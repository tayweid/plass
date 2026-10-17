import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// The block pill (src/block-chrome.ts): the controls of the table or grid
// the caret is in, in the page's margin beside it, with the actions pill
// (delete row, delete column, merge or split) under it. It runs the tables'
// own commands and the grids' caret commands, keeps the editor's selection,
// and does nothing for a keystroke but dim.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null) => Promise<unknown> };
    __pagCount: () => number;
    __pillProbe?: { reads: string[]; styles: number; stop: () => void };
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

/** A caret at the end of the textblock in a table cell (DOM row/column of
 *  the nth top-level or nested table) or a grid cell (row-major). */
async function caretIn(page: Page, target: { table: number; row: number; col: number } | { grid: number; cell: number }) {
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
      if (at < 0 && n.isTextblock) at = $p.start(d) + pos + 1 + n.content.size;
      return at < 0;
    });
    view.focus();
    // TextSelection through the app's own class: the selection's base.
    let S = view.state.selection.constructor as { fromJSON?: (doc: unknown, json: unknown) => unknown };
    while (Object.getPrototypeOf(S) && Object.getPrototypeOf(S) !== Function.prototype) S = Object.getPrototypeOf(S);
    view.dispatch(view.state.tr.setSelection(S.fromJSON!(view.state.doc, { type: 'text', anchor: at, head: at }) as never));
  }, target);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const pill = (page: Page) => page.locator('.block-pill');
const tile = (page: Page, id: string) => page.locator(`.block-pill [data-tile="${id}"]`);
/** A tile of the actions pill under the pill. */
const action = (page: Page, id: string) => page.locator(`.bc-actions [data-tile="${id}"]`);
/** Rows added below the caret's, one click each: twelve make the sheet's
 *  first table taller than the pill and the actions pill under it. */
const addRows = async (page: Page, n = 12) => {
  for (let i = 0; i < n; i++) await tile(page, 'addrow').click();
};
const tableAt = (page: Page, index: number) => page.evaluate((i) => {
  const el = document.querySelectorAll('.ProseMirror table')[i];
  const view = window.view;
  const $p = view.state.doc.resolve(view.posAtDOM(el.querySelector('td, th')!, 0));
  let d = $p.depth;
  while (d > 0 && $p.node(d).type.name !== 'table') d--;
  const t = $p.node(d);
  const rows: Array<Array<{ text: string; align: string | null; fill: string; type: string }>> = [];
  const rules: string[] = [];
  t.forEach((row) => {
    rules.push(String(row.attrs.rule ?? ''));
    const cells: Array<{ text: string; align: string | null; fill: string; type: string }> = [];
    row.forEach((cell) => cells.push({ text: cell.textContent, align: cell.attrs.align, fill: String(cell.attrs.fill ?? ''), type: cell.type.name }));
    rows.push(cells);
  });
  return { rows, rules, columnWidths: t.attrs.columnWidths as string[] | null };
}, index);
const gridAt = (page: Page, index: number) => page.evaluate((i) => {
  const el = document.querySelectorAll('.ProseMirror .ts-grid')[i];
  const view = window.view;
  const $p = view.state.doc.resolve(view.posAtDOM(el.querySelector('.ts-grid-cell')!, 0));
  let d = $p.depth;
  while (d > 0 && $p.node(d).type.name !== 'grid') d--;
  const g = $p.node(d);
  const rows: string[][] = [];
  g.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cell.textContent));
    rows.push(cells);
  });
  return { rows, columns: g.attrs.columns as number[] };
}, index);
/** Where the caret is: the grid cell's row/column or the table cell's text. */
const caretCellText = (page: Page) => page.evaluate(() => {
  const $h = window.view.state.selection.$head;
  for (let d = $h.depth; d > 0; d--) if (/cell|header/.test($h.node(d).type.name)) return $h.node(d).textContent;
  return null;
});

