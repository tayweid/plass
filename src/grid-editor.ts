// The grid rail: a block of rows × columns whose cells hold any block
// content, laid out as Typst's `#grid(columns: (…fr), gutter: …)`. Column
// widths are fraction shares (CSS `fr` and Typst `fr` divide the measure
// left after the gutters the same way), rows are atomic (`grid.cell(
// breakable: false)` on export; the paginator moves a row whole), and the
// grid breaks between rows. A cell's box is normalized to the paragraph's
// frame slack (see GridCellView) so cells of different content align at
// their frame tops as Typst aligns them, and a row's frame is the tallest
// cell's — which lets the paginator treat a row exactly like a paragraph
// block. Markdown carries a grid as a ```typst fence holding the same
// call (md-parser recognizes it).

import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from 'prosemirror-view';
import { schema } from './schema';
import { getSettings } from './settings';
import { blockFrameSlackEm, headingScale } from './typ-serializer';
import { atPaperSize, onPaperScale, paperScale } from './paper-scale';
import { inkReachEm } from './font-registry';
import { onGeometryVarsPublished, scheduleTypeset } from './typeset-plugin';
import { cellIndexAt, cellSpan, cellStarts, fitGridRow, withSpan } from './grid-spans';

export const DEFAULT_GRID_GUTTER_EM = 1;

/** The nearest grid around the selection, with its position, or the grid
 *  it node-selects (Escape from a cell selects the block; the pill, its
 *  panels and the washes stay). `depth` is the grid's own depth. */
export function gridContext(state: EditorState): { pos: number; node: PMNode; depth: number } | null {
  const selection = state.selection;
  if (selection instanceof NodeSelection && selection.node.type === schema.nodes.grid) {
    return { pos: selection.from, node: selection.node, depth: selection.$from.depth + 1 };
  }
  const { $from } = selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === schema.nodes.grid) return { pos: $from.before(d), node, depth: d };
  }
  return null;
}

/** The selection's cell: its row, its index in the row (`cell`), the
 *  first column it covers and how many (`column`, `span`: a merged cell
 *  covers several), and the caret's offset in it. */
function selectedCell(state: EditorState, ctx: NonNullable<ReturnType<typeof gridContext>>) {
  const { $from } = state.selection;
  if ($from.depth < ctx.depth + 2) return null;
  const row = $from.index(ctx.depth);
  const cell = $from.index(ctx.depth + 1);
  return {
    row,
    cell,
    column: cellStarts(ctx.node.child(row))[cell],
    span: cellSpan($from.node(ctx.depth + 2)),
    offset: $from.pos - $from.start(ctx.depth + 2),
  };
}

/** The position of the row's `index`th cell (its index, not a column). */
function cellPosition(grid: PMNode, pos: number, row: number, index: number): number {
  let at = pos + 2;
  for (let i = 0; i < row; i++) at += grid.child(i).nodeSize;
  for (let i = 0; i < index; i++) at += grid.child(row).child(i).nodeSize;
  return at;
}

const emptyCell = () => schema.nodes.grid_cell.create(null, schema.nodes.paragraph.create());

/** A fresh rows × columns grid of empty paragraphs. */
export function makeGrid(columns: number[], rows = 1, gutter = DEFAULT_GRID_GUTTER_EM): PMNode {
  const row = () => schema.nodes.grid_row.create(null, columns.map(() => emptyCell()));
  return schema.nodes.grid.create({ columns, gutter }, Array.from({ length: rows }, row));
}

/** Insert a one-row, two-column grid after the current block; the caret
 *  lands in the first cell. */
export function insertGrid(view: EditorView, columns: number[] = [1, 1]): void {
  const { $from } = view.state.selection;
  // Never inside a table cell or another grid cell: after the top-level block.
  const insertPos = $from.depth > 0 ? $from.after(1) : view.state.selection.to;
  const tr = view.state.tr.insert(insertPos, makeGrid(columns));
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 3)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Rebuild the grid at `pos` from a cell matrix (rows of cells), keeping
 *  the caret in the cell now covering its column. */
function replaceGrid(state: EditorState, pos: number, attrs: Record<string, unknown>, rows: PMNode[][]): Transaction {
  const old = state.doc.nodeAt(pos)!;
  const node = schema.nodes.grid.create(attrs, rows.map((cells) => schema.nodes.grid_row.create(null, cells)));
  const tr = state.tr.replaceWith(pos, pos + old.nodeSize, node);
  const ctx = gridContext(state);
  const selected = ctx && selectedCell(state, ctx);
  let target = pos + 3;
  if (selected) {
    const row = Math.min(selected.row, node.childCount - 1);
    const index = cellIndexAt(node.child(row), selected.column);
    const cell = node.child(row).child(index);
    target = cellPosition(node, pos, row, index) + 1 + Math.min(selected.offset, cell.content.size);
  }
  // A grid selected as a block stays selected (its Grid layout panel).
  if (state.selection instanceof NodeSelection && state.selection.from === pos) tr.setSelection(NodeSelection.create(tr.doc, pos));
  else tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(pos + 3, target))));
  return tr;
}

const cellMatrix = (grid: PMNode): PMNode[][] => {
  const rows: PMNode[][] = [];
  grid.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((cell) => cells.push(cell));
    rows.push(cells);
  });
  return rows;
};

