// Pandoc attribute blocks — `{#id .class key=val key="val"}` — read and
// written by pandoc 3.4's grammar, and the bare-class form of a fence
// (`::: solution`). Shared by fenced divs (md-divs.ts), headings
// (`# Title {#sec:x}`), images (`![Cap](f.svg){#fig:x width=60%}`) and
// display math (`$$ … $$ {#eq:x}`).
//
// The grammar as pandoc 3.4 reads it (each rule was run against the
// binary, and src/md-divs.test.ts pins the results):
//
//   - `{`, then attributes separated by optional spaces and at most one
//     line break, then `}`. A blank line anywhere fails the whole block.
//   - `#id`: one or more letters, digits, `-`, `_`, `:` or `.`, in any
//     order (`#1a`, `#-x`, `#eq:a.b` are ids). The last id wins.
//   - `.class`: an identifier — a letter, then letters, digits, `-_:.`.
//     `.2x` and `._x` fail the block. Duplicates are kept.
//   - `-` alone is the class `unnumbered` (`{-}` on a heading).
//   - `key=value`, the key an identifier. `id=` sets the id; `class=` adds
//     its whitespace-separated words as classes; every other pair is kept
//     in order, duplicates included. The value is either
//       quoted, "…" or '…': the character after the opening quote may not
//         be whitespace; `\` before a character that is not a letter or
//         digit escapes it; HTML character references are decoded; a line
//         break reads as a space; a quote that never closes is not a
//         quoted value, and the bare form takes over from the quote; or
//       bare: everything up to whitespace or `}`, with the same `\`
//         escapes and no character references. It may be empty (`k=`).
//     Attributes need no space between them (`{.a#b}`, `{k="x".a}`), so
//     text glued to a quoted value must itself be an attribute: `k="x"y`
//     fails the block.
//
// The writer emits the canonical form of the same grammar: the id, then
// the classes, then the pairs; a value bare when it is plainly safe,
// otherwise double-quoted with `\` escapes. What it writes reads back as
// the same attributes, in pandoc and here (a line break in a value is
// written as the space it reads back as).

import MarkdownIt from 'markdown-it';

export type PandocAttrs = {
  /** `#id` or `id=`; '' when there is none. */
  id: string;
  /** `.class`, `class="a b"` and `-` (→ `unnumbered`), in order. */
  classes: string[];
  /** Every other `key=value`, in order, duplicates kept. */
  kvs: Array<[string, string]>;
};

const LETTER = /\p{L}/u;
const ALNUM = /[\p{L}\p{N}]/u;
const IDENTIFIER = /^\p{L}[\p{L}\p{N}_:.-]*$/u;
const ID = /^[\p{L}\p{N}_:.-]+$/u;
// Values written without quotes: a conservative set (letters, digits and
// `_:.%+/,#-`; no quote, brace, backslash, ampersand or space), so `1em`,
// `60%` and `r0:gray-dark` stay bare and anything else is quoted.
const BARE_VALUE = /^[\p{L}\p{N}_:.%+/,#-]+$/u;
const ENTITY = /^&[a-z#][a-z0-9]{1,31};/i;

let unescapeAll: ((s: string) => string) | null = null;

/** Decode one HTML character reference (`&amp;`, `&#65;`, `&#x42;`), or
 *  return it unchanged when it names nothing — pandoc's rule, through
 *  markdown-it's own decoder. */
function decodeReference(ref: string): string {
  unescapeAll ??= new MarkdownIt('zero').utils.unescapeAll;
  return unescapeAll(ref);
}

/** The code point at `i`, as a string (one or two code units). */
function charAt(src: string, i: number): string {
  const cp = src.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

function isSpaceChar(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

/** `\` + a character that is not a letter or digit: that character. */
function escapeAt(src: string, i: number): { ch: string; end: number } | null {
  const ch = charAt(src, i + 1);
  if (!ch || ch === '\n' || ALNUM.test(ch)) return null;
  return { ch, end: i + 1 + ch.length };
}

/** Pandoc's `spnl`: spaces, at most one line break, spaces — and never a
 *  blank line. Returns the index after it, or -1 on a blank line. */
function spnl(src: string, i: number): number {
  while (isSpaceChar(src[i])) i++;
  if (src[i] === '\n') {
    i++;
    while (isSpaceChar(src[i])) i++;
  }
  return src[i] === '\n' ? -1 : i;
}

/** End of an identifier starting at `i` (a letter, then letters, digits,
 *  `-_:.`), or -1 when there is none. */
function scanIdentifier(src: string, i: number): number {
  const first = charAt(src, i);
  if (!first || !LETTER.test(first)) return -1;
  i += first.length;
  for (let ch = charAt(src, i); ch && (ALNUM.test(ch) || '-_:.'.includes(ch)); ch = charAt(src, i)) i += ch.length;
  return i;
}

function readQuoted(src: string, i: number): { value: string; end: number } | null {
  const quote = src[i];
  const first = src[i + 1];
  if (first === undefined || first === ' ' || first === '\t' || first === '\n') return null;
  let value = '';
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === quote) return { value, end: j + 1 };
    if (ch === '\\') {
      const e = escapeAt(src, j);
      if (e) {
        value += e.ch;
        j = e.end;
        continue;
      }
    }
    if (ch === '&') {
      const ref = ENTITY.exec(src.slice(j, j + 34));
      if (ref) {
        value += decodeReference(ref[0]);
        j += ref[0].length;
        continue;
      }
    }
    if (ch === '\n') {
      let k = j + 1;
      while (isSpaceChar(src[k])) k++;
      if (src[k] === '\n') return null;
      value += ' ';
      j++;
      continue;
    }
    value += ch;
    j++;
  }
  return null;
}

function readBare(src: string, i: number): { value: string; end: number } {
  let value = '';
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '}') break;
    if (ch === '\\') {
      const e = escapeAt(src, j);
      if (e) {
        value += e.ch;
        j = e.end;
        continue;
      }
    }
    value += ch;
    j++;
  }
  return { value, end: j };
}

