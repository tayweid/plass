import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
  }
}

// Regression: the SVG sanitizer once stripped the compiled text layer
// (foreignObject .tsel spans), silently failing the page oracle on every
// document. The fallback paginator masked it for plain paragraphs (it splits
// them at line boundaries) but moves list items whole — a long bullet
// crossing a page boundary left a large gap instead of splitting mid-item.
test('page oracle splits a long bullet across the page boundary', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const { schema } = state;
    const p = schema.nodes.paragraph;
    const li = schema.nodes.list_item;
    const filler =
      'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      schema.nodes.heading.create({ level: 1 }, schema.text('Fall 2024 Notes')),
      schema.nodes.bullet_list.create(null, [
        li.create(null, p.create(null, schema.text('A short first bullet that spans about two lines when justified at the page measure. '))),
        li.create(null, p.create(null, schema.text(`Second bullet. ${filler.repeat(20)}`))),
        li.create(null, p.create(null, schema.text(`Third bullet. ${filler.repeat(28)}`))),
        li.create(null, p.create(null, schema.text('A short trailing bullet.'))),
      ]),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });

  // The compiled page oracle must take authority (not the local fallback).
  await expect
    .poll(
      () => page.evaluate(() => window.__pagLog().at(-1)?.startsWith('exact[') ?? false),
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);

  // Typst splits the long bullets mid-item: every page spacer must sit
  // INSIDE a list-item paragraph, and the bullets stay on consecutive pages
  // without the moved-whole gap.
  const spacers = await page.evaluate(() =>
    [...document.querySelectorAll('.ts-pagegap')].map((el) => ({
      insideListItem: Boolean(el.closest('li > p')),
      height: parseFloat((el as HTMLElement).style.height),
    })),
  );
  expect(spacers.length).toBeGreaterThanOrEqual(2);
  for (const spacer of spacers) {
    expect(spacer.insideListItem).toBe(true);
    // A moved-whole bullet manufactures a gap of hundreds of px; a mid-item
    // split's spacer is page-gap + margins only.
    expect(spacer.height).toBeLessThan(400);
  }
});
