import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Editing chrome on the paper (design: cell washes, rings, selection). All of
// it is paint: pseudo-elements, outlines and custom properties, never a laid
// out box's geometry. Driven through the app's own view (window.view).

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> };
  }
}

const HEAD =
  '#set page(paper: "us-letter", margin: 1.25in)\n#set par(justify: true, leading: 10.215pt, spacing: 21.465pt)\n#set text(font: "New Computer Modern", size: 12.5pt)\n\n';

async function openTyp(page: Page, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(async ({ text }) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('chrome.typ', { create: true });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
    await window.__fm.loadHandle(h);
  }, { text });
  await settleLocal(page);
}

/** A booktabs (or `style`) table of plain text cells, filling the document. */
async function installTable(page: Page, style: 'booktabs' | 'grid' | 'plain', fills: Record<string, string> = {}) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  await page.evaluate(({ style, fills }) => {
    const { state } = window.view;
    const s = state.schema;
    const cell = (text: string) => s.nodes.table_cell.create({ fill: fills[text] ?? '' }, s.nodes.paragraph.create(null, s.text(text)));
    const table = s.nodes.table.create({ style, caption: '', label: '' }, [
      s.nodes.table_row.create(null, [cell('A'), cell('B')]),
      s.nodes.table_row.create(null, [cell('C'), cell('D')]),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [s.nodes.paragraph.create(null, s.text('Before.')), table]));
  }, { style, fills });
  await settleLocal(page);
}

const caretIn = (page: Page, text: string) =>
  page.evaluate((text) => {
    const view = window.view;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === text) at = pos + node.nodeSize;
      return at < 0;
    });
    const C = Object.getPrototypeOf(view.state.selection).constructor;
    view.focus();
    view.dispatch(view.state.tr.setSelection(C.near(view.state.doc.resolve(at))));
  }, text);

test('a small gutter tiles the washes into one surface split by hairlines', async ({ page }) => {
  await openTyp(page, HEAD + '#grid(columns: (1fr, 1fr), gutter: 0em, [Top left], [Top right], [Bottom left], [Bottom right])');
  // (At gutter 0 a row's line box overlaps the next row's: place the caret.)
  await caretIn(page, 'Top left');
  const grid = page.locator('.ProseMirror .ts-grid');
  await expect(grid).toHaveClass(/ts-grid-joined/);
  const w = await grid.evaluate((element) => {
    const stack = document.getElementById('stack')!;
    const s = stack.getBoundingClientRect().width / stack.offsetWidth;
    return [...element.querySelectorAll<HTMLElement>('.ts-grid-cell')].map((cell) => {
      const a = getComputedStyle(cell, '::after');
      const r = cell.getBoundingClientRect();
      return { top: r.top + parseFloat(a.top) * s, bottom: r.bottom - parseFloat(a.bottom) * s, left: r.left + parseFloat(a.left) * s, right: r.right - parseFloat(a.right) * s };
    });
  });
  // Columns meet at the gutter midline, rows at the gap's midline.
  expect(Math.abs(w[0].right - w[1].left)).toBeLessThan(0.5);
  expect(Math.abs(w[0].bottom - w[2].top)).toBeLessThan(0.5);
  expect(Math.abs(w[1].bottom - w[3].top)).toBeLessThan(0.5);
});

