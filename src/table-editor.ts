// Native structured table editing.
//
// A table has exactly one editable representation: its ProseMirror rows,
// cells, paragraphs, and inline content. The old spreadsheet card copied
// cells into a parallel string grid and compiled a second visual table; that
// made ordinary typing modal and could flatten rich cell content on save.

import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import {
  CellSelection,
  TableMap,
  addColumnAfter as addColumnAfterNative,
  addColumnBefore as addColumnBeforeNative,
  addRowAfter,
  addRowBefore,
  deleteColumn as deleteColumnNative,
  deleteRow,
  deleteTable,
  addRow,
  goToNextCell,
  isInTable,
  mergeCells,
  removeColumn,
  removeRow,
  rowIsHeader,
  selectedRect,
  setCellAttr,
  splitCell,
  toggleHeaderRow,
} from 'prosemirror-tables';
import { closeHistory, isHistoryTransaction } from 'prosemirror-history';
import { isPortableCitationKey } from './bibtex';
import { ROW_RULE_CYCLE, type RowRule } from './table-rules';
import { CELL_FILL_CYCLE, type CellFill } from './table-fills';
import { schema } from './schema';
import { normalizeTableColumns } from './table-geometry';
import { onPaperScale, paperScale } from './paper-scale';
import { notify } from './notify';
import {
  transactionChangesDerivedStructure,
  type DerivedStructureRules,
} from './transaction-impact';

interface TableContext { pos: number; node: PMNode }

/** The table around the selection, or the table it node-selects (Escape
 *  from a cell selects the block; the pill and its panels stay). */
function tableContext(state: Pick<EditorState, 'selection'>): TableContext | null {
  const selection = state.selection;
  if (selection instanceof NodeSelection && selection.node.type.spec.tableRole === 'table') return { pos: selection.from, node: selection.node };
  const $pos = selection.$anchor;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.spec.tableRole === 'table') return { pos: $pos.before(depth), node };
  }
  return null;
}

/** Set attributes on the table at `pos` (the panel's writes: no scroll,
 *  the panel sits beside the table). `separateHistory`: an undo step of
 *  its own. False when no table is there any more. */
export function setTableAttrsAt(view: EditorView, pos: number, attrs: Record<string, unknown>, separateHistory = false): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.spec.tableRole !== 'table') return false;
  if (Object.entries(attrs).every(([name, value]) => JSON.stringify(node.attrs[name]) === JSON.stringify(value))) return true;
  const tr = view.state.tr;
  view.dispatch((separateHistory ? closeHistory(tr) : tr).setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
  return true;
}

/** A label as Typst accepts it: letters, digits, `:._-`, starting with a
 *  letter or digit, at most 128 characters. */
export function normalizeTableLabel(text: string): string {
  return text.replace(/[^A-Za-z0-9:._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128);
}

export function setTableStyle(style: 'booktabs' | 'grid' | 'plain'): Command {
  return (state, dispatch) => {
    const context = tableContext(state);
    if (!context) return false;
    if (dispatch && context.node.attrs.style !== style) {
      dispatch(state.tr.setNodeMarkup(context.pos, undefined, { ...context.node.attrs, style }));
    }
    return true;
  };
}

/** Column widths address logical columns, including columns covered by a merge. */
function explicitColumnWidths(table: PMNode, count: number): string[] | null {
  const stored = normalizeTableColumns(table.attrs.columnWidths);
  if (!stored) return null;
  return Array.from({ length: count }, (_, index) => String(stored[index] ?? 'auto'));
}

function insertColumnWithWidth(side: 'before' | 'after'): Command {
  const command = side === 'before' ? addColumnBeforeNative : addColumnAfterNative;
  return (state, dispatch) => {
    if (!dispatch) return command(state);
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const widths = explicitColumnWidths(rect.table, rect.map.width);
    return command(state, (tr) => {
      if (widths) {
        widths.splice(side === 'before' ? rect.left : rect.right, 0, 'auto');
        const pos = rect.tableStart - 1;
        const table = tr.doc.nodeAt(pos)!;
        tr.setNodeMarkup(pos, undefined, { ...table.attrs, columnWidths: widths });
      }
      dispatch(tr);
    });
  };
}

export const addColumnBefore = insertColumnWithWidth('before');
export const addColumnAfter = insertColumnWithWidth('after');

/** Set every selected logical column; a caret in a merged cell selects its span. */
export function setSelectedColumnWidth(width: string): Command {
  return (state, dispatch) => {
    if (!isInTable(state) || !normalizeTableColumns([width])) return false;
    const rect = selectedRect(state);
    if (dispatch) {
      const widths = explicitColumnWidths(rect.table, rect.map.width) ?? Array(rect.map.width).fill('auto');
      for (let index = rect.left; index < rect.right; index++) widths[index] = width;
      if (JSON.stringify(widths) !== JSON.stringify(rect.table.attrs.columnWidths)) {
        dispatch(closeHistory(state.tr).setNodeMarkup(rect.tableStart - 1, undefined, { ...rect.table.attrs, columnWidths: widths }));
      }
    }
    return true;
  };
}

export function alignSelectedTableCells(align: 'left' | 'center' | 'right' | null): Command {
  return setCellAttr('align', align);
}

/** Put a native caret in the table at a document position. */
export function focusTable(view: EditorView, pos: number): void {
  const table = view.state.doc.nodeAt(pos);
  if (!table || table.type.spec.tableRole !== 'table') return;
  const firstCell = TableMap.get(table).map[0];
  if (firstCell === undefined) return;
  const cellPos = pos + 1 + firstCell;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(cellPos + 1), 1)).scrollIntoView());
  view.focus();
}

