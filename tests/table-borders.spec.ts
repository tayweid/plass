import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Cell borders (src/table-borders.ts, table-border-commands.ts): lines on
// chosen sides of chosen cells, so a game's payoff matrix, lines round the
// four payoffs and none round the names and labels, is a native table
// (Taylor, 2026-10-21). Read from the page's pixels, set from the cell
// panel's Border row, paint only.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> };
  }
}

const MATRIX = `Before the matrix.

::: {.table style=plain borders="r2-3c2-3:all"}
|   |   |   |   |
|---|---|---|---|
|   |   | Firm 2 |   |
|   |   | Low | High |
| Firm 1 | Up | 3, 3 | 0, 5 |
|   | Down | 5, 0 | 1, 1 |
:::

After the matrix.
`;

async function openMd(page: Page, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('borders.md', { create: true });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
    await window.__fm.loadHandle(h);
  }, text);
  await settleLocal(page);
}

/** The table cell holding `text`. */
const cell = (page: Page, text: string) => page.locator('.ProseMirror td', { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });

/** The darkest pixel (0–255) across each edge of the cell holding `text`. */
async function edgeInk(page: Page, text: string) {
  const box = (await cell(page, text).boundingBox())!;
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({ b64, box }) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext('2d')!;
    g.drawImage(bitmap, 0, 0);
    const dpr = bitmap.width / innerWidth;
    const darkest = (x: number, y: number, vertical: boolean) => {
      let min = 255;
      for (let d = -3; d <= 3; d++) {
        const [r, gr, b] = g.getImageData(Math.round((vertical ? x + d / 2 : x) * dpr), Math.round((vertical ? y : y + d / 2) * dpr), 1, 1).data;
        min = Math.min(min, Math.round((r + gr + b) / 3));
      }
      return min;
    };
    // Probe a quarter in from the corner: off the text, on the edge.
    const qx = box.x + box.width / 4;
    const qy = box.y + box.height / 4;
    return {
      top: darkest(qx, box.y, false),
      bottom: darkest(qx, box.y + box.height, false),
      left: darkest(box.x, qy, true),
      right: darkest(box.x + box.width, qy, true),
    };
  }, { b64: shot, box });
}

const INK = 170;

test('a payoff matrix from Markdown: lines round the four payoffs and nowhere else', async ({ page }) => {
  await openMd(page, MATRIX);
  // The caret stays outside the table: a Plain table shows ghost edges
  // while it is edited.
  for (const payoff of ['3, 3', '0, 5', '5, 0', '1, 1']) {
    const ink = await edgeInk(page, payoff);
    for (const [side, value] of Object.entries(ink)) expect(value, `${payoff} ${side}`).toBeLessThan(INK);
  }
  // The labels: no line between them, nor above the column labels.
  const row = await edgeInk(page, 'Firm 1');
  expect(row.right).toBeGreaterThan(230);
  expect(row.top).toBeGreaterThan(230);
  const col = await edgeInk(page, 'Low');
  expect(col.top).toBeGreaterThan(230);
  expect(col.left).toBeGreaterThan(230);
});

/** Drag across the cells from `from` to `to` (a cell selection). */
async function selectCells(page: Page, from: string, to: string) {
  const a = (await cell(page, from).boundingBox())!;
  const b = (await cell(page, to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
}

const borders = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string> = {};
    window.view.state.doc.descendants((node) => {
      if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
        if (node.attrs.border) out[node.textContent] = node.attrs.border as string;
        return false;
      }
      return true;
    });
    return out;
  });

async function openCellPanel(page: Page) {
  await page.locator('.block-pill [data-tile="cell"]').click();
  const panel = page.getByRole('dialog', { name: 'Cell fill, rules and borders' });
  await expect(panel).toBeVisible();
  return panel;
}

const PLAIN = `Before.

::: {.table style=plain}
| A | B | C |
|---|---|---|
| a1 | b1 | c1 |
| a2 | b2 | c2 |
| a3 | b3 | c3 |
:::

After.
`;

