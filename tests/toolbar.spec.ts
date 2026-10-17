import { expect, test } from './fixture';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

test('Bold and Italic are one-click tiles; Strikethrough lives in Extras; the selection survives', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text('cut this phrase'));
    const doc = state.schema.nodes.doc.create(state.doc.attrs, [paragraph]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });
  await page.click('.ProseMirror');
  await page.keyboard.press('ControlOrMeta+a');
  const selection = await page.evaluate(() => window.view.state.selection.toJSON());

  // One click each, pressed while the selection carries the mark, and the
  // selection survives (the tiles swallow mousedown).
  const bold = page.locator('#rail').getByRole('button', { name: 'Bold', exact: true });
  const italic = page.locator('#rail').getByRole('button', { name: 'Italic', exact: true });
  const marks = () => page.evaluate(() => {
    const names = new Set<string>();
    window.view.state.doc.descendants((node) => { for (const mark of node.marks) names.add(mark.type.name); });
    return [...names].sort();
  });
  await bold.click();
  expect(await marks()).toEqual(['strong']);
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await italic.click();
  expect(await marks()).toEqual(['em', 'strong']);
  expect(await page.evaluate(() => window.view.state.selection.toJSON())).toEqual(selection);
  await bold.click();
  await italic.click();
  expect(await marks()).toEqual([]);
  await expect(bold).toHaveAttribute('aria-pressed', 'false');

  // Strikethrough, the occasional one, is in Extras.
  const extras = page.getByRole('button', { name: 'Extras', exact: true });
  const menu = page.getByRole('menu', { name: 'Extras', exact: true });
  const strikeBtn = menu.locator('button[title^="Strikethrough"]');
  await extras.click();
  await expect(menu).toBeVisible();
  await strikeBtn.click();
  await expect(page.locator('.ProseMirror s')).toHaveText('cut this phrase');
  await expect(menu).toBeHidden();
  expect(await page.evaluate(() => window.view.state.selection.toJSON())).toEqual(selection);
  await extras.click();
  await strikeBtn.click();
  await expect(page.locator('.ProseMirror s')).toHaveCount(0);

  // The keymap drives the same mark.
  await page.keyboard.press('ControlOrMeta+Shift+x');
  await expect(page.locator('.ProseMirror s')).toHaveText('cut this phrase');
});

test('the bar, the rail and the open menus fit a narrow window with a long filename', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?new=1');
  await expect(page.getByRole('button', { name: 'Heading level', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const fm = window.__fm as unknown as { rename(name: string): Promise<void> };
    await fm.rename('A very long manuscript title with tables and side-by-side grids');
  });
  await expect(page.locator('#file-name')).toHaveText('A very long manuscript title with tables and side-by-side grids');

  // The bar holds the paper's way in and out; the rail, every tool.
  const barButtons = page.locator('#toolbar button:visible');
  await expect(barButtons).toHaveCount(3);
  for (const name of ['File', 'Export PDF', 'Export']) {
    await expect(page.locator('#toolbar').getByRole('button', { name, exact: true })).toBeVisible();
  }
  const railButtons = page.locator('#rail button:visible');
  await expect(railButtons).toHaveCount(16);
  for (const name of ['Heading level', 'Bold', 'Italic', 'Bulleted list', 'Numbered list', 'Insert figure', 'Inline math', 'Footnote', 'Insert', 'Block quote', 'Solution', 'Comment', 'Remove quote', 'Extras', 'Document settings', 'Plain text view']) {
    await expect(page.locator('#rail').getByRole('button', { name, exact: true })).toBeVisible();
  }
  for (const button of [...(await barButtons.all()), ...(await railButtons.all())]) {
    const bounds = await button.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(812);
  }

  // The flyouts from the rail stay inside the window too.
  const flyout = async (trigger: string, groups: string[]) => {
    await page.getByRole('button', { name: trigger, exact: true }).click();
    const menu = page.getByRole('menu', { name: trigger, exact: true });
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(812);
    await expect(menu.getByRole('group')).toHaveCount(groups.length);
    for (const name of groups) {
      const group = menu.getByRole('group', { name, exact: true });
      await expect(group).toBeVisible();
      for (const button of await group.locator('button:visible').all()) {
        const buttonBounds = await button.boundingBox();
        expect(buttonBounds).not.toBeNull();
        expect(buttonBounds!.x).toBeGreaterThanOrEqual(bounds!.x);
        expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      }
    }
    await expect(menu.locator('[aria-haspopup]')).toHaveCount(0);
    await page.mouse.click(200, 790);
    await expect(menu).toBeHidden();
  };
  await flyout('Insert', ['Insert']);
  await flyout('Extras', ['Text', 'Alignment', 'Code', 'Document']);
});

