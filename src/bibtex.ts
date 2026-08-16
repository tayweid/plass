// A pragmatic BibTeX parser: enough to list, search, and format entries in
// the editor. The PDF path never depends on this — Typst's own bibliography
// engine consumes the raw .bib content.

import { INPUT_LIMITS, textSizeError } from './input-limits';

export interface BibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
}

/** Citation keys safe in Plass UI, reference syntax, and Typst output. */
export const PORTABLE_CITATION_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export function isPortableCitationKey(key: string): boolean {
  return PORTABLE_CITATION_KEY.test(key);
}

const ACCENTS: Record<string, Record<string, string>> = {
  '"': { a: 'ä', o: 'ö', u: 'ü', e: 'ë', i: 'ï', A: 'Ä', O: 'Ö', U: 'Ü' },
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', E: 'É' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', N: 'Ñ' },
  c: { c: 'ç', C: 'Ç' },
  v: { c: 'č', s: 'š', z: 'ž', C: 'Č', S: 'Š', Z: 'Ž' },
  o: { '': 'ø' },
};

/** Strip braces/TeX-isms from a field value for display. */
function clean(value: string): string {
  return (
    value
      // accents: \"a, \'{e}, {\"a}, \v{c}, …
      .replace(/\\(["'`^~])\s*\{?([a-zA-Z])\}?/g, (_, acc: string, ch: string) => ACCENTS[acc]?.[ch] ?? ch)
      .replace(/\\([cv])\s*\{([a-zA-Z])\}/g, (_, acc: string, ch: string) => ACCENTS[acc]?.[ch] ?? ch)
      // text macros whose name IS the text (\TeX, \LaTeX)
      .replace(/\\(TeX|LaTeX)\b/g, '$1')
      // escaped specials
      .replace(/\\([&%$#_])/g, '$1')
      // remaining commands: drop the backslash-name, keep any argument
      .replace(/\\[a-zA-Z]+\s*/g, '')
      .replace(/[{}]/g, '')
      .replace(/~/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  const n = body.length;
  while (i < n) {
    // field name
    while (i < n && !/[a-zA-Z]/.test(body[i])) i++;
    let name = '';
    while (i < n && /[a-zA-Z_-]/.test(body[i])) name += body[i++];
    while (i < n && body[i] !== '=') i++;
    i++; // '='
    while (i < n && /\s/.test(body[i])) i++;
    if (!name || i >= n) break;
    // value: {...} | "..." | bare
    let value = '';
    if (body[i] === '{') {
      let depth = 1;
      i++;
      const start = i;
      while (i < n && depth > 0) {
        if (body[i] === '{') depth++;
        else if (body[i] === '}') depth--;
        if (depth > 0) i++;
      }
      value = body.slice(start, i);
      i++;
    } else if (body[i] === '"') {
      i++;
      const start = i;
      while (i < n && body[i] !== '"') i++;
      value = body.slice(start, i);
      i++;
    } else {
      const start = i;
      while (i < n && body[i] !== ',') i++;
      value = body.slice(start, i);
    }
    fields[name.toLowerCase()] = clean(value);
    while (i < n && body[i] !== ',') i++;
    i++;
  }
  return fields;
}

export function parseBibTeX(src: string): BibEntry[] {
  // All UI import paths report this limit before calling the parser. Keep a
  // fail-closed guard here too because bibliography text can also arrive
  // inside a hand-written document or restored browser state.
  if (textSizeError(src, INPUT_LIMITS.bibliographyBytes, 'Bibliography')) return [];
  const entries: BibEntry[] = [];
  const re = /@(\w+)\s*\{\s*([^,\s{}]+)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const type = m[1].toLowerCase();
    if (type === 'comment' || type === 'preamble' || type === 'string') continue;
    let i = re.lastIndex;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    entries.push({ type, key: m[2], fields: parseFields(src.slice(start, i - 1)) });
    re.lastIndex = i;
  }
  return entries;
}

/** "Knuth, Donald E. and Plass, Michael F." -> "D. Knuth and M. Plass" (et al. beyond 3). */
export function bibAuthors(e: BibEntry): string {
  const raw = e.fields.author ?? e.fields.editor ?? '';
  if (!raw) return '';
  const names = raw.split(/\s+and\s+/i).map((name) => {
    const comma = name.indexOf(',');
    if (comma >= 0) {
      const last = name.slice(0, comma).trim();
      const first = name.slice(comma + 1).trim();
      return (first ? first[0] + '. ' : '') + last;
    }
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return parts[0][0] + '. ' + parts.slice(1).join(' ');
  });
  if (names.length > 3) return `${names[0]} et al.`;
  if (names.length > 1) return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  return names[0];
}

export function bibVenue(e: BibEntry): string {
  return e.fields.journal ?? e.fields.booktitle ?? e.fields.publisher ?? e.fields.school ?? e.fields.howpublished ?? '';
}
