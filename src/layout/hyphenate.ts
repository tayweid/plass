// Hyphenation via Liang's algorithm (the same patterns TeX uses), through hypher.
import Hypher from 'hypher';
import english from 'hyphenation.en-us';

const h = new Hypher(english);
const cache = new Map<string, string[]>();

/**
 * Split a word token into breakable parts. Tokens that contain anything but
 * letters (punctuation, digits, mixed scripts) are left whole — punctuation
 * stays attached to its word and never hyphenates, which is the conservative
 * choice.
 */
export function syllabify(token: string): string[] {
  if (token.length < 5 || !/^[a-zA-Z]+$/.test(token)) return [token];
  let parts = cache.get(token);
  if (!parts) {
    parts = h.hyphenate(token);
    if (cache.size > 20000) cache.clear();
    cache.set(token, parts);
  }
  return parts;
}