test('an empty cell in a joined grid keeps the surface: its wash and dividers, no hole', async ({ page }) => {
  await openTyp(page, HEAD + '#grid(columns: (1fr, 1fr), gutter: 0.3em, [Top left], [], [Bottom left], [Bottom right])');
  await caretIn(page, 'Bottom left');
  const grid = page.locator('.ProseMirror .ts-grid');
  await expect(grid).toHaveClass(/ts-grid-joined/);
  const cells = grid.locator('.ts-grid-cell');
  await expect(cells.nth(1)).toHaveAttribute('data-grid-empty', 'true');
  await page.waitForTimeout(250); // past the washes' colour transition
  const paint = await grid.evaluate((element) => [...element.querySelectorAll<HTMLElement>('.ts-grid-cell')].map((cell) => {
    const a = getComputedStyle(cell, '::after');
    return { bg: a.backgroundColor, shadow: a.boxShadow };
  }));
  // The empty top-right cell paints as its full neighbour does: the same
  // wash, and the joined surface's seam under it (not the spacer's ring).
  expect(paint[1].bg).toBe(paint[0].bg);
  expect(paint[1].bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(paint[1].shadow).not.toMatch(/0px 0px 0px (?!0px)[\d.]+px inset/);
  expect(paint[1].shadow).toMatch(/0px -[\d.]+px 0px 0px inset/);
});

test('the table under the caret rings its cell; a cell selection draws one overlay, no native highlight', async ({ page }) => {
  await installTable(page, 'booktabs');
  await caretIn(page, 'D');
  const table = page.locator('.ProseMirror table');
  await expect(table).toHaveClass(/ts-table-editing/);
  const active = table.locator('td.ts-cell-active');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveText('D');
  expect(await active.evaluate((td) => getComputedStyle(td, '::before').boxShadow)).toMatch(/0px 0px 0px [\d.]+px inset/);
  // The edited table carries the paper scale, so its strokes stay one screen px.
  expect(Number(await table.evaluate((t) => (t as HTMLElement).style.getPropertyValue('--ps')))).toBeGreaterThan(0);
  // A cell selection: no active ring, the overlay at 14%, and the editor's
  // native selection painted transparent (prosemirror-view's hideselection).
  await page.evaluate(() => {
    const view = window.view;
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'table_cell') cells.push(pos);
      return true;
    });
    let C = view.state.selection.constructor;
    while (Object.getPrototypeOf(C) && Object.getPrototypeOf(C) !== Function.prototype) C = Object.getPrototypeOf(C);
    view.dispatch(view.state.tr.setSelection((C as unknown as { fromJSON: (d: unknown, j: unknown) => never }).fromJSON(view.state.doc, { type: 'cell', anchor: cells[2], head: cells[3] })));
  });
  await expect(table.locator('.selectedCell')).toHaveCount(2);
  await expect(table.locator('.ts-cell-active')).toHaveCount(0);
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toHaveClass(/ProseMirror-hideselection/);
  const paint = await table.locator('.selectedCell p').first().evaluate((p) => ({
    overlay: getComputedStyle(p.parentElement!, '::after').backgroundColor,
    native: getComputedStyle(p, '::selection').backgroundColor,
  }));
  expect(paint.overlay).toMatch(/\/ 0\.14\)$/);
  expect(paint.native).toBe('rgba(0, 0, 0, 0)');
  // Leaving the table clears its chrome.
  await caretIn(page, 'Before.');
  await expect(table).not.toHaveClass(/ts-table-editing/);
  await expect(table.locator('.ts-cell-active')).toHaveCount(0);
});

