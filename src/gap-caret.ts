// A caret beside a table where no line can hold one (Taylor, 2026-10-21:
// "it's hard to create a new line above a table in a grid and to delete a
// line above a table in a grid, since there's no cursor location before
// the table in its line").
//
// A table that opens a grid cell has nothing above it inside the cell, so
// ↑ from its first row went clear out of the grid, and there was no place
// to type a line before it. The same holds after a table that ends a cell,
// and between a table and another block that is not text (two tables, a
// grid and a table). That place is now a caret of its own, the GapCaret:
// reached with the arrow keys from the table's edge (↑ / ← from its first
// line, ↓ / → from its last) or a click in the room above or below the
// table, drawn as a short blinking line at the table's corner. Typing or
// Enter there makes the paragraph; the arrows leave it again.
//
// It is ProseMirror's gap cursor (prosemirror-gapcursor), cut down to
// this one place, and drawn outside the editable DOM: a widget inside a
// grid cell would be the cell's first element, which the cell's frame
// measure reads (grid-editor.ts leafOf), so a caret could move the page.
//
// The document's own edges keep what they had: ↑ from a table that opens
// the document (↓ from one that ends it) makes the paragraph at once
// (exitTableVertically).
//
// And the way back: ⌫ at the very start of a table deletes the empty line
// right before it, and ⌫ in an empty line with nothing before it in its
// cell (or at the top of the document) deletes the line when a table or
// another block that is not text follows.

import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { Plugin, Selection, TextSelection, type Command } from 'prosemirror-state';
import { keydownHandler } from 'prosemirror-keymap';
import type { Mappable } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';

const isTable = (node: PMNode | null | undefined) => node?.type.spec.tableRole === 'table';

export class GapCaret extends Selection {
  constructor($pos: ResolvedPos) {
    super($pos, $pos);
  }

  map(doc: PMNode, mapping: Mappable): Selection {
    const $pos = doc.resolve(mapping.map(this.head));
    return GapCaret.valid($pos) ? new GapCaret($pos) : Selection.near($pos);
  }

  content() {
    return Slice.empty;
  }

  eq(other: Selection): boolean {
    return other instanceof GapCaret && other.head === this.head;
  }

  toJSON() {
    return { type: 'gapcaret', pos: this.head };
  }

  static fromJSON(doc: PMNode, json: { pos: number }) {
    return new GapCaret(doc.resolve(json.pos));
  }

  getBookmark() {
    return new GapBookmark(this.head);
  }

  /** A place between blocks, beside a table, where no text block is on
   *  either side and a paragraph may go; never the document's own first or
   *  last place (there ↑ / ↓ make the paragraph, exitTableVertically). */
  static valid($pos: ResolvedPos): boolean {
    const parent = $pos.parent;
    if (parent.inlineContent || parent.type.spec.tableRole) return false;
    const before = $pos.nodeBefore;
    const after = $pos.nodeAfter;
    if (!isTable(before) && !isTable(after)) return false;
    if (before?.isTextblock || after?.isTextblock) return false;
    if ($pos.depth === 0 && (!before || !after)) return false;
    return Boolean(parent.contentMatchAt($pos.index()).matchType(schema.nodes.paragraph));
  }
}

// Hidden native selection: prosemirror-view adds ProseMirror-hideselection.
(GapCaret.prototype as { visible: boolean }).visible = false;
Selection.jsonID('gapcaret', GapCaret);

class GapBookmark {
  constructor(readonly pos: number) {}
  map(mapping: Mappable) {
    return new GapBookmark(mapping.map(this.pos));
  }
  resolve(doc: PMNode) {
    const $pos = doc.resolve(this.pos);
    return GapCaret.valid($pos) ? new GapCaret($pos) : Selection.near($pos);
  }
}

/** The table the caret is in, its depth on the caret's path. */
function tableDepth($pos: ResolvedPos): number {
  for (let d = $pos.depth; d > 0; d--) if (isTable($pos.node(d))) return d;
  return -1;
}

/** ↑ / ↓ from a table's first / last line, ← / → from its very start /
 *  end: the gap before / after it, when there is one. */
export function gapFromTable(dir: -1 | 1, axis: 'vert' | 'horiz'): Command {
  return (state, dispatch, view) => {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) return false;
    const $head = sel.$head;
    const d = tableDepth($head);
    if (d < 0) return false;
    // table > row > cell > paragraph: the edge row, the edge cell of it
    // (sideways only), the edge paragraph of that cell.
    const edge = (depth: number) => (dir < 0 ? $head.index(depth) === 0 : $head.index(depth) === $head.node(depth).childCount - 1);
    if (!edge(d) || !edge(d + 2)) return false;
    if (axis === 'horiz') {
      if (!edge(d + 1)) return false;
      if (dir < 0 ? $head.parentOffset !== 0 : $head.parentOffset !== $head.parent.content.size) return false;
    } else if (view && !view.endOfTextblock(dir < 0 ? 'up' : 'down')) {
      return false;
    }
    const $gap = state.doc.resolve(dir < 0 ? $head.before(d) : $head.after(d));
    if (!GapCaret.valid($gap)) return false;
    if (dispatch) dispatch(state.tr.setSelection(new GapCaret($gap)).scrollIntoView());
    return true;
  };
}

