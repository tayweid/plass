// PAGE-PORT.md Phase 7: the table row model and the row-break walk, checked
// against scenarios derived from the pinned Typst grid layouter
// (crates/typst-layout/src/grid/{layouter,repeated}.rs, resolve.rs).

import { schema } from '../schema';
import { planTableRowBreaks, tableRowModel, tableRowStartIsRepresentable, type MeasuredRow } from './table-rows';

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

const paragraph = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const cell = (text: string, attrs: Record<string, unknown> = {}) =>
  schema.nodes.table_cell.create(attrs, paragraph(text));
const header = (text: string) => schema.nodes.table_header.create(null, paragraph(text));
const row = (...cells: ReturnType<typeof cell>[]) => schema.nodes.table_row.create(null, cells);
const table = (rows: ReturnType<typeof row>[], attrs: Record<string, unknown> = {}) =>
  schema.nodes.table.create({ style: 'booktabs', caption: '', label: '', params: '', fontSize: '', ...attrs }, rows);

// --- tableRowModel -----------------------------------------------------------

{
  const t = table([row(header('A'), header('B')), row(cell('1'), cell('2')), row(cell('3'), cell('4'))]);
  const m = tableRowModel(t);
  check('row count and offsets', m.rowCount === 3 && m.rowOffsets[0] === 1 && m.rowOffsets[1] === 1 + t.child(0).nodeSize);
  check('one leading header row repeats itself', m.headerRun === 1 && m.repeatRow === 0);
  check('plain table is breakable', m.atomicReason === null);
  check('no rowspan boundaries', m.spannedBoundaries.size === 0);
  check('row 1 and 2 starts are representable', tableRowStartIsRepresentable(m, 1) && tableRowStartIsRepresentable(m, 2));
  check('row 0 and out-of-range starts are not', !tableRowStartIsRepresentable(m, 0) && !tableRowStartIsRepresentable(m, 3));
}

{
  // Two consecutive table.header rows: only the LAST repeats (resolve.rs
  // marks the earlier one short-lived) — matches the compiled probe, where
  // page 2 of a two-header table began with the second header's text only.
  const m = tableRowModel(table([row(header('A')), row(header('B')), row(cell('1')), row(cell('2'))]));
  check('two-row header run', m.headerRun === 2);
  check('only the last header of the run repeats', m.repeatRow === 1);
}

{
  const m = tableRowModel(table([row(cell('1')), row(cell('2'))]));
  check('no header run, nothing repeats', m.headerRun === 0 && m.repeatRow === null);
}

{
  const m = tableRowModel(table([row(header('A')), row(cell('1')), row(header('B')), row(cell('2'))]));
  check('a header after content rows keeps the table atomic', m.atomicReason === 'mid-table-header');
}

{
  const m = tableRowModel(table([row(cell('1')), row(cell('2'))], { caption: 'Cap' }));
  check('a captioned table is a figure: atomic', m.atomicReason === 'caption');
  const m2 = tableRowModel(table([row(cell('1')), row(cell('2'))], { label: 'tab:x' }));
  check('a labelled table is a figure: atomic', m2.atomicReason === 'caption');
}

{
  // A rowspan from row 1 over rows 1..3 crosses the boundaries before rows
  // 2 and 3 (prosemirror-tables keeps only the origin cell in the tree).
  const m = tableRowModel(
    table([
      row(cell('a'), cell('b')),
      row(cell('span', { rowspan: 3 }), cell('c')),
      row(cell('d')),
      row(cell('e')),
      row(cell('f'), cell('g')),
    ]),
  );
  check('rowspan boundaries', [...m.spannedBoundaries].sort().join(',') === '2,3');
  check('a start inside the span is not representable', !tableRowStartIsRepresentable(m, 2) && !tableRowStartIsRepresentable(m, 3));
  check('starts outside the span are', tableRowStartIsRepresentable(m, 1) && tableRowStartIsRepresentable(m, 4));
}

// --- planTableRowBreaks -----------------------------------------------------

const rows = (heights: number[]): MeasuredRow[] => {
  let top = 0;
  return heights.map((height) => {
    const r = { top, height };
    top += height;
    return r;
  });
};
const model = (opts: { rowCount: number; headerRun?: number; spanned?: number[] }) => ({
  rowCount: opts.rowCount,
  rowOffsets: [],
  headerRun: opts.headerRun ?? 0,
  repeatRow: opts.headerRun ? opts.headerRun - 1 : null,
  spannedBoundaries: new Set(opts.spanned ?? []),
  atomicReason: null,
});

