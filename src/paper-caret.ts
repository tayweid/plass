// A click on the paper writes. Taylor, 2026-10-06: "on a blank page i can
// lose the cursor by clicking on the page. and nothing writes when i
// keyboard. the only way back is command r."
//
// The editable element (.ProseMirror) is only the text column, from the
// first block's top to the last block's bottom. Everything else the eye
// reads as the page is not editable: the margins (#editor's padding),
// the sheet below the last block (#stack, the rest of a blank page is
// all of it: the empty paragraph is one 25 px line at the top margin),
// the page gaps at the margins' width, and the panel's frame under a
// short paper (#scroll). A press there is a press on a plain element, so
// Chromium takes the focus off the editor and puts the document's
// selection in whatever text is nearest (a page number in #pages, the
// scroll rail's label), and every key after it goes nowhere. On a blank
// page the one way back, a click on that invisible first line, cannot be
// found, so it looked like only a reload brought the caret back.
//
// So a press on the paper outside the text is the editor's: the press's
// default (the blur, the stray selection) is cancelled and the caret goes
// where the press is nearest in the text — a press beside a line (in a
// margin) at that line's near end, above the first line on the first
// line, below the last block at the end of the document's text. Beside a
// block narrower than the column (a centered table or grid), the caret
// goes in the block level with the press, in the cell of that row nearest
// it, never in the text before it: ProseMirror finds nothing under a point
// beside such a block and would answer with a place between blocks, and the
// text before that place can be an editorial comment, which a key typed
// there would write into. A comment takes the caret only from a press
// beside it. A drag from the paper selects to wherever it goes, as a drag
// from the text does, and a shift-press extends the selection. The caret
// is only ever put in text: a press below a document that ends in an
// equation or a figure must not select the atom, which the next key would
// replace.
//
// The plain-text view loses the caret the same way (2026-10-06 review):
// CodeMirror's text (.cm-content) is a measure in the middle of the sheet,
// and a press on its air (the editor's padding above and below, the sheet
// either side of the measure, #paper under a short text) blurred it to the
// body. Such a press is the source editor's in the same way
// (SourceView.pressAt: the point taken into the text's box, the end of the
// text below it). A press in CodeMirror's text, or on its search panel, is
// CodeMirror's own.
//
// Some presses keep the focus where it is and move no caret: the bare frame
// round the panel (the window's edge, the cut corners of the paper), the
// HUD's chip in the panel's corner, the background of a floating image or
// table toolbar between its buttons, and a right-click on the paper outside
// the text. Its context menu still opens (cancelling a press does not
// cancel the menu), and the menu's own selection of the word nearest the
// press (a Mac's) finds none: nothing on the paper but the text can be
// selected (#scroll in style.css), so the selection stays in the text. So a
// near miss of the page's edge, a press on the word count or a stray press
// on a toolbar does not leave the keys going nowhere (a field that has the
// focus, a name being renamed, still loses it as ever).
//
// None of this touches anything a control does: controls take their
// presses before these listeners (the bar's and the rail's tiles cancel
// their own; the menus close from a capturing listener on the document),
// and a press inside the text is never handled here.

import { Selection, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import type { SourceView } from './source-view';

/** Elements a press must reach unchanged even on the paper. */
const CONTROL = 'button, input, textarea, select, a[href], label, [contenteditable], [role="button"], [role="menuitem"]';
/** CodeMirror's own: its text, its search panel, its tooltips. */
const SOURCE_OWN = '.cm-content, .cm-panels, .cm-tooltip';
/** The toolbars floated over the page for a selected image or table (or
 *  grid): their background between buttons is not the paper. */
const FLOATING_TOOLBAR = '.image-toolbar, .native-table-toolbar';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** How far `v` is outside [lo, hi] (0 inside). */
const outside = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);

const isComment = (node: PMNode) => node.type.name === 'editor_comment';

function rectAt(view: EditorView, pos: number): DOMRect | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof Element ? dom.getBoundingClientRect() : null;
}

/** The nearest text from `pos` in direction `dir`, past editorial
 *  comments (a caret is put in a comment only from a press beside it). */
function textFrom(doc: PMNode, pos: number, dir: 1 | -1): Selection | null {
  for (;;) {
    const sel = Selection.findFrom(doc.resolve(pos), dir, true);
    if (!sel || !isComment(sel.$head.node(1))) return sel;
    pos = dir < 0 ? sel.$head.before(1) : sel.$head.after(1);
  }
}

/** The caret in the text level with a point beside the text: the top-level
 *  block level with it (a comment only when it is), else the nearest one
 *  above or below; in it, the textblock nearest the point (a table's or a
 *  grid's cell in that row); in an atom (an equation, a figure), the
 *  nearer text before or after it. */
