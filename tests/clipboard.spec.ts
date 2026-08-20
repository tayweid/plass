import { expect, test } from 'playwright/test';

// Copying TEXT out of a block copies the text. Copying across blocks copies
// the blocks. ProseMirror slices at the selection's own depth, which used to
// make the first case behave like the second: highlighting a bullet's words
// and pasting them onto an empty line turned that line into a bullet.

const shape = (page: import('playwright/test').Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    window.view.state.doc.forEach((n) => out.push(`${n.type.name}:${n.textContent}`));
    return out;
  });

async function build(page: import('playwright/test').Page) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const item = (t: string) => s.nodes.list_item.create(null, s.nodes.paragraph.create(null, s.text(t)));
    window.view.dispatch(
      state.tr.replaceWith(
        0,
        state.doc.content.size,
        s.nodes.doc.create(state.doc.attrs, [
          s.nodes.bullet_list.create(null, [item('Alpha beta'), item('Second item')]),
          s.nodes.paragraph.create(null, s.text('Plain para')),
          s.nodes.paragraph.create(null),
        ]).content,
      ),
    );
  });
}

/** Copy the text of the paragraph(s) whose text starts with `first`/ends with `last`. */
async function copyText(page: import('playwright/test').Page, first: string, last = first) {
  await page.evaluate(([first, last]) => {
    const d = window.view.state.doc;
    let from = -1;
    let to = -1;
    d.descendants((n, pos) => {
      if (n.type.name !== 'paragraph') return true;
      if (from < 0 && n.textContent.startsWith(first)) from = pos + 1;
      if (n.textContent.startsWith(last)) to = pos + 1 + n.content.size;
      return true;
    });
    const Sel = window.view.state.selection.constructor as unknown as {
      create(doc: unknown, a: number, b: number): never;
    };
    window.view.dispatch(window.view.state.tr.setSelection(Sel.create(d, from, to)));
    window.view.focus();
  }, [first, last]);
  await page.keyboard.press('ControlOrMeta+c');
}

async function pasteOnTheEmptyLine(page: import('playwright/test').Page) {
  await page.evaluate(() => {
    const { state } = window.view;
    const Sel = state.selection.constructor as unknown as { create(doc: unknown, a: number): never };
    window.view.dispatch(state.tr.setSelection(Sel.create(state.doc, state.doc.content.size - 1)));
    window.view.focus();
  });
  await page.keyboard.press('ControlOrMeta+v');
  await page.waitForTimeout(350);
}

test("a bullet's text pastes onto a new line without the bullet", async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await build(page);
  await copyText(page, 'Alpha beta');
  await pasteOnTheEmptyLine(page);
  expect((await shape(page)).at(-1)).toBe('paragraph:Alpha beta');
});

test('a selection spanning two bullets still pastes as a list', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await build(page);
  await copyText(page, 'Alpha beta', 'Second item');
  await pasteOnTheEmptyLine(page);
  const after = await shape(page);
  expect(after.filter((s) => s.startsWith('bullet_list'))).toHaveLength(2);
  expect(after.at(-1)).toBe('bullet_list:Alpha betaSecond item');
});

test('a whole paragraph still pastes as a paragraph', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await build(page);
  await copyText(page, 'Plain para');
  await pasteOnTheEmptyLine(page);
  expect((await shape(page)).at(-1)).toBe('paragraph:Plain para');
});