test('the Border row: Outside, a side on and off, All, None', async ({ page }) => {
  await openMd(page, PLAIN);
  await cell(page, 'a1').click();
  await selectCells(page, 'a1', 'b2');
  const panel = await openCellPanel(page);
  const tile = (name: string) => panel.getByRole('button', { name: `${name} border`, exact: true });

  await tile('Outside').click();
  expect(await borders(page)).toEqual({ a1: 'top left', b1: 'top right', a2: 'bottom left', b2: 'right bottom' });
  await expect(tile('Top')).toHaveAttribute('aria-pressed', 'true');
  await expect(tile('All')).toHaveAttribute('aria-pressed', 'false');

  // Top is drawn all along: it turns off, on both sides of the edge.
  await tile('Top').click();
  expect(await borders(page)).toEqual({ a1: 'left', b1: 'right', a2: 'bottom left', b2: 'right bottom' });
  await expect(tile('Top')).toHaveAttribute('aria-pressed', 'false');
  await tile('Top').click();
  expect(await borders(page)).toEqual({ a1: 'top left', b1: 'top right', a2: 'bottom left', b2: 'right bottom' });

  await tile('All').click();
  expect(await borders(page)).toEqual({ a1: 'all', b1: 'all', a2: 'all', b2: 'all' });
  await expect(tile('All')).toHaveAttribute('aria-pressed', 'true');

  // None takes every line in and round the selection away, the
  // neighbours' facing sides too.
  await page.evaluate(() => {
    const { state } = window.view;
    let pos = -1;
    state.doc.descendants((node, p) => {
      if (pos < 0 && node.type.name === 'table_cell' && node.textContent === 'c1') pos = p;
      return pos < 0;
    });
    window.view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...state.doc.nodeAt(pos)!.attrs, border: 'left' }).setMeta('addToHistory', false));
  });
  // Past history's grouping delay, so None is an undo step of its own.
  await page.waitForTimeout(600);
  await tile('None').click();
  expect(await borders(page)).toEqual({});
  await expect(tile('None')).toHaveAttribute('aria-pressed', 'true');

  // Undo goes back a step at a time.
  await page.keyboard.press('ControlOrMeta+z');
  expect(await borders(page)).toEqual({ a1: 'all', b1: 'all', a2: 'all', b2: 'all', c1: 'left' });
});

test('a grid table: the Border row is off, and says why', async ({ page }) => {
  await openMd(page, PLAIN.replace('style=plain', 'style=grid'));
  await cell(page, 'a1').click();
  const panel = await openCellPanel(page);
  await expect(panel.getByRole('button', { name: 'All border', exact: true })).toBeDisabled();
  await expect(panel.getByText('Grid style boxes every cell')).toBeVisible();
});

test('borders are paint only: no cell or block moves', async ({ page }) => {
  await openMd(page, PLAIN);
  const boxes = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.ProseMirror > *, .ProseMirror td, .ProseMirror th')].map((el) => {
        const r = el.getBoundingClientRect();
        return [r.top, r.height, r.left, r.width].map((v) => Math.round(v * 64) / 64);
      }),
    );
  const before = await boxes();
  await page.evaluate(() => {
    const { state } = window.view;
    const tr = state.tr;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'table_cell' || node.type.name === 'table_header') tr.setNodeMarkup(pos, undefined, { ...node.attrs, border: 'all' });
    });
    window.view.dispatch(tr);
  });
  await settleLocal(page);
  expect(await boxes()).toEqual(before);
  expect(await page.locator('.ProseMirror td[data-border="all"]').count()).toBe(9);
});

test('line colours: a red border from the cell panel, gray lines from Table settings, drawn in those colours', async ({ page }) => {
  await openMd(page, MATRIX);
  await cell(page, '3, 3').click();
  const panel = await openCellPanel(page);
  await panel.getByRole('radio', { name: 'Red border colour' }).click();
  const attrs = () =>
    page.evaluate(() => {
      let out: Record<string, unknown> = {};
      window.view.state.doc.descendants((node) => {
        if (node.type.name === 'table') {
          out = { line: node.attrs.lineColor, cells: {} as Record<string, string> };
          node.descendants((c) => {
            if (c.type.name === 'table_cell' && c.attrs.borderColor) (out.cells as Record<string, string>)[c.textContent] = c.attrs.borderColor as string;
            return c.type.name !== 'table_cell';
          });
          return false;
        }
        return true;
      });
      return out;
    });
  expect(await attrs()).toEqual({ line: '', cells: { '3, 3': 'red' } });
  await page.keyboard.press('Escape');
  await page.locator('.block-pill [data-tile="table"]').click();
  const settings = page.getByRole('dialog', { name: 'Table settings' });
  await expect(settings).toBeVisible();
  await settings.getByRole('radio', { name: 'Gray' }).click();
  expect(await attrs()).toEqual({ line: 'gray', cells: { '3, 3': 'red' } });

  // Off the table, so no ghost edges: the pixels on each payoff's left edge.
  await page.locator('.ProseMirror p', { hasText: 'Before the matrix.' }).click();
  const leftEdge = async (text: string) => {
    const box = (await cell(page, text).boundingBox())!;
    const shot = (await page.screenshot()).toString('base64');
    return page.evaluate(async ({ b64, x, y }) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d')!;
      g.drawImage(bitmap, 0, 0);
      const dpr = bitmap.width / innerWidth;
      // The most saturated (red) and the darkest pixel across the edge.
      let red = 0;
      let dark = 255;
      for (let d = -3; d <= 3; d++) {
        const [r, gr, b] = g.getImageData(Math.round((x + d / 2) * dpr), Math.round(y * dpr), 1, 1).data;
        red = Math.max(red, r - Math.max(gr, b));
        dark = Math.min(dark, Math.round((r + gr + b) / 3));
      }
      return { red, dark };
    }, { b64: shot, x: box.x, y: box.y + box.height / 4 });
  };
  const red = await leftEdge('3, 3');
  expect(red.red).toBeGreaterThan(60);
  // Gray: a line, but neither red nor ink-black.
  const gray = await leftEdge('5, 0');
  expect(gray.red).toBeLessThan(20);
  expect(gray.dark).toBeLessThan(235);
  expect(gray.dark).toBeGreaterThan(60);
});
