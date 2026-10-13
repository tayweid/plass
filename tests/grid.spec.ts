import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// The grid rail: rows × fraction columns of any block content, rows
// atomic, the grid breaking between rows; cells normalized to the
// paragraph's frame so a table beside a paragraph aligns as Typst aligns
// them. The audit measures the page starts against Typst.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> };
    __pagLog: () => string[];
    __pagCount: () => number;
    __audit: () => Promise<{
      chrome: unknown[];
      pages: { agree: boolean; local: Array<{ pos: number; line: number; unit: string }>; typst: Array<{ pos: number; line: number; unit: string }> };
      summary: { chromeMismatch: number; pagesAgree: boolean; mismatch: number; typstFail: number };
      blocks: Array<{ pos: number; type: string; status: string; reason?: string }>;
    } | null>;
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';
const HEAD = (page: string) =>
  `#set page(${page})\n#set par(justify: true, leading: 10.215pt, spacing: 21.465pt)\n#set text(font: "New Computer Modern", size: 12.5pt)\n\n`;

async function openTyp(page: Page, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(
    async ({ text }) => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle('grid.typ', { create: true });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      await window.__fm.loadHandle(h);
      // Inserted images are imported into a project folder: OPFS here.
      window.showDirectoryPicker = async () => root;
    },
    { text },
  );
  await settleLocal(page);
}

/** A file chooser's change event carries no click, so importing into a
 *  folderless document asks for the folder from a toast. */
async function chooseFolderIfAsked(page: Page) {
  await page.locator('.toast-action', { hasText: 'Choose folder' }).click({ timeout: 1500 }).catch(() => {});
}

/** The block pill's tiles and the menus / panel they open (src/block-chrome.ts). */
const tile = (page: Page, id: string) => page.locator(`.block-pill [data-tile="${id}"]`);
async function menuItem(page: Page, tileId: 'rows' | 'cols', name: string) {
  await tile(page, tileId).click();
  await page.getByRole('menu', { name: tileId === 'rows' ? 'Rows' : 'Columns' }).getByRole('menuitem', { name, exact: true }).click();
}
async function gridLayout(page: Page) {
  await tile(page, 'grid').click();
  const panel = page.getByRole('dialog', { name: 'Grid layout' });
  await expect(panel).toBeVisible();
  return panel;
}

test('insert a grid from the toolbar, tab between cells, set the split from Grid layout', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(() => {
    const { state } = window.view;
    const p = state.schema.nodes.paragraph.create(null, state.schema.text('Before the grid.'));
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [p]));
  });
  await page.click('.ProseMirror p');
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Grid', exact: true }).click();
  await expect(page.locator('.ProseMirror .ts-grid')).toHaveCount(1);
  await expect(page.getByRole('toolbar', { name: 'Grid controls' })).toBeVisible();
  await page.keyboard.type('Left cell');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Right cell');
  const cells = page.locator('.ProseMirror .ts-grid-cell');
  await expect(cells).toHaveCount(2);
  await expect(cells.nth(0)).toHaveText('Left cell');
  await expect(cells.nth(1)).toHaveText('Right cell');
  // Shift-Tab goes back; Tab from the last cell adds a row.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type(' again');
  await expect(cells.nth(0)).toHaveText('Left cell again');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('.ProseMirror .ts-grid-row')).toHaveCount(2);
  // The split: typed into Grid layout's Custom field, applied as fr shares.
  const columns = (await gridLayout(page)).getByLabel('Custom split');
  await columns.fill('2 : 1');
  await columns.press('Enter');
  await columns.press('Escape');
  await expect(page.locator('.ProseMirror .ts-grid')).toHaveAttribute('data-columns', '2 1');
  const style = await page.locator('.ProseMirror .ts-grid').getAttribute('style');
  expect(style).toContain('--grid-cols: 2fr 1fr');
  // Columns and rows are added and deleted at the caret's.
  await cells.nth(1).click();
  await menuItem(page, 'cols', 'Add column after');
  await expect(page.locator('.ProseMirror .ts-grid')).toHaveAttribute('data-columns', '2 1 1');
  await expect(page.locator('.ProseMirror .ts-grid-row').first().locator('.ts-grid-cell')).toHaveCount(3);
  await page.locator('.ProseMirror .ts-grid-row').nth(1).locator('.ts-grid-cell').first().click();
  await menuItem(page, 'rows', 'Delete selected row');
  await expect(page.locator('.ProseMirror .ts-grid-row')).toHaveCount(1);
  const typ = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return docToTyp(window.view.state.doc);
  });
  expect(typ).toContain('#grid(\n  columns: (2fr, 1fr, 1fr),\n  gutter: 1em,\n  [\n    Left cell again\n  ],\n  [\n    Right cell\n  ],\n  [],\n)');
  expect(typ).toContain('#set grid.cell(breakable: false)');
  // Unwrap puts the blocks back in the flow.
  await (await gridLayout(page)).getByRole('button', { name: 'Unwrap grid' }).click();
  await expect(page.locator('.ProseMirror .ts-grid')).toHaveCount(0);
  const texts = await page.locator('.ProseMirror p').allTextContents();
  expect(texts.slice(0, 3)).toEqual(['Before the grid.', 'Left cell again', 'Right cell']);
});