{
  const plan = planTableRowBreaks(model({ rowCount: 4 }), rows([25, 25, 25, 25]), 1000, () => 1000);
  check('everything fits: no breaks', plan.kind === 'rows' && plan.breaks.length === 0);
}

{
  // 10 rows of 25px, 120px available on the first page: rows 0-3 fit
  // (100px), row 4 finishes the region (layouter.rs:435). No header, so a
  // continuation page of 200px takes rows 4-11 → no further break.
  const plan = planTableRowBreaks(model({ rowCount: 10 }), rows(new Array(10).fill(25)), 120, () => 200);
  check('break between rows, never inside one', plan.kind === 'rows' && plan.breaks.length === 1 && plan.breaks[0].kind === 'row' && plan.breaks[0].row === 4);
  check('no repeated header without a header run', plan.kind === 'rows' && plan.breaks[0].kind === 'row' && plan.breaks[0].headerHeight === 0);
}

{
  // Same, with a 30px header row 0: page 1 holds header + rows 1-3
  // (30+75=105 ≤ 120); row 4 breaks and the continuation page reserves the
  // repeated header (30px) first: 200-30 = 170px → rows 4-9 (150px) fit.
  const plan = planTableRowBreaks(model({ rowCount: 10, headerRun: 1 }), rows([30, ...new Array(9).fill(25)]), 120, () => 200);
  check('repeated header height is reserved on the continuation page', plan.kind === 'rows' && plan.breaks.length === 1 && plan.breaks[0].kind === 'row' && plan.breaks[0].row === 4 && plan.breaks[0].headerHeight === 30);
}

{
  // The repeated header shrinks the continuation page: with 60px pages and
  // 10px rows, page 2 holds the header (10) + 5 rows, not 6.
  const plan = planTableRowBreaks(model({ rowCount: 20, headerRun: 1 }), rows(new Array(20).fill(10)), 60, () => 60);
  const breakRows = plan.kind === 'rows' ? plan.breaks.map((b) => (b.kind === 'row' ? b.row : -1)) : [];
  check('continuation pages hold capacity minus the repeated header', breakRows.join(',') === '6,11,16');
}

{
  // Header orphan prevention: header (30) fits in the 40px left on the page
  // but the first content row would not follow it → the header migrates
  // too, i.e. the whole table moves (its first frame would be empty).
  const plan = planTableRowBreaks(model({ rowCount: 3, headerRun: 1 }), rows([30, 25, 25]), 40, () => 200);
  check('orphaned header moves the table start', plan.kind === 'rows' && plan.breaks.length === 1 && plan.breaks[0].kind === 'start');
}

{
  // Two-row header run: the short-lived first header (row 0) stays; the
  // repeating header (row 1) + first content row migrate, and nothing
  // repeats on that page (the header had not been flushed yet).
  const plan = planTableRowBreaks(model({ rowCount: 4, headerRun: 2 }), rows([30, 30, 25, 25]), 70, () => 200);
  check('short-lived header stays, repeating header migrates with its row', plan.kind === 'rows' && plan.breaks.length === 1 && plan.breaks[0].kind === 'row' && plan.breaks[0].row === 1 && plan.breaks[0].headerHeight === 0);
}

{
  // A break landing inside a rowspan: fail open (Phase 7 step 4).
  const plan = planTableRowBreaks(model({ rowCount: 4, spanned: [2] }), rows([25, 25, 25, 25]), 60, () => 200);
  check('rowspan across the boundary → atomic', plan.kind === 'atomic' && plan.row === 2);
}

{
  // Oversize row: a row taller than any page is placed and overflows
  // rather than looping.
  const plan = planTableRowBreaks(model({ rowCount: 3 }), rows([25, 500, 25]), 100, () => 100);
  check('oversize row breaks once, then overflows', plan.kind === 'rows' && plan.breaks.length === 2 && plan.breaks[0].kind === 'row' && plan.breaks[0].row === 1 && plan.breaks[1].kind === 'row' && plan.breaks[1].row === 2);
}

{
  // Per-page capacity callback receives the continuation ordinal.
  const seen: number[] = [];
  planTableRowBreaks(model({ rowCount: 6 }), rows(new Array(6).fill(10)), 20, (k) => {
    seen.push(k);
    return 20;
  });
  check('capacity is asked per continuation page in order', seen.join(',') === '1,2');
}

console.log('all table-rows tests passed');
