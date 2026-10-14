// Typst highlighting for the source view, covering ONLY the rails
// (SOURCE-VIEW.md, decision 4): `=` headings, `-`/`+` list markers, `$…$`
// math, `#name[` / `#name(` calls, `//` comments, raw fences and inline
// raw, `@key` citations and references, `*…*` / `_…_` emphasis, `<label>`.
// Everything else is plain text — the highlighter, like the editor, only
// knows the rails; off-rails Typst renders as prose, which is what it is
// to Plass. A hand-written stream mode, not a Typst grammar, on purpose.
//
// Token names are the standard highlight tags (@lezer/highlight), shared
// with the Markdown mode so one HighlightStyle dresses both:
//   processingInstruction  markup characters (dimmed)
//   heading                the rest of a heading line (bold)
//   meta                   a `#name` call head (dimmed)
//   comment                `//` to end of line
//   monospace              raw: fences and backtick spans
//   string.special         math
//   link                   `@key`
//   labelName              `<label>`
//   strong / emphasis      text inside `*…*` / `_…_`

import type { StreamParser, StringStream } from '@codemirror/language';

export interface TypstRailsState {
  /** Inside a ``` fence (until the closing fence line). */
  fence: boolean;
  /** Inside a backtick raw span (they may span lines: `#mitex(`…`)`). */
  raw: boolean;
  /** Inside `$…$` (display math spans lines). */
  math: boolean;
  strong: boolean;
  em: boolean;
  /** The rest of the current line is a heading. */
  heading: boolean;
}

const WORD = /[\p{L}\p{N}_]/u;
/** What may precede a `@key`: not a word (an email) and not a quote (a
 *  package path in `#import "@preview/…"`). */
const NOT_REF_START = /[\p{L}\p{N}_"]/u;
const REF = /^@[\p{L}\p{N}_-]+(?:[:.][\p{L}\p{N}_-]+)*/u;
const CALL = /^#[\p{L}_][\p{L}\p{N}_-]*(?=[[(])/u;
const LABEL = /^<[\p{L}\p{N}_:.-]+>/u;

function before(stream: StringStream, offset = 1): string {
  return stream.pos - offset >= 0 ? stream.string.charAt(stream.pos - offset) : '';
}

export const typstRails: StreamParser<TypstRailsState> = {
  name: 'typst-rails',
  startState: () => ({ fence: false, raw: false, math: false, strong: false, em: false, heading: false }),
  copyState: (s) => ({ ...s }),
  blankLine(state) {
    // A paragraph ends: unclosed emphasis does not leak into the next one.
    state.strong = state.em = false;
  },
  token(stream, state) {
    if (stream.sol()) state.heading = false;

    // Fenced raw: the fence lines and everything between them.
    if (state.fence) {
      if (stream.sol() && stream.match(/^\s*```/)) state.fence = false;
      stream.skipToEnd();
      return 'monospace';
    }
    if (stream.sol() && stream.match(/^\s*```/)) {
      state.fence = true;
      stream.skipToEnd();
      return 'monospace';
    }

    // Backtick raw spans, possibly across lines.
    if (state.raw) {
      while (!stream.eol()) {
        if (stream.next() === '`') {
          state.raw = false;
          break;
        }
      }
      return 'monospace';
    }

    // Math, possibly across lines. `\$` is a literal dollar.
    if (state.math) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '\\') stream.next();
        else if (ch === '$') {
          state.math = false;
          break;
        }
      }
      return 'string.special';
    }

    if (state.heading) {
      stream.skipToEnd();
      return 'heading';
    }

    if (stream.sol()) {
      if (stream.match(/^=+(?=\s)/)) {
        state.heading = true;
        return 'processingInstruction';
      }
      if (stream.match(/^\s*[-+](?=\s)/)) return 'processingInstruction';
    }

    const ch = stream.peek() ?? '';
    if (ch === '`') {
      stream.next();
      state.raw = true;
      return 'monospace';
    }
    if (ch === '$') {
      stream.next();
      state.math = true;
      return 'string.special';
    }
    if (ch === '/' && stream.match('//') && (stream.pos === 2 || /\s/.test(before(stream, 3)))) {
      stream.skipToEnd();
      return 'comment';
    }
    if (ch === '#' && stream.match(CALL)) return 'meta';
    if (ch === '[' || ch === ']') {
      stream.next();
      return 'processingInstruction';
    }
    if (ch === '@' && !NOT_REF_START.test(before(stream)) && stream.match(REF)) return 'link';
    if (ch === '<' && stream.match(LABEL)) return 'labelName';
    if (ch === '*') {
      stream.next();
      state.strong = !state.strong;
      return 'processingInstruction';
    }
    if (ch === '_') {
      const prev = before(stream);
      const next = stream.string.charAt(stream.pos + 1);
      const opens = !state.em && !WORD.test(prev) && next !== '' && !/\s/.test(next);
      const closes = state.em && !WORD.test(next);
      if (opens || closes) {
        stream.next();
        state.em = !state.em;
        return 'processingInstruction';
      }
    }

    // Plain text up to the next character that could start a token.
    stream.next();
    stream.eatWhile((c) => !'`$/#[]@<*_'.includes(c));
    return state.strong ? 'strong' : state.em ? 'emphasis' : null;
  },
};
