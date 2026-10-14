// Citation styles, the line-breaker way: a hand-written formatter per
// style, offered only for styles that are ported, and verified against the
// compiler — the References block's own compile also renders every
// in-text citation, and where the compiled string differs from this
// formatter's the compiled string wins for that citation (citations.ts).
// Not a CSL engine: three styles, exact for the cases that matter.
//
// Every rule below is what Typst's hayagriva printed for the entries in
// citation-styles.test.ts (probed through the in-app compiler on
// 2026-09-11): surnames with lowercase particles dropped unless the
// surname is braced, corporate names whole, `et al.` from three names,
// editors when there is no author (APA by surname, Chicago by full name,
// comma-joined), the title when there are neither (Chicago in curly
// quotes), `n.d.` for no year, and `a`/`b` suffixes — `n.d.-a` — for the
// same names and year among the cited entries, in first-use order.

import type { BibEntry } from './bibtex';

export type CitationStyle = 'ieee' | 'apa' | 'chicago-author-date';

export const CITATION_STYLES: Array<[CitationStyle, string]> = [
  ['ieee', 'IEEE — numeric [1]'],
  ['apa', 'APA — author–year (Knuth & Plass, 1981)'],
  ['chicago-author-date', 'Chicago — author–date (Knuth and Plass 1981)'],
];

/** A field's value from the entry's raw BibTeX, braces intact — the
 *  parsed fields are cleaned for display and have lost the `{…}` that
 *  marks a corporate author as one name. */
