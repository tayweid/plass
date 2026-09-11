import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

// A space typed right after an inline formula arrives from Chrome as a
// non-breaking space (the editor's white-space: normal would collapse a
// plain one at the end of a text node). The document must hold a plain
// space once a word follows, or the export writes `~` and the formula is
// welded to the next word.
test('a space typed after inline math is a plain space in the document and the export', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => window.view.focus());
  await page.keyboard.type('area $a^2$ done, and $b$ too');
  const parts = await page.evaluate(() => {
    const out: string[] = [];
    window.view.state.doc.child(0).forEach((n) => out.push(n.isText ? n.text! : `<${n.type.name}>`));
    return out;
  });
  expect(parts).toEqual(['area ', '<math_inline>', ' done, and ', '<math_inline>', ' too']);
  expect(parts.join('')).not.toContain(' ');
  const typ = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return docToTyp(window.view.state.doc);
  });
  expect(typ).toContain('area #mi(`a^2`) done, and #mi(`b`) too');
  expect(typ).not.toMatch(/\)~/);
});
