import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// The block pill's settings panels (src/block-chrome.ts, spec §5): Table
// settings (style, text size, padding, header row, the caret's column,
// columns, caption, label, delete) and
// Grid layout (split presets + Custom, gutter presets + Custom, unwrap); the
// on-page caption as the way into Table settings; refusals in the app toast.

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


const tile = (page: Page, id: string) => page.locator(`.block-pill [data-tile="${id}"]`);
const settings = (page: Page) => page.getByRole('dialog', { name: 'Table settings' });
const layout = (page: Page) => page.getByRole('dialog', { name: 'Grid layout' });
/** The attrs of the nth table / grid in document order (DOM order). */
const attrsOf = (page: Page, selector: string, index: number) => page.evaluate(({ selector, index }) => {
  const el = document.querySelectorAll(selector)[index];
  if (!el) return null;
  const view = window.view;
  const $p = view.state.doc.resolve(view.posAtDOM(el.querySelector('td, th, .ts-grid-cell')!, 0));
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.type.name === 'table' || n.type.name === 'grid') return n.attrs as Record<string, unknown>;
  }
  return null;
}, { selector, index });
const tableAttrs = (page: Page, i: number) => attrsOf(page, '.ProseMirror table', i);
const gridAttrs = (page: Page, i: number) => attrsOf(page, '.ProseMirror .ts-grid', i);

