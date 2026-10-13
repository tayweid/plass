// The keyboard for tables and grids beyond cell navigation (docs/
// BLOCK-CHROME.md, spec §6):
//
//   Escape in a cell        selects the innermost table or grid (a
//                           NodeSelection, outlined); the cell it left is
//                           remembered here.
//   Escape / Enter          on a selected block: back to that cell.
//   ⌫ / Delete              on a selected block: deletes it (PM's default).
//   Tab                     on a selected block: the pill's first tile.
//   ⌘⏎ / ⇧⌘⏎                in a table or grid cell: a row below / above,
//                           the caret in it. Registered before the editing
//                           keymap, whose ⌘⏎ is the page break (which cannot
//                           live in a cell); elsewhere ⌘⏎ is unchanged.
//
// Shift-Tab / Escape in the pill hand the editor its focus back with the
// selection it had (block-chrome.ts). Model only: nothing here reads
// geometry or writes style.

import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey, Selection, type Command, type EditorState } from 'prosemirror-state';
import { keymap } from 'prosemirror-keymap';
import { Mapping, StepMap } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import { CellSelection } from 'prosemirror-tables';
import { schema } from './schema';
import { insertTableRow } from './table-editor';
import { insertGridRowAt } from './grid-editor';

const isBlock = (node: PMNode) => node.type.spec.tableRole === 'table' || node.type === schema.nodes.grid;

/** The innermost table or grid holding the selection (not one it selects). */
function innermostBlock(state: EditorState): { pos: number; node: PMNode } | null {
  const selection = state.selection;
  const $pos: ResolvedPos = selection instanceof CellSelection ? selection.$anchorCell : selection.$from;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (isBlock(node)) return { pos: $pos.before(depth), node };
  }
  return null;
}

/** The block the selection node-selects, if it is a table or grid. */
function selectedBlock(state: EditorState): NodeSelection | null {
  const selection = state.selection;
  return selection instanceof NodeSelection && isBlock(selection.node) ? selection : null;
}

// ---------------------------------------------------------------------------
// The remembered cell

interface Memory {
  /** The selected block's position. */
  block: number;
  /** The selection Escape left (a caret, a range, a cell selection). */
  saved: Selection;
}

const memoryKey = new PluginKey<Memory | null>('block-select');

/** Remembers the cell an Escape left while its block stays selected;
 *  mapped through edits elsewhere, forgotten once the selection moves.
 *  An attribute change to the selected block itself (a rule style, Text
 *  size, a gutter: setNodeMarkup) rewrites the block's own token, which
 *  PM maps as deleting the NodeSelection, so it falls back to a caret in
 *  the first cell. The memory follows the block through such a change and
 *  `appendTransaction` selects it again: a style picked in the pill keeps
 *  the block, and its cell, as they were. */
function memoryPlugin(): Plugin<Memory | null> {
  return new Plugin<Memory | null>({
    key: memoryKey,
    state: {
      init: () => null,
      apply(tr, value, old, state) {
        const meta = tr.getMeta(memoryKey) as Memory | null | undefined;
        if (meta !== undefined) return meta;
        if (!value) return null;
        const selected = selectedBlock(state);
        if (!tr.docChanged) return selected && selected.from === value.block ? value : null;
        // An edit elsewhere, or inside the block: both map through it.
        const moved = tr.mapping.mapResult(value.block, 1);
        if (!moved.deleted) return selected && selected.from === moved.pos ? { block: moved.pos, saved: value.saved.map(tr.doc, tr.mapping) } : null;
        const was = old.doc.nodeAt(value.block);
        if (!was) return null;
        if (selected) {
          // The block rebuilt and selected again by the change itself
          // (replaceGrid): the cell by its offset when the content is the
          // same, else wherever it maps (cellSelectionFor checks it).
          const pos = tr.mapping.map(value.block, -1);
          if (selected.from !== pos || selected.node.type !== was.type) return null;
          const same = selected.node.content.eq(was.content);
          return { block: pos, saved: value.saved.map(tr.doc, same ? new Mapping([StepMap.offset(pos - value.block)]) : tr.mapping) };
        }
        // Only the block's own token rewritten (setNodeMarkup): its content
        // maps; a deleted block's does not. A change that set the
        // selection itself moved it on purpose.
        if (tr.selectionSet) return null;
        const inner = tr.mapping.mapResult(value.block + 1, 1);
        if (inner.deleted) return null;
        const node = tr.doc.nodeAt(inner.pos - 1);
        if (!node || node.type !== was.type) return null;
        return { block: inner.pos - 1, saved: value.saved.map(tr.doc, tr.mapping) };
      },
    },
    appendTransaction(_trs, _old, state) {
      const memory = memoryKey.getState(state);
      if (!memory || selectedBlock(state)?.from === memory.block) return null;
      const node = state.doc.nodeAt(memory.block);
      if (!node || !isBlock(node)) return null;
      return state.tr.setSelection(NodeSelection.create(state.doc, memory.block));
    },
    props: {
      // A letter typed on a selected table or grid would replace the whole
      // block with that letter (PM's default for a NodeSelection): one stray
      // key after Escape loses a table. Typing does nothing there; ⌫ / Delete
      // still delete the block on purpose.
      handleTextInput: (view) => !!selectedBlock(view.state),
    },
  });
}

