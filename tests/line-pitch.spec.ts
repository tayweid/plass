import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// A body line's Typst frame is the face's cap height, 0.683 em for New
// Computer Modern (font-registry.ts `extent`; font-registry.test.ts reads
// it from the font file), and the exported leading is the line height less
// it, so Typst pitches lines at the editor's line height exactly. With a
// measured 0.6828 the leading came out 0.0025 pt long and Typst's pitch
// was 25.0033 px against the page's 25 (12.5 pt, line height 1.5): by a
// page's 35th line the print ran 0.12 px below the page, and where the
// page bottom fell that close to a line Typst moved on a line the page
// kept.
//
// Each case is one long paragraph, compiled once with the port audit
// (`__audit`); Typst's baselines are read from the same compile's SVG.

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

/** Typst's baselines per page, pt from the page top: each `.typst-text`
 *  group's translates summed below its `.typst-page`. */
function typstBaselines(svg: string): number[][] {
  const pages: number[][] = [];
  const stack: Array<{ y: number; page: boolean }> = [];
  const re = /<(\/?)g\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const [, close, attrs, selfClose] = m;
    if (close) {
      stack.pop();
      continue;
    }
    const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const tr = /transform="translate\(([-\d.]+)[, ]+([-\d.]+)\)"/.exec(attrs);
    const isPage = cls.split(/\s+/).includes('typst-page');
    const y = isPage ? 0 : (stack.at(-1)?.y ?? 0) + (tr ? Number(tr[2]) : 0);
    if (isPage) pages.push([]);
    else if (cls.split(/\s+/).includes('typst-text') && pages.length) pages[pages.length - 1].push(y);
    if (!selfClose) stack.push({ y, page: isPage });
  }
  return pages.map((ys) => [...new Set(ys)].sort((a, b) => a - b));
}

async function paragraphAt(page: Page, marginTop: number) {
  await page.goto('/?new=1');
  await page.evaluate(({ sentence, marginTop }) => {
    const { state } = window.view;
    const { schema } = state;
    const tr = state.tr.replaceWith(0, state.doc.content.size, schema.nodes.paragraph.create(null, schema.text(sentence.repeat(40).trim())));
    tr.setDocAttribute('settings', { ...state.doc.attrs.settings, marginTop, marginRight: 1, marginBottom: 1, marginLeft: 1 });
    window.view.dispatch(tr);
  }, { sentence: SENTENCE, marginTop });
  await settleLocal(page, 0);
}

test('Typst pitches body lines at the line height the page paints', async ({ page }) => {
  test.setTimeout(90_000);
  await paragraphAt(page, 1);
  const svg = await page.evaluate(() => window.__tableProofSvg());
  if (!svg) throw new Error('Typst compile failed');
  // The painted line tops, by sheet: a word whose caret top moved starts a line.
  const painted = await page.evaluate(() => {
    const view = window.view;
    const sheets = [...document.querySelectorAll<HTMLElement>('#pages .page-box')].map((el) => el.getBoundingClientRect().top);
    const text = view.state.doc.textContent;
    const out: number[][] = sheets.map(() => []);
    let last = Number.NEGATIVE_INFINITY;
    for (const m of text.matchAll(/\S+/g)) {
      const top = view.coordsAtPos(1 + m.index!, 1).top;
      if (Math.abs(top - last) > 2) {
        const k = sheets.findLastIndex((s) => top >= s);
        out[k].push(top - sheets[k]);
      }
      last = top;
    }
    return out;
  });
  // The page number is a text group in the bottom margin: only lines.
  const contentBottomPt = 11 * 72 - 72;
  const typst = typstBaselines(svg).map((ys) => ys.filter((y) => y <= contentBottomPt).map((y) => (y * 4) / 3));
  expect(typst.map((ys) => ys.length)).toEqual(painted.map((ys) => ys.length));
  expect(painted[0].length).toBeGreaterThanOrEqual(34);
  for (let p = 0; p < typst.length; p++) {
    // Each baseline sits the same distance below its painted line on the
    // whole sheet: no drift from line to line. (The SVG prints 0.001 pt.)
    const offsets = typst[p].map((y, k) => y - painted[p][k]);
    const spread = Math.max(...offsets) - Math.min(...offsets);
    expect(spread, `sheet ${p + 1}: ${offsets.map((o) => o.toFixed(4)).join(' ')}`).toBeLessThan(0.005);
  }
});

// Where the page bottom falls a fraction of a pixel from a line, the page
// breaks where Typst does. At a top margin of 1.0266 in the 35th line fits
// with 0.06 px to spare and stays on page 1; the old leading put it 0.06
// px past the margin in print, and Typst moved it. At 1.029 in it runs
// 0.17 px past and starts page 2 on both sides. At 1.0278 in it runs 0.05
// px past: the page kept it while the paginator's fit tolerance
// (FIT_TOLERANCE_PX in typeset-plugin.ts) was 0.1 px; it is one layout
// unit, 1/64 px, since the page's geometry is exact to that.
for (const { marginTop, startsPage2 } of [
  { marginTop: 1.029, startsPage2: 34 },
  { marginTop: 1.0278, startsPage2: 34 },
  { marginTop: 1.0266, startsPage2: 35 },
]) {
  test(`a page bottom at a ${marginTop} in top margin breaks where Typst breaks it`, async ({ page }) => {
    test.setTimeout(90_000);
    await paragraphAt(page, marginTop);
    const report = await page.evaluate(() => window.__audit());
    if (!report) throw new Error('port audit: Typst compile failed');
    expect(report.pages.agree, JSON.stringify(report.pages.firstDiff)).toBe(true);
    expect(report.pages.local.map((s) => [s.pos, s.line])).toEqual([[0, startsPage2]]);
  });
}