/** Insert a 3 x 3 semantic table and start typing directly in its first cell. */
export function insertStructuredTable(view: EditorView): void {
  const { table, table_row, table_cell, table_header, paragraph } = schema.nodes;
  const cell = (header: boolean, text = '') => (header ? table_header : table_cell).create(
    null,
    paragraph.create(null, text ? schema.text(text) : undefined),
  );
  const node = table.create({ style: 'booktabs' }, [
    table_row.create(null, [cell(true), cell(true), cell(true)]),
    table_row.create(null, [cell(false), cell(false), cell(false)]),
    table_row.create(null, [cell(false), cell(false), cell(false)]),
  ]);
  const { $from } = view.state.selection;
  const insertPos = $from.depth > 0 ? $from.after(1) : view.state.selection.to;
  const tr = view.state.tr.insert(insertPos, node);
  const inserted = tr.doc.nodeAt(insertPos);
  if (!inserted) return;
  // The caret lands in the first (empty) header cell.
  const firstCell = TableMap.get(inserted).map[0];
  const cellPos = insertPos + 1 + firstCell;
  const firstNode = tr.doc.nodeAt(cellPos)!;
  tr.setSelection(TextSelection.between(tr.doc.resolve(cellPos + 1), tr.doc.resolve(cellPos + firstNode.nodeSize - 1)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** The rule under the selected rows, cycled: preset → light → heavy →
 *  none. Every selected row takes the value after the first row's. Grid
 *  tables draw cell strokes instead and have no row rules. */
export const cycleRowRule: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  let rect: ReturnType<typeof selectedRect>;
  try {
    rect = selectedRect(state);
  } catch {
    return false;
  }
  if (rect.table.attrs.style === 'grid') return false;
  if (!dispatch) return true;
  const first = rect.table.child(rect.top);
  const current = (first.attrs.rule as RowRule) || '';
  const next = ROW_RULE_CYCLE[(ROW_RULE_CYCLE.indexOf(current) + 1) % ROW_RULE_CYCLE.length];
  const tr = state.tr;
  rect.table.forEach((row, offset, i) => {
    if (i >= rect.top && i < rect.bottom) tr.setNodeMarkup(rect.tableStart + offset, undefined, { ...row.attrs, rule: next });
  });
  dispatch(tr);
  return true;
};

/** The fill of the selected cells, cycled: none → gray → yellow → blue.
 *  Every selected cell takes the value after the anchor cell's. */
export const cycleCellFill: Command = (state, dispatch, view) => {
  if (!isInTable(state)) return false;
  const current = selectedCellFill(state);
  if (current === null) return false;
  const next = CELL_FILL_CYCLE[(CELL_FILL_CYCLE.indexOf(current) + 1) % CELL_FILL_CYCLE.length];
  return setCellAttr('fill', next)(state, dispatch, view);
};

/** Set the rule under every selected row to one preset (the block pill's
 *  Cell panel; cycleRowRule, the retired bar's cycle, is kept as an export). Grid tables draw cell
 *  strokes instead and have no row rules. */
export function setRowRule(rule: RowRule): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    let rect: ReturnType<typeof selectedRect>;
    try {
      rect = selectedRect(state);
    } catch {
      return false;
    }
    if (rect.table.attrs.style === 'grid') return false;
    if (!dispatch) return true;
    const tr = state.tr;
    rect.table.forEach((row, offset, i) => {
      if (i >= rect.top && i < rect.bottom && (row.attrs.rule || '') !== rule) tr.setNodeMarkup(rect.tableStart + offset, undefined, { ...row.attrs, rule });
    });
    if (tr.docChanged) dispatch(tr);
    return true;
  };
}