test('adding a row focuses it and its cells accept figures and caption-following text', async ({ page }) => {
  // gutter: 1em keeps the grid apart (the default gutter joins it), so the
  // empty-cell check below sees separate washes and the hairline-only look.
  await openTyp(page, HEAD('paper: "us-letter", margin: 1.25in') + '#grid(columns: (1fr, 1fr), gutter: 1em, [First row], [])');
  const grid = page.locator('.ProseMirror .ts-grid');
  await grid.locator('.ts-grid-cell').first().locator('p').click();
  await menuItem(page, 'rows', 'Add row below');
  const secondRow = grid.locator('.ts-grid-row').nth(1);
  await expect(secondRow.locator('.ts-grid-cell').first()).toHaveClass(/ts-grid-cell-active/);
  await expect(page.locator('.grid-toolbar-position')).toHaveText('Row 2 of 2 · Column 1 of 2');
  await settleLocal(page);
  // Editing chrome (paint only): every cell washes as tall as its row's
  // ink with air round it; the active cell adds an accent ring; an empty
  // cell that is not active shows only a faint hairline; the placeholder
  // is in the active empty cell alone.
  const cues = await grid.evaluate((element) => {
    const stack = document.getElementById('stack')!;
    const s = stack.getBoundingClientRect().width / stack.offsetWidth;
    const cells = [...element.querySelectorAll<HTMLElement>('.ts-grid-cell')];
    const wash = (cell: HTMLElement) => {
      const a = getComputedStyle(cell, '::after');
      const r = cell.getBoundingClientRect();
      return { top: r.top + parseFloat(a.top) * s, bottom: r.bottom - parseFloat(a.bottom) * s, bg: a.backgroundColor, shadow: a.boxShadow, border: a.borderTopStyle };
    };
    // The text's real ink, from the font's glyph bounds on Chrome's own line box.
    const ink = (cell: HTMLElement) => {
      const p = cell.querySelector('p')!;
      const cs = getComputedStyle(p);
      const cv = document.createElement('canvas').getContext('2d')!;
      cv.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = cv.measureText(p.textContent!);
      const range = document.createRange();
      range.selectNodeContents(p);
      const line = range.getClientRects()[0];
      return { top: line.top + (m.fontBoundingBoxAscent - m.actualBoundingBoxAscent) * s, bottom: line.top + (m.fontBoundingBoxAscent + m.actualBoundingBoxDescent) * s };
    };
    return {
      first: wash(cells[0]),
      second: wash(cells[1]),
      active: wash(cells[2]),
      spacer: wash(cells[3]),
      firstInk: ink(cells[0]),
      placeholder: getComputedStyle(cells[2], '::before').content,
      spacerPlaceholder: getComputedStyle(cells[3], '::before').content,
    };
  });
  const transparent = 'rgba(0, 0, 0, 0)';
  expect(cues.first.border).toBe('none');
  expect(cues.first.bg).not.toBe(transparent);
  expect(cues.first.shadow).not.toMatch(/0px 0px 0px [\d.]+px inset/);
  expect(cues.active.bg).not.toBe(transparent);
  expect(cues.active.bg).not.toBe(cues.first.bg);
  expect(cues.active.shadow).toMatch(/0px 0px 0px [\d.]+px inset/);
  expect(cues.spacer.bg).toBe(transparent);
  expect(cues.spacer.shadow).toMatch(/0px 0px 0px [\d.]+px inset/);
  // The wash holds the ink: air above the cap and below the descenders.
  expect(cues.first.top).toBeLessThan(cues.firstInk.top - 1);
  expect(cues.first.bottom).toBeGreaterThan(cues.firstInk.bottom + 1);
  // A row's washes end level; rows never overlap.
  expect(Math.abs(cues.first.top - cues.second.top)).toBeLessThan(0.5);
  expect(Math.abs(cues.first.bottom - cues.second.bottom)).toBeLessThan(0.5);
  expect(Math.abs(cues.active.bottom - cues.spacer.bottom)).toBeLessThan(0.5);
  expect(cues.first.bottom).toBeLessThanOrEqual(cues.active.top + 0.01);
  expect(cues.placeholder).toContain('Type, or add an image');
  expect(cues.spacerPlaceholder).toBe('none');
  await page.emulateMedia({ media: 'print' });
  expect(await secondRow.locator('.ts-grid-cell').first().evaluate((cell) => ['::before', '::after'].map((pseudo) => getComputedStyle(cell, pseudo).display))).toEqual(['none', 'none']);
  await page.emulateMedia({ media: 'screen' });
  await page.keyboard.type('Second row');
  await expect(secondRow.locator('.ts-grid-cell').first()).toHaveText('Second row');
  await expect(grid.locator('.ts-grid-row').first()).toHaveText('First row');
  await page.keyboard.press('Tab');
  const rightCell = secondRow.locator('.ts-grid-cell').nth(1);
  await expect(page.locator('.grid-toolbar-position')).toHaveText('Row 2 of 2 · Column 2 of 2');
  await expect(rightCell).toHaveAttribute('data-grid-empty', 'true');
  // A numbered figure comes from Insert (the pill's Image tile puts a
  // plain image in the cell).
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert figure', exact: true }).click();
  await (await chooser).setFiles({
    name: 'grid-figure.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#38786d"/></svg>'),
  });
  await chooseFolderIfAsked(page);
  await expect(rightCell.locator('.ts-figure')).toHaveCount(1);
  await expect(rightCell).not.toHaveAttribute('data-grid-empty');
  await page.keyboard.type('A caption');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Below the figure');
  await expect(rightCell.locator('figcaption')).toContainText('A caption');
  await expect(rightCell.locator('p')).toHaveText('Below the figure');
  // Adding a column at the caret moves the caret into it; the cells keep
  // their content and logical places, though earlier rows gain nodes and
  // shift this cell's document position.
  await menuItem(page, 'cols', 'Add column after');
  await expect(page.locator('.grid-toolbar-position')).toHaveText('Row 2 of 2 · Column 3 of 3');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.grid-toolbar-position')).toHaveText('Row 2 of 2 · Column 2 of 3');
  await page.keyboard.type(' here');
  await expect(rightCell.locator('p')).toHaveText('Below the figure here');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.grid-toolbar-position')).toHaveText('Row 2 of 2 · Column 1 of 3');
  await page.keyboard.type(' edited');
  await expect(secondRow.locator('.ts-grid-cell').first()).toHaveText('Second row edited');
});

