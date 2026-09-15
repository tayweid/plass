import { expect, test, type Page } from 'playwright/test';
import { settleLocal } from './settle';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
    __pagCount: () => number;
    __suffixPaginationStats: (reset?: boolean) => {
      attempts: number;
      eligible: number;
      mismatches: number;
      bySource: { exact: { eligible: number }; fallback: { eligible: number } };
      lastAnchorPos: number | null;
      lastStartPos: number | null;
      reasons: Record<string, number>;
    };
    __audit: () => Promise<{ pages: { agree: boolean; typst: Array<{ unit: string; line: number }> } } | null>;
  }
}

// PAGE-PORT.md Phase 7: a native table crossing a page boundary breaks
// BETWEEN rows while staying one editable table node. The break is a widget
// row (`tr.ts-table-break`) between two real rows: an exact-height gap plus a
// non-editable copy of the repeating header at the top of the next page,
// exactly what Typst lays out (grid `layout_active_headers`).

interface TableOptions {
  rows: number;
  style?: 'booktabs' | 'grid';
  density?: '' | 'compact' | 'roomy';
  decoratedHeader?: boolean;
  /** Row index (0-based, content rows start at 1) whose first cell spans
   * two rows — a merged cell across the boundary below it. */
  rowspanAt?: number;
  caption?: string;
  /** Append a forced page break and two paragraphs after the table. */
  trailingPage?: boolean;
}

async function installDoc(page: Page, opts: TableOptions, navigate = true): Promise<number> {
  if (navigate) await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view && !!window.__pagLog);
  return page.evaluate((o) => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const cell = (text: string, attrs: Record<string, unknown> = {}) => s.nodes.table_cell.create(attrs, paragraph(text));
    const header = (text: string) => s.nodes.table_header.create(
      o.decoratedHeader ? { fill: 'blue', align: 'center' } : null,
      o.decoratedHeader ? [paragraph(text), paragraph('Continued')] : paragraph(text),
    );
    const tableRows = [
      s.nodes.table_row.create(null, [header('Item'), header('Value'), header('Note')]),
      ...Array.from({ length: o.rows - 1 }, (_, index) => {
        const row = index + 1;
        if (o.rowspanAt !== undefined && row === o.rowspanAt + 1) {
          // The row below a rowspan origin holds no cell in that column.
          return s.nodes.table_row.create(null, [cell(`${row}.5`), cell(`n${row}`)]);
        }
        const first = o.rowspanAt === row ? cell(`Alpha ${row}`, { rowspan: 2 }) : cell(`Alpha ${row}`);
        return s.nodes.table_row.create(null, [first, cell(`${row}.5`), cell(`n${row}`)]);
      }),
    ];
    const table = s.nodes.table.create(
      { style: o.style ?? 'booktabs', density: o.density ?? '', caption: o.caption ?? '', label: '', params: '', fontSize: '' },
      tableRows,
    );
    const doc = s.nodes.doc.create(state.doc.attrs, [
      s.nodes.heading.create({ level: 1 }, s.text('Table pagination')),
      paragraph('An introductory paragraph sits above the table.'),
      table,
      paragraph('A closing paragraph follows the table.'),
      ...(o.trailingPage
        ? [
            s.nodes.page_break.create(),
            paragraph('The first paragraph of the last page.'),
            paragraph('The second paragraph of the last page, which is edited.'),
          ]
        : []),
    ]);
    const logStart = window.__pagCount();
    window.view.dispatch(
      state.tr.replaceWith(0, state.doc.content.size, doc.content).setMeta('addToHistory', false),
    );
    return logStart;
  }, opts);
}

/** Wait until a pagination entry after `logStart` has the given prefix. */
async function expectPagination(page: Page, logStart: number, _prefix: 'local[' = 'local[') {
  await settleLocal(page, logStart);
}

