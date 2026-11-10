// Editorial comments: notes between top-level blocks, shown on the page
// as a strip that is visibly not paper (editor-comments.css), kept in the
// working file (editor-comments-format.ts), absent from every rendered
// export. The one approved exception to "the page shows only printed
// content" (docs/COMMENTS-AND-APPEARANCE-HANDOFF.md).
//
// A note holds lines of plain text (`comment_text`, newlines as typed)
// and tables (Taylor, 2026-11-09: "just add a table inside the comment"):
// the page's own table, drawn by the browser rather than laid out exactly
// (a note never prints), saved inside the comment as the same Markdown
// table (md-serializer's `commentPayload`, md-parser's
// `commentFromPayload`). `normalizeComments` keeps a note's shape
// `comment_text (table comment_text)*`: a line before and after every
// table, so a caret always has one to land on. What print counts or
// numbers never goes in a note (`commentRefusal`: a footnote, a
// citation, a figure, a display equation, a grid, a page break): an edit
// that would put one there is refused, with a toast.
//
// Layout: a note has no printed height. The paginator subtracts every
// note's painted height when it recovers print geometry, so page starts
// and line breaks never move; the displayed sheet that holds the note
// grows by exactly the note's height (typeset-plugin.ts, page-geometry.ts).

import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { Plugin, Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { NodeView, ViewMutationRecord } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { schema } from './schema';
import { commentRefusal } from './editor-comments-format';
import { notify } from './notify';

const type = () => schema.nodes.editor_comment;
const lineType = () => schema.nodes.comment_text;

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON_COMMENT = svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>');

/** The note enclosing the selection's head, as (node, position), or null. */
function enclosingNote(state: EditorState): { node: PMNode; pos: number } | null {
  const { $from } = state.selection;
  if ($from.depth < 1) return null;
  const node = $from.node(1);
  return node.type === type() ? { node, pos: $from.before(1) } : null;
}

/** A stored document (a tab's session, the autosave: JSON) from before
 *  notes held tables (2026-11-09): a note's text, its whole content then,
 *  becomes its one line; an empty note gets an empty line. */
export function migrateNoteJSON(json: unknown): unknown {
  if (!json || typeof json !== 'object') return json;
  const node = json as { type?: string; content?: unknown[] };
  if (node.type === 'editor_comment' && !node.content?.some((c) => (c as { type?: string })?.type !== 'text')) {
    return { ...node, content: [{ type: 'comment_text', ...(node.content?.length ? { content: node.content } : {}) }] };
  }
  return Array.isArray(node.content) ? { ...node, content: node.content.map(migrateNoteJSON) } : json;
}

/** A note with one empty line: what the Comment tool inserts. */
export function emptyNote(): PMNode {
  return type().create(null, lineType().create());
}

export class EditorCommentView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private header: HTMLElement;

  constructor(node: PMNode) {
    this.dom = document.createElement('div');
    this.dom.className = 'editor-comment';
    this.dom.setAttribute('data-editor-comment', '');
    // The label is chrome, not content: never editable, never parsed back
    // into the note. No delete button (removed 2026-11-09): Backspace in
    // an emptied note deletes it.
    this.header = document.createElement('div');
    this.header.className = 'editor-comment-header';
    this.header.contentEditable = 'false';
    const label = document.createElement('span');
    label.className = 'editor-comment-label';
    label.innerHTML = `${ICON_COMMENT}<span>Comment</span>`;
    const tag = document.createElement('span');
    tag.className = 'editor-comment-tag';
    tag.textContent = 'Not printed';
    this.header.append(label, tag);
    // Its lines and tables.
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'editor-comment-body';
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
    const tr = state.tr.insert(pos, emptyNote());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 2)).scrollIntoView());
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

/** Enter on a note's line is a newline, not a block split. (In a note's
 *  table, Enter is the table's.) */
const newlineInEditorComment: Command = (state, dispatch) => {
  if (!enclosingNote(state) || state.selection.$from.parent.type !== lineType()) return false;
  dispatch?.(state.tr.insertText('\n').scrollIntoView());
  return true;
};

/** Backspace at the start of a note's line: in a note of one empty line
 *  the note goes; after a table the caret goes into the table's last
 *  cell (nothing joins into a table); any other line holds its ground
 *  (isolating: nothing joins across the note's boundary). */
