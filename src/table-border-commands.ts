// The cell panel's Border row (block-chrome.ts): borders set on the
// selected cells, as a spreadsheet sets them. All boxes every selected
// cell; Outside draws the selection's outline; Top, Bottom, Left and Right
// turn that edge of the selection on, or off when it is all on already;
// None takes every line in and round the selection away.
//
// A line between two cells can be either cell's (the upper cell's bottom
// or the lower cell's top, table-borders.ts): one weight, so the page and
// the print show it the same. An edge turned on goes on the selected
// cell's side; turned off, both sides lose it, so it is really gone.

import type { Command, EditorState } from 'prosemirror-state';
import { isInTable, selectedRect, type TableRect } from 'prosemirror-tables';
import { borderSides, borderValue, type BorderSide } from './table-borders';

export type BorderAction = 'all' | 'outside' | 'none' | BorderSide;

interface Edits {
  rect: TableRect;
  /** Cell offset (from tableStart) → its sides, as edited so far. */
  sides: Map<number, Set<BorderSide>>;
}

function begin(state: EditorState): Edits | null {
  if (!isInTable(state)) return null;
  try {
    const rect = selectedRect(state);
    if (rect.table.attrs.style === 'grid') return null;
    return { rect, sides: new Map() };
  } catch {
    return null;
  }
}

function sidesOf(e: Edits, offset: number): Set<BorderSide> {
  let set = e.sides.get(offset);
  if (!set) {
    set = borderSides(String(e.rect.table.nodeAt(offset)?.attrs.border ?? '')) ?? new Set();
    e.sides.set(offset, set);
  }
  return set;
}

/** The cell at grid position (row, col), with its own rectangle. */
function cellAt(e: Edits, row: number, col: number) {
  const { map } = e.rect;
  if (row < 0 || col < 0 || row >= map.height || col >= map.width) return null;
  const offset = map.map[row * map.width + col];
  return { offset, box: map.findCell(offset) };
}

/** The two cells either side of one edge segment: horizontal at row
 *  boundary `y` over column `c`, or vertical at column boundary `x` beside
 *  row `r`. Each only when its own edge lies on the boundary. */
function sidesAt(e: Edits, axis: 'h' | 'v', line: number, at: number) {
  if (axis === 'h') {
    const before = cellAt(e, line - 1, at);
    const after = cellAt(e, line, at);
    return {
      before: before && before.box.bottom === line ? { offset: before.offset, side: 'bottom' as const } : null,
      after: after && after.box.top === line ? { offset: after.offset, side: 'top' as const } : null,
    };
  }
  const before = cellAt(e, at, line - 1);
  const after = cellAt(e, at, line);
  return {
    before: before && before.box.right === line ? { offset: before.offset, side: 'right' as const } : null,
    after: after && after.box.left === line ? { offset: after.offset, side: 'left' as const } : null,
  };
}

function edgeOn(e: Edits, axis: 'h' | 'v', line: number, at: number): boolean {
  const { before, after } = sidesAt(e, axis, line, at);
  return Boolean((before && sidesOf(e, before.offset).has(before.side)) || (after && sidesOf(e, after.offset).has(after.side)));
}

/** Turn one edge segment on (on the `prefer` side's cell, when it has one)
 *  or off (on both). */
function setEdge(e: Edits, axis: 'h' | 'v', line: number, at: number, on: boolean, prefer: 'before' | 'after') {
  const { before, after } = sidesAt(e, axis, line, at);
  if (on) {
    if (edgeOn(e, axis, line, at)) return;
    const target = (prefer === 'before' ? before : after) ?? before ?? after;
    if (target) sidesOf(e, target.offset).add(target.side);
    return;
  }
  if (before) sidesOf(e, before.offset).delete(before.side);
  if (after) sidesOf(e, after.offset).delete(after.side);
}

