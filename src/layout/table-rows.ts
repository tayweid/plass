// PAGE-PORT.md Phase 7: the row model behind mid-table page breaks.
//
// A native table stays ONE editable node; a page break inside it is pure
// presentation, decided at ROW boundaries. This module holds the pure,
// DOM-free half of that decision, mirroring the grid rules of the pinned
// vendor/typst @ 951788cc (crates/typst-layout/src/grid/):
//
// - `tableRowModel` reads the document node the way Typst's grid resolver
//   reads what the exporter (typ-serializer.ts) emits for it: which rows are
//   `table.header` rows, which one actually repeats on continuation pages,
//   which row boundaries a merged (rowspan) cell crosses, and whether the
//   table can break at all.
// - `planTableRowBreaks` is the row-placement walk of `GridLayouter::layout`
//   over editor-measured row geometry: a row that does not fit finishes the
//   region (layouter.rs:435 `regions.is_full()` → `finish_region`;
//   layout_auto_row:1166 skips a region whose first frame would be empty),
//   header rows carry orphan prevention (finish_region:1607 truncates to the
//   `lrows_orphan_snapshot`), and each continuation region reserves the
//   repeating header's height first (repeated.rs `layout_active_headers`).
//
// Deliberately NOT mirrored (fail open, PAGE-PORT.md Phase 7 step 4): a
// breakable rowspan split across regions (grid/rowspans.rs) and a tall cell
// split inside one row (`layout_multi_row`). The oracle declines the exact
// map in both cases, so the local walk below never produces a layout the
// compiled document could contradict silently.

import type { Node as PMNode } from 'prosemirror-model';

export type TableAtomicReason = 'caption' | 'mid-table-header' | 'empty';

export interface TableRowModel {
  rowCount: number;
  /** Document offset of each row relative to the table node's position
   * (`tablePos + rowOffsets[i]` is the position before row i). */
  rowOffsets: number[];
  /** Number of leading rows whose cells are all `table_header` — each is
   * serialized as its own `table.header(...)` call. */
  headerRun: number;
  /** The row Typst repeats at the top of every continuation region: the LAST
   * header of the leading run. Consecutive headers before it are
   * short-lived (grid/resolve.rs:1834-1843 marks a header short-lived when
   * it ends exactly where the next same-or-higher-level header starts), so
   * they are laid out once and never repeat. Null without a header run. */
  repeatRow: number | null;
  /** Row indices `i > 0` whose boundary (between row i-1 and row i) a
   * rowspan cell crosses. A page start there is a rowspan split. */
  spannedBoundaries: Set<number>;
  /** Why the table must stay one atomic block, or null when rows may break. */
  atomicReason: TableAtomicReason | null;
}

/** Read the row structure the exporter hands Typst for this table node. */
export function tableRowModel(node: PMNode): TableRowModel {
  const rowOffsets: number[] = [];
  let headerRun = 0;
  let inLeadingRun = true;
  let midTableHeader = false;
  const spannedBoundaries = new Set<number>();
  node.forEach((row, offset, index) => {
    rowOffsets.push(1 + offset);
    let allHeader = row.childCount > 0;
    row.forEach((cell) => {
      if (cell.type.name !== 'table_header') allHeader = false;
      const rowspan = (cell.attrs.rowspan as number) ?? 1;
      for (let k = 1; k < rowspan; k++) spannedBoundaries.add(index + k);
    });
    if (allHeader) {
      if (inLeadingRun) headerRun++;
      else midTableHeader = true;
    } else {
      inLeadingRun = false;
    }
  });
  const rowCount = rowOffsets.length;
  const caption = !!((node.attrs.caption as string) || (node.attrs.label as string));
  let atomicReason: TableAtomicReason | null = null;
  if (rowCount === 0) atomicReason = 'empty';
  // A captioned/labelled table exports as `#figure(table(...))`, and figures
  // are unbreakable blocks by default (typst-library/src/model/figure.rs:
  // 412 — only `show figure: set block(breakable: true)` changes that).
  else if (caption) atomicReason = 'caption';
  // A `table.header` after content rows is a sub-header with its own
  // repetition scope; not modelled here (Typst's header levels).
  else if (midTableHeader) atomicReason = 'mid-table-header';
  return {
    rowCount,
    rowOffsets,
    headerRun,
    repeatRow: headerRun > 0 ? headerRun - 1 : null,
    spannedBoundaries,
    atomicReason,
  };
}

