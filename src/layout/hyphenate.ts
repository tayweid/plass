// Hyphenation via Liang's algorithm (the same patterns TeX uses), through hypher.
import Hypher from 'hypher';
import english from 'hyphenation.en-us';

const h = new Hypher(english);
const cache = new Map<string, string[]>();

function hyphenateCore(word: string): string[] {
  let parts = cache.get(word);
  if (!parts) {
    parts = h.hyphenate(word);
    if (cache.size > 20000) cache.clear();
    cache.set(word, parts);
  }
  return parts;
}

/**
 * Split a word token into breakable parts (parts always tile the token).
 * Existing hyphens are break points (a part ending in '-'; no glyph needs to
 * be added there). Leading/trailing punctuation stays attached to the first/
 * last syllable; tokens with anything else non-alphabetic inside stay whole.
 */
export function syllabify(token: string): string[] {
  if (token.length < 5) return [token];
  const segs = token.split(/(?<=[-–—])/); // keep the dash attached to the left part
  const out: string[] = [];
  for (const seg of segs) {
    const m = /^([^a-zA-Z]*)([a-zA-Z]+)([^a-zA-Z]*[-–—]?)$/.exec(seg);
    if (!m || m[2].length < 5) {
      out.push(seg);
      continue;
    }
    const parts = hyphenateCore(m[2]);
    for (let i = 0; i < parts.length; i++) {
      let p = parts[i];
      if (i === 0) p = m[1] + p;
      if (i === parts.length - 1) p = p + m[3];
      out.push(p);
    }
  }
  return out.length ? out : [token];
}