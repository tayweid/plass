import { expect, test, type Page } from 'playwright/test';
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
    },
    { text },
  );
  await settleLocal(page);
}

test('insert a grid from the toolbar, tab between cells, set the split from the bar', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(() => {
    const { state } = window.view;
    const p = state.schema.nodes.paragraph.create(null, state.schema.text('Before the grid.'));
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [p]));
  });
  await page.click('.ProseMirror p');
  await page.getByRole('button', { name: 'Extras', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Grid', exact: true }).click();
  await expect(page.locator('.ProseMirror .ts-grid')).toHaveCount(1);
  await expect(page.locator('.grid-toolbar')).toBeVisible();
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
  // The split: typed into the bar, applied as fr shares.
  const columns = page.locator('.grid-toolbar .grid-toolbar-field input').first();
  await columns.fill('2 : 1');
  await columns.press('Enter');
  await expect(page.locator('.ProseMirror .ts-grid')).toHaveAttribute('data-columns', '2 1');
  const style = await page.locator('.ProseMirror .ts-grid').getAttribute('style');
  expect(style).toContain('--grid-cols: 2fr 1fr');
  await page.click('.grid-toolbar button:has-text("+ Column")');
  await expect(page.locator('.ProseMirror .ts-grid')).toHaveAttribute('data-columns', '2 1 1');
  await expect(page.locator('.ProseMirror .ts-grid-row').first().locator('.ts-grid-cell')).toHaveCount(3);
  await page.click('.grid-toolbar button:has-text("− Row")');
  await expect(page.locator('.ProseMirror .ts-grid-row')).toHaveCount(1);
  const typ = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return docToTyp(window.view.state.doc);
  });
  expect(typ).toContain('#grid(\n  columns: (2fr, 1fr, 1fr),\n  gutter: 1em,\n  [\n    Left cell again\n  ],\n  [\n    Right cell\n  ],\n  [],\n)');
  expect(typ).toContain('#set grid.cell(breakable: false)');
  // Unwrap puts the blocks back in the flow.
  await page.click('.grid-toolbar button:has-text("Unwrap")');
  await expect(page.locator('.ProseMirror .ts-grid')).toHaveCount(0);
  const texts = await page.locator('.ProseMirror p').allTextContents();
  expect(texts.slice(0, 3)).toEqual(['Before the grid.', 'Left cell again', 'Right cell']);
});

test('adding a row focuses it and its cells accept figures and caption-following text', async ({ page }) => {
  await openTyp(page, HEAD('paper: "us-letter", margin: 1.25in') + '#grid(columns: (1fr, 1fr), [First row], [])');
  const grid = page.locator('.ProseMirror .ts-grid');
  await grid.locator('.ts-grid-cell').first().locator('p').click();
  await page.getByRole('button', { name: '+ Row', exact: true }).click();
  const secondRow = grid.locator('.ts-grid-row').nth(1);
  await expect(secondRow.locator('.ts-grid-cell').first()).toHaveClass(/ts-grid-cell-active/);
  await expect(page.locator('.grid-toolbar-position')).toHaveText('Row 2 of 2 · Column 1 of 2');
  await settleLocal(page);
  const cues = await grid.evaluate((element) => {
    const cells = [...element.querySelectorAll<HTMLElement>('.ts-grid-cell')];
    const first = cells[0], active = cells[2];
    const firstBorder = getComputedStyle(first, '::after'), activeBorder = getComputedStyle(active, '::after');
    return {
      firstStyle: firstBorder.borderTopStyle,
      activeStyle: activeBorder.borderTopStyle,
      firstBottom: first.getBoundingClientRect().bottom - parseFloat(firstBorder.bottom),
      activeTop: active.getBoundingClientRect().top + parseFloat(activeBorder.top),
      placeholder: getComputedStyle(active, '::before').content,
    };
  });
  expect(cues.firstStyle).toBe('dashed');
  expect(cues.activeStyle).toBe('solid');
  expect(cues.firstBottom).toBeLessThanOrEqual(cues.activeTop);
  expect(cues.placeholder).toContain('Type here or insert a figure');
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
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Figure in cell', exact: true }).click();
  await (await chooser).setFiles({
    name: 'grid-figure.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#38786d"/></svg>'),
  });
  await expect(rightCell.locator('.ts-figure')).toHaveCount(1);
  await expect(rightCell).not.toHaveAttribute('data-grid-empty');
  await page.keyboard.type('A caption');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Below the figure');
  await expect(rightCell.locator('figcaption')).toContainText('A caption');
  await expect(rightCell.locator('p')).toHaveText('Below the figure');
  // Adding a column must retain the logical cell and its cursor, even
  // though earlier rows gain nodes and shift this cell's document position.
  await page.getByRole('button', { name: '+ Column', exact: true }).click();
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
  // Selecting the old image and choosing a replacement uses the existing
  // figure controls, preserving the rest of the cell's text.
  await rightCell.locator('.ts-inline-image img').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Figure in cell', exact: true }).click();
  await (await chooser).setFiles({ name: 'replacement.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg, 'base64') });
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
