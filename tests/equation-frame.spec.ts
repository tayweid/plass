import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// A display equation's Typst frame is the formula's own box, and on the
// page it is the `.math-display` box's content, inside the 0.5 em padding
// that starts and ends Typst's spacing around it. The ink svg used to sit
// on the baseline of a line box: a formula shorter than a line (13 pt in a
// 25 px line) filled the whole line, and a taller one carried the line's
// descent below it, so the paragraph after an equation painted 6-13 px
// below its print. The paginator took the padded box for the frame, so an
// equation within about 15 px of the bottom margin went to the next page
// while Typst kept it, and one at a page top painted 0.5 em below its
// print. And the ink's own page comes back rounded up to whole points (a
// 12.91 pt frame as a 13 pt svg): the frame is Typst's measure of the
// formula, not the svg's height.
//
// Each case is compiled once with the port audit (`__audit`); Typst's
// baselines are read from the same compile's SVG.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __tableProofSvg: () => Promise<string | null>;
    __audit: () => Promise<{
      pages: { agree: boolean; local: Array<{ pos: number; line: number }>; firstDiff: unknown };
    } | null>;
  }
}

const SENTENCE = 'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';

/** Baselines per page, px from the page top: each `.typst-text` group's
 *  translates summed below its `.typst-page` (an equation's own ink svg is
 *  one page). */
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

/** A 32-line paragraph, the equation, a short paragraph; 1 in margins but
 *  the top one. Resolves once the equation's ink is on the page (KaTeX's
 *  echo stands in for it until then). */
async function open(page: Page, marginTop: number, src: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(
    ({ sentence, marginTop, src }) => {
      const { state } = window.view;
      const { schema } = state;
      const tr = state.tr.replaceWith(0, state.doc.content.size, [
        schema.nodes.paragraph.create(null, schema.text(sentence.repeat(28).trim())),
        schema.nodes.math_display.create({ src }),
        schema.nodes.paragraph.create(null, schema.text(sentence.repeat(4).trim())),
      ]);
      tr.setDocAttribute('settings', { ...state.doc.attrs.settings, marginTop, marginRight: 1, marginBottom: 1, marginLeft: 1 });
      window.view.dispatch(tr);
    },
    { sentence: SENTENCE, marginTop, src },
  );
  await page.waitForFunction(() => Boolean(document.querySelector('.math-display.math-ink')));
  await settleLocal(page, 0);
}

/** The equation's sheet and its ink's first baseline there, px from the
 *  sheet top: the painted svg's top plus the ink svg's own first baseline. */
async function paintedInk(page: Page): Promise<{ sheet: number; baseline: number; frameBottom: number }> {
  const r = await page.evaluate(() => {
    const sheets = [...document.querySelectorAll<HTMLElement>('#pages .page-box')].map((el) => el.getBoundingClientRect().top);
    const md = document.querySelector<HTMLElement>('.math-display')!;
    const svg = md.querySelector('svg')!;
    const top = svg.getBoundingClientRect().top;
    const sheet = sheets.findLastIndex((s) => top >= s);
    const frameBottom = md.getBoundingClientRect().bottom - parseFloat(getComputedStyle(md).paddingBottom);
    return { sheet, top: top - sheets[sheet], frameBottom: frameBottom - sheets[sheet], svg: svg.outerHTML };
  });
  const [ink] = typstBaselines(r.svg);
  return { sheet: r.sheet, baseline: r.top + ink[0], frameBottom: r.frameBottom };
}

const CONTENT_BOTTOM = 11 * 96 - 96;

