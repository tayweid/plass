// Markdown -> PM doc (.md open path): Pandoc Markdown as Plass reads it
// (docs/MARKDOWN-SOURCE-PLAN.md "The format"; docs/MARKDOWN-FORMAT.md).
//
// Built on markdown-it (the reference CommonMark+GFM tokenizer) plus the
// fenced-div rule (md-divs.ts), with everything Plass-specific around it:
//
//   - a line pre-pass extracts what markdown-it would mangle or misread
//     and leaves a sentinel in its place: `$…$` and `$$…$$` math by
//     pandoc's `tex_math_dollars` rule (inline math may span a soft line
//     break; display math anywhere in a paragraph splits it), code spans
//     (so a `|` inside backticks never splits a pipe-table row), the raw
//     attribute `` `…`{=typst} ``, an attribute block glued to a `)` (an
//     image's `{#fig:x width=60%}`), and the escapes `\@` and `\[` (literal,
//     never a citation); `\ ` becomes a no-break space; a heading's
//     trailing `{#sec:x}` is read off its line. Every sentinel remembers
//     its source text, and every pre-pass line the source line it starts
//     at, so code and islands come back as written. Indented code passes
//     through verbatim, as a fence's lines do.
//   - fenced divs: `::: solution` (the solution block), one `::: {.columns
//     gutter=1em}` per grid row holding `::: {.column width=60%}` cells
//     (later rows carry `.continued`), `::: {.table …}` around a pipe table
//     (md-tables.ts), `::: center` / `::: right` / `::: {.keep}` around one
//     paragraph. Any other div, an HTML block and inline HTML are kept
//     verbatim as islands (shown and printed as code, never run).
//   - every HTML comment is an editorial comment. A comment that is not a
//     top-level block — in a div, a list, a quote, a cell, a footnote,
//     inline in a paragraph — is hoisted to the nearest top-level boundary:
//     before its top-level block when nothing printed precedes it there,
//     after it otherwise (one warning per file with the count). As pandoc
//     reads it, a comment is a block only where a block starts: on a line
//     inside a paragraph it is inline (the paragraph stays whole), and text
//     after a comment block on its closing line opens a paragraph. A
//     `<!--` that no `-->` follows is text (pandoc's reading too).
//   - citations by pandoc's grammar (`[see @a, p. 3; @b]`, bare `@a`); a
//     key prefixed `eq:`, `fig:`, `sec:` or `tbl:` is a reference.
//   - ```` ```{=typst} ```` is the raw-Typst island, ```` ```{=bibtex} ````
//     the embedded bibliography at its position; ```` ```typst ```` and
//     ```` ```bibtex ```` are code listings. `\newpage` is the page break.
//   - YAML frontmatter carries title/author/date; every other line rides
//     along verbatim (doc.attrs.frontmatter) and is written back on save.

import MarkdownIt from 'markdown-it';
import footnotePlugin from 'markdown-it-footnote';
import { Fragment, type Node as PMNode, type Mark } from 'prosemirror-model';
import { schema } from './schema';
import { readMdComment, readMdComments } from './editor-comments-format';
import { DEFAULT_SETTINGS, type DocSettings } from './settings';
import { INPUT_LIMITS, textSizeError } from './input-limits';
import { printedForm, trimSpaceBeforeMarker } from './collapse-spaces';
import { createQuoteState, smartenInline, smartenText } from './smart-quotes';
import { readAttrBlock, type PandocAttrs } from './md-attrs';
import { fencedDivs, type DivMeta } from './md-divs';
import { captionFromLine, delimiterAlign, readPipeTable } from './md-tables';

export interface MdImport {
  doc: PMNode;
  warnings: string[];
}

interface MdToken {
  type: string;
  tag: string;
  content: string;
  info: string;
  markup: string;
  children: MdToken[] | null;
  meta: unknown;
  map: [number, number] | null;
  attrGet(name: string): string | null;
  hidden: boolean;
  level: number;
}

// ---------------------------------------------------------------- pre-pass

/** What a sentinel stands for, with the source text it replaced. */
type Stored =
  | { k: 'math'; src: string; orig: string }
  | { k: 'display'; src: string; label: string; numbered: boolean | null; orig: string }
  | { k: 'code'; code: string; orig: string }
  | { k: 'raw'; fmt: string; src: string; orig: string }
  | { k: 'attrs'; attrs: PandocAttrs; orig: string }
  | { k: 'lit'; ch: string; orig: string }
  // An HTML comment inside paragraph text (pandoc's RawInline): its
  // payload, and whether only whitespace and comments follow it there.
  | { k: 'comment'; text: string; trailing: boolean; orig: string };

// Sentinels are wrapped in a symbol character (U+241F, the control
// picture for the unit separator): markdown-it passes it through verbatim
// (NUL would be rewritten to U+FFFD per CommonMark), and, being a symbol,
// it flanks an emphasis delimiter the way the punctuation it stands for
// does (`$`, a backtick, `{`, `<`, `\`), so `` `make`*(once)* `` is still
// emphasis. A private-use character would read as a letter there.
const S = '\u241F';
/** The sentinel character, for the tests that check none leaks into a
 *  document. */
export const SENTINEL_CHAR = S;
const SENTINEL = /\u241F(\d+)\u241F/g;
/** A sentinel that opens a text. */
const LEADING_SENTINEL = /^\u241F(\d+)\u241F/;
/** What may follow a lone image: its attribute block, then spaces and
 *  no-break spaces. */
const IMAGE_TAIL = /^(?:\u241F(\d+)\u241F)?([ \t\n\u00a0]*)$/;

interface Pre {
  /** The text markdown-it parses. */
  text: string;
  /** The source line each pre-pass line starts at; one more entry, the
   *  source's line count, closes the last range. */
  origLine: number[];
  /** The source, split into lines. */
  lines: string[];
  store: Stored[];
  /** A heading's attribute block, by its pre-pass line. */
  headingAttrs: Map<number, PandocAttrs>;
  /** Pre-pass lines that end a comment block whose source line went on
   *  with text (the text opens the paragraph on the next pre-pass line). */
  splitComments: Set<number>;
}

// markdown-it's HTML block start conditions (rules_block/html_block.mjs):
// types 1–6 may interrupt a paragraph, type 7 (any lone open or close tag)
// may not. The pre-pass follows them so it treats exactly markdown-it's
// HTML blocks as verbatim.
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const ATTR = `(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)`;
const OPEN_CLOSE_TAG = new RegExp(`^(?:<[A-Za-z][A-Za-z0-9\\-]*${ATTR}*\\s*\\/?>|<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>)\\s*$`);
const HTML_STARTS: Array<[RegExp, RegExp | null, boolean]> = [
  [/^<(script|pre|style|textarea)(?=(\s|>|$))/i, /<\/(script|pre|style|textarea)>/i, true],
  [/^<!--/, /-->/, true],
  [/^<\?/, /\?>/, true],
  [/^<![A-Z]/, />/, true],
  [/^<!\[CDATA\[/, /\]\]>/, true],
  [new RegExp(`^</?(${BLOCK_TAGS})(?=(\\s|/?>|$))`, 'i'), null, true],
  [OPEN_CLOSE_TAG, null, false],
];

/** A line's text inside its quote markers and indentation. */
const body = (line: string) => line.replace(/^(?:[ \t]*>)*[ \t]*/, '');

/** Quote markers at the start of a line (`> > `). */
const QUOTE_PREFIX = /^(?:[ \t]{0,3}>[ \t]?)+/;

const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

/** The container markers a line opens with: quote markers, list markers
 *  and indentation, in any order (`> - `, `1. 1. `). */
const CONTAINER_MARKERS = /^(?:[ \t]*>[ \t]?|[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+|[ \t]+)*/;

/** An autolink at the scan position: a URI or an email address in angle
 *  brackets (CommonMark's grammar, which markdown-it follows). */
const AUTOLINK =
  /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;

/** Whether a formula cannot continue onto `line`. pandoc's math parsers
 *  take line breaks themselves (never a blank line), so a formula runs on
 *  through a heading or quote marker inside a paragraph; what ends it is
 *  the next item of the list it is in (pandoc splits a list into items
 *  before reading them) or a fence line. */
function breaksMath(line: string, inList: boolean): boolean {
  const b = body(line);
  return /^(?:`{3,}|~{3,}|:{3,})/.test(b) || (inList && LIST_MARKER.test(b));
}

/** How many quotes a line opens with (`> > ` is two). */
const quoteDepth = (line: string) => (QUOTE_PREFIX.exec(line)?.[0].match(/>/g) ?? []).length;

/** A line with its first `depth` quote markers removed: the markers of the
 *  quotes a paragraph is in. A `>` past them is the line's own text
 *  (pandoc reads no quote inside a paragraph). */
function stripQuotes(line: string, depth: number): string {
  let l = line;
  for (let d = 0; d < depth; d++) {
    const m = /^[ \t]{0,3}>[ \t]?/.exec(l);
    if (!m) break;
    l = l.slice(m[0].length);
  }
  return l;
}

/** Indentation of a line's content inside its container: quote markers
 *  first, then a list marker or plain indentation. */
function contentIndent(line: string): number {
  const quote = QUOTE_PREFIX.exec(line)?.[0] ?? '';
  const rest = line.slice(quote.length);
  return /^[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?/.exec(rest)![0].length;
}

/** A formula's (or a comment's) source lines after the first, back in the
 *  container's own coordinates: the `depth` quote markers of the quotes
 *  around the paragraph and the container's indentation removed. */
function dedentMath(src: string, opener: string, depth: number): string {
  const indent = contentIndent(opener);
  return src
    .split('\n')
    .map((line, i) => {
      if (i === 0) return line;
      let l = stripQuotes(line, depth);
      const lead = /^[ \t]*/.exec(l)![0].length;
      l = l.slice(Math.min(lead, indent));
      return l;
    })
    .join('\n');
}

/** The attribute block that ends a heading's text, by pandoc's rule: an
 *  unescaped `{` whose block runs to the end of the line, not glued to a
 *  code span, link or image (`` `c`{.l} `` is the code's). */
function trailingAttrs(text: string): { attrs: PandocAttrs; start: number } | null {
  const end = text.replace(/[ \t]+$/, '');
  if (!end.endsWith('}')) return null;
  let tries = 0;
  for (let i = end.lastIndexOf('{'); i >= 0 && tries < 16; i = end.lastIndexOf('{', i - 1), tries++) {
    let slashes = 0;
    while (end[i - 1 - slashes] === '\\') slashes++;
    if (slashes % 2) continue;
    if (/[)\]`]/.test(end[i - 1] ?? '')) continue;
    const block = readAttrBlock(end, i);
    if (block && block.end === end.length) return { attrs: block.attrs, start: i };
    if (i === 0) break;
  }
  return null;
}