test.describe('the block panels', () => {
  test('Table settings shows and sets the table as presets', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    await tile(page, 'table').click();
    const panel = settings(page);
    await expect(panel).toBeVisible();
    // One geometry: 284 wide, the 60 px label column.
    expect(await panel.evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(284, 0);
    expect(await panel.locator('.bp-head').first().evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(60, 0);
    const style = panel.getByRole('radiogroup', { name: 'Table rule style' });
    await expect(style.getByRole('radio', { name: 'Booktabs' })).toHaveAttribute('aria-checked', 'true');
    await style.getByRole('radio', { name: 'Grid' }).click();
    expect((await tableAttrs(page, 0))!.style).toBe('grid');
    await expect(style.getByRole('radio', { name: 'Grid' })).toHaveAttribute('aria-checked', 'true');
    // The click hands the caret back and the panel stays open.
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => window.view.hasFocus())).toBe(true);

    const size = panel.getByRole('radiogroup', { name: 'Table text size' });
    await expect(size.locator('[data-value=""]')).toHaveAttribute('aria-checked', 'true');
    await size.locator('[data-value="0.85em"]').click();
    expect((await tableAttrs(page, 0))!.fontSize).toBe('0.85em');

    const density = panel.getByRole('radiogroup', { name: 'Table cell density' });
    await expect(density.locator('[data-value=""]')).toHaveAttribute('aria-checked', 'true');
    const pad = panel.getByLabel('Cell padding in points');
    await expect(pad).toHaveValue('');
    await expect(pad).toHaveAttribute('placeholder', '5');
    await density.locator('[data-value="compact"]').click();
    expect((await tableAttrs(page, 0))!.density).toBe('compact');
    await expect(pad).toHaveAttribute('placeholder', '3');
    // Custom pt: Enter applies, keeps the focus, and the field reads as in force.
    await pad.fill('6.5');
    await pad.press('Enter');
    expect((await tableAttrs(page, 0))!.insetPt).toBe(6.5);
    await expect(pad).toBeFocused();
    await expect(pad.locator('xpath=..')).toHaveClass(/checked/);
    await expect(density.locator('[aria-checked="true"]')).toHaveCount(0);
    // A density again clears it.
    await density.locator('[data-value="roomy"]').click();
    expect(await tableAttrs(page, 0)).toMatchObject({ density: 'roomy', insetPt: null });
    await expect(pad.locator('xpath=..')).not.toHaveClass(/checked/);

    // Columns: automatic, and the way back from custom widths.
    await expect(panel.getByText('Automatic widths')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reset to automatic' })).toBeHidden();
    await page.evaluate(() => {
      const view = window.view;
      const el = document.querySelectorAll('.ProseMirror table')[0];
      const $p = view.state.doc.resolve(view.posAtDOM(el.querySelector('td')!, 0));
      let d = $p.depth;
      while ($p.node(d).type.name !== 'table') d--;
      view.dispatch(view.state.tr.setNodeMarkup($p.before(d), undefined, { ...$p.node(d).attrs, columnWidths: ['auto', '1fr', 'auto', 'auto'] }));
    });
    await expect(panel.getByText('Custom widths')).toBeVisible();
    await panel.getByRole('button', { name: 'Reset to automatic' }).click();
    expect((await tableAttrs(page, 0))!.columnWidths).toBeNull();

    // Label: the document's own prefix as the example; normalized as typed.
    const label = panel.getByLabel('Label');
    await expect(label).toHaveAttribute('placeholder', 'tbl:results');
    await label.fill('tbl:station log');
    await expect(label).toHaveValue('tbl:station-log');
    await label.press('Enter');
    expect((await tableAttrs(page, 0))!.label).toBe('tbl:station-log');
  });

  test('Caption writes after a pause, not per keystroke, and never scrolls', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    await tile(page, 'table').click();
    const caption = settings(page).getByLabel('Caption');
    await expect(caption).toHaveValue('Each visit’s weather, time on site, and birds counted.');
    // Scroll the table's top off the panel: a per-keystroke scrollIntoView
    // would bring it back.
    await page.evaluate(() => { document.getElementById('scroll')!.scrollTop += 60; });
    const scrolled = await page.evaluate(() => document.getElementById('scroll')!.scrollTop);
    const docs = await page.evaluate(() => {
      (window as unknown as { __docs: number }).__docs = 0;
      const view = window.view;
      const dispatch = view.dispatch.bind(view);
      view.setProps({ dispatchTransaction: (tr) => { if (tr.docChanged) (window as unknown as { __docs: number }).__docs++; view.updateState(view.state.apply(tr)); } });
      void dispatch;
      return 0;
    });
    expect(docs).toBe(0);
    await caption.focus();
    await caption.press('End');
    await page.keyboard.type(' Two more.', { delay: 30 });
    // Typed within the pause: no document change yet.
    expect(await page.evaluate(() => (window as unknown as { __docs: number }).__docs)).toBe(0);
    await page.waitForTimeout(450);
    expect(await page.evaluate(() => (window as unknown as { __docs: number }).__docs)).toBe(1);
    expect((await tableAttrs(page, 0))!.caption).toBe('Each visit’s weather, time on site, and birds counted. Two more.');
    expect(await page.evaluate(() => document.getElementById('scroll')!.scrollTop)).toBe(scrolled);
    await expect(page.locator('.native-table-caption').first()).toContainText('Two more.');
    // ⌘Z in the field is the document's history, and the field follows.
    await caption.press('ControlOrMeta+z');
    await expect(caption).toHaveValue('Each visit’s weather, time on site, and birds counted.');
    // A write still pending when Escape returns to the page is not lost
    // (as when every keystroke was written), and the caret is back.
    await caption.press('End');
    await page.keyboard.type(' Kept');
    await page.keyboard.press('Escape');
    await expect(settings(page)).toBeHidden();
    expect((await tableAttrs(page, 0))!.caption).toBe('Each visit’s weather, time on site, and birds counted. Kept');
    expect(await page.evaluate(() => window.view.hasFocus())).toBe(true);
    // Nor when a click elsewhere closes the panel.
    await tile(page, 'table').click();
    await settings(page).getByLabel('Caption').focus();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.locator('.ProseMirror h1').first().click();
    await expect(settings(page)).toBeHidden();
    await expect.poll(async () => (await tableAttrs(page, 0))!.caption).toBe('Each visit’s weather, time on site, and birds counted. Kept!');
  });

  test('a click on the on-page caption opens Table settings with Caption focused', async ({ page }) => {
    await openSheet(page);
    // The caret elsewhere, in the prose.
    await page.evaluate(() => {
      const view = window.view;
      view.focus();
      let S = view.state.selection.constructor as { fromJSON?: (doc: unknown, json: unknown) => unknown };
      while (Object.getPrototypeOf(S) && Object.getPrototypeOf(S) !== Function.prototype) S = Object.getPrototypeOf(S);
      view.dispatch(view.state.tr.setSelection(S.fromJSON!(view.state.doc, { type: 'text', anchor: 3, head: 3 }) as never));
    });
    const caption = page.locator('.native-table-caption').first();
    await expect(caption).toHaveCSS('cursor', 'pointer');
    const docBefore = await page.evaluate(() => window.view.state.doc.toJSON());
    await caption.click();
    await expect(settings(page)).toBeVisible();
    await expect(settings(page).getByLabel('Caption')).toBeFocused();
    // The caret is in that table now; nothing in the document changed.
    expect(await page.evaluate(() => {
      const $h = window.view.state.selection.$head;
      for (let d = $h.depth; d > 0; d--) if ($h.node(d).type.name === 'table') return $h.node(d).textContent.includes('Overcast');
      return false;
    })).toBe(true);
    expect(await page.evaluate(() => window.view.state.doc.toJSON())).toEqual(docBefore);
  });

  test('Delete table is at the foot and undoable; the advanced note shows only for file styling', async ({ page }) => {
    await openSheet(page);
    const tables = await page.locator('.ProseMirror table').count();
    await caretIn(page, { table: 0, row: 1, col: 0 });
    await tile(page, 'table').click();
    await expect(settings(page).locator('.native-table-advanced')).toBeHidden();
    await settings(page).getByRole('button', { name: 'Delete table' }).click();
    await expect(page.locator('.ProseMirror table')).toHaveCount(tables - 1);
    await expect(settings(page)).toBeHidden();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.ProseMirror table')).toHaveCount(tables);
    // A table with styling Plass does not show: said, and padding is locked.
    await caretIn(page, { table: 0, row: 1, col: 0 });
    await page.evaluate(() => {
      const view = window.view;
      const $h = view.state.selection.$head;
      let d = $h.depth;
      while ($h.node(d).type.name !== 'table') d--;
      view.dispatch(view.state.tr.setNodeMarkup($h.before(d), undefined, { ...$h.node(d).attrs, params: 'inset: 4pt, stroke: blue' }));
    });
    await tile(page, 'table').click();
    await expect(settings(page).locator('.native-table-advanced')).toContainText('not shown here');
    await expect(settings(page).getByLabel('Cell padding in points')).toBeDisabled();
    await expect(settings(page).getByText('Set by custom styling in the file')).toBeVisible();
  });

  test('Grid layout: split presets for the column count, a Custom field as written, gutter presets', async ({ page }) => {
    await openSheet(page);
    // Part 2: five columns, 1 : 4 : 1 : 4 : 1, gutter 1.2em.
    await caretIn(page, { grid: 1, cell: 1 });
    await tile(page, 'grid').click();
    let panel = layout(page);
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(284, 0);
    const split = panel.getByRole('radiogroup', { name: 'Column split' });
    await expect(split.getByRole('radio')).toHaveCount(2);
    await expect(split.getByRole('radio', { name: 'Split 1 : 1 : 1 : 1 : 1' })).toHaveAttribute('aria-checked', 'false');
    await expect(split.getByRole('radio', { name: 'Split 1 : 4 : 1 : 4 : 1' })).toHaveAttribute('aria-checked', 'true');
    await expect(panel.getByLabel('Custom split')).toHaveValue('1 : 4 : 1 : 4 : 1');
    const gutter = panel.getByRole('radiogroup', { name: 'Space between cells' });
    await expect(gutter.locator('[aria-checked="true"]')).toHaveCount(0);
    await expect(panel.getByLabel('Gutter in em')).toHaveValue('1.2');
    await expect(panel.getByLabel('Gutter in em').locator('xpath=..')).toHaveClass(/checked/);
    await gutter.getByRole('radio', { name: 'Normal' }).click();
    expect((await gridAttrs(page, 1))!.gutter).toBe(1);
    await expect(panel.getByLabel('Gutter in em')).toHaveValue('');
    await expect(panel.getByLabel('Gutter in em')).toHaveAttribute('placeholder', '1');
    await panel.getByLabel('Gutter in em').fill('0.75');
    await panel.getByLabel('Gutter in em').press('Enter');
    expect((await gridAttrs(page, 1))!.gutter).toBe(0.75);
    await expect(panel.getByLabel('Gutter in em')).toBeFocused();
    await panel.getByLabel('Gutter in em').press('Escape');
    await expect(panel).toBeHidden();

    // Part 1: three columns, four presets; a preset never changes the count.
    await caretIn(page, { grid: 0, cell: 1 });
    await tile(page, 'grid').click();
    panel = layout(page);
    await expect(panel.getByRole('radiogroup', { name: 'Column split' }).getByRole('radio')).toHaveCount(4);
    await panel.getByRole('radio', { name: 'Split 1 : 2 : 1' }).click();
    expect((await gridAttrs(page, 0))!.columns).toEqual([1, 2, 1]);
    await expect(panel.getByRole('radio', { name: 'Split 1 : 2 : 1' })).toHaveAttribute('aria-checked', 'true');
    const custom = panel.getByLabel('Custom split');
    await expect(custom).toHaveValue('1 : 2 : 1');
    // Percents are accepted; the field shows the split as it reads.
    await custom.fill('50% 25% 25%');
    await custom.press('Enter');
    expect((await gridAttrs(page, 0))!.columns).toEqual([2, 1, 1]);
    await expect(custom).toHaveValue('2 : 1 : 1');
    await custom.fill('nonsense');
    await custom.press('Enter');
    await expect(custom).toHaveValue('2 : 1 : 1');
    expect((await gridAttrs(page, 0))!.columns).toEqual([2, 1, 1]);
    await custom.press('Escape');

    // The data sheet's split is no ratio: shown as percents, its own tile.
    await caretIn(page, { grid: 2, cell: 0 });
    await tile(page, 'grid').click();
    await expect(layout(page).getByLabel('Custom split')).toHaveValue('29% : 39% : 32%');
    await expect(layout(page).getByRole('radio', { name: 'Split 29% : 39% : 32%' })).toHaveAttribute('aria-checked', 'true');
  });

  test('the panels are dialogs: Tab walks their controls, fields included', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 2, col: 1 });
    // Opened from the keyboard: the focus on the first control.
    await tile(page, 'table').focus();
    await page.keyboard.press('Enter');
    const panel = settings(page);
    await expect(panel.getByRole('radio', { name: 'Booktabs' })).toBeFocused();
    // One stop per choice group, then the fields, then the foot.
    const focusedName = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return el.getAttribute('aria-label') ?? el.closest('[role="radiogroup"]')?.getAttribute('aria-label') ?? el.textContent;
    });
    // (The column's amount field is off while the column fits its content.)
    const order: Array<string | null> = [];
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Tab');
      order.push(await focusedName());
    }
    expect(order).toEqual(['Table text size', 'Table cell density', 'Cell padding in points', 'Header row', 'Selected column sizing', 'Caption', 'Label']);
    await page.keyboard.press('Shift+Tab');
    await expect(panel.getByLabel('Caption')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Keyed in');
    // Leaving the field writes it.
    await page.keyboard.press('Tab');
    await expect(panel.getByLabel('Label')).toBeFocused();
    expect((await tableAttrs(page, 0))!.caption).toBe('Keyed in');
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: 'Delete table' })).toBeFocused();
    // Past the last control: the page gets the caret.
    await page.keyboard.press('Tab');
    await expect(panel).toBeHidden();
    expect(await page.evaluate(() => window.view.hasFocus())).toBe(true);
    // Before the first: back to the tile.
    await tile(page, 'table').focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('radio', { name: 'Booktabs' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(panel).toBeHidden();
    await expect(tile(page, 'table')).toBeFocused();

    // Grid layout: the split's choices, then Custom split, then the gutter.
    await caretIn(page, { grid: 0, cell: 1 });
    await tile(page, 'grid').focus();
    await page.keyboard.press('Enter');
    const grid = layout(page);
    await expect(grid.getByRole('radiogroup', { name: 'Column split' }).locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Tab');
    const custom = grid.getByLabel('Custom split');
    await expect(custom).toBeFocused();
    // A split with another column count is refused, and said (Columns adds
    // and deletes columns; a dropped column would take its text).
    const before = (await gridAttrs(page, 0))!.columns;
    await custom.fill('1 : 1');
    await custom.press('Enter');
    expect((await gridAttrs(page, 0))!.columns).toEqual(before);
    await expect(page.locator('#toast')).toContainText('one per column');
    await page.keyboard.press('Tab');
    expect(await focusedName()).toBe('Space between cells');
    await page.keyboard.press('Tab');
    await expect(grid.getByLabel('Gutter in em')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(grid.getByRole('button', { name: 'Unwrap grid' })).toBeFocused();
  });

  test('Unwrap grid keeps the contents in reading order', async ({ page }) => {
    await openSheet(page);
    const grids = await page.locator('.ProseMirror .ts-grid').count();
    await caretIn(page, { grid: 0, cell: 0 });
    await tile(page, 'grid').click();
    await layout(page).getByRole('button', { name: 'Unwrap grid' }).click();
    await expect(page.locator('.ProseMirror .ts-grid')).toHaveCount(grids - 1);
    const text = await page.evaluate(() => window.view.state.doc.textContent);
    expect(text.indexOf('Do morning visits')).toBeLessThan(text.indexOf('Does a longer visit'));
  });

  test('a refused table edit is said in the app toast', async ({ page }) => {
    await openSheet(page);
    await caretIn(page, { table: 0, row: 1, col: 1 });
    const before = await page.evaluate(() => window.view.state.doc.toJSON());
    // A line break inside a cell's text has no lossless Typst cell form.
    await page.evaluate(() => {
      const view = window.view;
      view.dispatch(view.state.tr.insertText('two\nlines'));
    });
    expect(await page.evaluate(() => window.view.state.doc.toJSON())).toEqual(before);
    await expect(page.locator('#toast')).toContainText('Not applied');
    await expect(page.locator('#toast')).toHaveAttribute('role', 'status');
    await expect(page.locator('.native-table-notice')).toHaveCount(0);
  });
});
