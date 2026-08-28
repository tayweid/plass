import type { Node as PMNode } from 'prosemirror-model';

/**
 * The editable page can crop ordinary in-flow Typst, but it cannot honestly
 * reproduce code that changes the environment of later native nodes or
 * paints outside its own flow interval. Those programs remain executable and
 * byte-for-byte exact in Proof/PDF; the editor simply declines to call its
 * mixed native surface exact.
 */
export type TypstEmbedPolicy =
  | { mode: 'bounded' }
  | { mode: 'proof'; reason: string };

const PROOF_ONLY_WORDS = new Map<string, string>([
  ['set', 'a document style rule'],
  ['show', 'a document show rule'],
  ['include', 'included document content'],
  ['eval', 'dynamically evaluated Typst'],
  ['place', 'out-of-flow placement'],
  ['move', 'out-of-flow movement'],
  ['pagebreak', 'an explicit page break'],
  ['colbreak', 'an explicit column break'],
]);

const PROOF_ONLY_METHODS = new Map<string, string>([
  ['update', 'a state or counter update'],
  ['step', 'a counter update'],
]);

function skipQuoted(source: string, from: number, quote: '"' | '`'): number {
  let index = from + 1;
  while (index < source.length) {
    if (quote === '"' && source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index++;
  }
  return -1;
}

function skipBlockComment(source: string, from: number): number {
  let depth = 1;
  let index = from + 2;
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
  return depth ? -1 : index;
}

/** Conservative lexical boundary. Strings and comments are data; executable
 * hash words and mutating method calls are code. Malformed trivia fails to
 * Proof-only instead of accidentally certifying an ambiguous program. */
export function classifyTypstEmbed(source: string): TypstEmbedPolicy {
  let index = 0;
  while (index < source.length) {
    if (source[index] === '"' || source[index] === '`') {
      const after = skipQuoted(source, index, source[index] as '"' | '`');
      if (after < 0) return { mode: 'proof', reason: 'an unterminated string' };
      index = after;
      continue;
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const after = skipBlockComment(source, index);
      if (after < 0) return { mode: 'proof', reason: 'an unterminated comment' };
      index = after;
      continue;
    }
    if (source[index] === '#') {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(index + 1));
      const reason = match ? PROOF_ONLY_WORDS.get(match[0]) : undefined;
      if (reason) return { mode: 'proof', reason };
    }
    if (source[index] === '.') {
      const match = /^\.([A-Za-z_][A-Za-z0-9_-]*)\s*\(/.exec(source.slice(index));
      const reason = match ? PROOF_ONLY_METHODS.get(match[1]) : undefined;
      if (reason) return { mode: 'proof', reason };
    }
    index++;
  }
  return { mode: 'bounded' };
}

/** First reason the native surface cannot claim exact page/line geometry. */
export function typstEmbedLayoutBlocker(doc: PMNode): string | null {
  let blocker: string | null = null;
  doc.descendants((node) => {
    if (blocker || node.type.name !== 'typst_embed') return !blocker;
    const policy = classifyTypstEmbed(node.textContent);
    if (policy.mode === 'proof') blocker = `Typst embed uses ${policy.reason}`;
    return !blocker;
  });
  return blocker;
}
