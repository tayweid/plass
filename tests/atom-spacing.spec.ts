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

  // A space typed right BEFORE a formula, then a word.
  await page.evaluate(() => {
    const p = window.view.state.doc.child(0);
    let pos = 1;
    p.forEach((n, off) => { if (n.type.name === 'math_inline' && pos === 1) pos = 1 + off; });
    const TS = window.view.state.selection.constructor as typeof import('prosemirror-state').TextSelection;
    window.view.dispatch(window.view.state.tr.setSelection(TS.create(window.view.state.doc, pos)));
    window.view.focus();
  });
  await page.keyboard.type(' of');
  expect(await page.evaluate(() => window.view.state.doc.child(0).child(0).text)).toBe('area of');
});

// A `~` in a .typ file right after a formula is intentional glue: it is
// not the browser's artifact and the normalizer leaves it alone, on load
// and on edit.
test('an imported non-breaking space after a formula survives loading and editing', async ({ page }) => {
  await page.goto('/?new=1');
  const text = await page.evaluate(async () => {
    const { typToDoc } = await import('/src/typ-parser.ts');
    const { doc } = typToDoc('Glue #mi(`x`)~here and more.\n');
    const { state } = window.view;
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content).setMeta('addToHistory', false));
    window.view.focus();
    return window.view.state.doc.child(0).textContent;
  });
  expect(text).toBe('Glue \u00a0here and more.'.replace('Glue \u00a0', 'Glue \u00a0'));
  expect(text.includes('\u00a0here')).toBe(true);
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited.');
  const after = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return { text: window.view.state.doc.child(0).textContent, typ: docToTyp(window.view.state.doc) };
  });
  expect(after.text.includes('\u00a0here')).toBe(true);
  expect(after.typ).toContain('#mi(`x`)~here');
});