/** Every column back to automatic width (columnWidths = null). */
export const resetTableColumnWidths: Command = (state, dispatch) => {
  const context = tableContext(state);
  if (!context || context.node.attrs.columnWidths == null) return false;
  if (dispatch) dispatch(closeHistory(state.tr).setNodeMarkup(context.pos, undefined, { ...context.node.attrs, columnWidths: null }));
  return true;
};

/** One attribute of every selected cell (each merged cell once): the
 *  shared value, or 'mixed'; null outside a table. */
export function selectedCellsAttr(state: EditorState, name: 'align' | 'valign' | 'fill' | 'borderColor'): string | null {
  if (!isInTable(state)) return null;
  try {
    const rect = selectedRect(state);
    const cells = new Set<number>();
    for (let row = rect.top; row < rect.bottom; row++) {
      for (let column = rect.left; column < rect.right; column++) cells.add(rect.map.map[row * rect.map.width + column]);
    }
    const values = [...cells].map((offset) => String(rect.table.nodeAt(offset)?.attrs[name] ?? ''));
    return values.every((value) => value === values[0]) ? values[0] ?? '' : 'mixed';
  } catch {
    return null;
  }
}

/** The selected columns' shared width ('auto', '2fr', '72pt') or 'mixed',
 *  and whether any column of the table takes a share. */
export function selectedColumnWidth(state: EditorState): { width: string; columns: number; anyShare: boolean; custom: boolean } | null {
  if (!isInTable(state)) return null;
  try {
    const rect = selectedRect(state);
    const stored = explicitColumnWidths(rect.table, rect.map.width);
    const widths = stored ?? Array(rect.map.width).fill('auto');
    const selected = widths.slice(rect.left, rect.right);
    return {
      width: selected.every((value) => value === selected[0]) ? selected[0] : 'mixed',
      columns: rect.right - rect.left,
      anyShare: widths.some((value) => value.endsWith('fr')),
      custom: stored !== null,
    };
  } catch {
    return null;
  }
}

/** The caret's cell as a resolved position (the anchor cell of a cell
 *  selection), for Select row / Select column. */
function anchorCell(state: EditorState) {
  const rect = selectedRect(state);
  return state.doc.resolve(rect.tableStart + rect.map.map[rect.top * rect.map.width + rect.left]);
}

/** Select the caret's whole row / column as a cell selection. */
export function selectTableLine(axis: 'row' | 'col'): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    let $cell: ResolvedPos;
    try {
      $cell = anchorCell(state);
    } catch {
      return false;
    }
    if (dispatch) dispatch(state.tr.setSelection(axis === 'row' ? CellSelection.rowSelection($cell) : CellSelection.colSelection($cell)));
    return true;
  };
}

/** Whether the selection's first row is a header row. */
export function selectedRowIsHeader(state: EditorState): boolean {
  if (!isInTable(state)) return false;
  try {
    const rect = selectedRect(state);
    return rowIsHeader(rect.map, rect.table, rect.top);
  } catch {
    return false;
  }
}

/** Rows in the selection's table (0 outside one). */
export function selectedTableRows(state: EditorState): number {
  if (!isInTable(state)) return 0;
  try {
    return selectedRect(state).map.height;
  } catch {
    return 0;
  }
}

/** The fill preset of the anchor cell, for the control's label. */
export function selectedCellFill(state: EditorState): CellFill | null {
  if (!isInTable(state)) return null;
  try {
    const rect = selectedRect(state);
    const offset = rect.map.map[rect.top * rect.map.width + rect.left];
    return (rect.table.nodeAt(offset)?.attrs.fill as CellFill) || '';
  } catch {
    return null;
  }
}

/** The rule preset of the first selected row, for the control's label. */
export function selectedRowRule(state: EditorState): RowRule | null {
  if (!isInTable(state)) return null;
  try {
    const rect = selectedRect(state);
    return (rect.table.child(rect.top).attrs.rule as RowRule) || '';
  } catch {
    return null;
  }
}

/**
 * Span-aware deletion. prosemirror-tables' deleteRow/deleteColumn remove
 * every row or column the selection's rectangle covers — and a text caret
 * inside a merged cell covers the whole span, so deleting "the column" from
 * inside a two-column cell took both columns. With a caret, only the cell's
 * first row or column goes (the merged cell shrinks by one, as in a
 * spreadsheet); a cell selection still removes exactly what it covers. The
 * last row or column deletes the table.
 */
