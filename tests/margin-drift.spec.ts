import { codeBlockMetricsEm } from '../src/font-registry';
import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Chrome holds a length in 1/64 px and truncates a CSS length to it. The
// paragraph margin was 0.9em, which at 12.5 pt is 15 px computed as
// 14.99999…, so it was laid out 14.984375 px: every gap between two
// paragraphs on a spaced page was 1/64 px short of Typst's spacing, and the
// paragraphs crept up against the print, 0.33 px by a page's 22nd. A
// display equation lost its 0.5em paddings and its own 0.9em margin the
// same way, about 0.04 px a pair. The margins are published in layout
// units now (`layoutPx`, settings.ts), and an equation's edges are rounded
// from the exact model (style.css), so each block ends within 1/128 px of
// where Typst puts it below its top. At 12.5 pt a paragraph's margin is
// exact. An equation's frame is any length, so each one keeps its own
// rounding, at most 1/128 px; at a size where 0.9em is not a whole 1/64 px
// (12 pt: 14.4 px) so does each paragraph gap.
//
// One page of one-line paragraphs: each paragraph's first line against
// Typst's baseline in the same compile, both measured from the first
// paragraph's.
//
// The other blocks' em lengths were truncated the same way and are in
// layout units too (below): a tight list item's 0.25em margin (1/96 px
// short an item at 12.5 pt), the fixed 0.9em margin of a list, a nested
// list, figures, the abstract and the bibliography, a quote's padding and
// spacing below, and a code block's padding, margin and line pitch. Each
// is checked by the paragraph lines around it: a list item's or a quote's
// paragraph is the same line box as one at the top level.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __tableProofSvg: () => Promise<string | null>;
  }
}

/** Typst's baselines per page, px from the page top: each `.typst-text`
 *  group's translates summed below its `.typst-page`. */
function typstBaselines(svg: string): number[][] {
  const pages: number[][] = [];
  const stack: number[] = [];
  const re = /<(\/?)g\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const [, close, attrs, selfClose] = m;
    if (close) {
      stack.pop();
      continue;
    }
    const cls = (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/);
    const tr = /transform="translate\(([-\d.]+)[, ]+([-\d.]+)\)"/.exec(attrs);
    const isPage = cls.includes('typst-page');
    const y = isPage ? 0 : (stack.at(-1) ?? 0) + (tr ? Number(tr[2]) : 0);
    if (isPage) pages.push([]);
    else if (cls.includes('typst-text') && pages.length) pages[pages.length - 1].push(y);
    if (!selfClose) stack.push(y);
  }
  return pages.map((ys) => [...new Set(ys)].sort((a, b) => a - b).map((y) => (y * 4) / 3));
}

/** Each paragraph's drift, px: where the page puts its first line less
 *  where Typst does, both from the first paragraph's. `equations` puts a
 *  display equation after every paragraph but the last, numbered, half of
 *  them short enough that the number grows the frame (`x = y`). */
