/**
 * Compile-only instrumentation for inline Typst atoms.
 *
 * A supported, intrinsically unbreakable inline atom is wrapped in a
 * transparent HTTPS link without adding an editor-only box. The SVG renderer places
 * the link rectangle in the exact layout box, which lets the editor crop that
 * atom from the shared whole-document publication without compiling a
 * synthetic fragment. The classifier is intentionally conservative: boxing
 * a naturally block-level or breakable expression would change the very
 * layout being measured. Normal .typ, Proof, and PDF serialization never
 * enable this wrapper.
 */
export const TYPST_INLINE_LINK_PREFIX = 'https://plass.invalid/.well-known/inline-atom/';

export type TypstInlineClassification =
  | { kind: 'fixed' }
  | { kind: 'flexible'; fraction: number }
  | { kind: 'unsupported'; reason: string };

const MAX_INLINE_SOURCE = 4_096;

// These constructs can mutate document state, escape inline flow, read the
// world, or create page/block semantics. Keeping the node lossless but inert
// in the editing surface is safer than changing their meaning with a box.
const FORBIDDEN_HASH_WORDS = new Set([
  'assert', 'bibliography', 'break', 'colbreak', 'columns', 'context',
  'continue', 'counter', 'eval', 'figure', 'for', 'grid', 'heading', 'hide',
  'if', 'import', 'include', 'let', 'locate', 'metadata', 'move', 'outline',
  'link', 'page', 'pagebreak', 'panic', 'place', 'query', 'read', 'return', 'rotate',
  'scale', 'set', 'show', 'state', 'table', 'v', 'while',
]);

function skipTrivia(source: string, from: number): number {
  let index = from;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index++;
      continue;
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      return newline < 0 ? source.length : skipTrivia(source, newline + 1);
    }
    if (source.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth) {
        if (source.startsWith('/*', index)) {
          depth++;
          index += 2;
        } else if (source.startsWith('*/', index)) {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      if (depth) return -1;
      continue;
    }
    break;
  }
  return index;
}

/** Return the first byte after one balanced (), [] or {} group. */
function balancedEnd(source: string, from: number): number {
  const closeFor: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const first = source[from];
  if (!(first in closeFor)) return -1;
  const stack = [closeFor[first]];
  let index = from + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      index++;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index++] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) return -1;
      continue;
    }
    if (char === '`') {
      const end = source.indexOf('`', index + 1);
      if (end < 0) return -1;
      index = end + 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const after = skipTrivia(source, index);
      if (after < 0) return -1;
      index = after;
      continue;
    }
    if (char in closeFor) {
      stack.push(closeFor[char]);
      index++;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      if (stack.pop() !== char) return -1;
      index++;
      if (!stack.length) return index;
      continue;
    }
    index++;
  }
  return -1;
}

/** Scan executable #words outside strings/raw/comments, fail-closed. */
function containsForbiddenConstruct(source: string): boolean {
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      index++;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index++] === '"') break;
      }
      continue;
    }
    if (char === '`') {
      const end = source.indexOf('`', index + 1);
      if (end < 0) return true;
      index = end + 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const after = skipTrivia(source, index);
      if (after < 0) return true;
      index = after;
      continue;
    }
    if (char === '#') {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(index + 1));
      if (match && FORBIDDEN_HASH_WORDS.has(match[0])) return true;
    }
    index++;
  }
  return false;
}

/** SVG getBBox deliberately excludes stroke/shadow expansion. Until the
 * publication protocol carries exact ink bounds including those effects,
 * do not certify a crop whose paint can exceed its recovered box. */
function containsUnboundedPaint(source: string): boolean {
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      index++;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index++] === '"') break;
      }
      continue;
    }
    if (char === '`') {
      const end = source.indexOf('`', index + 1);
      if (end < 0) return true;
      index = end + 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const after = skipTrivia(source, index);
      if (after < 0) return true;
      index = after;
      continue;
    }
    const named = /^(stroke|outset|shadow)\s*:/.exec(source.slice(index));
    if (named && (index === 0 || !/[A-Za-z0-9_-]/.test(source[index - 1]))) return true;
    index++;
  }
  return false;
}