function deleteSpanAware(axis: 'row' | 'col'): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    let rect: ReturnType<typeof selectedRect>;
    try {
      rect = selectedRect(state);
    } catch {
      return false;
    }
    const whole = state.selection instanceof CellSelection;
    const size = axis === 'row' ? rect.map.height : rect.map.width;
    const from = axis === 'row' ? rect.top : rect.left;
    const to = whole ? (axis === 'row' ? rect.bottom : rect.right) : from + 1;
    if (!dispatch) return true;
    if (from === 0 && to === size) return deleteTable(state, dispatch);
    const tr = state.tr;
    for (let i = to - 1; i >= from; i--) {
      // Re-read the table each step: the map changes with every removal.
      const table = tr.doc.nodeAt(rect.tableStart - 1)!;
      const live = { ...rect, map: TableMap.get(table), table };
      if (axis === 'row') removeRow(tr, live, i);
      else removeColumn(tr, live, i);
    }
    if (axis === 'col') {
      const widths = explicitColumnWidths(rect.table, rect.map.width);
      if (widths) {
        widths.splice(from, to - from);
        const table = tr.doc.nodeAt(rect.tableStart - 1)!;
        tr.setNodeMarkup(rect.tableStart - 1, undefined, { ...table.attrs, columnWidths: widths });
      }
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}
export const deleteSelectedRows = deleteSpanAware('row');
export const deleteSelectedColumns = deleteSpanAware('col');

export const deleteColumn: Command = (state, dispatch) => {
  if (!dispatch) return deleteColumnNative(state);
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const widths = explicitColumnWidths(rect.table, rect.map.width);
  return deleteColumnNative(state, (tr) => {
    if (widths && rect.right - rect.left < rect.map.width) {
      widths.splice(rect.left, rect.right - rect.left);
      const table = tr.doc.nodeAt(rect.tableStart - 1)!;
      tr.setNodeMarkup(rect.tableStart - 1, undefined, { ...table.attrs, columnWidths: widths });
    }
    dispatch(tr);
  });
};

/** A row added below the selection. Below a header row it is a body row —
 *  the library would clone the header type and stack a second header. */
export const addBodyRowAfter: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  let rect: ReturnType<typeof selectedRect>;
  try {
    rect = selectedRect(state);
  } catch {
    return false;
  }
  if (!dispatch) return true;
  const tr = addRow(state.tr, rect, rect.bottom);
  if (rowIsHeader(rect.map, rect.table, rect.bottom - 1)) {
    const table = tr.doc.nodeAt(rect.tableStart - 1)!;
    const map = TableMap.get(table);
    const seen = new Set<number>();
    for (let col = 0; col < map.width; col++) {
      const offset = map.map[rect.bottom * map.width + col];
      if (seen.has(offset)) continue;
      seen.add(offset);
      const cell = table.nodeAt(offset)!;
      // A cell that spans down from the header is not the new row's own.
      if (map.colCount(offset) !== undefined && map.findCell(offset).top !== rect.bottom) continue;
      if (cell.type.name === 'table_header') tr.setNodeMarkup(rect.tableStart + offset, schema.nodes.table_cell, cell.attrs);
    }
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/** Run a command that dispatches through a callback and hand back its
 *  transaction (null when it did not apply). */
function captured(command: Command, state: EditorState): Transaction | null {
  let out: Transaction | null = null;
  return command(state, (tr) => { out = tr; }) ? out : null;
}

/** The caret at the start of the cell covering (row, column) of the table
 *  that starts at `tableStart` in `tr`'s document. */
function caretToCell(tr: Transaction, tableStart: number, row: number, column: number): Transaction {
  const table = tr.doc.nodeAt(tableStart - 1);
  if (!table) return tr;
  const map = TableMap.get(table);
  const offset = map.map[Math.min(row, map.height - 1) * map.width + Math.min(column, map.width - 1)];
  return offset === undefined ? tr : tr.setSelection(TextSelection.near(tr.doc.resolve(tableStart + offset + 1)));
}

/** A row above or below the selection (below a header row, a body row);
 *  the caret lands in the new row, in the selection's first column, as it
 *  does in a grid (the pill's Rows menu, ⌘⏎ / ⇧⌘⏎). */
export function insertTableRow(side: 'above' | 'below'): Command {
  const command = side === 'above' ? addRowBefore : addBodyRowAfter;
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (!dispatch) return command(state);
    let rect: ReturnType<typeof selectedRect>;
    try {
      rect = selectedRect(state);
    } catch {
      return false;
    }
    const tr = captured(command, state);
    if (!tr) return false;
    dispatch(caretToCell(tr, rect.tableStart, side === 'above' ? rect.top : rect.bottom, rect.left).scrollIntoView());
    return true;
  };
}

/** A column left or right of the selection (column widths kept); the
 *  caret lands in the new column, in the selection's first row. */