function prepass(src: string, warn: (m: string) => void): Pre {
  const lines = src.split('\n');
  const store: Stored[] = [];
  const keep = (s: Stored) => `${S}${store.push(s) - 1}${S}`;
  /** A stored value with the sentinels a source line already held (a
   *  literal sentinel character) back to their text: a formula's, a code
   *  span's or a comment's text holds what the file says. */
  const unlit = (text: string) => (text.includes(S) ? text.replace(SENTINEL, (all, n: string) => store[+n]?.orig ?? all) : text);
  const literal = (s: Stored): Stored => {
    if (!s.orig.includes(S)) return s;
    const out = { ...s, orig: unlit(s.orig) } as Record<string, unknown>;
    for (const key of ['src', 'code', 'text'] as const) if (typeof out[key] === 'string') out[key] = unlit(out[key] as string);
    return out as Stored;
  };
  // A sentinel character already in the file is literal text: it becomes
  // a sentinel of its own, so nothing the file holds can read as one.
  const work = (src.includes(S) ? src.replace(new RegExp(S, 'g'), () => keep({ k: 'lit', ch: S, orig: S })) : src).split('\n');
  const out: string[] = [];
  const origLine: number[] = [];
  const headingAttrs = new Map<number, PandocAttrs>();
  const push = (text: string, from: number) => {
    out.push(text);
    origLine.push(from);
  };

  /** Scan paragraph-ish text (lines joined by `\n`): the sentinels, the
   *  escapes, the fill-in blanks. Returns the scanned lines, each with the
   *  source line it starts at. */
  const scan = (text: string, lineNos: number[], listed = false): Array<{ text: string; line: number }> => {
    const starts = [0];
    for (let k = 0; k < text.length; k++) if (text[k] === '\n') starts.push(k + 1);
    /** The buffer line holding `offset` (binary search: a long table is
     *  one buffer of many lines). */
    const lineIndexAt = (offset: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const lineAt = (offset: number) => text.slice(starts[lineIndexAt(offset)], text.indexOf('\n', offset) < 0 ? undefined : text.indexOf('\n', offset));
    /** The quotes the text is in: its first line has all their markers (a
     *  later line may lack them, lazily, or hold more, as text). */
    const depth = quoteDepth(lineAt(0));
    const result: Array<{ text: string; line: number }> = [];
    let cur = '';
    let prose = '';
    let curLine = lineNos[0];
    const flushProse = () => {
      // A run of three or more underscores (a blank to fill in, escaped or
      // not) is text, not emphasis delimiters: every one is escaped so
      // markdown-it keeps it. (`___bold italic___` is the one idiom this
      // gives up; `***` says the same thing.)
      cur += prose.replace(/(?:\\?_){3,}/g, (run) => run.replace(/\\?_/g, '\\_'));
      prose = '';
    };
    const newline = (at: number) => {
      flushProse();
      result.push({ text: cur, line: curLine });
      cur = '';
      curLine = lineNos[lineIndexAt(at + 1)];
    };
    const sentinel = (s: Stored) => {
      flushProse();
      cur += keep(literal(s));
    };

    // A list's lines (an item's, or a later paragraph's in a loose item): a
    // formula or code span there may not run into the next item.
    const inList = listed || LIST_MARKER.test(body(text.slice(0, starts[1] === undefined ? undefined : starts[1] - 1)));
    /** Whether a newline inside a formula at `at` continues it: not out of
     *  a pipe-table row (a row is one line), not into the next list item
     *  or a fence. */
    const softBreak = (at: number, opener: string) =>
      !/^\|/.test(body(opener)) &&
      !breaksMath(text.slice(at + 1, text.indexOf('\n', at + 1) < 0 ? undefined : text.indexOf('\n', at + 1)), inList || LIST_MARKER.test(body(opener)));

    /** Whether the `$` at `k` starts a line after the opener's, in its
     *  container's coordinates: quote markers off, and in a list the item's
     *  indentation when the line has all of it (pandoc reads an item's
     *  text that way; a paragraph's own continuation lines keep theirs). */
    const startsLine = (k: number, i: number, opener: string): boolean => {
      const from = text.lastIndexOf('\n', k - 1) + 1;
      if (from <= i) return false;
      const itemIndent = inList || LIST_MARKER.test(body(opener)) ? contentIndent(opener) : 0;
      let lead = stripQuotes(text.slice(from, k), depth);
      if (/^[ \t]*/.exec(lead)![0].length >= itemIndent) lead = lead.slice(itemIndent);
      return lead === '';
    };

    /** Inline math opening at `i` (pandoc's `mathInlineWith "$" "$"`): a
     *  non-space after the `$`; `\` escapes the next character and `\text`
     *  takes a balanced brace group (which may hold a `$`); a space or tab
     *  may not come right before the closing `$`, which no digit may follow.
     *  A line break may: pandoc's formula takes it like any other
     *  character, so a `$` that starts the next line closes the formula. */
    const inlineMath = (i: number): number => {
      const first = text[i + 1];
      if (first === undefined || /\s/.test(first)) return -1;
      const opener = lineAt(i);
      let j = i + 1;
      while (j < text.length) {
        const ch = text[j];
        if (ch === '\\') {
          if (text.startsWith('\\text{', j)) {
            let depth = 0;
            let k = j + 5;
            for (; k < text.length; k++) {
              if (text[k] === '\\') k++;
              else if (text[k] === '{') depth++;
              else if (text[k] === '}' && --depth === 0) break;
            }
            if (k < text.length) {
              j = k + 1;
              continue;
            }
          }
          j += 2;
          continue;
        }
        if (ch === '$') return /\d/.test(text[j + 1] ?? '') ? -1 : j + 1;
        if (/\s/.test(ch)) {
          let k = j;
          while (k < text.length && /\s/.test(text[k])) {
            if (text[k] === '\n' && !softBreak(k, opener)) return -1;
            k++;
          }
          if (text[k] === '$' && !startsLine(k, i, opener)) return -1;
          j = k;
          continue;
        }
        j++;
      }
      return -1;
    };

    /** Whether only white space and comments follow `at`. The stretch of
     *  them a look found is remembered: a later comment that ends inside
     *  it has the same answer, so a paragraph of many comments is read in
     *  one pass. */
    let seen = { from: -1, to: -1, only: false };
    const onlyCommentsAfter = (at: number): boolean => {
      if (at >= seen.from && at <= seen.to) return seen.only;
      let k = at;
      for (;;) {
        while (k < text.length && /\s/.test(text[k])) k++;
        const close = text.startsWith('<!--', k) ? text.indexOf('-->', k + 4) : -1;
        if (close < 0) break;
        k = close + 3;
      }
      seen = { from: at, to: k, only: k >= text.length };
      return seen.only;
    };

    /** Display math opening at `i`: everything up to the next `$$`. */
    const displayMath = (i: number): number => {
      const close = text.indexOf('$$', i + 2);
      if (close <= i + 2) return -1;
      const opener = lineAt(i);
      for (let k = i + 2; k < close; k++) if (text[k] === '\n' && !softBreak(k, opener)) return -1;
      return close + 2;
    };

    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '\n') {
        newline(i);
        i++;
        continue;
      }
      if (c === '\\') {
        const n = text[i + 1];
        if (n === ' ') {
          // pandoc's escaped space: a no-break space.
          prose += '\u00a0';
          i += 2;
        } else if (n === '@' || n === '[') {
          // Literal: never a citation or a citation group.
          sentinel({ k: 'lit', ch: n, orig: '\\' + n });
          i += 2;
        } else if (n === undefined || n === '\n') {
          prose += c;
          i++;
        } else {
          prose += c + n;
          i += 2;
        }
        continue;
      }
      if (c === '`') {
        let run = 1;
        while (text[i + run] === '`') run++;
        // A code span ends where its block does, as a formula does: never
        // in the next list item, past a fence or out of a table row.
        const opener = lineAt(i);
        let close = -1;
        for (let k = i + run; k < text.length; ) {
          if (text[k] === '\n' && !softBreak(k, opener)) break;
          if (text[k] !== '`') {
            k++;
            continue;
          }
          let n = 1;
          while (text[k + n] === '`') n++;
          if (n === run) {
            close = k;
            break;
          }
          k += n;
        }
        if (close < 0) {
          prose += text.slice(i, i + run);
          i += run;
          continue;
        }
        let code = text.slice(i + run, close);
        // A quote's markers on the span's later lines are the quote's, not
        // the code's (pandoc keeps a list's indentation there, though).
        if (code.includes('\n') && depth) code = code.replace(/\n([^\n]*)/g, (_, line: string) => '\n' + stripQuotes(line, depth));
        code = code.replace(/\n/g, ' ');
        if (/^ [\s\S]* $/.test(code) && code.trim()) code = code.slice(1, -1);
        let end = close + run;
        const raw = /^\{=([A-Za-z0-9_+-]+)\}/.exec(text.slice(end));
        if (raw) {
          end += raw[0].length;
          sentinel({ k: 'raw', fmt: raw[1].toLowerCase(), src: code, orig: text.slice(i, end) });
        } else {
          const attrs = text[end] === '{' ? readAttrBlock(text, end) : null;
          if (attrs) {
            warn('attributes on inline code have no Plass form — dropped');
            end = attrs.end;
          }
          sentinel({ k: 'code', code, orig: text.slice(i, end) });
        }
        i = end;
        continue;
      }
      if (c === '<') {
        // An autolink is verbatim (CommonMark's grammar, markdown-it's): a
        // `$`, a backtick or underscores in it are the URL's.
        AUTOLINK.lastIndex = i;
        const auto = AUTOLINK.exec(text);
        if (auto) {
          flushProse();
          cur += auto[0];
          i += auto[0].length;
          continue;
        }
      }
      if (c === '<' && text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end >= 0) {
          // Inside paragraph text a comment is inline, as pandoc reads it
          // (markdown-it would end the paragraph at one that starts a
          // line): a sentinel, hoisted out of the paragraph by the reader.
          const orig = text.slice(i, end + 3);
          sentinel({
            k: 'comment',
            text: readMdComment(dedentMath(orig, lineAt(i), depth)) ?? '',
            trailing: onlyCommentsAfter(end + 3),
            orig,
          });
          i = end + 3;
          continue;
        }
      }
      if (c === '$') {
        if (text[i + 1] === '$') {
          const end = displayMath(i);
          if (end > 0) {
            const opener = lineAt(i);
            const src = dedentMath(text.slice(i + 2, end - 2), opener, depth).trim();
            // The attribute block pandoc leaves as text after the formula:
            // after spaces, or on the next line.
            let j = end;
            while (text[j] === ' ' || text[j] === '\t') j++;
            if (text[j] === '\n') {
              const next = text.slice(j + 1);
              const lead = next.length - body(next).length;
              if (text[j + 1 + lead] === '{') j = j + 1 + lead;
            }
            const block = text[j] === '{' ? readAttrBlock(text, j) : null;
            const stop = block ? block.end : end;
            const classes = block?.attrs.classes ?? [];
            sentinel({
              k: 'display',
              src,
              label: block?.attrs.id ?? '',
              numbered: classes.includes('unnumbered') ? false : classes.includes('numbered') ? true : null,
              orig: text.slice(i, stop),
            });
            i = stop;
            continue;
          }
          prose += '$$';
          i += 2;
          continue;
        }
        const end = inlineMath(i);
        if (end > 0) {
          // A formula closed at the start of a line ends in that line
          // break, which pandoc trims.
          sentinel({ k: 'math', src: dedentMath(text.slice(i + 1, end - 1), lineAt(i), depth).replace(/\s+$/, ''), orig: text.slice(i, end) });
          i = end;
          continue;
        }
      }
      if (c === '{' && text[i - 1] === ')') {
        const block = readAttrBlock(text, i);
        if (block) {
          sentinel({ k: 'attrs', attrs: block.attrs, orig: text.slice(i, block.end) });
          i = block.end;
          continue;
        }
      }
      prose += c;
      i++;
    }
    flushProse();
    result.push({ text: cur, line: curLine });
    return result;
  };

  let para: Array<{ text: string; line: number }> = [];
  /** Whether the lines read are inside a list: from a list marker until a
   *  line at the left margin follows a blank line. */
  let listed = false;
  let paraListed = false;
  /** Lines that open with a `<!--` no `-->` follows: text (below). */
  const literalComment = new Set<number>();
  const flush = () => {
    if (!para.length) return;
    const given = new Map(para.map((p) => [p.line, p.text]));
    for (const l of scan(para.map((p) => p.text).join('\n'), para.map((p) => p.line), paraListed)) {
      // The `<` is set aside as a literal, so markdown-it reads no HTML
      // block there (when no formula or code span took the line's start).
      const at = literalComment.has(l.line) ? /^(?:[ \t]*>)*[ \t]*(?=<!--)/.exec(l.text)?.[0].length : undefined;
      let text = at === undefined ? l.text : l.text.slice(0, at) + keep({ k: 'lit', ch: '<', orig: '<' }) + l.text.slice(at + 1);
      // A line whose content (past its quote and list markers) opens with
      // three or more backticks and holds another backtick later is text,
      // not a fence (CommonMark's rule and pandoc's). The scan may have
      // made that later backtick a code span's sentinel, and markdown-it
      // would then read a fence there that runs to the end of the file: the
      // run is set aside as a literal, so the line stays text.
      const lead = CONTAINER_MARKERS.exec(text)![0].length;
      const run = /^`{3,}/.exec(text.slice(lead))?.[0];
      const source = given.get(l.line) ?? '';
      if (run && source.startsWith(run, lead) && source.slice(lead + run.length).includes('`')) {
        text = text.slice(0, lead) + keep({ k: 'lit', ch: run, orig: run }) + text.slice(lead + run.length);
      }
      push(text, l.line);
    }
    para = [];
  };

  const splitComments = new Set<number>();
  /** Whether a `-->` follows the `<!--` on line `i`. */
  const lastClose = src.lastIndexOf('-->');
  const lineStart: number[] = [];
  for (let k = 0, at = 0; k < lines.length; at += lines[k].length + 1, k++) lineStart.push(at);
  const closedLater = (i: number) => lastClose >= lineStart[i] + lines[i].indexOf('<!--') + 4;
  /** The comment run that opens line `i`'s body: the line its last comment
   *  closes on, the column after that, and whether text follows there.
   *  Null when a comment runs into a blank line or another comment opens
   *  after it and does not close on that line (then markdown-it's HTML
   *  block reads it, as before). */
  const commentRun = (i: number): { line: number; restAt: number; rest: boolean } | null => {
    let l = i;
    let at = work[i].length - body(work[i]).length + 4;
    for (;;) {
      const close = work[l].indexOf('-->', at);
      if (close >= 0) {
        at = close + 3;
        break;
      }
      l++;
      if (l >= work.length || !body(work[l]).trim()) return null;
      at = 0;
    }
    for (;;) {
      const lead = /^[ \t]*/.exec(work[l].slice(at))![0].length;
      if (!work[l].startsWith('<!--', at + lead)) break;
      const close = work[l].indexOf('-->', at + lead + 4);
      if (close < 0) return null;
      at = close + 3;
    }
    return { line: l, restAt: at, rest: !!work[l].slice(at).trim() };
  };
  /** Whether the open paragraph lines are a pipe table (a delimiter row
   *  among them) or indented code, which a comment line ends for pandoc
   *  as for markdown-it. */
  const tableOrCode = () =>
    para.some((p) => {
      const pb = body(p.text);
      return pb.includes('|') && /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(pb);
    }) ||
    (!paraListed && /^(?: {4}|\t)/.test(para[0].text.replace(QUOTE_PREFIX, '')));

  let fence: { ch: string; len: number } | null = null;
  let html: RegExp | 'blank' | null = null;
  let inPara = false;
  let afterBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const line = work[i];
    const b = body(line);
    if (fence) {
      push(line, i);
      const close = /^(`{3,}|~{3,})[ \t]*$/.exec(b);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    if (html) {
      push(line, i);
      if (html === 'blank' ? !b.trim() : html.test(b)) {
        html = null;
        inPara = false;
      }
      continue;
    }
    if (!b.trim()) {
      flush();
      push(line, i);
      inPara = false;
      afterBlank = true;
      continue;
    }
    if (!inPara && !listed && /^(?: {4}|\t)/.test(line.replace(QUOTE_PREFIX, ''))) {
      // Indented code (four spaces or a tab past the quote markers, where
      // no paragraph or list item goes on) is verbatim: no formula, code
      // span or escape is read in it, and a fence or `:::` there is code.
      push(line, i);
      afterBlank = false;
      continue;
    }
    // A footnote's text, like a list item's, goes on in indented lines.
    if (LIST_MARKER.test(b) || /^\[\^[^\]\s]+\]:/.test(b)) listed = true;
    else if (afterBlank && !/^[ \t]/.test(line.replace(QUOTE_PREFIX, ''))) listed = false;
    afterBlank = false;
    const open = /^(`{3,}|~{3,})/.exec(b);
    if (open && !(open[1][0] === '`' && b.slice(open[1].length).includes('`'))) {
      flush();
      push(line, i);
      fence = { ch: open[1][0], len: open[1].length };
      inPara = false;
      continue;
    }
    if (b.startsWith('<!--') && !closedLater(i)) {
      // A `<!--` that no `-->` follows is text to pandoc, where markdown-it
      // would open an HTML block running to the end of its container (and
      // past a div's closer). Its `<` is set aside as a literal, so
      // markdown-it reads the line as text too.
      if (!para.length) paraListed = listed;
      para.push({ text: line, line: i });
      literalComment.add(i);
      inPara = true;
      continue;
    }
    if (b.startsWith('<!--')) {
      const run = commentRun(i);
      if (run && inPara && !tableOrCode()) {
        // pandoc reads a comment inside a paragraph (a list item's, a
        // quote's) as inline, where markdown-it would end the paragraph at
        // it: its lines join the paragraph, and the scan sets it aside.
        for (let l = i; l <= run.line; l++) para.push({ text: work[l], line: l });
        i = run.line;
        continue;
      }
      if (run && !inPara && run.rest) {
        // A comment that opens a block and closes on a line that goes on
        // with text: pandoc reads the comment as a block and the text as
        // the start of a paragraph, which the next lines continue.
        // markdown-it would keep the text in the HTML block, so the text
        // moves to a line of its own.
        flush();
        for (let l = i; l < run.line; l++) push(work[l], l);
        push(work[run.line].slice(0, run.restAt).replace(/[ \t]+$/, ''), run.line);
        splitComments.add(out.length - 1);
        paraListed = listed;
        para.push({ text: line.slice(0, line.length - b.length) + work[run.line].slice(run.restAt).replace(/^[ \t]+/, ''), line: run.line });
        inPara = true;
        i = run.line;
        continue;
      }
    }
    const start = HTML_STARTS.find(([re, , interrupts]) => re.test(b) && (interrupts || !inPara));
    if (start) {
      flush();
      push(line, i);
      const [, end] = start;
      if (end === null) html = 'blank';
      else if (!end.test(b)) html = end;
      inPara = false;
      continue;
    }
    if (/^:{3,}/.test(b)) {
      flush();
      push(line, i);
      // An attribute block that continues over the following lines.
      const brace = b.indexOf('{');
      if (brace >= 0 && !b.includes('}', brace)) {
        for (let k = i + 1; k < lines.length && k <= i + 32 && body(work[k]).trim(); k++) {
          push(work[k], k);
          i = k;
          if (work[k].includes('}')) break;
        }
      }
      inPara = false;
      continue;
    }
    const heading = /^((?:[ \t]*>)*[ \t]*#{1,6})(?:([ \t]+)(.*))?$/.exec(line);
    if (heading && /^#{1,6}(?:[ \t]|$)/.test(b)) {
      flush();
      let text = heading[3] ?? '';
      // A closing sequence of hashes ends the heading; pandoc then reads
      // no attribute block before it.
      if (!/(?:^|[ \t])#+[ \t]*$/.test(text)) {
        const attrs = trailingAttrs(text);
        if (attrs) {
          headingAttrs.set(out.length, attrs.attrs);
          text = text.slice(0, attrs.start).replace(/[ \t]+$/, '');
        }
      }
      const scanned = scan(text, [i])[0].text;
      push(heading[1] + (heading[2] ?? (scanned ? ' ' : '')) + scanned, i);
      inPara = false;
      continue;
    }
    if (!para.length && /^\\(?:newpage|pagebreak)[ \t]*$/.test(line)) {
      // pandoc reads the command alone on its line as a raw TeX block,
      // with or without a blank line after it.
      push(line, i);
      if (work[i + 1]?.trim()) push('', i + 1);
      inPara = false;
      continue;
    }
    if (!para.length) paraListed = listed;
    para.push({ text: line, line: i });
    inPara = true;
  }
  flush();
  origLine.push(lines.length);
  return { text: out.join('\n'), origLine, lines, store, headingAttrs, splitComments };
}