test('a fill reads true under the pointer, and a Plain table shows ghost edges only while edited', async ({ page }) => {
  await installTable(page, 'plain', { A: 'yellow' });
  const filled = page.locator('.ProseMirror td', { hasText: 'A' });
  const before = await filled.evaluate((td) => getComputedStyle(td).backgroundColor);
  await filled.hover();
  await page.waitForTimeout(150);
  expect(await filled.evaluate((td) => getComputedStyle(td).backgroundColor)).toBe(before);
  // Computed box-shadow lists the four slots in order: top, right, bottom, left.
  const slots = (text: string) => page.locator('.ProseMirror td', { hasText: text }).evaluate((td) => {
    const list = getComputedStyle(td).boxShadow;
    return { list: list === 'none' ? [] : list.split(/,(?![^(]*\))/).map((x) => x.trim()), table: getComputedStyle(td.closest('table')!).boxShadow, outline: getComputedStyle(td).outlineStyle };
  });
  // (The cell's shadow transitions: poll past it.)
  await caretIn(page, 'Before.');
  await expect.poll(() => slots('B')).toEqual({ list: [], table: 'none', outline: 'none' });
  await caretIn(page, 'D');
  await page.waitForTimeout(150);
  // Each cell draws its right and bottom edge, a row's first cell its left,
  // the first row its top (inset, so nothing is laid out and a shared edge is
  // drawn once). The table box draws nothing, so a fill on an edge cell (A)
  // keeps its outer edges: inset shadows paint over the cell's own fill.
  const none = /^rgba\(0, 0, 0, 0\) 0px 0px 0px 0px$/;
  const top = / 0px [\d.]+px 0px 0px inset$/, right = / -[\d.]+px 0px 0px 0px inset$/;
  const bottom = / 0px -[\d.]+px 0px 0px inset$/, left = / [\d.]+px 0px 0px 0px inset$/;
  const A = await slots('A'), B = await slots('B'), C = await slots('C'), D = await slots('D');
  for (const c of [A, B, C, D]) {
    expect(c.outline).toBe('none');
    expect(c.table).toBe('none');
    expect(c.list).toHaveLength(4);
    expect(c.list[1]).toMatch(right);
    expect(c.list[2]).toMatch(bottom);
  }
  expect(A.list[0]).toMatch(top);
  expect(A.list[3]).toMatch(left);
  expect(B.list[0]).toMatch(top);
  expect(B.list[3]).toMatch(none);
  expect(C.list[0]).toMatch(none);
  expect(C.list[3]).toMatch(left);
  expect(D.list[0]).toMatch(none);
  expect(D.list[3]).toMatch(none);
});

test('a Plain table keeps its ghost edges on rule rows, and a rowspan in column 0 leaves no doubled left edge', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const p = (t: string) => s.nodes.paragraph.create(null, s.text(t));
    const cell = (t: string, h = false, rowspan = 1) => (h ? s.nodes.table_header : s.nodes.table_cell).create({ rowspan }, p(t));
    const row = (rule: string, cells: ReturnType<typeof cell>[]) => s.nodes.table_row.create({ rule }, cells);
    const table = s.nodes.table.create({ style: 'plain', caption: '', label: '' }, [
      row('light', [cell('H1', true), cell('H2', true), cell('H3', true)]),
      row('', [cell('a1'), cell('a2'), cell('a3')]),
      row('heavy', [cell('b1'), cell('b2'), cell('b3')]),
      row('none', [cell('c1'), cell('c2'), cell('c3')]),
      row('', [cell('s1', false, 2), cell('d2'), cell('d3')]),
      row('', [cell('e2'), cell('e3')]),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [p('Before.'), table]));
  });
  await settleLocal(page);
  await caretIn(page, 'a2');
  await expect(page.locator('.ProseMirror table')).toHaveClass(/ts-table-editing/);
  await page.waitForTimeout(150);
  const slots = (text: string) => page.locator('.ProseMirror :is(td, th)', { hasText: new RegExp(`^${text}$`) }).evaluate((td) => {
    const list = getComputedStyle(td).boxShadow;
    return list === 'none' ? [] : list.split(/,(?![^(]*\))/).map((x) => x.trim());
  });
  const none = /^rgba\(0, 0, 0, 0\) 0px 0px 0px 0px$/;
  const top = / 0px [\d.]+px 0px 0px inset$/, right = / -[\d.]+px 0px 0px 0px inset$/;
  const bottom = / 0px -[\d.]+px 0px 0px inset$/, left = / [\d.]+px 0px 0px 0px inset$/;
  // A rule row swaps only its bottom slot for the printed rule (light, heavy)
  // or keeps the ghost under it (none); its right edges and the table's
  // outer top and left stay.
  const ruleBottom = (cells: string[][]) => cells.map((c) => c[2]);
  const H = [await slots('H1'), await slots('H2'), await slots('H3')];
  const B = [await slots('b1'), await slots('b2'), await slots('b3')];
  const C = [await slots('c1'), await slots('c2'), await slots('c3')];
  for (const c of [...H, ...B, ...C]) {
    expect(c).toHaveLength(4);
    expect(c[1]).toMatch(right);
    expect(c[2]).toMatch(bottom);
  }
  for (const c of H) expect(c[0]).toMatch(top);
  for (const [i, c] of [H, B, C].flatMap((r) => [...r.entries()])) expect(c[3]).toMatch(i === 0 ? left : none);
  // The rules print in ink, thicker for heavy; 'none' keeps the faint ghost.
  const width = (v: string) => -parseFloat(v.match(/ 0px (-[\d.]+)px 0px 0px inset$/)![1]);
  const hb = ruleBottom(H), bb = ruleBottom(B), cb = ruleBottom(C);
  expect(new Set(hb).size).toBe(1);
  expect(new Set(bb).size).toBe(1);
  expect(hb[0]).not.toBe(cb[0]);
  expect(bb[0]).not.toBe(hb[0]);
  expect(width(bb[0])).toBeGreaterThan(width(hb[0]));
  expect(cb[0]).toBe((await slots('a2'))[2]);
  // Under the rowspan, row e's first cell (e2) is in column 1: no left edge.
  expect((await slots('s1'))[3]).toMatch(left);
  expect((await slots('d2'))[3]).toMatch(none);
  expect((await slots('e2'))[3]).toMatch(none);
  expect((await slots('e2'))[1]).toMatch(right);
});