export function insertTableColumn(side: 'left' | 'right'): Command {
  const command = side === 'left' ? addColumnBefore : addColumnAfter;
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (!dispatch) return command(state);
    let rect: ReturnType<typeof selectedRect>;
    try {
      rect = selectedRect(state);
    } catch {
      return false;
    }
    const tr = captured(command, state);
    if (!tr) return false;
    dispatch(caretToCell(tr, rect.tableStart, rect.top, side === 'left' ? rect.left : rect.right).scrollIntoView());
    return true;
  };
}

/** Select a cell's whole content, as Tab does when it lands in one. */
function selectCell(tr: Transaction, cellPos: number): Transaction {
  const cell = tr.doc.nodeAt(cellPos);
  if (!cell) return tr;
  return tr.setSelection(TextSelection.between(tr.doc.resolve(cellPos + 1), tr.doc.resolve(cellPos + cell.nodeSize - 1)));
}

/** Tab in a table: the next cell; from the last cell, a new row — the
 *  spreadsheet habit, so a table grows under the fingers. */
export const tabInTable: Command = (state, dispatch, view) => {
  if (!isInTable(state)) return false;
  if (goToNextCell(1)(state, dispatch)) return true;
  if (!addBodyRowAfter(state, dispatch)) return false;
  if (view) goToNextCell(1)(view.state, view.dispatch);
  return true;
};

/** Enter in a cell: the cell below, in the same column; from the last row,
 *  a new row. (A line break inside a cell is Shift-Enter.) */
export const enterInTable: Command = (state, dispatch, view) => {
  if (!isInTable(state)) return false;
  let rect: ReturnType<typeof selectedRect>;
  try {
    rect = selectedRect(state);
  } catch {
    return false;
  }
  const { map, tableStart } = rect;
  if (rect.bottom >= map.height) {
    if (!addBodyRowAfter(state, dispatch)) return false;
    if (view) {
      const next = selectedRect(view.state);
      const below = next.map.map[(next.bottom) * next.map.width + next.left];
      view.dispatch(selectCell(view.state.tr, next.tableStart + below).scrollIntoView());
    }
    return true;
  }
  const below = map.map[rect.bottom * map.width + rect.left];
  if (dispatch) dispatch(selectCell(state.tr, tableStart + below).scrollIntoView());
  return true;
};

/** ArrowDown from the last row (ArrowUp from the first) with nowhere to go:
 *  step out of the table into the block after (before) it, creating a
 *  paragraph when the table ends the document. Runs after the geometric
 *  caret motion has found no line to land on. */
export function exitTableVertically(dir: -1 | 1): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    let rect: ReturnType<typeof selectedRect>;
    try {
      rect = selectedRect(state);
    } catch {
      return false;
    }
    if (dir > 0 ? rect.bottom < rect.map.height : rect.top > 0) return false;
    const tablePos = rect.tableStart - 1;
    const table = state.doc.nodeAt(tablePos);
    if (!table) return false;
    const edge = dir > 0 ? tablePos + table.nodeSize : tablePos;
    if (!dispatch) return true;
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

// The editor enforces the same lossless subset as the Typst serializer.
const TABLE_CELL_MARKS = new Set(['strong', 'em', 'strike', 'code', 'value', 'color']);
/** The marks a formula in a cell may carry: the run marks the Typst
 *  serializer wraps (its RUN_MARKS) and the reader gives back. */
const TABLE_CELL_MATH_MARKS = new Set(['strong', 'em', 'strike', 'color']);
const TABLE_CELL_INLINE = new Set(['text', 'hard_break', 'math_inline', 'eq_ref', 'citation']);

const tableIssueCache = new WeakMap<PMNode, string | null>();

/** A node or mark name as a writer reads it (`code_block` → `code block`).
 *  The refusals are short: the toast is one line at the narrowest window. */
const spoken = (name: string) => name.replace(/_/g, ' ');