/** Set the column shares; a different count adds empty cells on the right
 *  or drops the rightmost columns (their content is lost, a merged cell
 *  across the new edge narrowed; Grid layout never changes the count,
 *  Columns › add/delete act at the caret instead). */
export function setGridColumns(view: EditorView, columns: number[], focus = true): boolean {
  const ctx = gridContext(view.state);
  if (!ctx) return false;
  const rows = cellMatrix(ctx.node).map((cells) => fitGridRow(cells, columns.length));
  view.dispatch(replaceGrid(view.state, ctx.pos, { ...ctx.node.attrs, columns }, rows));
  if (focus) view.focus();
  return true;
}

/** `focus`: hand the editor the focus (a click does; a field the writer
 *  is typing in keeps it). */
export function setGridGutter(view: EditorView, gutter: number, focus = true): boolean {
  const ctx = gridContext(view.state);
  if (!ctx) return false;
  if (ctx.node.attrs.gutter !== gutter) view.dispatch(view.state.tr.setNodeMarkup(ctx.pos, undefined, { ...ctx.node.attrs, gutter }));
  if (focus) view.focus();
  return true;
}

// Append a row at the bottom (the pill's row commands act at the caret:
// insertGridRowAt and the rest below).
export function addGridRow(view: EditorView): boolean {
  const ctx = gridContext(view.state);
  if (!ctx) return false;
  const columns = ctx.node.attrs.columns as number[];
  const rows = cellMatrix(ctx.node);
  rows.push(columns.map(() => emptyCell()));
  const tr = replaceGrid(view.state, ctx.pos, ctx.node.attrs, rows);
  const grid = tr.doc.nodeAt(ctx.pos)!;
  const firstCell = cellPosition(grid, ctx.pos, grid.childCount - 1, 0);
  tr.setSelection(TextSelection.near(tr.doc.resolve(firstCell + 1)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** The caret's grid and cell (row, column), for the commands that act at
 *  the caret: in a cell of a nested block, the grid cell holding it. */
function caretCell(state: EditorState) {
  const ctx = gridContext(state);
  if (!ctx) return null;
  const selected = selectedCell(state, ctx);
  return selected ? { ctx, ...selected } : null;
}

/** Put the caret at the start of the rebuilt grid's cell covering
 *  `column` in `row`. */
function caretTo(tr: Transaction, pos: number, row: number, column: number): Transaction {
  const grid = tr.doc.nodeAt(pos)!;
  const index = cellIndexAt(grid.child(row), column);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(cellPosition(grid, pos, row, index) + 1)));
}

/** Shares divided by the smallest, to three decimals (parseColumnShares's
 *  canonical form). */
const canonical = (shares: number[]) => {
  const min = Math.min(...shares);
  return shares.map((n) => Math.round((n / min) * 1000) / 1000);
};

/** A row of empty cells above or below the caret's row; the caret lands in
 *  the new row, in its column. */
export function insertGridRowAt(view: EditorView, side: 'above' | 'below'): boolean {
  const at = caretCell(view.state);
  if (!at) return false;
  const columns = at.ctx.node.attrs.columns as number[];
  const rows = cellMatrix(at.ctx.node);
  const index = side === 'above' ? at.row : at.row + 1;
  rows.splice(index, 0, columns.map(() => emptyCell()));
  const tr = caretTo(replaceGrid(view.state, at.ctx.pos, at.ctx.node.attrs, rows), at.ctx.pos, index, Math.min(at.column, columns.length - 1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Remove the caret's row (its content goes with it); never the last. */
export function deleteGridRowAt(view: EditorView): boolean {
  const at = caretCell(view.state);
  if (!at || at.ctx.node.childCount < 2) return false;
  const rows = cellMatrix(at.ctx.node);
  rows.splice(at.row, 1);
  const row = Math.min(at.row, rows.length - 1);
  const tr = caretTo(replaceGrid(view.state, at.ctx.pos, at.ctx.node.attrs, rows), at.ctx.pos, row, at.column);
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** An empty column left or right of the caret's cell (all of a merged
 *  cell), one share wide (the smallest share); the caret lands in it, in
 *  its row. A merged cell the new column passes through in another row
 *  widens over it, as a table's does. */
export function insertGridColumnAt(view: EditorView, side: 'left' | 'right'): boolean {
  const at = caretCell(view.state);
  if (!at) return false;
  const columns = [...(at.ctx.node.attrs.columns as number[])];
  if (columns.length >= 12) return false;
  const index = side === 'left' ? at.column : at.column + at.span;
  columns.splice(index, 0, Math.min(...columns));
  const rows = cellMatrix(at.ctx.node).map((cells) => {
    const out = [...cells];
    const starts = cellStarts(cells);
    const across = starts.findIndex((start, i) => start < index && index < start + cellSpan(cells[i]));
    if (across >= 0) out[across] = withSpan(cells[across], cellSpan(cells[across]) + 1);
    else {
      const before = starts.findIndex((start) => start >= index);
      out.splice(before < 0 ? out.length : before, 0, emptyCell());
    }
    return out;
  });
  const tr = caretTo(replaceGrid(view.state, at.ctx.pos, { ...at.ctx.node.attrs, columns: canonical(columns) }, rows), at.ctx.pos, at.row, index);
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Remove the caret's column (its content goes with it); never the last.
 *  In a merged cell, its first column: the cell narrows by one and keeps
 *  its content, as a table's merged cell does; so does a merged cell
 *  across the column in another row. */
export function deleteGridColumnAt(view: EditorView): boolean {
  const at = caretCell(view.state);
  const columns = [...((at?.ctx.node.attrs.columns as number[]) ?? [])];
  if (!at || columns.length < 2) return false;
  columns.splice(at.column, 1);
  const rows = cellMatrix(at.ctx.node).map((cells) => {
    const i = cellIndexAt(cells, at.column);
    const start = cellStarts(cells)[i];
    const span = cellSpan(cells[i]);
    if (!(start <= at.column && at.column < start + span)) return cells;
    const out = [...cells];
    if (span > 1) out[i] = withSpan(cells[i], span - 1);
    else out.splice(i, 1);
    return out.length ? out : [emptyCell()];
  });
  const column = Math.min(at.column, columns.length - 1);
  const tr = caretTo(replaceGrid(view.state, at.ctx.pos, { ...at.ctx.node.attrs, columns: canonical(columns) }, rows), at.ctx.pos, at.row, column);
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** The caret's place in its grid, for the pill's live readout: its cell's
 *  first column and how many it covers. */
export function gridCaretPlace(state: EditorState): { row: number; rows: number; column: number; span: number; columns: number } | null {
  const at = caretCell(state);
  if (!at) return null;
  return { row: at.row, rows: at.ctx.node.childCount, column: at.column, span: at.span, columns: (at.ctx.node.attrs.columns as number[]).length };
}

/** The caret cell's alignment (`align`: left / center / right; `valign`:
 *  top / middle / bottom), '' where unset, as selectedCellsAttr reads a
 *  table's; null outside a grid cell. */
export function gridCellAttr(state: EditorState, name: 'align' | 'valign'): string | null {
  const at = caretCell(state);
  if (!at) return null;
  return String(at.ctx.node.child(at.row).child(at.cell).attrs[name] ?? '');
}

/** Set the caret cell's alignment (Typst's grid.cell(align:)); null is
 *  Typst's default again. */
export function setGridCellAttr(name: 'align' | 'valign', value: string | null): Command {
  return (state, dispatch) => {
    const at = caretCell(state);
    if (!at) return false;
    const cell = at.ctx.node.child(at.row).child(at.cell);
    if ((cell.attrs[name] ?? null) === value) return true;
    if (dispatch) {
      const pos = cellPosition(at.ctx.node, at.ctx.pos, at.row, at.cell);
      dispatch(state.tr.setNodeMarkup(pos, undefined, { ...cell.attrs, [name]: value }));
    }
    return true;
  };
}

/** The index of the cell holding the selection's end, when that is in the
 *  same row as its start (`at`); null otherwise. */
function selectionEndCell(state: EditorState, at: NonNullable<ReturnType<typeof caretCell>>): number | null {
  const { $to } = state.selection;
  const d = at.ctx.depth;
  if ($to.depth < d + 2 || $to.before(d) !== at.ctx.pos || $to.index(d) !== at.row) return null;
  return $to.index(d + 1);
}

/** The cells a merge joins, as indexes into one row: the run of cells the
 *  selection spans, or, from a caret (a selection inside one cell), its
 *  cell and the next. Null when that is not one row's two or more cells. */
function mergeRun(state: EditorState): { at: NonNullable<ReturnType<typeof caretCell>>; from: number; to: number } | null {
  const at = caretCell(state);
  if (!at) return null;
  const last = selectionEndCell(state, at);
  if (last === null) return null;
  const to = last > at.cell ? last : at.cell + 1;
  return to < at.ctx.node.child(at.row).childCount ? { at, from: at.cell, to } : null;
}

/** Whether the selection spans two or more cells of one grid row (the
 *  pill offers Merge cells, not Merge with cell right). */
export function gridSelectionSpansCells(state: EditorState): boolean {
  const at = caretCell(state);
  return !!at && (selectionEndCell(state, at) ?? -1) > at.cell;
}

/** Merge cells across (Typst's grid.cell(colspan:)): the run mergeRun
 *  finds becomes one cell covering their columns, holding their blocks in
 *  order (an empty cell adds none) and the first cell's alignment. */
export const mergeGridCells: Command = (state, dispatch) => {
  const run = mergeRun(state);
  if (!run) return false;
  if (dispatch) {
    const { at, from, to } = run;
    const row = at.ctx.node.child(at.row);
    const blocks: PMNode[] = [];
    let span = 0;
    for (let i = from; i <= to; i++) {
      const cell = row.child(i);
      span += cellSpan(cell);
      const empty = cell.childCount === 1 && cell.firstChild!.type === schema.nodes.paragraph && !cell.firstChild!.content.size;
      if (!empty) cell.forEach((block) => blocks.push(block));
    }
    const first = row.child(from);
    const merged = first.type.create({ ...first.attrs, colspan: span }, blocks.length ? blocks : [schema.nodes.paragraph.create()]);
    const start = cellPosition(at.ctx.node, at.ctx.pos, at.row, from);
    const end = cellPosition(at.ctx.node, at.ctx.pos, at.row, to) + row.child(to).nodeSize;
    const tr = state.tr.replaceWith(start, end, merged);
    // The caret stays where it was in the first cell's text (its start
    // when that cell was empty and added nothing).
    tr.setSelection(TextSelection.near(tr.doc.resolve(start + 1 + Math.min(state.selection.empty ? at.offset : 0, merged.content.size))));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Split the caret's merged cell back into one cell per column: the first
 *  keeps the content and the alignment, the others are empty. */
export const splitGridCell: Command = (state, dispatch) => {
  const at = caretCell(state);
  if (!at || at.span < 2) return false;
  if (dispatch) {
    const pos = cellPosition(at.ctx.node, at.ctx.pos, at.row, at.cell);
    const cell = at.ctx.node.child(at.row).child(at.cell);
    const tr = state.tr.setNodeMarkup(pos, undefined, { ...cell.attrs, colspan: 1 });
    tr.insert(pos + cell.nodeSize, Array.from({ length: at.span - 1 }, () => emptyCell()));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Replace the grid by its cells' blocks in reading order. */
export function unwrapGrid(view: EditorView): boolean {
  const ctx = gridContext(view.state);
  if (!ctx) return false;
  const blocks: PMNode[] = [];
  ctx.node.forEach((row) => row.forEach((cell) => cell.forEach((block) => blocks.push(block))));
  const tr = view.state.tr.replaceWith(ctx.pos, ctx.pos + ctx.node.nodeSize, Fragment.from(blocks));
  tr.setSelection(TextSelection.near(tr.doc.resolve(ctx.pos + 1)));
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Tab / Shift-Tab inside a grid: the next / previous cell in reading
 *  order; Tab from the last cell adds a row (like a table). */
export const tabInGrid = (dir: 1 | -1): Command => (state, dispatch, view) => {
  const ctx = gridContext(state);
  if (!ctx) return false;
  const cells: number[] = [];
  ctx.node.forEach((row, rowOff) => {
    row.forEach((_cell, cellOff) => cells.push(ctx.pos + 1 + rowOff + 1 + cellOff));
  });
  const here = state.selection.$from;
  let idx = -1;
  for (let d = here.depth; d > 0; d--) {
    if (here.node(d).type === schema.nodes.grid_cell && here.before(d) >= ctx.pos) {
      idx = cells.indexOf(here.before(d));
      break;
    }
  }
  if (idx < 0) return false;
  const target = idx + dir;
  if (target < 0) return true;
  if (target >= cells.length) {
    if (dispatch && view) addGridRow(view);
    return true;
  }
  if (dispatch) {
    const cellPos = cells[target];
    const cell = state.doc.nodeAt(cellPos)!;
    const $to = dir > 0 ? state.doc.resolve(cellPos + 1) : state.doc.resolve(cellPos + cell.nodeSize - 1);
    dispatch(state.tr.setSelection(TextSelection.near($to, dir)).scrollIntoView());
  }
  return true;
};

/** ArrowDown from a grid's last row (ArrowUp from its first) with nowhere
 *  to go: step out of the grid into the block after (before) it, creating
 *  a paragraph when the grid ends (opens) the document or its cell — the
 *  table's exitTableVertically, for grids. Runs after the geometric caret
 *  motion has found no line to land on. */
export function exitGridVertically(dir: -1 | 1): Command {
  return (state, dispatch) => {
    // A caret only: a range or a selected image keeps the default motion.
    if (!(state.selection instanceof TextSelection) || !state.selection.empty) return false;
    const at = caretCell(state);
    if (!at) return false;
    if (dir > 0 ? at.row < at.ctx.node.childCount - 1 : at.row > 0) return false;
    // In a table inside the cell, the table's own exit leads (into the cell).
    const { $from } = state.selection;
    for (let d = $from.depth; d > at.ctx.depth; d--) if ($from.node(d).type.spec.tableRole === 'table') return false;
    if (!dispatch) return true;
    const edge = dir > 0 ? at.ctx.pos + at.ctx.node.nodeSize : at.ctx.pos;
    const $edge = state.doc.resolve(edge);
    const neighbour = dir > 0 ? $edge.nodeAfter : $edge.nodeBefore;
    if (neighbour?.isTextblock) {
      const pos = dir > 0 ? edge + 1 : edge - 1;
      dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos), dir)).scrollIntoView());
      return true;
    }
    const tr = state.tr.insert(edge, schema.nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, edge + 1)).scrollIntoView());
    return true;
  };
}

// ---------------------------------------------------------------------------
// Cell frames

const LEAF_TAGS = new Set(['UL', 'OL', 'LI', 'BLOCKQUOTE']);

/** A cell's first / last leaf block: descend through list and quote
 *  containers, in the node and in its DOM. */
function leafOf(node: PMNode, el: Element | null, last: boolean): { node: PMNode; el: Element } | null {
  let n: PMNode | null = last ? node.lastChild : node.firstChild;
  let e: Element | null = last ? el?.lastElementChild ?? null : el?.firstElementChild ?? null;
  while (n && e && LEAF_TAGS.has(e.tagName) && n.childCount) {
    n = last ? n.lastChild : n.firstChild;
    e = last ? e.lastElementChild : e.firstElementChild;
  }
  // A paragraph containing only an image has the image's frame, not a
  // text line's cap/baseline insets. Subtracting those insets shortened
  // graph cells by a full leading and placed their ink above adjacent
  // tables; repeated graph rows could hide an entire printed page.
  if (n?.type === schema.nodes.paragraph && n.childCount === 1 && n.firstChild?.type === schema.nodes.image) {
    const image = e?.querySelector<HTMLImageElement>('.ts-inline-image img');
    if (image?.naturalHeight) return { node: n.firstChild, el: image };
  }
  return n && e ? { node: n, el: e } : null;
}

/** Every mounted cell, for the re-fits nothing in the cell's own node
 *  announces (geometry variables, late fonts). */
const liveCells = new Set<GridCellView>();

/** One observer for every cell's content box. A cell's margins are the
 *  only thing fit() writes, and margins never resize the content box, so
 *  the observer cannot loop; what does resize it — a nested table's column
 *  pass or its block margin changing, a late font — re-fits the cell. */
let cellObserver: ResizeObserver | null = null;
const observedCells = new WeakMap<Element, GridCellView>();
function observeCell(cell: GridCellView, el: HTMLElement) {
  if (typeof ResizeObserver === 'undefined') return;
  cellObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) observedCells.get(entry.target)?.refitSoon();
  });
  observedCells.set(el, cell);
  cellObserver.observe(el);
}

/** Re-fit every mounted cell now, in one paper-size measure. Returns true
 *  when any cell's margins moved. */
export function refitGridCells(): boolean {
  if (!liveCells.size) return false;
  return atPaperSize(() => {
    let moved = false;
    for (const cell of liveCells) moved = cell.fitNow() || moved;
    return moved;
  });
}

// Published geometry variables change what a cell's first/last block
// measures (a table's --table-mb): re-fit inside that pass, before it
// measures the page.
onGeometryVarsPublished(refitGridCells);

// A late font can move a leaf without resizing the cell's box.
if (typeof document !== 'undefined' && document.fonts) {
  const refitAll = () => {
    for (const cell of liveCells) cell.refitSoon();
  };
  void document.fonts.ready.then(refitAll);
  document.fonts.addEventListener('loadingdone', refitAll);
}

/**
 * A grid cell. Its box is normalized so that, whatever block starts or
 * ends it, the box begins one paragraph slack above the content's Typst
 * frame and ends one paragraph inset below it: a paragraph-first cell keeps
 * its own line box, a table-first cell drops the table's block margin, a
 * heading-first cell shifts by the heading's larger ascent. Then every
 * cell in a row shares frame top and the tallest frame sets the row (as
 * Typst's grid aligns cells), and the paginator can fit a row with the
 * paragraph's adjust and inset. The margins are re-measured whenever the
 * cell's content changes, its box resizes, the document's geometry
 * variables change, or a font arrives; reading two rects is the whole
 * cost. fit() is a function of the settled DOM, so a re-fit with nothing
 * changed writes nothing: entering a cell (a decoration change) never
 * moves layout.
 */
export class GridCellView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private pending = false;
  private fitted = false;
  private span = 1;
  /** Where this cell's ink lies, for the grid's wash pass (cellWashPass). */
  ink: CellInk | null = null;

  constructor(node: PMNode, private view: EditorView) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'ts-grid-cell';
    this.contentDOM = this.dom;
    this.paint(node);
    liveCells.add(this);
    observeCell(this, this.dom);
    this.schedule();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const moved = node.attrs.valign !== this.node.attrs.valign;
    this.node = node;
    this.paint(node);
    this.schedule();
    // A cell placed elsewhere in its row (align-self) keeps its size, so
    // no observer fires: its wash is placed again here.
    if (moved) scheduleWashPass(this.dom.closest('.ts-grid'));
    return true;
  }

  /** The cell's alignment as the data attributes style.css paints, and its
   *  column span as its place in the row's CSS grid (the node view stands
   *  in for the schema's toDOM). */
  private paint(node: PMNode): void {
    for (const [name, value] of [['data-align', node.attrs.align], ['data-valign', node.attrs.valign]] as const) {
      if (typeof value === 'string' && value) {
        if (this.dom.getAttribute(name) !== value) this.dom.setAttribute(name, value);
      } else if (this.dom.hasAttribute(name)) this.dom.removeAttribute(name);
    }
    const span = cellSpan(node);
    if (span !== this.span) {
      this.span = span;
      this.dom.style.gridColumn = span > 1 ? `span ${span}` : '';
    }
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    return m.type === 'attributes' && m.target === this.dom;
  }

  destroy(): void {
    liveCells.delete(this);
    cellObserver?.unobserve(this.dom);
  }

  /** Re-fit after something outside the document moved (observer, fonts). */
  refitSoon(): void {
    this.schedule();
  }

  private schedule() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      // Measured on the paper at its own size (paper-scale.ts). A change
      // to a cell that was already fitted moves the rows below after a
      // pass may have measured them: re-paginate. (A new cell's first fit
      // precedes the pass its own transaction scheduled.)
      const first = !this.fitted;
      this.fitted = true;
      if (atPaperSize(() => this.fit()) && !first) scheduleTypesetSoon(this.view);
    });
  }

  /** Fit now (the caller holds the paper at its own size). */
  fitNow(): boolean {
    return this.fit();
  }

  private fit(): boolean {
    if (!this.dom.isConnected) return false;
    const s = getSettings(this.view.state);
    const F = parseFloat(getComputedStyle(this.view.dom).fontSize) || 16.67;
    const box = this.dom.getBoundingClientRect();
    const first = leafOf(this.node, this.contentDOM, false);
    const last = leafOf(this.node, this.contentDOM, true);
    if (!first || !last || box.height === 0) return false;
    const ref = blockFrameSlackEm(schema.nodes.paragraph.create(), s);
    const above = blockFrameSlackEm(first.node, s).above;
    const below = blockFrameSlackEm(last.node, s).below;
    const extraAbove = first.el.getBoundingClientRect().top - box.top;
    const extraBelow = box.bottom - last.el.getBoundingClientRect().bottom;
    const marginTop = ref.above * F - (extraAbove + above * F);
    const marginBottom = ref.below * F - (extraBelow + below * F);
    const top = `${marginTop.toFixed(3)}px`;
    const bottom = `${marginBottom.toFixed(3)}px`;
    let moved = false;
    if (this.dom.style.marginTop !== top) {
      this.dom.style.marginTop = top;
      moved = true;
    }
    if (this.dom.style.marginBottom !== bottom) {
      this.dom.style.marginBottom = bottom;
      moved = true;
    }
    // Editing guides use the normalized frame, including margins that
    // take a first/last block's extra spacing out of this cell's box.
    if (this.dom.style.getPropertyValue('--grid-cell-margin-top') !== top) this.dom.style.setProperty('--grid-cell-margin-top', top);
    if (this.dom.style.getPropertyValue('--grid-cell-margin-bottom') !== bottom) this.dom.style.setProperty('--grid-cell-margin-bottom', bottom);
    // The wash's reach (paint only): where the ink sits inside this box,
    // from the frames just measured and the family's ink beyond them, or a
    // non-text block's own box, widened by any image or math in the edge
    // leaves. Reads only the edge leaves' atoms; the grid pass runs only
    // when this or the box's height moved (a keystroke that wraps no line
    // costs nothing more).
    const reach = inkReachEm(s.font);
    const after = this.dom.getBoundingClientRect();
    const frameTop = extraAbove + above * F;
    const frameBottom = extraBelow + below * F;
    // A text edge reaches to its line box, not just its glyphs: the caret
    // fills the line box, and a wash that stopped at the glyphs let it poke
    // out and sat a word without descenders high in its tile.
    const lineTop = lineEdge(first, after, 'top');
    const lineBottom = lineEdge(last, after, 'bottom');
    const inkTop = leafInk(first, after, 'top', lineTop ?? frameTop - reach.above * F * scaleOf(first.node));
    const inkBottom = leafInk(last, after, 'bottom', lineBottom ?? frameBottom - reach.below * F * scaleOf(last.node));
    const ink: CellInk = {
      top: inkTop,
      bottom: inkBottom,
      topText: lineTop !== null && inkTop !== null && Math.abs(inkTop - lineTop) < 0.01,
      bottomText: lineBottom !== null && inkBottom !== null && Math.abs(inkBottom - lineBottom) < 0.01,
      frameTop: lineTop ?? frameTop - reach.above * F,
      frameBottom: lineBottom ?? frameBottom - reach.below * F,
      height: after.height,
      heading: first.node.type === schema.nodes.heading,
      reachEm: lineTop !== null && lineBottom !== null ? (frameTop - lineTop + frameBottom - lineBottom) / F : reach.above + reach.below,
    };
    const prev = this.ink;
    this.ink = ink;
    if (!prev || moved || !sameInk(prev, ink)) scheduleWashPass(this.dom.parentElement?.parentElement ?? null);
    return moved;
  }
}