async function drift(page: Page, sizePt: number, parIndent: boolean, equations: boolean): Promise<number[]> {
  const count = equations ? 8 : 20;
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(
    ({ sizePt, parIndent, equations, count }) => {
      const { state } = window.view;
      const { schema } = state;
      const blocks = [];
      for (let i = 1; i <= count; i++) {
        blocks.push(schema.nodes.paragraph.create(null, schema.text(`Paragraph ${i} is a single short line.`)));
        if (equations && i < count) blocks.push(schema.nodes.math_display.create({ src: i % 2 ? 'x^2 + y^2 = z^2' : 'x = y' }));
      }
      const tr = state.tr.replaceWith(0, state.doc.content.size, blocks);
      tr.setDocAttribute('settings', {
        ...state.doc.attrs.settings,
        sizePt,
        parIndent,
        numberEquations: true,
        marginTop: 1,
        marginRight: 1,
        marginBottom: 1,
        marginLeft: 1,
      });
      window.view.dispatch(tr);
    },
    { sizePt, parIndent, equations, count },
  );
  // An equation's box is its Typst frame once its ink is on the page
  // (KaTeX's echo stands in for it until then).
  if (equations) await page.waitForFunction((n) => document.querySelectorAll('.math-display.math-ink').length === n, count - 1);
  await settleLocal(page, 0);
  // The test window draws the paper at 1:1: layout px from the sheet top.
  const tops = await page.evaluate(() => {
    const sheet = document.querySelector('#pages .page-box')!.getBoundingClientRect().top;
    return [...window.view.dom.querySelectorAll<HTMLElement>(':scope > p')].map((el) => el.getBoundingClientRect().top - sheet);
  });
  expect(tops).toHaveLength(count);
  const svg = await page.evaluate(() => window.__tableProofSvg());
  if (!svg) throw new Error('Typst compile failed');
  const pages = typstBaselines(svg);
  expect(pages).toHaveLength(1);
  // The text area (1 in margins on Letter): the page number is below it.
  const ys = pages[0].filter((y) => y >= 96 && y <= 11 * 96 - 96);
  // A paragraph's line is the baseline nearest where the first paragraph's
  // offset puts it (an equation's baselines are a line or more away).
  const offset = ys[0] - tops[0];
  return tops.map((top) => {
    const at = top + offset;
    const printed = ys.reduce((best, y) => (Math.abs(y - at) < Math.abs(best - at) ? y : best));
    return at - printed;
  });
}

for (const parIndent of [false, true]) {
  test(`${parIndent ? 'classic' : 'spaced'} paragraphs at 12.5 pt print where the page puts every one`, async ({ page }) => {
    test.setTimeout(90_000);
    const d = await drift(page, 12.5, parIndent, false);
    // The SVG prints 0.001 pt.
    for (const [i, x] of d.entries()) expect(Math.abs(x), `paragraph ${i + 1}: ${JSON.stringify(d)}`).toBeLessThan(0.005);
  });

  test(`${parIndent ? 'classic' : 'spaced'} paragraphs: each display equation moves the next paragraph by less than a layout unit`, async ({ page }) => {
    test.setTimeout(90_000);
    const d = await drift(page, 12.5, parIndent, true);
    // From one paragraph to the next: an equation's margin end is within
    // 1/128 px of the model, and the SVG prints 0.001 pt.
    for (let i = 1; i < d.length; i++) expect(Math.abs(d[i] - d[i - 1]), `equation ${i}: ${JSON.stringify(d)}`).toBeLessThan(1 / 128 + 0.002);
  });
}

test('at 12 pt the paragraph margin is the nearest layout unit to Typst spacing', async ({ page }) => {
  test.setTimeout(90_000);
  const d = await drift(page, 12, false, false);
  // 0.9em is 14.4 px, 14.40625 in layout units: 1/160 px a gap, not the
  // 1/107 px the truncated 14.390625 lost.
  for (const [i, x] of d.entries()) expect(Math.abs(x), `paragraph ${i + 1}: ${JSON.stringify(d)}`).toBeLessThanOrEqual(i / 128 + 0.002);
});

/** Every paragraph's drift on a page of `blocks` (ProseMirror JSON), at
 *  12.5 pt with 1 in margins: its first line's top against the nearest of
 *  Typst's baselines, both from the first top-level paragraph's. */
