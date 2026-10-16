import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Classic (indented) paragraphs have no margin on the page: `--par-margin`
// is 0 (settings.ts), and Typst's paragraph spacing is the leading
// (`parSpacingEm`). The spacing a heading or a display equation prints
// above it is the page's gap from the paragraph before it, so it carries
// the paragraph's margin only when the page does. It used to add the
// spaced mode's 0.9 em whatever the mode, and in classic mode the print
// put every heading and display equation 15 px lower than the page did.
//
// Measured line to line: from the last line of the paragraph before a
// heading (or a run of headings, or an equation) to the first line of the
// paragraph after it, the page's line tops against Typst's baselines in
// the same compile. A body line's frame sits the same way in every
// paragraph box, so the two gaps are equal when the page and the print
// agree.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagCount: () => number;
    __tableProofSvg: () => Promise<string | null>;
  }
}

const SENTENCE = 'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';

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

type Gaps = { heading: number; run: number; equation: number };

/** One page: a paragraph, an H2, a paragraph, an H1 and an H3 in a run, a
 *  paragraph, a display equation, a paragraph. The three line-to-line gaps,
 *  printed and painted. */
async function gaps(page: Page, parIndent: boolean): Promise<{ typst: Gaps; painted: Gaps }> {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(
    ({ sentence, parIndent }) => {
      const { state } = window.view;
      const { schema } = state;
      const par = () => schema.nodes.paragraph.create(null, schema.text(sentence.repeat(2).trim()));
      const heading = (level: number) => schema.nodes.heading.create({ level }, schema.text('A section'));
      const tr = state.tr.replaceWith(0, state.doc.content.size, [
        par(),
        heading(2),
        par(),
        heading(1),
        heading(3),
        par(),
        schema.nodes.math_display.create({ src: 'x^2 + y^2 = z^2' }),
        par(),
      ]);
      tr.setDocAttribute('settings', { ...state.doc.attrs.settings, parIndent, marginTop: 1, marginRight: 1, marginBottom: 1, marginLeft: 1 });
      window.view.dispatch(tr);
    },
    { sentence: SENTENCE, parIndent },
  );
  await settleLocal(page, 0);
  // The page's paragraphs, in layout px (the test window draws the paper
  // at 1:1): first line top, last line top, line count.
  const paras = await page.evaluate(() =>
    [...window.view.dom.querySelectorAll<HTMLElement>(':scope > p')].map((el) => {
      const r = el.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      return { first: r.top, last: r.bottom - lh, lines: Math.round(r.height / lh) };
    }),
  );
  expect(paras).toHaveLength(4);
  const svg = await page.evaluate(() => window.__tableProofSvg());
  if (!svg) throw new Error('Typst compile failed');
  // Page 1's text area (1 in margins on Letter): the page number is below it.
  const pages = typstBaselines(svg);
  expect(pages).toHaveLength(1);
  const ys = pages[0].filter((y) => y >= 96 && y <= 11 * 96 - 96);
  const [a, b, c, d] = paras.map((p) => p.lines);
  // a lines, the H2, b lines, the H1 and the H3, c lines, the equation's
  // ink (one baseline or more), d lines.
  expect(ys.length).toBeGreaterThan(a + 1 + b + 2 + c + d);
  return {
    typst: {
      heading: ys[a + 1] - ys[a - 1],
      run: ys[a + b + 3] - ys[a + b],
      equation: ys[ys.length - d] - ys[a + b + c + 2],
    },
    painted: {
      heading: paras[1].first - paras[0].last,
      run: paras[2].first - paras[1].last,
      equation: paras[3].first - paras[2].last,
    },
  };
}

for (const parIndent of [true, false]) {
  test(`${parIndent ? 'classic' : 'spaced'} paragraphs: headings print where the page puts them`, async ({ page }) => {
    test.setTimeout(90_000);
    const { typst, painted } = await gaps(page, parIndent);
    const detail = JSON.stringify({ typst, painted });
    // The SVG prints 0.001 pt; the heading boxes are snapped to 1/64 px.
    expect(Math.abs(typst.heading - painted.heading), detail).toBeLessThan(0.05);
    expect(Math.abs(typst.run - painted.run), detail).toBeLessThan(0.05);
  });
}

// The page's equation box is its line box, taller than the formula's
// frame for a formula shorter than a line, so the gap across an equation
// is not yet the print's in either mode (ROADMAP). Whatever that offset
// is, classic mode must not add to it: the print's gap shrinks by the
// paragraph margin the page drops.
test('classic paragraphs: a display equation prints where the page puts it, as in spaced mode', async ({ page }) => {
  test.setTimeout(120_000);
  const classic = await gaps(page, true);
  const spaced = await gaps(page, false);
  const offset = (g: { typst: Gaps; painted: Gaps }) => g.typst.equation - g.painted.equation;
  expect(Math.abs(offset(classic) - offset(spaced)), JSON.stringify({ classic, spaced })).toBeLessThan(0.05);
});