// ---------------------------------------------------------------------------
// Cell washes (editing chrome, paint only)
//
// While the caret is in a grid every cell paints a rounded wash on its
// absolutely positioned ::after (style.css), as tall as its ROW's ink and
// with air round it, so descenders and answer boxes sit inside. The cell
// views measure their own ink (fit); one pass per grid row-equalizes it and
// decides, per row boundary, between two rounded washes with air between
// them and, when the rows' ink is too close for that (Q1's "Types:" line
// over its answer boxes), one surface joined at the gap's midline with a
// hairline seam. Everything written is a custom property on the cell:
// nothing laid out reads them.

/** A cell's ink, layout px inward from its border box (negative =
 *  outside); `top`/`bottom` are null for a cell with no ink (an empty
 *  paragraph), whose row's ink stands in, and `frameTop`/`frameBottom`
 *  are a text line's ink at the cell's frame (an all-empty row). */
interface CellInk {
  top: number | null;
  bottom: number | null;
  /** The top / bottom edge is a line box (text), not an image or block. */
  topText: boolean;
  bottomText: boolean;
  frameTop: number;
  frameBottom: number;
  height: number;
  heading: boolean;
  /** The family's ink reach above the cap and below the baseline, em. */
  reachEm: number;
}

const sameInk = (a: CellInk, b: CellInk) =>
  a.top === b.top && a.bottom === b.bottom && a.topText === b.topText && a.bottomText === b.bottomText && a.frameTop === b.frameTop && a.frameBottom === b.frameBottom && a.height === b.height && a.heading === b.heading && a.reachEm === b.reachEm;