test.describe('the block pill', () => {
  test('appears beside a table, hugs it, never covers text, and leaves with the caret', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    await expect(page.getByRole('toolbar', { name: 'Table controls' })).toBeVisible();
    // Add row below (and its Row above) · Add column right (and its Column
    // left) · Align · Cell │ Table settings, and under them Delete row ·
    // Delete column · Merge.
    await expect(page.locator('.block-pill .tb-btn')).toHaveCount(7);
    await expect(page.getByRole('toolbar', { name: 'Table row and column actions' }).locator('.tb-btn')).toHaveCount(3);
    const geometry = () => page.evaluate(() => {
      const r = (e: Element) => e.getBoundingClientRect();
      const p = r(document.querySelector('.block-pill')!);
      // The pill and the actions pill under it: the stack that covers nothing.
      const stack = r(document.querySelector('.block-stack')!);
      const table = r(document.querySelectorAll('.ProseMirror table')[0]);
      const editor = document.getElementById('editor')!;
      const s = r(document.getElementById('stack')!).width / document.getElementById('stack')!.offsetWidth;
      const textLeft = r(editor).left + parseFloat(getComputedStyle(editor).paddingLeft) * s;
      // Every line of text on the page, the table's and its caption's too.
      const texts: Array<{ rect: DOMRect; text: string }> = [];
      const walker = document.createTreeWalker(document.getElementById('stack')!, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let t: Node | null; (t = walker.nextNode());) {
        if (!t.textContent?.trim()) continue;
        range.selectNodeContents(t);
        for (const rect of range.getClientRects()) texts.push({ rect, text: t.textContent });
      }
      const hit = texts.filter(({ rect: t }) => t.right > stack.left && t.left < stack.right && t.bottom > stack.top && t.top < stack.bottom).map((t) => t.text);
      return { p: p.toJSON(), table: table.toJSON(), textLeft, hit, hug: document.querySelector('.block-pill')!.classList.contains('is-hug') };
    });
    // A short table: the pill and the actions pill are longer than the
    // table and its caption, so they stay in the margin (compact at this window: 8 px from the text)
    // rather than hang beside the prose below; level with the table's top.
    let geo = await geometry();
    expect(geo.hug).toBe(false);
    expect(Math.abs(geo.p.right - (geo.textLeft - 8))).toBeLessThan(1);
    expect(Math.abs(geo.p.top - geo.table.top)).toBeLessThan(1);
    expect(geo.hit).toEqual([]);
    // Grown taller than both, the centred table is hugged: 8 px clear of
    // its left edge, over no text.
    await addRows(page);
    await expect(pill(page)).toHaveClass(/is-hug/);
    geo = await geometry();
    expect(Math.abs(geo.p.right - (geo.table.left - 8))).toBeLessThan(1);
    expect(Math.abs(geo.p.top - geo.table.top)).toBeLessThan(1);
    expect(geo.hit).toEqual([]);
    // A grid spans the text column: the pill sits in the margin.
    await caretIn(page, { grid: 0, cell: 1 });
    await expect(page.getByRole('toolbar', { name: 'Grid controls' })).toBeVisible();
    // Add row below (and above) · Add column right (and left) · Align ·
    // Image │ Grid layout (docs/BLOCK-CHROME.md).
    await expect(page.locator('.block-pill .tb-btn')).toHaveCount(7);
    await expect(page.getByRole('toolbar', { name: 'Grid row and column actions' })).toBeVisible();
    await expect(pill(page)).not.toHaveClass(/is-hug/);
    // Out of the block: gone.
    await page.evaluate(() => {
      const view = window.view;
      let S = view.state.selection.constructor as { fromJSON?: (doc: unknown, json: unknown) => unknown };
      while (Object.getPrototypeOf(S) && Object.getPrototypeOf(S) !== Function.prototype) S = Object.getPrototypeOf(S);
      view.dispatch(view.state.tr.setSelection(S.fromJSON!(view.state.doc, { type: 'text', anchor: 3, head: 3 }) as never));
    });
    await expect(page.locator('.block-track')).toBeHidden();
  });

  test('typing that widens a hugged table never runs it under the pill', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    // Taller than the pill and the actions pill, so it hugs (as above).
    await addRows(page);
    await expect(pill(page)).toHaveClass(/is-hug/);
    // The Weather column is auto: typing widens the centred table to the
    // left before any placement runs (placements wait for a pause).
    await caretIn(page, { table: 0, row: 2, col: 1 });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    const gap = () => page.evaluate(() => {
      const p = document.querySelector('.block-pill')!.getBoundingClientRect();
      const t = document.querySelectorAll('.ProseMirror table')[0].getBoundingClientRect();
      return t.left - p.right;
    });
    const before = await page.evaluate(() => document.querySelectorAll('.ProseMirror table')[0].getBoundingClientRect().left);
    let least = await gap();
    for (const ch of ' and then a long squall from the west') {
      await page.keyboard.type(ch);
      await page.waitForTimeout(40);
      least = Math.min(least, await gap());
    }
    const after = await page.evaluate(() => document.querySelectorAll('.ProseMirror table')[0].getBoundingClientRect().left);
    expect(after).toBeLessThan(before - 40);
    expect(least).toBeGreaterThan(0);
    // Once typing pauses it hugs the widened table again, 8 px clear.
    await expect(page.locator('.block-track')).not.toHaveClass(/is-typing/);
    await expect(pill(page)).toHaveClass(/is-hug/);
    expect(Math.abs((await gap()) - 8)).toBeLessThan(1);
  });

  test('a typing run keeps the pill in the margin until it pauses, reading nothing', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    await addRows(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    await expect(pill(page)).toHaveClass(/is-hug/);
    // Every frame of the run: the track's left and the hug class, and any
    // geometry block-chrome reads.
    await page.evaluate(() => {
      const w = window as unknown as { __run: { reads: number; samples: string[]; raf: number; stop: () => void } };
      const rect = Element.prototype.getBoundingClientRect;
      const run = { reads: 0, samples: [] as string[], raf: 0, stop: () => {} };
      Element.prototype.getBoundingClientRect = function () {
        if (/block-chrome/.test(new Error().stack ?? '')) run.reads++;
        return rect.call(this);
      };
      const track = document.querySelector<HTMLElement>('.block-track')!;
      const pillEl = document.querySelector<HTMLElement>('.block-pill')!;
      const tick = () => {
        const s = `${pillEl.classList.contains('is-hug') ? 'H' : '-'}${track.classList.contains('is-typing') ? 'T' : '-'} ${Math.round(rect.call(track).left)}`;
        if (run.samples[run.samples.length - 1] !== s) run.samples.push(s);
        run.raf = requestAnimationFrame(tick);
      };
      tick();
      run.stop = () => {
        cancelAnimationFrame(run.raf);
        Element.prototype.getBoundingClientRect = rect;
      };
      w.__run = run;
    });
    // One key every 120 ms: a run of about 2.4 s, longer than the pause.
    for (const ch of 'gusts later in the day') {
      await page.keyboard.type(ch);
      await page.waitForTimeout(120);
    }
    const mid = await page.evaluate(() => {
      const run = (window as unknown as { __run: { reads: number; samples: string[] } }).__run;
      return { reads: run.reads, samples: [...run.samples] };
    });
    // Stepped back on the first key and nowhere else until the pause.
    expect(mid.reads).toBe(0);
    expect(mid.samples).toHaveLength(2);
    expect(mid.samples[0]).toMatch(/^H- /);
    expect(mid.samples[1]).toMatch(/^-T /);
    // The pause places it beside the table again.
    await expect(page.locator('.block-track')).not.toHaveClass(/is-typing/);
    await expect(pill(page)).toHaveClass(/is-hug/);
    const after = await page.evaluate(() => {
      const run = (window as unknown as { __run: { reads: number; stop: () => void } }).__run;
      run.stop();
      return run.reads;
    });
    expect(after).toBeGreaterThan(0);
  });

  test('the add tiles, the actions pill and Table settings run the table commands without taking the focus', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    // One click adds a row below; the editor keeps the focus.
    await tile(page, 'addrow').click();
    expect(await page.evaluate(() => window.view.hasFocus())).toBe(true);
    let t = await tableAt(page, 0);
    expect(t.rows).toHaveLength(6);
    expect(t.rows[3].map((c) => c.text).join('')).toBe('');
    expect(t.rows[3].every((c) => c.type === 'table_cell')).toBe(true);
    // And the actions pill's Delete row takes it out again.
    await action(page, 'delrow').click();
    expect(await page.evaluate(() => window.view.hasFocus())).toBe(true);
    expect((await tableAt(page, 0)).rows).toHaveLength(5);

    await caretIn(page, { table: 0, row: 2, col: 1 });
    await tile(page, 'addcol').click();
    t = await tableAt(page, 0);
    expect(t.rows[0]).toHaveLength(5);
    expect(t.rows[0][2].text).toBe('');

    // The header row and the caret column's width: Table settings.
    await caretIn(page, { table: 0, row: 2, col: 1 });
    await tile(page, 'table').click();
    const settings = page.getByRole('dialog', { name: 'Table settings' });
    await expect(settings.getByRole('radiogroup', { name: 'Header row' }).locator('[data-value="off"]')).toHaveAttribute('aria-checked', 'true');
    // Width: a fixed width at the caret's column, then a share typed in its
    // field (Enter applies and keeps the field).
    const sizing = settings.getByRole('radiogroup', { name: 'Selected column sizing' });
    await expect(sizing.locator('[data-value="auto"]')).toHaveAttribute('aria-checked', 'true');
    await sizing.locator('[data-value="pt"]').click();
    t = await tableAt(page, 0);
    expect(t.columnWidths?.[1]).toBe('72pt');
    await expect(sizing.locator('[data-value="pt"]')).toHaveAttribute('aria-checked', 'true');
    await sizing.locator('[data-value="fr"]').click();
    expect((await tableAt(page, 0)).columnWidths?.[1]).toBe('1fr');
    const share = settings.getByLabel('Column width amount');
    await share.fill('2');
    await share.press('Enter');
    t = await tableAt(page, 0);
    expect(t.columnWidths?.[1]).toBe('2fr');
    await expect(share).toBeFocused();
    await expect(settings.getByRole('button', { name: 'Reset to automatic' })).toBeVisible();
    await share.press('Escape');
    await expect(settings).toBeHidden();
    expect(await caretCellText(page)).toBe('Rain');
  });

  test('the Align and Cell panels show and set the caret cell', async ({ page }) => {
    await openSheet(page);
    // Hours is a right-aligned column.
    await caretIn(page, { table: 0, row: 2, col: 2 });
    await expect(tile(page, 'align')).toHaveAttribute('aria-label', 'Align · Right');
    await tile(page, 'align').click();
    const align = page.getByRole('dialog', { name: /Align/ });
    await expect(align.getByRole('radio', { name: 'Align selected cells right' })).toHaveAttribute('aria-checked', 'true');
    await align.getByRole('radio', { name: 'Align selected cells center' }).click();
    await expect(align).toBeVisible();
    await expect(align.getByRole('radio', { name: 'Align selected cells center' })).toHaveAttribute('aria-checked', 'true');
    await expect(tile(page, 'align')).toHaveAttribute('aria-label', 'Align · Center');
    expect((await tableAt(page, 0)).rows[2][2].align).toBe('center');
    await align.getByRole('radio', { name: 'Align selected cells middle' }).click();
    await page.keyboard.press('Escape');
    await expect(align).toBeHidden();

    await tile(page, 'cell').click();
    const cell = page.getByRole('dialog', { name: 'Cell fill and rules' });
    await expect(cell.getByRole('radio', { name: 'None', exact: true }).first()).toHaveAttribute('aria-checked', 'true');
    await cell.getByRole('radio', { name: 'Yellow' }).click();
    await cell.getByRole('radio', { name: 'Heavy' }).click();
    const t = await tableAt(page, 0);
    expect(t.rows[2][2].fill).toBe('yellow');
    expect(t.rules[2]).toBe('heavy');
    await expect(cell.getByRole('radio', { name: 'Yellow' })).toHaveAttribute('aria-checked', 'true');
    // Merging is the actions pill's, and waits for a selection across cells.
    await expect(cell.getByRole('menuitem')).toHaveCount(0);
    await expect(action(page, 'merge')).toHaveAttribute('aria-label', 'Merge cells');
    await expect(action(page, 'merge')).toBeDisabled();
  });

  test('grid rows and columns are added and deleted at the caret', async ({ page }) => {
    await openSheet(page);
    const before = await gridAt(page, 0);
    await caretIn(page, { grid: 0, cell: 1 });
    // Column left: the Add column tile's flyout, shown on hover.
    await tile(page, 'addcol').hover();
    await tile(page, 'addcolleft').click();
    let g = await gridAt(page, 0);
    expect(g.columns).toHaveLength(4);
    expect(g.rows[0][1]).toBe('');
    expect(g.rows[0][2]).toBe(before.rows[0][1]);
    expect(await caretCellText(page)).toBe('');
    await action(page, 'delcol').click();
    g = await gridAt(page, 0);
    expect(g.rows).toEqual(before.rows);
    expect(g.columns).toEqual(before.columns);

    await caretIn(page, { grid: 0, cell: 2 });
    await tile(page, 'addrow').hover();
    await tile(page, 'addrowabove').click();
    g = await gridAt(page, 0);
    expect(g.rows).toHaveLength(before.rows.length + 1);
    expect(g.rows[0].join('')).toBe('');
    expect(g.rows.slice(1)).toEqual(before.rows);
    await action(page, 'delrow').click();
    expect((await gridAt(page, 0)).rows).toEqual(before.rows);
  });

  test('a table in a grid cell owns the pill and reaches its grid', async ({ page }) => {
    await openSheet(page);
    const nested = await page.evaluate(() => [...document.querySelectorAll('.ProseMirror table')].findIndex((t) => t.closest('.ts-grid')));
    await caretIn(page, { table: nested + 1, row: 2, col: 1 });
    await expect(page.locator('.block-pill .tb-btn')).toHaveCount(8);
    await expect(tile(page, 'gridparent')).toBeVisible();
    const gi = await page.evaluate(() => [...document.querySelectorAll('.ProseMirror .ts-grid')].findIndex((g) => g.querySelector('table')));
    const rowsBefore = (await gridAt(page, gi)).rows.length;
    await tile(page, 'gridparent').click();
    const menu = page.getByRole('menu', { name: 'Grid' });
    await menu.getByRole('menuitem', { name: 'Grid rows' }).click();
    const sub = page.getByRole('menu', { name: 'Grid rows' });
    await expect(sub).toBeVisible();
    await sub.getByRole('menuitem', { name: 'Add row below' }).click();
    expect((await gridAt(page, gi)).rows.length).toBe(rowsBefore + 1);
  });

  test('the Image tile puts a plain, full-width image in the caret cell', async ({ page }) => {
    await openSheet(page);
    // The project's own picker, answered with the folder's box.
    await page.evaluate(() => {
      (window as unknown as { showOpenFilePicker: () => Promise<FileSystemFileHandle[]> }).showOpenFilePicker = async () => {
        const root = await navigator.storage.getDirectory();
        return [await (await root.getDirectoryHandle('i')).getFileHandle('box.svg')];
      };
    });
    // Part 2's first spacer cell: empty.
    await caretIn(page, { grid: 1, cell: 0 });
    await tile(page, 'image').click();
    await expect.poll(() => page.evaluate(() => {
      const sel = window.view.state.selection as unknown as { node?: { type: { name: string }; attrs: Record<string, unknown> } };
      return sel.node ? { type: sel.node.type.name, src: sel.node.attrs.src, width: sel.node.attrs.widthPct } : null;
    })).toEqual({ type: 'image', src: 'i/box.svg', width: 100 });
    const cell = await page.evaluate(() => {
      const $f = window.view.state.selection.$from;
      for (let d = $f.depth; d > 0; d--) if ($f.node(d).type.name === 'grid_cell') return { blocks: $f.node(d).childCount, para: $f.node(d).firstChild!.type.name };
      return null;
    });
    expect(cell).toEqual({ blocks: 1, para: 'paragraph' });
    // Not a numbered figure.
    expect(await page.evaluate(() => {
      let figures = 0;
      window.view.state.doc.descendants((n) => { if (n.type.name === 'figure') figures++; });
      return figures;
    })).toBe(0);
  });

  test('a keystroke reads no pill geometry, writes no pill style, and dims it', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    await expect(pill(page)).toBeVisible();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => {
      const reads: string[] = [];
      let styles = 0;
      const mine = () => /block-chrome/.test(new Error().stack ?? '');
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        if (mine()) reads.push('getBoundingClientRect');
        return rect.call(this);
      };
      const patched: Array<[string, PropertyDescriptor]> = [];
      for (const name of ['offsetWidth', 'offsetHeight', 'offsetLeft', 'offsetTop']) {
        const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!;
        patched.push([name, d]);
        Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get() { if (mine()) reads.push(name); return d.get!.call(this); } });
      }
      const observer = new MutationObserver((records) => {
        for (const r of records) if (r.attributeName === 'style') styles++;
      });
      observer.observe(document.getElementById('block-chrome')!, { attributes: true, subtree: true });
      window.__pillProbe = {
        reads,
        get styles() { return styles; },
        stop() {
          observer.disconnect();
          Element.prototype.getBoundingClientRect = rect;
          for (const [name, d] of patched) Object.defineProperty(HTMLElement.prototype, name, d);
        },
      };
    });
    await page.keyboard.type('Zq');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const probe = await page.evaluate(() => {
      const p = window.__pillProbe!;
      const out = { reads: [...p.reads], styles: p.styles };
      p.stop();
      return out;
    });
    expect(probe.reads).toEqual([]);
    expect(probe.styles).toBe(0);
    await expect(pill(page)).toHaveClass(/is-dim/);
    // Another cell: awake again.
    await page.keyboard.press('Tab');
    await expect(pill(page)).not.toHaveClass(/is-dim/);
  });

  test('a narrow margin folds the tiles into one menu', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 700 });
    await openSheet(page);
    const rows = (await gridAt(page, 0)).rows.length;
    await caretIn(page, { grid: 0, cell: 0 });
    await expect(page.locator('.block-pill .tb-btn')).toHaveCount(1);
    await tile(page, 'more').click();
    const menu = page.getByRole('menu', { name: 'Grid controls' });
    await menu.getByRole('menuitem', { name: 'Rows' }).click();
    await page.getByRole('menu', { name: 'Rows' }).getByRole('menuitem', { name: 'Add row below' }).click();
    const after = (await gridAt(page, 0)).rows;
    expect(after).toHaveLength(rows + 1);
    expect(after[1].join('')).toBe('');
    // The one ⋯ tile serves both kinds: it names the block it is beside.
    await expect(tile(page, 'more')).toHaveAttribute('aria-label', 'Grid controls');
    await caretIn(page, { table: 0, row: 1, col: 1 });
    await expect(page.getByRole('toolbar', { name: 'Table controls' })).toBeVisible();
    // Collapsed, the ⋯ tile keeps to the paper's edge beside a centred table.
    await expect(pill(page)).not.toHaveClass(/is-hug/);
    const edge = await page.evaluate(() => document.querySelector('.block-pill')!.getBoundingClientRect().left - document.getElementById('paper')!.getBoundingClientRect().left);
    expect(Math.abs(edge - 4)).toBeLessThan(1);
    await expect(tile(page, 'more')).toHaveAttribute('aria-label', 'Table controls');
    await expect(tile(page, 'more').locator('.lbl')).toHaveText('Table controls');
  });

  test('the keyboard walks the pill, the actions pill and a panel, and hands the caret back', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    const before = await page.evaluate(() => window.view.state.selection.toJSON());
    await tile(page, 'addrow').focus();
    // Down into the tile's Row above flyout, shown while the focus is in
    // either, then on to Add column and back up into Row above.
    await page.keyboard.press('ArrowDown');
    await expect(tile(page, 'addrowabove')).toBeFocused();
    await expect(tile(page, 'addrowabove')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(tile(page, 'addcol')).toBeFocused();
    // Once its fade has hidden it again, Row above still takes the focus.
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowUp');
    await expect(tile(page, 'addrowabove')).toBeFocused();
    await expect(tile(page, 'addrowabove')).toBeVisible();
    // The walk goes on into the actions pill: End is its last tile the
    // caret's cell can take (Merge waits for a selection across cells).
    await page.keyboard.press('End');
    await expect(action(page, 'delcol')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(action(page, 'delrow')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(tile(page, 'table')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tile(page, 'addrow')).toBeFocused();
    // → opens a tile's panel with the focus in it; Escape gives it back.
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await expect(tile(page, 'align')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const align = page.getByRole('dialog', { name: /Align/ });
    await expect(align).toBeVisible();
    await expect(align.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(align).toBeHidden();
    await expect(tile(page, 'align')).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.view.hasFocus())).toBe(true);
    expect(await page.evaluate(() => window.view.state.selection.toJSON())).toEqual(before);
  });

  test('the pill rides down a tall table as the panel scrolls, and stops at its end', async ({ page }) => {
    await page.goto('/?new=1');
    await page.waitForFunction(() => !!window.view && !!window.__pagCount);
    await page.evaluate(() => {
      const { state } = window.view;
      const s = state.schema;
      const cell = (text: string) => s.nodes.table_cell.create(null, s.nodes.paragraph.create(null, s.text(text)));
      const rows = Array.from({ length: 60 }, (_, i) => s.nodes.table_row.create(null, [cell(`Row ${i + 1}`), cell(String(i))]));
      const table = s.nodes.table.create({ style: 'booktabs' }, rows);
      const tail = s.nodes.paragraph.create(null, s.text('After the table.'));
      window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [table, tail]).setMeta('addToHistory', false));
    });
    await settleLocal(page);
    await caretIn(page, { table: 0, row: 1, col: 0 });
    await expect(pill(page)).toBeVisible();
    const at = (scroll: number) => page.evaluate(async (y) => {
      const sc = document.getElementById('scroll')!;
      sc.scrollTop = y;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const p = document.querySelector('.block-pill')!.getBoundingClientRect();
      const t = document.querySelector('.ProseMirror table')!.getBoundingClientRect();
      return { pill: p.top - sc.getBoundingClientRect().top, tableBottom: t.bottom, pillBottom: p.bottom };
    }, scroll);
    const mid = await at(600);
    expect(Math.abs(mid.pill - 8)).toBeLessThan(1);
    const end = await page.evaluate(() => document.getElementById('scroll')!.scrollHeight);
    const last = await at(end);
    expect(last.pillBottom).toBeLessThanOrEqual(last.tableBottom + 1);
  });
});