// ------------------------------------------------------------- the reader

const NAMESPACE = /^(?:eq|fig|sec|tbl):/;
// pandoc's citation key: a letter, digit or `_`, then those and internal
// punctuation followed by one of them (`@eq:a.` is `eq:a`).
const KEY = String.raw`[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&\-+?<>~/](?=[\p{L}\p{N}_]))*`;
const BARE_CITE = new RegExp(String.raw`(?<![\p{L}\p{N}_])(-?)@(${KEY})`, 'gu');
const KEY_AT = new RegExp(String.raw`^(-?)@(${KEY})`, 'u');
const RAILS = ['table', 'columns', 'solution', 'center', 'right', 'keep'];
const CITE_EXTRAS = 'citation prefix/suffix kept as text; Plass cites the key only';
const ALIGN_RAILS = ['center', 'right', 'keep'];

/** A display formula in a paragraph's inline run, before the split. */
class DisplayItem {
  constructor(readonly display: Extract<Stored, { k: 'display' }>) {}
}
/** Where a comment left the inline run (the gap it closes). */
const CUT = Symbol('cut');
type Item = PMNode | DisplayItem | typeof CUT;
const isNode = (x: Item): x is PMNode => x !== CUT && !(x instanceof DisplayItem);

/** Where a hoisted comment sat in the source, so an island made of that
 *  source leaves it out. */
type Cut = { lines: [number, number] } | { inline: string; lines: [number, number] };

