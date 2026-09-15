import { expect, test, type Page } from 'playwright/test';
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
  await page.locator('.ProseMirror table td').first().locator('p').first().click();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
}

const widths = (page: Page) => page.evaluate(() => window.view.state.doc.firstChild!.attrs.columnWidths);
const attrs = (page: Page) => page.evaluate(() => window.view.state.doc.firstChild!.attrs);

test('table layout controls set widths and padding while keeping rich content and the caret', async ({ page }) => {
  await installTable(page);
  const toolbar = page.getByRole('toolbar', { name: 'Table controls' });
  const mode = toolbar.getByRole('combobox', { name: 'Selected column sizing' });
  const caret = await page.evaluate(() => window.view.state.selection.toJSON());
  await expect(mode).toHaveValue('auto');
  await mode.selectOption('fr');
  const weight = toolbar.getByRole('spinbutton', { name: 'Column share weight' });
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
  await mode.selectOption('pt');
  const points = toolbar.getByRole('spinbutton', { name: 'Column width in points' });
  await points.fill('58.5');
  await points.press('Enter');
  expect(await widths(page)).toEqual(['58.5pt', '2fr', '90pt']);

  const padding = toolbar.getByRole('spinbutton', { name: 'Cell padding in points' });
  await padding.fill('9');
  await padding.press('Enter');
  expect((await attrs(page)).insetPt).toBe(9);
  await expect(padding).toBeFocused();
  const density = toolbar.getByRole('combobox', { name: 'Table cell density' });
  await expect(density).toHaveValue('custom');
  await expect(density).toBeEnabled();
  await padding.press('ControlOrMeta+z');
  await expect(padding).toHaveValue('5');
  expect((await attrs(page)).insetPt).toBeNull();
  await padding.press('ControlOrMeta+Shift+z');
  await expect(padding).toHaveValue('9');
  await density.selectOption('roomy');
  expect((await attrs(page)).insetPt).toBeNull();
  await expect(padding).toHaveValue('8');

  await padding.fill('90');
  await padding.press('Enter');
  expect((await attrs(page)).insetPt).toBeNull();
  await expect(padding).toHaveValue('8');
  expect(await page.evaluate(() => {
    const cell = window.view.state.doc.firstChild!.firstChild!.firstChild!;
    return { paragraphs: cell.childCount, marks: cell.firstChild!.firstChild!.marks.map((m) => m.type.name), math: cell.firstChild!.lastChild!.type.name };
  })).toEqual({ paragraphs: 2, marks: ['strong'], math: 'math_inline' });
});

test('fill and vertical alignment apply to selected cells and stay in sync across cells', async ({ page }) => {
  await installTable(page);
  const toolbar = page.getByRole('toolbar', { name: 'Table controls' });
  const fill = toolbar.getByRole('combobox', { name: 'Selected cells fill' });
  const vertical = toolbar.getByRole('combobox', { name: 'Selected cells vertical alignment' });
  await fill.selectOption('gray-dark');
  await vertical.selectOption('middle');
  expect(await page.evaluate(() => {
    const cell = window.view.state.doc.firstChild!.firstChild!.firstChild!;
    return { fill: cell.attrs.fill, valign: cell.attrs.valign };
  })).toEqual({ fill: 'gray-dark', valign: 'middle' });
  await page.locator('.ProseMirror table tr').first().locator('td').nth(1).click();
  await expect(fill).toHaveValue('');
  await expect(vertical).toHaveValue('');
  await expect(toolbar.getByRole('combobox', { name: 'Selected column sizing' })).toHaveValue('fr');
  await expect(toolbar.getByRole('spinbutton', { name: 'Column share weight' })).toHaveValue('2');
  await page.locator('.ProseMirror table tr').first().locator('td').first().click({ modifiers: ['Shift'] });
  await expect(fill).toHaveValue('mixed');
  await vertical.selectOption('bottom');
  await fill.selectOption('gray-dark');
  expect(await page.evaluate(() => {
    const row = window.view.state.doc.firstChild!.firstChild!;
    return [row.child(0), row.child(1)].map((cell) => ({ fill: cell.attrs.fill, valign: cell.attrs.valign }));
  })).toEqual([{ fill: 'gray-dark', valign: 'bottom' }, { fill: 'gray-dark', valign: 'bottom' }]);
});

test('column insertion and deletion preserve logical width entries through merged cells and undo', async ({ page }) => {
  await installTable(page, true);
  const toolbar = page.getByRole('toolbar', { name: 'Table controls' });
  await expect(toolbar.getByRole('combobox', { name: 'Selected column sizing' })).toHaveValue('mixed');
  await toolbar.getByRole('button', { name: 'Add column after', exact: true }).click();
  expect(await widths(page)).toEqual(['auto', '2fr', 'auto', '90pt']);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await widths(page)).toEqual(['auto', '2fr', '90pt']);
  await toolbar.getByRole('button', { name: 'Add column before', exact: true }).click();
  expect(await widths(page)).toEqual(['auto', 'auto', '2fr', '90pt']);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await widths(page)).toEqual(['auto', '2fr', '90pt']);
  await toolbar.getByRole('button', { name: 'Delete selected column', exact: true }).click();
  expect(await widths(page)).toEqual(['2fr', '90pt']);
  expect(await page.evaluate(() => window.view.state.doc.firstChild!.firstChild!.firstChild!.attrs.colspan)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await widths(page)).toEqual(['auto', '2fr', '90pt']);
  expect(await page.evaluate(() => window.view.state.doc.firstChild!.firstChild!.firstChild!.attrs.colspan)).toBe(2);
  await toolbar.getByRole('combobox', { name: 'Selected column sizing' }).selectOption('pt');
  const points = toolbar.getByRole('spinbutton', { name: 'Column width in points' });
  await points.fill('50');
  await points.press('Enter');
  expect(await widths(page)).toEqual(['50pt', '50pt', '90pt']);
});
