import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

async function installTable(page: Page, merged = false) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view && !!window.__pagCount);
  const start = await page.evaluate((merged) => {
    const { state } = window.view;
    const s = state.schema;
    const p = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const cell = (text: string, colspan = 1) => s.nodes.table_cell.create({ colspan }, p(text));
    const row = (...cells: import('prosemirror-model').Node[]) => s.nodes.table_row.create(null, cells);
    const rich = s.nodes.table_cell.create(null, [
      s.nodes.paragraph.create(null, [s.text('Rich ', [s.marks.strong.create()]), s.nodes.math_inline.create({ src: 'x^2' })]),
      p('Second paragraph'),
    ]);
    const table = s.nodes.table.create({ style: 'grid', columnWidths: ['auto', '2fr', '90pt'] }, [
      merged ? row(cell('Merged', 2), cell('Third')) : row(rich, cell('Second'), cell('Third')),
      row(cell('Code'), cell('Skill'), cell('Practice')),
    ]);
    const start = window.__pagCount();
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, table).setMeta('addToHistory', false));
    return start;
  }, merged);
  await settleLocal(page, start);
  if (!merged) {
    // The formula's Typst ink replaces its KaTeX echo (a different width)
    // after pagination can already look quiet; click only on final layout.
    await expect(page.locator('.ProseMirror table td .math-inline.math-ink')).toHaveCount(1, { timeout: 30_000 });
    await settleLocal(page);
  }
  // Click text, not the paragraph's center: the center sits a few pixels
  // from the formula, and a click on the formula opens its editor instead.
  const first = page.locator('.ProseMirror table td').first().locator('p').first();
  await (merged ? first : first.locator('strong')).click();
  await expect.poll(() => firstCellHoldsSelection(page)).toBe(true);
}

/** The block pill's tiles and what they open (src/block-chrome.ts). */
const tile = (page: Page, id: string) => page.locator(`.block-pill [data-tile="${id}"]`);
const columnsMenu = async (page: Page) => {
  await tile(page, 'cols').click();
  const menu = page.getByRole('menu', { name: 'Columns' });
  await expect(menu).toBeVisible();
  return menu;
};
const panel = async (page: Page, id: 'table' | 'cell' | 'align') => {
  await tile(page, id).click();
  const dialog = page.getByRole('dialog', { name: id === 'table' ? 'Table settings' : id === 'cell' ? 'Cell fill and rules' : /^Align/ });
  await expect(dialog).toBeVisible();
  return dialog;
};

const firstCellHoldsSelection = (page: Page) => page.evaluate(() => {
  const { selection, doc } = window.view.state;
  const cell = doc.firstChild!.firstChild!.firstChild!;
  // table(0) > row(1) > first cell(2): the cell's content spans 3 .. 3 + content size.
  return selection.from >= 3 && selection.to <= 3 + cell.content.size;
});

const widths = (page: Page) => page.evaluate(() => window.view.state.doc.firstChild!.attrs.columnWidths);
const attrs = (page: Page) => page.evaluate(() => window.view.state.doc.firstChild!.attrs);

test('table layout controls set widths and padding while keeping rich content and the caret', async ({ page }) => {
  await installTable(page);
  const caret = await page.evaluate(() => window.view.state.selection.toJSON());
  const cols = await columnsMenu(page);
  await expect(cols.locator('[data-value="auto"]')).toHaveAttribute('aria-checked', 'true');
  await cols.locator('[data-value="fr"]').click();
  expect(await widths(page)).toEqual(['1fr', '2fr', '90pt']);
  const weight = cols.getByRole('spinbutton', { name: 'Column share weight' });
  await weight.fill('3.5');
  await weight.press('Enter');
  await expect(weight).toBeFocused();
  expect(await widths(page)).toEqual(['3.5fr', '2fr', '90pt']);
  expect(await page.evaluate(() => window.view.state.selection.toJSON())).toEqual(caret);

  await weight.press('ControlOrMeta+z');
  await expect(weight).toHaveValue('1');
  expect(await widths(page)).toEqual(['1fr', '2fr', '90pt']);
  await weight.press('ControlOrMeta+Shift+z');
  await expect(weight).toHaveValue('3.5');
  await cols.locator('[data-value="pt"]').click();
  await expect(cols.locator('[data-value="pt"]')).toHaveAttribute('aria-checked', 'true');
  const points = cols.getByRole('spinbutton', { name: 'Column width in points' });
  await points.fill('58.5');
  await points.press('Enter');
  expect(await widths(page)).toEqual(['58.5pt', '2fr', '90pt']);

  // Padding: the presets, and a Custom pt field showing the inset in force.
  const settings = await panel(page, 'table');
  const padding = settings.getByRole('spinbutton', { name: 'Cell padding in points' });
  const density = settings.getByRole('radiogroup', { name: 'Table cell density' });
  await padding.fill('9');
  await padding.press('Enter');
  expect((await attrs(page)).insetPt).toBe(9);
  await expect(padding).toBeFocused();
  await expect(density.locator('[aria-checked="true"]')).toHaveCount(0);
  await expect(density.locator('[data-value="roomy"]')).toBeEnabled();
  await padding.press('ControlOrMeta+z');
  await expect(padding).toHaveValue('');
  await expect(padding).toHaveAttribute('placeholder', '5');
  expect((await attrs(page)).insetPt).toBeNull();
  await padding.press('ControlOrMeta+Shift+z');
  await expect(padding).toHaveValue('9');
  await density.locator('[data-value="roomy"]').click();
  expect((await attrs(page)).insetPt).toBeNull();
  await expect(padding).toHaveValue('');
  await expect(padding).toHaveAttribute('placeholder', '8');

  // Out of range (0–72): nothing is applied and the field reverts.
  await padding.fill('90');
  await padding.press('Enter');
  expect((await attrs(page)).insetPt).toBeNull();
  await expect(padding).toHaveValue('');
  expect(await page.evaluate(() => {
    const cell = window.view.state.doc.firstChild!.firstChild!.firstChild!;
    return { paragraphs: cell.childCount, marks: cell.firstChild!.firstChild!.marks.map((m) => m.type.name), math: cell.firstChild!.lastChild!.type.name };
  })).toEqual({ paragraphs: 2, marks: ['strong'], math: 'math_inline' });
});