/** ↓ (↑) from the last (first) line of a text block whose next (previous)
 *  sibling is a table: into the table's first (last) row, in the cell
 *  nearest the caret's column. The caret's column often misses a table
 *  (a centred one narrower than the measure, or a cell's), and the page's
 *  geometric motion then went clean past it. */
export function enterTableVertically(dir: -1 | 1): Command {
  return (state, dispatch, view) => {
    const sel = state.selection;
    if (!view || !(sel instanceof TextSelection) || !sel.empty) return false;
    const $head = sel.$head;
    if (!$head.parent.isTextblock || $head.depth < 1) return false;
    if (!view.endOfTextblock(dir < 0 ? 'up' : 'down')) return false;
    const $block = state.doc.resolve(dir < 0 ? $head.before() : $head.after());
    if (!isTable(dir < 0 ? $block.nodeBefore : $block.nodeAfter)) return false;
    let x: number;
    try {
      x = view.coordsAtPos(sel.head).left;
    } catch {
      return false;
    }
    const next = landBeside(view, $block, dir, x);
    if (!next) return false;
    if (dispatch) dispatch(state.tr.setSelection(next).scrollIntoView());
    return true;
  };
}

/** Where a caret moving up (down) at column `x` lands when the page's
 *  probe meets a place between blocks: the GapCaret, if that place is one;
 *  else, beside a table, the table's last (first) row, in the cell nearest
 *  `x`. Null elsewhere (the probe goes on). */
export function landBeside(view: EditorView, $pos: ResolvedPos, dir: -1 | 1, x: number): Selection | null {
  if ($pos.parent.inlineContent) return null;
  if (GapCaret.valid($pos)) return new GapCaret($pos);
  const table = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
  if (!isTable(table)) return null;
  const tablePos = dir < 0 ? $pos.pos - table!.nodeSize : $pos.pos;
  const rowIndex = dir < 0 ? table!.childCount - 1 : 0;
  let rowPos = tablePos + 1;
  for (let i = 0; i < rowIndex; i++) rowPos += table!.child(i).nodeSize;
  let best = rowPos + 1;
  let bestDist = Infinity;
  let cellPos = rowPos + 1;
  table!.child(rowIndex).forEach((cell) => {
    const dom = view.nodeDOM(cellPos) as HTMLElement | null;
    if (dom) {
      const r = dom.getBoundingClientRect();
      const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = cellPos;
      }
    }
    cellPos += cell.nodeSize;
  });
  const doc = view.state.doc;
  const cell = doc.nodeAt(best)!;
  return TextSelection.near(doc.resolve(dir < 0 ? best + cell.nodeSize - 1 : best + 1), dir);
}

/** The first text line the eye meets going up (down) from `y` at `x`,
 *  outside `skip` (the table beside the gap). */
function probeVertically(view: EditorView, x: number, y: number, dir: -1 | 1, skip: { from: number; to: number }): Selection | null {
  for (let step = 1; step <= 120; step++) {
    const found = view.posAtCoords({ left: x, top: y + dir * 4 * step });
    if (!found || found.inside === -1) continue;
    if (found.pos >= skip.from && found.pos <= skip.to) continue;
    const $pos = view.state.doc.resolve(found.pos);
    if (!$pos.parent.inlineContent) continue;
    return TextSelection.near($pos, dir);
  }
  return null;
}

/** The arrows at a GapCaret: into the table beside it, or on past it. */
export function moveFromGap(dir: -1 | 1, axis: 'vert' | 'horiz'): Command {
  return (state, dispatch, view) => {
    const sel = state.selection;
    if (!(sel instanceof GapCaret)) return false;
    const $gap = sel.$head;
    const toward = dir < 0 ? $gap.nodeBefore : $gap.nodeAfter;
    let next: Selection | null = null;
    if (toward) {
      // Into the block on that side (a table: its last / first cell).
      next = Selection.findFrom($gap, dir, true) ?? Selection.near($gap, dir);
    } else if (axis === 'vert' && view) {
      // The gap opens (ends) its cell: up (down) is what lies above
      // (below) the table on the page, as ↑ / ↓ from its edge row went.
      const table = (dir < 0 ? $gap.nodeAfter : $gap.nodeBefore)!;
      const from = dir < 0 ? $gap.pos : $gap.pos - table.nodeSize;
      const dom = view.nodeDOM(from) as HTMLElement | null;
      if (dom) {
        const r = dom.getBoundingClientRect();
        next = probeVertically(view, r.left + 2, dir < 0 ? r.top : r.bottom, dir, { from, to: from + table.nodeSize });
      }
      next ??= Selection.findFrom($gap, dir, true);
    } else {
      next = Selection.findFrom($gap, dir, true);
    }
    if (!next) return true;
    if (dispatch) dispatch(state.tr.setSelection(next).scrollIntoView());
    return true;
  };
}

