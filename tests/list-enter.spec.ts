import { expect, test } from './fixture';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

// Enter twice at the end of a list item leaves the list: the empty item
// becomes a paragraph and the list is cut in half around it. The real
// keypress path (ref autocomplete, comment keymap, the editing keymap, then
// baseKeymap) is what these pin; src/list-enter.test.ts has the shapes.

/** Item a (with sub-items x and y when `nested`), then item b; the caret at
 *  the end of a. */
async function listWithCaretAfterA(page: import('./fixture').Page, nested: boolean) {
  await page.goto('/?new=1');
  await page.evaluate((nested) => {
    const { state } = window.view;
    const { schema } = state;
    const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
    const li = schema.nodes.list_item;
    const ul = schema.nodes.bullet_list;
    const sub = ul.create(null, [li.create(null, p('x')), li.create(null, p('y'))]);
    const list = ul.create(null, [li.create(null, nested ? [p('a'), sub] : [p('a')]), li.create(null, p('b'))]);
    let tr = state.tr.replaceWith(0, state.doc.content.size, list);
    const TS = state.selection.constructor as typeof import('prosemirror-state').TextSelection;
    // After "a": list, item, paragraph open, then the letter.
    tr = tr.setSelection(TS.create(tr.doc, 4));
    window.view.dispatch(tr);
    window.view.focus();
  }, nested);
}

const outline = (page: import('./fixture').Page) =>
  page.evaluate(() => {
    const { doc, selection } = window.view.state;
    const kinds: string[] = [];
    doc.forEach((node) => {
      const items: string[] = [];
      if (node.type.name.endsWith('_list')) node.forEach((item) => items.push(item.firstChild!.textContent));
      kinds.push(node.type.name.endsWith('_list') ? `${node.type.name}[${items.join(',')}]` : node.type.name);
    });
    return { kinds, depth: selection.$from.depth, inEmptyParagraph: selection.$from.parent.content.size === 0 };
  });

test('Enter twice on an item that holds a sub-list exits to a paragraph between the halves', async ({ page }) => {
  await listWithCaretAfterA(page, true);
  await page.keyboard.press('Enter');
  expect(await outline(page)).toEqual({ kinds: ['bullet_list[a,,b]'], depth: 3, inEmptyParagraph: true });
  await page.keyboard.press('Enter');
  expect(await outline(page)).toEqual({
    kinds: ['bullet_list[a]', 'paragraph', 'bullet_list[x,y,b]'],
    depth: 1,
    inEmptyParagraph: true,
  });
  // The paragraph is the writer's: typing goes there, not into a list.
  await page.keyboard.type('between');
  expect(await page.evaluate(() => window.view.state.doc.child(1).textContent)).toBe('between');
});

test('Enter twice in the middle of a flat list cuts it in half (unchanged)', async ({ page }) => {
  await listWithCaretAfterA(page, false);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  expect(await outline(page)).toEqual({
    kinds: ['bullet_list[a]', 'paragraph', 'bullet_list[b]'],
    depth: 1,
    inEmptyParagraph: true,
  });
});