const backspaceInEditorComment: Command = (state, dispatch) => {
  const note = enclosingNote(state);
  if (!note) return false;
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== lineType() || $from.parentOffset !== 0) return false;
  const index = $from.index(1);
  if (index > 0) {
    if (dispatch) dispatch(state.tr.setSelection(Selection.near(state.doc.resolve($from.before(2)), -1)).scrollIntoView());
    return true;
  }
  if (note.node.childCount > 1 || note.node.content.size > 2) return true;
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

/** A note's lines as paragraphs, one per line; its tables as they are. */
function noteAsBlocks(note: PMNode): PMNode[] {
  const nodes: PMNode[] = [];
  note.forEach((child) => {
    if (child.type !== lineType()) {
      nodes.push(child);
      return;
    }
    for (const line of child.textContent.split('\n')) {
      nodes.push(schema.nodes.paragraph.create(null, line ? [schema.text(line)] : []));
    }
  });
  return nodes;
}

/** Notes pasted where they cannot live (inside a list item, a quote, a
 *  cell, a footnote, another note) become paragraphs, one per line, and
 *  their tables, so nothing typed is lost to the schema. At the top level
 *  they paste as notes. */
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
          if (n.type === type()) nodes.push(...noteAsBlocks(n));
          else nodes.push(n);
        });
        return new Slice(Fragment.from(nodes), slice.openStart, slice.openEnd);
      },
    },
  });
}

/** The changed ranges of `tr`, in its new document. */
function changedRanges(tr: Transaction): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  tr.mapping.maps.forEach((map, i) => {
    const after = tr.mapping.slice(i + 1);
    map.forEach((_a, _b, from, to) => ranges.push([after.map(from, -1), after.map(to, 1)]));
  });
  return ranges;
}

/** Keeps every note in its shape and its content to what a note holds:
 *  - an edit that would put in a note what print counts or numbers (a
 *    footnote, a citation, a figure, a display equation, a grid, a page
 *    break, a table in a table) is refused, with a toast. A whole
 *    document arriving (a file opened, a reload) is the reader's, which
 *    never builds one (md-parser's `commentFromPayload`);
 *  - after any edit, each note is `comment_text (table comment_text)*`:
 *    adjacent lines join (a table deleted between them: its two lines
 *    become one, a newline between), and a line goes before, between and
 *    after tables where one is missing. */
export function commentShape(): Plugin {
  return new Plugin({
    filterTransaction(tr, state) {
      if (!tr.docChanged) return true;
      const whole = tr.steps.length === 1 && (tr.steps[0] as unknown as { from?: number; to?: number }).from === 0 && (tr.steps[0] as unknown as { to?: number }).to === state.doc.content.size;
      if (whole) return true;
      let refusal: string | null = null;
      for (const [from, to] of changedRanges(tr)) {
        if (refusal) break;
        tr.doc.nodesBetween(Math.max(0, from), Math.min(to, tr.doc.content.size), (node) => {
          if (refusal) return false;
          if (node.type === type()) refusal = commentRefusal(node);
          return false;
        });
      }
      if (refusal) notify(`Not in a comment: ${refusal}. A comment holds text and tables.`);
      return !refusal;
    },
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged)) return null;
      const tr = state.tr;
      // Last to first, so each fix leaves the positions before it alone.
      const notes: Array<{ node: PMNode; pos: number }> = [];
      state.doc.forEach((node, pos) => {
        if (node.type === type()) notes.push({ node, pos });
      });
      for (let k = notes.length - 1; k >= 0; k--) {
        const { node, pos } = notes[k];
        const kids: Array<{ node: PMNode; pos: number }> = [];
        node.forEach((child, offset) => kids.push({ node: child, pos: pos + 1 + offset }));
        // A line after the last table.
        if (kids[kids.length - 1].node.type !== lineType()) tr.insert(pos + node.nodeSize - 1, lineType().create());
        for (let i = kids.length - 1; i >= 0; i--) {
          const kid = kids[i];
          const prev = kids[i - 1];
          if (kid.node.type === lineType()) {
            // Two lines side by side join, a newline between.
            if (prev?.node.type === lineType()) {
              tr.insertText('\n', kid.pos - 1);
              tr.join(kid.pos + 1);
            }
          } else if (!prev || prev.node.type !== lineType()) {
            // A line before a table (first in the note, or after another).
            tr.insert(kid.pos, lineType().create());
          }
        }
      }
      return tr.docChanged ? tr : null;
    },
  });
}