/** Enter at a GapCaret: an empty paragraph there, the caret in it. */
export const enterAtGap: Command = (state, dispatch) => {
  if (!(state.selection instanceof GapCaret)) return false;
  if (dispatch) {
    const pos = state.selection.head;
    const tr = state.tr.insert(pos, schema.nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView());
  }
  return true;
};

/** ⌫ / ⌦ at a GapCaret go into the table on that side; with nothing
 *  there they do nothing (a native delete would edit the cell's DOM). */
export function deleteAtGap(dir: -1 | 1): Command {
  return (state, dispatch, view) => {
    const sel = state.selection;
    if (!(sel instanceof GapCaret)) return false;
    if (dir < 0 ? sel.$head.nodeBefore : sel.$head.nodeAfter) moveFromGap(dir, 'horiz')(state, dispatch, view);
    return true;
  };
}

/** ⌫ at the very start of a table (its first cell's first character):
 *  the empty line right before the table goes. */
export const deleteEmptyLineBeforeTable: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return false;
  const $head = sel.$head;
  const d = tableDepth($head);
  if (d < 0 || $head.parentOffset !== 0) return false;
  for (let k = d; k <= d + 2; k++) if ($head.index(k) !== 0) return false;
  const $table = state.doc.resolve($head.before(d));
  const before = $table.nodeBefore;
  if (!before || before.type !== schema.nodes.paragraph || before.content.size) return false;
  if (dispatch) {
    const to = $table.pos;
    dispatch(state.tr.delete(to - before.nodeSize, to).scrollIntoView());
  }
  return true;
};

/** ⌫ in an empty line that has nothing before it in its cell (or opens
 *  the document) and a block that is not text after it: the line goes,
 *  and the caret waits where it was (the gap, or the block's start). */
