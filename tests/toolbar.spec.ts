import { expect, test } from './fixture';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

/** Open the rail's drawer (the All tools switch at its top). */
async function openDrawer(page: import('playwright/test').Page) {
  const drawer = page.locator('#rail-drawer');
  await drawer.click();
  await expect(page.locator('html')).toHaveClass(/\brail-open\b/);
  await expect(drawer).toHaveAttribute('aria-pressed', 'true');
}

test('the drawer’s Strikethrough row toggles the mark and preserves the selection', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text('cut this phrase'));
    const doc = state.schema.nodes.doc.create(state.doc.attrs, [paragraph]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });
  await openDrawer(page);
  await page.click('.ProseMirror');
  await page.keyboard.press('ControlOrMeta+a');

  const strikeBtn = page.locator('#rail').getByRole('button', { name: 'Strikethrough', exact: true });
  const selection = await page.evaluate(() => window.view.state.selection.toJSON());
  await expect(strikeBtn).toBeVisible();
  await expect(strikeBtn).toHaveAttribute('aria-pressed', 'false');
  await strikeBtn.click();
  await expect(page.locator('.ProseMirror s')).toHaveText('cut this phrase');
  await expect(strikeBtn).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.view.state.selection.toJSON())).toEqual(selection);

  // Same row un-toggles (the selection survives the click because the
  // rail swallows mousedown).
  await strikeBtn.click();
  await expect(page.locator('.ProseMirror s')).toHaveCount(0);
  await expect(strikeBtn).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.view.state.selection.toJSON())).toEqual(selection);

  // The keymap drives the same mark.
  await page.keyboard.press('ControlOrMeta+Shift+x');
  await expect(page.locator('.ProseMirror s')).toHaveText('cut this phrase');
});

test('the Red text tile at rest toggles the mark over text and math, never a footnote marker', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const { schema } = state;
    const paragraph = schema.nodes.paragraph.create(null, [
      schema.text('the slope '),
      schema.nodes.math_inline.create({ src: '\\beta_1' }),
      schema.text(' is positive'),
      schema.nodes.footnote.create(null, schema.text('a note')),
    ]);
    const doc = schema.nodes.doc.create(state.doc.attrs, [paragraph]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });
  await page.click('.ProseMirror');
  await page.keyboard.press('ControlOrMeta+a');

  const redBtn = page.locator('#rail').getByRole('button', { name: 'Red text', exact: true });
  await expect(redBtn).toBeVisible();
  await expect(redBtn).toHaveAttribute('aria-pressed', 'false');
  await redBtn.click();
  // One wrapper over the whole run, the formula inside it (its SVG's own
  // style text is in the wrapper's text); the footnote marker after it,
  // the note's text red as Bold would make it.
  const red = page.locator('.ProseMirror .ts-color[data-color="red"]');
  const run = red.filter({ hasText: 'is positive' });
  await expect(run).toHaveCount(1);
  await expect(run).toContainText('the slope');
  await expect(redBtn).toHaveAttribute('aria-pressed', 'true');
  // Typst's own red, the formula's ink with it; the footnote marker stays.
  expect(await red.first().evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 65, 54)');
  await expect(page.locator('.ProseMirror .ts-color .math-inline')).toHaveCount(1);
  await expect(page.locator('.ProseMirror .ts-color .footnote-ref, .ProseMirror .ts-color sup')).toHaveCount(0);
  expect(await page.evaluate(() => {
    let marked = 0;
    window.view.state.doc.descendants((n) => { if (n.type.name === 'footnote' && n.marks.some((m) => m.type.name === 'color')) marked++; return true; });
    return marked;
  })).toBe(0);

  // The same tile un-toggles; the keymap drives the same mark.
  await redBtn.click();
  await expect(red).toHaveCount(0);
  await expect(redBtn).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ControlOrMeta+Shift+r');
  await expect(run).toHaveCount(1);

  // The file holds a pandoc span, the print a #text(fill: red) run.
  const out = await page.evaluate(async () => {
    const { docToMd } = await import('/src/md-serializer.ts');
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return { md: docToMd(window.view.state.doc), typ: docToTyp(window.view.state.doc, { islands: 'print' }) };
  });
  expect(out.md).toContain('[the slope $\\beta_1$ is positive]{.red}[^1]');
  expect(out.md).toContain('[^1]: [a note]{.red}');
  // The print's math is native Typst (`$beta _(1 )$`), spaced by the converter.
  expect(out.typ).toMatch(/#text\(fill: red\)\[the slope \$[^$]*beta[^$]*\$ is positive\]#footnote\[#text\(fill: red\)\[a note\]\]/);
});

