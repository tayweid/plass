// Pandoc fenced divs for markdown-it: `::: solution` … `:::`.
//
// A block rule that reads pandoc 3.4's fenced divs and emits `div_open` /
// `div_close` tokens around the div's content, which markdown-it tokenizes
// as usual. `div_open.meta` (DivMeta) carries the parsed attributes and
// two flags the reader turns into warnings; `div_open.map` is the source
// line range from the opener to the closer inclusive, `div_close.map` the
// closer's line (null when the div was closed implicitly). The md reader
// decides what a class means; this module only finds the divs.
//
// The syntax, as pandoc 3.4 reads it (src/md-divs.test.ts pins each case):
//
//   - An opener is three or more colons at the container's own column (no
//     indentation), optional spaces, then either an attribute block
//     (md-attrs.ts; it may continue over the following lines to its
//     closing `}`) or one bare word, taken verbatim as the one class
//     (`::: solution`), then optional spaces and colons to the end of the
//     line. Anything else on the line makes it ordinary text. When the
//     block fails to parse, the bare word is tried instead (`::: {.a`
//     followed by a blank line is the class `{.a`).
//   - A closer is three or more colons alone on a line, at the column of
//     the div it closes. It closes the innermost open div whose content it
//     sits in directly; inside a quote or list item within the div it is
//     text there (it does end the paragraph, table or list around it, as
//     pandoc's closers do). Outside every div it is text.
//   - Divs nest by depth. Content is tokenized by markdown-it, so a `:::`
//     line inside a fenced code block or an HTML block is never a fence:
//     the fence or the block consumes it. (An HTML block other than a
//     comment runs to the next blank line, markdown-it's rule and the one
//     md-parser's math pre-pass uses; pandoc parses Markdown inside an
//     HTML element, so `</div>` directly followed by `:::` closes the div
//     there and not here.)
//   - A div that is never closed ends with its container — the end of the
//     document, or of the quote or list item it opened in — as pandoc 3.4
//     closes it ("closing implicitly", with a warning). Nothing is lost:
//     the content is the div's. `meta.unclosed` records it. A closer must
//     sit in its opener's container (`> :::` for a div opened in a quote);
//     pandoc's lazy continuation also accepts an unprefixed one there,
//     which here is the quote paragraph's text.
//   - Past markdown-it's nesting limit (maxNesting, 100 levels), where it
//     would skip content, an opener stays text.
//   - Pandoc reads an opener on the line directly after paragraph text as
//     more of that paragraph. This rule accepts it (a hand-written file
//     means a div there) and records it in `meta.glued`, so the reader can
//     warn; the writer always puts a blank line before `:::`, so the first
//     save makes the file read the same in both.
//
// Registration follows markdown-it-container: before `table`, and in the
// `paragraph`, `reference`, `blockquote` and `list` terminator chains, so
// a `:::` line ends a paragraph, a pipe table (whose rows consult the
// blockquote chain), a quote's or list item's lazy continuation, and a
// reference definition. Without the chains a closer right after a table
// row is swallowed as one more row.

import type { MarkdownIt, StateBlock } from 'markdown-it';
import { readAttrBlock, type PandocAttrs } from './md-attrs';

export type DivMeta = {
  attrs: PandocAttrs;
  /** The opener follows a paragraph line with no blank line between, so
   *  pandoc reads it (and the div) as paragraph text. */
  glued: boolean;
  /** No closer before the end of the container; the div ends there. */
  unclosed: boolean;
};

interface Frame {
  /** `state.level` of the div's own content. */
  level: number;
  /** The closer's line, once the div's content reaches it. */
  close: number;
}

const COLON = 0x3a;
// An attribute block runs to its `}` but never past a blank line; this
// caps how far a malformed one is chased (no real block is this long).
const MAX_ATTR_LINES = 32;

const openFrames = new WeakMap<StateBlock, Frame[]>();

/** Index after the run of three or more colons at `pos`, or -1. */
function colonsEnd(state: StateBlock, pos: number): number {
  const end = state.skipChars(pos, COLON);
  return end - pos >= 3 ? end : -1;
}

/** Spaces, colons, spaces, end of line: what may follow an opener's
 *  attributes. */
function onlyTrailer(text: string): boolean {
  return /^[ \t]*:*[ \t]*$/.test(text);
}

function isCloser(state: StateBlock, line: number): boolean {
  const pos = state.bMarks[line] + state.tShift[line];
  const max = state.eMarks[line];
  const end = colonsEnd(state, pos);
  return end >= 0 && state.skipSpaces(end) >= max;
}

interface Opener {
  attrs: PandocAttrs;
  /** The line after the opener (its attribute block may span lines). */
  next: number;
  markup: string;
  info: string;
}

