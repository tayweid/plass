import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Typst's inline raw never grows a line: its frame runs from the mono
// face's top edge (0.7598 of its 0.8em, under every certified body face's
// cap height) to the baseline. On the page the mono face's box (hhea
// 0.9282 / 0.2358) sits lower on the baseline than the body face's, and
// at any line height it inherited it hung below the line's strut: a table
// row with code was 2-3 px taller than one without, a footnote line 2 px,
// a body line 0.55 px at 10 pt and line spacing 1.3. In print, inline raw
// was pinned to 0.8 times the BODY size, so in a table set smaller, or a
// footnote entry, it was larger than its line's text and grew the row (by
// 1 px at 0.8em) where the page's did not.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> };
    __tableProofSvg: () => Promise<string | null>;
  }
}

const S = 'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';
const SC = 'The committee reconvened after lunch to weigh the `revised` proposal against the `earlier` draft. ';

async function openMd(page: Page, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('code.md', { create: true });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
    await window.__fm.loadHandle(h);
  }, text);
  await settleLocal(page);
}

/** Two grid tables, at the body's size and at 0.8em, whose rows alternate
 *  plain text with inline code. (Inline raw is not exported from a table
 *  cell, `tableCellContentToTyp`: there is nothing to print it beside.) */
function tables(pt: number, lh: number) {
  const table = (scale: string) => [
    `::: {.table style=grid${scale ? ` font-size=${scale}` : ''}}`,
    '',
    '| A | B |',
    '|---|---|',
    '| plain one | plain two |',
    '| code `one` | plain two |',
    '| plain one | plain two |',
    '| code `x|y` | code `z` |',
    '| plain one | plain two |',
    '',
    ':::',
    '',
  ];
  return ['---', `fontsize: ${pt}pt`, `linestretch: ${lh}`, '---', '', ...table(''), ...table('0.8em')].join('\n');
}

for (const [pt, lh] of [[12.5, 1.8], [10, 1.5], [13, 1.3]]) {
  test(`table rows holding inline code are as tall as plain rows, page and print, at ${pt} pt / ${lh}`, async ({ page }) => {
    test.setTimeout(90_000);
    await openMd(page, tables(pt, lh));
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.ProseMirror table')].map((t) => [...t.querySelectorAll('tr')].map((tr) => tr.getBoundingClientRect().height)),
    );
    expect(rows).toHaveLength(2);
    for (const heights of rows) expect(new Set(heights).size, JSON.stringify(rows)).toBe(1);
    // Typst's rows, between the grid's horizontal rules, px.
    const printed = await page.evaluate(async () => {
      const svg = await window.__tableProofSvg();
      if (!svg) throw new Error('Typst compile failed');
      const parsed = new DOMParser().parseFromString(svg, 'text/html');
      const ys: number[] = [];
      for (const el of parsed.querySelectorAll('.typst-shape')) {
        if (!/^M 0 0 L [\d.]+ 0$/.test(el.getAttribute('d') ?? '')) continue;
        let y = 0;
        for (let c: Element | null = el; c; c = c.parentElement) {
          const m = /translate\(([-\d.]+)[, ]+([-\d.]+)\)/.exec(c.getAttribute('transform') ?? '');
          if (m) y += Number(m[2]);
        }
        ys.push(y);
      }
      const rules = [...new Set(ys.map((y) => y.toFixed(3)))].map(Number).sort((a, b) => a - b);
      return rules.slice(1).map((y, i) => ((y - rules[i]) * 4) / 3);
    });
    // Two tables of six rows, and the gap between them.
    expect(printed).toHaveLength(13);
    for (const heights of [printed.slice(0, 6), printed.slice(7)]) {
      expect(Math.max(...heights) - Math.min(...heights), JSON.stringify(printed)).toBeLessThan(0.01);
    }
  });
}

test('lines holding inline code are as tall as plain lines in prose, lists, quotes, notes and headings', async ({ page }) => {
  test.setTimeout(90_000);
  await openMd(
    page,
    [
      '---',
      'fontsize: 10pt',
      'linestretch: 1.3',
      '---',
      '',
      S.repeat(6).trim(),
      '',
      '# A plain heading',
      '',
      SC.repeat(6).trim(),
      '',
      '# A `code` heading',
      '',
      'Raw ' + 'and `#h(1em)`{=typst} once more, '.repeat(24).trim(),
      '',
      '- ' + S.repeat(3).trim(),
      '- ' + SC.repeat(3).trim(),
      '',
      '> ' + S.repeat(3).trim(),
      '',
      'Between the quotes.[^1] And after.[^2]',
      '',
      '> ' + SC.repeat(3).trim(),
      '',
      '[^1]: ' + S.repeat(3).trim(),
      '[^2]: ' + SC.repeat(3).trim(),
      '',
    ].join('\n'),
  );
  const m = await page.evaluate(() => {
    // A port-laid block's lines end in a `br.ts-br`: its height a line.
    const perLine = (el: Element) => el.getBoundingClientRect().height / (el.querySelectorAll('br.ts-br').length + 1);
    const pm = document.querySelector('.ProseMirror')!;
    const ps = [...pm.querySelectorAll(':scope > p')];
    return {
      headings: [...pm.querySelectorAll(':scope > h1')].map((h) => h.getBoundingClientRect().height),
      prose: ps.slice(0, 3).map(perLine),
      lines: ps.slice(0, 3).map((p) => p.querySelectorAll('br.ts-br').length + 1),
      items: [...pm.querySelectorAll('li > p')].map(perLine),
      quotes: [...pm.querySelectorAll('blockquote > p')].map(perLine),
      notes: [...pm.querySelectorAll('.fn-body')].map(perLine),
    };
  });
  const detail = JSON.stringify(m);
  expect(Math.min(...m.lines), detail).toBeGreaterThanOrEqual(4);
  expect(m.headings[1], detail).toBe(m.headings[0]);
  expect(m.prose[1], detail).toBe(m.prose[0]);
  expect(m.prose[2], detail).toBe(m.prose[0]);
  expect(m.items[1], detail).toBe(m.items[0]);
  expect(m.quotes[1], detail).toBe(m.quotes[0]);
  expect(m.notes[1], detail).toBe(m.notes[0]);
});

// With no line height of its own the code's box is out of the line box, but
// a click anywhere on its chip still lands in its text: hit-testing
// follows the glyphs.
test('a click on inline code puts the caret in it', async ({ page }) => {
  await openMd(page, ['Some text with `inline_code_here` in it.', ''].join('\n'));
  const code = page.locator('.ProseMirror > p code').first();
  const box = (await code.boundingBox())!;
  const [from, to] = await code.evaluate((el) => [window.view.posAtDOM(el.firstChild!, 0), window.view.posAtDOM(el.firstChild!, el.textContent!.length)]);
  for (const dy of [0.1, 0.5, 0.9]) {
    // Apart by more than ProseMirror's double-click window (500 ms), or
    // the clicks select a word and then the paragraph.
    await page.waitForTimeout(600);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * dy);
    await expect
      .poll(() => page.evaluate(() => window.view.state.selection.head), { message: `click at ${dy} of the chip's height, in ${from}-${to}` })
      .toBeGreaterThan(from);
    expect(await page.evaluate(() => window.view.state.selection.head)).toBeLessThan(to);
  }
});