export const deleteEmptyLineAtContainerStart: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return false;
  const $head = sel.$head;
  const para = $head.parent;
  if (para.type !== schema.nodes.paragraph || para.content.size || $head.depth < 1) return false;
  const $para = state.doc.resolve($head.before());
  const after = $para.parent.maybeChild($para.index() + 1);
  if ($para.nodeBefore || !after || after.isTextblock) return false;
  if (dispatch) {
    const tr = state.tr.delete($para.pos, $para.pos + para.nodeSize);
    const $at = tr.doc.resolve($para.pos);
    tr.setSelection(GapCaret.valid($at) ? new GapCaret($at) : Selection.near($at, 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Where a click lands a GapCaret: in the room above (below) a table
 *  whose gap before (after) it is valid. */
function gapAtClick(view: EditorView, pos: number, event: MouseEvent): ResolvedPos | null {
  const { doc } = view.state;
  const candidates = new Set<number>();
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d >= 0; d--) {
    // The table the click resolved into or beside, at any depth.
    const node = $pos.node(d);
    if (d > 0 && isTable(node)) {
      candidates.add($pos.before(d));
      candidates.add($pos.after(d));
    }
  }
  if (isTable($pos.nodeAfter)) candidates.add(pos);
  if (isTable($pos.nodeBefore)) candidates.add(pos);
  // A press in a cell's room above (below) its table resolves to the cell
  // as a whole: the places round each table it holds.
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  const holder = hit && hit.inside >= 0 ? doc.nodeAt(hit.inside) : null;
  if (hit && holder && !holder.inlineContent && !holder.type.spec.tableRole) {
    holder.forEach((child, offset) => {
      if (!isTable(child)) return;
      const at = hit.inside + 1 + offset;
      candidates.add(at);
      candidates.add(at + child.nodeSize);
    });
  }
  for (const at of candidates) {
    const $gap = doc.resolve(at);
    if (!GapCaret.valid($gap)) continue;
    for (const side of [1, -1] as const) {
      const table = side > 0 ? $gap.nodeAfter : $gap.nodeBefore;
      if (!isTable(table)) continue;
      const dom = view.nodeDOM(side > 0 ? at : at - table!.nodeSize) as HTMLElement | null;
      if (!dom) continue;
      const r = dom.getBoundingClientRect();
      if (event.clientX < r.left - 24 || event.clientX > r.right + 24) continue;
      if (side > 0 ? event.clientY < r.top : event.clientY > r.bottom) return $gap;
    }
  }
  return null;
}

/** The plugin: draws the GapCaret and lands it on a click. */
export function gapCaretPlugin(): Plugin {
  return new Plugin({
    props: {
      // After the ref popup (it keeps its arrows), before the input rules
      // and the editing keymap (main.ts).
      handleKeyDown: keydownHandler(gapKeys()),
      // A letter typed at the gap: the paragraph, holding it.
      handleTextInput(view, _from, _to, text) {
        const sel = view.state.selection;
        if (!(sel instanceof GapCaret)) return false;
        const pos = sel.head;
        const tr = view.state.tr.insert(pos, schema.nodes.paragraph.create(null, schema.text(text)));
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1 + text.length)).scrollIntoView());
        return true;
      },
      handleDOMEvents: {
        // An IME composing at the gap composes in a new paragraph
        // (prosemirror-gapcursor's beforeinput).
        beforeinput(view, event) {
          const sel = view.state.selection;
          if (!(sel instanceof GapCaret) || (event as InputEvent).inputType !== 'insertCompositionText') return false;
          const pos = sel.head;
          const tr = view.state.tr.replace(pos, pos, new Slice(Fragment.from(schema.nodes.paragraph.create()), 0, 0));
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)));
          return false;
        },
      },
      handleClick(view, pos, event) {
        if (event.shiftKey || event.metaKey || event.altKey) return false;
        const $gap = gapAtClick(view, pos, event);
        if (!$gap) return false;
        view.dispatch(view.state.tr.setSelection(new GapCaret($gap)));
        return true;
      },
    },
    view(view) {
      const mark = document.createElement('div');
      mark.className = 'gap-caret';
      mark.setAttribute('aria-hidden', 'true');
      let frame = 0;
      const draw = () => {
        frame = 0;
        const sel = view.state.selection;
        const host = view.dom.parentElement;
        if (!(sel instanceof GapCaret) || !host || !view.hasFocus()) {
          mark.remove();
          return;
        }
        const after = sel.$head.nodeAfter;
        const before = sel.$head.nodeBefore;
        const table = isTable(after) ? after! : before!;
        const tablePos = isTable(after) ? sel.head : sel.head - table.nodeSize;
        const dom = view.nodeDOM(tablePos) as HTMLElement | null;
        if (!dom) {
          mark.remove();
          return;
        }
        // In the host's own coordinates: the paper is drawn scaled
        // (paper-scale.ts), the host inside the scaled stack.
        const hostBox = host.getBoundingClientRect();
        const scale = host.offsetWidth ? hostBox.width / host.offsetWidth : 1;
        const r = dom.getBoundingClientRect();
        const lineH = parseFloat(getComputedStyle(dom).lineHeight) || 20;
        const height = Math.min(lineH, 22);
        const left = (r.left - hostBox.left) / scale;
        const top = isTable(after) ? (r.top - hostBox.top) / scale - height - 3 : (r.bottom - hostBox.top) / scale + 3;
        mark.style.left = `${left}px`;
        mark.style.top = `${top}px`;
        mark.style.height = `${height}px`;
        // Restart the blink at each move, as a text caret does.
        mark.style.animation = 'none';
        void mark.offsetWidth;
        mark.style.animation = '';
        if (mark.parentElement !== host) host.appendChild(mark);
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(draw);
      };
      const onFocus = () => schedule();
      view.dom.addEventListener('focus', onFocus);
      view.dom.addEventListener('blur', onFocus);
      schedule();
      return {
        update: schedule,
        destroy() {
          if (frame) cancelAnimationFrame(frame);
          view.dom.removeEventListener('focus', onFocus);
          view.dom.removeEventListener('blur', onFocus);
          mark.remove();
        },
      };
    },
  });
}

/** The GapCaret's keys, for the editing keymap's chains. */
export function gapKeys(): Record<string, Command> {
  return {
    ArrowUp: (s, d, v) => moveFromGap(-1, 'vert')(s, d, v) || gapFromTable(-1, 'vert')(s, d, v) || enterTableVertically(-1)(s, d, v),
    ArrowDown: (s, d, v) => moveFromGap(1, 'vert')(s, d, v) || gapFromTable(1, 'vert')(s, d, v) || enterTableVertically(1)(s, d, v),
    ArrowLeft: (s, d, v) => moveFromGap(-1, 'horiz')(s, d, v) || gapFromTable(-1, 'horiz')(s, d, v),
    ArrowRight: (s, d, v) => moveFromGap(1, 'horiz')(s, d, v) || gapFromTable(1, 'horiz')(s, d, v),
    Enter: enterAtGap,
    Backspace: (s, d, v) => deleteAtGap(-1)(s, d, v) || deleteEmptyLineBeforeTable(s, d, v) || deleteEmptyLineAtContainerStart(s, d, v),
    Delete: deleteAtGap(1),
  };
}

