// Citation styles, the line-breaker way: a hand-written formatter per
// style, offered only for styles that are ported, and verified against the
// compiler — the References block's own compile also renders every
// in-text citation, and where the compiled string differs from this
// formatter's the compiled string wins for that citation (citations.ts).
// Not a CSL engine: two styles, exact for the cases that matter.
//
// The APA rules below are what Typst's hayagriva printed for the cases in
// citation-styles.test.ts: `(Surname, Year)`, `&` for two authors, `et al.`
// from three, corporate authors whole, lowercase particles dropped
// ("van der Berg" → "Berg"), editors when there is no author, `n.d.` for
// no year, and `a`/`b` suffixes for the same author string and year among
// the cited entries.

import type { BibEntry } from './bibtex';

export type CitationStyle = 'ieee' | 'apa';

export const CITATION_STYLES: Array<[CitationStyle, string]> = [
  ['ieee', 'IEEE — numeric [1]'],
  ['apa', 'APA — author–year (Knuth & Plass, 1981)'],
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

/** Surnames of an entry's authors (editors when it has none), for the
 *  short in-text form. A braced name (`{World Bank}`) is one corporate
 *  author, whole. */
export function bibSurnames(e: BibEntry): string[] {
  const list = rawField(e.raw, 'author') ?? rawField(e.raw, 'editor') ?? e.fields.author ?? e.fields.editor ?? '';
  if (!list.trim()) return [];
  return splitNames(list).map((name) => {
    if (name.startsWith('{') && name.endsWith('}')) return name.slice(1, -1).replace(/[{}]/g, '').trim();
    const bare = name.replace(/[{}]/g, '');
    const comma = bare.indexOf(',');
    let last = comma >= 0 ? bare.slice(0, comma).trim() : (bare.trim().split(/\s+/).pop() ?? bare);
    // Lowercase particles (van, der, de, von) drop from the short form.
    const parts = last.split(/\s+/);
    while (parts.length > 1 && /^\p{Ll}/u.test(parts[0])) parts.shift();
    last = parts.join(' ');
    return last;
  });
}

function apaAuthors(surnames: string[]): string {
  if (!surnames.length) return '';
  if (surnames.length === 1) return surnames[0];
  if (surnames.length === 2) return `${surnames[0]} & ${surnames[1]}`;
  return `${surnames[0]} et al.`;
}

function apaYear(e: BibEntry): string {
  const y = /\b(\d{4})\b/.exec(e.fields.year ?? e.fields.date ?? '');
  return y ? y[1] : 'n.d.';
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
  // APA: author string + year, with a/b suffixes where two cited entries
  // would otherwise read the same, lettered in first-use order.
  const bases = new Map<string, string[]>();
  for (const [key] of order) {
    const e = byKey.get(key);
    if (!e) continue;
    const base = `${apaAuthors(bibSurnames(e))}|${apaYear(e)}`;
    const keys = bases.get(base) ?? [];
    keys.push(key);
    bases.set(base, keys);
  }
  for (const [key] of order) {
    const e = byKey.get(key);
    if (!e) {
      labels.set(key, '(?)');
      continue;
    }
    const authors = apaAuthors(bibSurnames(e));
    const year = apaYear(e);
    const siblings = bases.get(`${authors}|${year}`) ?? [key];
    const suffix = siblings.length > 1 && year !== 'n.d.' ? String.fromCharCode(97 + siblings.indexOf(key)) : '';
    labels.set(key, `(${authors ? `${authors}, ` : ''}${year}${suffix})`);
  }
  return labels;
}
