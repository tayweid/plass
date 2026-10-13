import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Editing chrome is paint only: putting the caret in a grid or a table must
// not move a block, a cell box, or a cell margin. The fixture is shaped like
// a printed exam (prompt grids over answer boxes, a spacer-column grid, a
// data-sheet grid whose cells each end in a table, tables before and after),
// loaded after a default new document so the first fit sees that document's
// geometry variables — the condition under which a data-sheet cell used to
// grow on the first click (GridCellView read a stale --table-mb).

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null) => Promise<unknown> };
    __pagCount: () => number;
  }
}

const SHEET = readFileSync(new URL('./fixtures/block-chrome/sheet.md', import.meta.url), 'utf8');
// An answer box, as the exam draws them: a bare stroked rectangle.
const BOX = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="260" viewBox="0 0 200 260"><rect x="1" y="1" width="198" height="258" fill="none" stroke="#aaaaaa" stroke-width="1.2"/></svg>';
const TOLERANCE = 0.05;

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
  // The answer boxes are loaded (a box arriving later would resize its row).
  await expect
    .poll(() => page.locator('.ProseMirror .ts-grid img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length))
    .toBeGreaterThanOrEqual(3);
  await settleLocal(page, -1, 600);
}

interface Snapshot {
  blocks: Array<{ tag: string; top: number; height: number }>;
  cells: Array<{ kind: string; top: number; height: number; mt: number; mb: number }>;
}

/** Layout px (unscaled), relative to the editor: every top-level block's
 *  box and every grid / table cell's box and margins. */
function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const stack = document.getElementById('stack')!;
    const s = stack.getBoundingClientRect().width / stack.offsetWidth;
    const editor = document.querySelector('.ProseMirror')!;
    const origin = editor.getBoundingClientRect().top;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: (r.top - origin) / s, height: r.height / s };
    };
    return {
      blocks: [...editor.children].map((el) => ({ tag: el.tagName, ...box(el) })),
      cells: [...editor.querySelectorAll('.ts-grid-cell, td, th')].map((el) => {
        const cs = getComputedStyle(el);
        return { kind: el.className.includes('ts-grid-cell') ? 'grid' : el.tagName, ...box(el), mt: parseFloat(cs.marginTop), mb: parseFloat(cs.marginBottom) };
      }),
    };
  });
}

function differences(a: Snapshot, b: Snapshot): string[] {
  const out: string[] = [];
  if (a.blocks.length !== b.blocks.length) out.push(`block count ${a.blocks.length} → ${b.blocks.length}`);
  if (a.cells.length !== b.cells.length) out.push(`cell count ${a.cells.length} → ${b.cells.length}`);
  a.blocks.forEach((x, i) => {
    const y = b.blocks[i];
    if (!y) return;
    for (const k of ['top', 'height'] as const) if (Math.abs(x[k] - y[k]) > TOLERANCE) out.push(`block ${i} <${x.tag}> ${k} ${x[k].toFixed(3)} → ${y[k].toFixed(3)}`);
  });
  a.cells.forEach((x, i) => {
    const y = b.cells[i];
    if (!y) return;
    for (const k of ['top', 'height', 'mt', 'mb'] as const) if (Math.abs(x[k] - y[k]) > TOLERANCE) out.push(`cell ${i} (${x.kind}) ${k} ${x[k].toFixed(3)} → ${y[k].toFixed(3)}`);
  });
  return out;
}

/** Every caret placement to try: each grid cell, and one body cell of each
 *  table (nested ones included). */
function caretTargets(page: Page): Promise<Array<{ pos: number; what: string }>> {
  return page.evaluate(() => {
    const out: Array<{ pos: number; what: string }> = [];
    let table = 0;
    window.view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'grid_cell') out.push({ pos: pos + 1, what: `grid cell @${pos}` });
      if (node.type.name === 'table') {
        // The second row's first cell: a body cell (row 0 may be the header).
        const skip = node.childCount > 1 ? node.child(0).nodeSize : 0;
        const rowStart = pos + 1 + skip;
        out.push({ pos: rowStart + 2, what: `table ${table++} @${pos} (${node.child(skip ? 1 : 0).firstChild?.textContent})` });
      }
      return true;
    });
    return out;
  });
}

async function placeCaret(page: Page, pos: number) {
  await page.evaluate((pos) => {
    const { state } = window.view;
    const Selection = state.selection.constructor as unknown as {
      near: (p: ReturnType<typeof state.doc.resolve>) => typeof state.selection;
    };
    window.view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(pos))));
  }, pos);
  // Re-fits run in a microtask, table measures in a frame, and a re-fit
  // that moved anything requests a pagination pass: give all three time.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(120);
}

