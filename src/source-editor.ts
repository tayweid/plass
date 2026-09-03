// The CodeMirror half of the source view: a plain-text editor over the
// document's own file format (SOURCE-VIEW.md, decision 4). Reached only
// through a dynamic import from source-view.ts, so every CodeMirror package
// lands in its own chunk and the page view pays nothing until the first
// toggle.
//
// The look (SOURCE-VIEW.md, "Look"): markup dimmed, heading lines bold,
// math and raw in a faint tint, links and `@` references in the accent.
// One HighlightStyle serves both languages — the Typst rails mode
// (source-typst-mode.ts) emits the same standard tags lang-markdown does.
// The sheet, measure and fonts are CSS (#source in style.css).

import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import type { BlockContext, InlineContext, Line, MarkdownExtension } from '@lezer/markdown';
import { typstRails } from './source-typst-mode';

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

const DOLLAR = 36;
const AT = 64;
const WORD = /[\p{L}\p{N}_]/u;
const REF = /^@[\p{L}\p{N}_-]+(?:[:.][\p{L}\p{N}_-]+)*/u;

/** Plass's Markdown beyond CommonMark+GFM: `$…$` / `$$` math (extracted
 *  before markdown-it sees it in md-parser.ts) and `@key` references.
 *  Highlight-only: these exist so the source view can tint them. */
const plassMarkdown: MarkdownExtension = {
  defineNodes: [
    { name: 'InlineMath', style: tags.special(tags.string) },
    { name: 'MathBlock', block: true, style: tags.special(tags.string) },
    { name: 'PlassRef', style: tags.link },
  ],
  parseBlock: [
    {
      name: 'MathBlock',
      parse(cx: BlockContext, line: Line) {
        if (!line.text.startsWith('$$', line.pos)) return false;
        const start = cx.lineStart + line.pos;
        const endOf = () => cx.lineStart + line.text.length;
        // `$$ … $$` on one line, or a fence closed by a later `$$` line
        // (the serializer writes `$$ {#eq:label}` after the closing fence).
        let end = line.text.indexOf('$$', line.pos + 2) >= 0 ? endOf() : -1;
        while (end < 0 && cx.nextLine()) {
          if (line.text.trimStart().startsWith('$$')) end = endOf();
        }
        if (end < 0) end = cx.prevLineEnd();
        else cx.nextLine();
        cx.addElement(cx.elt('MathBlock', start, end));
        return true;
      },
      endLeaf: (_cx: BlockContext, line: Line) => line.text.startsWith('$$', line.pos),
    },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      before: 'Escape',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== DOLLAR) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === 92 /* \ */) i++;
          else if (ch === DOLLAR && i > pos + 1) return cx.addElement(cx.elt('InlineMath', pos, i + 1));
        }
        return -1;
      },
    },
    {
      name: 'PlassRef',
      before: 'Escape',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== AT || (pos > cx.offset && WORD.test(cx.slice(pos - 1, pos)))) return -1;
        const m = REF.exec(cx.slice(pos, cx.end));
        return m ? cx.addElement(cx.elt('PlassRef', pos, pos + m[0].length)) : -1;
      },
    },
  ],
};

/** Colors come from the app's tokens (style.css); the style only says
 *  which tag gets which treatment. */
const railsHighlight = HighlightStyle.define([
  { tag: tags.processingInstruction, color: 'var(--ink-soft)' },
  { tag: tags.meta, color: 'var(--ink-soft)' },
  { tag: tags.contentSeparator, color: 'var(--ink-soft)' },
  { tag: tags.comment, color: 'var(--ink-soft)', fontStyle: 'italic' },
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.monospace, color: 'var(--source-raw)', backgroundColor: 'var(--source-tint)' },
  { tag: tags.special(tags.string), color: 'var(--source-raw)', backgroundColor: 'var(--source-tint)' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--accent)' },
  { tag: tags.labelName, color: 'var(--accent)' },
  { tag: tags.string, color: 'var(--ink-soft)' },
]);

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
        opts.format === '.md'
          ? markdown({ base: markdownLanguage, extensions: plassMarkdown })
          : StreamLanguage.define(typstRails),
        syntaxHighlighting(railsHighlight),
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