export function mdToDoc(src: string): MdImport {
  const warnings: string[] = [];
  src = src.replace(/\r\n?/g, '\n');

  // ---------- frontmatter ----------
  const settings: DocSettings = { ...DEFAULT_SETTINGS };
  let title: string | null = null;
  let authors: string | null = null;
  let date: string | null = null;
  let frontmatter = '';
  let skipped = 0;
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---\n', 4);
    if (end > 0) {
      // A known key with a scalar value on its own line becomes the title/
      // author/date block. Every other line — unknown keys, a YAML list
      // under `author:`, a block scalar (`abstract: |`), comments — is kept
      // in order, verbatim, and written back on save.
      const extra: string[] = [];
      for (const line of src.slice(4, end).split('\n')) {
        const m = /^(title|authors?|date):\s*(\S.*)$/i.exec(line);
        const value = m ? m[2].trim() : '';
        if (!m || /^[|>][-+]?\d*$/.test(value)) {
          extra.push(line);
          continue;
        }
        const key = m[1].toLowerCase();
        const text = value.replace(/^["']|["']$/g, '');
        if (key === 'title') title = text;
        else if (key === 'date') date = text;
        else authors = text;
      }
      frontmatter = extra.join('\n').replace(/^\n+|\n+$/g, '');
      skipped = src.slice(0, end + 5).split('\n').length - 1;
      src = src.slice(end + 5);
    }
  }

  // Warnings raised while reading content that ends up an island are not
  // the user's concern: the island keeps that content verbatim.
  let quiet = 0;
  const warn = (m: string) => {
    if (!quiet && !warnings.includes(m)) warnings.push(m);
  };

  const pre = prepass(src, warn);
  const { store, origLine, lines } = pre;
  const lineNo = (preLine: number) => (origLine[preLine] ?? lines.length) + 1 + skipped;

  /** Every sentinel in `text` back to the source it replaced. */
  const restore = (text: string) => text.replace(SENTINEL, (all, n: string) => store[+n]?.orig ?? all);
  /** The same in a link's destination or title, where markdown-it has
   *  resolved the escapes: an escape is its character. */
  const restoreLink = (text: string) =>
    text.replace(SENTINEL, (all, n: string) => {
      const s = store[+n];
      return !s ? all : s.k === 'lit' ? s.ch : s.orig;
    });

  /** An image's alt text as plain text (markdown-it's own rendering of
   *  it): escapes resolved, a formula or code span as its source. */
  const altText = (children: MdToken[]): string =>
    children
      .map((c) =>
        c.type === 'text' || c.type === 'code_inline'
          ? c.content.replace(SENTINEL, (all, n: string) => {
              const s = store[+n];
              return !s ? all : s.k === 'lit' ? s.ch : s.k === 'code' ? s.code : s.k === 'comment' ? '' : s.orig;
            })
          : c.type === 'softbreak' || c.type === 'hardbreak'
            ? ' '
            : c.type === 'image'
              ? altText(c.children ?? [])
              : '',
      )
      .join('');

  // ---------- tokenize ----------
  const md = new MarkdownIt({ html: true }).use(footnotePlugin).use(fencedDivs);
  // markdown-it drops every `data:` URL but a few raster types. An SVG
  // data URL is how a single-file document carries a figure, so an image's
  // destination may be one; a link's may not (an SVG opened from a link
  // can run script), nor a reference definition's. markdown-it validates
  // all of them through one hook, so the rule ahead of `link` notes
  // whether the inline at hand opens an image, and a label scan (which
  // runs the rules over the label, an image inside it included) leaves
  // the answer as it found it for the link or image around it.
  let imageDest = false;
  md.inline.ruler.before('link', 'plass_image_dest', (state) => {
    imageDest = state.src.charCodeAt(state.pos) === 0x21 && state.src.charCodeAt(state.pos + 1) === 0x5b;
    return false;
  });
  const parseLinkLabel = md.helpers.parseLinkLabel;
  md.helpers.parseLinkLabel = (state, start, disableNested) => {
    const image = imageDest;
    try {
      return parseLinkLabel(state, start, disableNested);
    } finally {
      imageDest = image;
    }
  };
  md.validateLink = (url: string) => {
    const s = url.trim().toLowerCase();
    if (!/^(vbscript|javascript|file|data):/.test(s)) return true;
    return /^data:image\/(gif|png|jpeg|webp);/.test(s) || (imageDest && /^data:image\/svg\+xml;/.test(s));
  };
  // A destination may hold sentinels (`$`, a backtick, `\@` in a URL):
  // they go back to their text before markdown-it percent-encodes it.
  const normalizeLink = md.normalizeLink.bind(md);
  md.normalizeLink = (url: string) => {
    const text = restoreLink(url);
    return /^data:/i.test(text) ? text : normalizeLink(text);
  };
  // Where definitions stand: markdown-it moves a footnote's to the end of
  // the stream and drops a link reference's, so one that only kept-as-
  // source content uses would vanish from the file on save (below).
  const noteDefs = new Map<string, [number, number]>();
  const linkDefs: Array<{ label: string; map: [number, number] }> = [];
  md.core.ruler.before('footnote_tail', 'plass_note_defs', (state) => {
    let label: string | null = null;
    let range: [number, number] = [Infinity, -1];
    for (const t of state.tokens as unknown as MdToken[]) {
      if (t.type === 'footnote_reference_open') {
        label = (t.meta as { label: string }).label;
        range = [Infinity, -1];
      } else if (t.type === 'footnote_reference_close') {
        if (label !== null && range[1] >= 0) noteDefs.set(label, range);
        label = null;
      } else if (label !== null && t.map) range = [Math.min(range[0], t.map[0]), Math.max(range[1], t.map[1])];
    }
  });
  md.core.ruler.before('strip_references', 'plass_link_defs', (state) => {
    for (const t of state.tokens as unknown as MdToken[]) if (t.type === 'reference_definition' && t.map) linkDefs.push({ label: (t.meta as { label: string }).label, map: t.map });
  });
  const tokens = md.parse(pre.text, {}) as unknown as MdToken[];

  const { paragraph, heading, blockquote, code_block, horizontal_rule } = schema.nodes;

  // ---------- comment hoisting ----------
  interface Hoist {
    seen: boolean;
    before: PMNode[];
    after: PMNode[];
  }
  let H: Hoist = { seen: false, before: [], after: [] };
  /** Inside a footnote or a figure caption: a comment follows the marker
   *  or the image, so it goes after. */
  let forceAfter = 0;
  let hoisted = 0;
  const cuts: Cut[] = [];
  /** The source lines of the inline run being read (for an inline cut). */
  let inlineLines: [number, number] = [0, 0];
  const comment = (text: string) => schema.nodes.editor_comment.create(null, text ? [schema.text(text)] : []);
  /** `stays`: a comment on the last lines of a top-level paragraph. It
   *  goes after the paragraph like any other, but that is where it already
   *  stands, so it is not counted as moved. */
  const hoist = (text: string, cut: Cut, stays = false) => {
    (H.seen || forceAfter ? H.after : H.before).push(comment(text));
    if (!stays) hoisted++;
    cuts.push(cut);
  };
  /** Whether the paragraph being read is a top-level one (its trailing
   *  comments stay where they are). */
  let topParagraph = false;
  /** Footnote labels whose marker is printed content's (not an island's). */
  const printedNotes: string[] = [];
  /** The islands made, with the source lines each keeps. */
  const islands: Array<{ node: PMNode; range: [number, number] }> = [];
  const keepIsland = (node: PMNode, map: [number, number] | null): PMNode => {
    if (!quiet) islands.push({ node, range: mapLines(map) });
    return node;
  };
  /** Islands whose source runs open to the end of its container (an
   *  unclosed div, an HTML block whose end never came): a closer written
   *  after one would be taken into it. */
  const openEnded = new WeakSet<PMNode>();
  const endsOpen = (nodes: PMNode[]) => nodes.length > 0 && openEnded.has(nodes[nodes.length - 1]);
  /** The cut a comment block leaves: its lines, or, when the pre-pass split
   *  text off its closing line, the comment itself on those lines. */
  const blockCut = (t: MdToken): Cut =>
    t.map && pre.splitComments.has(t.map[1] - 1)
      ? { inline: restore(t.content).replace(/\n$/, ''), lines: [origLine[t.map[0]], origLine[t.map[1] - 1] + 1] }
      : { lines: mapLines(t.map) };
  /** The comments a token holds: an inline comment, or the comment
   *  sentinels in a text token. */
  const tokenComments = (k: MdToken): Array<{ text: string; orig: string; trailing: boolean }> => {
    if (k.type === 'html_inline') {
      const note = readMdComment(k.content);
      return note === null ? [] : [{ text: note, orig: k.content, trailing: false }];
    }
    if (k.type !== 'text') return [];
    const found: Array<{ text: string; orig: string; trailing: boolean }> = [];
    for (const m of k.content.matchAll(SENTINEL)) {
      const s = store[+m[1]];
      if (s?.k === 'comment') found.push(s);
    }
    return found;
  };
  /** Text with its comment sentinels taken out. */
  const uncommented = (text: string) => text.replace(SENTINEL, (all, n: string) => (store[+n]?.k === 'comment' ? '' : all));
  const mapLines = (map: [number, number] | null): [number, number] => (map ? [origLine[map[0]], origLine[map[1]] ?? lines.length] : [0, 0]);

  // ---------- footnotes (definitions arrive at the stream tail) ----------
  const footnoteDefs = new Map<number, MdToken[]>();
  {
    let current = -1;
    let buf: MdToken[] = [];
    for (const t of tokens) {
      if (t.type === 'footnote_open') {
        current = (t.meta as { id?: number } | null)?.id ?? -1;
        buf = [];
      } else if (t.type === 'footnote_close') {
        footnoteDefs.set(current, buf);
        current = -1;
      } else if (current >= 0) buf.push(t);
    }
  }
  const footnoteBodies = new Map<number, PMNode[]>();
  const footnoteBody = (id: number): PMNode[] => {
    const known = footnoteBodies.get(id);
    if (known) return known;
    const parts: PMNode[][] = [];
    forceAfter++;
    const top = topParagraph;
    topParagraph = false;
    const lineRange = inlineLines;
    for (const t of footnoteDefs.get(id) ?? []) {
      if (t.type === 'inline') {
        inlineLines = mapLines(t.map);
        parts.push(finishInline(inlineItems(t.children ?? [], false)));
      } else if (t.type === 'html_block') {
        const read = readMdComments(t.content);
        if (read) {
          for (const c of read.comments) hoist(c, blockCut(t));
          if (read.rest) parts.push(finishInline(inlineItems(inlineTokens(read.rest), false)));
        }
      }
    }
    inlineLines = lineRange;
    topParagraph = top;
    forceAfter--;
    if (parts.length > 1) warn('multi-paragraph footnote flattened');
    const nodes = parts.flatMap((b, k) => (k > 0 ? [schema.text(' '), ...b] : b));
    footnoteBodies.set(id, nodes);
    return nodes;
  };

  /** Inline tokens for text the block parser left raw (after a comment). */
  const inlineTokens = (text: string): MdToken[] => {
    const scanned = prepass(restore(text), warn);
    const offset = store.length;
    store.push(...scanned.store);
    const shifted = scanned.text.replace(SENTINEL, (_, n: string) => `${S}${+n + offset}${S}`);
    const inline = md.parseInline(shifted, {}) as unknown as MdToken[];
    return inline[0]?.children ?? [];
  };

  let bib: { name: string; content: string } | null = null;

  // ---------- inline ----------

  /** A citation group `[…]` at `p` by pandoc's grammar, or null. */
  function citeGroup(text: string, p: number): { end: number; items: Array<{ prefix: string; suppress: boolean; key: string; suffix: string }> } | null {
    const items: Array<{ prefix: string; suppress: boolean; key: string; suffix: string }> = [];
    let pos = p + 1;
    for (;;) {
      let k = pos;
      let found: RegExpExecArray | null = null;
      for (; k < text.length; k++) {
        const ch = text[k];
        if (ch === ';' || ch === ']' || ch === '[') return null;
        if ((ch === '@' || ch === '-') && !/[\p{L}\p{N}_]/u.test(text[k - 1] ?? '')) {
          found = KEY_AT.exec(text.slice(k));
          if (found) break;
        }
      }
      if (!found) return null;
      const prefix = text.slice(pos, k).trim();
      let e = k + found[0].length;
      let s = e;
      while (s < text.length && text[s] !== ';' && text[s] !== ']') {
        if (text[s] === '[') return null;
        s++;
      }
      if (s >= text.length) return null;
      const raw = text.slice(e, s);
      const rest = raw.trim();
      items.push({ prefix, suppress: found[1] === '-', key: found[2], suffix: /^\s/.test(raw) && rest ? ' ' + rest : rest });
      e = s + 1;
      if (text[s] === ']') return { end: e, items };
      pos = e;
    }
  }

  /** Text with its sentinels expanded into atoms. */
  function expand(text: string, marks: readonly Mark[], displays: boolean, out: Item[]): void {
    let last = 0;
    for (const m of text.matchAll(SENTINEL)) {
      if (m.index! > last) pushText(text.slice(last, m.index), marks, out);
      last = m.index! + m[0].length;
      const s = store[+m[1]];
      if (!s) {
        pushText(m[0], marks, out);
        continue;
      }
      switch (s.k) {
        case 'math':
          out.push(schema.nodes.math_inline.create({ src: s.src }, null, atomMarks(marks)));
          H.seen = true;
          break;
        case 'display':
          if (displays) out.push(new DisplayItem(s));
          else out.push(schema.nodes.math_inline.create({ src: s.src }, null, atomMarks(marks)));
          H.seen = true;
          break;
        case 'code':
          if (s.code) out.push(schema.text(s.code, [...marks, schema.marks.code.create()]));
          H.seen = true;
          break;
        case 'raw':
          if (s.fmt === 'typst' || s.fmt === 'html') out.push(schema.nodes.typst_inline.create({ src: s.src, lang: s.fmt === 'html' ? 'html' : 'typst' }, null, atomMarks(marks)));
          else {
            if (s.src) out.push(schema.text(s.src, [...marks, schema.marks.code.create()]));
            pushText(`{=${s.fmt}}`, marks, out);
          }
          H.seen = true;
          break;
        case 'attrs':
          pushText(s.orig, marks, out);
          break;
        case 'lit':
          pushText(s.ch, marks, out);
          break;
        case 'comment':
          hoist(s.text, { inline: s.orig, lines: inlineLines }, s.trailing && topParagraph);
          out.push(CUT);
          break;
      }
    }
    if (last < text.length) pushText(text.slice(last), marks, out);
  }

  function pushText(text: string, marks: readonly Mark[], out: Item[]): void {
    if (!text) return;
    out.push(schema.text(text, marks));
    if (text.trim()) H.seen = true;
  }

  /** The marks an inline atom (a formula, a citation or reference, a
   *  footnote marker, an image, an inline island) takes from the span it
   *  sits in: strong, emphasis and strike, as the editor gives them to an
   *  atom inside a bolded run and the writer writes it inside the run's
   *  delimiters. Strong emboldens (and widens) Typst math. A link or code
   *  mark does not apply to an atom. */
  function atomMarks(marks: readonly Mark[]): Mark[] {
    return marks.filter((mk) => mk.type.name === 'strong' || mk.type.name === 'em' || mk.type.name === 'strike');
  }

  function refNode(key: string, marks: readonly Mark[]): PMNode {
    return NAMESPACE.test(key) ? schema.nodes.eq_ref.create({ label: key }, null, atomMarks(marks)) : schema.nodes.citation.create({ key }, null, atomMarks(marks));
  }

  /** A markdown-it text token: printed form (the dash and ellipsis
   *  shorthands become their glyphs, as Typst prints them), then citation
   *  groups, bare citations and references, and the sentinels. */
  function textItems(raw: string, marks: readonly Mark[], displays: boolean, out: Item[]): void {
    const text = printedForm(raw);
    let last = 0;
    const plain = (to: number) => {
      // Bare `@key` (not after a letter or digit: `a@b.org` is no
      // citation) and `-@key` (pandoc's suppressed author, kept as text
      // beside the citation).
      const seg = text.slice(last, to);
      let at = 0;
      for (const m of seg.matchAll(BARE_CITE)) {
        expand(seg.slice(at, m.index), marks, displays, out);
        // `-@key` and `@key [p. 3]` are pandoc's suppressed author and
        // locator: kept as the text they are.
        if (m[1] || /^ ?\[[^\]@]*\]/.test(seg.slice(m.index! + m[0].length))) warn(CITE_EXTRAS);
        if (m[1]) pushText('-', marks, out);
        out.push(refNode(m[2], marks));
        H.seen = true;
        at = m.index! + m[0].length;
      }
      expand(seg.slice(at), marks, displays, out);
    };
    for (let p = text.indexOf('['); p >= 0; p = text.indexOf('[', p + 1)) {
      if (p < last) continue;
      const group = citeGroup(text, p);
      if (!group) continue;
      plain(p);
      group.items.forEach((it, k) => {
        if (it.prefix || it.suffix || it.suppress) warn(CITE_EXTRAS);
        if (k > 0 && (group.items[k - 1].suffix || it.prefix)) expand('; ', marks, displays, out);
        if (it.prefix) expand(it.prefix + ' ', marks, displays, out);
        if (it.suppress) pushText('-', marks, out);
        out.push(refNode(it.key, marks));
        if (it.suffix) expand(it.suffix, marks, displays, out);
      });
      H.seen = true;
      last = group.end;
      p = group.end - 1;
    }
    plain(text.length);
  }

  const imageAttrs = (children: MdToken[], at: number): PandocAttrs | null => {
    const next = children[at];
    if (next?.type !== 'text') return null;
    const m = LEADING_SENTINEL.exec(next.content);
    const s = m ? store[+m[1]] : null;
    if (s?.k !== 'attrs') return null;
    next.content = next.content.slice(m![0].length);
    return s.attrs;
  };

  const widthOf = (attrs: PandocAttrs | null, what: string): number | null => {
    let pct: number | null = null;
    for (const [key, value] of attrs?.kvs ?? []) {
      if (key !== 'width') {
        warn(`${what} attribute "${key}" has no Plass form — dropped`);
        continue;
      }
      const m = /^(\d+(?:\.\d+)?|\.\d+)%$/.exec(value);
      const n = m ? Number(m[1]) : NaN;
      if (n > 0 && n <= 100) pct = n;
      else warn(`${what} width "${value}" is not a percent from 1% to 100% — dropped`);
    }
    for (const cls of attrs?.classes ?? []) warn(`${what} class ".${cls}" has no Plass form — dropped`);
    return pct;
  };

  /** One inline run as items: nodes, display formulas (when `displays`,
   *  for a paragraph to split at) and the cuts comments left. */
  function inlineItems(children: MdToken[], displays: boolean): Item[] {
    const out: Item[] = [];
    let marks: Mark[] = [];
    for (let ti = 0; ti < children.length; ti++) {
      const t = children[ti];
      switch (t.type) {
        case 'text':
          if (t.content) textItems(t.content, marks, displays, out);
          break;
        case 'code_inline':
          // markdown-it's own code span: only where the pre-pass saw none.
          out.push(schema.text(restore(t.content), [...marks, schema.marks.code.create()]));
          H.seen = true;
          break;
        case 'strong_open':
          marks = [...marks, schema.marks.strong.create()];
          break;
        case 'em_open':
          marks = [...marks, schema.marks.em.create()];
          break;
        case 'link_open':
          marks = [...marks, schema.marks.link.create({ href: restoreLink(t.attrGet('href') ?? ''), title: t.attrGet('title') === null ? null : restoreLink(t.attrGet('title')!) })];
          break;
        case 's_open':
          marks = [...marks, schema.marks.strike.create()];
          break;
        case 'link_close':
          marks = marks.slice(0, -1);
          if (imageAttrs(children, ti + 1)) warn('link attributes have no Plass form — dropped');
          break;
        case 'strong_close':
        case 'em_close':
        case 's_close':
          marks = marks.slice(0, -1);
          break;
        case 'softbreak':
          out.push(schema.text(' ', marks));
          break;
        case 'hardbreak':
          out.push(schema.nodes.hard_break.create());
          break;
        case 'image': {
          const attrs = imageAttrs(children, ti + 1);
          if (attrs?.id) warn('an inline image has no label — its id was dropped');
          const alt = altText(t.children ?? []);
          const title = restoreLink(t.attrGet('title') ?? '');
          out.push(
            schema.nodes.image.create({ src: restoreLink(t.attrGet('src') ?? ''), alt: alt || null, title: title || null, widthPct: widthOf(attrs, 'image') }, null, atomMarks(marks)),
          );
          H.seen = true;
          break;
        }
        case 'footnote_ref': {
          const label = (t.meta as { label?: string } | null)?.label;
          if (label !== undefined && !quiet) printedNotes.push(label);
          const body = footnoteBody((t.meta as { id?: number } | null)?.id ?? -1);
          const nodes = out.filter(isNode);
          const lastText = nodes[nodes.length - 1];
          if (lastText && out[out.length - 1] === lastText) {
            const one = [lastText];
            trimSpaceBeforeMarker(one);
            if (one.length) out[out.length - 1] = one[0];
            else out.pop();
          }
          out.push(schema.nodes.footnote.create(null, body, atomMarks(marks)));
          H.seen = true;
          break;
        }
        case 'html_inline': {
          const note = readMdComment(t.content);
          if (note !== null) {
            hoist(note, { inline: t.content, lines: inlineLines });
            out.push(CUT);
            break;
          }
          // An inline island: verbatim in the file, inline code in the
          // page and the print.
          if (t.content) out.push(schema.nodes.typst_inline.create({ src: restore(t.content), lang: 'html' }, null, atomMarks(marks)));
          H.seen = true;
          break;
        }
        default:
          if (t.content) textItems(t.content, marks, displays, out);
      }
    }
    return out;
  }

  /** Close the gaps comments left (one space where two would meet, none at
   *  either end) and drop the markers. */
  function closeCuts(items: Item[]): Array<PMNode | DisplayItem> {
    const out: Array<PMNode | DisplayItem> = [];
    let pending = false;
    for (const item of items) {
      if (item === CUT) {
        pending = true;
        continue;
      }
      if (pending && isNode(item) && item.isText) {
        const prev = out[out.length - 1];
        const prevEnds = !prev || prev instanceof DisplayItem || (prev.isText && /\s$/.test(prev.text ?? ''));
        if (prevEnds) {
          const trimmed = (item.text ?? '').replace(/^\s+/, '');
          pending = false;
          if (trimmed) out.push(schema.text(trimmed, item.marks));
          continue;
        }
      }
      pending = false;
      out.push(item);
    }
    if (pending) {
      const last = out[out.length - 1];
      if (last && !(last instanceof DisplayItem) && last.isText) {
        const trimmed = (last.text ?? '').replace(/\s+$/, '');
        if (trimmed) out[out.length - 1] = schema.text(trimmed, last.marks);
        else out.pop();
      }
    }
    return out;
  }

  /** An inline run with no display formulas left in it, smartened. */
  function finishInline(items: Item[]): PMNode[] {
    return smartenInline(closeCuts(items).map((x) => (x instanceof DisplayItem ? schema.nodes.math_inline.create({ src: x.display.src }) : x)));
  }

  // ---------- blocks ----------

  const matchClose = (i: number): number => {
    let depth = 0;
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].type === 'div_open') depth++;
      else if (tokens[j].type === 'div_close' && --depth === 0) return j;
    }
    return tokens.length;
  };

  const commentsOnly = (t: MdToken) => {
    if (t.type !== 'html_block') return false;
    const read = readMdComments(t.content);
    return !!read && !read.rest;
  };

  /** The plain caption a paragraph states (`: Caption`), from its read
   *  nodes: math as `$…$`, citations and references in their Markdown
   *  form, as step 3's `takeCaptionLine` stores a caption row. `flat` when
   *  marks or line breaks were kept as their text only. Null when it holds
   *  what a caption cannot (a footnote, an image, inline HTML or Typst). */
  const captionOf = (p: PMNode): { text: string; flat: boolean } | null => {
    if (p.type !== paragraph) return null;
    let text = '';
    let ok = true;
    let flat = false;
    p.forEach((n) => {
      if (n.isText) text += n.text;
      else if (n.type.name === 'math_inline') text += `$${n.attrs.src as string}$`;
      else if (n.type.name === 'citation') text += `[@${n.attrs.key as string}]`;
      else if (n.type.name === 'eq_ref') text += `@${n.attrs.label as string}`;
      else if (n.type.name === 'hard_break') {
        text += ' ';
        flat = true;
      } else ok = false;
      if (n.marks.length) flat = true;
    });
    const caption = ok ? captionFromLine(text) : null;
    return caption === null ? null : { text: caption, flat };
  };
  const NOT_A_CAPTION = 'a footnote, an image, inline HTML or display math, which a Plass table caption cannot hold';
  /** `table` with the caption a `: Caption` line gives it. */
  const captioned = (table: PMNode, caption: { text: string; flat: boolean }): PMNode => {
    if (caption.flat) warn('a table caption is plain text — its emphasis, code, links and line breaks are kept as their text');
    return table.type.create({ ...table.attrs, caption: printedCaption(caption.text) }, table.content);
  };

  /** A table caption in printed form (dashes, ellipsis, Typst's quotes)
   *  outside its `$…$` math, as body text is held. */
  const printedCaption = (caption: string): string => {
    const quotes = createQuoteState();
    let before: string | null = null;
    return caption
      .split(/((?<!\\)\$\S(?:[^$\n]*?\S)?\$(?!\d))/)
      .map((part, k) => {
        if (k % 2) {
          before = '\uFFFC';
          return part;
        }
        const r = smartenText(printedForm(part), quotes, before);
        before = r.before;
        return r.text;
      })
      .join('');
  };

  function parseTable(i: number, attrs: PandocAttrs | null): { node: PMNode; next: number } {
    const open = tokens[i];
    const rows: PMNode[] = [];
    let cells: PMNode[] = [];
    let header = false;
    for (; i < tokens.length && tokens[i].type !== 'table_close'; i++) {
      const t = tokens[i];
      if (t.type === 'thead_open') header = true;
      else if (t.type === 'thead_close') header = false;
      else if (t.type === 'tr_open') cells = [];
      else if (t.type === 'tr_close') rows.push(schema.nodes.table_row.create(null, cells));
      else if (t.type === 'th_open' || t.type === 'td_open') {
        const inline = tokens[i + 1];
        const type = header || t.type === 'th_open' ? schema.nodes.table_header : schema.nodes.table_cell;
        inlineLines = mapLines(inline?.map ?? open.map);
        const content = finishInline(inlineItems(inline?.children ?? [], false));
        cells.push(type.create({ align: delimiterAlign(t.attrGet('style')) }, [paragraph.create(null, content)]));
        i++;
      }
    }
    const last = open.map ? lines[origLine[open.map[1] - 1] ?? 0] ?? null : null;
    let node = readPipeTable(
      schema.nodes.table.create({ style: 'booktabs' }, rows),
      attrs ? { id: attrs.id, classes: attrs.classes, keyvals: attrs.kvs } : null,
      warn,
      last ?? undefined,
    );
    if (node.attrs.caption) node = node.type.create({ ...node.attrs, caption: printedCaption(node.attrs.caption as string) }, node.content);
    H.seen = true;
    return { node, next: i + 1 };
  }

  /** The paragraph `t` opens: a page break, a figure, a paragraph, or
   *  paragraphs split around display math. */
  function parseParagraph(i: number, top: boolean): PMNode[] {
    const inline = tokens[i + 1];
    const kids = inline?.children ?? [];
    inlineLines = mapLines(inline?.map ?? tokens[i].map);
    /** Hoist the comments in `ks` (the paragraph is not read as a run). */
    const hoistIn = (ks: MdToken[]) => {
      for (const k of ks) for (const c of tokenComments(k)) hoist(c.text, { inline: c.orig, lines: inlineLines }, c.trailing && top);
    };
    // Comments and white space do not count: what is left says what the
    // paragraph is.
    const solid = kids.filter(
      (k) => !(k.type === 'softbreak' || (k.type === 'text' && /^[ \t\n]*$/.test(uncommented(k.content))) || (k.type === 'html_inline' && readMdComment(k.content) !== null)),
    );
    // The command as the source writes it: `\\newpage` (an escaped
    // backslash) is text, as pandoc reads it.
    const command = (text: string) => /^\\(?:newpage|pagebreak)$/.test(uncommented(text).replace(/<!--[\s\S]*?-->/g, '').trim());
    if (solid.length === 1 && solid[0].type === 'text' && command(solid[0].content) && command(inline?.content ?? '')) {
      hoistIn(kids);
      H.seen = true;
      if (top) return [schema.nodes.page_break.create()];
      warn('a page break inside a block cannot print — kept as source');
      return [code_block.create({ params: 'md-raw' }, [schema.text(uncommented(solid[0].content).trim())])];
    }
    const at = kids.indexOf(solid[0]);
    // What may follow a lone image: its attribute block, then spaces and
    // no-break spaces. A no-break space there is pandoc's way to keep the
    // image out of a figure.
    const tail = solid.length === 2 && solid[1].type === 'text' ? IMAGE_TAIL.exec(uncommented(solid[1].content)) : null;
    const tailAttrs = tail?.[1] !== undefined ? store[+tail[1]] : null;
    const tailOk = !!tail && (tailAttrs ? tailAttrs.k === 'attrs' : tail[2].includes('\u00a0'));
    const glue = tailOk && tail![2].includes('\u00a0');
    const lone = solid[0]?.type === 'image' && (solid.length === 1 || tailOk);
    const img = solid[0];
    const asFigure = lone && (altText(img.children ?? []).trim() !== '' || (tailAttrs?.k === 'attrs' && !!tailAttrs.attrs.id));
    if (lone && (!glue || asFigure)) {
      // A lone image: a figure when it has a caption (pandoc's implicit
      // figure) or a label; otherwise an image in its paragraph. With the
      // no-break space after it, it is an image in its paragraph whatever
      // it has, and the space (the file's way of saying so) is dropped.
      hoistIn(kids.slice(0, at));
      const attrs = imageAttrs(kids, kids.indexOf(img) + 1);
      const src = restoreLink(img.attrGet('src') ?? '');
      const title = restoreLink(img.attrGet('title') ?? '');
      const label = attrs?.id ?? '';
      const caption = altText(img.children ?? []).trim();
      H.seen = true;
      let node: PMNode;
      if (glue) {
        if (label) warn('an inline image has no label — its id was dropped');
        const alt = altText(img.children ?? []);
        node = paragraph.create(null, [schema.nodes.image.create({ src, alt: alt || null, title: title || null, widthPct: widthOf(attrs, 'image') })]);
      } else if (caption || label) {
        forceAfter++;
        const content = finishInline(inlineItems(img.children ?? [], false));
        forceAfter--;
        node = schema.nodes.figure.create({ src, label, title, widthPct: widthOf(attrs, 'figure') }, content);
      } else {
        // No caption: an alt of spaces alone stays as written.
        const alt = altText(img.children ?? []);
        node = paragraph.create(null, [schema.nodes.image.create({ src, alt: alt || null, title: title || null, widthPct: widthOf(attrs, 'image') })]);
      }
      hoistIn(kids.slice(at + 1));
      return [node];
    }
    topParagraph = top;
    const items = closeCuts(inlineItems(kids, true));
    topParagraph = false;
    // Display math is a block: the paragraph splits around each formula,
    // each piece read on its own (its own quote state).
    const out: PMNode[] = [];
    let piece: PMNode[] = [];
    const isBreak = (n: PMNode) => n.type === schema.nodes.hard_break;
    /** A line break that ends a piece (before a formula, or at the
     *  paragraph's end) prints nothing, as Typst lays it out, and has no
     *  Markdown form (`\` there is a literal backslash): it goes, with the
     *  spaces around it. One that opens the piece after a formula prints
     *  an empty line and stays. */
    const dropEndBreaks = (nodes: PMNode[]) => {
      let end = nodes.length;
      while (end > 0 && (isBreak(nodes[end - 1]) || (nodes[end - 1].isText && /^[ \t\n]*$/.test(nodes[end - 1].text!)))) end--;
      if (nodes.slice(end).some(isBreak)) nodes.length = end;
    };
    const flushPiece = () => {
      const nodes = [...piece];
      dropEndBreaks(nodes);
      while (nodes.length && nodes[0].isText && !nodes[0].text!.trim()) nodes.shift();
      while (nodes.length && nodes[nodes.length - 1].isText && !nodes[nodes.length - 1].text!.trim()) nodes.pop();
      if (nodes.length && nodes[0].isText) nodes[0] = schema.text(nodes[0].text!.replace(/^\s+/, ''), nodes[0].marks);
      const lastIdx = nodes.length - 1;
      if (lastIdx >= 0 && nodes[lastIdx].isText) nodes[lastIdx] = schema.text(nodes[lastIdx].text!.replace(/\s+$/, ''), nodes[lastIdx].marks);
      if (nodes.length) out.push(paragraph.create(null, smartenInline(nodes)));
      piece = [];
    };
    for (const item of items) {
      if (item instanceof DisplayItem) {
        flushPiece();
        out.push(schema.nodes.math_display.create({ src: item.display.src, label: item.display.label, numbered: item.display.numbered }));
      } else piece.push(item);
    }
    if (out.length) flushPiece();
    else if (piece.length) {
      dropEndBreaks(piece);
      if (piece.length) out.push(paragraph.create(null, smartenInline(piece)));
    }
    return out;
  }

  /** Where the opener of div `t` starts on its source line: the last run
   *  of its colons that its attributes follow (a list marker, quote
   *  markers or a comment may come before it on the line). -1 if none. */
  function openerColumn(line: string, t: MdToken): number {
    const info = restore(t.info).split('\n')[0];
    for (let p = line.lastIndexOf(t.markup); p >= 0; p = p > 0 ? line.lastIndexOf(t.markup, p - 1) : -1) {
      let q = p + t.markup.length;
      if (line[p - 1] === ':' || line[q] === ':') continue;
      while (line[q] === ' ' || line[q] === '\t') q++;
      if (line.startsWith(info, q)) return p;
    }
    return -1;
  }

  /** The original source of a div, opener to closer, in its container's
   *  coordinates and with the comments the reader hoisted out of it left
   *  out: an island's text. Its first line starts at the opener; what is
   *  before the opener there (a list item's marker, quote markers, a
   *  comment that closes on that line) is the container's or the file's,
   *  and the same container markers come off the lines after it. */
  function islandSource(t: MdToken, within: Cut[]): string {
    const map = t.map ?? [0, 0];
    const from = origLine[map[0]];
    const to = origLine[map[1]] ?? lines.length;
    const kept: string[] = [];
    const dropped = new Set<number>();
    const commentLines = new Set<number>();
    for (const c of within) if (!('inline' in c)) for (let l = c.lines[0]; l < c.lines[1]; l++) commentLines.add(l);
    /** Each source line's text; null for a line an inline cut joined into
     *  the one before it. */
    const text = new Map<number, string | null>();
    for (let l = from; l < to; l++) text.set(l, lines[l]);
    for (const c of within) {
      if (!('inline' in c)) continue;
      // The comment as markdown-it saw it, matched in the source: a line
      // break in it may be followed there by the container's quote
      // markers and indentation, which markdown-it had removed.
      const pattern = new RegExp(
        c.inline
          .split('\n')
          .map((part, k) => (k ? part.replace(/^[ \t]+/, '') : part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('\\n[ \\t>]*'),
      );
      for (let l = c.lines[0]; l < c.lines[1]; l++) {
        if (text.get(l) == null) continue;
        // The run of lines from `l` the comment can span.
        const span: number[] = [];
        for (let e = l; e < c.lines[1] && span.length <= (c.inline.match(/\n/g)?.length ?? 0); e++) if (text.get(e) != null) span.push(e);
        const joined = span.map((e) => text.get(e)).join('\n');
        const m = pattern.exec(joined);
        if (!m || joined.slice(0, m.index).includes('\n')) continue;
        const before = joined.slice(0, m.index);
        let after = joined.slice(m.index + m[0].length);
        // The gap closes to one space, as it does in a paragraph; a comment
        // that held a line of its own (in a paragraph, or a block's that
        // its text followed) takes the line with it.
        if (!before.trim() || /[ \t]$/.test(before)) after = after.replace(/^[ \t]+/, '');
        const merged = /^[ \t>]*$/.test(before + after) ? [] : (before + after).split('\n');
        span.forEach((e, k) => text.set(e, k < merged.length ? merged[k] : null));
        break;
      }
    }
    const opener = text.get(from) ?? lines[from];
    let at = openerColumn(opener, t);
    if (at < 0) at = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(opener)![0].length;
    // The container markers before the opener, a comment closing there
    // left out: each quote marker comes off a later line (when it has
    // one), and a list marker's or indentation's width of spaces.
    let head = opener.slice(0, at);
    if (head.includes('-->')) head = head.slice(head.lastIndexOf('-->') + 3);
    const peel: Array<number | '>'> = [];
    for (let m: RegExpExecArray | null; head && (m = /^[ \t]{0,3}>[ \t]?|^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)|^[ \t]+/.exec(head)); head = head.slice(m[0].length)) {
      peel.push(m[0].includes('>') ? '>' : m[0].length);
    }
    const dedent = (line: string) => {
      let l = line;
      for (const p of peel) l = p === '>' ? l.replace(/^[ \t]{0,3}>[ \t]?/, '') : l.slice(Math.min(p, /^[ \t]*/.exec(l)![0].length));
      return l;
    };
    for (let l = from; l < to; l++) {
      if (text.get(l) === null) continue;
      if (commentLines.has(l)) {
        // A dropped comment takes one blank line with it.
        if (!commentLines.has(l + 1) && !(kept[kept.length - 1] ?? 'x').trim() && !(text.get(l + 1) ?? 'x').trim()) dropped.add(l + 1);
        continue;
      }
      if (dropped.has(l)) continue;
      kept.push(l === from ? opener.slice(at) : dedent(text.get(l)!));
    }
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
    return kept.join('\n');
  }

  /** A div `i` opens, read as the class says (or kept as an island). */
  function parseDiv(i: number, seq: PMNode[]): { nodes: PMNode[]; next: number } {
    const t = tokens[i];
    const meta = t.meta as DivMeta;
    const close = matchClose(i);
    const next = close + 1;
    const { id, classes, kvs } = meta.attrs;
    const rail = RAILS.find((c) => classes.includes(c));
    const where = `line ${lineNo(t.map?.[0] ?? 0)}`;
    const opener = `::: ${t.info}`;
    const prev = tokens[i - 1]?.type === 'paragraph_close' ? tokens[i - 2] : null;
    const afterBreak = prev?.type === 'inline' && /^\\(?:newpage|pagebreak)\s*$/.test(prev.content);
    if (meta.glued && !afterBreak) warn(`"${opener}" (${where}) directly follows a line of text — add a blank line before it (pandoc reads it as text)`);
    if (meta.unclosed) warn(`"${opener}" (${where}) has no closing ::: — it runs to the end of its container`);
    const dropExtra = (allowed: string[], allowedKeys: string[]) => {
      const extra = [...(id ? [`#${id}`] : []), ...classes.filter((c) => !allowed.includes(c)).map((c) => `.${c}`), ...kvs.filter(([k]) => !allowedKeys.includes(k)).map(([k]) => k)];
      if (extra.length) warn(`${extra.join(', ')} on "${opener}" ${extra.length > 1 ? 'have' : 'has'} no Plass form — dropped`);
    };

    const textNode = (s: string) => (s ? [schema.text(s)] : []);
    // Any other div is kept as written. Its content is still read, for the
    // comments it holds: they move out like any nested comment, so the
    // island never prints one.
    const island = (): { nodes: PMNode[]; next: number } => {
      const mark = cuts.length;
      quiet++;
      parseSeq(i + 1, 'div_close', false);
      quiet--;
      H.seen = true;
      const node = keepIsland(code_block.create({ params: 'md-raw' }, textNode(islandSource(t, cuts.slice(mark)))), t.map);
      if (meta.unclosed) openEnded.add(node);
      return { nodes: [node], next };
    };
    /** Where the reading stands, so a div read as a rail can still turn
     *  into an island. */
    const readMark = () => ({ warnings: warnings.length, cuts: cuts.length, notes: printedNotes.length, islands: islands.length });
    /** The div, already read, kept as source instead: what was read is
     *  dropped for the island (its warnings, its notes and islands with
     *  it); the comments it held stay moved out of it. */
    const readAsIsland = (mark: ReturnType<typeof readMark>, why: string): { nodes: PMNode[]; next: number } => {
      warnings.length = mark.warnings;
      printedNotes.length = mark.notes;
      islands.length = mark.islands;
      H.seen = true;
      warn(why);
      const node = keepIsland(code_block.create({ params: 'md-raw' }, textNode(islandSource(t, cuts.slice(mark.cuts)))), t.map);
      if (meta.unclosed) openEnded.add(node);
      return { nodes: [node], next };
    };
    // An unclosed div whose content ends in source that runs open lost its
    // closer to that source: it is kept as source as well, or the closer
    // written after its content would be taken in again on every save.
    const TAKEN = `"${opener}" (${where}) ends in content kept as source that takes in its closer — kept as source`;

    if (rail === 'solution') {
      const mark = readMark();
      dropExtra(['solution'], []);
      const inner = parseSeq(i + 1, 'div_close', false);
      if (meta.unclosed && endsOpen(inner.nodes)) return readAsIsland(mark, TAKEN);
      return { nodes: [blockquote.create({ kind: 'solution' }, inner.nodes.length ? inner.nodes : [paragraph.create()])], next };
    }

    if (rail === 'columns') {
      // A row: nothing but `.column` divs (and comments).
      const cellDivs: number[] = [];
      for (let j = i + 1; j < close; ) {
        const u = tokens[j];
        if (u.type === 'div_open' && (u.meta as DivMeta).attrs.classes.includes('column')) {
          cellDivs.push(j);
          j = matchClose(j) + 1;
        } else if (commentsOnly(u)) j++;
        else return island();
      }
      if (!cellDivs.length) return island();
      const mark = readMark();
      let taken = false;
      dropExtra(['columns', 'continued'], ['gutter']);
      const continued = classes.includes('continued');
      let gi = seq.length - 1;
      while (gi >= 0 && seq[gi].type === schema.nodes.editor_comment) gi--;
      const grid = continued && gi >= 0 && seq[gi].type === schema.nodes.grid ? seq[gi] : null;
      if (grid) H.seen = true;
      if (continued && !grid) warn(`"${opener}" (${where}) continues no grid (none directly before it) — it starts a grid of its own`);
      else if (grid && gi < seq.length - 1) warn(`a comment between a grid's rows (before ${where}) moves after the grid — the rows are one grid`);
      const shares: Array<number | null> = [];
      const cells: PMNode[] = [];
      for (let j = i + 1; j < close; ) {
        const u = tokens[j];
        if (u.type === 'html_block') {
          for (const c of readMdComments(u.content)?.comments ?? []) hoist(c, blockCut(u));
          j++;
          continue;
        }
        const cellMeta = u.meta as DivMeta;
        const ca = cellMeta.attrs;
        const extra = [...(ca.id ? [`#${ca.id}`] : []), ...ca.classes.filter((c) => c !== 'column').map((c) => `.${c}`), ...ca.kvs.filter(([k]) => k !== 'width').map(([k]) => k)];
        if (extra.length) warn(`${extra.join(', ')} on a ::: column has no Plass form — dropped`);
        const width = ca.kvs.filter(([k]) => k === 'width').pop()?.[1];
        let share: number | null = null;
        if (width !== undefined) {
          const m = /^(\d+(?:\.\d+)?|\.\d+)(%|fr)?$/.exec(width.trim());
          if (m && Number(m[1]) > 0) share = Number(m[1]);
          else warn(`column width "${width}" is not a percent, a number or an fr share — the column takes an equal share`);
        }
        shares.push(share);
        const inner = parseSeq(j + 1, 'div_close', false);
        if (cellMeta.unclosed && endsOpen(inner.nodes)) taken = true;
        cells.push(schema.nodes.grid_cell.create(null, inner.nodes.length ? inner.nodes : [paragraph.create()]));
        j = inner.next;
      }
      if (taken) return readAsIsland(mark, TAKEN);
      const given = shares.filter((s): s is number => s !== null);
      const filled = shares.map((s) => s ?? (given.length ? given.reduce((a, b) => a + b, 0) / given.length : 1));
      const columns = canonicalShares(filled);
      const gutter = gutterEm(kvs.filter(([k]) => k === 'gutter').pop()?.[1]);
      if (grid) {
        const width = (grid.attrs.columns as number[]).length;
        if (cells.length !== width) warn(`a .continued grid row has ${cells.length} cell(s) where its grid has ${width} — the row is refit to ${width}`);
        else if (JSON.stringify(columns) !== JSON.stringify(grid.attrs.columns)) warn('a .continued grid row has other column widths than its grid — the grid keeps its own');
        if (gutter !== grid.attrs.gutter) warn('a .continued grid row has another gutter than its grid — the grid keeps its own');
        const rows: PMNode[] = [];
        grid.forEach((r) => rows.push(r));
        rows.push(...gridRows(cells, width));
        seq[gi] = grid.type.create(grid.attrs, rows);
        return { nodes: [], next };
      }
      return { nodes: [schema.nodes.grid.create({ columns, gutter }, gridRows(cells, columns.length))], next };
    }

    if (rail === 'table') {
      // Exactly one pipe table, a caption line beside it, and comments.
      let tableAt = -1;
      const captions: number[] = [];
      for (let j = i + 1; j < close; ) {
        const u = tokens[j];
        if (u.type === 'table_open' && tableAt < 0) {
          tableAt = j;
          while (j < close && tokens[j].type !== 'table_close') j++;
          j++;
        } else if (u.type === 'paragraph_open' && captionFromLine(tokens[j + 1]?.content ?? '') !== null) {
          captions.push(j);
          j += 3;
        } else if (commentsOnly(u)) j++;
        else return island();
      }
      if (tableAt < 0 || captions.length > 1) return island();
      const mark = readMark();
      let node: PMNode | null = null;
      let caption: { text: string; flat: boolean } | null = null;
      let rejected = false;
      for (let j = i + 1; j < close; ) {
        const u = tokens[j];
        if (j === tableAt) {
          const read = parseTable(j, meta.attrs);
          node = read.node;
          j = read.next;
        } else if (captions.includes(j)) {
          const read = parseParagraph(j, false);
          caption = read.length === 1 ? captionOf(read[0]) : null;
          rejected = !caption;
          j += 3;
        } else {
          for (const c of readMdComments(u.content)?.comments ?? []) hoist(c, blockCut(u));
          j++;
        }
      }
      if (rejected) return readAsIsland(mark, `"${opener}" (${where}): its caption line holds ${NOT_A_CAPTION} — kept as source`);
      if (caption !== null && node) {
        if (node.attrs.caption) warn('a table has both a caption attribute and a caption line — the attribute is kept');
        else node = captioned(node, caption);
      }
      return { nodes: node ? [node] : [], next };
    }

    if (rail && ALIGN_RAILS.includes(rail)) {
      const mark = readMark();
      const inner = parseSeq(i + 1, 'div_close', false);
      const only = inner.nodes.filter((n) => n.type !== schema.nodes.editor_comment);
      if (only.length !== 1 || only[0].type !== paragraph) return readAsIsland(mark, `"${opener}" (${where}) holds something other than one paragraph — kept as source`);
      dropExtra(ALIGN_RAILS, []);
      const aligns = classes.filter((c) => c === 'center' || c === 'right');
      if (aligns.length > 1) warn(`"${opener}" names two alignments — the first is kept`);
      const p = only[0];
      return { nodes: [paragraph.create({ ...p.attrs, align: aligns[0] ?? null, keep: classes.includes('keep') }, p.content)], next };
    }

    return island();
  }

  /** A grid's rows from one row's cells, refit to `width` columns (a
   *  short row padded, a long one wrapped, as Typst would lay its cells). */
  function gridRows(cells: PMNode[], width: number): PMNode[] {
    const rows: PMNode[] = [];
    for (let k = 0; k < cells.length; k += width) {
      const row = cells.slice(k, k + width);
      while (row.length < width) row.push(schema.nodes.grid_cell.create(null, [paragraph.create()]));
      rows.push(schema.nodes.grid_row.create(null, row));
    }
    return rows;
  }

  /** A gutter in em: em is native; pt, in, mm and cm are converted at the
   *  document's font size. Absent or unreadable, the rail's 1em. */
  function gutterEm(value: string | undefined): number {
    if (value === undefined) return 1;
    const m = /^(\d+(?:\.\d+)?|\.\d+)(em|pt|in|mm|cm)?$/.exec(value.trim());
    if (!m) {
      warn(`grid gutter "${value}" is not a length — 1em is used`);
      return 1;
    }
    const n = Number(m[1]);
    const pt = { em: n * settings.sizePt, pt: n, in: n * 72, mm: (n * 72) / 25.4, cm: (n * 72) / 2.54 }[m[2] ?? 'em']!;
    return Math.round((pt / settings.sizePt) * 1000) / 1000;
  }

  /** The blocks of one block-level token at `i`; `captionLine` when it is
   *  a paragraph whose source is a `: Caption` line. */
  function parseBlock(i: number, seq: PMNode[], top: boolean): { nodes: PMNode[]; next: number; captionLine?: boolean } {
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const level = +t.tag.slice(1);
        const inline = tokens[i + 1];
        let kids = inline?.children ?? [];
        let attrs = t.map ? pre.headingAttrs.get(t.map[0]) ?? null : null;
        if (!attrs) {
          // A setext heading's (or one in a list item's) attributes end its
          // text — so its source says, where an escaped `\{` is still seen.
          const last = kids[kids.length - 1];
          const found = last?.type === 'text' && trailingAttrs(inline?.content ?? '') ? trailingAttrs(last.content) : null;
          if (found) {
            attrs = found.attrs;
            kids = [...kids.slice(0, -1), { ...last, content: last.content.slice(0, found.start).replace(/[ \t]+$/, '') } as MdToken];
          }
        }
        if (attrs) {
          const extra = [...attrs.classes.filter((c) => c !== 'unnumbered').map((c) => `.${c}`), ...attrs.kvs.map(([k]) => k)];
          if (extra.length) warn(`${extra.join(', ')} on a heading ${extra.length > 1 ? 'have' : 'has'} no Plass form — dropped`);
        }
        inlineLines = mapLines(inline?.map ?? t.map);
        const content = finishInline(inlineItems(kids, false));
        H.seen = true;
        return { nodes: [heading.create({ level, label: attrs?.id ?? '' }, content)], next: i + 3 };
      }
      case 'paragraph_open': {
        const nodes = parseParagraph(i, top);
        // A `: Caption` line beside a table may be its caption: so its
        // source says (an escaped `\:` is a paragraph).
        return { nodes, next: i + 3, captionLine: captionFromLine(tokens[i + 1]?.content ?? '') !== null };
      }
      case 'code_block':
        // Indented (four-space) code: same node as a fence, no language.
        H.seen = true;
        return { nodes: [code_block.create({ params: '' }, [schema.text(restore(t.content).replace(/\n$/, ''))])], next: i + 1 };
      case 'fence': {
        // A fence the pre-pass did not see (one opening in a list item's
        // marker line) was scanned: its info string goes back to its text.
        const info = restore(t.info).trim();
        const content = restore(t.content).replace(/\n$/, '');
        const text = content ? [schema.text(content)] : [];
        H.seen = true;
        if (info === '{=typst}') return { nodes: [code_block.create({ params: 'typst-raw' }, text)], next: i + 1 };
        if (info === '{=bibtex}' && !quiet) {
          const sizeError = textSizeError(content, INPUT_LIMITS.bibliographyBytes, 'Embedded bibliography');
          if (sizeError) warn(`${sizeError} — preserved as a code block`);
          else if (bib) warn('a second {=bibtex} block is kept as a code listing — Plass holds one bibliography');
          else {
            bib = { name: 'references.bib', content };
            return { nodes: [schema.nodes.bibliography.create()], next: i + 1 };
          }
        }
        return { nodes: [code_block.create({ params: info }, text)], next: i + 1 };
      }
      case 'blockquote_open': {
        const inner = parseSeq(i + 1, 'blockquote_close', false);
        // The serializer writes the abstract as a quote led by
        // "**Abstract.**" — recognize it coming back.
        const first = inner.nodes[0];
        const lead = first?.firstChild;
        if (
          first?.type === paragraph &&
          lead?.isText &&
          lead.marks.some((m) => m.type === schema.marks.strong) &&
          /^Abstract\.?\s*$/.test(lead.text ?? '')
        ) {
          const rest = first.content.content.slice(1);
          while (rest.length && rest[0].isText && !rest[0].text?.trim()) rest.shift();
          if (rest[0]?.isText) rest[0] = schema.text(rest[0].text!.replace(/^\s+/, ''), rest[0].marks);
          const paras = [paragraph.create(null, rest), ...inner.nodes.slice(1)];
          return { nodes: [schema.nodes.abstract.create(null, paras)], next: inner.next };
        }
        return { nodes: [blockquote.create(null, inner.nodes.length ? inner.nodes : [paragraph.create()])], next: inner.next };
      }
      case 'bullet_list_open': {
        const items = parseListItems(i + 1, 'bullet_list_close');
        return { nodes: [schema.nodes.bullet_list.create({ tight: items.tight }, items.nodes)], next: items.next };
      }
      case 'ordered_list_open': {
        const items = parseListItems(i + 1, 'ordered_list_close');
        const start = t.attrGet('start');
        return { nodes: [schema.nodes.ordered_list.create({ order: start ? +start : 1, tight: items.tight }, items.nodes)], next: items.next };
      }
      case 'hr':
        H.seen = true;
        return { nodes: [horizontal_rule.create()], next: i + 1 };
      case 'table_open': {
        const table = parseTable(i, null);
        return { nodes: [table.node], next: table.next };
      }
      case 'html_block': {
        const read = readMdComments(t.content);
        if (read) {
          // A comment that is not a top-level block moves out of its block.
          for (const c of read.comments) hoist(c, blockCut(t));
          if (!read.rest) return { nodes: [], next: i + 1 };
          const kids = inlineTokens(read.rest);
          return { nodes: [paragraph.create(null, finishInline(inlineItems(kids, false)))], next: i + 1 };
        }
        // An HTML element: kept verbatim, shown and printed as code. A
        // comment on lines of its own inside it is lifted out of it: after
        // it, since its first line is printed code — except in a `<div>`,
        // which pandoc reads as a div (`native_divs`) whose own tags are
        // markup, so there, as in a `:::` div, a comment that nothing but
        // `<div>` tags precedes goes before the block.
        const kept: string[] = [];
        const src = restore(t.content).replace(/\n$/, '').split('\n');
        const seen = H.seen;
        const divTags = (line: string) => /^(?:\s*<\/?div(?:\s[^>]*)?>)*\s*$/i.test(line);
        let text = !/^[ \t]*<div(?=[\s/>]|$)/i.test(src[0] ?? '');
        for (let k = 0; k < src.length; k++) {
          const line = src[k];
          if (k > 0 && /^\s*<!--/.test(line)) {
            let e = k;
            while (e < src.length && !src[e].includes('-->')) e++;
            const chunk = src.slice(k, e + 1).join('\n');
            const read = e < src.length ? readMdComments(chunk) : null;
            if (read && !read.rest) {
              const base = t.map ? origLine[t.map[0]] : 0;
              H.seen = seen || text;
              for (const c of read.comments) hoist(c, { lines: [base + k, base + e + 1] });
              k = e;
              continue;
            }
          }
          if (!divTags(line)) text = true;
          kept.push(line);
        }
        H.seen = true;
        let tight = '';
        if (top) {
          // Which sides had no blank line, so the save keeps the file's
          // spacing (`# Title` directly over a `<div>`).
          const prev = tokens.slice(0, i).reverse().find((k) => k.map)?.map;
          const after = tokens.slice(i + 1).find((k) => k.map)?.map;
          const before = !!t.map && !!prev && prev[1] === t.map[0];
          const behind = !!t.map && !!after && after[0] === t.map[1];
          tight = before && behind ? 'both' : before ? 'before' : behind ? 'after' : '';
        }
        const node = keepIsland(code_block.create({ params: 'md-raw', tight }, [schema.text(kept.join('\n'))]), t.map);
        // An element whose end markdown-it never found (`<pre>` with no
        // `</pre>`) ran to the end of its container.
        const end = HTML_STARTS.find(([re]) => re.test((src[0] ?? '').trimStart()))?.[1];
        if (end && !end.test(t.content)) openEnded.add(node);
        return { nodes: [node], next: i + 1 };
      }
      case 'div_open':
        return parseDiv(i, seq);
      case 'footnote_block_open': {
        // Definitions were collected up front.
        let d = 1;
        let j = i + 1;
        while (j < tokens.length && d > 0) {
          if (tokens[j].type === 'footnote_block_open') d++;
          if (tokens[j].type === 'footnote_block_close') d--;
          j++;
        }
        return { nodes: [], next: j };
      }
      default:
        return { nodes: [], next: i + 1 };
    }
  }

  /** Blocks from `i` to the close token; at the top level each block is a
   *  hoisting boundary for the comments inside it. */
  function parseSeq(i: number, closeType: string | null, top: boolean): { nodes: PMNode[]; next: number } {
    const nodes: PMNode[] = [];
    /** The block read last, while what follows may pair with it: a table
     *  with no caption, or a `: Caption` line (its caption, when it is one
     *  paragraph that can be one), by its place in `nodes`. */
    let prev: { at: number; table: true } | { at: number; table: false; caption: { text: string; flat: boolean } | null } | null = null;
    while (i < tokens.length) {
      const t = tokens[i];
      if (closeType && t.type === closeType) return { nodes, next: i + 1 };
      if (top && t.type === 'html_block') {
        const read = readMdComments(t.content);
        if (read) {
          // A top-level comment is a comment where it stands; text after
          // it on its line is a paragraph (pandoc's reading).
          nodes.push(...read.comments.map(comment));
          if (read.rest) {
            H = { seen: false, before: [], after: [] };
            const p = paragraph.create(null, finishInline(inlineItems(inlineTokens(read.rest), false)));
            nodes.push(...H.before, p, ...H.after);
          }
          prev = null;
          i++;
          continue;
        }
      }
      const saved = H;
      if (top) H = { seen: false, before: [], after: [] };
      const r = parseBlock(i, nodes, top);
      // A `: Caption` paragraph beside a table is the table's caption (each
      // read once, as what it is): the line before the table, or else the
      // line after it. One that holds what a caption cannot stays a
      // paragraph, with a warning.
      let own = r.nodes;
      const table = own.length === 1 && own[0].type === schema.nodes.table && !own[0].attrs.caption ? own[0] : null;
      const caption = r.captionLine ? (own.length === 1 ? captionOf(own[0]) : null) : undefined;
      let paired = false;
      if (table && prev && !prev.table) {
        if (prev.caption) {
          own = [captioned(table, prev.caption)];
          nodes.splice(prev.at, 1);
          paired = true;
        } else warn(`a ": Caption" line before a table holds ${NOT_A_CAPTION} — kept as a paragraph`);
      } else if (caption !== undefined && prev?.table) {
        if (caption) {
          nodes[prev.at] = captioned(nodes[prev.at], caption);
          own = [];
          paired = true;
        } else warn(`a ": Caption" line after a table holds ${NOT_A_CAPTION} — kept as a paragraph`);
      }
      const at = nodes.length + (top ? H.before.length : 0);
      if (top) {
        // Source left open runs to the end of the file, so what the save
        // writes after it would be read as inside it: the comments that
        // came out of it go before it.
        if (endsOpen(own)) nodes.push(...H.before, ...H.after, ...own);
        else nodes.push(...H.before, ...own, ...H.after);
        H = saved;
      } else nodes.push(...own);
      prev = paired ? null : table ? { at, table: true } : caption !== undefined ? { at, table: false, caption } : null;
      i = r.next;
    }
    return { nodes, next: i };
  }

  function parseListItems(i: number, closeType: string): { nodes: PMNode[]; next: number; tight: boolean } {
    const items: PMNode[] = [];
    // markdown-it marks a tight list by hiding the paragraphs directly
    // inside its items; a paragraph left visible means the list is loose.
    let tight = true;
    while (i < tokens.length && tokens[i].type !== closeType) {
      if (tokens[i].type === 'list_item_open') {
        const itemLevel = tokens[i].level;
        for (let j = i + 1; j < tokens.length && tokens[j].type !== 'list_item_close'; j++) {
          if (tokens[j].type === 'paragraph_open' && tokens[j].level === itemLevel + 1 && !tokens[j].hidden) tight = false;
          if (tokens[j].type === 'list_item_open') break;
        }
        const inner = parseSeq(i + 1, 'list_item_close', false);
        items.push(schema.nodes.list_item.create(null, inner.nodes.length ? inner.nodes : [paragraph.create()]));
        i = inner.next;
      } else i++;
    }
    return { nodes: items, next: i + 1, tight };
  }

  let { nodes: body } = parseSeq(0, null, true);
  if (hoisted) warnings.push(`${hoisted} comment(s) moved out of nested blocks — each is kept, unprinted, beside the block it was in`);

  // ---------- definitions only kept-as-source content uses ----------
  // A footnote whose only marker is in an island, and a link reference only
  // an island uses, keep their definitions: appended, verbatim, to the
  // first island that uses them, so the file still holds them after it (an
  // island inside a block keeps them inside it too). A definition nothing
  // uses prints nothing (pandoc's reading too) and is dropped, with a
  // warning; one printed links use is written into them.
  {
    const carried = new Map<PMNode, string[]>();
    // The islands by where they start (they never overlap), and the first
    // island to use each footnote and link label: a definition is looked
    // up, not searched for, so many islands and definitions read in
    // linear time.
    const byStart = [...islands].sort((a, b) => a.range[0] - b.range[0]);
    const inIsland = (from: number, to: number) => {
      let lo = 0;
      let hi = byStart.length - 1;
      let hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (byStart[mid].range[0] <= from) {
          hit = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return hit >= 0 && to <= byStart[hit].range[1];
    };
    const normalize = md.utils.normalizeReference;
    const labelsIn = (text: string) => [...text.matchAll(/\[((?:[^[\]\\]|\\.)+)\]/g)].map((m) => normalize(m[1]));
    const noteUser = new Map<string, PMNode>();
    const linkUser = new Map<string, PMNode>();
    for (const { node } of islands) {
      const text = node.textContent;
      for (const m of text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) if (!noteUser.has(m[1])) noteUser.set(m[1], node);
      if (linkDefs.length) for (const label of labelsIn(text)) if (!linkUser.has(label)) linkUser.set(label, node);
    }
    const defText = (from: number, to: number) => {
      const prefix = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(lines[from])![0];
      return lines
        .slice(from, to)
        .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l.replace(/^(?:[ \t]*>)+[ \t]?/, '')))
        .join('\n')
        .replace(/\s+$/, '');
    };
    const carry = (user: PMNode | undefined, from: number, to: number) => {
      if (user) carried.set(user, [...(carried.get(user) ?? []), defText(from, to)]);
      return !!user;
    };
    const dropped: string[] = [];
    let kept = 0;
    const printed = new Set(printedNotes);
    for (const [label, [a, b]] of noteDefs) {
      if (printed.has(label)) continue;
      // The definition's own line (its text may start on the next one).
      let from = origLine[a];
      for (let back = 0; back < 2 && from > 0 && !lines[from].includes(`[^${label}]:`); back++) from--;
      if (!lines[from].includes(`[^${label}]:`)) from = origLine[a];
      const to = origLine[b] ?? lines.length;
      if (inIsland(from, to)) continue;
      if (carry(noteUser.get(label), from, to)) kept++;
      else dropped.push(`[^${label}]`);
    }
    if (linkDefs.length) {
      const defLines = new Set<number>();
      for (const d of linkDefs) for (let l = origLine[d.map[0]]; l < (origLine[d.map[1]] ?? lines.length); l++) defLines.add(l);
      const used = new Set(lines.flatMap((l, n) => (defLines.has(n) ? [] : labelsIn(l))));
      for (const d of linkDefs) {
        const from = origLine[d.map[0]];
        const to = origLine[d.map[1]] ?? lines.length;
        if (inIsland(from, to)) continue;
        if (carry(linkUser.get(d.label), from, to)) kept++;
        else if (!used.has(d.label)) dropped.push(/^(?:[ \t]*>)*[ \t]*(\[(?:[^[\]\\]|\\.)+\])/.exec(lines[from])?.[1] ?? lines[from].trim());
      }
    }
    if (kept) warnings.push(`${kept} footnote or link definition(s) that only content kept as source uses moved next to it`);
    if (dropped.length) warnings.push(`${dropped.join(', ')}: defined but used nowhere, so never printed — dropped`);
    const rebuild = (node: PMNode): PMNode => {
      const defs = carried.get(node);
      if (defs) {
        // The definitions follow the island, so it can no longer sit
        // directly against the block after it.
        const tight = node.attrs.tight === 'both' ? 'before' : node.attrs.tight === 'after' ? '' : node.attrs.tight;
        return node.type.create({ ...node.attrs, tight }, schema.text([node.textContent, ...defs].filter(Boolean).join('\n\n')));
      }
      if (node.isLeaf || node.isTextblock) return node;
      let changed = false;
      const kids: PMNode[] = [];
      node.forEach((k) => {
        const r = rebuild(k);
        changed ||= r !== k;
        kids.push(r);
      });
      return changed ? node.copy(Fragment.from(kids)) : node;
    };
    if (carried.size) body = body.map(rebuild);
  }

  const front: PMNode[] = [];
  if (title) front.push(schema.nodes.doc_title.create(null, [schema.text(title)]));
  if (authors) front.push(schema.nodes.doc_authors.create(null, [schema.text(authors)]));
  if (date) front.push(schema.nodes.doc_date.create(null, [schema.text(date)]));

  const blocks = [...front, ...body];
  if (!blocks.length) blocks.push(paragraph.create());
  const doc = schema.nodes.doc.create({ settings, bib, frontmatter }, blocks);
  return { doc, warnings };
}

/** Grid shares as the model holds them: each divided by the smallest and
 *  rounded to 3 decimals, so `60/40` is `[1.5, 1]` and `33.333%/66.667%`
 *  is `[1, 2]` (ratio-equivalent shares lay out identically). */
function canonicalShares(shares: number[]): number[] {
  const min = Math.min(...shares);
  return shares.map((s) => Math.round((s / min) * 1000) / 1000);
}
