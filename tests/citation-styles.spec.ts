import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __citationOracle: { runs: () => number; overrides: () => ReadonlyMap<string, string> };
  }
}

const BIB = `@article{knuth86,
  author = {Knuth, Donald E. and Plass, Michael F.},
  title = {Breaking Paragraphs into Lines},
  journal = {Software: Practice and Experience},
  year = {1981},
}

@book{lamport94, author = {Lamport, Leslie}, title = {{LaTeX}: A Document Preparation System}, year = {1994}}
`;

// The citation style is a document setting. The in-text string comes from
// a ported formatter and is checked against the compiler: the References
// block's compile renders every citation too, and a drift would swap in
// the compiled string. For these entries there is no drift.
test('the APA style paints author-year citations that the compiler agrees with', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.__citationOracle);
  await page.evaluate((bib) => {
    const { state } = window.view;
    const { schema } = state;
    const p = schema.nodes.paragraph.create(null, [
      schema.text('Line breaking '),
      schema.nodes.citation.create({ key: 'knuth86' }),
      schema.text(' and typesetting '),
      schema.nodes.citation.create({ key: 'lamport94' }),
      schema.text(' again '),
      schema.nodes.citation.create({ key: 'knuth86' }),
      schema.text('.'),
    ]);
    const doc = schema.nodes.doc.create(
      { ...state.doc.attrs, bib: { name: 'references.bib', content: bib }, settings: { ...state.doc.attrs.settings, citationStyle: 'apa' } },
      [p, schema.nodes.bibliography.create()],
    );
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content).setDocAttribute('bib', doc.attrs.bib).setDocAttribute('settings', doc.attrs.settings));
  }, BIB);
  const painted = () => page.evaluate(() => [...document.querySelectorAll('.ts-cite')].map((el) => el.getAttribute('data-cite-num')));
  expect(await painted()).toEqual(['(Knuth & Plass, 1981)', '(Lamport, 1994)', '(Knuth & Plass, 1981)']);

  // The compiler check runs off the References compile and finds no drift.
  await expect.poll(() => page.evaluate(() => window.__citationOracle.runs()), { timeout: 40_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => [...window.__citationOracle.overrides().keys()])).toEqual([]);
  expect(await painted()).toEqual(['(Knuth & Plass, 1981)', '(Lamport, 1994)', '(Knuth & Plass, 1981)']);

  // The export carries the style; switching back repaints numbers.
  const typ = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return docToTyp(window.view.state.doc);
  });
  expect(typ).toContain('title: "References", style: "apa")');
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.setDocAttribute('settings', { ...state.doc.attrs.settings, citationStyle: 'ieee' }));
  });
  expect(await painted()).toEqual(['[1]', '[2]', '[1]']);
});