/** Whether a compiled page start at row `row` of this table can be
 * mirrored as a row-boundary break: inside the table, past the header run
 * (header rows form an unbreakable group and are never split off from each
 * other), and not across a merged cell. */
export function tableRowStartIsRepresentable(model: TableRowModel, row: number): boolean {
  if (model.atomicReason) return false;
  if (!Number.isInteger(row) || row <= 0 || row >= model.rowCount) return false;
  if (model.spannedBoundaries.has(row)) return false;
  return true;
}

/** One measured row: natural geometry relative to the table's own top. */
export interface MeasuredRow {
  top: number;
  height: number;
}

export type TableRowBreak =
  /** The whole table moves: nothing of it was placed on the current page
   * (Typst: the block's first region frame is empty — flow/distribute.rs:
   * 286-294 finishes the region before `frame()` is ever called, so a
   * sticky heading above comes along through the snapshot restore). */
  | { kind: 'start' }
  /** A break before `row`; `headerHeight` is the repeated header's height
   * reserved at the top of the new page (0 when nothing repeats there). */
  | { kind: 'row'; row: number; headerHeight: number };

export type TableRowPlan =
  | { kind: 'rows'; breaks: TableRowBreak[] }
  /** A merged cell crosses a boundary the walk would break at: fail open
   * (Phase 7 step 4) — the caller places the table as one atomic block. */
  | { kind: 'atomic'; row: number };

/**
 * Walk the rows in Typst's order and decide every region finish.
 *
 * `avail` is the space (px) below the table's top on the current page;
 * `capacity(k)` is the full content height of the k-th continuation page
 * (k = 1 for the first page the table spills onto), as reduced by whatever
 * the caller's footnote ledger settles there. Heights are DOM-measured and
 * consumed as-is (PAGE-PORT.md doctrine); rows never split.
 */
export function planTableRowBreaks(
  model: TableRowModel,
  rows: readonly MeasuredRow[],
  avail: number,
  capacity: (continuation: number) => number,
  tolerance = 0.5,
): TableRowPlan {
  const breaks: TableRowBreak[] = [];
  const rep = model.repeatRow;
  // Natural y (relative to the table top) of the current page's bottom.
  let limit = avail;
  let continuation = 0;
  // Row a break was last placed before: a row that still overflows on its
  // own fresh page is placed anyway (Typst would split the cell across
  // regions; this walk lets it overflow — PAGE-PORT.md Phase 5 "oversize").
  let brokeBefore = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.top + row.height <= limit + tolerance) continue;
    if (i === brokeBefore) continue;
    // The row does not fit. Where does the region finish?
    let at = i;
    // Header orphan prevention (layouter.rs:1604-1618 with the snapshot
    // taken in repeated.rs `layout_new_headers`): the repeating header must
    // be followed by a content row in its region, else it migrates whole.
    // Short-lived headers before it stay put (they never repeat, and are
    // placed without a snapshot: repeated.rs:79-90).
    if (rep !== null && i === rep + 1 && brokeBefore !== rep) at = rep;
    if (model.spannedBoundaries.has(at)) return { kind: 'atomic', row: at };
    // The repeating header exists on continuation regions only once it has
    // been flushed by a placed content row (repeated.rs `flush_orphans`
    // after `layout_row`); a break inside the header run repeats nothing.
    const headerHeight = rep !== null && at > rep ? rows[rep].height : 0;
    breaks.push(at === 0 ? { kind: 'start' } : { kind: 'row', row: at, headerHeight });
    continuation++;
    limit = rows[at].top - headerHeight + capacity(continuation);
    brokeBefore = at;
    // Re-evaluate from the row the break sits before.
    i = at - 1;
  }
  return { kind: 'rows', breaks };
}
