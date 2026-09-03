import { expect, test, type Page } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
    __pagCount: () => number;
    __pageOracle: unknown;
  }
}

// PAGE-PORT.md Phase 7: a native table crossing a page boundary breaks
// BETWEEN rows while staying one editable table node. The break is a widget
// row (`tr.ts-table-break`) between two real rows: an exact-height gap plus a
// non-editable copy of the repeating header at the top of the next page,
// exactly what Typst lays out (grid `layout_active_headers`).

interface TableOptions {
  rows: number;
  /** Row index (0-based, content rows start at 1) whose first cell spans
   * two rows — a merged cell across the boundary below it. */
  rowspanAt?: number;
  caption?: string;
}

async function installDoc(page: Page, opts: TableOptions, navigate = true): Promise<number> {
  if (navigate) await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view && !!window.__pagLog && !!window.__pageOracle);
  return page.evaluate((o) => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const cell = (text: string, attrs: Record<string, unknown> = {}) => s.nodes.table_cell.create(attrs, paragraph(text));
    const header = (text: string) => s.nodes.table_header.create(null, paragraph(text));
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
      { style: 'booktabs', caption: o.caption ?? '', label: '', params: '', fontSize: '' },
      tableRows,
    );
    const doc = s.nodes.doc.create(state.doc.attrs, [
      s.nodes.heading.create({ level: 1 }, s.text('Table pagination')),
      paragraph('An introductory paragraph sits above the table.'),
      table,
      paragraph('A closing paragraph follows the table.'),
    ]);
    const logStart = window.__pagCount();
    window.view.dispatch(
      state.tr.replaceWith(0, state.doc.content.size, doc.content).setMeta('addToHistory', false),
    );
    return logStart;
  }, opts);
}

/** Wait until a pagination entry after `logStart` has the given prefix. */
async function expectPagination(page: Page, logStart: number, prefix: 'exact[' | 'fallback[') {
  await expect
    .poll(
      () => page.evaluate(([start, p]) => {
        const fresh = Math.min(window.__pagCount() - (start as number), 40);
        return fresh > 0 && (window.__pagLog().at(-1)?.startsWith(p as string) ?? false);
      }, [logStart, prefix] as const),
      { timeout: 45_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);
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
  await expectPagination(page, logStart, 'exact[');

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

  // The exact page start Typst reported is the same row boundary.
  const oracleRow = await page.evaluate(() => {
    const oracle = window.__pageOracle as { results?: Map<string, { status: string; pageStarts?: Array<{ unit: string; line: number }> }> };
    const entry = [...(oracle.results?.values() ?? [])].find((e) => e.status === 'ok');
    return entry?.pageStarts?.find((ps) => ps.unit === 'table')?.line ?? -1;
  });
  expect(oracleRow).toBe(Number(nextRow![1]));
});

test('a merged cell across the boundary keeps the table atomic (fail open)', async ({ page }) => {
  test.setTimeout(120_000);
  // Learn where Typst breaks this document, then put a rowspan across
  // exactly that boundary.
  const first = await installDoc(page, { rows: 30 });
  await expectPagination(page, first, 'exact[');
  const breakRow = await page.evaluate(() => {
    const next = document.querySelector('.ProseMirror table tr.ts-table-break')?.nextElementSibling;
    return Number(/Alpha (\d+)/.exec(next?.querySelector('td')?.textContent ?? '')?.[1] ?? -1);
  });
  expect(breakRow).toBeGreaterThan(1);

  const second = await installDoc(page, { rows: 30, rowspanAt: breakRow - 1 }, false);
  // Typst itself splits the rowspan (a compiled start inside the table)...
  await expect
    .poll(
      () => page.evaluate(() => {
        const oracle = window.__pageOracle as { results?: Map<string, { status: string; pageStarts?: Array<{ unit: string; line: number }> }> };
        return [...(oracle.results?.values() ?? [])].some(
          (entry) => entry.status === 'ok' && entry.pageStarts?.some((start) => start.unit === 'table' && start.line > 0),
        );
      }),
      { timeout: 45_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);
  // ...which the editor declines: the table stays one atomic block on the
  // local path, with no widget row inside it.
  await expectPagination(page, second, 'fallback[');
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
  const rowspan = await page.evaluate((r) => window.view.state.doc.child(2).child(r).child(0).attrs.rowspan, breakRow - 1);
  expect(rowspan).toBe(2);
});

test('editing a cell of a split table keeps one table node and returns to exact pagination', async ({ page }) => {
  test.setTimeout(120_000);
  const logStart = await installDoc(page, { rows: 40 });
  await expectPagination(page, logStart, 'exact[');
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
  await expectPagination(page, before, 'exact[');

  await caretAtEndOfCell(39);
  const afterSecond = await page.evaluate(() => window.__pagCount());
  await page.keyboard.type(' too');
  await expectPagination(page, afterSecond, 'exact[');

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
  await expectPagination(page, logStart, 'exact[');
  const result = await readBreak(page);
  expect(result.widget).toBeNull();
  const inOne = await page.evaluate(() => {
    const table = document.querySelector<HTMLElement>('.ProseMirror table')!.getBoundingClientRect();
    const boxes = [...document.querySelectorAll<HTMLElement>('.page-box')].map((el) => el.getBoundingClientRect());
    return boxes.some((b) => table.top >= b.top - 1 && table.bottom <= b.bottom + 1);
  });
  expect(inOne).toBe(true);
});