/** Images, math and nested blocks whose own box is their ink. */
const INK_ATOMS = 'img, .ts-inline-image, .math-inline, .math-display, figure, table';

const isTextLeaf = (node: PMNode) => node.isTextblock && node.type !== schema.nodes.code_block;
const scaleOf = (node: PMNode) => (node.type === schema.nodes.heading ? headingScale((node.attrs.level as number) || 1) : 1);

/** A text leaf's outer line-box edge, layout px inward from the cell's box:
 *  the band the caret fills, which holds the line's ascenders and
 *  descenders and sits evenly round its text. Null for a non-text leaf. */
function lineEdge(leaf: { node: PMNode; el: Element }, box: DOMRect, side: 'top' | 'bottom'): number | null {
  if (!isTextLeaf(leaf.node)) return null;
  const r = leaf.el.getBoundingClientRect();
  if (r.height <= 0.5) return null;
  return side === 'top' ? r.top - box.top : box.bottom - r.bottom;
}

/** The ink edge of a cell's first (`top`) or last (`bottom`) leaf, layout
 *  px inward from the cell's box: a text leaf's line box (`textEdge`), a
 *  non-text leaf's own box, and every atom in it. */
function leafInk(leaf: { node: PMNode; el: Element }, box: DOMRect, side: 'top' | 'bottom', textEdge: number): number | null {
  let edge = Infinity;
  const take = (r: DOMRect) => {
    if (r.height <= 0.5) return;
    edge = Math.min(edge, side === 'top' ? r.top - box.top : box.bottom - r.bottom);
  };
  if (!isTextLeaf(leaf.node)) take(leaf.el.getBoundingClientRect());
  let atoms = 0;
  for (const atom of leaf.el.querySelectorAll(INK_ATOMS)) {
    atoms++;
    take(atom.getBoundingClientRect());
  }
  if (isTextLeaf(leaf.node) && (leaf.node.textContent.trim() || (!atoms && leaf.node.content.size))) edge = Math.min(edge, textEdge);
  return Number.isFinite(edge) ? edge : null;
}