async function blocksDrift(page: Page, blocks: unknown[], parIndent = false): Promise<Array<{ kind: string; drift: number }>> {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(
    ({ blocks, parIndent }) => {
      const { state } = window.view;
      const tr = state.tr.replaceWith(
        0,
        state.doc.content.size,
        blocks.map((b) => state.schema.nodeFromJSON(b)),
      );
      tr.setDocAttribute('settings', { ...state.doc.attrs.settings, sizePt: 12.5, parIndent, marginTop: 1, marginRight: 1, marginBottom: 1, marginLeft: 1 });
      window.view.dispatch(tr);
    },
    { blocks, parIndent },
  );
  await settleLocal(page, 0);
  const rows = await page.evaluate(() => {
    const sheet = document.querySelector('#pages .page-box')!.getBoundingClientRect().top;
    return [...window.view.dom.querySelectorAll<HTMLElement>('p')].map((el) => {
      const parent = el.parentElement!;
      const kind = parent === window.view.dom ? 'p' : parent.tagName === 'LI' ? 'li' : parent.tagName === 'BLOCKQUOTE' ? 'quote' : 'abstract';
      return { kind, text: el.textContent ?? '', top: el.getBoundingClientRect().top - sheet };
    });
  });
  const svg = await page.evaluate(() => window.__tableProofSvg());
  if (!svg) throw new Error('Typst compile failed');
  const pages = typstBaselines(svg);
  expect(pages).toHaveLength(1);
  const ys = pages[0].filter((y) => y >= 96 && y <= 11 * 96 - 96);
  const offset = ys[0] - rows[0].top;
  return rows.map(({ kind, text, top }) => {
    const at = top + offset;
    const printed = ys.reduce((best, y) => (Math.abs(y - at) < Math.abs(best - at) ? y : best));
    return { kind: `${kind} ${text}`, drift: at - printed };
  });
}

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const li = (...content: unknown[]) => ({ type: 'list_item', content });
const ul = (...items: unknown[]) => ({ type: 'bullet_list', attrs: { tight: true }, content: items });
const ol = (...items: unknown[]) => ({ type: 'ordered_list', attrs: { tight: true, order: 1 }, content: items });
const quote = (...content: unknown[]) => ({ type: 'blockquote', content });
const code = (text: string) => ({ type: 'code_block', content: [{ type: 'text', text }] });
const BODY_PX = (12.5 * 4) / 3;
const layoutPx = (px: number) => Math.round(px * 64) / 64;

test('a tight list item is the nearest layout unit to its pitch, and a list, a nested list and their margins land on the print', async ({ page }) => {
  test.setTimeout(90_000);
  const d = await blocksDrift(page, [
    p('Before the lists.'),
    ul(li(p('One.')), li(p('Two.'), ul(li(p('Two a.')), li(p('Two b.')))), li(p('Three.'))),
    p('After the first list.'),
    ol(li(p('First.')), li(p('Second.'))),
    p('The last paragraph.'),
  ]);
  // A tight item's pitch is the leading + 0.25em: 4.1667 px at 12.5 pt,
  // 4.171875 in layout units (it was 4.15625, 1/96 px short an item). The
  // 0.9em margins after a list and over a nested list are 15 px, exact.
  const item = layoutPx(0.25 * BODY_PX) - 0.25 * BODY_PX;
  // Item gaps above each paragraph: One, Two, Two a, Two b, Three, After,
  // First, Second, Last.
  const gaps = [0, 0, 1, 1, 2, 3, 3, 3, 4, 4];
  expect(d).toHaveLength(gaps.length);
  // The SVG prints 0.001 pt.
  for (const [i, row] of d.entries()) expect(Math.abs(row.drift - gaps[i] * item), `${row.kind}: ${JSON.stringify(d)}`).toBeLessThan(0.003);
});

// A list is spaced from its neighbours as a paragraph is (Typst's Auto
// spacing): in classic mode by the leading alone, so a list's margin, and a
// nested list's above it, is the paragraph's, none there. A tight item's
// 0.25em is spacing between items: where a list ends there is none, and a
// nested list that ends an item before the last carries the outer list's
// item spacing, a loose list's paragraph spacing. In classic mode the page
// put the line after a list, the first line of a nested list and a heading
// after a list 15 px lower than the print; in either mode a loose list's
// item after one ending in a nested list was at the tight item spacing
// (spaced 10.8 px higher than the print, classic 4.2 px lower).
for (const parIndent of [false, true]) {
  test(`${parIndent ? 'classic' : 'spaced'}: a list's end, a nested list and a loose list's items land on the print`, async ({ page }) => {
    test.setTimeout(90_000);
    const loose = (...items: unknown[]) => ({ ...ul(...items), attrs: { tight: false } });
    const d = await blocksDrift(
      page,
      [
        p('Before the lists.'),
        ul(li(p('One.')), li(p('Two.'), ul(li(p('Two a.')), li(p('Two b.')))), li(p('Three.'))),
        p('After the first list.'),
        ol(li(p('First.')), li(p('Second.'), ul(li(p('Second a.'))))),
        p('After the second list.'),
        loose(li(p('Loose one.'), ul(li(p('Loose one a.')))), li(p('Loose two.'))),
        p('After the loose list.'),
        ul(li(p('The last item.'))),
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A heading' }] },
        p('After the heading.'),
      ],
      parIndent,
    );
    const item = layoutPx(0.25 * BODY_PX) - 0.25 * BODY_PX;
    // Tight item gaps above each paragraph: Before, One, Two, Two a, Two b,
    // Three, After, First, Second, Second a, After, Loose one, Loose one a,
    // Loose two, After, The last item, After the heading.
    const gaps = [0, 0, 1, 1, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4];
    expect(d).toHaveLength(gaps.length);
    for (const [i, row] of d.entries()) expect(Math.abs(row.drift - gaps[i] * item), `${row.kind}: ${JSON.stringify(d)}`).toBeLessThan(0.003);
  });
}

