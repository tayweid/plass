import { codeBlockMetricsEm, parityMetrics } from '../src/font-registry';
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
 *  Typst's baselines, both from the first top-level paragraph's. A
 *  figure's caption is a row too (`caption`, its first line). With `bib`
 *  (a .bib source) the bibliography's compiled list is waited for, and
 *  each of its baselines is a row (`bib`): placed as a line top, so the
 *  same offset maps it. */
async function blocksDrift(page: Page, blocks: unknown[], parIndent = false, bib?: string): Promise<Array<{ kind: string; drift: number }>> {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(
    ({ blocks, parIndent, bib }) => {
      const { state } = window.view;
      const tr = state.tr.replaceWith(
        0,
        state.doc.content.size,
        blocks.map((b) => state.schema.nodeFromJSON(b)),
      );
      if (bib) tr.setDocAttribute('bib', { name: 'references.bib', content: bib });
      tr.setDocAttribute('settings', { ...state.doc.attrs.settings, sizePt: 12.5, parIndent, marginTop: 1, marginRight: 1, marginBottom: 1, marginLeft: 1 });
      window.view.dispatch(tr);
    },
    { blocks, parIndent, bib },
  );
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.ts-figure img')].every((img) => img.complete && img.naturalWidth > 0));
  if (bib) await page.waitForFunction(() => document.querySelector('.ts-bibliography.bib-has-ink'), null, { timeout: 40_000 });
  // An equation's box is its Typst frame once its ink is on the page.
  const equations = blocks.filter((b) => (b as { type: string }).type === 'math_display').length;
  if (equations) await page.waitForFunction((n) => document.querySelectorAll('.math-display.math-ink').length === n, equations);
  await settleLocal(page, 0);
  // A paragraph's Typst baseline below its line box's top (its cap slack
  // and the cap height): a compiled baseline in the page becomes a line top.
  const m = parityMetrics('New Computer Modern');
  const baselineInBox = (1.5 / 2 + (m.cssA - m.cssD) / 2 - m.typAsc + m.extent) * BODY_PX;
  const { rows, inkSvg, inkTop } = await page.evaluate(() => {
    const sheet = document.querySelector('#pages .page-box')!.getBoundingClientRect().top;
    const rows = [...window.view.dom.querySelectorAll<HTMLElement>('p, figcaption')].map((el) => {
      const parent = el.parentElement!;
      const kind =
        el.tagName === 'FIGCAPTION'
          ? 'caption'
          : parent === window.view.dom
            ? 'p'
            : parent.tagName === 'LI'
              ? 'li'
              : parent.tagName === 'BLOCKQUOTE'
                ? 'quote'
                : parent.tagName === 'TD' || parent.tagName === 'TH'
                  ? 'cell'
                  : parent.classList.contains('ts-grid-cell')
                    ? 'grid'
                    : 'abstract';
      return { kind, text: el.textContent ?? '', top: el.getBoundingClientRect().top - sheet };
    });
    const ink = document.querySelector('.ts-bibliography .bib-ink svg');
    return { rows, inkSvg: ink?.outerHTML ?? null, inkTop: ink ? ink.getBoundingClientRect().top - sheet : 0 };
  });
  if (inkSvg) {
    // The fragment's own page: its baselines from its top (in px already).
    const [own] = typstBaselines(inkSvg);
    const at = rows.findIndex((row) => row.top > inkTop);
    rows.splice(at < 0 ? rows.length : at, 0, ...own.map((y, i) => ({ kind: 'bib', text: `baseline ${i + 1}`, top: inkTop + y - baselineInBox })));
  }
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
const heading = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const equation = (src: string) => ({ type: 'math_display', attrs: { src } });
const cell = (text: string) => ({ type: 'table_cell', content: [p(text)] });
const table = (...rows: string[][]) => ({ type: 'table', content: rows.map((row) => ({ type: 'table_row', content: row.map(cell) })) });
const grid = (...cells: string[]) => ({
  type: 'grid',
  attrs: { columns: cells.map(() => 1), gutter: 1 },
  content: [{ type: 'grid_row', content: cells.map((text) => ({ type: 'grid_cell', content: [p(text)] })) }],
});
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

for (const parIndent of [false, true]) {
  test(`${parIndent ? 'classic' : 'spaced'}: the abstract's label, its paragraphs and the paragraph after it land on the print`, async ({ page }) => {
    test.setTimeout(90_000);
    const d = await blocksDrift(
      page,
      [
        p('Before the abstract.'),
        { type: 'abstract', content: [p('The abstract, one line.'), p('Its second paragraph.')] },
        p('After the abstract.'),
        p('The last paragraph.'),
      ],
      parIndent,
    );
    // The export prints the label as a bold paragraph of its own and the
    // abstract's paragraphs after it, all at paragraph spacing; the bold
    // capitals make the label's frame 0.05 px taller than a paragraph
    // line's (`abstractBoxEm`). The painted label had a 0.75em margin under
    // it: the abstract's first line was 2.55 px higher than its print
    // (12.45 px lower with indented paragraphs, and the 0.9em margin after
    // the abstract put the next paragraph 15 px lower again).
    for (let i = 1; i < d.length; i++) {
      expect(Math.abs(d[i].drift - d[i - 1].drift), `${d[i].kind}: ${JSON.stringify(d)}`).toBeLessThan(1 / 128 + 0.002);
    }
  });
}

const RECT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#38786d"/></svg>';
const figure = (caption: string) => ({
  type: 'figure',
  attrs: { src: `data:image/svg+xml;base64,${Buffer.from(RECT_SVG).toString('base64')}`, widthPct: 20 },
  content: [{ type: 'text', text: caption }],
});

for (const parIndent of [false, true]) {
  test(`${parIndent ? 'classic' : 'spaced'}: a figure's caption and the paragraph after it land on the print`, async ({ page }) => {
    test.setTimeout(90_000);
    const d = await blocksDrift(
      page,
      [
        p('Before the figures.'),
        figure('A one-line caption.'),
        p('Between the figures.'),
        figure('A caption long enough to wrap: the Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings.'),
        p('The last paragraph.'),
      ],
      parIndent,
    );
    expect(d.map((row) => row.kind.split(' ')[0])).toEqual(['p', 'caption', 'p', 'caption', 'p']);
    // Typst prints a figure as one block at paragraph spacing, its frame
    // from the image's top to the caption's last baseline, the caption
    // 0.65em below the image (`figureBoxEm`); the image is 20 % of the
    // column, its height by its ratio. Each figure is rounded from its
    // top, so its caption's line and the paragraph after it move by less
    // than a layout unit. The July box put the caption 5 px lower than its
    // print and the paragraph after it 8.3 px lower (spaced; 23.3 px with
    // indented paragraphs, its 0.9em margin besides), and Chrome's own
    // image height was 1/80 px short.
    for (let i = 1; i < d.length; i++) {
      expect(Math.abs(d[i].drift - d[i - 1].drift), `${d[i].kind}: ${JSON.stringify(d)}`).toBeLessThan(1 / 128 + 0.002);
    }
  });
}

const BIB = `@article{knuth81,
  author = {Knuth, Donald E. and Plass, Michael F.},
  title = {Breaking Paragraphs into Lines},
  journal = {Software: Practice and Experience},
  year = {1981},
}

@book{lamport94, author = {Lamport, Leslie}, title = {{LaTeX}: A Document Preparation System}, year = {1994}}
`;

for (const parIndent of [false, true]) {
  test(`${parIndent ? 'classic' : 'spaced'}: the bibliography's compiled list and the paragraph after it land on the print`, async ({ page }) => {
    test.setTimeout(120_000);
    const cite = (key: string) => ({ type: 'citation', attrs: { key } });
    const d = await blocksDrift(
      page,
      [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before the list, citing ' }, cite('knuth81'), { type: 'text', text: ' and ' }, cite('lamport94'), { type: 'text', text: '.' }] },
        { type: 'bibliography' },
        p('After the list.'),
        p('The last paragraph.'),
      ],
      parIndent,
      BIB,
    );
    expect(d.filter((row) => row.kind.startsWith('bib')).length).toBeGreaterThan(2);
    // Typst prints the title as a level-1 heading (its spacing above is the
    // heading's) and the entries at paragraph spacing below their last
    // baseline (`bibliographyBoxEm`). The page shows the list compiled on a
    // page of its own, from the title's frame top to the last baseline; its
    // edges are rounded from the box's top, so the title's line, each
    // entry's and the paragraph after the list land within a layout unit of
    // the print. The 0.75em padding put the list 2.34 px higher than its
    // print at 12.5 pt and the paragraph after it 1.25 px higher (14.08 px
    // lower with indented paragraphs).
    for (let i = 1; i < d.length; i++) {
      expect(Math.abs(d[i].drift - d[i - 1].drift), `${d[i].kind}: ${JSON.stringify(d)}`).toBeLessThan(1 / 128 + 0.002);
    }
  });
}

// Typst's quote sets its 2.4em above and 1.8em below as a show-set rule,
// a style the quote's content inherits: every block inside it whose own
// spacing is Auto (a list, a list nested in an item, a grid, a table, a
// code block) is 2.4em below the paragraph before it and 1.8em above the
// one after, at the block's own size (a code block's em is the raw
// text's). The page spaced them as paragraphs: a list 11.38 px higher
// than its print at 12.5 pt, a code block 1.23 px lower. Each paragraph's
// line is checked against the print from the one before it: each box edge
// is rounded to the layout unit on its own, and a code line keeps its
// pitch's residual. A table cell's line is left out (the cell's text sits
// 1.46 px off its print at the top level too, the whole table on it).
for (const parIndent of [false, true]) {
  test(`${parIndent ? 'classic' : 'spaced'}: a list in a quote is spaced as the quote spaces itself, an item's nested list too`, async ({ page }) => {
    test.setTimeout(90_000);
    const d = await blocksDrift(
      page,
      [
        p('Before the quote.'),
        quote(p('Quote with a list.'), ul(li(p('Item a.'), ul(li(p('Sub a.')))), li(p('Item b.'))), p('Closing the quote.')),
        p('Between the quotes.'),
        quote(ul(li(p('An opening item.'))), p('Middle.'), ul(li(p('A closing item.')))),
        p('The last paragraph.'),
      ],
      parIndent,
    );
    expect(d).toHaveLength(11);
    for (let i = 1; i < d.length; i++) expect(Math.abs(d[i].drift - d[i - 1].drift), `${d[i].kind}: ${JSON.stringify(d)}`).toBeLessThan(1 / 64 + 0.003);
  });

  test(`${parIndent ? 'classic' : 'spaced'}: a grid, a table and a code block in a quote are spaced as the quote spaces itself`, async ({ page }) => {
    test.setTimeout(90_000);
    const d = (
      await blocksDrift(
        page,
        [
          p('Before the quote.'),
          quote(p('Then a grid.'), grid('G1', 'G2'), p('Then a table.'), table(['A1', 'B1'], ['A2', 'B2']), p('Then code.'), code('let x = 1\nlet y = 2'), p('Closing the quote.')),
          p('Between the quotes.'),
          quote(table(['C1', 'D1']), p('Middle.'), code('let z = 3')),
          p('The last paragraph.'),
        ],
        parIndent,
      )
    ).filter((row) => !row.kind.startsWith('cell'));
    expect(d).toHaveLength(10);
    const metrics = codeBlockMetricsEm({ font: 'New Computer Modern', lineHeight: 1.5, parIndent });
    const line = Math.abs(layoutPx(metrics.lineEm * BODY_PX) - metrics.lineEm * BODY_PX);
    for (let i = 1; i < d.length; i++) expect(Math.abs(d[i].drift - d[i - 1].drift), `${d[i].kind}: ${JSON.stringify(d)}`).toBeLessThan(1 / 64 + 2 * line + 0.003);
  });

  // A quote's spacing and a heading's, an equation's or another quote's
  // are all explicit: Typst keeps the larger of the two, where the page
  // added the quote's padding to the gap the block before it paints (a
  // quote after a third-level heading was 3.98 px short at 12.5 pt and
  // moved a page break; classic, a heading after a quote 16 px long).
  test(`${parIndent ? 'classic' : 'spaced'}: a quote beside a heading, an equation or another quote keeps the larger spacing`, async ({ page }) => {
    test.setTimeout(90_000);
    const d = await blocksDrift(
      page,
      [
        p('Before the headings.'),
        heading(1, 'First level'),
        quote(p('After a first-level heading.')),
        heading(2, 'Second level'),
        quote(p('After a second-level heading.')),
        heading(3, 'Third level'),
        quote(p('After a third-level heading.')),
        heading(3, 'After a quote'),
        p('Under the heading.'),
        quote(p('A quote.')),
        quote(p('Another quote right after it.')),
        equation('x^2 + y^2 = z^2'),
        quote(p('After an equation.')),
        equation('a = b'),
        p('The last paragraph.'),
      ],
      parIndent,
    );
    expect(d).toHaveLength(9);
    for (let i = 1; i < d.length; i++) expect(Math.abs(d[i].drift - d[i - 1].drift), `${d[i].kind}: ${JSON.stringify(d)}`).toBeLessThan(1 / 64 + 0.003);
  });
}

/** Every paragraph outside a table cell on a document of `blocks`, at
 *  12.5 pt with 1 in margins, against Typst's baseline nearest it on the
 *  same page, both from page 1's first paragraph; and each table's box,
 *  px from its sheet's top. */
async function pagedDrift(page: Page, blocks: unknown[], parIndent = false) {
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
  const dom = await page.evaluate(() => {
    const sheets = [...document.querySelectorAll('#pages .page-box')].map((el) => el.getBoundingClientRect().top);
    const at = (el: Element) => {
      const top = el.getBoundingClientRect().top;
      const i = sheets.findLastIndex((sheet) => sheet <= top + 0.5);
      return { page: i, top: top - sheets[i] };
    };
    return {
      sheets: sheets.length,
      rows: [...window.view.dom.querySelectorAll<HTMLElement>('p')].filter((el) => !el.closest('td, th')).map((el) => ({ text: el.textContent ?? '', ...at(el) })),
      tables: [...window.view.dom.querySelectorAll('table')].map(at),
    };
  });
  const svg = await page.evaluate(() => window.__tableProofSvg());
  if (!svg) throw new Error('Typst compile failed');
  const pages = typstBaselines(svg).map((ys) => ys.filter((y) => y >= 96 && y <= 11 * 96 - 96));
  expect(dom.sheets, 'page count').toBe(pages.length);
  const offset = pages[0][0] - dom.rows[0].top;
  const rows = dom.rows.map(({ text, page: i, top }) => {
    const at = top + offset;
    const printed = pages[i].reduce((best, y) => (Math.abs(y - at) < Math.abs(best - at) ? y : best));
    return { text, page: i, drift: at - printed };
  });
  return { rows, tables: dom.tables };
}

// A table that opens a page: Typst drops the spacing above it, and its
// frame (the table's box) starts at the top margin. The page landed the
// box a whole margin-top higher (`blockTopAdjustPx` took the table's
// margin off a box the margin is above), and once a page gap came between
// a paragraph and the table the paragraph's margin no longer collapsed
// into the table's, so where the table sat depended on whether the last
// pass had broken there: 8.27 px or 23.27 px above the margin at 12.5 pt
// (a quote's table 8.28 px), and everything after it on the page as high.
// A page gap before a table carries the table's margin-top now
// (style.css): the table's place in the unbroken flow is the same with the
// gap or without, and its box lands where the gap ends.
const pageTopTables: Array<{ name: string; parIndent?: boolean; blocks: () => unknown[] }> = [
  {
    name: 'after a paragraph',
    blocks: () => [...Array.from({ length: 21 }, (_, i) => p(`Paragraph ${i + 1} is a single short line.`)), p('Before the table.'), table(['A1', 'B1'], ['A2', 'B2']), p('After the table.'), p('The last paragraph.')],
  },
  {
    name: 'after a paragraph, classic',
    parIndent: true,
    blocks: () => [...Array.from({ length: 33 }, (_, i) => p(`Paragraph ${i + 1} is a single short line.`)), p('Before the table.'), table(['A1', 'B1'], ['A2', 'B2']), p('After the table.'), p('The last paragraph.')],
  },
  {
    name: 'in a quote, after its paragraph',
    blocks: () => [
      ...Array.from({ length: 20 }, (_, i) => p(`Paragraph ${i + 1} is a single short line.`)),
      quote(p('Quoted before the table.'), table(['A1', 'B1'], ['A2', 'B2']), p('Quoted after the table.')),
      p('After the quote.'),
    ],
  },
  {
    name: 'after a list',
    blocks: () => [...Array.from({ length: 21 }, (_, i) => p(`Paragraph ${i + 1} is a single short line.`)), ul(li(p('An item.'))), table(['A1', 'B1'], ['A2', 'B2']), p('After the table.')],
  },
  {
    name: 'after a page break',
    blocks: () => [p('Before the break.'), { type: 'page_break' }, table(['A1', 'B1'], ['A2', 'B2']), p('After the table.')],
  },
];
for (const c of pageTopTables) {
  test(`a table that opens a page lands its frame at the top margin: ${c.name}`, async ({ page }) => {
    test.setTimeout(90_000);
    const { rows, tables } = await pagedDrift(page, c.blocks(), c.parIndent);
    expect(tables[0].page, JSON.stringify(tables)).toBe(1);
    // The box at the margin, within the page gap's painted hundredths.
    expect(Math.abs(tables[0].top - 96), JSON.stringify(tables)).toBeLessThan(1 / 32);
    // Every line on both pages on its print; a table's margins are still
    // four-decimal lengths, truncated (ROADMAP).
    for (const row of rows) expect(Math.abs(row.drift), `${row.text}: ${JSON.stringify(rows)}`).toBeLessThan(1 / 32);
  });
}