test('a Plain table crossing a page draws no ghost edge through the break; the repeated header gets its own', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const p = (t: string) => s.nodes.paragraph.create(null, s.text(t));
    const cell = (t: string, h = false) => (h ? s.nodes.table_header : s.nodes.table_cell).create(null, p(t));
    const rows = [
      s.nodes.table_row.create(null, [cell('Item', true), cell('Value', true)]),
      ...Array.from({ length: 70 }, (_, i) => s.nodes.table_row.create(null, [cell(`Row ${i + 1}`), cell(`v${i + 1}`)])),
    ];
    const table = s.nodes.table.create({ style: 'plain', caption: '', label: '' }, rows);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [p('Before.'), table]));
  });
  await settleLocal(page);
  const brk = page.locator('.ProseMirror tr.ts-table-break').first();
  await expect(brk).toHaveCount(1);
  await caretIn(page, 'v3');
  await expect(page.locator('.ProseMirror table')).toHaveClass(/ts-table-editing/);
  await page.waitForTimeout(150);
  const paint = await brk.evaluate((tr) => {
    const tds = [...tr.querySelectorAll(':scope > td')];
    const hdrs = tds.map((td) => getComputedStyle(td.querySelector('.ts-table-hdr')!).boxShadow);
    const next = tr.nextElementSibling!.firstElementChild!;
    return {
      td: tds.map((td) => getComputedStyle(td).boxShadow),
      gap: tds.map((td) => getComputedStyle(td.querySelector('.ts-table-gap')!).boxShadow),
      hdrs,
      next: getComputedStyle(next).boxShadow,
      table: getComputedStyle(tr.closest('table')!).boxShadow,
    };
  });
  expect(paint.td).toEqual(['none', 'none']);
  expect(paint.gap).toEqual(['none', 'none']);
  expect(paint.table).toBe('none');
  // The header copy: top and right, left on the first column, no bottom
  // (the next real row draws its top there).
  const split = (v: string) => v.split(/,(?![^(]*\))/).map((x) => x.trim());
  for (const [i, h] of paint.hdrs.entries()) {
    const [t, r, b, l] = split(h);
    expect(t).toMatch(/ 0px [\d.]+px 0px 0px inset$/);
    expect(r).toMatch(/ -[\d.]+px 0px 0px 0px inset$/);
    expect(b).toMatch(/^rgba\(0, 0, 0, 0\) 0px 0px 0px 0px$/);
    expect(l).toMatch(i === 0 ? / [\d.]+px 0px 0px 0px inset$/ : /^rgba\(0, 0, 0, 0\) 0px 0px 0px 0px$/);
  }
  expect(split(paint.next)[0]).toMatch(/ 0px [\d.]+px 0px 0px inset$/);
});

