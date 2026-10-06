// The space a line breaks at is kept through an edit beside it. Found
// 2026-10-06: a letter typed at the end of a wrapped line ran the line's
// last word into the next line's first ("Every line break" became "Every
// linexbreak").
//
// The space at a line break is the last character of its line: the layout
// draws the break after it (a `<br class="ts-br">`, or a `.ts-pagegap` at
// a page break; layout/line-decorations.ts), and the editor's `white-space:
// normal` collapses a space that ends a line, so it paints nothing. Chrome's
// editing deletes collapsed ("insignificant") whitespace next to where it
// writes: its InsertText removes the collapsed text between the caret and
// the next drawn position, and ProseMirror reads the change as the space
// replaced by what was typed. The same goes for an IME's text (an accent
// typed with a dead key), and a Backspace at the line end took the letter
// and the space with it. A Backspace at the start of the next line took the
// letter too: ProseMirror moves the DOM caret back across the `<br>` before
// a Backspace (its skipIgnoredNodes), so it lands after the collapsed space,
// where Chrome's caret is the end of the line above. And a space typed at
// a line end came out as a non-breaking space in the break space's place:
// glue, which prints the two words welded (`~` in Typst).
//
// So a letter typed, or a Backspace, with the caret on either side of a
// break space is done here, not by the browser: its `beforeinput` is
// cancelled and the edit is the document's. Typed text goes through the
// `handleTextInput` props as a key typed anywhere does (the input rules:
// smart quotes, `**bold**`, math, footnotes), and is put at the caret. A
// Backspace deletes from where Chrome's own target range starts up to the
// caret, never past it; after a break space it deletes that space, the
// character before the caret. A space typed at a line end is then two
// plain spaces, which the printed-form normalizer (collapse-spaces.ts)
// makes one, as it does anywhere.
//
// An IME's text (an accent typed with a dead key, kana turned to kanji)
// cannot be cancelled. The break space it takes is put back as ProseMirror
// reads each change, after the composed text with the caret before it, so
// the line keeps its break while the composition runs (appendTransaction),
// and drawn in a span of its own; a composition over a selection that ends
// at a line end deletes the selection first (compositionstart).
//
// Word and line deletions (Option- and Command-Backspace) are left to the
// browser: what they take with the space is a space the words still have
// between them, or one that would start the paragraph.

import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import { Mapping } from 'prosemirror-transform';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { TypesetDecorationSpec } from './layout/line-decorations';
import { typesetKey } from './layout/typeset-state';

/** Whether the character at `pos` is a space a line breaks at: a plain
 *  space with the layout's line break, or page break, drawn right after it
 *  (or right before it, where an edit's mapping has put the break until the
 *  next layout pass: a space put back below sits after the break). */
function isBreakSpace(state: EditorState, pos: number): boolean {
  if (pos < 0 || pos + 1 > state.doc.content.size) return false;
  if (state.doc.textBetween(pos, pos + 1) !== ' ') return false;
  const decos = typesetKey.getState(state)?.decos;
  return !!decos?.find(pos, pos + 1, (spec) => {
    const kind = (spec as Partial<TypesetDecorationSpec>).tsKind;
    return kind === 'line-break' || kind === 'line-page-gap';
  }).length;
}

/** The document position of the DOM caret, where the browser would edit,
 *  when it is collapsed in the editor. */
function domCaret(view: EditorView): number | null {
  const sel = view.dom.ownerDocument.getSelection();
  if (!sel?.isCollapsed || !sel.focusNode || !view.dom.contains(sel.focusNode)) return null;
  return view.posAtDOM(sel.focusNode, sel.focusOffset);
}

function typeAt(view: EditorView, at: number, text: string): void {
  const deflt = () => {
    const tr = view.state.tr.insertText(text, at, at);
    return tr.setSelection(TextSelection.create(tr.doc, at + text.length)).scrollIntoView();
  };
  if (!view.someProp('handleTextInput', (f) => f(view, at, at, text, deflt))) view.dispatch(deflt());
}

function deleteBefore(view: EditorView, from: number, to: number): void {
  const { doc } = view.state;
  const tr = view.state.tr.delete(from, to);
  // As ProseMirror's own read of a deletion: the next letter typed keeps
  // the deleted text's marks.
  const marks = doc.resolve(from).marksAcross(doc.resolve(to));
  if (marks) tr.ensureMarks(marks);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from)).scrollIntoView());
}

/** The space put back after an IME's text (below), while it is. */
const restoredKey = new PluginKey<number | null>('break-space-restored');

