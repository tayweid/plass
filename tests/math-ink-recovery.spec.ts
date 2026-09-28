import { expect, test } from './fixture';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __mathInk: () => Record<string, number>;
    __portAtoms: (pos: number) => Array<{ type: string; domPt: number; typstPt: number | null }> | null;
  }
}

const FILLER = 'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings. ';

// A formula's Typst width is compiled in the background. When the compiler
// cannot run it (here: the first compile outlasts the 20 s preview deadline
// while the compiler wasm is still downloading, as on a slow connection),
// the circuit pauses previews and every queued formula is refused. Those
// formulas were cached as failed for good and laid out at KaTeX's width,
// silently. Now they are deferred: marked on the page, and compiled again
// at the next edit.
test('formulas the compiler could not run are marked, then measured after an edit', async ({ page }) => {
  test.setTimeout(120_000);
  let held = false;
  await page.route('**/typst_ts_web_compiler_bg*.wasm*', async (route) => {
    if (held) return route.continue();
    held = true;
    await new Promise((r) => setTimeout(r, 23_000));
    await route.continue().catch(() => {});
  });
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate((filler) => {
    const { state } = window.view;
    const { schema } = state;
    const p = schema.nodes.paragraph;
    const doc = schema.nodes.doc.create(
      state.doc.attrs,
      Array.from({ length: 3 }, (_, i) =>
        p.create(null, [
          schema.text(`Inline `),
          schema.nodes.math_inline.create({ src: `x^${i} + y` }),
          schema.text(` sits here. ${filler}`),
        ]),
      ),
    );
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  }, FILLER);

  const unmeasured = page.locator('.math-inline.math-unmeasured');
  await expect(unmeasured).toHaveCount(3, { timeout: 40_000 });
  await expect(unmeasured.first()).toHaveAttribute('title', /has not measured this formula/);
  expect(await page.evaluate(() => window.__mathInk())).toEqual({ deferred: 3 });

  // Any document edit is the trusted boundary that lets the compiler run again.
  await page.evaluate(() => window.view.dispatch(window.view.state.tr.insertText('!', 1)));
  await expect(page.locator('.math-inline.math-ink')).toHaveCount(3, { timeout: 40_000 });
  await expect(unmeasured).toHaveCount(0);
  expect(await page.evaluate(() => window.__mathInk())).toEqual({ ready: 3 });
});

// A formula Typst rejects is terminal, and says so.
test('a formula Typst cannot compile is marked', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(() => {
    const { state } = window.view;
    const { schema } = state;
    const para = schema.nodes.paragraph.create(null, [
      schema.text('Broken '),
      schema.nodes.math_inline.create({ src: '\\begin{x}' }),
      schema.text(' here.'),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, para));
  });
  const el = page.locator('.math-inline.math-unmeasured');
  await expect(el).toHaveCount(1, { timeout: 40_000 });
  await expect(el).toHaveAttribute('title', /could not compile/);
});
