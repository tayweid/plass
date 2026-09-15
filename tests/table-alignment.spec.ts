import { expect, test, type Page } from 'playwright/test';
import { settleLocal } from './settle';

async function installTable(page: Page, wrapped = false) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view && !!window.__pagCount);
  const started = await page.evaluate((wrap) => {
    const { state } = window.view;
    const s = state.schema;
    const p = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const cell = (text: string, header = false) =>
      (header ? s.nodes.table_header : s.nodes.table_cell).create(null, p(text));
    const row = (...cells: import('prosemirror-model').Node[]) => s.nodes.table_row.create(null, cells);
    const table = s.nodes.table.create({ style: 'grid' }, [
      row(cell('Header', true), cell('An adjacent column', true)),
      row(cell(wrap ? 'Several words make a paragraph that wraps naturally inside this table cell. '.repeat(5) + 'End.' : 'Short'), cell('Neighbor')),
      row(cell('A wider reference label'), cell('Another neighboring entry')),
    ]);
    const started = window.__pagCount();
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, table).setMeta('addToHistory', false));
    return started;
  }, wrapped);
  await settleLocal(page, started);
}

async function paragraphGeometry(page: Page, row: number) {
  return page.locator('.ProseMirror table > tbody > tr').nth(row).locator('th, td').first().locator('p').evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p);
    const lines = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => ({ left: r.left, right: r.right, top: r.top }));
    const rect = p.getBoundingClientRect();
    return { left: rect.left, right: rect.right, height: rect.height, lines };
  });
}

test('table L/C/R controls visibly align both header and body text', async ({ page }) => {
  await installTable(page);
  const toolbar = page.getByRole('toolbar', { name: 'Table controls' });
  for (const row of [0, 1]) {
    await page.locator('.ProseMirror table > tbody > tr').nth(row).locator('th, td').first().locator('p').click();
    for (const alignment of ['left', 'center', 'right'] as const) {
      await toolbar.getByRole('button', { name: `Align selected cells ${alignment}`, exact: true }).click();
      const geometry = await paragraphGeometry(page, row);
      expect(geometry.lines).toHaveLength(1);
      const line = geometry.lines[0];
      const offset = alignment === 'left'
        ? line.left - geometry.left
        : alignment === 'right'
          ? geometry.right - line.right
          : (line.left + line.right - geometry.left - geometry.right) / 2;
      expect(Math.abs(offset), `row ${row}, ${alignment}: ${JSON.stringify(geometry)}`).toBeLessThan(0.5);
    }
  }
});

test('cell alignment retains justified wrapping and aligns the final line without changing height', async ({ page }) => {
  await installTable(page, true);
  await page.locator('.ProseMirror table > tbody > tr').nth(1).locator('td').first().locator('p').click();
  const before = await paragraphGeometry(page, 1);
  expect(before.lines.length).toBeGreaterThan(2);
  const toolbar = page.getByRole('toolbar', { name: 'Table controls' });
  for (const alignment of ['center', 'right'] as const) {
    await toolbar.getByRole('button', { name: `Align selected cells ${alignment}`, exact: true }).click();
    const after = await paragraphGeometry(page, 1);
    expect(Math.abs(after.height - before.height)).toBeLessThan(0.5);
    const first = after.lines[0];
    expect(Math.abs(first.left - after.left)).toBeLessThan(0.5);
    expect(Math.abs(first.right - after.right)).toBeLessThan(0.5);
    const last = after.lines.at(-1)!;
    const offset = alignment === 'center'
      ? (last.left + last.right - after.left - after.right) / 2
      : after.right - last.right;
    expect(Math.abs(offset), `${alignment}: ${JSON.stringify(after)}`).toBeLessThan(0.5);
  }
});
