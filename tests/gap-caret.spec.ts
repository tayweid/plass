import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// The caret beside a table where no line can hold one (src/gap-caret.ts):
// a table that opens a grid cell, or sits between two blocks that are not
// text, has a caret place before (after) it, reached with the arrows and a
// click, where typing or Enter makes the line; ⌫ takes an empty line above
// a table away again. ↓ / ↑ from a line beside a table enter it.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

type Spec = Array<{ p: string } | { table: string[][] } | { grid: Array<Array<{ p: string } | { table: string[][] }>> }>;

/** Replace the document with paragraphs, tables and one-row grids. */
async function load(page: Page, spec: Spec) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate((spec) => {
    const view = window.view;
    const s = view.state.schema;
    const n = s.nodes;
    const para = (t: string) => n.paragraph.create(null, t ? s.text(t) : undefined);
    const table = (rows: string[][]) => n.table.create(null, rows.map((r) => n.table_row.create(null, r.map((t) => n.table_cell.create(null, para(t))))));
    const block = (b: { p: string } | { table: string[][] }) => ('p' in b ? para(b.p) : table(b.table));
    const blocks = spec.map((b) => ('grid' in b ? n.grid.create({ columns: b.grid.map(() => 1), gutter: 1 }, [n.grid_row.create(null, b.grid.map((cell) => n.grid_cell.create(null, cell.map(block))))]) : block(b)));
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, blocks));
  }, spec);
  await settleLocal(page);
}

/** Put the caret at the start (end) of the text block holding `text`. */
async function caretAt(page: Page, text: string, atEnd = false) {
  await page.evaluate(({ text, atEnd }) => {
    const view = window.view;
    let pos = -1;
    view.state.doc.descendants((node, p) => {
      if (pos < 0 && node.isTextblock && node.textContent === text) pos = p + 1 + (atEnd ? node.content.size : 0);
      return pos < 0;
    });
    const Sel = view.state.selection.constructor as unknown as { near: (p: unknown, bias?: number) => import('prosemirror-state').Selection };
    view.focus();
    view.dispatch(view.state.tr.setSelection(Sel.near(view.state.doc.resolve(pos), 1)));
  }, { text, atEnd });
}

const caret = (page: Page) =>
  page.evaluate(() => {
    const sel = window.view.state.selection;
    return { kind: sel.toJSON().type as string, text: sel.$head.parent.isTextblock ? sel.$head.parent.textContent : null, in: sel.$head.parent.type.name };
  });

/** The first grid cell's blocks, as `p:text` / `table`. */
const firstCell = (page: Page) =>
  page.evaluate(() => {
    let cell: import('prosemirror-model').Node | null = null;
    window.view.state.doc.descendants((node) => {
      if (!cell && node.type.name === 'grid_cell') cell = node;
      return !cell;
    });
    const out: string[] = [];
    (cell as unknown as import('prosemirror-model').Node).forEach((b) => out.push(b.type.name === 'paragraph' ? `p:${b.textContent}` : b.type.name));
    return out;
  });

const GRID: Spec = [{ p: 'Before the grid.' }, { grid: [[{ table: [['A1', 'B1'], ['A2', 'B2']] }], [{ p: 'Right cell.' }]] }, { p: 'After the grid.' }];

