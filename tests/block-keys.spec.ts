import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// The block keyboard (src/block-keys.ts, spec §6): Escape selects the
// table or grid the caret is in and Escape / Enter go back to the cell;
// ⌫ deletes a selected block; Tab takes a selected block to its pill, which
// then acts at the cell the block was selected from; ⌘⏎ / ⇧⌘⏎ add a row in
// a cell (and are still the page break elsewhere); ↓ / ↑ leave a grid at
// its edge rows. New rows and columns take the caret.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null) => Promise<unknown> };
  }
}

const SHEET = readFileSync(new URL('./fixtures/block-chrome/sheet.md', import.meta.url), 'utf8');
const BOX = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="260" viewBox="0 0 200 260"><rect x="1" y="1" width="198" height="258" fill="none" stroke="#aaaaaa" stroke-width="1.2"/></svg>';

async function openSheet(page: Page) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(
    async ({ text, box }) => {
      const root = await navigator.storage.getDirectory();
      const write = async (dir: FileSystemDirectoryHandle, name: string, data: string) => {
        const h = await dir.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write(data);
        await w.close();
        return h;
      };
      await write(await root.getDirectoryHandle('i', { create: true }), 'box.svg', box);
      await window.__fm.loadHandle(await write(root, 'sheet.md', text), root);
    },
    { text: SHEET, box: BOX },
  );
  await settleLocal(page);
  await expect(page.locator('.ProseMirror .ts-grid')).toHaveCount(3);
}

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** A caret `offset` characters into (default: at the end of) the first
 *  textblock of a table cell (DOM row/column of the nth table) or a grid
 *  cell (row-major). */
async function caretIn(page: Page, target: ({ table: number; row: number; col: number } | { grid: number; cell: number }) & { offset?: number }) {
  await page.evaluate((t) => {
    const view = window.view;
    const el = 'table' in t
      ? document.querySelectorAll('.ProseMirror table')[t.table].querySelectorAll('tr')[t.row].querySelectorAll(':scope > td, :scope > th')[t.col]
      : document.querySelectorAll('.ProseMirror .ts-grid')[t.grid].querySelectorAll(':scope > .ts-grid-row > .ts-grid-cell')[t.cell];
    const $p = view.state.doc.resolve(view.posAtDOM(el!, 0));
    let d = $p.depth;
    while (d > 0 && !/cell|header/.test($p.node(d).type.name)) d--;
    let at = -1;
    $p.node(d).descendants((n, pos) => {
      if (at < 0 && n.isTextblock) at = $p.start(d) + pos + 1 + (t.offset ?? n.content.size);
      return at < 0;
    });
    view.focus();
    let S = view.state.selection.constructor as { fromJSON?: (doc: unknown, json: unknown) => unknown };
    while (Object.getPrototypeOf(S) && Object.getPrototypeOf(S) !== Function.prototype) S = Object.getPrototypeOf(S);
    view.dispatch(view.state.tr.setSelection(S.fromJSON!(view.state.doc, { type: 'text', anchor: at, head: at }) as never));
  }, target);
  await frames(page);
}

/** The selection: its JSON, a node selection's node name, and the
 *  innermost cell's place (table: DOM row/col; grid: row/column) and text. */
const where = (page: Page) => page.evaluate(() => {
  const sel = window.view.state.selection as unknown as { toJSON: () => { type: string; anchor: number; head: number }; node?: { type: { name: string } }; $head: import('prosemirror-model').ResolvedPos };
  const $h = sel.$head;
  let cell: { kind: string; row: number; col: number; text: string } | null = null;
  for (let d = $h.depth; d > 1 && !sel.node; d--) {
    const name = $h.node(d).type.name;
    if (/table_cell|table_header|grid_cell/.test(name)) {
      cell = { kind: name === 'grid_cell' ? 'grid' : 'table', row: $h.index(d - 2), col: $h.index(d - 1), text: $h.node(d).textContent };
      break;
    }
  }
  return { json: sel.toJSON(), node: sel.node?.type.name ?? null, cell };
});