export function breakSpaceInput(): Plugin {
  return new Plugin<number | null>({
    key: restoredKey,
    // The space put back is drawn in a span of its own until the next edit
    // that is not an IME's. Otherwise it ends the composed text's text node,
    // and an IME's next composition, written before it, makes it a
    // non-breaking space: Chrome turns a plain space that ends the text node
    // it writes in into one, so that it cannot collapse. (Turned back while
    // the composition runs, the composition broke.)
    state: {
      init: () => null,
      apply(tr, pos) {
        const restored = tr.getMeta(restoredKey) as number | undefined;
        if (restored !== undefined) return restored;
        if (pos === null || (tr.docChanged && !tr.getMeta('composition'))) return null;
        const mapped = tr.mapping.map(pos, 1);
        return tr.doc.textBetween(mapped, Math.min(mapped + 1, tr.doc.content.size)) === ' ' ? mapped : null;
      },
    },
    // A transaction ProseMirror read from the DOM during an IME's
    // composition (its `composition` meta) took the break space just after
    // the selection: put it back after the composed text, the caret before
    // it. Chrome takes it with the composition's first text and again when
    // the composition is committed. The space goes back with the composed
    // text's last letter rewritten before it: the line's break, mapped to
    // the end of a replaced range, then follows the space. Inserted on its
    // own, at the break, it would follow the break (a widget keeps to the
    // text before it), and until the next layout pass the caret before it
    // would be drawn at the start of the next line, where an IME's next
    // composition would write.
    appendTransaction(trs, oldState, newState) {
      if (!trs.some((tr) => tr.docChanged && tr.getMeta('composition'))) return null;
      const at = oldState.selection.to;
      if (!isBreakSpace(oldState, at)) return null;
      const mapping = new Mapping();
      for (const tr of trs) mapping.appendMapping(tr.mapping);
      const end = mapping.mapResult(at + 1, -1);
      if (!end.deletedBefore || newState.doc.textBetween(end.pos, end.pos + 1) === ' ') return null;
      const { schema } = newState;
      const space = schema.text(' ', oldState.doc.nodeAt(at)!.marks);
      const last = newState.doc.resolve(end.pos).nodeBefore;
      const tr = last?.isText
        ? newState.tr.replaceWith(end.pos - 1, end.pos, [schema.text(last.text!.slice(-1), last.marks), space])
        : newState.tr.insert(end.pos, space);
      const { anchor, head } = newState.selection;
      const keep = (p: number) => (p <= end.pos ? p : p + 1);
      if (newState.selection instanceof TextSelection) tr.setSelection(TextSelection.create(tr.doc, keep(anchor), keep(head)));
      return tr.setMeta(restoredKey, end.pos);
    },
    props: {
      decorations(state) {
        const pos = restoredKey.getState(state);
        return pos == null ? null : DecorationSet.create(state.doc, [Decoration.inline(pos, pos + 1, { class: 'ts-restored-space' })]);
      },
      handleDOMEvents: {
        // An IME's text that replaces a selection ending at a line end:
        // the selection is deleted first, so the composition starts at a
        // caret, as above. Composed over the selection, it came out wrong
        // (the selection kept, or the composed letter written twice).
        compositionstart(view) {
          const { state } = view;
          if (view.composing || state.selection.empty || !(state.selection instanceof TextSelection)) return false;
          if (isBreakSpace(state, state.selection.to)) view.dispatch(state.tr.deleteSelection());
          return false;
        },
        beforeinput(view, event) {
          const input = event as InputEvent;
          if (input.isComposing || view.composing) return false;
          if (input.inputType !== 'insertText' && input.inputType !== 'deleteContentBackward') return false;
          const caret = domCaret(view);
          if (caret === null) return false;
          const { state } = view;
          const before = isBreakSpace(state, caret - 1);
          if (!before && !isBreakSpace(state, caret)) return false;
          if (input.inputType === 'insertText') {
            if (!input.data) return false;
            event.preventDefault();
            typeAt(view, caret, input.data);
            return true;
          }
          let from = caret - 1;
          if (!before) {
            const range = input.getTargetRanges()[0];
            if (!range || !view.dom.contains(range.startContainer)) return false;
            from = view.posAtDOM(range.startContainer, range.startOffset);
            if (from >= caret || from < state.doc.resolve(caret).start()) return false;
          }
          event.preventDefault();
          deleteBefore(view, from, caret);
          return true;
        },
      },
    },
  });
}