/** The rail at rest, top to bottom: All tools over its hairline; Text
 *  (the two stepping tiles and Red text), Insert and Blocks; the foot's
 *  Bibliography and Document settings. The view switch is on the page,
 *  not the rail. */
const RAIL_AT_REST = [
  'All tools',
  'Heading level', 'Alignment', 'Red text',
  'Image', 'Table', 'Grid', 'Inline math', 'Footnote',
  'Block quote', 'Solution', 'Comment', 'Code block',
  'Bibliography', 'Document settings',
];

test('the bar, the rail and the open drawer fit a narrow window with a long filename', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?new=1');
  await expect(page.getByRole('button', { name: 'Image', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const fm = window.__fm as unknown as { rename(name: string): Promise<void> };
    await fm.rename('A very long manuscript title with tables and side-by-side grids');
  });
  await expect(page.locator('#file-name')).toHaveText('A very long manuscript title with tables and side-by-side grids');

  // The bar holds the paper's way in and out (and, the paper having no
  // file yet, Save… in its name pill); the rail, the tools.
  const barButtons = page.locator('#toolbar button:visible');
  await expect(barButtons).toHaveCount(6);
  for (const name of ['Open', 'Recent papers', 'New window', 'Save…', 'Export PDF', 'Export']) {
    await expect(page.locator('#toolbar').getByRole('button', { name, exact: true })).toBeVisible();
  }
  const railButtons = page.locator('#rail button:visible');
  await expect(railButtons).toHaveCount(RAIL_AT_REST.length);
  for (const name of RAIL_AT_REST) {
    await expect(page.locator('#rail').getByRole('button', { name, exact: true })).toBeVisible();
  }
  // In that order, down the rail.
  const order = await railButtons.evaluateAll((els) =>
    els.map((el) => [el.getAttribute('aria-label'), el.getBoundingClientRect().top] as const).sort((a, b) => a[1] - b[1]).map(([name]) => name));
  expect(order).toEqual(RAIL_AT_REST);
  // The groups at rest: Text, Insert and Blocks; Layout, Code and
  // Document are the drawer's alone.
  const restGroups = await page.locator('#rail .tb-rail-groups > .tb-rail-group:visible').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(restGroups).toEqual(['Text', 'Insert', 'Blocks']);
  await expect(page.locator('#rail .tb-rail-foot button:visible')).toHaveCount(2);
  await expect(page.locator('#rail .tb-rail-top button:visible')).toHaveCount(1);
  const viewSwitch = page.getByRole('button', { name: 'Plain text view', exact: true });
  await expect(viewSwitch).toBeVisible();
  for (const button of [...(await barButtons.all()), ...(await railButtons.all()), viewSwitch]) {
    const bounds = await button.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(812);
  }

  // Open, the drawer stays inside the window too: every row inside the
  // rail's width, every group's heading shown, the foot in view.
  await openDrawer(page);
  const rail = (await page.locator('#rail').boundingBox())!;
  expect(rail.x).toBeGreaterThanOrEqual(0);
  expect(rail.x + rail.width).toBeLessThanOrEqual(375);
  for (const name of ['Basics', 'Insert', 'Blocks', 'Layout', 'Code', 'Document', 'Keys']) {
    await expect(page.locator('#rail').getByRole('group', { name, exact: true }).locator('.tb-rail-head')).toBeVisible();
  }
  // The stepping tiles are the rail's at rest: the drawer lists each level
  // and alignment instead.
  await expect(page.locator('#rail').getByRole('group', { name: 'Text', exact: true })).toBeHidden();
  const rows = page.locator('#rail .tb-rail-group button:visible');
  expect(await rows.count()).toBeGreaterThan(RAIL_AT_REST.length);
  for (const row of await rows.all()) {
    const bounds = (await row.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(rail.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(rail.x + rail.width + 0.5);
  }
  for (const button of await page.locator('#rail .tb-rail-foot button:visible').all()) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(812);
  }
});

test('the rail’s tiles keep glyphs with hover captions beside the rail', async ({ page }) => {
  await page.goto('/?new=1');
  const settings = page.getByRole('button', { name: 'Document settings', exact: true });
  await expect(settings).toBeVisible();
  const rail = page.locator('#rail');
  const grid = rail.getByRole('button', { name: 'Grid', exact: true });
  const caption = grid.locator('.lbl');
  await expect(grid.locator('.ico')).toBeVisible();
  await expect(caption).toHaveText('Grid');
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await grid.hover();
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  // Beside the rail, level with the glyph: it covers nothing in the rail.
  const railBox = (await rail.boundingBox())!;
  const glyph = (await grid.boundingBox())!;
  const label = (await caption.boundingBox())!;
  expect(label.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
  expect(Math.abs(label.y + label.height / 2 - (glyph.y + glyph.height / 2))).toBeLessThan(1.5);
  await page.mouse.move(400, 8);
  await expect.poll(() => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  // A tile the keyboard reaches shows its caption too.
  await rail.getByRole('button', { name: 'Table', exact: true }).focus();
  await page.keyboard.press('Tab');
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

test('the view switch is a chip at the panel’s lower left in either view, clear of the HUD, beside the open drawer too', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  const switcher = page.getByRole('button', { name: 'Plain text view', exact: true });
  // On the page, not in the rail, and no rail tile: no hover caption.
  expect(await switcher.evaluate((el) => ({ inRail: !!el.closest('#rail'), parent: el.parentElement!.tagName, tile: el.classList.contains('tb-btn') })))
    .toEqual({ inRail: false, parent: 'BODY', tile: false });
  await expect(switcher.locator('.lbl')).toHaveCount(0);
  const place = () => page.evaluate(() => {
    const s = document.querySelector('.view-switch')!.getBoundingClientRect();
    const panel = document.getElementById('scroll')!.getBoundingClientRect();
    const hud = document.getElementById('hud')!;
    const h = hud.getBoundingClientRect();
    const hudShown = getComputedStyle(hud).display !== 'none' && h.width > 0;
    return {
      left: s.left - panel.left,
      bottom: panel.bottom - s.bottom,
      clearOfHud: !hudShown || s.right <= h.left || s.left >= h.right || s.bottom <= h.top || s.top >= h.bottom,
      title: (document.querySelector('.view-switch') as HTMLElement).title,
    };
  });
  // The source glyph alone: no word on the chip, its name in its title.
  expect(await switcher.evaluate((el) => ({ text: el.textContent, glyph: el.querySelector('svg')!.innerHTML })))
    .toEqual({ text: '', glyph: '<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>' });
  await expect.poll(place).toEqual({ left: 10, bottom: 10, clearOfHud: true, title: 'Switch to plain text (⌘/)' });
  await switcher.click();
  await expect(page.locator('#source .cm-content')).toHaveCount(1);
  await expect(switcher).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(place).toEqual({ left: 10, bottom: 10, clearOfHud: true, title: 'Switch to paper (⌘/)' });
  await switcher.click();
  await expect(switcher).toHaveAttribute('aria-pressed', 'false');
  // The open drawer pushes the panel over; the switch goes with it.
  await openDrawer(page);
  await expect.poll(() => page.locator('#scroll').evaluate((el) => el.getBoundingClientRect().left)).toBeCloseTo(264, 0);
  await expect.poll(place).toEqual({ left: 10, bottom: 10, clearOfHud: true, title: 'Switch to plain text (⌘/)' });
});

test('shutting the drawer shows no caption on the way: the rows’ labels do not fade out beside the rail', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  await openDrawer(page);
  // Each frame after the switch is pressed: every rail label shown (its
  // opacity above nothing). Shut, a label is a hover caption, and its
  // fade-out once drew the rows' glass boxes outside the narrowed rail.
  const shown = await page.evaluate(async () => {
    (document.getElementById('rail-drawer') as HTMLElement).click();
    const out: number[] = [];
    for (let f = 0; f < 10; f++) {
      await new Promise((r) => requestAnimationFrame(r));
      // (All tools' own caption, under the pointer that pressed it, is a
      // hover caption and stays.)
      out.push([...document.querySelectorAll('#rail .tb-rail-groups .lbl')].filter((el) => {
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.02 && el.getBoundingClientRect().width > 0;
      }).length);
    }
    return out;
  });
  expect(shown).toEqual(Array(10).fill(0));
});

test('menus open, navigate, and close from the keyboard', async ({ page }) => {
  await page.goto('/?new=1');
  const exportBtn = page.locator('#toolbar').getByRole('button', { name: 'Export', exact: true });
  const menu = page.getByRole('menu', { name: 'Export', exact: true });
  await exportBtn.focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu).toBeVisible();
  await expect(exportBtn).toHaveAttribute('aria-expanded', 'true');
  const items = menu.locator('button:not(:disabled)');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(exportBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(exportBtn).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(exportBtn).toBeFocused();

  // ArrowUp opens on the last item.
  await page.keyboard.press('ArrowUp');
  await expect(menu).toBeVisible();
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // The Open side's chevron behaves the same way.
  const recentBtn = page.locator('#toolbar').getByRole('button', { name: 'Recent papers', exact: true });
  const recent = page.getByRole('menu', { name: 'Recent papers', exact: true });
  await recentBtn.focus();
  await page.keyboard.press('ArrowDown');
  await expect(recent).toBeVisible();
  await expect(recent.locator('button:not(:disabled)').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(recent).toBeHidden();
  await expect(recentBtn).toBeFocused();
});

test('a mouse click after Escape leaves no ring or caption on the tile Escape went back to', async ({ page }) => {
  await page.goto('/?new=1');
  for (const name of ['Export', 'Recent papers']) {
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

test('the drawer’s heading rows and the rail’s alignment tile apply to a whole-document selection', async ({ page }) => {
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
  await openDrawer(page);
  const rail = page.locator('#rail');
  const heading = rail.getByRole('button', { name: 'Heading 2', exact: true });
  await expect(heading).toHaveAttribute('title', 'Heading 2 (⌘⌥2)');
  await expect(heading).toBeEnabled();
  await heading.click();
  await expect(page.locator('.ProseMirror h2')).toHaveText(['First paragraph.', 'Second paragraph.']);

  await rail.getByRole('button', { name: 'Body text', exact: true }).click();
  await expect(page.locator('.ProseMirror > p').filter({ hasText: /paragraph\./ })).toHaveText(['First paragraph.', 'Second paragraph.']);

  // Alignment is one stepping tile at rest: justified, then center.
  await page.locator('#rail-drawer').click();
  await expect(page.locator('html')).not.toHaveClass(/\brail-open\b/);
  const align = rail.getByRole('button', { name: 'Alignment', exact: true });
  await expect(align).toBeVisible();
  await expect(align).toHaveAttribute('title', 'Justified · click for Center');
  await expect(align).toBeEnabled();
  await align.click();
  expect(await page.evaluate(() => {
    const attrs: unknown[] = [];
    window.view.state.doc.forEach((node) => {
      if (node.textContent) attrs.push(node.attrs.align);
    });
    return attrs;
  })).toEqual(['center', 'center']);
  await expect(align).toHaveAttribute('data-align', 'center');
  // The drawer's rows read the same selection.
  await openDrawer(page);
  await expect(rail.getByRole('button', { name: 'Center', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(rail.getByRole('button', { name: 'Justified', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('the Heading level tile shows the caret block’s level and steps body → H3 → H2 → H1 → body', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const { paragraph, heading } = state.schema.nodes;
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [
      heading.create({ level: 2 }, state.schema.text('A section')),
      paragraph.create(null, state.schema.text('Some words.')),
    ]));
  });
  const tile = page.locator('#heading-cycle');
  const glyph = tile.locator('.tico');
  await expect(tile).toHaveAttribute('aria-label', 'Heading level');
  // The glyph follows the caret.
  await page.locator('.ProseMirror h2').click();
  await expect(glyph).toHaveText('H2');
  await expect(tile.locator('.lbl')).toHaveText('Heading 2 · click for Heading 1');
  await page.locator('.ProseMirror > p', { hasText: 'Some words.' }).click();
  await expect(glyph).toHaveText('¶');
  await expect(tile.locator('.lbl')).toHaveText('Body text · click for Heading 3');
  await expect(tile).toHaveAttribute('title', 'Body text · click for Heading 3 (⌘⌥0–3)');
  await expect(tile).toBeEnabled();

  // Each press one size bigger, and H1 back to body text; the caret stays
  // in the block.
  const block = () => page.evaluate(() => {
    const { $from } = window.view.state.selection;
    return { type: $from.parent.type.name, level: $from.parent.attrs.level ?? null, text: $from.parent.textContent };
  });
  for (const [want, shown] of [[3, 'H3'], [2, 'H2'], [1, 'H1'], [null, '¶']] as const) {
    await tile.click();
    expect(await block()).toEqual({ type: want === null ? 'paragraph' : 'heading', level: want, text: 'Some words.' });
    await expect(glyph).toHaveText(shown);
  }
  await expect(page.locator('.ProseMirror h2')).toHaveText('A section');

  // Hidden while the drawer is open, which lists each level instead.
  await openDrawer(page);
  await expect(tile).toBeHidden();
  await expect(page.locator('#rail').getByRole('button', { name: 'Heading 3', exact: true })).toBeVisible();
});

test('the Alignment tile steps a paragraph justified → center → right → justified and rests in a heading', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const { paragraph, heading } = state.schema.nodes;
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [
      heading.create({ level: 1 }, state.schema.text('A title')),
      paragraph.create(null, state.schema.text('Some words.')),
    ]));
  });
  const tile = page.locator('#align-cycle');
  await expect(tile).toHaveAttribute('aria-label', 'Alignment');
  await page.locator('.ProseMirror > p', { hasText: 'Some words.' }).click();
  await expect(tile).toBeEnabled();
  await expect(tile).toHaveAttribute('data-align', 'null');
  await expect(tile.locator('.lbl')).toHaveText('Justified · click for Center');
  const align = () => page.evaluate(() => window.view.state.doc.child(1).attrs.align ?? null);
  for (const [want, caption] of [
    ['center', 'Center · click for Right'],
    ['right', 'Right · click for Justified'],
    [null, 'Justified · click for Center'],
  ] as const) {
    await tile.click();
    expect(await align()).toBe(want);
    await expect(tile).toHaveAttribute('data-align', String(want));
    await expect(tile.locator('.lbl')).toHaveText(caption);
    await expect(tile).toHaveAttribute('title', caption);
    await expect(tile.locator('svg')).toHaveCount(1);
  }
  // A heading is no paragraph: the tile rests.
  await page.locator('.ProseMirror h1').click();
  await expect(tile).toBeDisabled();
  await page.locator('.ProseMirror > p', { hasText: 'Some words.' }).click();
  await expect(tile).toBeEnabled();
});

test('All tools keeps its box at the rail’s top, open or shut', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  const drawer = page.locator('#rail-drawer');
  const box = () => drawer.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const railTop = (await page.locator('#rail').boundingBox())!.y;
  const shut = await box();
  expect(shut.x).toBe(6);
  // Above every tool group, the first thing in the rail.
  const groupsTop = await page.locator('#rail .tb-rail-groups').evaluate((el) => el.getBoundingClientRect().top);
  expect(shut.y).toBeGreaterThanOrEqual(railTop);
  expect(shut.y + shut.height).toBeLessThanOrEqual(groupsTop);
  for (const button of await page.locator('#rail button:visible').all()) {
    expect((await button.boundingBox())!.y).toBeGreaterThanOrEqual(shut.y);
  }
  await openDrawer(page);
  await expect.poll(() => page.locator('#rail').evaluate((el) => el.getBoundingClientRect().width)).toBe(264);
  expect(await box()).toEqual(shut);
  await drawer.click();
  await expect(page.locator('html')).not.toHaveClass(/\brail-open\b/);
  await expect.poll(() => page.locator('#rail').evaluate((el) => el.getBoundingClientRect().width)).toBe(44);
  expect(await box()).toEqual(shut);
});

test('the drawer’s Loose list spacing row reports and changes spacing for the nearest nested list', async ({ page }) => {
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
  await openDrawer(page);
  await page.locator('.ProseMirror ol p').click();
  const spacing = page.locator('#rail').getByRole('button', { name: 'Loose list spacing', exact: true });
  await expect(spacing).toHaveAttribute('title', 'Item spacing (⌘⇧7) — tight, or loose with paragraph spacing between items');
  await expect(spacing).toHaveAttribute('aria-pressed', 'true');
  await spacing.click();
  await expect(spacing).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => {
    const outer = window.view.state.doc.firstChild!;
    return [outer.attrs.tight, outer.firstChild!.lastChild!.attrs.tight];
  })).toEqual([true, true]);
  // The outer list is tight too: the caret there reads the same.
  await page.locator('.ProseMirror ul > li > p').first().click();
  await expect(spacing).toHaveAttribute('aria-pressed', 'false');
});

test('All tools opens the drawer: it pushes the paper, shows Basics first with hints, acts on the caret, survives a reload, and closes back to the 44px rail', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const paragraph = state.schema.nodes.paragraph;
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [
      paragraph.create(null, state.schema.text('Opening words.')),
      paragraph.create(null, state.schema.text('Closing words.')),
    ]));
  });
  const html = page.locator('html');
  const rail = page.locator('#rail');
  const drawer = page.locator('#rail-drawer');
  const panelLeft = () => page.locator('#scroll').evaluate((el) => el.getBoundingClientRect().left);
  const paperLeft = () => page.locator('#paper').evaluate((el) => el.getBoundingClientRect().left);
  await expect(drawer).toHaveAttribute('aria-pressed', 'false');
  await expect(html).not.toHaveClass(/\brail-open\b/);
  expect(Math.round((await rail.boundingBox())!.width)).toBe(44);
  await expect.poll(panelLeft).toBeCloseTo(44, 0);
  const restPaper = await paperLeft();
  await expect(rail.locator('.tb-hint:visible')).toHaveCount(0);
  await expect(rail.getByRole('button', { name: 'Heading 1', exact: true })).toBeHidden();

  await openDrawer(page);
  // The page is pushed over, and the paper refits beside it.
  await expect.poll(panelLeft).toBeCloseTo(264, 0);
  expect(Math.round((await rail.boundingBox())!.width)).toBe(264);
  await expect.poll(paperLeft).toBeGreaterThanOrEqual(264);
  expect(await paperLeft()).toBeGreaterThan(restPaper);

  // Basics, first, every row labelled with its markdown and keys.
  const groups = rail.locator('.tb-rail-groups > .tb-rail-group:visible');
  const tops = await groups.evaluateAll((els) => els.map((el) => [el.getAttribute('aria-label'), el.getBoundingClientRect().top] as const));
  tops.sort((a, b) => a[1] - b[1]);
  expect(tops[0][0]).toBe('Basics');
  const basics = rail.getByRole('group', { name: 'Basics', exact: true });
  await expect(basics.locator('.tb-rail-head')).toHaveText('Basics');
  const h1 = basics.getByRole('button', { name: 'Heading 1', exact: true });
  await expect(h1).toBeVisible();
  await expect(h1.locator('.lbl')).toBeVisible();
  await expect(h1.locator('.tb-hint')).toBeVisible();
  await expect(h1.locator('.tb-hint')).toHaveText('# · ⌘⌥1');
  for (const row of await basics.locator('button').all()) await expect(row.locator('.tb-hint')).toBeVisible();
  // The rows label themselves: no hover caption beside the drawer.
  await h1.hover();
  await expect(h1).not.toHaveClass(/\btb-caption-active\b/);

  // A Basics row acts on the caret's block.
  await page.locator('.ProseMirror p', { hasText: 'Closing words.' }).click();
  await h1.click();
  await expect(page.locator('.ProseMirror h1')).toHaveText('Closing words.');
  await expect(page.locator('.ProseMirror > p', { hasText: 'Opening words.' })).toHaveCount(1);
  await expect(h1).toHaveAttribute('aria-pressed', 'true');

  // The drawer is remembered.
  await page.reload();
  await page.waitForFunction(() => !!window.view);
  await expect(html).toHaveClass(/\brail-open\b/);
  await expect(drawer).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(panelLeft).toBeCloseTo(264, 0);
  await expect(rail.getByRole('button', { name: 'Heading 1', exact: true })).toBeVisible();

  // Closed, the rail is 44px again and the page comes back.
  await drawer.click();
  await expect(html).not.toHaveClass(/\brail-open\b/);
  await expect(drawer).toHaveAttribute('aria-pressed', 'false');
  expect(Math.round((await rail.boundingBox())!.width)).toBe(44);
  await expect.poll(panelLeft).toBeCloseTo(44, 0);
  await expect(rail.getByRole('button', { name: 'Heading 1', exact: true })).toBeHidden();
  await expect(rail.locator('.tb-rail-head:visible')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('typeset-rail-open'))).toBe('0');
});

