// Editorial comments: plain-text notes between top-level blocks, shown on
// the page as a strip that is visibly not paper (editor-comments.css),
// kept in the working file (editor-comments-format.ts), absent from every
// rendered export. The one approved exception to "the page shows only
// printed content" (docs/COMMENTS-AND-APPEARANCE-HANDOFF.md).
//
// Layout: a note has no printed height. The paginator subtracts every
// note's painted height when it recovers print geometry, so page starts
// and line breaks never move; the displayed sheet that holds the note
// grows by exactly the note's height (typeset-plugin.ts, page-geometry.ts).

import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { Plugin, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { schema } from './schema';

const type = () => schema.nodes.editor_comment;

/** The note enclosing the selection's head, as (node, position), or null. */
function enclosingNote(state: EditorState): { node: PMNode; pos: number } | null {
  const { $from } = state.selection;
  if ($from.depth < 1) return null;
  const node = $from.node(1);
  return node.type === type() ? { node, pos: $from.before(1) } : null;
}

export class EditorCommentView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private header: HTMLElement;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.dom = document.createElement('div');
    this.dom.className = 'editor-comment';
    this.dom.setAttribute('data-editor-comment', '');
    // The label and the delete action are chrome, not content: never
    // editable, never parsed back into the note.
    this.header = document.createElement('div');
    this.header.className = 'editor-comment-header';
    this.header.contentEditable = 'false';
    const label = document.createElement('span');
    label.className = 'editor-comment-label';
    label.textContent = 'Comment';
    const tag = document.createElement('span');
    tag.className = 'editor-comment-tag';
    tag.textContent = 'Not printed';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'editor-comment-delete';
    remove.title = 'Delete comment (undo restores it)';
    remove.setAttribute('aria-label', 'Delete comment');
    remove.textContent = '×';
    remove.addEventListener('mousedown', (e) => e.preventDefault());
    remove.addEventListener('click', () => {
      const pos = getPos();
      if (pos === undefined) return;
      const current = view.state.doc.nodeAt(pos);
      if (!current || current.type !== type()) return;
      const tr = view.state.tr.delete(pos, pos + current.nodeSize);
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), -1));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    });
    this.header.append(label, tag, remove);
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'editor-comment-text';
    this.dom.append(this.header, this.contentDOM);
    void node;
  }

  update(node: PMNode): boolean {
    return node.type === type();
  }

  stopEvent(event: Event): boolean {
    return this.header.contains(event.target as Node);
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    // Header-only DOM changes are ours; content and selection changes must
    // reach ProseMirror.
    if (m.type === 'selection') return false;
    return !this.contentDOM.contains(m.target) && m.target !== this.contentDOM;
  }
}

/** Insert an empty note at a top-level boundary: before the caret's block
 *  when the caret sits at its very start, else after the last selected
 *  top-level block. Never splits a paragraph or replaces a selection, and
 *  never nests inside an existing note. */
export const insertEditorComment: Command = (state, dispatch) => {
  if (enclosingNote(state)) return false;
  const { $from, $to, empty } = state.selection;
  let pos: number;
  if ($from.depth === 0) {
    pos = $to.pos;
  } else {
    let atStart = empty && $from.parentOffset === 0;
    for (let d = 2; atStart && d <= $from.depth; d++) if ($from.index(d - 1) !== 0) atStart = false;
    pos = atStart ? $from.before(1) : $to.after(1);
  }
  if (dispatch) {
    const tr = state.tr.insert(pos, type().create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView());
  }
  return true;
};

/** Leave the note: the caret lands at the start of the next top-level
 *  block, or in a new paragraph when the note ends the document. */
const exitEditorComment: Command = (state, dispatch) => {
  const note = enclosingNote(state);
  if (!note) return false;
  if (dispatch) {
    const after = note.pos + note.node.nodeSize;
    const tr = state.tr;
    if (after >= state.doc.content.size) tr.insert(after, schema.nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1), 1)).scrollIntoView());
  }
  return true;
};

/** Enter inside a note is a newline, not a block split. */
const newlineInEditorComment: Command = (state, dispatch) => {
  if (!enclosingNote(state)) return false;
  dispatch?.(state.tr.insertText('\n').scrollIntoView());
  return true;
};

/** Backspace at the start of a note: an empty note is deleted, a filled
 *  one holds its ground (isolating: nothing joins across its boundary). */
const backspaceInEditorComment: Command = (state, dispatch) => {
  const note = enclosingNote(state);
  if (!note) return false;
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  if (note.node.content.size > 0) return true;
  if (dispatch) {
    const tr = state.tr.delete(note.pos, note.pos + note.node.nodeSize);
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(note.pos, tr.doc.content.size)), -1)).scrollIntoView());
  }
  return true;
};

/** Registered before the general editing keymap, whose Mod-Enter inserts a
 *  page break. Inside a note: Enter/Shift-Enter newline, Mod-Enter exits,
 *  Backspace at the start deletes an empty note. Elsewhere every binding
 *  declines, so the ordinary commands run. */
export function editorCommentKeymap(): Plugin {
  return keymap({
    Enter: newlineInEditorComment,
    'Shift-Enter': newlineInEditorComment,
    'Mod-Enter': exitEditorComment,
    Backspace: backspaceInEditorComment,
  });
}

/** Notes pasted where they cannot live (inside a list item, a quote, a
 *  cell, a footnote) become paragraphs, one per line, so nothing typed is
 *  lost to the schema. At the top level they paste as notes. */
export function editorCommentPaste(): Plugin {
  return new Plugin({
    props: {
      transformPasted(slice, view) {
        const { $from } = view.state.selection;
        if ($from.depth <= 1 && !enclosingNote(view.state)) return slice;
        let found = false;
        slice.content.descendants((n) => {
          if (n.type === type()) found = true;
          return !found;
        });
        if (!found) return slice;
        const nodes: PMNode[] = [];
        slice.content.forEach((n) => {
          if (n.type !== type()) {
            nodes.push(n);
            return;
          }
          for (const line of n.textContent.split('\n')) {
            nodes.push(schema.nodes.paragraph.create(null, line ? [schema.text(line)] : []));
          }
        });
        return new Slice(Fragment.from(nodes), slice.openStart, slice.openEnd);
      },
    },
  });
}