function tableCellIssue(table: PMNode): string | null {
  const cached = tableIssueCache.get(table);
  if (cached !== undefined || tableIssueCache.has(table)) return cached ?? null;
  let issue: string | null = null;
  table.descendants((node) => {
    if (issue) return false;
    if (node.type.spec.tableRole !== 'cell' && node.type.spec.tableRole !== 'header_cell') return true;
    node.forEach((block) => {
      if (issue) return;
      if (block.type.name !== 'paragraph') {
        issue = `${spoken(block.type.name)}s can’t go in a table cell`;
        return;
      }
      if (block.attrs.keep || block.attrs.align) {
        issue = 'paragraph alignment can’t go in a table cell';
        return;
      }
      block.descendants((inline) => {
        if (issue) return false;
        if (!TABLE_CELL_INLINE.has(inline.type.name)) {
          issue = `${spoken(inline.type.name)}s can’t go in a table cell`;
          return false;
        }
        const marks = inline.marks.map((mark) => mark.type.name);
        const unsupported = marks.find((mark) => !TABLE_CELL_MARKS.has(mark));
        if (unsupported) {
          issue = `${spoken(unsupported)} marks can’t go in a table cell`;
          return false;
        }
        if (!inline.isText && marks.length && !(inline.type.name === 'math_inline' && marks.every((mark) => TABLE_CELL_MATH_MARKS.has(mark)))) {
          issue = `formatted ${spoken(inline.type.name)}s can’t go in a table cell`;
          return false;
        }
        if (marks.includes('code') && marks.length > 1) {
          issue = 'code with another mark can’t go in a table cell';
          return false;
        }
        const source = inline.isText ? inline.text ?? '' : inline.type.name === 'math_inline' ? String(inline.attrs.src ?? '') : '';
        if (/[\r\n]/.test(source)) {
          issue = 'a line break inside inline content can’t go in a table cell';
          return false;
        }
        if (inline.type.name === 'citation') {
          const key = String(inline.attrs.key ?? '');
          if (!isPortableCitationKey(key)) {
            issue = `citation ${JSON.stringify(key)} isn’t portable Typst`;
            return false;
          }
        }
        return true;
      });
    });
    return false;
  });
  tableIssueCache.set(table, issue);
  return issue;
}

/** A refused edit is said in the app's one toast (notify.ts → #toast). */
function announceTableConstraint(issue: string): void {
  notify(`Not applied: ${issue}`);
}

function tablesTouchedBy(transaction: Transaction): Map<PMNode, number> {
  const touched = new Map<PMNode, number>();
  const size = transaction.doc.content.size;
  transaction.mapping.maps.forEach((stepMap, index) => {
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      // Map early-step coordinates through the remaining steps so the range
      // addresses the transaction's final document.
      const rest = transaction.mapping.slice(index + 1);
      const mappedStart = rest.map(newStart, -1);
      const mappedEnd = rest.map(newEnd, 1);
      const from = Math.max(0, Math.min(mappedStart, mappedEnd) - 1);
      const to = Math.min(size, Math.max(mappedStart, mappedEnd) + 1);
      if (to < from) return;
      transaction.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.spec.tableRole === 'table') {
          touched.set(node, pos);
          return false;
        }
        return true;
      });
    });
  });
  // Attribute-only and selection-preserving structural commands can expose a
  // zero-width map. The selected table is the exact cheap fallback target.
  const selected = tableContext({ selection: transaction.selection });
  if (selected) touched.set(selected.node, selected.pos);
  return touched;
}

function keepsUnsupportedTablesVerbatim(before: PMNode, transaction: Transaction): { ok: boolean; issue?: string } {
  // An undo/redo transaction can legitimately reinsert an unsupported legacy
  // table that was already part of this editor session. Such content never
  // entered history through this guard (the introducing edit would have been
  // rejected), so restoring it is safe and must not make undo lie about
  // succeeding while leaving the document changed.
  if (isHistoryTransaction(transaction)) return { ok: true };
  const changedUnsupported: Array<{ node: PMNode; issue: string }> = [];
  for (const table of tablesTouchedBy(transaction).keys()) {
    const issue = tableCellIssue(table);
    if (issue) changedUnsupported.push({ node: table, issue });
  }
  if (!changedUnsupported.length) return { ok: true };

  // Slow path only for a transaction that actually contains unsupported cell
  // content. Unchanged legacy tables retain node identity and may be moved or
  // deleted; a newly introduced or edited unsupported table is rejected.
  const priorTables = new Set<PMNode>();
  before.descendants((node) => {
    if (node.type.spec.tableRole === 'table') {
      priorTables.add(node);
      return false;
    }
    return true;
  });
  const changed = changedUnsupported.find(({ node }) => !priorTables.has(node));
  return changed ? { ok: false, issue: changed.issue } : { ok: true };
}

interface NativeTablePluginState {
  decorations: DecorationSet;
  /** Changes only when controls-relevant metadata or topology changes. */
  controlsRevision: number;
}

const tableControlsKey = new PluginKey<NativeTablePluginState>('native-table-controls');

/** The tables' structure revision: bumps only when a table's attributes,
 *  rows, columns or cell attributes change, never for text typed in a cell
 *  (the block pill re-measures and refreshes on it). */
export function tableControlsRevision(state: EditorState): number {
  return tableControlsKey.getState(state)?.controlsRevision ?? 0;
}