/** The selection to act at while a table or grid is node-selected: the
 *  remembered cell when it is still inside the block, else the block's
 *  first cell. Null when no block is selected. */
export function cellSelectionFor(state: EditorState): Selection | null {
  const selected = selectedBlock(state);
  if (!selected) return null;
  const memory = memoryKey.getState(state);
  const end = selected.from + selected.node.nodeSize;
  if (memory && memory.block === selected.from && memory.saved.from > selected.from && memory.saved.to < end) return memory.saved;
  return Selection.findFrom(state.doc.resolve(selected.from + 1), 1, true) ?? Selection.findFrom(state.doc.resolve(selected.from + 1), 1);
}

/** Escape in a cell: select the innermost table or grid, remembering the
 *  cell. A block already selected goes back to its cell instead. */
export const selectBlock: Command = (state, dispatch) => {
  if (selectedBlock(state)) return returnToCell(state, dispatch);
  const block = innermostBlock(state);
  if (!block) return false;
  if (dispatch) {
    // No scroll: the block's top may be far above a caret deep in it.
    dispatch(state.tr.setSelection(NodeSelection.create(state.doc, block.pos)).setMeta(memoryKey, { block: block.pos, saved: state.selection }));
  }
  return true;
};

/** Escape or Enter on a selected block: the caret back in the cell it left. */
export const returnToCell: Command = (state, dispatch) => {
  const target = cellSelectionFor(state);
  if (!target) return false;
  if (dispatch) dispatch(state.tr.setSelection(target).setMeta(memoryKey, null).scrollIntoView());
  return true;
};

/** Put the remembered cell's selection back in the editor before the pill
 *  runs a command that acts at a cell. False when no block is selected. */
export function restoreCell(view: EditorView): boolean {
  const target = cellSelectionFor(view.state);
  if (!target) return false;
  view.dispatch(view.state.tr.setSelection(target).setMeta(memoryKey, null));
  return true;
}

/** What focuses the pill (block-chrome.ts registers it). */
let pillFocuser: (() => boolean) | null = null;
export function setPillFocuser(focus: (() => boolean) | null): void {
  pillFocuser = focus;
}

/** Tab on a selected block: the pill's first tile. Swallowed even when the
 *  pill cannot take the focus, so the browser does not move it elsewhere. */
const tabToPill: Command = (state, dispatch) => {
  if (!selectedBlock(state)) return false;
  if (dispatch) pillFocuser?.();
  return true;
};

/** Shift-Tab on a selected block stays put (the pill is after it). */
const stayOnBlock: Command = (state) => !!selectedBlock(state);

/** ⌘⏎ / ⇧⌘⏎ in a cell: a row below / above the caret's, in the innermost
 *  table or grid. False outside a cell (the page break runs). */
const addRow = (side: 'above' | 'below'): Command => (state, dispatch, view) => {
  // A selected block: at the cell it was selected from.
  if (selectedBlock(state)) {
    if (!dispatch || !view) return true;
    if (restoreCell(view)) addRow(side)(view.state, view.dispatch, view);
    return true;
  }
  const block = innermostBlock(state);
  if (!block) return false;
  if (block.node.type === schema.nodes.grid) {
    if (!dispatch || !view) return true;
    insertGridRowAt(view, side);
    return true;
  }
  // A refused insert (prosemirror-tables found no rectangle) still keeps
  // the page break out of the cell.
  insertTableRow(side)(state, dispatch);
  return true;
};

/** The block keyboard: its memory, and its keymap (before the editing
 *  keymap; after the reference popup and the comment keymap). */
export function blockKeys(): Plugin[] {
  return [
    memoryPlugin(),
    keymap({
      Escape: selectBlock,
      Enter: returnToCell,
      Tab: tabToPill,
      'Shift-Tab': stayOnBlock,
      'Mod-Enter': addRow('below'),
      'Shift-Mod-Enter': addRow('above'),
    }),
  ];
}
