import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
  }
}

// Regression: a footnote's rendered superscript number glues onto whatever
// precedes it in the extracted text layer — even when the document itself
// holds a real space right before the marker (typing "word " and then
// inserting a footnote is the ordinary way to do it), because Typst drops
// that source space rather than rendering it. The oracle's spec builder
// predicted a space there, so the very first footnote-bearing paragraph
// typed this way permanently lost exact pagination for the whole document.
test('page oracle reaches exact pagination for a footnote marker typed with a leading space', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const { schema } = state;
    const p = schema.nodes.paragraph;
    const fn = schema.nodes.footnote;
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      schema.nodes.heading.create({ level: 1 }, schema.text('Footnote pagination')),
      p.create(null, [
        schema.text('This paragraph has a marker '),
        fn.create(null, schema.text('First footnote body text.')),
        schema.text(' continues after the marker.'),
      ]),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });

  await expect
    .poll(
      () => page.evaluate(() => window.__pagLog().at(-1)?.startsWith('exact[') ?? false),
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);
});

// Two footnote-bearing paragraphs on the page, each with a leading space
// before its marker — the pattern most likely to appear across a real
// document once one such paragraph exists.
test('page oracle reaches exact pagination for two footnote-bearing paragraphs', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const { schema } = state;
    const p = schema.nodes.paragraph;
    const fn = schema.nodes.footnote;
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      schema.nodes.heading.create({ level: 1 }, schema.text('Two footnotes pagination')),
      p.create(null, [
        schema.text('This paragraph has a marker '),
        fn.create(null, schema.text('First footnote body text.')),
        schema.text(' continues after the marker.'),
      ]),
      p.create(null, [
        schema.text('This second paragraph has another marker '),
        fn.create(null, schema.text('Second footnote body text.')),
        schema.text(' continues after the marker too.'),
      ]),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });

  await expect
    .poll(
      () => page.evaluate(() => window.__pagLog().at(-1)?.startsWith('exact[') ?? false),
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);
});