function readBreak(page: Page) {
  return page.evaluate(() => {
    const doc = window.view.state.doc;
    let tables = 0;
    doc.descendants((node) => {
      if (node.type.name === 'table') tables++;
      return true;
    });
    const widget = document.querySelector<HTMLElement>('.ProseMirror table tr.ts-table-break');
    if (!widget) return { tables, widget: null };
    const prev = widget.previousElementSibling;
    const next = widget.nextElementSibling;
    const pageBoxes = [...document.querySelectorAll<HTMLElement>('.page-box')].map((el) => el.getBoundingClientRect());
    const hdr = widget.querySelector<HTMLElement>('.ts-table-hdr');
    const nextRect = next?.getBoundingClientRect();
    const hdrRect = hdr?.getBoundingClientRect();
    const marginTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-margin-top'));
    return {
      tables,
      widget: {
        prevIsRow: prev?.tagName === 'TR' && !prev.classList.contains('ts-table-break'),
        nextIsRow: next?.tagName === 'TR' && !next.classList.contains('ts-table-break'),
        prevText: prev?.querySelector('td, th')?.textContent ?? '',
        nextText: next?.querySelector('td, th')?.textContent ?? '',
        headerText: [...widget.querySelectorAll('.ts-table-hdr')].map((el) => el.textContent).join('|'),
        headerCells: widget.querySelectorAll('.ts-table-hdr').length,
        editable: widget.isContentEditable,
        // Where the header copy and the following row land, relative to
        // the second page's content top.
        hdrTopFromContent: hdrRect && pageBoxes[1] ? hdrRect.top - (pageBoxes[1].top + marginTop) : NaN,
        nextRowBelowHdr: nextRect && hdrRect ? nextRect.top - hdrRect.bottom : NaN,
        pages: pageBoxes.length,
      },
    };
  });
}

test('a 40-row table crossing a page boundary paginates exactly, breaking between rows with the header repeated', async ({ page }) => {
  test.setTimeout(90_000);
  const logStart = await installDoc(page, { rows: 40 });
  await expectPagination(page, logStart, 'local[');

  const result = await readBreak(page);
  expect(result.tables).toBe(1);
  expect(result.widget).not.toBeNull();
  const w = result.widget!;
  expect(w.pages).toBe(2);
  expect(w.prevIsRow && w.nextIsRow).toBe(true);
  expect(w.editable).toBe(false);
  // The rows around the break are consecutive content rows.
  const prevRow = /Alpha (\d+)/.exec(w.prevText);
  const nextRow = /Alpha (\d+)/.exec(w.nextText);
  expect(prevRow && nextRow && Number(nextRow[1]) === Number(prevRow[1]) + 1).toBe(true);
  // The repeated header copy: every header cell, non-editable, at the top
  // of page 2's content area with the next row directly below it.
  expect(w.headerCells).toBe(3);
  expect(w.headerText).toBe('Item|Value|Note');
  expect(Math.abs(w.hdrTopFromContent)).toBeLessThan(1.5);
  expect(Math.abs(w.nextRowBelowHdr)).toBeLessThan(1.5);

  // Presentation (Phase 7 step 3): the widget row paints the table's
  // closing rule at the page bottom, the opening rule and the header rule
  // on the new page — as pseudo-elements only — and its layout height is
  // exactly the spacer it stands for (gap + header copy).
  const paint = await page.evaluate(() => {
    const widget = document.querySelector<HTMLElement>('.ProseMirror table tr.ts-table-break')!;
    const td = widget.querySelector<HTMLElement>('td')!;
    const gap = widget.querySelector<HTMLElement>('.ts-table-gap')!;
    const hdr = widget.querySelector<HTMLElement>('.ts-table-hdr')!;
    const width = (el: Element, pseudo: string, side: 'borderTopWidth' | 'borderBottomWidth') =>
      parseFloat(getComputedStyle(el, pseudo)[side]);
    const requested = Number(/^pgr:\d+:(\d+):(\d+)(?::.*)?$/.exec(widget.dataset.tsGapKey ?? '')?.[1] ?? NaN);
    return {
      classes: [...widget.classList],
      closingRule: width(td, '::before', 'borderTopWidth'),
      openingRule: width(gap, '::after', 'borderBottomWidth'),
      headerRule: width(td, '::after', 'borderBottomWidth'),
      requested,
      painted: widget.getBoundingClientRect().height,
      gapPlusHeader: gap.getBoundingClientRect().height + hdr.getBoundingClientRect().height,
      cellPaddingBlock: [getComputedStyle(td).paddingTop, getComputedStyle(td).paddingBottom],
    };
  });
  expect(paint.classes).toEqual(expect.arrayContaining(['ts-pagegap', 'ts-table-break', 'ts-table-break-header', 'ts-table-break-midrule']));
  expect(paint.closingRule).toBeGreaterThan(0.5);
  expect(paint.openingRule).toBeGreaterThan(0.5);
  expect(paint.headerRule).toBeGreaterThan(0.5);
  expect(paint.cellPaddingBlock).toEqual(['0px', '0px']);
  expect(Math.abs(paint.painted - paint.requested)).toBeLessThan(1);
  expect(Math.abs(paint.painted - paint.gapPlusHeader)).toBeLessThan(1);

  // Typst breaks the same table at the same row boundary (port audit).
  const report = await page.evaluate(() => window.__audit());
  expect(report?.pages.typst.find((ps) => ps.unit === 'table')?.line ?? -1).toBe(Number(nextRow![1]));
  expect(report?.pages.agree, JSON.stringify(report?.pages)).toBe(true);
});