test('fill and vertical alignment apply to selected cells and stay in sync across cells', async ({ page }) => {
  await installTable(page);
  let cell = await panel(page, 'cell');
  await cell.getByRole('radiogroup', { name: 'Selected cells fill' }).locator('[data-value="gray-dark"]').click();
  let align = await panel(page, 'align');
  await align.getByRole('radiogroup', { name: 'Selected cells vertical alignment' }).locator('[data-value="middle"]').click();
  expect(await page.evaluate(() => {
    const cell = window.view.state.doc.firstChild!.firstChild!.firstChild!;
    return { fill: cell.attrs.fill, valign: cell.attrs.valign };
  })).toEqual({ fill: 'gray-dark', valign: 'middle' });

  // Another cell: the panels and the Columns menu describe it.
  await page.locator('.ProseMirror table tr').first().locator('td').nth(1).click();
  cell = await panel(page, 'cell');
  const fills = cell.getByRole('radiogroup', { name: 'Selected cells fill' });
  await expect(fills.locator('[data-value=""]')).toHaveAttribute('aria-checked', 'true');
  align = await panel(page, 'align');
  const vertical = align.getByRole('radiogroup', { name: 'Selected cells vertical alignment' });
  await expect(vertical.locator('[aria-checked="true"]')).toHaveCount(0);
  const cols = await columnsMenu(page);
  await expect(cols.locator('[data-value="fr"]')).toHaveAttribute('aria-checked', 'true');
  await expect(cols.getByRole('spinbutton', { name: 'Column share weight' })).toHaveValue('2');
  await page.keyboard.press('Escape');

  // Both cells: a mixed fill checks nothing and says so.
  await page.locator('.ProseMirror table tr').first().locator('td').first().click({ modifiers: ['Shift'] });
  await expect.poll(() => page.evaluate(() => window.view.state.selection.constructor.name)).toBe('CellSelection');
  cell = await panel(page, 'cell');
  await expect(fills.locator('[aria-checked="true"]')).toHaveCount(0);
  await expect(cell.getByText('Mixed', { exact: true })).toBeVisible();
  await fills.locator('[data-value="gray-dark"]').click();
  align = await panel(page, 'align');
  await vertical.locator('[data-value="bottom"]').click();
  expect(await page.evaluate(() => {
    const row = window.view.state.doc.firstChild!.firstChild!;
    return [row.child(0), row.child(1)].map((cell) => ({ fill: cell.attrs.fill, valign: cell.attrs.valign }));
  })).toEqual([{ fill: 'gray-dark', valign: 'bottom' }, { fill: 'gray-dark', valign: 'bottom' }]);
});

test('column insertion and deletion preserve logical width entries through merged cells and undo', async ({ page }) => {
  await installTable(page, true);
  let cols = await columnsMenu(page);
  await expect(cols.locator('[data-value="mixed"]')).toHaveAttribute('aria-checked', 'true');
  await cols.getByRole('menuitem', { name: 'Add column after', exact: true }).click();
  expect(await widths(page)).toEqual(['auto', '2fr', 'auto', '90pt']);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await widths(page)).toEqual(['auto', '2fr', '90pt']);
  cols = await columnsMenu(page);
  await cols.getByRole('menuitem', { name: 'Add column before', exact: true }).click();
  expect(await widths(page)).toEqual(['auto', 'auto', '2fr', '90pt']);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await widths(page)).toEqual(['auto', '2fr', '90pt']);
  cols = await columnsMenu(page);
  await cols.getByRole('menuitem', { name: 'Delete selected column', exact: true }).click();
  expect(await widths(page)).toEqual(['2fr', '90pt']);
  expect(await page.evaluate(() => window.view.state.doc.firstChild!.firstChild!.firstChild!.attrs.colspan)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await widths(page)).toEqual(['auto', '2fr', '90pt']);
  expect(await page.evaluate(() => window.view.state.doc.firstChild!.firstChild!.firstChild!.attrs.colspan)).toBe(2);
  cols = await columnsMenu(page);
  await cols.locator('[data-value="pt"]').click();
  const points = cols.getByRole('spinbutton', { name: 'Column width in points' });
  await points.fill('50');
  await points.press('Enter');
  expect(await widths(page)).toEqual(['50pt', '50pt', '90pt']);
});

test('a formula clicked in a cell is the selection the table controls describe', async ({ page }) => {
  await installTable(page);
  // Put the caret in another column first, then click the formula in the first cell.
  await page.locator('.ProseMirror table tr').first().locator('td').nth(2).locator('p').click();
  // The pill's place readout (visually hidden, aria-live) names the column.
  const place = page.locator('.block-pill .table-toolbar-position');
  await expect(place).toHaveText('Row 1 of 2 · Column 3 of 3');
  await page.locator('.ProseMirror table td .math-inline').click();
  await expect(page.locator('.math-editor-input')).toBeFocused();
  expect(await page.evaluate(() => window.view.state.selection.toJSON())).toEqual({ type: 'node', anchor: 9 });
  await expect(place).toHaveText('Row 1 of 2 · Column 1 of 3');
  await page.locator('.math-editor-input').press('Escape');
  await expect.poll(() => firstCellHoldsSelection(page)).toBe(true);
});