test('Save… shows in the name pill while the paper has no file, and goes once it has one', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as unknown as { __fm?: unknown }).__fm);
  const pod = page.locator('#doc-pod');
  const save = page.locator('#doc-save');
  await expect(save).toBeVisible();
  await expect(save).toHaveText('Save…');
  await expect(pod).toHaveClass(/\bhas-save\b/);
  // Inside the pill, after the name.
  const podBox = (await pod.boundingBox())!;
  const saveBox = (await save.boundingBox())!;
  const nameBox = (await page.locator('#file-name').boundingBox())!;
  expect(saveBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width);
  expect(saveBox.x + saveBox.width).toBeLessThanOrEqual(podBox.x + podBox.width);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`save-chip-${Math.random().toString(36).slice(2)}`, { create: true });
    const h = await dir.getFileHandle('Filed.typ', { create: true });
    const w = await h.createWritable();
    await w.write('= Filed\n\nA paper with a file.\n');
    await w.close();
    await (window as unknown as { __fm: { loadHandle(h: FileSystemFileHandle, d: FileSystemDirectoryHandle): Promise<unknown> } }).__fm.loadHandle(h, dir);
  });
  await expect(page.locator('#file-name')).toHaveText('Filed');
  await expect(save).toBeHidden();
  await expect(pod).not.toHaveClass(/\bhas-save\b/);
});