function caretBeside(view: EditorView, x: number, y: number): Selection | null {
  const { doc } = view.state;
  let block = -1;
  let blockPos = 0;
  let best = Infinity;
  for (let i = 0, pos = 0; i < doc.childCount; pos += doc.child(i).nodeSize, i++) {
    const r = rectAt(view, pos);
    if (!r || !r.height) continue;
    const d = outside(y, r.top, r.bottom);
    if (d < best && (d === 0 || !isComment(doc.child(i)))) {
      best = d;
      block = i;
      blockPos = pos;
    }
    if (r.top > y) break;
  }
  if (block < 0) return null;
  const node = doc.child(block);
  let pick = null as { pos: number; node: PMNode; r: DOMRect; dy: number; dx: number } | null;
  doc.nodesBetween(blockPos, blockPos + node.nodeSize, (n, pos) => {
    if (!n.isTextblock) return true;
    const r = rectAt(view, pos);
    if (!r) return false;
    const dy = outside(y, r.top, r.bottom);
    const dx = outside(x, r.left, r.right);
    if (!pick || dy < pick.dy || (dy === pick.dy && dx < pick.dx)) pick = { pos, node: n, r, dy, dx };
    return false;
  });
  if (pick) {
    const { pos, node: text, r } = pick;
    const hit = view.posAtCoords({ left: clamp(x, r.left + 1, r.right - 1), top: clamp(y, r.top + 1, r.bottom - 1) });
    if (hit && hit.pos > pos && hit.pos < pos + text.nodeSize) return TextSelection.create(doc, hit.pos);
    return TextSelection.create(doc, x < (r.left + r.right) / 2 ? pos + 1 : pos + text.nodeSize - 1);
  }
  const before = textFrom(doc, blockPos, -1);
  const after = textFrom(doc, blockPos + node.nodeSize, 1);
  if (!before || !after) return before ?? after;
  const gap = (sel: Selection) => {
    const c = view.coordsAtPos(sel.head);
    return outside(y, c.top, c.bottom);
  };
  return gap(after) < gap(before) ? after : before;
}

/** The caret nearest a point of the paper, in text. */
function caretAt(view: EditorView, x: number, y: number): Selection {
  const { doc } = view.state;
  const box = view.dom.getBoundingClientRect();
  const end = textFrom(doc, doc.content.size, -1) ?? Selection.findFrom(doc.resolve(doc.content.size), -1, true) ?? Selection.atEnd(doc);
  if (y >= box.bottom) return end;
  // Into the text column by a pixel, so the point is over a line.
  const left = clamp(x, box.left + 1, box.right - 1);
  const top = clamp(y, box.top + 1, box.bottom - 1);
  const hit = view.posAtCoords({ left, top });
  if (hit) {
    const $pos = doc.resolve(hit.pos);
    // Text level with the press: the line beside it.
    if ($pos.parent.inlineContent) {
      const r = rectAt(view, $pos.before());
      if (r && outside(top, r.top, r.bottom) === 0) return TextSelection.create(doc, hit.pos);
    }
  }
  return caretBeside(view, left, top) ?? (y < box.top ? Selection.atStart(doc) : end);
}

/** A press on the paper in the page view: the caret, and the drag. */
function pressPage(view: EditorView, x: number, y: number, extend: boolean): (x: number, y: number) => void {
  const caret = caretAt(view, x, y);
  const anchor = extend ? view.state.selection.anchor : caret.head;
  const select = (head: Selection) => {
    const { doc, selection } = view.state;
    const sel = head.head === anchor ? head : TextSelection.between(doc.resolve(Math.min(anchor, doc.content.size)), head.$head);
    if (!sel.eq(selection)) view.dispatch(view.state.tr.setSelection(sel));
  };
  select(caret);
  view.focus();
  return (x, y) => select(caretAt(view, x, y));
}

/**
 * Give presses on the paper outside the text to the editor that shows it
 * (the page's, or the plain-text view's while it is open), in the panel and
 * everything in it, and keep the editor's focus through a press on the
 * bare frame, the HUD, a floating toolbar's background, or a right-click
 * on the paper.
 */
export function attachPaperCaret(view: EditorView, panel: HTMLElement, source: Pick<SourceView, 'isActive' | 'pressAt'>): void {
  /** Whether a press on `target` is in the text of the editor showing. */
  const inText = (target: Element) => (source.isActive() ? !!target.closest(SOURCE_OWN) : view.dom.contains(target));

  panel.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.defaultPrevented) return;
    const target = e.target as Element;
    if (target.closest(CONTROL) || inText(target)) return;
    e.preventDefault();
    let drag: (x: number, y: number) => void;
    if (source.isActive()) {
      source.pressAt(e.clientX, e.clientY, e.shiftKey);
      drag = (x, y) => source.pressAt(x, y, true);
    } else {
      drag = pressPage(view, e.clientX, e.clientY, e.shiftKey);
    }
    const move = (m: MouseEvent) => {
      if (!(m.buttons & 1)) return stop();
      drag(m.clientX, m.clientY);
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  });

  document.addEventListener('mousedown', (e) => {
    if (e.defaultPrevented) return;
    const active = document.activeElement;
    if (!active || !(view.dom.contains(active) || active.closest('.cm-editor'))) return;
    const target = e.target as Element;
    if (target.closest(CONTROL)) return;
    const kept =
      e.button === 0
        ? target === document.body || target === document.documentElement || target.id === 'hud' || !!target.closest(FLOATING_TOOLBAR)
        : e.button === 2 && panel.contains(target) && !inText(target);
    if (kept) e.preventDefault();
  });
}
