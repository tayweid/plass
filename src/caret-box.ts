// The caret's drawn box. ProseMirror measures a caret by the character
// after it (`coordsAtPos`'s default side, 1), but at the end of a wrapped
// line that character is the space the line breaks at, and the editor's
// `white-space: normal` collapses it away: it sits between the line's
// word-spacing span and the layout's `<br class="ts-br">` (or a
// `.ts-pagegap`), paints nothing, and measures an all-zero box. A caret
// there is drawn at the end of its line, the box of the character before
// it (side -1).
//
// What measured the zero box (2026-10-06): the scroll rail put its caret
// mark at the top of the paper, "page 1", for a caret at a line end on any
// page; and a layout pass that carried a followed caret from the middle of
// a line to the end of the one above (letters deleted from a line's first
// word until it fit up there) read the caret at the window's top after the
// pass and scrolled the panel up by the caret's whole height on the screen
// (paperPass in paper-scale.ts).

import type { EditorView } from 'prosemirror-view';

type CaretBox = ReturnType<EditorView['coordsAtPos']>;

/** The box of a caret at `pos` as the browser draws it: side 1's, unless
 *  that box is empty, then side -1's. */
export function caretBox(view: EditorView, pos: number): CaretBox {
  const box = view.coordsAtPos(pos);
  return box.bottom > box.top ? box : view.coordsAtPos(pos, -1);
}
