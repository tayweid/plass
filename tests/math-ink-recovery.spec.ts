import { expect, test } from './fixture';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __mathInk: () => Record<string, number>;
    __portAtoms: (pos: number) => Array<{ type: string; domPt: number; typstPt: number | null }> | null;
  }
}

const FILLER = 'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings. ';

async function loadFormulas(page: import('playwright/test').Page) {
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
}

const COMPILER_WASM = '**/typst_ts_web_compiler_bg*.wasm*';

// A formula's Typst width is compiled in the background, and the first
// compile has to download the 28 MB compiler. The 20 s preview deadline
// guards Typst's own work on a source; it once also ran during the
// download, so a slow connection timed out the first formula, paused the
// compiler, and left every formula at KaTeX's width.
test('a compiler download slower than the preview deadline still measures every formula', async ({ page }) => {
  test.setTimeout(120_000);
  let held = false;
  await page.route(COMPILER_WASM, async (route) => {
    if (held) return route.continue();
    held = true;
    await new Promise((r) => setTimeout(r, 23_000));
    await route.continue().catch(() => {});
  });
  await loadFormulas(page);
  await expect(page.locator('.math-inline.math-ink')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.locator('.math-inline.math-unmeasured')).toHaveCount(0);
  expect(await page.evaluate(() => window.__mathInk())).toEqual({ ready: 3 });
});

// A compiler that could not be loaded once (a dropped download) says
// nothing about the formulas: as soon as a later compile succeeds, the
// refused ones are asked for again, without an edit.
test('formulas refused while the compiler failed to load are measured once it loads', async ({ page }) => {
  test.setTimeout(120_000);
  let refused = false;
  await page.route(COMPILER_WASM, async (route) => {
    if (refused) return route.continue();
    refused = true;
    await route.abort('failed');
  });
  await loadFormulas(page);
  await expect(page.locator('.math-inline.math-ink')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.locator('.math-inline.math-unmeasured')).toHaveCount(0);
  expect(refused).toBe(true);
});

// With no compiler at all, the formulas are not failed for good (they once
// were, silently): they are deferred, marked on the page, and compiled
// again at the next edit.
test('formulas the compiler could not run are marked, then measured after an edit', async ({ page }) => {
  test.setTimeout(120_000);
  let online = false;
  await page.route(COMPILER_WASM, (route) => (online ? route.continue() : route.abort('failed')));
  await loadFormulas(page);

  const unmeasured = page.locator('.math-inline.math-unmeasured');
  await expect(unmeasured).toHaveCount(3, { timeout: 40_000 });
  await expect(unmeasured.first()).toHaveAttribute('title', /has not measured this formula \(The Typst compiler could not be loaded/);
  expect(await page.evaluate(() => window.__mathInk())).toEqual({ deferred: 3 });

  // Back online, any document edit lets the compiler run again.
  online = true;
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