/** The segments of one edge of the selection. */
function selectionEdge(rect: TableRect, side: BorderSide): Array<{ axis: 'h' | 'v'; line: number; at: number; prefer: 'before' | 'after' }> {
  const out: Array<{ axis: 'h' | 'v'; line: number; at: number; prefer: 'before' | 'after' }> = [];
  if (side === 'top' || side === 'bottom') {
    const line = side === 'top' ? rect.top : rect.bottom;
    for (let c = rect.left; c < rect.right; c++) out.push({ axis: 'h', line, at: c, prefer: side === 'top' ? 'after' : 'before' });
  } else {
    const line = side === 'left' ? rect.left : rect.right;
    for (let r = rect.top; r < rect.bottom; r++) out.push({ axis: 'v', line, at: r, prefer: side === 'left' ? 'after' : 'before' });
  }
  return out;
}

/** The selected cells' offsets (each once, however many positions). */
function selectedCells(rect: TableRect): number[] {
  const cells = new Set<number>();
  for (let r = rect.top; r < rect.bottom; r++) {
    for (let c = rect.left; c < rect.right; c++) cells.add(rect.map.map[r * rect.map.width + c]);
  }
  return [...cells];
}

function apply(e: Edits, state: EditorState, dispatch: Parameters<Command>[1]): boolean {
  if (!dispatch) return true;
  const tr = state.tr;
  for (const [offset, set] of e.sides) {
    const cell = e.rect.table.nodeAt(offset);
    if (!cell) continue;
    const value = borderValue(set);
    if (value !== (cell.attrs.border || '')) tr.setNodeMarkup(e.rect.tableStart + offset, undefined, { ...cell.attrs, border: value });
  }
  if (tr.docChanged) dispatch(tr);
  return true;
}

/** The Border row's command for `action`. False (disabled) outside a
 *  table and in a grid table, whose strokes box every cell already. */
export function setCellBorders(action: BorderAction): Command {
  return (state, dispatch) => {
    const e = begin(state);
    if (!e) return false;
    const { rect } = e;
    if (action === 'all') {
      for (const offset of selectedCells(rect)) {
        const set = sidesOf(e, offset);
        (['top', 'right', 'bottom', 'left'] as const).forEach((s) => set.add(s));
      }
    } else if (action === 'none') {
      for (let y = rect.top; y <= rect.bottom; y++) for (let c = rect.left; c < rect.right; c++) setEdge(e, 'h', y, c, false, 'after');
      for (let x = rect.left; x <= rect.right; x++) for (let r = rect.top; r < rect.bottom; r++) setEdge(e, 'v', x, r, false, 'after');
    } else if (action === 'outside') {
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        for (const s of selectionEdge(rect, side)) setEdge(e, s.axis, s.line, s.at, true, s.prefer);
      }
    } else {
      const segments = selectionEdge(rect, action);
      const on = !segments.every((s) => edgeOn(e, s.axis, s.line, s.at));
      for (const s of segments) setEdge(e, s.axis, s.line, s.at, on, s.prefer);
    }
    return apply(e, state, dispatch);
  };
}

/** Whether the selection's `side` edge is drawn all along it (a side
 *  tile's checked state); null outside a table or in a grid table. */
export function selectionEdgeOn(state: EditorState, side: BorderSide): boolean | null {
  const e = begin(state);
  if (!e) return null;
  return selectionEdge(e.rect, side).every((s) => edgeOn(e, s.axis, s.line, s.at));
}

/** Whether no line is drawn in or round the selection (None's checked
 *  state). */
export function selectionUnbordered(state: EditorState): boolean | null {
  const e = begin(state);
  if (!e) return null;
  const { rect } = e;
  for (let y = rect.top; y <= rect.bottom; y++) for (let c = rect.left; c < rect.right; c++) if (edgeOn(e, 'h', y, c)) return false;
  for (let x = rect.left; x <= rect.right; x++) for (let r = rect.top; r < rect.bottom; r++) if (edgeOn(e, 'v', x, r)) return false;
  return true;
}

/** Whether every selected cell is boxed (All's checked state). */
export function selectionAllBordered(state: EditorState): boolean | null {
  const e = begin(state);
  if (!e) return null;
  return selectedCells(e.rect).every((offset) => sidesOf(e, offset).size === 4);
}
