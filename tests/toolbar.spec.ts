import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

test('Text style menu toggles strikethrough and preserves the selection', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text('cut this phrase'));
    const doc = state.schema.nodes.doc.create(state.doc.attrs, [paragraph]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });
  await page.click('.ProseMirror');
  await page.keyboard.press('ControlOrMeta+a');

  const textStyle = page.getByRole('button', { name: 'Text style', exact: true });
  const menu = page.getByRole('menu', { name: 'Text style', exact: true });
  const strikeBtn = page.locator('button[title^="Strikethrough"]');
  const selection = await page.evaluate(() => window.view.state.selection.toJSON());
  await textStyle.click();
  await expect(menu).toBeVisible();
  const items = menu.locator('button:not(:disabled)');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  expect(await page.evaluate(() => window.view.state.selection.toJSON())).toEqual(selection);
  await strikeBtn.click();
  await expect(page.locator('.ProseMirror s')).toHaveText('cut this phrase');
  await expect(menu).toBeHidden();
  expect(await page.evaluate(() => window.view.state.selection.toJSON())).toEqual(selection);

  // Same button un-toggles (the selection survives the click because the
  // toolbar swallows mousedown).
  await textStyle.click();
  await strikeBtn.click();
  await expect(page.locator('.ProseMirror s')).toHaveCount(0);

  // The keymap drives the same mark.
  await page.keyboard.press('ControlOrMeta+Shift+x');
  await expect(page.locator('.ProseMirror s')).toHaveText('cut this phrase');
});