function flexibleHorizontalSpace(source: string): number | null {
  const match = /^#h\s*\(\s*(\d+(?:\.\d+)?)\s*fr\s*\)$/.exec(source);
  if (!match) return null;
  const fraction = Number(match[1]);
  // The editor's forced-layout contract currently assigns equal shares to
  // flexible atoms. Supporting a numeric weight other than 1 would silently
  // change `1fr + 2fr` into equal columns, so keep that source lossless but
  // visibly unsupported until weighted fills are represented explicitly.
  return fraction === 1 ? fraction : null;
}

interface AtomicHashExpression {
  root: string;
  qualified: boolean;
  suffixes: number;
}

function atomicHashExpression(source: string): AtomicHashExpression | null {
  if (source[0] !== '#') return null;
  const identifier = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/.exec(source.slice(1));
  if (!identifier) return null;
  let index = 1 + identifier[0].length;
  let suffixes = 0;
  while (true) {
    index = skipTrivia(source, index);
    if (index < 0) return null;
    if (source[index] !== '(' && source[index] !== '[') break;
    index = balancedEnd(source, index);
    if (index < 0) return null;
    suffixes++;
  }
  index = skipTrivia(source, index);
  if (index !== source.length || (!identifier[0].includes('.') && suffixes === 0)) return null;
  return {
    root: identifier[0].split('.')[0],
    qualified: identifier[0].includes('.'),
    suffixes,
  };
}

function isAtomicMath(source: string): boolean {
  if (!source.startsWith('$') || !source.endsWith('$') || source.length < 2) return false;
  // Typst deliberately uses whitespace just inside the delimiters to switch
  // from inline to block math. An editor-only box would silently switch it
  // back, so only genuine inline math is eligible for a crop.
  if (/\s/.test(source[1]) || /\s/.test(source[source.length - 2])) return false;
  let escaped = false;
  for (let index = 1; index < source.length - 1; index++) {
    const char = source[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '$') {
      return false;
    }
  }
  return !escaped;
}

/** Conservative visual-support boundary; unsupported source is never lost. */
export function classifyTypstInline(raw: string): TypstInlineClassification {
  const source = raw.trim();
  if (!source) return { kind: 'unsupported', reason: 'empty source' };
  if (source.length > MAX_INLINE_SOURCE) return { kind: 'unsupported', reason: 'source is too large for an inline atom' };
  const fraction = flexibleHorizontalSpace(source);
  if (fraction !== null) return { kind: 'flexible', fraction };
  if (/\b\d+(?:\.\d+)?\s*fr\b/.test(source)) {
    return { kind: 'unsupported', reason: 'context-dependent fractional layout' };
  }
  if (containsForbiddenConstruct(source)) {
    return { kind: 'unsupported', reason: 'document-level or stateful Typst' };
  }
  if (containsUnboundedPaint(source)) {
    return { kind: 'unsupported', reason: 'paint can exceed the recoverable inline crop' };
  }
  if (isAtomicMath(source)) return { kind: 'fixed' };
  const expression = atomicHashExpression(source);
  if (expression) {
    // These qualified namespaces are content constants (single glyphs), not
    // arbitrary method chains. They are already indivisible in normal Typst.
    if (expression.suffixes === 0 && expression.qualified &&
        (expression.root === 'sym' || expression.root === 'emoji')) {
      return { kind: 'fixed' };
    }
    // An explicit box is already an unbreakable inline object. Percent
    // sizing is excluded because adding an auto-sized parent changes the
    // containing block can still depend on surrounding document geometry.
    if (expression.root === 'box' && expression.suffixes > 0 && !/%/.test(source)) {
      return { kind: 'fixed' };
    }
    // Absolute/relative-to-font horizontal space is intrinsically inline.
    // Fractional space was handled above and receives compiled line slack.
    if (expression.root === 'h' && expression.suffixes > 0 && !/%/.test(source)) {
      return { kind: 'fixed' };
    }
    return { kind: 'unsupported', reason: 'expression is not guaranteed to preserve inline layout' };
  }
  return { kind: 'unsupported', reason: 'not one balanced inline expression' };
}

export function typstInlineLink(index: number): string {
  return `${TYPST_INLINE_LINK_PREFIX}${index}`;
}

export function typstInlineIndexFromLink(value: string): number | null {
  if (!value.startsWith(TYPST_INLINE_LINK_PREFIX)) return null;
  const suffix = value.slice(TYPST_INLINE_LINK_PREFIX.length);
  return /^(?:0|[1-9]\d*)$/.test(suffix) && Number.isSafeInteger(Number(suffix))
    ? Number(suffix)
    : null;
}
