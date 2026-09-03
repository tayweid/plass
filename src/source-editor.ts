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

import { EditorState, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, drawSelection, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import {
  HighlightStyle,
  StreamLanguage,
  codeFolding,
  foldEffect,
  foldedRanges,
  syntaxHighlighting,
  unfoldEffect,
} from '@codemirror/language';
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
  /** End offset of the generated Typst preamble (the settings block the
   *  Settings panel edits), folded away on mount so the source opens on
   *  the body. 0 or undefined: nothing to fold. */
  preambleEnd?: number;
}

// ---------- the folded preamble ----------
//
// A .typ source begins with twenty-odd generated lines (`#set page`, the
// parity `#show` rules, `#import`) before the first heading. They are the
// file — saved verbatim, decision 3 — but they are the machine's settings
// block, so they open folded behind one quiet line and unfold on click.
// Presentation only: the text underneath is untouched and still editable
// once unfolded, and edits there apply on exit like a file open would.

/** Where the preamble ends, mapped through edits while unfolded; 0 once
 *  it has been deleted. */
const preambleEnd = StateField.define<number>({
  create: () => 0,
  update: (to, tr) => (to ? tr.changes.mapPos(to, 1) : 0),
});

const isPreambleFolded = (state: EditorState): boolean => {
  let folded = false;
  foldedRanges(state).between(0, 0, (from) => {
    if (from === 0) folded = true;
  });
  return folded;
};

/** The first body position after the preamble's trailing blank line. */
function bodyStart(state: EditorState): number {
  let pos = state.field(preambleEnd);
  while (pos < state.doc.length && state.doc.sliceString(pos, pos + 1) === '\n') pos++;
  return pos;
}

/** The "fold" affordance shown above an unfolded preamble. */
class PreambleBar extends WidgetType {
  eq() {
    return true;
  }
  toDOM(view: EditorView) {
    const bar = document.createElement('div');
    bar.className = 'source-preamble-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'source-preamble-fold-btn';
    btn.textContent = '⚙ Document settings · fold';
    btn.title = 'Fold the generated settings block';
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const to = view.state.field(preambleEnd);
      if (to > 0) view.dispatch({ effects: foldEffect.of({ from: 0, to }), selection: { anchor: bodyStart(view.state) } });
    });
    bar.appendChild(btn);
    return bar;
  }
  ignoreEvent() {
    return false;
  }
}

/** Block widgets must come from a state field, not a view plugin. */
const preambleBar = StateField.define<DecorationSet>({
  create: (state) => barDecorations(state),
  update: (_deco, tr) => barDecorations(tr.state),
  provide: (field) => EditorView.decorations.from(field),
});

function barDecorations(state: EditorState): DecorationSet {
  const to = state.field(preambleEnd);
  if (!to || isPreambleFolded(state)) return Decoration.none;
  return Decoration.set([Decoration.widget({ widget: new PreambleBar(), block: true, side: -1 }).range(0)]);
}

/** Enter with the caret against the folded block unfolds it (the fold is
 *  atomic, so the caret can only rest at its ends). */
const unfoldOnEnter = keymap.of([
  {
    key: 'Enter',
    run(view) {
      const to = view.state.field(preambleEnd);
      const { head, empty } = view.state.selection.main;
      if (!to || !empty || !isPreambleFolded(view.state) || (head !== 0 && head !== to)) return false;
      view.dispatch({ effects: unfoldEffect.of({ from: 0, to }), selection: { anchor: 0 } });
      return true;
    },
  },
]);

function preambleFolding(to: number): Extension {
  return [
    preambleEnd.init(() => to),
    codeFolding({
      preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number + 1,
      placeholderDOM(_view, onclick, lines: number) {
        const el = document.createElement('span');
        el.className = 'source-preamble-fold';
        el.title = 'Click to expand';
        el.setAttribute('aria-label', `Document settings, ${lines} lines, folded — click to expand`);
        el.textContent = `⚙ Document settings · ${lines} lines`;
        const hint = document.createElement('span');
        hint.className = 'source-preamble-hint';
        hint.textContent = 'click to expand';
        el.appendChild(hint);
        el.addEventListener('click', onclick);
        return el;
      },
    }),
    preambleBar,
    unfoldOnEnter,
  ];
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
        opts.preambleEnd ? preambleFolding(opts.preambleEnd) : [],
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
  if (opts.preambleEnd) {
    // Start folded, caret on the body — never inside the folded range.
    view.dispatch({ effects: foldEffect.of({ from: 0, to: opts.preambleEnd }), selection: { anchor: bodyStart(view.state) } });
  }
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