const pill = (page: Page) => page.locator('.block-pill');
const tile = (page: Page, id: string) => page.locator(`.block-pill [data-tile="${id}"]`);
/** Walks the pill's roving focus `n` tiles down. */
const down = async (page: Page, n: number) => {
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowDown');
};
const pageBreaks = (page: Page) => page.evaluate(() => {
  let n = 0;
  window.view.state.doc.descendants((node) => { if (node.type.name === 'page_break') n++; });
  return n;
});
const tableRows = (page: Page, index: number) => page.evaluate((i) => document.querySelectorAll('.ProseMirror table')[i].querySelectorAll(':scope > tbody > tr:not(.ts-pagegap)').length, index);
const gridRows = (page: Page, index: number) => page.evaluate((i) => {
  const el = document.querySelectorAll('.ProseMirror .ts-grid')[i];
  return [...el.querySelectorAll(':scope > .ts-grid-row')].map((r) => [...r.querySelectorAll(':scope > .ts-grid-cell')].map((c) => c.textContent ?? ''));
}, index);

test.describe('the block keyboard', () => {
  test('Escape selects the table, keeps the pill, and Escape or Enter go back to the cell', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1, offset: 2 });
    const before = await where(page);
    expect(before.cell?.text).toBe('Rain');
    await expect(pill(page)).toBeVisible();
    await expect(page.locator('.ProseMirror table').first().locator('.ts-cell-active')).toHaveCount(1);

    await page.keyboard.press('Escape');
    expect((await where(page)).node).toBe('table');
    const table = page.locator('.ProseMirror table').first();
    await expect(table).toHaveClass(/ProseMirror-selectednode/);
    await expect(table).toHaveClass(/ts-table-editing/);
    expect(await table.evaluate((t) => getComputedStyle(t).outlineStyle)).toBe('solid');
    // No active cell ring while the block is selected; the pill stays and
    // still shows the cell it will act at.
    await expect(table.locator('.ts-cell-active')).toHaveCount(0);
    await expect(page.getByRole('toolbar', { name: 'Table controls' })).toBeVisible();
    await expect(tile(page, 'addrow')).toBeEnabled();

    await page.keyboard.press('Escape');
    expect((await where(page)).json).toEqual(before.json);
    await expect(table).not.toHaveClass(/ProseMirror-selectednode/);

    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    expect((await where(page)).json).toEqual(before.json);
    // Typing goes on in that cell.
    await page.keyboard.type('x');
    expect((await where(page)).cell?.text).toBe('Raxin');
  });

  test('Backspace deletes a selected table; undo brings it back', async ({ page }) => {
    await openSheet(page);
    const tables = await page.locator('.ProseMirror table').count();
    await caretIn(page, { table: 0, row: 1, col: 0 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.ProseMirror table')).toHaveCount(tables - 1);
    await expect(page.locator('.block-track')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.ProseMirror table')).toHaveCount(tables);
  });

  test('a Table settings change on a selected table keeps it selected, and Enter goes back to the cell', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1, offset: 2 });
    const before = await where(page);
    await page.keyboard.press('Escape');
    const selected = await where(page);
    expect(selected.node).toBe('table');
    // Add row below, its Row above · Add column right, its Column left ·
    // Align · Cell │ Table settings (End would go on into the actions pill
    // under it).
    await page.keyboard.press('Tab');
    await down(page, 6);
    await expect(tile(page, 'table')).toBeFocused();
    await page.keyboard.press('Enter');
    const styles = page.locator('.bc-flyout [role="radiogroup"][aria-label="Table rule style"] [role="radio"][aria-checked="false"]');
    await expect(styles.first()).toBeVisible();
    const doc = await page.evaluate(() => JSON.stringify(window.view.state.doc.toJSON()));
    await styles.first().click();
    expect(await page.evaluate(() => JSON.stringify(window.view.state.doc.toJSON()))).not.toBe(doc);
    expect((await where(page)).json).toEqual(selected.json);
    // So does Text size, a write() of the panel.
    await page.locator('.bc-flyout [role="radiogroup"][aria-label="Table text size"] [role="radio"][aria-checked="false"]').first().click();
    expect((await where(page)).json).toEqual(selected.json);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.view.hasFocus())).toBe(true);
    expect((await where(page)).json).toEqual(selected.json);
    await page.keyboard.press('Enter');
    expect((await where(page)).json).toEqual(before.json);
    expect((await where(page)).cell?.text).toBe('Rain');
    // Undo keeps the block's memory too.
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    expect((await where(page)).node).toBe('table');
    await page.keyboard.press('Enter');
    expect((await where(page)).json).toEqual(before.json);
  });

  test('a Grid layout gutter change on a selected grid keeps it selected', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { grid: 0, cell: 1, offset: 1 });
    const before = await where(page);
    await page.keyboard.press('Escape');
    const selected = await where(page);
    expect(selected.node).toBe('grid');
    // The selected grid carries the paper scale for its outline.
    expect(await page.locator('.ProseMirror .ts-grid').first().evaluate((g) => (g as HTMLElement).style.getPropertyValue('--ps'))).not.toBe('');
    // Add row below, its Row above · Add column right, its Column left ·
    // Align · Image │ Grid layout.
    await page.keyboard.press('Tab');
    await down(page, 6);
    await expect(tile(page, 'grid')).toBeFocused();
    await page.keyboard.press('Enter');
    const gutters = page.locator('.bc-flyout [role="radiogroup"][aria-label="Space between cells"] [role="radio"][aria-checked="false"]');
    await expect(gutters.first()).toBeVisible();
    await gutters.first().click();
    expect((await where(page)).json).toEqual(selected.json);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    expect((await where(page)).json).toEqual(before.json);
  });

  test('Escape in a grid cell selects the grid, its washes stay, and Delete removes it', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { grid: 0, cell: 1 });
    await page.keyboard.press('Escape');
    expect((await where(page)).node).toBe('grid');
    const grid = page.locator('.ProseMirror .ts-grid').first();
    await expect(grid).toHaveClass(/ProseMirror-selectednode/);
    await expect(grid).toHaveClass(/ts-grid-editing/);
    await expect(grid.locator('.ts-grid-cell-active')).toHaveCount(0);
    await expect(page.getByRole('toolbar', { name: 'Grid controls' })).toBeVisible();
    // A stray letter on the selected grid leaves it whole and selected.
    await page.keyboard.type('q');
    await expect(page.locator('.ProseMirror .ts-grid')).toHaveCount(3);
    expect((await where(page)).node).toBe('grid');
    await page.keyboard.press('Delete');
    await expect(page.locator('.ProseMirror .ts-grid')).toHaveCount(2);
  });

  test('a nested table selects itself first; its grid keeps the active cell', async ({ page }) => {
    await openSheet(page);
    const nested = await page.evaluate(() => [...document.querySelectorAll('.ProseMirror table')].findIndex((t) => t.closest('.ts-grid')));
    await caretIn(page, { table: nested + 1, row: 2, col: 1 });
    const before = await where(page);
    await page.keyboard.press('Escape');
    expect((await where(page)).node).toBe('table');
    const table = page.locator('.ProseMirror table').nth(nested + 1);
    await expect(table).toHaveClass(/ProseMirror-selectednode/);
    await expect(page.locator('.ProseMirror .ts-grid-cell-active')).toHaveCount(1);
    await expect(page.locator('.block-pill .tb-btn')).toHaveCount(8);
    await page.keyboard.press('Escape');
    expect((await where(page)).json).toEqual(before.json);
  });

  test('Tab takes a selected grid to its pill, which acts at the remembered cell; Shift-Tab hands the block back', async ({ page }) => {
    await openSheet(page);
    const before = await gridRows(page, 0);
    // Row 1 (of 1), column 2: the caret's cell.
    await caretIn(page, { grid: 0, cell: 1 });
    await page.keyboard.press('Escape');
    const selected = await where(page);
    expect(selected.node).toBe('grid');
    await page.keyboard.press('Tab');
    await expect(tile(page, 'addrow')).toBeFocused();
    await expect(tile(page, 'addrow')).toHaveAttribute('tabindex', '0');
    // Roving focus (into the tile's Row above flyout, shown while the focus
    // is on the tile), then back: the editor has the focus and the block is
    // still selected.
    await page.keyboard.press('ArrowDown');
    await expect(tile(page, 'addrowabove')).toBeFocused();
    await expect(tile(page, 'addrowabove')).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => window.view.hasFocus())).toBe(true);
    expect((await where(page)).json).toEqual(selected.json);
    // Again, and Escape from the pill does the same.
    await page.keyboard.press('Tab');
    await expect(tile(page, 'addrow')).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.view.hasFocus())).toBe(true);
    expect((await where(page)).json).toEqual(selected.json);
    // Add row below from the pill: the row goes under the remembered
    // cell's row and the caret lands in it, in its column.
    await page.keyboard.press('Tab');
    await expect(tile(page, 'addrow')).toBeFocused();
    await page.keyboard.press('Enter');
    const after = await gridRows(page, 0);
    expect(after).toHaveLength(before.length + 1);
    expect(after[1].join('')).toBe('');
    expect((await where(page)).cell).toMatchObject({ kind: 'grid', row: 1, col: 1, text: '' });
  });

  test('the add-row tile names the row chord', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    // Row above, the tile's flyout, says its direction in a word.
    await expect(tile(page, 'addrow').locator('.lbl kbd')).toHaveText('⌘⏎');
    await expect(tile(page, 'addrowabove').locator('.bc-alt-word')).toHaveText('Row above');
    await caretIn(page, { grid: 0, cell: 0 });
    await expect(page.getByRole('toolbar', { name: 'Grid controls' })).toBeVisible();
    await expect(tile(page, 'addrow').locator('.lbl kbd')).toHaveText('⌘⏎');
    await expect(tile(page, 'addcolleft').locator('.bc-alt-word')).toHaveText('Column left');
  });

  test('⌘⏎ / ⇧⌘⏎ add a row in a table cell with the caret in it, and no page break', async ({ page }) => {
    await openSheet(page);
    const breaks = await pageBreaks(page);
    const rows = await tableRows(page, 0);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect.poll(() => tableRows(page, 0)).toBe(rows + 1);
    expect((await where(page)).cell).toMatchObject({ kind: 'table', row: 3, col: 1, text: '' });
    await page.keyboard.type('Fog');
    await caretIn(page, { table: 0, row: 2, col: 2 });
    await page.keyboard.press('Shift+ControlOrMeta+Enter');
    await expect.poll(() => tableRows(page, 0)).toBe(rows + 2);
    expect((await where(page)).cell).toMatchObject({ kind: 'table', row: 2, col: 2, text: '' });
    // The rows: the new one above "Rain", "Fog" in the one below it.
    const texts = await page.evaluate(() => [...document.querySelectorAll('.ProseMirror table')[0].querySelectorAll('tbody > tr:not(.ts-pagegap)')].map((r) => r.textContent));
    expect(texts[2]).toBe('');
    expect(texts[3]).toContain('Rain');
    expect(texts[4]).toBe('Fog');
    expect(await pageBreaks(page)).toBe(breaks);
  });

  test('⌘⏎ / ⇧⌘⏎ add a grid row (innermost: a table in a grid gets a table row)', async ({ page }) => {
    await openSheet(page);
    const breaks = await pageBreaks(page);
    const before = await gridRows(page, 0);
    await caretIn(page, { grid: 0, cell: 2 });
    await page.keyboard.press('ControlOrMeta+Enter');
    let after = await gridRows(page, 0);
    expect(after).toHaveLength(before.length + 1);
    expect(after[1].join('')).toBe('');
    expect((await where(page)).cell).toMatchObject({ kind: 'grid', row: 1, col: 2 });
    await page.keyboard.press('Shift+ControlOrMeta+Enter');
    after = await gridRows(page, 0);
    expect(after).toHaveLength(before.length + 2);
    expect((await where(page)).cell).toMatchObject({ kind: 'grid', row: 1, col: 2 });

    const nested = await page.evaluate(() => [...document.querySelectorAll('.ProseMirror table')].findIndex((t) => t.closest('.ts-grid')));
    const gi = await page.evaluate(() => [...document.querySelectorAll('.ProseMirror .ts-grid')].findIndex((g) => g.querySelector('table')));
    const gridBefore = (await gridRows(page, gi)).length;
    const tableBefore = await tableRows(page, nested);
    await caretIn(page, { table: nested, row: 1, col: 1 });
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect.poll(() => tableRows(page, nested)).toBe(tableBefore + 1);
    expect((await gridRows(page, gi)).length).toBe(gridBefore);
    expect((await where(page)).cell).toMatchObject({ kind: 'table', row: 2, col: 1 });
    expect(await pageBreaks(page)).toBe(breaks);
  });

  test('⌘⏎ outside a cell is still the page break', async ({ page }) => {
    await openSheet(page);
    const breaks = await pageBreaks(page);
    // The worksheet's first paragraph.
    await page.evaluate(() => {
      const view = window.view;
      let at = -1;
      view.state.doc.forEach((node, offset) => {
        if (at < 0 && node.type.name === 'paragraph' && node.textContent.startsWith('This worksheet')) at = offset + 1 + 5;
      });
      view.focus();
      let S = view.state.selection.constructor as { fromJSON?: (doc: unknown, json: unknown) => unknown };
      while (Object.getPrototypeOf(S) && Object.getPrototypeOf(S) !== Function.prototype) S = Object.getPrototypeOf(S);
      view.dispatch(view.state.tr.setSelection(S.fromJSON!(view.state.doc, { type: 'text', anchor: at, head: at }) as never));
    });
    await page.keyboard.press('ControlOrMeta+Enter');
    expect(await pageBreaks(page)).toBe(breaks + 1);
  });

  test('the add tiles put the caret in the new row / column', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    // Row above and Column left are the flyouts of their tiles, shown on
    // hover.
    await tile(page, 'addrow').hover();
    await tile(page, 'addrowabove').click();
    expect((await where(page)).cell).toMatchObject({ kind: 'table', row: 2, col: 1, text: '' });
    await caretIn(page, { table: 0, row: 3, col: 1 });
    await tile(page, 'addrow').click();
    expect((await where(page)).cell).toMatchObject({ kind: 'table', row: 4, col: 1, text: '' });
    await caretIn(page, { table: 0, row: 3, col: 1 });
    await tile(page, 'addcol').hover();
    await tile(page, 'addcolleft').click();
    expect((await where(page)).cell).toMatchObject({ kind: 'table', row: 3, col: 1, text: '' });
    await caretIn(page, { table: 0, row: 3, col: 2 });
    await tile(page, 'addcol').click();
    expect((await where(page)).cell).toMatchObject({ kind: 'table', row: 3, col: 3, text: '' });
    // A grid does the same.
    await caretIn(page, { grid: 0, cell: 1 });
    await tile(page, 'addcol').click();
    expect((await where(page)).cell).toMatchObject({ kind: 'grid', row: 0, col: 2, text: '' });
    await tile(page, 'addrow').click();
    expect((await where(page)).cell).toMatchObject({ kind: 'grid', row: 1, col: 2, text: '' });
  });

  test('↓ from a grid that ends the document makes a paragraph after it; ↑ from its first row leaves it', async ({ page }) => {
    await page.goto('/?new=1');
    await page.waitForFunction(() => Boolean(window.view));
    await page.evaluate(() => {
      const view = window.view;
      const s = view.state.schema;
      const cell = (text: string) => s.nodes.grid_cell.create(null, s.nodes.paragraph.create(null, text ? s.text(text) : undefined));
      const doc = s.nodes.doc.create(view.state.doc.attrs, [
        s.nodes.paragraph.create(null, s.text('Above the grid.')),
        s.nodes.grid.create({ columns: [1, 1], gutter: 1 }, [
          s.nodes.grid_row.create(null, [cell('One'), cell('Two')]),
          s.nodes.grid_row.create(null, [cell('Three'), cell('Four')]),
        ]),
      ]);
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
    });
    await settleLocal(page);
    await caretIn(page, { grid: 0, cell: 3 });
    await page.keyboard.press('ArrowDown');
    const below = await page.evaluate(() => {
      const { doc, selection } = window.view.state;
      return { last: doc.lastChild!.type.name, empty: doc.lastChild!.content.size === 0, atEnd: selection.head === doc.content.size - 1, top: selection.$head.depth };
    });
    expect(below).toEqual({ last: 'paragraph', empty: true, atEnd: true, top: 1 });
    await caretIn(page, { grid: 0, cell: 1, offset: 0 });
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => window.view.state.selection.$head.parent.textContent)).toBe('Above the grid.');
  });

  test('↑ from the first row of a grid that opens the document makes a paragraph before it', async ({ page }) => {
    await page.goto('/?new=1');
    await page.waitForFunction(() => Boolean(window.view));
    await page.evaluate(() => {
      const view = window.view;
      const s = view.state.schema;
      const cell = (text: string) => s.nodes.grid_cell.create(null, s.nodes.paragraph.create(null, text ? s.text(text) : undefined));
      const doc = s.nodes.doc.create(view.state.doc.attrs, [
        s.nodes.grid.create({ columns: [1, 1], gutter: 1 }, [
          s.nodes.grid_row.create(null, [cell('One'), cell('Two')]),
          s.nodes.grid_row.create(null, [cell('Three'), cell('Four')]),
        ]),
        s.nodes.paragraph.create(null, s.text('Below the grid.')),
      ]);
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
    });
    await settleLocal(page);
    await caretIn(page, { grid: 0, cell: 1, offset: 0 });
    await page.keyboard.press('ArrowUp');
    const above = await page.evaluate(() => {
      const { doc, selection } = window.view.state;
      return { first: doc.firstChild!.type.name, empty: doc.firstChild!.content.size === 0, second: doc.child(1).type.name, head: selection.head, depth: selection.$head.depth };
    });
    expect(above).toEqual({ first: 'paragraph', empty: true, second: 'grid', head: 1, depth: 1 });
  });
});