test('a table opening a grid cell: ↑ reaches the place above it, typing makes the line', async ({ page }) => {
  await load(page, GRID);
  await caretAt(page, 'A1');
  await page.keyboard.press('ArrowUp');
  expect(await caret(page)).toEqual({ kind: 'gapcaret', text: null, in: 'grid_cell' });
  // Drawn above the table, at its left edge.
  const mark = page.locator('.gap-caret');
  await expect(mark).toBeVisible();
  const box = (await mark.boundingBox())!;
  const table = (await page.locator('.ProseMirror .ts-grid table').boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(table.y);
  expect(Math.abs(box.x - table.x)).toBeLessThan(2);

  await page.keyboard.type('Above the table.');
  expect(await firstCell(page)).toEqual(['p:Above the table.', 'table']);
  expect(await caret(page)).toEqual({ kind: 'text', text: 'Above the table.', in: 'paragraph' });
  await expect(mark).toHaveCount(0);

  // ↑ again from the table goes to the line just made.
  await caretAt(page, 'A1');
  await page.keyboard.press('ArrowUp');
  expect(await caret(page)).toEqual({ kind: 'text', text: 'Above the table.', in: 'paragraph' });
});

test('Enter at the place makes an empty line; ↓ enters the table; ⌫ at its start takes the line back', async ({ page }) => {
  await load(page, GRID);
  await caretAt(page, 'A1');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  expect(await firstCell(page)).toEqual(['p:', 'table']);
  expect(await caret(page)).toEqual({ kind: 'text', text: '', in: 'paragraph' });
  // The table is centred, narrower than the cell: ↓ still enters it.
  await page.keyboard.press('ArrowDown');
  expect(await caret(page)).toEqual({ kind: 'text', text: 'A1', in: 'paragraph' });
  await caretAt(page, 'A1');
  await page.keyboard.press('Backspace');
  expect(await firstCell(page)).toEqual(['table']);
  expect(await caret(page)).toEqual({ kind: 'text', text: 'A1', in: 'paragraph' });
});

test('⌫ in an empty line above a table in a cell deletes the line', async ({ page }) => {
  await load(page, [{ p: 'Before the grid.' }, { grid: [[{ p: '' }, { table: [['A1', 'B1']] }], [{ p: 'Right cell.' }]] }]);
  await caretAt(page, '');
  await page.keyboard.press('Backspace');
  expect(await firstCell(page)).toEqual(['table']);
  expect(await caret(page)).toEqual({ kind: 'gapcaret', text: null, in: 'grid_cell' });
  // From the place, ↑ leaves the grid; ↓ from above stops at the place
  // again (the column misses the centred table), then enters the table.
  await page.keyboard.press('ArrowUp');
  expect(await caret(page)).toEqual({ kind: 'text', text: 'Before the grid.', in: 'paragraph' });
  await page.keyboard.press('ArrowDown');
  expect(await caret(page)).toEqual({ kind: 'gapcaret', text: null, in: 'grid_cell' });
  await page.keyboard.press('ArrowDown');
  expect(await caret(page)).toEqual({ kind: 'text', text: 'A1', in: 'paragraph' });
});

test('a click above a table that opens a cell lands the caret there', async ({ page }) => {
  await load(page, GRID);
  const table = (await page.locator('.ProseMirror .ts-grid table').boundingBox())!;
  const cell = (await page.locator('.ProseMirror .ts-grid-cell').first().boundingBox())!;
  expect(table.y - cell.y).toBeGreaterThan(4);
  await page.mouse.click(table.x + table.width / 2, (cell.y + table.y) / 2);
  expect(await caret(page)).toEqual({ kind: 'gapcaret', text: null, in: 'grid_cell' });
});

test('between two tables: ↑ from the second reaches the place between, Enter makes the line', async ({ page }) => {
  await load(page, [{ p: 'Top.' }, { table: [['A1', 'B1']] }, { table: [['C1', 'D1']] }, { p: 'End.' }]);
  await caretAt(page, 'C1');
  await page.keyboard.press('ArrowUp');
  expect(await caret(page)).toEqual({ kind: 'gapcaret', text: null, in: 'doc' });
  await page.keyboard.press('Enter');
  const blocks = await page.evaluate(() => {
    const out: string[] = [];
    window.view.state.doc.forEach((b) => out.push(b.type.name === 'paragraph' ? `p:${b.textContent}` : b.type.name));
    return out;
  });
  expect(blocks).toEqual(['p:Top.', 'table', 'p:', 'table', 'p:End.']);
  // ↑ from the first table goes to the paragraph before it: no place there.
  await caretAt(page, 'A1');
  await page.keyboard.press('ArrowUp');
  expect(await caret(page)).toEqual({ kind: 'text', text: 'Top.', in: 'paragraph' });
});

test('↓ / ↑ from the line beside a centred table enter it, in the nearest column', async ({ page }) => {
  const after = 'After the table, one line that runs on past the middle of the page.';
  await load(page, [{ p: 'Before the table.' }, { table: [['A1', 'B1'], ['A2', 'B2']] }, { p: after }]);
  await caretAt(page, 'Before the table.');
  await page.keyboard.press('ArrowDown');
  expect(await caret(page)).toEqual({ kind: 'text', text: 'A1', in: 'paragraph' });
  // From the end of a line that ends right of the table: its right column.
  await caretAt(page, after, true);
  await page.keyboard.press('ArrowUp');
  expect(await caret(page)).toEqual({ kind: 'text', text: 'B2', in: 'paragraph' });
});

test('the place is paint only: no block or cell moves while the caret is there', async ({ page }) => {
  await load(page, GRID);
  const boxes = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.ProseMirror > *, .ProseMirror .ts-grid-cell, .ProseMirror table')].map((el) => {
        const r = el.getBoundingClientRect();
        return [r.top, r.height, r.left, r.width].map((v) => Math.round(v * 64) / 64);
      }),
    );
  await caretAt(page, 'A1');
  await settleLocal(page);
  const before = await boxes();
  await page.keyboard.press('ArrowUp');
  expect(await caret(page)).toEqual({ kind: 'gapcaret', text: null, in: 'grid_cell' });
  await settleLocal(page);
  expect(await boxes()).toEqual(before);
});