test('toolbar and open menus fit a narrow window with a long filename', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?new=1');
  await expect(page.getByRole('button', { name: 'Headings', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const fm = window.__fm as unknown as { rename(name: string): Promise<void> };
    await fm.rename('A very long manuscript title with tables and side-by-side grids');
  });
  await expect(page.locator('.tb-file')).toHaveText('A very long manuscript title with tables and side-by-side grids');

  const visibleButtons = page.locator('#toolbar button:visible');
  await expect(visibleButtons).toHaveCount(10);
  for (const name of ['File', 'Headings', 'Text style', 'Lists', 'Insert figure', 'Inline math', 'Footnote', 'Extras', 'Document settings', 'Export']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  for (const button of await visibleButtons.all()) {
    const bounds = await button.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  }

  const extras = page.getByRole('button', { name: 'Extras', exact: true });
  await extras.click();
  const menu = page.getByRole('menu', { name: 'Extras', exact: true });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(812);
  for (const name of ['Alignment', 'Blocks', 'Code']) {
    await page.mouse.move(8, 400);
    const group = menu.locator('.tb-flyout-wrap', { has: page.getByRole('menuitem', { name, exact: true }) });
    await group.hover();
    const flyout = group.locator('.tb-flyout');
    await expect(flyout).toBeVisible();
    const flyoutBounds = await flyout.boundingBox();
    expect(flyoutBounds).not.toBeNull();
    expect(flyoutBounds!.x).toBeGreaterThanOrEqual(0);
    expect(flyoutBounds!.x + flyoutBounds!.width).toBeLessThanOrEqual(375);
    expect(flyoutBounds!.y + flyoutBounds!.height).toBeLessThanOrEqual(812);
  }
  await page.mouse.click(8, 790);
  await expect(menu).toBeHidden();
});

test('Extras keeps glyph controls with hover captions', async ({ page }) => {
  await page.goto('/?new=1');
  const settings = page.getByRole('button', { name: 'Document settings', exact: true });
  await expect(settings).toBeVisible();
  await page.getByRole('button', { name: 'Extras', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Extras', exact: true });
  const grid = menu.getByRole('menuitem', { name: 'Grid', exact: true });
  const caption = grid.locator('.lbl');
  await expect(grid.locator('.ico')).toBeVisible();
  await expect(caption).toHaveText('Grid');
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await grid.hover();
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await page.mouse.move(8, 400);
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await grid.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(grid).toBeFocused();
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
});

test('the plain text switch stays visible in the lower-left corner in either view', async ({ page }) => {
  await page.goto('/?new=1');
  const switcher = page.getByRole('button', { name: 'Plain text view', exact: true });
  await expect(switcher).toHaveAttribute('aria-pressed', 'false');
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    for (const active of [false, true]) {
      await expect(switcher).toBeVisible();
      await expect(switcher).toHaveAttribute('aria-pressed', String(active));
      const bounds = await switcher.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x).toBeLessThan(viewport.width / 4);
      expect(bounds!.y).toBeGreaterThan(viewport.height * 3 / 4);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      await switcher.click();
      await expect(switcher).toHaveAttribute('aria-pressed', String(!active));
      await expect(page.locator('#source .cm-content')).toHaveCount(active ? 0 : 1);
    }
  }
});

test('menus open, navigate, and close from the keyboard', async ({ page }) => {
  await page.goto('/?new=1');
  const headings = page.getByRole('button', { name: 'Headings', exact: true });
  const menu = page.getByRole('menu', { name: 'Headings', exact: true });
  await headings.focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu).toBeVisible();
  await expect(headings).toHaveAttribute('aria-expanded', 'true');
  const items = menu.locator('button:not(:disabled)');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(headings).toHaveAttribute('aria-expanded', 'false');
  await expect(headings).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(headings).toBeFocused();

  await page.getByRole('button', { name: 'Extras', exact: true }).click();
  const extras = page.getByRole('menu', { name: 'Extras', exact: true });
  const alignment = extras.getByRole('menuitem', { name: 'Alignment', exact: true });
  await alignment.focus();
  await page.keyboard.press('ArrowRight');
  await expect(alignment).toHaveAttribute('aria-expanded', 'true');
  const flyout = extras.getByRole('menu', { name: 'Alignment', exact: true });
  await expect(flyout).toBeVisible();
  await expect(flyout.locator('button:not(:disabled)').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(flyout).toBeHidden();
  await expect(alignment).toHaveAttribute('aria-expanded', 'false');
  await expect(alignment).toBeFocused();
  await expect(extras).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(extras).toBeHidden();
});

test('Headings and Extras apply headings and alignment to a whole-document selection', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const paragraph = state.schema.nodes.paragraph;
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [
      paragraph.create(null, state.schema.text('First paragraph.')),
      paragraph.create(null, state.schema.text('Second paragraph.')),
    ]));
  });
  await page.click('.ProseMirror');
  await page.keyboard.press('ControlOrMeta+a');
  const headings = page.getByRole('button', { name: 'Headings', exact: true });
  await headings.click();
  const heading = page.getByTitle('Heading 2 (⌘⌥2)', { exact: true });
  await expect(heading).toBeEnabled();
  await heading.click();
  await expect(page.locator('.ProseMirror h2')).toHaveText(['First paragraph.', 'Second paragraph.']);

  await headings.click();
  await page.getByTitle('Body text (⌘⌥0)', { exact: true }).click();
  await expect(page.locator('.ProseMirror > p').filter({ hasText: /paragraph\./ })).toHaveText(['First paragraph.', 'Second paragraph.']);
  await page.getByRole('button', { name: 'Extras', exact: true }).click();
  await page.locator('.tb-flyout-wrap', { has: page.getByRole('menuitem', { name: 'Alignment', exact: true }) }).hover();
  const center = page.getByTitle('Center text', { exact: true });
  await expect(center).toBeEnabled();
  await center.click();
  expect(await page.evaluate(() => {
    const attrs: unknown[] = [];
    window.view.state.doc.forEach((node) => {
      if (node.textContent) attrs.push(node.attrs.align);
    });
    return attrs;
  })).toEqual(['center', 'center']);
});

test('Lists reports and changes spacing for the nearest nested list', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const { paragraph, list_item, bullet_list, ordered_list } = state.schema.nodes;
    const nested = ordered_list.create({ tight: false }, [
      list_item.create(null, [paragraph.create(null, state.schema.text('Nested item.'))]),
    ]);
    const outer = bullet_list.create({ tight: true }, [
      list_item.create(null, [paragraph.create(null, state.schema.text('Outer item.')), nested]),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, outer));
  });
  await page.locator('.ProseMirror ol p').click();
  const lists = page.getByRole('button', { name: 'Lists', exact: true });
  await lists.click();
  const spacing = page.getByTitle('Item spacing (⌘⇧7) — tight, or loose with paragraph spacing between items', { exact: true });
  await expect(spacing).toHaveAttribute('aria-checked', 'true');
  await spacing.click();
  await lists.click();
  await expect(spacing).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => {
    const outer = window.view.state.doc.firstChild!;
    return [outer.attrs.tight, outer.firstChild!.lastChild!.attrs.tight];
  })).toEqual([true, true]);
});
