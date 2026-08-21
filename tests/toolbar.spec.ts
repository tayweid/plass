import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

test('text-style flyout toggles strikethrough on the selection', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text('cut this phrase'));
    const doc = state.schema.nodes.doc.create(state.doc.attrs, [paragraph]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });
  await page.click('.ProseMirror');
  await page.keyboard.press('ControlOrMeta+a');

  // Hover the wrap, not the trigger: the opened flyout overlaps its
  // trigger by design, which Playwright would report as interception.
  const strikeBtn = page.locator('button[title^="Strikethrough"]');
  const wrap = page.locator('.tb-flyout-wrap', { has: strikeBtn });
  await wrap.hover();
  await strikeBtn.click();
  await expect(page.locator('.ProseMirror s')).toHaveText('cut this phrase');

  // Same button un-toggles (the selection survives the click because the
  // toolbar swallows mousedown).
  await wrap.hover();
  await strikeBtn.click();
  await expect(page.locator('.ProseMirror s')).toHaveCount(0);

  // The keymap drives the same mark.
  await page.keyboard.press('ControlOrMeta+Shift+x');
  await expect(page.locator('.ProseMirror s')).toHaveText('cut this phrase');
});