test('the Insert flyout keeps glyph controls with hover captions', async ({ page }) => {
  await page.goto('/?new=1');
  const settings = page.getByRole('button', { name: 'Document settings', exact: true });
  await expect(settings).toBeVisible();
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Insert', exact: true });
  const grid = menu.getByRole('menuitem', { name: 'Grid', exact: true });
  const caption = grid.locator('.lbl');
  await expect(grid.locator('.ico')).toBeVisible();
  await expect(caption).toHaveText('Grid');
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await grid.hover();
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  // Beside the panel, level with the glyph, as a rail tile's caption sits
  // beside the rail: it covers nothing in the panel.
  const panel = (await menu.boundingBox())!;
  const glyph = (await grid.boundingBox())!;
  const label = (await caption.boundingBox())!;
  expect(label.x).toBeGreaterThanOrEqual(panel.x + panel.width);
  expect(Math.abs(label.y + label.height / 2 - (glyph.y + glyph.height / 2))).toBeLessThan(1.5);
  await page.mouse.move(8, 400);
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await grid.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(grid).toBeFocused();
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
});

test('Settings stays inside a narrow window and its lower dropdowns remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 650 });
  await page.goto('/?new=1');
  const trigger = page.getByRole('button', { name: 'Document settings', exact: true });
  await trigger.click();
  const panel = page.getByRole('dialog', { name: 'Document settings', exact: true });
  const bounds = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(367);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(642);
  await expect(panel.locator('.settings-row').filter({ hasText: 'Custom size (in)' })).toBeHidden();

  const rule = panel.locator('.settings-row').filter({ hasText: 'Footnote rule' });
  await rule.locator('.ts-select-btn').click();
  const choices = rule.locator('.ts-select-menu');
  await expect(choices).toBeVisible();
  const menuBounds = (await choices.boundingBox())!;
  expect(menuBounds.y).toBeGreaterThanOrEqual(bounds.y);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  await choices.getByRole('button', { name: 'Full width', exact: true }).click();
  expect(await page.evaluate(() => window.view.state.doc.attrs.settings.footnoteSeparator)).toBe('full');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
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
  const headings = page.getByRole('button', { name: 'File', exact: true });
  const menu = page.getByRole('menu', { name: 'File', exact: true });
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

  // A rail tile's flyout also opens to the right.
  const insert = page.getByRole('button', { name: 'Insert', exact: true });
  const insertMenu = page.getByRole('menu', { name: 'Insert', exact: true });
  await insert.focus();
  await page.keyboard.press('ArrowRight');
  await expect(insertMenu).toBeVisible();
  await expect(insertMenu.locator('button:not(:disabled)').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(insertMenu).toBeHidden();
  await expect(insert).toBeFocused();

  await page.getByRole('button', { name: 'Extras', exact: true }).click();
  const extras = page.getByRole('menu', { name: 'Extras', exact: true });
  const alignment = extras.getByRole('menuitemcheckbox', { name: 'Justified', exact: true });
  await alignment.focus();
  await page.keyboard.press('ArrowRight');
  await expect(extras.getByRole('menuitemcheckbox', { name: 'Center', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(alignment).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(extras).toBeHidden();
  await expect(page.getByRole('button', { name: 'Extras', exact: true })).toBeFocused();
});

test('a mouse click after Escape leaves no ring or caption on the tile Escape went back to', async ({ page }) => {
  await page.goto('/?new=1');
  for (const name of ['Insert', 'File']) {
    const tile = page.getByRole('button', { name, exact: true });
    const caption = tile.locator('.lbl');
    const opacity = () => caption.evaluate((el) => getComputedStyle(el).opacity);
    await tile.click();
    await expect(page.getByRole('menu', { name, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tile).toBeFocused();
    await expect.poll(opacity).toBe('1');
    // The tiles swallow mousedown, so the click on another tile moves no
    // focus by itself; the settings panel takes none either.
    const settings = page.getByRole('button', { name: 'Document settings', exact: true });
    await settings.click();
    const panel = page.getByRole('dialog', { name: 'Document settings', exact: true });
    await expect(panel).toBeVisible();
    await expect(tile).not.toBeFocused();
    await expect.poll(opacity).toBe('0');
    await settings.click();
    await expect(panel).toHaveCount(0);
  }
});

test('the Heading tile steps a whole-document selection up a size per click, and Extras aligns it', async ({ page }) => {
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
  const tile = page.locator('#rail').getByRole('button', { name: 'Heading level', exact: true });
  const glyph = tile.locator('.tico');
  await expect(glyph).toHaveText('¶');
  await expect(tile).toHaveAttribute('title', 'Body text · click for Heading 3 (⌘⌥0–3)');
  // Body → H3 → H2 → H1 → body, one click each.
  for (const level of [3, 2, 1]) {
    await tile.click();
    await expect(page.locator(`.ProseMirror h${level}`)).toHaveText(['First paragraph.', 'Second paragraph.']);
    await expect(glyph).toHaveText(`H${level}`);
  }
  await expect(tile).toHaveAttribute('title', 'Heading 1 · click for Body text (⌘⌥0–3)');
  await tile.click();
  await expect(glyph).toHaveText('¶');
  await expect(page.locator('.ProseMirror > p').filter({ hasText: /paragraph\./ })).toHaveText(['First paragraph.', 'Second paragraph.']);

  await page.getByRole('button', { name: 'Extras', exact: true }).click();
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

test('the list tiles toggle: wrap, switch kind, lift out', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, state.schema.nodes.paragraph.create(null, state.schema.text('An item.'))));
  });
  await page.locator('.ProseMirror p', { hasText: 'An item.' }).click();
  const bullets = page.locator('#rail').getByRole('button', { name: 'Bulleted list', exact: true });
  const numbers = page.locator('#rail').getByRole('button', { name: 'Numbered list', exact: true });
  const kind = () => page.evaluate(() => {
    const { $from } = window.view.state.selection;
    return $from.depth > 1 ? $from.node($from.depth - 2).type.name : $from.parent.type.name;
  });
  await bullets.click();
  expect(await kind()).toBe('bullet_list');
  await expect(bullets).toHaveAttribute('aria-pressed', 'true');
  await numbers.click();
  expect(await kind()).toBe('ordered_list');
  await expect(numbers).toHaveAttribute('aria-pressed', 'true');
  await expect(bullets).toHaveAttribute('aria-pressed', 'false');
  await numbers.click();
  expect(await kind()).toBe('paragraph');
  await expect(numbers).toHaveAttribute('aria-pressed', 'false');
});

test('Extras reports and changes spacing for the nearest nested list', async ({ page }) => {
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
  const extras = page.getByRole('button', { name: 'Extras', exact: true });
  await extras.click();
  const spacing = page.getByTitle('Loose list spacing (⌘⇧7) — paragraph spacing between items, or tight', { exact: true });
  await expect(spacing).toHaveAttribute('aria-checked', 'true');
  await spacing.click();
  await extras.click();
  await expect(spacing).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => {
    const outer = window.view.state.doc.firstChild!;
    return [outer.attrs.tight, outer.firstChild!.lastChild!.attrs.tight];
  })).toEqual([true, true]);
});
