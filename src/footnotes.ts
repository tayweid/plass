// Footnotes: inline marker, body edited in place at the bottom of its page.
//
// The node view keeps ProseMirror calm while the paginator imperatively
// positions the body (style attributes on .fn-body are presentation, not
// content). Numbering is painted by the numbering plugin.

import { Plugin, TextSelection, type Command } from 'prosemirror-state';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { InputRule } from 'prosemirror-inputrules';
import { schema } from './schema';

export class FootnoteView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  constructor(node: PMNode) {
    this.dom = document.createElement('span');
    this.dom.className = 'ts-footnote';
    this.dom.setAttribute('data-footnote', '');
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'fn-body';
    this.dom.appendChild(this.contentDOM);
    void node;
  }

  update(node: PMNode): boolean {
    return node.type === schema.nodes.footnote;
  }

  ignoreMutation(m: ViewMutationRecord) {
    // The paginator styles .fn-body (top/visibility/class) — presentation
    // only; content mutations inside the body must still reach ProseMirror.
    if (m.type === 'attributes') return true;
    return !this.contentDOM.contains(m.target);
  }
}

/** True if the selection is inside a footnote body. */
function inFootnote(state: Parameters<Command>[0]): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.footnote) return true;
  }
  return false;
}

/** Insert a footnote at the cursor and start editing its body. */
export const insertFootnote: Command = (state, dispatch) => {
  if (inFootnote(state) || !state.selection.$from.parent.isTextblock) return false;
  if (dispatch) {
    const fn = schema.nodes.footnote.create();
    let tr = state.tr.replaceSelectionWith(fn);
    tr = tr.setSelection(TextSelection.create(tr.doc, state.selection.from + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Enter inside a footnote body returns the caret to just after the marker. */
export const exitFootnote: Command = (state, dispatch) => {
  const { $from } = state.selection;
  let depth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.footnote) {
      depth = d;
      break;
    }
  }
  if (depth < 0) return false;
  if (dispatch) {
    const after = $from.after(depth);
    dispatch(state.tr.setSelection(TextSelection.near(state.tr.doc.resolve(after), 1)).scrollIntoView());
  }
  return true;
};

/**
 * Typed footnote entry: `^[` (Pandoc) or `\footnote{` (LaTeX reflex) creates
 * a footnote and moves the caret into its body.
 */
function openRule(pattern: RegExp): InputRule {
  return new InputRule(pattern, (state, _match, start, end) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === schema.nodes.footnote) return null; // no nesting
    }
    if (!$from.parent.isTextblock) return null;
    let tr = state.tr.replaceWith(start, end, schema.nodes.footnote.create());
    tr = tr.setSelection(TextSelection.create(tr.doc, start + 1));
    return tr;
  });
}

export const footnoteOpenRules = [openRule(/\^\[$/), openRule(/\\footnote\{$/)];

/**
 * Typing the matching closer (`]` or `}`) inside a body exits the footnote —
 * unless an unmatched opener precedes the caret, in which case the bracket
 * is literal (so "[1]" still types normally inside a note).
 */
export const footnoteCloseRule = new InputRule(/[\]}]$/, (state, match) => {
  const closer = match[0];
  const opener = closer === ']' ? '[' : '{';
  const { $from } = state.selection;
  if ($from.parent.type !== schema.nodes.footnote) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, ' ', ' ');
  const opens = before.split(opener).length - 1;
  const closes = before.split(closer).length - 1;
  if (opens > closes) return null; // literal bracket
  const after = $from.after();
  return state.tr.setSelection(TextSelection.create(state.tr.doc, after)).scrollIntoView();
});

/** Click a marker (the superscript ::before sits on the outer span) to jump into the body. */
export function footnoteMarkerClick(view: EditorView, event: MouseEvent): boolean {
  const target = event.target as HTMLElement;
  if (!target.classList?.contains('ts-footnote')) return false;
  const pos = view.posAtDOM(target, 0);
  if (pos < 0) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).setMeta('fn-enter', true));
  view.focus();
  return true;
}

/**
 * Vertical arrows (browser caret geometry) can drop the caret into a
 * footnote body — it renders at the page bottom but lives DOM-inside the
 * anchor paragraph. A footnote body is only entered deliberately: by
 * clicking it, clicking its marker, or creating one. Any other selection
 * move that lands inside from outside gets bounced past the anchor block
 * in the direction of travel.
 */
export function footnoteGuard(): Plugin {
  const fnDepth = ($pos: ResolvedPos): number => {
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type === schema.nodes.footnote) return d;
    }
    return 0;
  };
  return new Plugin({
    appendTransaction(trs, oldState, newState) {
      if (!trs.some((tr) => tr.selectionSet)) return null;
      if (trs.some((tr) => tr.docChanged || tr.getMeta('pointer') || tr.getMeta('fn-enter'))) return null;
      if (!newState.selection.empty) return null;
      const $from = newState.selection.$from;
      const depth = fnDepth($from);
      if (!depth || fnDepth(oldState.selection.$from)) return null;
      // Entered a footnote via keyboard/geometric motion: hop over the
      // anchor textblock in the direction of travel.
      const dir = newState.selection.from >= oldState.selection.from ? 1 : -1;
      const anchorDepth = depth - 1; // the textblock containing the marker
      const target = dir > 0 ? $from.after(anchorDepth) : $from.before(anchorDepth);
      const $target = newState.doc.resolve(Math.max(0, Math.min(target, newState.doc.content.size)));
      return newState.tr.setSelection(TextSelection.near($target, dir)).scrollIntoView();
    },
  });
}


/**
 * Horizontal arrows hop over footnote markers instead of dropping the caret
 * into the (page-bottom) body — the body is entered by clicking the marker
 * or the body itself, never by walking past the superscript.
 */
export function skipFootnote(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection;
    if (!empty || !$from.parent.isTextblock) return false;
    const node = dir > 0 ? $from.nodeAfter : $from.nodeBefore;
    if (!node || node.type !== schema.nodes.footnote) return false;
    if (dispatch) {
      const pos = $from.pos + dir * node.nodeSize;
      dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos), dir)).scrollIntoView());
    }
    return true;
  };
}