for (const density of ['compact', 'roomy'] as const) {
  test(`grid table page gaps have no cell strokes and repeat the ${density} header faithfully`, async ({ page }) => {
    const before = await installDoc(page, { rows: 60, style: 'grid', density, decoratedHeader: true });
    await settleLocal(page, before);
    const paint = await page.evaluate(() => {
      const table = document.querySelector('.ProseMirror table')!;
      const original = table.querySelector('th')!;
      const spacer = table.querySelector('.ts-table-break > td')!;
      const header = spacer.querySelector('.ts-table-hdr')!;
      const originalRect = original.getBoundingClientRect();
      const spacerRect = spacer.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const textOffset = (el: Element, selector = 'p') => {
        const r = el.querySelector(selector)!.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return { left: r.left - box.left, top: r.top - box.top };
      };
      return {
        spacerShadow: getComputedStyle(spacer).boxShadow,
        originalShadow: getComputedStyle(original).boxShadow,
        repeatedShadow: getComputedStyle(header).boxShadow,
        originalFill: getComputedStyle(original).backgroundColor,
        repeatedFill: getComputedStyle(header).backgroundColor,
        alignment: [getComputedStyle(original).textAlign, getComputedStyle(header).textAlign],
        widths: [originalRect.width, spacerRect.width, headerRect.width],
        heights: [originalRect.height, headerRect.height],
        originalText: textOffset(original),
        repeatedText: textOffset(header),
        originalLastText: textOffset(original, 'p:last-child'),
        repeatedLastText: textOffset(header, 'p:last-child'),
      };
    });
    expect(paint.spacerShadow).toBe('none');
    expect(paint.repeatedShadow).toBe(paint.originalShadow);
    expect(paint.repeatedFill).toBe(paint.originalFill);
    expect(paint.alignment).toEqual(['center', 'center']);
    expect(paint.widths[1]).toBeCloseTo(paint.widths[0], 1);
    expect(paint.widths[2]).toBeCloseTo(paint.widths[0], 1);
    expect(paint.heights[1]).toBeCloseTo(paint.heights[0], 1);
    expect(paint.repeatedText.left).toBeCloseTo(paint.originalText.left, 1);
    expect(paint.repeatedText.top).toBeCloseTo(paint.originalText.top, 1);
    expect(paint.repeatedLastText.top).toBeCloseTo(paint.originalLastText.top, 1);
  });
}

