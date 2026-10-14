// Typst's smart quotes, mirrored so the document holds the printed glyph.
//
// Typst reads every unescaped `'` and `"` in markup as a SmartQuote and
// decides, per paragraph, whether it prints an opening, a closing, an
// apostrophe, or a prime (vendor/typst/crates/typst-library/src/text/
// smartquote.rs, `SmartQuoter::quote`, and typst-layout/src/inline/
// collect.rs for what "the character before" is). Doctrine: document text
// equals printed text, so the importers and the edit-time normalizer apply
// the same decision and store the glyph — exactly as they do for dashes.
// A straight quote that must print straight is escaped on export (`\"`).
//
// English quotes only: the document has no language setting yet, and
// Typst's default is the English set.

import type { Node as PMNode } from 'prosemirror-model';

/** Typst's stand-in for an inline object (an equation, a box) in the text
 *  the quoter looks back over: `is_alphabetic` is false for it but the
 *  apostrophe rule accepts it explicitly. */
export const OBJECT = '￼';

/** The stack of open quotes: a bit per level, 1 = double. */
export interface QuoteState {
  depth: number;
  kinds: number;
}

export function createQuoteState(): QuoteState {
  return { depth: 0, kinds: 0 };
}

const OPEN = { single: '‘', double: '“' } as const;
const CLOSE = { single: '’', double: '”' } as const;
const PRIME = { single: '′', double: '″' } as const;

const isNumeric = (c: string) => /\p{N}/u.test(c);
const isAlphabetic = (c: string) => /\p{Alphabetic}/u.test(c);
const isWhitespace = (c: string) => /\s/u.test(c);
const isOpeningBracket = (c: string) => c === '(' || c === '{' || c === '[';
/** `is_default_ignorable`: the quoter looks past zero-width joiners,
 *  soft hyphens and their kin to the last visible character. */
const isIgnorable = (c: string) => /\p{Default_Ignorable_Code_Point}/u.test(c);

function top(state: QuoteState): boolean | null {
  return state.depth > 0 ? ((state.kinds >> (state.depth - 1)) & 1) === 1 : null;
}

function push(state: QuoteState, double: boolean) {
  if (state.depth < 32) {
    if (double) state.kinds |= 1 << state.depth;
    state.depth++;
  }
}

function pop(state: QuoteState) {
  state.depth--;
  state.kinds &= (1 << state.depth) - 1;
}

/** Typst's `SmartQuoter::quote`: the glyph for a straight quote given the
 *  last visible character before it (`null` at the paragraph start). */
export function smartQuote(state: QuoteState, before: string | null, double: boolean): string {
  const opened = top(state);
  const b = before ?? ' ';
  // After a number, and not right after opening a quote of this kind:
  // a prime (5'11").
  if (isNumeric(b) && opened !== double) return double ? PRIME.double : PRIME.single;
  // A single quote after a letter (or an object) with no single quotation
  // open: an apostrophe.
  if (!double && opened !== false && (isAlphabetic(b) || b === OBJECT)) return CLOSE.single;
  // The innermost open quotation is of this kind and the previous
  // character does not start a nested one: close it.
  if (opened === double && !isWhitespace(b) && !isOpeningBracket(b)) {
    pop(state);
    return double ? CLOSE.double : CLOSE.single;
  }
  push(state, double);
  return double ? OPEN.double : OPEN.single;
}

/** An already-curly glyph in the text feeds the stack the way the straight
 *  quote that produced it did, so a closing quote typed after an opening
 *  one that has already been normalized still closes. Typst itself never
 *  sees these (they are plain text to it), which is fine: once every
 *  straight quote is a glyph, the print is the text. */
export function feedGlyph(state: QuoteState, glyph: string) {
  if (glyph === OPEN.single) push(state, false);
  else if (glyph === OPEN.double) push(state, true);
  else if (glyph === CLOSE.double && top(state) === true) pop(state);
  // A ’ with a single quotation open closes it — Typst's own quoter makes
  // the same call for a straight quote there (the apostrophe rule yields
  // to an open single quotation); with none open it is an apostrophe.
  else if (glyph === CLOSE.single && top(state) === false) pop(state);
}

/** What Typst's quoter sees as the character before a quote that follows
 *  this inline node: the printed text's last character for text, `\n` for
 *  a line break, the object stand-in for boxes and equations, and the
 *  printed marker's last character for references and citations. */
export function beforeAfterNode(node: PMNode, fallback: string | null): string | null {
  if (node.isText) return lastVisible(node.text ?? '', fallback);
  switch (node.type.name) {
    case 'hard_break':
      return '\n';
    case 'citation':
      return ']';
    case 'eq_ref':
      return ')';
    case 'typst_inline':
      return lastVisible(node.attrs.src as string, fallback);
    default:
      return OBJECT;
  }
}

/** Importers: the inline children of one paragraph, every straight quote
 *  in prose replaced by its glyph. Code-marked text prints verbatim (raw)
 *  and only contributes its last character to the context. */
export function smartenInline(children: PMNode[]): PMNode[] {
  const state = createQuoteState();
  let before: string | null = null;
  return children.map((child) => {
    if (!child.isText || !child.text || child.marks.some((m) => m.type.name === 'code')) {
      before = beforeAfterNode(child, before);
      return child;
    }
    const r = smartenText(child.text, state, before);
    before = r.before;
    return r.swaps.length ? child.type.schema.text(r.text, child.marks) : child;
  });
}

/** The last visible character of `text`, or `fallback` when it has none. */
export function lastVisible(text: string, fallback: string | null): string | null {
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (!isIgnorable(c)) return c;
  }
  return fallback;
}

export interface Smartened {
  text: string;
  /** Indexes in the INPUT text that changed, with their glyphs. */
  swaps: Array<{ index: number; glyph: string }>;
  before: string | null;
}

/** Replace every straight quote in `text` by Typst's glyph, threading the
 *  quote stack and the character before through curly glyphs and plain
 *  characters alike. `before` is the last visible character preceding
 *  this text in the same paragraph (`null` at its start). */
export function smartenText(text: string, state: QuoteState, before: string | null): Smartened {
  let out = '';
  const swaps: Array<{ index: number; glyph: string }> = [];
  let prev = before;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const glyph = smartQuote(state, prev, c === '"');
      out += glyph;
      swaps.push({ index: i, glyph });
      prev = glyph;
      continue;
    }
    if (c === OPEN.single || c === OPEN.double || c === CLOSE.single || c === CLOSE.double) feedGlyph(state, c);
    out += c;
    if (!isIgnorable(c)) prev = c;
  }
  return { text: out, swaps, before: prev };
}
