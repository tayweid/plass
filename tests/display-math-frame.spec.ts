import { expect, test } from './fixture';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

// A display equation's block is Typst's equation frame (vertical parity):
// its content box, inside the 0.5em padding the export's equation spacing
// is derived from (`equationBlockSpacingEm`), is exactly the frame Typst
// lays in the flow. The svg used to sit inline on a text baseline, so the
// block also held the line's strut below the ink (a one-letter formula was
// a whole line tall), and it took the svg page's height, which the
// compiler rounds up to whole points. Frames measured in the pinned Typst
// (0.14.2) from the compiled flow, in em of the document size: `x` 5.6625pt
// and the integral 33.135pt at 12.5pt. (Unnumbered: a number can make the
// frame taller, the next test.)
test('a display equation is exactly as tall as its Typst frame', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const { schema } = state;
    const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      p('Before the equations.'),
      schema.nodes.math_display.create({ src: 'x', numbered: false }),
      p('Between them.'),
      schema.nodes.math_display.create({ src: '\\int_0^1 f(x) \\, dx = F(1) - F(0)', numbered: false }),
      p('After them.'),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });
  await expect(page.locator('.math-display.math-ink')).toHaveCount(2, { timeout: 30_000 });
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.math-display.math-ink')].map((el) => {
      const cs = getComputedStyle(el);
      const content = el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      return { content, em: parseFloat(cs.fontSize) };
    }),
  );
  const [x, integral] = boxes;
  expect(Math.abs(x.content - (5.6625 / 12.5) * x.em), `x: ${x.content}px`).toBeLessThan(0.05);
  expect(Math.abs(integral.content - (33.135 / 12.5) * integral.em), `integral: ${integral.content}px`).toBeLessThan(0.05);
});

// A numbered equation's frame holds its number: Typst sets "(1)" on the
// equation's baseline and grows the frame to hold it, so `x` (5.6625pt
// bare) is 8.675pt numbered, its ink 3.0125pt below the frame's top, and
// the integral, taller than its number, keeps its own 33.135pt. Measured in
// the pinned Typst at 12.5pt: `measure` of the numbered equation, and the
// baseline of a tag at the body's head. Turning the document's numbering
// off gives `x` its bare frame back; the per-equation attr beats the
// setting.
test('a numbered display equation is as tall as its number', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const { schema } = state;
    const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      p('Before the equations.'),
      schema.nodes.math_display.create({ src: 'x' }),
      p('Between them.'),
      schema.nodes.math_display.create({ src: '\\int_0^1 f(x) \\, dx = F(1) - F(0)' }),
      p('And the last.'),
      schema.nodes.math_display.create({ src: 'x', numbered: true }),
      p('After them.'),
    ]);
    const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
    window.view.dispatch(tr.setDocAttribute('settings', { ...state.doc.attrs.settings, sizePt: 12.5, numberEquations: true }));
  });
  await expect(page.locator('.math-display.math-ink')).toHaveCount(3, { timeout: 30_000 });
  const read = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.math-display.math-ink')].map((el) => {
        const cs = getComputedStyle(el);
        const content = el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        const svg = el.querySelector('svg')!;
        const inkTop = svg.getBoundingClientRect().top - el.getBoundingClientRect().top - parseFloat(cs.paddingTop);
        return { content, inkTop, em: parseFloat(cs.fontSize) };
      }),
    );
  const pt = (v: number, em: number) => (v / 12.5) * em;
  const near = (got: number, want: number) => Math.abs(got - want) < 0.05;
  await expect.poll(async () => near((await read())[0].content, pt(8.675, (await read())[0].em)), { timeout: 10_000 }).toBe(true);
  const [x, integral, own] = await read();
  expect(near(x.content, pt(8.675, x.em)), `numbered x: ${x.content}px`).toBe(true);
  expect(near(x.inkTop, pt(3.0125, x.em)), `numbered x ink: ${x.inkTop}px below the frame's top`).toBe(true);
  expect(near(integral.content, pt(33.135, integral.em)), `numbered integral: ${integral.content}px`).toBe(true);
  expect(near(own.content, pt(8.675, own.em)), `x numbered by its attr: ${own.content}px`).toBe(true);

  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.setDocAttribute('settings', { ...state.doc.attrs.settings, numberEquations: false }));
  });
  await expect.poll(async () => near((await read())[0].content, pt(5.6625, (await read())[0].em)), { timeout: 10_000 }).toBe(true);
  const [bare, , stillOwn] = await read();
  expect(near(bare.inkTop, 0), `unnumbered x ink: ${bare.inkTop}px`).toBe(true);
  expect(near(stillOwn.content, pt(8.675, stillOwn.em)), `x numbered by its attr, document unnumbered: ${stillOwn.content}px`).toBe(true);
});
