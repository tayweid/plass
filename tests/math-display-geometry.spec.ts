import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// A display equation's painted box is its Typst frame inside 0.5em of
// padding (MATH_DISPLAY_PAD_EM): the ink is drawn as a block at the
// frame's measured height, and the paginator fits the frame, not the
// padding, at a page's foot and top. Measured against the same compile's
// SVG and the port audit (`__audit`).

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __mathInk: () => Record<string, number>;
    __tableProofSvg: () => Promise<string | null>;
    __audit: () => Promise<{
      pages: {
        agree: boolean;
        local: Array<{ pos: number; line: number; unit: string }>;
        firstDiff: unknown;
      };
    } | null>;
  }
}

const SENTENCE = 'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';
const FORMULA = '\\int_0^1 f(x) \\, dx = F(1) - F(0)';

/** A paragraph of `before` sentences, the formula, a paragraph of 20, at a
 *  top margin of 1 in + `d` px. */
async function equationAt(page: Page, before: number, d: number) {
  await page.goto('/?new=1');
  await page.evaluate(({ sentence, formula, before, marginTop }) => {
    const { state } = window.view;
    const { schema } = state;
    const p = (n: number) => schema.nodes.paragraph.create(null, schema.text(sentence.repeat(n).trim()));
    const tr = state.tr.replaceWith(0, state.doc.content.size, [p(before), schema.nodes.math_display.create({ src: formula }), p(20)]);
    tr.setDocAttribute('settings', { ...state.doc.attrs.settings, marginTop, marginRight: 1, marginBottom: 1, marginLeft: 1 });
    window.view.dispatch(tr);
  }, { sentence: SENTENCE, formula: FORMULA, before, marginTop: 1 + d / 96 });
  await expect.poll(() => page.evaluate(() => window.__mathInk().pending ?? 0), { timeout: 60_000 }).toBe(0);
  await settleLocal(page, -1, 1500);
}

/** Typst's text baselines by page, px from the page top: each
 *  `.typst-text` group's translates summed below its `.typst-page`. */
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
  return pages.map((ys) => [...new Set(ys)].map((y) => (y * 4) / 3));
}

/** Each painted body line's distance above Typst's baseline, by sheet. */
async function baselineOffsets(page: Page): Promise<number[][]> {
  const svg = await page.evaluate(() => window.__tableProofSvg());
  if (!svg) throw new Error('Typst compile failed');
  const typst = typstBaselines(svg);
  const painted = await page.evaluate(() => {
    const view = window.view;
    const sheets = [...document.querySelectorAll<HTMLElement>('#pages .page-box')].map((el) => el.getBoundingClientRect().top);
    const out: number[][] = sheets.map(() => []);
    let last = Number.NEGATIVE_INFINITY;
    view.state.doc.descendants((node, pos) => {
      if (!node.isText) return true;
      for (const m of node.text!.matchAll(/\S+/g)) {
        const top = view.coordsAtPos(pos + m.index!, 1).top;
        if (Math.abs(top - last) > 2) {
          const k = sheets.findLastIndex((s) => top >= s);
          out[k].push(top - sheets[k]);
        }
        last = top;
      }
      return false;
    });
    return out;
  });
  return painted.map((tops, k) =>
    tops.map((top) => {
      const ys = typst[k].filter((y) => y > top + 8 && y < top + 24);
      return ys.length ? Math.max(...ys) - top : Number.NaN;
    }),
  );
}

const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

// The box is the padding and the frame: the lines after the equation sit
// where Typst prints them. The ink was drawn inline, on the text baseline,
// from a page rounded up to a whole point (34 pt for a 33.14 pt frame), so
// the box was 7.1 px taller than the print and math.md's fourth page kept
// a line fewer than Typst's.
test("a display equation's box is its frame and padding", async ({ page }) => {
  test.setTimeout(90_000);
  await equationAt(page, 12, 0);
  const [sheet] = await baselineOffsets(page);
  expect(sheet.length).toBeGreaterThan(30);
  expect(spread(sheet), sheet.map((o) => o.toFixed(3)).join(' ')).toBeLessThan(0.05);
});

// At a page's foot the frame must fit, not the padding below it: 3 px
// below 1 in Typst keeps the equation on the first page, which the page
// moved while it fitted the box's bottom.
test('an equation at the foot of a page stays where Typst keeps it', async ({ page }) => {
  test.setTimeout(90_000);
  await equationAt(page, 28, 3);
  const report = await page.evaluate(() => window.__audit());
  if (!report) throw new Error('port audit: Typst compile failed');
  expect(report.pages.agree, JSON.stringify(report.pages.firstDiff)).toBe(true);
  expect(report.pages.local.map((s) => s.unit)).toEqual(['paragraph']);
});

// An equation that opens a page lands its frame at the margin, as Typst
// drops its spacing there: the lines after it sit on the second page
// where Typst prints them, as the first page's lines do on theirs.
test('an equation opening a page lands its frame at the margin', async ({ page }) => {
  test.setTimeout(90_000);
  await equationAt(page, 28, 9);
  const report = await page.evaluate(() => window.__audit());
  if (!report) throw new Error('port audit: Typst compile failed');
  expect(report.pages.agree, JSON.stringify(report.pages.firstDiff)).toBe(true);
  expect(report.pages.local.map((s) => s.unit)).toEqual(['block']);
  const [first, second] = await baselineOffsets(page);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  expect(second.length).toBeGreaterThan(10);
  expect(spread(second)).toBeLessThan(0.05);
  expect(Math.abs(mean(second) - mean(first)), `${mean(first).toFixed(3)} ${mean(second).toFixed(3)}`).toBeLessThan(0.1);
});
