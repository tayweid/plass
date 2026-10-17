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