function rawField(raw: string, name: string): string | null {
  const m = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*`, 'i').exec(raw);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (raw[i] === '{') {
    let depth = 0;
    const start = i + 1;
    for (; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}' && --depth === 0) return raw.slice(start, i);
    }
    return raw.slice(start);
  }
  if (raw[i] === '"') {
    const end = raw.indexOf('"', i + 1);
    return end < 0 ? raw.slice(i + 1) : raw.slice(i + 1, end);
  }
  const end = raw.slice(i).search(/[,}]/);
  return end < 0 ? raw.slice(i).trim() : raw.slice(i, i + end).trim();
}

/** Split a name list on ` and ` outside braces. */
function splitNames(list: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let start = 0;
  const lower = list.toLowerCase();
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && /\s/.test(c) && lower.startsWith('and', i + 1) && /\s/.test(list[i + 4] ?? '')) {
      names.push(list.slice(start, i));
      start = i + 5;
      i += 4;
    }
  }
  names.push(list.slice(start));
  return names.map((n) => n.trim()).filter(Boolean);
}

interface Name {
  /** The short form: surname, or the whole corporate name. */
  short: string;
  /** The full form, "First Last" (Chicago names its editors this way). */
  full: string;
}

function parseName(name: string): Name {
  if (name.startsWith('{') && name.endsWith('}')) {
    const whole = name.slice(1, -1).replace(/[{}]/g, '').trim();
    return { short: whole, full: whole };
  }
  const comma = name.indexOf(',');
  if (comma >= 0) {
    const lastRaw = name.slice(0, comma).trim();
    const rest = name.slice(comma + 1).split(',');
    const first = rest[rest.length - 1].trim().replace(/[{}]/g, '');
    const braced = lastRaw.startsWith('{') && lastRaw.endsWith('}');
    const last = lastRaw.replace(/[{}]/g, '');
    return { short: braced ? last : dropParticles(last), full: [first, last].filter(Boolean).join(' ') };
  }
  const bare = name.replace(/[{}]/g, '').trim();
  const parts = bare.split(/\s+/);
  return { short: dropParticles(parts[parts.length - 1] ?? bare), full: bare };
}

/** Lowercase particles (van, der, de, von) drop from the short form. */
function dropParticles(last: string): string {
  const parts = last.split(/\s+/);
  while (parts.length > 1 && /^\p{Ll}/u.test(parts[0])) parts.shift();
  return parts.join(' ');
}

function names(e: BibEntry, field: 'author' | 'editor'): Name[] {
  const list = rawField(e.raw, field) ?? e.fields[field] ?? '';
  return list.trim() ? splitNames(list).map(parseName) : [];
}

/** Surnames of an entry's authors (editors when it has none). */
export function bibSurnames(e: BibEntry): string[] {
  const authors = names(e, 'author');
  return (authors.length ? authors : names(e, 'editor')).map((n) => n.short);
}

const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'yet', 'so', 'as', 'at', 'by', 'in', 'of', 'on', 'to', 'up', 'via', 'per', 'vs']);

/** hayagriva's title case for a title standing in for the author. */
function titleCase(title: string): string {
  return title
    .replace(/[{}]/g, '')
    .split(/(\s+)/)
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : word))
    .join('');
}

function year(e: BibEntry): string | null {
  const y = /\b(\d{4})\b/.exec(e.fields.year ?? e.fields.date ?? '');
  return y ? y[1] : null;
}

/** The "who" of a citation under a style, or the title when nobody wrote
 *  it, or '' when the entry has neither. */
/** Chicago quotes a standing-in title for a short work (an article, a
 *  misc) and leaves a long one (a book, a report — italic in print) bare. */
const QUOTED_TITLE_TYPES = new Set(['article', 'misc', 'inproceedings', 'incollection', 'inbook', 'conference', 'online', 'unpublished']);

function who(style: 'apa' | 'chicago-author-date', e: BibEntry): { text: string; isTitle: boolean } {
  const authors = names(e, 'author');
  if (authors.length) return { text: join(style, authors.map((n) => n.short), 'and'), isTitle: false };
  const editors = names(e, 'editor');
  if (editors.length) {
    // Chicago names its editors in full, comma-joined; APA by surname.
    if (style === 'chicago-author-date') return { text: join(style, editors.map((n) => n.full), ','), isTitle: false };
    return { text: join(style, editors.map((n) => n.short), 'and'), isTitle: false };
  }
  const title = e.fields.title?.trim();
  return { text: title ? titleCase(title) : '', isTitle: !!title && QUOTED_TITLE_TYPES.has(e.type) };
}

function join(style: 'apa' | 'chicago-author-date', parts: string[], two: 'and' | ','): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return two === ',' ? `${parts[0]}, ${parts[1]}` : `${parts[0]} ${style === 'apa' ? '&' : 'and'} ${parts[1]}`;
  return `${parts[0]} et al.`;
}

/**
 * The in-text string for every cited key. `order` is first-use order (the
 * numeric styles' number); `entries` the document's bibliography. Unknown
 * keys get the style's placeholder.
 */
export function citationLabels(style: CitationStyle, order: Map<string, number>, entries: readonly BibEntry[]): Map<string, string> {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const labels = new Map<string, string>();
  if (style === 'ieee') {
    for (const [key, n] of order) labels.set(key, byKey.has(key) ? `[${n}]` : '[?]');
    return labels;
  }
  // Suffixes where two cited entries would read the same, lettered in
  // first-use order.
  const bases = new Map<string, string[]>();
  const base = (e: BibEntry) => `${who(style, e).text}|${year(e) ?? 'n.d.'}`;
  for (const [key] of order) {
    const e = byKey.get(key);
    if (!e) continue;
    const keys = bases.get(base(e)) ?? [];
    keys.push(key);
    bases.set(base(e), keys);
  }
  for (const [key] of order) {
    const e = byKey.get(key);
    if (!e) {
      labels.set(key, '(?)');
      continue;
    }
    const w = who(style, e);
    const y = year(e);
    const siblings = bases.get(base(e)) ?? [key];
    const suffix = siblings.length > 1 ? (y ? '' : '-') + String.fromCharCode(97 + siblings.indexOf(key)) : '';
    const date = (y ?? 'n.d.') + suffix;
    if (!w.text) {
      labels.set(key, `(${date})`);
    } else if (style === 'apa') {
      labels.set(key, `(${w.text}, ${date})`);
    } else if (w.isTitle) {
      // Chicago quotes a standing-in title; the comma before n.d. sits
      // inside the quotes.
      labels.set(key, y ? `(“${w.text}” ${date})` : `(“${w.text},” ${date})`);
    } else {
      labels.set(key, y ? `(${w.text} ${date})` : `(${w.text}, ${date})`);
    }
  }
  return labels;
}
