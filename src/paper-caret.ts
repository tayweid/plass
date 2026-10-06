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
// line, below the last block at the end of the document's text. A drag
// from there selects to wherever it goes, as a drag from the text does,
// and a shift-press extends the selection. The caret is only ever put in
// text: a press below a document that ends in an equation or a figure
// must not select the atom, which the next key would replace.
//
// The bare frame round the panel (the window's edge, the cut corners of
// the paper) is not the paper, and neither is the HUD's chip in the
// panel's corner, over it: a press there moves no caret, and only keeps
// the editor's focus where it is, so a near miss of the page's edge or a
// press on the word count does not leave the keys going nowhere either
// (a field that has the focus, a name being renamed, still loses it as
// ever). Neither touches anything a
// control does: controls take their presses before these listeners (the
// bar's and the rail's tiles cancel their own; the menus close from a
// capturing listener on the document), and a press inside the editor,
// or anywhere in the plain-text view (CodeMirror's sheet is its own, and
// Chromium hands a press below its text to it), is never handled here.

import { Selection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

/** Elements a press must reach unchanged even on the paper. */
const CONTROL = 'button, input, textarea, select, a[href], label, [contenteditable], [role="button"], [role="menuitem"]';

/** The caret nearest a point of the paper, in text. */
function caretAt(view: EditorView, x: number, y: number): Selection {
  const { doc } = view.state;
  const box = view.dom.getBoundingClientRect();
  const end = Selection.findFrom(doc.resolve(doc.content.size), -1, true) ?? Selection.atEnd(doc);
  if (y >= box.bottom) return end;
  // Into the text column by a pixel, so the point is over a line.
  const left = Math.min(Math.max(x, box.left + 1), box.right - 1);
  const top = Math.min(Math.max(y, box.top + 1), box.bottom - 1);
  const hit = view.posAtCoords({ left, top });
  if (!hit) return y < box.top ? Selection.atStart(doc) : end;
  const $pos = doc.resolve(hit.pos);
  if ($pos.parent.inlineContent) return TextSelection.create(doc, hit.pos);
  return Selection.findFrom($pos, -1, true) ?? Selection.findFrom($pos, 1, true) ?? end;
}

/**
 * Give presses on the paper outside the text to the editor (the panel and
 * everything in it), and keep the editor's focus through a press on the
 * bare frame or the HUD. `pageView` says whether the page view is the one showing
 * (false while the plain-text view is open: its sheet is CodeMirror's).
 */
export function attachPaperCaret(view: EditorView, panel: HTMLElement, pageView: () => boolean): void {
  panel.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.defaultPrevented || !pageView()) return;
    const target = e.target as Element;
    if (view.dom.contains(target) || target.closest(CONTROL)) return;
    e.preventDefault();
    const caret = caretAt(view, e.clientX, e.clientY);
    const anchor = e.shiftKey ? view.state.selection.anchor : caret.head;
    const select = (head: Selection) => {
      const { doc, selection } = view.state;
      const sel = head.head === anchor ? head : TextSelection.between(doc.resolve(Math.min(anchor, doc.content.size)), head.$head);
      if (!sel.eq(selection)) view.dispatch(view.state.tr.setSelection(sel));
    };
    select(caret);
    view.focus();
    const move = (m: MouseEvent) => {
      if (!(m.buttons & 1)) return stop();
      select(caretAt(view, m.clientX, m.clientY));
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  });

  document.addEventListener('mousedown', (e) => {
    const target = e.target as Element;
    if (e.button !== 0 || (target !== document.body && target !== document.documentElement && target.id !== 'hud')) return;
    const active = document.activeElement;
    if (active && (view.dom.contains(active) || active.closest('.cm-editor'))) e.preventDefault();
  });
}