/** One attribute at `i`, applied to `attrs`. Returns the index after it,
 *  or -1 when there is no attribute there. */
function readAttribute(src: string, i: number, attrs: PandocAttrs): number {
  const c = src[i];
  if (c === '#') {
    let j = i + 1;
    for (let ch = charAt(src, j); ch && (ALNUM.test(ch) || '-_:.'.includes(ch)); ch = charAt(src, j)) j += ch.length;
    if (j === i + 1) return -1;
    attrs.id = src.slice(i + 1, j);
    return j;
  }
  if (c === '.') {
    const j = scanIdentifier(src, i + 1);
    if (j < 0) return -1;
    attrs.classes.push(src.slice(i + 1, j));
    return j;
  }
  if (c === '-') {
    attrs.classes.push('unnumbered');
    return i + 1;
  }
  const k = scanIdentifier(src, i);
  if (k < 0 || src[k] !== '=') return -1;
  const key = src.slice(i, k);
  const q = src[k + 1];
  const v = ((q === '"' || q === "'") && readQuoted(src, k + 1)) || readBare(src, k + 1);
  if (key === 'id') attrs.id = v.value;
  else if (key === 'class') attrs.classes.push(...v.value.split(/\s+/u).filter(Boolean));
  else attrs.kvs.push([key, v.value]);
  return v.end;
}

/** Read the attribute block whose `{` is at `start`. Returns the
 *  attributes and the index just past the closing `}`, or null when the
 *  text there is not an attribute block. The block may run over lines
 *  (never across a blank one). */
export function readAttrBlock(src: string, start: number): { attrs: PandocAttrs; end: number } | null {
  if (src[start] !== '{') return null;
  const attrs: PandocAttrs = { id: '', classes: [], kvs: [] };
  let i = spnl(src, start + 1);
  while (i >= 0 && src[i] !== '}') {
    const next = readAttribute(src, i, attrs);
    if (next < 0) return null;
    i = spnl(src, next);
  }
  return i < 0 ? null : { attrs, end: i + 1 };
}

/** The attribute block that ends `text` (trailing spaces aside), as
 *  pandoc finds one on a heading line: the leftmost unescaped `{` whose
 *  block runs to the end. `start` is the index of its `{`; the text
 *  before it is the heading's. Null when the text ends in no block. */
export function readTrailingAttrBlock(text: string): { attrs: PandocAttrs; start: number } | null {
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    let slashes = 0;
    while (text[i - 1 - slashes] === '\\') slashes++;
    if (slashes % 2) continue;
    const block = readAttrBlock(text, i);
    if (block && /^[ \t]*$/.test(text.slice(block.end))) return { attrs: block.attrs, start: i };
  }
  return null;
}

function quoteValue(value: string): string {
  let body = value
    .replace(/[\\"]/g, '\\$&')
    // A literal `&amp;` would otherwise decode on the way back in.
    .replace(/&(?=[a-z#][a-z0-9]{1,31};)/gi, '\\&')
    // Pandoc expands a tab in the source to spaces; a reference does not.
    .replace(/\t/g, '&#9;')
    // A line break reads back as a space anyway (and two would end the
    // block): write the space.
    .replace(/\n/g, ' ');
  // Pandoc refuses a quoted value that opens with whitespace; an escaped
  // space is not whitespace to that check.
  if (body.startsWith(' ')) body = '\\' + body;
  return `"${body}"`;
}

/** Write attributes as a block: `{#id .a .b key=val key="two words"}`.
 *  Throws on what no attribute block can say: a key that is not an
 *  identifier (or is `id`/`class`, which pandoc reads as the id and the
 *  classes), and an empty class or one holding whitespace. */
export function writeAttrBlock(attrs: PandocAttrs): string {
  const parts: string[] = [];
  if (attrs.id) parts.push(ID.test(attrs.id) ? `#${attrs.id}` : `id=${quoteValue(attrs.id)}`);
  for (const c of attrs.classes) {
    if (IDENTIFIER.test(c)) parts.push(`.${c}`);
    else if (c && !/\s/u.test(c)) parts.push(`class=${quoteValue(c)}`);
    else throw new Error(`md-attrs: no attribute block can hold the class ${JSON.stringify(c)}`);
  }
  for (const [key, value] of attrs.kvs) {
    if (!IDENTIFIER.test(key) || key === 'id' || key === 'class') {
      throw new Error(`md-attrs: no attribute block can hold the key ${JSON.stringify(key)}`);
    }
    parts.push(`${key}=${BARE_VALUE.test(value) ? value : quoteValue(value)}`);
  }
  return `{${parts.join(' ')}}`;
}

/** What follows the colons of a div opener: the bare class when the
 *  attributes are exactly one identifier class (`solution`), otherwise
 *  the block (`{.columns gutter=1em cols=2}`). */
export function writeFenceAttrs(attrs: PandocAttrs): string {
  const only = attrs.classes[0];
  if (!attrs.id && !attrs.kvs.length && attrs.classes.length === 1 && IDENTIFIER.test(only)) return only;
  return writeAttrBlock(attrs);
}