// Table text is intentionally absent. A character edit leaves every command,
// select, and metadata field unchanged, so the plugin view can retain its
// semantic UI and defer only a possible geometry adjustment. Structural
// commands and table metadata remain explicit, transaction-local revisions.
const TABLE_CONTROL_STRUCTURE: DerivedStructureRules = {
  table: {
    attrs: ['style', 'params', 'caption', 'label', 'fontSize', 'density', 'columnWidths', 'insetPt'],
    structure: {
      table_row: ['rule'],
      table_cell: ['colspan', 'rowspan', 'colwidth', 'align', 'valign', 'fill'],
      table_header: ['colspan', 'rowspan', 'colwidth', 'align', 'valign', 'fill'],
    },
  },
};

interface CaptionDecorationSpec {
  nativeTableCaptionWidget: true;
  id: string;
  caption: string;
  label: string;
  number: number;
}

interface CaptionOwnerDecorationSpec {
  nativeTableCaptionOwner: true;
  id: string;
}

let nextTableCaptionId = 1;

function captionWidget(pos: number, caption: string, label: string, number: number, id: string): Decoration {
  const text = caption ? `Table ${number}: ${caption}` : `Table ${number}`;
  const spec: CaptionDecorationSpec = { nativeTableCaptionWidget: true, id, caption, label, number };
  return Decoration.widget(pos, () => {
    const element = document.createElement('div');
    element.className = 'native-table-caption';
    element.id = id;
    element.setAttribute('role', 'note');
    element.contentEditable = 'false';
    element.textContent = text;
    return element;
  }, { side: -1, key: `table-caption-${id}-${text}`, ...spec });
}

function captionDecorationPair(
  pos: number,
  table: PMNode,
  caption: string,
  label: string,
  number: number,
  id = `native-table-caption-${nextTableCaptionId++}`,
): Decoration[] {
  const end = pos + table.nodeSize;
  const owner: CaptionOwnerDecorationSpec = { nativeTableCaptionOwner: true, id };
  return [
    Decoration.node(pos, end, { 'aria-describedby': id }, owner),
    captionWidget(end, caption, label, number, id),
  ];
}

function captionDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  let tableNumber = 0;
  doc.descendants((node, pos) => {
    if (node.type.spec.tableRole !== 'table') return true;
    const caption = String(node.attrs.caption ?? '');
    const label = String(node.attrs.label ?? '');
    if (caption || label) {
      tableNumber++;
      decorations.push(...captionDecorationPair(pos, node, caption, label, tableNumber));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function tableNumberAt(doc: PMNode, targetPos: number): number {
  let number = 0;
  doc.descendants((node, pos) => {
    if (pos > targetPos) return false;
    if (node.type.spec.tableRole !== 'table') return true;
    if (node.attrs.caption || node.attrs.label) number++;
    return false;
  });
  return number;
}

function updateCaptionDecorations(
  transaction: Transaction,
  decorations: DecorationSet,
  oldState: EditorState,
  newState: EditorState,
): DecorationSet {
  let mapped = decorations.map(transaction.mapping, transaction.doc);
  const before = tableContext(oldState);
  const after = tableContext({ selection: transaction.selection });
  const touched = tablesTouchedBy(transaction);
  const beforeCaptioned = before && (before.node.attrs.caption || before.node.attrs.label) ? 1 : 0;
  const afterCaptioned = [...touched.keys()].filter((node) => node.attrs.caption || node.attrs.label).length;

  // Adding/removing a numbered table changes every later table number. Those
  // metadata/structure operations are rare, so rebuild then; ordinary typing
  // only maps and checks the one touched table instead of scanning the doc.
  if (beforeCaptioned !== afterCaptioned || (beforeCaptioned && !after) || touched.size > 1) {
    return captionDecorations(newState.doc);
  }

  for (const [table, pos] of touched) {
    const end = pos + table.nodeSize;
    const caption = String(table.attrs.caption ?? '');
    const label = String(table.attrs.label ?? '');
    const existing = mapped.find(
      Math.max(0, end - 1),
      Math.min(newState.doc.content.size, end + 1),
      (spec) => (spec as Partial<CaptionDecorationSpec>).nativeTableCaptionWidget === true,
    );
    const current = existing[0]?.spec as Partial<CaptionDecorationSpec> | undefined;
    if (current?.caption === caption && current.label === label) continue;
    if (current?.id) {
      const pair = mapped.find(
        Math.max(0, pos),
        Math.min(newState.doc.content.size, end + 1),
        (spec) =>
          (spec as Partial<CaptionDecorationSpec | CaptionOwnerDecorationSpec>).id === current.id,
      );
      if (pair.length) mapped = mapped.remove(pair);
    } else if (existing.length) {
      mapped = mapped.remove(existing);
    }
    if (caption || label) {
      const number = current?.number ?? tableNumberAt(newState.doc, pos);
      mapped = mapped.add(
        newState.doc,
        captionDecorationPair(pos, table, caption, label, number, current?.id),
      );
    }
  }
  return mapped;
}

/** Editing chrome for the table under the selection (paint only,
 * style.css): `ts-table-editing` on the table, `ts-cell-active` on the
 * cell under the caret (none while a cell selection draws its own overlay)
 * and, in a Plain table, `ts-cell-col0` on the cells in its first column,
 * which draw the ghost's left edge (a row's first DOM cell is not one when
 * a rowspan above covers column 0). Classes only, recomputed from the
 * selection (the map is cached per table node); nothing is measured. */
function editingDecorations(state: EditorState): Decoration[] {
  const context = tableContext(state);
  if (!context) return [];
  const out = [Decoration.node(context.pos, context.pos + context.node.nodeSize, { class: 'ts-table-editing' })];
  if (context.node.attrs.style === 'plain') {
    const map = TableMap.get(context.node);
    const start = context.pos + 1;
    let previous = -1;
    for (let row = 0; row < map.height; row++) {
      const offset = map.map[row * map.width];
      if (offset === previous) continue;
      previous = offset;
      const cell = context.node.nodeAt(offset);
      if (cell) out.push(Decoration.node(start + offset, start + offset + cell.nodeSize, { class: 'ts-cell-col0' }));
    }
  }
  if (state.selection instanceof CellSelection) return out;
  const $head = state.selection.$head;
  for (let depth = $head.depth; depth > 2; depth--) {
    const role = $head.node(depth).type.spec.tableRole;
    if (role !== 'cell' && role !== 'header_cell') continue;
    if ($head.before(depth - 2) === context.pos) {
      const cell = $head.before(depth);
      out.push(Decoration.node(cell, cell + $head.node(depth).nodeSize, { class: 'ts-cell-active' }));
    }
    break;
  }
  return out;
}

/** The edited table carries the paper scale (`--ps`), so its ring stays one
 * screen px under the stack's transform. TableView ignores attribute writes
 * on its table element; only a changed value is written. */
class TableEditingPaint {
  private table: HTMLElement | null = null;
  private readonly unlisten: () => void;

  constructor(private readonly view: EditorView) {
    this.unlisten = onPaperScale(() => this.write());
    this.update();
  }

  update(): void {
    const context = tableContext(this.view.state);
    const dom = context ? this.view.nodeDOM(context.pos) : null;
    this.table = dom instanceof HTMLElement && dom.tagName === 'TABLE' ? dom : null;
    this.write();
  }

  private write(): void {
    const value = String(paperScale());
    if (this.table && this.table.style.getPropertyValue('--ps') !== value) this.table.style.setProperty('--ps', value);
  }

  destroy(): void {
    this.unlisten();
  }
}

/** Captions, the editing-chrome classes, and the lossless table-cell guard.
 *  The controls live in the block pill (block-chrome.ts). */
export function structuredTablePlugin(): Plugin {
  return new Plugin<NativeTablePluginState>({
    key: tableControlsKey,
    state: {
      init: (_config, state) => ({
        decorations: captionDecorations(state.doc),
        controlsRevision: 0,
      }),
      apply: (transaction, value, oldState, newState) => {
        if (!transaction.docChanged) return value;
        return {
          decorations: updateCaptionDecorations(
            transaction,
            value.decorations,
            oldState,
            newState,
          ),
          controlsRevision:
            value.controlsRevision +
            (transactionChangesDerivedStructure(transaction, TABLE_CONTROL_STRUCTURE) ? 1 : 0),
        };
      },
    },
    filterTransaction(transaction, state) {
      if (!transaction.docChanged) return true;
      const result = keepsUnsupportedTablesVerbatim(state.doc, transaction);
      if (!result.ok) announceTableConstraint(result.issue ?? 'that content can’t go in a table cell');
      return result.ok;
    },
    props: {
      decorations: (state) => {
        const captions = tableControlsKey.getState(state)?.decorations ?? null;
        const editing = editingDecorations(state);
        if (!editing.length) return captions;
        return (captions ?? DecorationSet.empty).add(state.doc, editing);
      },
    },
    view: (view) => {
      const paint = new TableEditingPaint(view);
      return {
        update: () => paint.update(),
        destroy: () => paint.destroy(),
      };
    },
  });
}

export {
  CellSelection,
  addRowAfter,
  deleteRow,
  deleteTable,
  mergeCells,
  splitCell,
  toggleHeaderRow,
};
