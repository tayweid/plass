import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// A heading's Typst frame is its line from the bold face's cap height
// (0.686 em of the heading's size) to its baseline: the paginator tests a
// heading against the page bottom by that frame. The model used to make
// the frame about 0.4 em too tall below (it subtracted the July
// calibration's baseline shift where the frame bottom adds it), so a
// heading that ended a page with nothing after it there, here before an
// explicit page break, went to the next page whenever its baseline fell
// within 4-6 px of the margin, and Typst kept it.
//
// Each case is compiled once with the port audit (`__audit`); Typst's
// baselines are read from the same compile's SVG.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagCount: () => number;
    __tableProofSvg: () => Promise<string | null>;
    __audit: () => Promise<{
      pages: { agree: boolean; local: Array<{ pos: number; line: number }>; firstDiff: unknown };
    } | null>;
  }
}

const SENTENCE = 'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';

type Block = { p: string } | { h: number; text: string } | { pageBreak: true };

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

async function open(page: Page, marginTop: number, blocks: Block[]) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(
    ({ marginTop, blocks }) => {
      const { state } = window.view;
      const { schema } = state;
      const nodes = blocks.map((b) =>
        'p' in b
          ? schema.nodes.paragraph.create(null, schema.text(b.p))
          : 'h' in b
            ? schema.nodes.heading.create({ level: b.h }, schema.text(b.text))
            : schema.nodes.page_break.create(),
      );
      const tr = state.tr.replaceWith(0, state.doc.content.size, nodes);
      tr.setDocAttribute('settings', { ...state.doc.attrs.settings, marginTop, marginRight: 1, marginBottom: 1, marginLeft: 1 });
      window.view.dispatch(tr);
    },
    { marginTop, blocks },
  );
  await settleLocal(page, 0);
}

// The paragraph runs to 32 lines; the heading after it lands with its
// baseline 1.7-2.7 px above the bottom margin, and a page break follows.
for (const { level, marginTop } of [
  { level: 1, marginTop: 1.1875 },
  { level: 2, marginTop: 1 },
  { level: 3, marginTop: 1.12 },
]) {
  test(`an H${level} that ends a page stays on it, as in print`, async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, marginTop, [
      { p: SENTENCE.repeat(28).trim() },
      { h: level, text: 'A heading that ends the page' },
      { pageBreak: true },
      { p: SENTENCE.repeat(4).trim() },
    ]);
    const report = await page.evaluate(() => window.__audit());
    if (!report) throw new Error('port audit: Typst compile failed');
    const svg = await page.evaluate(() => window.__tableProofSvg());
    if (!svg) throw new Error('Typst compile failed');
    // In print the heading is page 1's last line, within 3 px of the margin.
    const contentBottom = 11 * 96 - 96;
    const lines = typstBaselines(svg)[0].filter((y) => y <= contentBottom);
    expect(contentBottom - lines[lines.length - 1]).toBeLessThan(3);
    expect(report.pages.agree, JSON.stringify(report.pages.firstDiff)).toBe(true);
    // One page start: the paragraph after the page break.
    const after = await page.evaluate(() => {
      const blocks: number[] = [];
      window.view.state.doc.forEach((_node, offset) => blocks.push(offset));
      return blocks[3];
    });
    expect(report.pages.local.map((s) => [s.pos, s.line])).toEqual([[after, 0]]);
  });
}

// A heading's lines are pitched at the editor's 1.25 line height in print:
// the heading leading is 1.25 em less the BOLD cap height. Less the body's
// 0.683 em, an H1's second line printed 0.095 px low.
test('Typst pitches a two-line heading at the line height the page paints', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, 1, [
    { h: 1, text: 'A heading long enough to wrap onto a second line of the page' },
    { p: SENTENCE.repeat(3).trim() },
  ]);
  const { lines, pitch } = await page.evaluate(() => {
    const el = window.view.dom.querySelector('h1')!;
    const cs = getComputedStyle(el);
    const pitch = 1.25 * parseFloat(cs.fontSize);
    return { lines: Math.round((el.getBoundingClientRect().height - parseFloat(cs.paddingTop)) / pitch), pitch };
  });
  expect(lines).toBe(2);
  const svg = await page.evaluate(() => window.__tableProofSvg());
  if (!svg) throw new Error('Typst compile failed');
  const [first, second] = typstBaselines(svg)[0];
  // The SVG prints 0.001 pt.
  expect(Math.abs(second - first - pitch), `${first} ${second}`).toBeLessThan(0.005);
});