/** Drawn px between two washes that do not join. */
const WASH_MIN_GAP = 3;

const pendingWash = new Set<Element>();
function scheduleWashPass(grid: Element | null) {
  if (!grid || pendingWash.has(grid)) return;
  pendingWash.add(grid);
  queueMicrotask(() => {
    pendingWash.delete(grid);
    if (grid.isConnected) atPaperSize(() => cellWashPass(grid as HTMLElement));
  });
}

let placeholderMeasure: { font: string; width: number } | null = null;
/** The full placeholder's width, layout px (style.css: 0.78em sans). */
function placeholderWidth(F: number): number {
  const sans = getComputedStyle(document.documentElement).getPropertyValue('--sans').trim() || 'sans-serif';
  const font = `400 ${(0.78 * F).toFixed(3)}px ${sans}`;
  if (placeholderMeasure?.font === font) return placeholderMeasure.width;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return 0;
  ctx.font = font;
  placeholderMeasure = { font, width: ctx.measureText(PLACEHOLDER).width };
  return placeholderMeasure.width;
}
const PLACEHOLDER = 'Type, or add an image';

function setVar(el: HTMLElement, name: string, value: string | null) {
  if (value === null) {
    if (el.style.getPropertyValue(name)) el.style.removeProperty(name);
  } else if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

const px = (v: number) => `${v.toFixed(3)}px`;

/** Row-equalize the cells' ink and place every wash edge (layout px). */
function cellWashPass(grid: HTMLElement) {
  const F = parseFloat(getComputedStyle(grid).fontSize) || 16.67;
  const g = (Number(grid.dataset.gutter) || 0) * F;
  const joinedGrid = (Number(grid.dataset.gutter) || 0) < JOINED_GUTTER_EM;
  const ps = paperScale() || 1;
  // style.css's air-y / air-x, in px: air between the ink and the wash.
  let reachEm = 0.33;
  const airX = Math.min(0.3 * F, g / 3);
  type Row = { el: HTMLElement; cells: Array<{ el: HTMLElement; box: DOMRect; ink: CellInk }>; T: number; B: number; textT: boolean; textB: boolean; airT: number; airB: number; joinT: boolean; joinB: boolean };
  const rows: Row[] = [];
  let heading = false;
  for (const child of grid.children) {
    if (!child.classList.contains('ts-grid-row')) continue;
    const cells: Row['cells'] = [];
    for (const cell of child.children) {
      const view = observedCells.get(cell);
      if (view?.ink) cells.push({ el: cell as HTMLElement, box: cell.getBoundingClientRect(), ink: view.ink });
    }
    if (!cells.length) continue;
    if (!rows.length) {
      heading = cells.some((c) => c.ink.heading);
      reachEm = cells[0].ink.reachEm;
    }
    const inked = cells.filter((c) => c.ink.top !== null && c.ink.bottom !== null);
    const T = inked.length ? Math.min(...inked.map((c) => c.box.top + c.ink.top!)) : Math.min(...cells.map((c) => c.box.top + c.ink.frameTop));
    const B = inked.length ? Math.max(...inked.map((c) => c.box.bottom - c.ink.bottom!)) : Math.max(...cells.map((c) => c.box.bottom - c.ink.frameBottom));
    // Whether the row's outermost ink, at that edge, is a line of text.
    const textT = inked.length > 0 && inked.every((c) => c.box.top + c.ink.top! > T + 0.01 || c.ink.topText);
    const textB = inked.length > 0 && inked.every((c) => c.box.bottom - c.ink.bottom! < B - 0.01 || c.ink.bottomText);
    rows.push({ el: child as HTMLElement, cells, T, B, textT, textB, airT: 0, airB: 0, joinT: false, joinB: false });
  }
  if (!rows.length) return;
  const airY = Math.min(0.25 * F, Math.max(0, (g - reachEm * F) / 3));
  // The grid's outer edges have no neighbour to keep clear of: at least
  // 0.3em, 0.45em beside a heading (the tiles then read as holding it).
  const airOut = Math.max(airY, airX, (heading ? 0.45 : 0.3) * F);
  for (const row of rows) row.airT = row.airB = airY;
  rows[0].airT = airOut;
  rows[rows.length - 1].airB = airOut;
  for (let i = 0; i + 1 < rows.length; i++) {
    // A page break between the rows (a gap widget) is not part of their
    // spacing; style.css un-joins the rows across it.
    let pageGap = 0;
    for (let el = rows[i].el.nextElementSibling; el && el !== rows[i + 1].el; el = el.nextElementSibling) pageGap += el.getBoundingClientRect().height;
    const gap = rows[i + 1].T - rows[i].B - pageGap;
    const air = Math.max(0, Math.min(airY, (gap - WASH_MIN_GAP / ps) / 2));
    const join = joinedGrid || airY <= 0 || air < 0.75 * airY;
    rows[i].airB = rows[i + 1].airT = join ? gap / 2 : air;
    rows[i].joinB = rows[i + 1].joinT = join;
  }
  // A grid edge that is a line of text takes the air its row has on the
  // other side, so the line sits centred in its tile: a line box already
  // holds its leading above the capitals and below the descenders, and the
  // larger outer air (for an image or a table edge, which have none) sat a
  // first or last line visibly off centre. A one-row grid of text: a small
  // fixed air, never less than a screen pixel.
  const textAir = Math.max(TEXT_AIR_EM * F, 1 / ps);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first.textT) first.airT = rows.length > 1 && first.textB ? Math.max(first.airB, 1 / ps) : textAir;
  if (last.textB) last.airB = rows.length > 1 && last.textT ? Math.max(last.airT, 1 / ps) : textAir;
  const full = placeholderWidth(F);
  for (const row of rows) {
    for (const { el, box } of row.cells) {
      setVar(el, '--ps', String(ps));
      setVar(el, '--cell-ink-top', px(row.T - box.top));
      setVar(el, '--cell-ink-bottom', px(box.bottom - row.B));
      setVar(el, '--air-t', px(row.airT));
      setVar(el, '--air-b', px(row.airB));
      setVar(el, '--air-out', px(airOut));
      setVar(el, '--rt', row.joinT ? '0' : '1');
      setVar(el, '--rb', row.joinB ? '0' : '1');
      setVar(el, '--seam-b', row.joinB ? 'var(--cell-line)' : null);
      // The placeholder (shown only in the active empty cell): the short
      // form where the full one would run out of the cell.
      setVar(el, '--ph', full > box.width - 0.6 * F ? '"Type\\2026"' : null);
    }
  }
}

