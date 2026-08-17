import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

test('all certified New Computer Modern faces load explicitly', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const family = '"New Computer Modern"';
    const specs = [
      `normal 400 16px ${family}`,
      `italic 400 16px ${family}`,
      `normal 700 16px ${family}`,
      `italic 700 16px ${family}`,
    ];
    const faces = await Promise.all(specs.map((spec) => document.fonts.load(spec, 'Afflictive naïve')));
    const editor = document.querySelector('.ProseMirror');
    return {
      loaded: faces.map((set) => set.length),
      family: editor ? getComputedStyle(editor).fontFamily : '',
    };
  });

  expect(result.loaded).toEqual([1, 1, 1, 1]);
  expect(result.family).toContain('New Computer Modern');
});

test('unsupported stored fonts fall back without being overwritten', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const settings = (state.doc.attrs.settings ?? {}) as Record<string, unknown>;
    window.view.dispatch(state.tr.setDocAttribute('settings', { ...settings, font: 'Georgia' }));
  });

  await expect
    .poll(() =>
      page.locator('.ProseMirror[contenteditable="true"]').evaluate((el) => getComputedStyle(el).fontFamily),
    )
    .toContain('New Computer Modern');
  expect(await page.evaluate(() => window.view.state.doc.attrs.settings.font)).toBe('Georgia');

  await page.getByTitle('Document settings').evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('.settings-font-compat')).toContainText(
    'rendering and exporting as New Computer Modern',
  );

  const fontRow = page.locator('.settings-row').filter({ hasText: 'Font' });
  await fontRow.locator('.ts-select-btn').click();
  await expect(page.locator('.ts-select-menu .ts-select-item')).toHaveCount(1);
  await expect(page.locator('.ts-select-menu .ts-select-item')).toHaveText('New Computer Modern');
  await fontRow.locator('.ts-select-btn').click();

  const sizeRow = page.locator('.settings-row').filter({ hasText: 'Size' });
  await sizeRow.locator('.ts-select-btn').click();
  await page.locator('.ts-select-menu .ts-select-item').filter({ hasText: '12 pt' }).click();

  expect(await page.evaluate(() => window.view.state.doc.attrs.settings.font)).toBe('Georgia');
  expect(await page.evaluate(() => window.view.state.doc.attrs.settings.sizePt)).toBe(12);
});
