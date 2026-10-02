// A document from disk put in place of the one the editor shows.
//
// When the open file changes under a clean document (an edit in another
// editor, or a rewind from the shell's History window), the writer is
// usually looking at a page and has a caret in it. A fresh editor state
// would throw both away: the caret goes to the top, every plugin starts
// again, and the layout lays out the whole paper from nothing. So the
// reload is one transaction that replaces only the range between the
// first and the last difference, and sets each document attribute (the
// settings, the bibliography) that changed. The selection maps through
// it, so the caret stays where the text still allows; nodes outside the
// range keep their DOM, so the scroll stays; and the layout redoes only
// the pages that changed.
//
// The reload is its own undo step (closed on both sides), so ⌘Z puts back
// what the document held before it, as an editor that reloads a file
// does. It is not the writer's edit: the document then matches the disk,
// so main.ts leaves it out of the file manager's dirty flag (FROM_DISK).

import { closeHistory } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';

/** The meta a reload's transaction carries: not an edit, nothing to save. */
export const FROM_DISK = 'plass-from-disk';

/** Deep equality for document attributes, which are plain JSON (they go
 *  to session storage as such): a parsed file builds new objects, and a
 *  settings object set again when it holds the same values would re-apply
 *  every setting for nothing. */
const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The transaction that turns `state`'s document into `doc` by replacing
 *  only what differs, its own undo step (the caller closes the history
 *  after it too); null when nothing differs. */
export function reloadTransaction(state: EditorState, doc: PMNode): Transaction | null {
  const old = state.doc;
  if (old.eq(doc)) return null;
  let tr = state.tr;
  const start = old.content.findDiffStart(doc.content);
  if (start !== null) {
    let { a: endA, b: endB } = old.content.findDiffEnd(doc.content)!;
    // Repeated text lets the end overrun the start ("aa" to "aaa" differs
    // from 2 on, and from 2 back): move both ends past it.
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) {
      endA += overlap;
      endB += overlap;
    }
    // A cut through nested structure (a table, a list) can fit otherwise
    // than it was cut, or not at all; then the whole content goes.
    let fits = false;
    try {
      fits = tr.replace(start, endA, doc.slice(start, endB)).doc.content.eq(doc.content);
    } catch {
      fits = false;
    }
    if (!fits) tr = state.tr.replaceWith(0, old.content.size, doc.content);
  }
  for (const [name, value] of Object.entries(doc.attrs)) {
    if (!sameValue(tr.doc.attrs[name], value)) tr.setDocAttribute(name, value);
  }
  return tr.docChanged ? closeHistory(tr).setMeta(FROM_DISK, true) : null;
}