/** Air between a line box and its wash where nothing sets it (em): the
 *  line box already holds the line's leading. */
const TEXT_AIR_EM = 0.12;

/** Below this gutter (em) the washes tile into one surface (style.css). */
export const JOINED_GUTTER_EM = 0.6;

// A new paper scale: the strokes divide by it.
onPaperScale((scale) => {
  for (const cell of liveCells) setVar(cell.dom, '--ps', String(scale));
});

/** One re-typeset per view for a burst of cell re-fits. */
const typesetPending = new WeakSet<EditorView>();
function scheduleTypesetSoon(view: EditorView) {
  if (typesetPending.has(view)) return;
  typesetPending.add(view);
  queueMicrotask(() => {
    typesetPending.delete(view);
    scheduleTypeset(view);
  });
}

/** The grid's editing decorations (classes only; the controls live in the
 *  block pill, block-chrome.ts). */
const gridEditingKey = new PluginKey('grid-editing');

export function gridPlugin(): Plugin {
  return new Plugin({
    key: gridEditingKey,
    // A new paper scale while a grid is selected: its decoration redraws
    // with the scale (a selection-free transaction, after the pass).
    view(view) {
      let frame = 0;
      const off = onPaperScale(() => {
        if (frame || !(view.state.selection instanceof NodeSelection) || view.state.selection.node.type !== schema.nodes.grid) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(gridEditingKey, 'scale'));
        });
      });
      return {
        destroy() {
          off();
          if (frame) cancelAnimationFrame(frame);
        },
      };
    },
    props: {
      decorations(state) {
        const ctx = gridContext(state);
        if (!ctx) return null;
        const selected = selectedCell(state, ctx);
        // Below JOINED_GUTTER_EM the washes tile into one surface split by
        // hairlines (style.css): read from the attribute, no geometry.
        const joined = (ctx.node.attrs.gutter as number) < JOINED_GUTTER_EM;
        const attrs: Record<string, string> = { class: joined ? 'ts-grid-editing ts-grid-joined' : 'ts-grid-editing' };
        // Selected as a block, its outline is drawn in screen px like a
        // table's: the grid carries the paper scale (its cells do already).
        if (state.selection instanceof NodeSelection && state.selection.from === ctx.pos) attrs.style = `--ps: ${paperScale() || 1}`;
        const decorations = [Decoration.node(ctx.pos, ctx.pos + ctx.node.nodeSize, attrs)];
        ctx.node.forEach((row, rowOff, rowIndex) => {
          row.forEach((cell, cellOff, columnIndex) => {
            const attrs: Record<string, string> = {};
            if (selected?.row === rowIndex && selected.cell === columnIndex) attrs.class = 'ts-grid-cell-active';
            if (cell.childCount === 1 && cell.firstChild?.type === schema.nodes.paragraph && !cell.firstChild.content.size) attrs['data-grid-empty'] = 'true';
            if (!Object.keys(attrs).length) return;
            const pos = ctx.pos + 2 + rowOff + cellOff;
            decorations.push(Decoration.node(pos, pos + cell.nodeSize, attrs));
          });
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}