test('a block selection outlines the grid; a selected image in a grid cell rings itself, not the cell', async ({ page }) => {
  await openTyp(page, HEAD + 'Before.\n\n#grid(columns: (1fr, 1fr), gutter: 1em, [Left], [Right])');
  await page.evaluate(() => {
    const view = window.view;
    let at = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === 'grid') at = offset;
    });
    let C = view.state.selection.constructor;
    while (Object.getPrototypeOf(C) && Object.getPrototypeOf(C) !== Function.prototype) C = Object.getPrototypeOf(C);
    view.focus();
    view.dispatch(view.state.tr.setSelection((C as unknown as { fromJSON: (d: unknown, j: unknown) => never }).fromJSON(view.state.doc, { type: 'node', anchor: at })));
  });
  const block = page.locator('.ProseMirror .ts-grid');
  await expect(block).toHaveClass(/ProseMirror-selectednode/);
  expect(await block.evaluate((t) => getComputedStyle(t).outlineStyle)).toBe('solid');

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="250" height="165"><rect width="250" height="165" fill="none" stroke="#999"/></svg>').toString('base64');
  await openTyp(page, HEAD + `#grid(columns: (1fr, 1fr), gutter: 1em, [Questions], [#image("data:image/svg+xml;base64,${svg}")])`);
  const cell = page.locator('.ProseMirror .ts-grid-cell').nth(1);
  await cell.locator('.ts-inline-image img').click();
  await expect(cell.locator('.ts-inline-image')).toHaveClass(/ProseMirror-selectednode/);
  await expect(cell).toHaveClass(/ts-grid-cell-active/);
  const rings = await cell.evaluate((c) => ({
    image: getComputedStyle(c.querySelector('.ts-inline-image')!).outlineStyle,
    cell: getComputedStyle(c, '::after').boxShadow,
  }));
  expect(rings.image).toBe('solid');
  expect(rings.cell).not.toMatch(/0px 0px 0px [\d.]+px inset/);
  // The image's ink sets the wash: the wash encloses the image with air.
  const enclosed = await cell.evaluate((c) => {
    const stack = document.getElementById('stack')!;
    const s = stack.getBoundingClientRect().width / stack.offsetWidth;
    const a = getComputedStyle(c, '::after');
    const r = c.getBoundingClientRect();
    const img = c.querySelector('img')!.getBoundingClientRect();
    return { washTop: r.top + parseFloat(a.top) * s, washBottom: r.bottom - parseFloat(a.bottom) * s, imgTop: img.top, imgBottom: img.bottom };
  });
  expect(enclosed.washTop).toBeLessThan(enclosed.imgTop - 1);
  expect(enclosed.washBottom).toBeGreaterThan(enclosed.imgBottom + 1);
});

test('the chrome is the same in a dark OS appearance (the sheet is always white)', async ({ page }) => {
  await openTyp(page, HEAD + '#grid(columns: (1fr, 1fr), gutter: 1em, [Left cell], [])');
  await page.locator('.ProseMirror .ts-grid-cell p', { hasText: 'Left cell' }).click();
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; caret-color: transparent !important; }' });
  const grid = page.locator('.ProseMirror .ts-grid');
  const paint = () => grid.evaluate((g) => [...g.querySelectorAll('.ts-grid-cell')].map((c) => {
    const a = getComputedStyle(c, '::after');
    return [a.backgroundColor, a.boxShadow, getComputedStyle(c, '::before').color].join('|');
  }).join('\n'));
  await page.emulateMedia({ colorScheme: 'light' });
  const light = await paint();
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await paint()).toBe(light);
});