test('an imported inline image explains how to add text below it in the same grid cell', async ({ page }) => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="250" height="165"><path d="M18 8V147H242" fill="none" stroke="#999"/></svg>').toString('base64');
  await openTyp(page, HEAD('paper: "us-letter", margin: 1.25in') + `#grid(columns: (1.65fr, 1fr), gutter: 1em, [Questions], [#image("data:image/svg+xml;base64,${svg}")])`);
  const cells = page.locator('.ProseMirror .ts-grid-cell');
  const rightCell = cells.nth(1);
  await rightCell.locator('.ts-inline-image img').click();
  await expect(page.locator('.grid-toolbar-hint')).toContainText('Image selected · → then Enter adds text below');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Notes below the graph.');
  await expect(rightCell.locator('.ts-inline-image')).toHaveCount(1);
  await expect(rightCell.locator('p')).toHaveCount(2);
  await expect(rightCell.locator('p').last()).toHaveText('Notes below the graph.');
  await expect(cells.first()).toHaveText('Questions');
  // Selecting the old image and inserting a figure replaces it, preserving
  // the rest of the cell's text.
  await rightCell.locator('.ts-inline-image img').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert figure', exact: true }).click();
  await (await chooser).setFiles({ name: 'replacement.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg, 'base64') });
  await chooseFolderIfAsked(page);
  await expect(rightCell.locator('.ts-figure')).toHaveCount(1);
  await expect(rightCell.locator('.ts-inline-image')).toHaveCount(0);
  await expect(rightCell.locator(':scope > *')).toHaveCount(2);
  await expect(rightCell.locator('p')).toHaveText('Notes below the graph.');
  await page.keyboard.type('New graph');
  await expect(rightCell.locator('figcaption')).toContainText('New graph');
  await expect(cells.first()).toHaveText('Questions');
});

test('cells align at their Typst frames, rows break between pages, and Typst agrees', async ({ page }) => {
  test.setTimeout(90_000);
  const text =
    HEAD('paper: "us-letter", margin: 1.25in') +
    '= Grids\n\n' +
    FILLER.repeat(3).trimEnd() +
    '\n\n#grid(\n  columns: (2fr, 1fr),\n  gutter: 1em,\n  [\n    ' +
    FILLER.repeat(2).trimEnd() +
    '\n  ],\n  [\n    #table(\n      columns: 2,\n      table.header([Item], [Value]),\n      [Alpha], [1],\n      [Beta], [2],\n    )\n  ],\n)\n\n' +
    Array.from({ length: 4 }, () => FILLER.repeat(4).trimEnd()).join('\n\n') +
    '\n\n#grid(\n  columns: (1fr, 1fr),\n  gutter: 1em,\n' +
    Array.from({ length: 6 }, (_, i) => '  [\n    ' + FILLER.repeat(2 + (i % 2)).trimEnd() + '\n  ],').join('\n') +
    '\n)\n\n' +
    Array.from({ length: 3 }, () => FILLER.repeat(4).trimEnd()).join('\n\n') +
    '\n';
  await openTyp(page, text);
  const grids = page.locator('.ProseMirror .ts-grid');
  await expect(grids).toHaveCount(2);
  // The table cell carries the paragraph's slack as margin, the paragraph
  // cell none; the table's top sits where the paragraph's cap top does.
  const geometry = await page.evaluate(async () => {
    const { pageTopAdjustEm } = await import('/src/typ-serializer.ts');
    const { getSettings } = await import('/src/settings.ts');
    const s = getSettings(window.view.state);
    const F = parseFloat(getComputedStyle(window.view.dom).fontSize);
    const row = document.querySelector('.ProseMirror .ts-grid-row')!;
    const [a, b] = [...row.querySelectorAll<HTMLElement>(':scope > .ts-grid-cell')];
    const p = a.querySelector('p')!.getBoundingClientRect();
    const t = b.querySelector('table')!.getBoundingClientRect();
    return { aTop: a.style.marginTop, bTop: b.style.marginTop, pTop: p.top, tableTop: t.top, slack: -pageTopAdjustEm(s, 'paragraph') * F };
  });
  // The paragraph cell keeps its line box (no margin); the table cell's
  // margin takes the table's block margin back so the table's top rule
  // sits at the paragraph's cap top — where Typst aligns the two frames.
  expect(parseFloat(geometry.aTop)).toBeCloseTo(0, 1);
  expect(parseFloat(geometry.bTop)).toBeLessThan(0);
  expect(geometry.tableTop - geometry.pTop).toBeCloseTo(geometry.slack, 0);
  // The tall grid breaks between rows: at least one page starts at a row.
  const starts = await page.evaluate(() => window.__pagLog().at(-1));
  expect(starts).toContain('local[');
  const report = await page.evaluate(() => window.__audit());
  expect(report).not.toBeNull();
  const rowStarts = report!.pages.local.filter((s) => s.unit === 'block' || s.unit === 'grid_row');
  expect(report!.pages.typst.some((s) => s.unit === 'grid_row'), 'Typst starts a page at a grid row: ' + JSON.stringify(report!.pages)).toBe(true);
  expect(rowStarts.length).toBeGreaterThan(0);
  expect(report!.summary.pagesAgree, JSON.stringify(report!.pages)).toBe(true);
  expect(report!.summary.mismatch).toBe(0);
  expect(report!.summary.typstFail, JSON.stringify(report!.blocks.filter((b) => b.status === 'typst-fail'))).toBe(0);
});