function readOpener(state: StateBlock, line: number, endLine: number): Opener | null {
  const pos = state.bMarks[line] + state.tShift[line];
  const max = state.eMarks[line];
  const colons = colonsEnd(state, pos);
  if (colons < 0) return null;
  const start = state.skipSpaces(colons);
  if (start >= max) return null; // a bare `:::` is a closer
  const markup = state.src.slice(pos, colons);
  const first = state.src.slice(start, max);

  if (first.startsWith('{')) {
    // The block may continue over the following lines of this container
    // (relative to its indentation), up to a blank or outdented line.
    let text = first;
    const lineStarts = [0];
    for (let l = line + 1; l < endLine && l <= line + MAX_ATTR_LINES; l++) {
      if (state.isEmpty(l) || state.sCount[l] < state.blkIndent) break;
      text += '\n';
      lineStarts.push(text.length);
      text += state.getLines(l, l + 1, state.blkIndent, false);
    }
    const block = readAttrBlock(text, 0);
    if (block) {
      let last = 0;
      while (last + 1 < lineStarts.length && lineStarts[last + 1] <= block.end) last++;
      const lineEnd = last + 1 < lineStarts.length ? lineStarts[last + 1] - 1 : text.length;
      // A block followed by anything but colons is no opener; pandoc does
      // not fall back to the bare word once a block has parsed.
      if (!onlyTrailer(text.slice(block.end, lineEnd))) return null;
      return { attrs: block.attrs, next: line + last + 1, markup, info: text.slice(0, block.end) };
    }
  }

  const word = /^[^ \t]+/.exec(first)![0];
  if (!onlyTrailer(first.slice(word.length))) return null;
  return { attrs: { id: '', classes: [word], kvs: [] }, next: line + 1, markup, info: word };
}

/** Whether the opener at `line` directly follows a paragraph line: the
 *  last block closed before it (through any quote or list it ended) is a
 *  paragraph whose lines run up to the opener. */
function followsParagraph(state: StateBlock, line: number): boolean {
  for (let i = state.tokens.length - 1; i >= 0; i--) {
    const t = state.tokens[i];
    if (t.type === 'paragraph_close') {
      const open = state.tokens[i - 2];
      return open?.type === 'paragraph_open' && open.map?.[1] === line;
    }
    if (t.nesting !== -1) return false;
  }
  return false;
}

function div(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  // Pandoc's fences sit at the container's column. A silent call may ask
  // about an outdented line (a lazy-continuation candidate): that is the
  // container's column too, as far as ending the lazy paragraph goes.
  if (state.sCount[startLine] > state.blkIndent) return false;
  if (state.src.charCodeAt(state.bMarks[startLine] + state.tShift[startLine]) !== COLON) return false;

  const frames = openFrames.get(state);
  if (isCloser(state, startLine)) {
    if (!frames?.length) return false; // a stray closer is text
    if (silent) return true;
    const top = frames[frames.length - 1];
    // Inside a quote or list item within the div, the closer is that
    // block's text (pandoc); only the div's own content level closes it.
    if (top.level !== state.level) return false;
    top.close = startLine;
    // End the div's own tokenize loop; the opener resumes after the closer.
    state.line = endLine;
    return true;
  }

  // markdown-it skips whatever sits deeper than maxNesting; an opener there
  // stays text instead, so nothing is dropped.
  if (state.level + 1 >= state.md.options.maxNesting) return false;
  const opener = readOpener(state, startLine, endLine);
  if (!opener) return false;
  if (silent) return true;

  const meta: DivMeta = { attrs: opener.attrs, glued: followsParagraph(state, startLine), unclosed: false };
  const open = state.push('div_open', 'div', 1);
  open.markup = opener.markup;
  open.info = opener.info;
  open.meta = meta;
  const range: [number, number] = [startLine, 0];
  open.map = range;

  const frame: Frame = { level: state.level, close: -1 };
  const stack = frames ?? [];
  openFrames.set(state, stack);
  stack.push(frame);
  const oldParentType = state.parentType;
  state.parentType = 'div';
  state.md.block.tokenize(state, opener.next, endLine);
  state.parentType = oldParentType;
  stack.pop();

  const close = state.push('div_close', 'div', -1);
  if (frame.close >= 0) {
    const pos = state.bMarks[frame.close] + state.tShift[frame.close];
    close.markup = state.src.slice(pos, state.skipChars(pos, COLON));
    close.map = [frame.close, frame.close + 1];
    state.line = frame.close + 1;
  } else {
    meta.unclosed = true;
    state.line = Math.max(state.line, opener.next);
  }
  range[1] = state.line;
  return true;
}

/** The markdown-it plugin: `md.use(fencedDivs)`. */
export function fencedDivs(md: MarkdownIt): void {
  md.block.ruler.before('table', 'div', div, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
}
