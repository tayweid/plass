// A grid cell's column span (Typst's `grid.cell(colspan:)`): how many of
// the grid's columns one cell covers, gutters between them included. A row
// is its cells left to right, and their spans add up to the grid's column
// count. Cells merge across only, never down: a row stays one box the
// paginator moves whole, so a cell never reaches into the next row.

import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';

/** The columns a cell covers (1 for an unmerged cell). */
export const cellSpan = (cell: PMNode): number => Math.max(1, Math.floor((cell.attrs.colspan as number) || 1));

const emptyCell = () => schema.nodes.grid_cell.create(null, schema.nodes.paragraph.create());

/** The cell with another span (itself when it already has it). */
export const withSpan = (cell: PMNode, colspan: number): PMNode =>
  cellSpan(cell) === colspan ? cell : cell.type.create({ ...cell.attrs, colspan }, cell.content, cell.marks);

/** The cells of a row node, or the cells themselves. */
const cellsOf = (row: PMNode | readonly PMNode[]): readonly PMNode[] => {
  if (!('type' in row)) return row as readonly PMNode[];
  const cells: PMNode[] = [];
  row.forEach((cell) => cells.push(cell));
  return cells;
};

/** The column each cell of a row starts at. */
export function cellStarts(row: PMNode | readonly PMNode[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const cell of cellsOf(row)) {
    starts.push(at);
    at += cellSpan(cell);
  }
  return starts;
}

/** The index of the row's cell covering `column` (its last cell for a
 *  column past the row's end). */
export function cellIndexAt(row: PMNode | readonly PMNode[], column: number): number {
  const starts = cellStarts(row);
  let index = 0;
  for (let i = 0; i < starts.length && starts[i] <= column; i++) index = i;
  return index;
}

/** Rows of `width` columns from cells in reading order, placed as Typst
 *  places them: left to right, a cell too wide for what is left of its row
 *  opening the next one (the rest of the row empty cells), a short last row
 *  padded. A span wider than the grid is narrowed to it. */
export function packGridRows(cells: readonly PMNode[], width: number): PMNode[] {
  const rows: PMNode[] = [];
  let row: PMNode[] = [];
  let used = 0;
  const close = () => {
    for (; used < width; used++) row.push(emptyCell());
    rows.push(schema.nodes.grid_row.create(null, row));
    row = [];
    used = 0;
  };
  for (const cell of cells) {
    const span = Math.min(cellSpan(cell), width);
    if (used + span > width) close();
    row.push(withSpan(cell, span));
    used += span;
    if (used === width) close();
  }
  if (row.length) close();
  return rows;
}

/** One row's cells refit to `width` columns: a cell past the edge dropped
 *  (its content with it), the one across the edge narrowed, a short row
 *  padded with empty cells. */
export function fitGridRow(cells: readonly PMNode[], width: number): PMNode[] {
  const out: PMNode[] = [];
  let used = 0;
  for (const cell of cells) {
    if (used >= width) break;
    const span = Math.min(cellSpan(cell), width - used);
    out.push(withSpan(cell, span));
    used += span;
  }
  for (; used < width; used++) out.push(emptyCell());
  return out;
}