test('Open is a split tile: the folder half is Open… (⌘O), the chevron lists the recent papers straight away, and New window opens a blank paper', async ({ page, context }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as unknown as { __fm?: unknown }).__fm);
  // A paper opened from a folder of the origin's storage is a recent one.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`recent-${Math.random().toString(36).slice(2)}`, { create: true });
    const h = await dir.getFileHandle('Seminar notes.typ', { create: true });
    const w = await h.createWritable();
    await w.write('= Seminar\n\nNotes.\n');
    await w.close();
    await (window as unknown as { __fm: { loadHandle(h: FileSystemFileHandle, d: FileSystemDirectoryHandle): Promise<unknown> } }).__fm.loadHandle(h, dir);
  });
  const bar = page.locator('#toolbar');
  await expect(bar.getByRole('button', { name: 'Open', exact: true })).toHaveAttribute('title', 'Open… (⌘O)');
  await bar.getByRole('button', { name: 'Recent papers', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Recent papers', exact: true });
  await expect(menu).toBeVisible();
  // The papers themselves, first, with no submenu to go through; then a
  // whole folder. No Save, no autosave switch, no History…, no update
  // check: Plass saves as you type, and the rest live elsewhere.
  await expect(menu.getByRole('menuitem').first()).toHaveText(/^recent-[a-z0-9]+\/Seminar notes\.typ$/);
  await expect(menu.getByRole('menuitem', { name: 'Open project folder…' })).toBeVisible();
  for (const gone of [/^Save/, /Autosave/, /History/, /update/i, /New document/, /^Open…$/]) {
    await expect(menu.getByRole('menuitem', { name: gone })).toHaveCount(0);
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  const opened = context.waitForEvent('page');
  await bar.getByRole('button', { name: 'New window', exact: true }).click();
  const other = await opened;
  expect(new URL(other.url()).searchParams.get('new')).toBe('1');
  await other.close();
});

test('in Plass.app the recent papers end with the app’s update only while the shell offers one', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__shell = [];
    w.__listeners = {} as Record<string, Array<(detail: unknown) => void>>;
    w.__fire = (event: string, detail: unknown) => (w.__listeners[event] ?? []).forEach((listener: (d: unknown) => void) => listener(detail));
    w.claerbout = {
      request: async (message: { type: string }) => {
        w.__shell.push(message);
        return message.type === 'document' ? { path: null } : null;
      },
      on: (event: string, listener: (detail: unknown) => void) => {
        (w.__listeners[event] ??= []).push(listener);
        return () => {};
      },
      pathOf: () => '',
    };
  });
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as unknown as { __fm?: unknown }).__fm);
  const chevron = page.locator('#toolbar').getByRole('button', { name: 'Recent papers', exact: true });
  const menu = page.getByRole('menu', { name: 'Recent papers', exact: true });
  await chevron.click();
  await expect(menu.getByRole('menuitem', { name: /update/i })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The shell's look at the site after launch found a newer build.
  await page.evaluate(() => (window as any).__fire('update', { state: 'available', latest: { build: 'abc123', built: '2026-10-17T10:00:00Z' } }));
  await chevron.click();
  const install = menu.getByRole('menuitem', { name: 'Install update (built 2026-10-17)' });
  await expect(install).toBeVisible();
  await install.click();
  await expect.poll(() => page.evaluate(() => (window as any).__shell.filter((m: { type: string }) => m.type === 'update'))).toEqual([{ type: 'update', action: 'install' }]);
});