for (const parIndent of [false, true]) {
  test(`${parIndent ? 'classic' : 'spaced'}: a quote's spacing ends within a layout unit of the print`, async ({ page }) => {
    test.setTimeout(90_000);
    const blocks: unknown[] = [];
    for (let i = 1; i <= 5; i++) blocks.push(p(`Paragraph ${i} is a single short line.`), quote(p('A quoted line.')));
    blocks.push(p('The last paragraph.'));
    const d = await blocksDrift(page, blocks, parIndent);
    // Each quote, padding to the end of its last child's margin, is
    // rounded from its top: the paragraph after it moves by less than a
    // layout unit (the four-decimal lengths were truncated, 0.017 px).
    const paragraphs = d.filter((row) => row.kind.startsWith('p '));
    for (let i = 1; i < paragraphs.length; i++) {
      expect(Math.abs(paragraphs[i].drift - paragraphs[i - 1].drift), `quote ${i}: ${JSON.stringify(d)}`).toBeLessThan(1 / 128 + 0.002);
    }
  });

  test(`${parIndent ? 'classic' : 'spaced'}: a code block's padding and margin land on the print, its lines at the nearest layout unit`, async ({ page }) => {
    test.setTimeout(90_000);
    const blocks: unknown[] = [];
    for (let i = 1; i <= 5; i++) blocks.push(p(`Paragraph ${i} is a single short line.`), code('let x = 1\nlet y = 2\nlet z = 3'));
    blocks.push(p('The last paragraph.'));
    const d = await blocksDrift(page, blocks, parIndent);
    // A raw line's pitch is any length (23.7473 px at 12.5 pt): each line
    // keeps the nearest layout unit's difference, 3 a block here. The
    // padding and the margin are rounded from the block's top, so what is
    // left is under a layout unit (spaced, it was 1/64 px short a block).
    const metrics = codeBlockMetricsEm({ font: 'New Computer Modern', lineHeight: 1.5, parIndent });
    const line = layoutPx(metrics.lineEm * BODY_PX) - metrics.lineEm * BODY_PX;
    for (let i = 1; i < d.length; i++) {
      expect(Math.abs(d[i].drift - d[i - 1].drift - 3 * line), `code block ${i}: ${JSON.stringify(d)}`).toBeLessThan(1 / 128 + 0.003);
    }
  });
}

test("the abstract's margin lands the paragraph after it on the print", async ({ page }) => {
  test.setTimeout(90_000);
  const d = await blocksDrift(page, [
    p('Before the abstract.'),
    { type: 'abstract', content: [p('The abstract, one line.'), p('Its second paragraph.')] },
    p('After the abstract.'),
    p('The last paragraph.'),
  ]);
  // Its last paragraph to the next one: the 0.9em margin, 15 px (it was
  // 14.984375). The abstract's top keeps its own calibration (ROADMAP).
  const last = d.findLastIndex((row) => row.kind.startsWith('abstract'));
  expect(Math.abs(d[last + 1].drift - d[last].drift), JSON.stringify(d)).toBeLessThan(1 / 128 + 0.002);
  expect(Math.abs(d[last + 2].drift - d[last + 1].drift), JSON.stringify(d)).toBeLessThan(0.003);
});
