import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';

// A formula inside a bold span compiles its ink in Typst's strong context,
// the same context the export's `*…*` run prints in. Under the pinned
// compiler strong leaves math untouched (equal advance); newer Typst
// emboldens and widens it, and the shared context keeps the editor's
// reservation equal to the print either way.
test('inline math inside a bold span compiles bold ink and stays exact', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate((filler) => {
    const { state } = window.view;
    const { schema } = state;
    const p = schema.nodes.paragraph;
    const strong = schema.marks.strong.create();
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      schema.nodes.heading.create({ level: 1 }, schema.text('Bold Math')),
      p.create(null, [
        schema.text('Regular: have '),
        schema.nodes.math_inline.create({ src: '2x' }),
        schema.text(' drinks. ' + filler.repeat(2)),
      ]),
      p.create(null, [
        schema.text('Bold: have ', [strong]),
        schema.nodes.math_inline.create({ src: '2x' }, null, [strong]),
        schema.text(' drinks.', [strong]),
        schema.text(' ' + filler.repeat(2)),
      ]),
      ...Array.from({ length: 6 }, () => p.create(null, schema.text(filler.repeat(5)))),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  }, FILLER);

  // Both formulas get Typst ink.
  await expect(page.locator('.math-inline.math-ink')).toHaveCount(2, { timeout: 30_000 });
  const widths = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.math-inline.math-ink')].map((el) => ({
      inStrong: Boolean(el.closest('strong')),
      width: parseFloat(el.querySelector('svg')!.style.width),
    })),
  );
  const regular = widths.find((w) => !w.inStrong)!;
  const bold = widths.find((w) => w.inStrong)!;
  expect(regular.width).toBeGreaterThan(0);
  // Never narrower than the regular ink; equal under the pinned compiler.
  expect(bold.width).toBeGreaterThanOrEqual(regular.width - 0.01);

  // The compiled page oracle still takes authority with the bold formula
  // in the flow (its fragment markup and the export agree on the context).
  await expect
    .poll(() => page.evaluate(() => window.__pagLog().at(-1)?.startsWith('exact[') ?? false), {
      timeout: 30_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(true);

  // The exporter keeps the span one run around the formula.
  const typ = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return docToTyp(window.view.state.doc);
  });
  expect(typ).toContain('*Bold: have #mi(`2x`) drinks.*');
});