async function caretMovesNothing(page: Page) {
  await openSheet(page);
  // Caret outside every grid and table: the first paragraph.
  const outside = await page.evaluate(() => {
    let pos = -1;
    window.view.state.doc.descendants((n, p) => {
      if (pos < 0 && n.type.name === 'paragraph') pos = p + 1;
      return pos < 0;
    });
    return pos;
  });
  await placeCaret(page, outside);
  const rest = await snapshot(page);
  expect(rest.cells.filter((c) => c.kind === 'grid').length).toBe(14);
  const targets = await caretTargets(page);
  expect(targets.filter((t) => t.what.startsWith('table')).length).toBe(5);
  for (const target of targets) {
    await placeCaret(page, target.pos);
    expect(await page.evaluate(() => window.view.state.selection.$from.depth > 1)).toBe(true);
    expect(differences(rest, await snapshot(page)), `caret in ${target.what}`).toEqual([]);
  }
  // Back outside, after any pagination pass a re-fit could have asked for.
  const count = await page.evaluate(() => window.__pagCount());
  await placeCaret(page, outside);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.__pagCount())).toBe(count);
  expect(differences(rest, await snapshot(page))).toEqual([]);
}

test('the caret in a grid or a table moves no block, cell box, or cell margin', async ({ page }) => {
  test.setTimeout(120_000);
  await caretMovesNothing(page);
});

test.describe('in a 740 px window (the compact pill, a smaller paper scale)', () => {
  test.use({ viewport: { width: 740, height: 860 } });
  test('the caret in a grid or a table moves no block, cell box, or cell margin', async ({ page }) => {
    test.setTimeout(120_000);
    await caretMovesNothing(page);
    // The pill really is the compact one here.
    await page.evaluate(() => {
      let pos = -1;
      window.view.state.doc.descendants((n, p) => {
        if (pos < 0 && n.type.name === 'table') pos = p + 3;
        return pos < 0;
      });
      const { state } = window.view;
      const Selection = state.selection.constructor as unknown as { near: (p: ReturnType<typeof state.doc.resolve>) => typeof state.selection };
      window.view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(pos))));
    });
    await expect(page.locator('.block-pill')).toHaveClass(/is-compact/);
  });
});

/** The data-sheet grid: the one whose cells end in tables. */
const dataSheetCells = (page: Page) => page.locator('.ProseMirror .ts-grid:has(table) > .ts-grid-row > .ts-grid-cell');
const cellMargins = (page: Page) =>
  dataSheetCells(page).evaluateAll((cells) =>
    cells.map((c) => {
      const cs = getComputedStyle(c);
      return { mt: parseFloat(cs.marginTop), mb: parseFloat(cs.marginBottom) };
    }),
  );

async function expectClickKeepsMargins(page: Page) {
  const before = await cellMargins(page);
  expect(before).toHaveLength(3);
  // Cells that end in the same kind of table end at the same distance
  // below their frames.
  expect(Math.abs(before[0].mb - before[1].mb)).toBeLessThan(TOLERANCE);
  expect(Math.abs(before[1].mb - before[2].mb)).toBeLessThan(TOLERANCE);
  for (const index of [1, 0, 2]) {
    const heading = dataSheetCells(page).nth(index).locator('p').first();
    await heading.scrollIntoViewIfNeeded();
    await heading.click();
    await expect(dataSheetCells(page).nth(index)).toHaveClass(/ts-grid-cell-active/);
    await page.waitForTimeout(150);
    const after = await cellMargins(page);
    after.forEach((m, i) => {
      expect(Math.abs(m.mt - before[i].mt), `cell ${i} margin-top after a click in cell ${index}`).toBeLessThan(TOLERANCE);
      expect(Math.abs(m.mb - before[i].mb), `cell ${i} margin-bottom after a click in cell ${index}`).toBeLessThan(TOLERANCE);
    });
  }
}

test('a click in a data-sheet grid cell changes no cell margin', async ({ page }) => {
  await openSheet(page);
  await expectClickKeepsMargins(page);
});

test('grid cells re-fit when the document geometry changes, with no caret in them', async ({ page }) => {
  await openSheet(page);
  // A Layout change (body size) republishes --table-mb; no cell node changes.
  await page.evaluate(() => {
    let pos = -1;
    window.view.state.doc.descendants((n, p) => {
      if (pos < 0 && n.type.name === 'paragraph') pos = p + 1;
      return pos < 0;
    });
    const { state } = window.view;
    const Selection = state.selection.constructor as unknown as {
      near: (p: ReturnType<typeof state.doc.resolve>) => typeof state.selection;
    };
    window.view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(pos))));
  });
  const count = await page.evaluate(() => window.__pagCount());
  await page.evaluate(() => {
    const v = window.view;
    v.dispatch(v.state.tr.setDocAttribute('settings', { ...v.state.doc.attrs.settings, sizePt: 12 }));
  });
  await settleLocal(page, count);
  await expectClickKeepsMargins(page);
});
