// The CodeMirror half of the source view: a plain-text editor over the
// document's own file format (SOURCE-VIEW.md, decision 4). Reached only
// through a dynamic import from source-view.ts, so every CodeMirror package
// lands in its own chunk and the page view pays nothing until the first
// toggle.

import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';

export type SourceFormat = '.md' | '.typ';

export interface SourceEditor {
  /** The text as typed, verbatim. */
  text(): string;
  /** Replace the whole text (a document arriving from disk while the
   *  source view is open). */
  setText(text: string): void;
  /** The caret's text offset (selection head). */
  caret(): number;
  /** Put the caret at a text offset and scroll it into view. */
  setCaret(offset: number): void;
  focus(): void;
  destroy(): void;
}

export interface SourceEditorOptions {
  text: string;
  format: SourceFormat;
  /** A document edit (not a selection change). */
  onChange: () => void;
}

export function mountSourceEditor(host: HTMLElement, opts: SourceEditorOptions): SourceEditor {
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: opts.text,
      extensions: [
        history(),
        drawSelection(),
        search({ top: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.lineWrapping,
        opts.format === '.md' ? markdown() : [],
        EditorView.updateListener.of((update) => {
          if (update.docChanged) opts.onChange();
        }),
      ],
    }),
  });
  return {
    text: () => view.state.doc.toString(),
    setText(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    caret: () => view.state.selection.main.head,
    setCaret(offset) {
      const pos = Math.max(0, Math.min(view.state.doc.length, offset));
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