// At a 1 in top margin the short formula's frame ends 31.8 px above the
// bottom margin and the integral's 4.8 px: each top margin below puts the
// frame about 3 px inside the margin or 3 px past it.
for (const { src, stays, moves } of [
  { src: 'x^2 + y^2 = z^2', stays: 1.3, moves: 1.36 },
  { src: '\\int_0^1 f(x) \\, dx = F(1) - F(0)', stays: 1.02, moves: 1.08 },
]) {
  test(`an equation whose frame fits above the bottom margin stays on the page, as in print: ${src}`, async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, stays, src);
    const report = await page.evaluate(() => window.__audit());
    if (!report) throw new Error('port audit: Typst compile failed');
    const ink = await paintedInk(page);
    expect(ink.sheet).toBe(0);
    expect(CONTENT_BOTTOM - ink.frameBottom).toBeGreaterThan(2);
    expect(CONTENT_BOTTOM - ink.frameBottom).toBeLessThan(4);
    expect(report.pages.agree, JSON.stringify(report.pages.firstDiff)).toBe(true);
    // One page start: the paragraph after the equation, part way through.
    const after = await page.evaluate(() => window.view.state.doc.child(0).nodeSize + window.view.state.doc.child(1).nodeSize);
    expect(report.pages.local.map((s) => s.pos)).toEqual([after]);
  });

  test(`an equation that starts a page prints where the page paints it: ${src}`, async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, moves, src);
    const report = await page.evaluate(() => window.__audit());
    if (!report) throw new Error('port audit: Typst compile failed');
    expect(report.pages.agree, JSON.stringify(report.pages.firstDiff)).toBe(true);
    const eqPos = await page.evaluate(() => window.view.state.doc.child(0).nodeSize);
    expect(report.pages.local.map((s) => s.pos)).toEqual([eqPos]);
    // Typst drops the spacing above the equation at the page top, so its
    // frame is at the margin: the page's ink baseline is the print's.
    const ink = await paintedInk(page);
    expect(ink.sheet).toBe(1);
    const svg = await page.evaluate(() => window.__tableProofSvg());
    if (!svg) throw new Error('Typst compile failed');
    const printed = typstBaselines(svg)[1][0];
    // The SVG prints 0.001 pt; the page is exact to a layout unit.
    expect(Math.abs(printed - ink.baseline), `print ${printed} page ${ink.baseline}`).toBeLessThan(0.05);
  });
}

/** A paragraph, the equation, a paragraph: the gap from the last line
 *  before the equation to the first line after it, printed and painted. */
async function gap(page: Page, src: string, numberEquations: boolean): Promise<{ typst: number; painted: number }> {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(
    ({ sentence, src, numberEquations }) => {
      const { state } = window.view;
      const { schema } = state;
      const par = () => schema.nodes.paragraph.create(null, schema.text(sentence.repeat(2).trim()));
      const tr = state.tr.replaceWith(0, state.doc.content.size, [par(), schema.nodes.math_display.create({ src }), par()]);
      tr.setDocAttribute('settings', { ...state.doc.attrs.settings, numberEquations, marginTop: 1, marginRight: 1, marginBottom: 1, marginLeft: 1 });
      window.view.dispatch(tr);
    },
    { sentence: SENTENCE, src, numberEquations },
  );
  await page.waitForFunction(() => Boolean(document.querySelector('.math-display.math-ink')));
  await settleLocal(page, 0);
  const paras = await page.evaluate(() =>
    [...window.view.dom.querySelectorAll<HTMLElement>(':scope > p')].map((el) => {
      const r = el.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      return { first: r.top, last: r.bottom - lh, lines: Math.round(r.height / lh) };
    }),
  );
  const svg = await page.evaluate(() => window.__tableProofSvg());
  if (!svg) throw new Error('Typst compile failed');
  // Page 1's text area: the page number is below it.
  const ys = typstBaselines(svg)[0].filter((y) => y >= 96 && y <= CONTENT_BOTTOM);
  const [a, b] = paras.map((p) => p.lines);
  return { typst: ys[ys.length - b] - ys[a - 1], painted: paras[1].first - paras[0].last };
}

// Typst sets a one-line equation's number on its baseline, and the frame
// grows by what the number's cap height has above the formula: `x = y`
// reaches only the x-height, and numbered it printed 4 px lower than the
// page. And Typst sets the rows of a multi-line equation apart by the
// paragraph leading: the ink was compiled at Typst's default leading, and
// two rows printed 2.8 px apart from the page's (0.9 px in an `aligned`).
for (const { src, numbered } of [
  { src: 'x = y', numbered: true },
  { src: 'x = y', numbered: false },
  { src: 'x = y \\\\ u = v', numbered: true },
  { src: '\\begin{aligned} x &= y \\\\ u &= v \\end{aligned}', numbered: true },
]) {
  test(`${numbered ? 'a numbered' : 'an unnumbered'} equation prints where the page puts it: ${src}`, async ({ page }) => {
    test.setTimeout(90_000);
    const { typst, painted } = await gap(page, src, numbered);
    // The SVG prints 0.001 pt; the page's boxes and margins are snapped to
    // 1/64 px.
    expect(Math.abs(typst - painted), JSON.stringify({ typst, painted })).toBeLessThan(0.05);
  });
}