test('repeated headers update after fill and alignment edits that keep the same row height', async ({ page }) => {
  const before = await installDoc(page, { rows: 60, style: 'grid', decoratedHeader: true });
  await settleLocal(page, before);
  const repeated = page.locator('.ts-table-break .ts-table-hdr').first();
  await expect(repeated).toHaveAttribute('data-fill', 'blue');
  const heightBefore = await repeated.evaluate((el) => el.getBoundingClientRect().height);
  const changed = await page.evaluate(() => {
    const { state } = window.view;
    let headerPos = -1;
    state.doc.descendants((node, pos) => {
      if (headerPos < 0 && node.type.name === 'table_header') headerPos = pos;
    });
    const header = state.doc.nodeAt(headerPos)!;
    const count = window.__pagCount();
    window.view.dispatch(state.tr.setNodeMarkup(headerPos, undefined, { ...header.attrs, fill: 'yellow', align: 'right' }));
    return count;
  });
  await settleLocal(page, changed);
  await expect(repeated).toHaveAttribute('data-fill', 'yellow');
  expect(await repeated.evaluate((el) => getComputedStyle(el).textAlignLast)).toBe('right');
  expect(await repeated.evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(heightBefore, 1);
});

test('a merged cell across the boundary keeps the table atomic (fail open)', async ({ page }) => {
  test.setTimeout(120_000);
  // Learn where Typst breaks this document, then put a rowspan across
  // exactly that boundary.
  const first = await installDoc(page, { rows: 30 });
  await expectPagination(page, first, 'local[');
  const breakRow = await page.evaluate(() => {
    const next = document.querySelector('.ProseMirror table tr.ts-table-break')?.nextElementSibling;
    return Number(/Alpha (\d+)/.exec(next?.querySelector('td')?.textContent ?? '')?.[1] ?? -1);
  });
  expect(breakRow).toBeGreaterThan(1);

  const second = await installDoc(page, { rows: 30, rowspanAt: breakRow - 1 }, false);
  // The editor keeps the table one atomic block, with no widget row inside
  // it (Typst itself splits the rowspan — the audit below shows the
  // declared disagreement — which the editor does not mirror).
  await expectPagination(page, second, 'local[');
  const result = await readBreak(page);
  expect(result.tables).toBe(1);
  expect(result.widget).toBeNull();
  const geometry = await page.evaluate(() => {
    const table = document.querySelector<HTMLElement>('.ProseMirror table')!.getBoundingClientRect();
    const boxes = [...document.querySelectorAll<HTMLElement>('.page-box')].map((el) => el.getBoundingClientRect());
    const inOne = boxes.some((b) => table.top >= b.top - 1 && table.bottom <= b.bottom + 1);
    return { inOne, pages: boxes.length };
  });
  expect(geometry.inOne).toBe(true);
  // The port audit records this as a declared disagreement: Typst's text
  // layer splits the merged row across the pages, which the row matcher
  // cannot follow, and Typst's page starts differ from the local ones.
  const report = await page.evaluate(() => window.__audit());
  expect(report?.pages.agree, JSON.stringify(report?.pages)).toBe(false);
  const rowspan = await page.evaluate((r) => window.view.state.doc.child(2).child(r).child(0).attrs.rowspan, breakRow - 1);
  expect(rowspan).toBe(2);
});

test('editing a cell of a split table keeps one table node and returns to exact pagination', async ({ page }) => {
  test.setTimeout(120_000);
  const logStart = await installDoc(page, { rows: 40 });
  await expectPagination(page, logStart, 'local[');
  expect((await readBreak(page)).widget).not.toBeNull();

  // Place the caret at the end of a cell's paragraph through the editor's
  // own selection (row 3 on page 1, then the last row on page 2) and type.
  const caretAtEndOfCell = (row: number) =>
    page.evaluate((r) => {
      const { state } = window.view;
      const table = state.doc.child(2);
      let pos = 0;
      state.doc.forEach((node, offset, index) => {
        if (index === 2) pos = offset;
      });
      // Table position + 1 (into table) + row offset + 1 (into row) + 1 (into cell) + paragraph content size.
      const rowNode = table.child(r);
      let rowOffset = 0;
      table.forEach((node, offset, index) => {
        if (index === r) rowOffset = offset;
      });
      const paragraphEnd = pos + 1 + rowOffset + 1 + 1 + 1 + rowNode.child(0).child(0).content.size;
      // The live selection class (a TextSelection after install) creates
      // the new caret; app modules are never imported into page.evaluate.
      const Sel = state.selection.constructor as unknown as { create: (doc: typeof state.doc, pos: number) => typeof state.selection };
      window.view.dispatch(state.tr.setSelection(Sel.create(state.doc, paragraphEnd)));
      window.view.focus();
    }, row);
  await caretAtEndOfCell(3);
  const before = await page.evaluate(() => window.__pagCount());
  await page.keyboard.type(' edited');
  await expect
    .poll(() => page.evaluate((b) => window.__pagCount() > b, before), { timeout: 20_000 })
    .toBe(true);
  await expectPagination(page, before, 'local[');

  await caretAtEndOfCell(39);
  const afterSecond = await page.evaluate(() => window.__pagCount());
  await page.keyboard.type(' too');
  await expectPagination(page, afterSecond, 'local[');

  const shape = await page.evaluate(() => {
    const doc = window.view.state.doc;
    const kinds = [] as string[];
    doc.forEach((node) => kinds.push(node.type.name));
    const table = doc.child(2);
    return {
      kinds,
      rows: table.childCount,
      edited: table.child(3).child(0).textContent,
      last: table.child(table.childCount - 1).child(0).textContent,
      widgets: document.querySelectorAll('.ProseMirror table tr.ts-table-break').length,
    };
  });
  expect(shape.kinds).toEqual(['heading', 'paragraph', 'table', 'paragraph']);
  expect(shape.rows).toBe(40);
  expect(shape.edited).toBe('Alpha 3 edited');
  expect(shape.last).toBe('Alpha 39 too');
  expect(shape.widgets).toBe(1);
});

test('a captioned table is a figure and stays whole', async ({ page }) => {
  test.setTimeout(90_000);
  const logStart = await installDoc(page, { rows: 30, caption: 'Thirty rows' });
  await expectPagination(page, logStart, 'local[');
  const result = await readBreak(page);
  expect(result.widget).toBeNull();
  const inOne = await page.evaluate(() => {
    const table = document.querySelector<HTMLElement>('.ProseMirror table')!.getBoundingClientRect();
    const boxes = [...document.querySelectorAll<HTMLElement>('.page-box')].map((el) => el.getBoundingClientRect());
    return boxes.some((b) => table.top >= b.top - 1 && table.bottom <= b.bottom + 1);
  });
  expect(inOne).toBe(true);
});

test('a split table seeds suffix pagination and agrees with Typst', async ({ page }) => {
  test.setTimeout(120_000);
  const logStart = await installDoc(page, { rows: 40, trailingPage: true });
  await expectPagination(page, logStart, 'local[');
  expect((await readBreak(page)).widget).not.toBeNull();

  // The local row walk lands on Typst's own row boundary (port audit).
  const report = await page.evaluate(() => window.__audit());
  expect(report?.pages.agree, JSON.stringify(report?.pages)).toBe(true);

  // Editing on the last page (a block-level page start after the table
  // anchors the seed) restarts local pagination there: the prefix —
  // including the table's row spacer — is validated and kept, not
  // recomputed.
  const before = await page.evaluate(() => {
    const { state } = window.view;
    const last = state.doc.child(state.doc.childCount - 1);
    if (last.type.name !== 'paragraph') throw new Error('fixture changed shape');
    const end = state.doc.content.size - 1;
    const Sel = state.selection.constructor as unknown as { create: (doc: typeof state.doc, pos: number) => typeof state.selection };
    window.view.dispatch(state.tr.setSelection(Sel.create(state.doc, end)));
    window.view.focus();
    window.__suffixPaginationStats(true);
    return { signature: window.__pagLog().at(-1)?.split(':').slice(1).join(':') ?? '', count: window.__pagCount() };
  });
  await page.keyboard.type(' Typed here.', { delay: 500 });
  await expect
    .poll(() => page.evaluate(() => window.__suffixPaginationStats().eligible), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);
  await expectPagination(page, before.count, 'local[');
  const stats = await page.evaluate(() => window.__suffixPaginationStats());
  expect(stats.mismatches).toBe(0);
  expect(stats.bySource.fallback.eligible).toBeGreaterThanOrEqual(1);
  expect(stats.reasons['ineligible-block'] ?? 0).toBe(0);
  const tablePos = await page.evaluate(() => {
    let pos = 0;
    window.view.state.doc.forEach((node, offset) => {
      if (node.type.name === 'table') pos = offset;
    });
    return pos;
  });
  expect(stats.lastAnchorPos).not.toBeNull();
  expect(stats.lastAnchorPos!).toBeGreaterThan(tablePos);
  // The prefix (the row break inside the table, the forced page break)
  // is byte-identical to the settled pagination.
  const after = await page.evaluate(() => window.__pagLog().at(-1)?.split(':').slice(1).join(':') ?? '');
  expect(after).toBe(before.signature);
  expect((await readBreak(page)).widget).not.toBeNull();
});
