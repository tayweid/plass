// Pandoc Markdown front matter: the YAML metadata block at the top of a
// Plass `.md` (docs/MARKDOWN-SOURCE-PLAN.md, "The format › Front matter").
//
// A YAML subset, read and written with no dependency: plain, single- and
// double-quoted scalars (double-quoted escapes decoded as YAML 1.2 — and
// pandoc — decode them), block maps at any depth, flow maps and lists,
// block lists, block scalars (`|`, `>`, chomping and indentation
// indicators) and `#` comments. An anchor (`&a`) or tag (`!t`) is skipped
// and the value after it read, as pandoc reads it; aliases are not resolved.
//
// Known keys are interpreted: pandoc's own names for the big knobs, Plass's
// settings under one `plass:` key (which pandoc ignores). Everything else —
// unknown keys, whole-line `#` comments, an entry that cannot be read — is
// carried verbatim, in order, in `extra` (doc.attrs.frontmatter) and
// written back after the known keys. title, author, date and abstract come
// back as RAW Markdown for the body reader to parse; this module never
// interprets Markdown. The writer emits only non-default settings, in the
// plan's fixed order, `margin` as a dict, and every scalar in a form that
// needs no backslash escaping (plain when YAML reads it back as the same
// string, else single-quoted), so `$\beta$` survives a save.
//
// Where pandoc rejects a file whose intent is plain (an unquoted `: ` or a
// leading `*` in a title, an unknown `\` escape), the reader takes the
// intent, warns, and the next save writes the value in a form pandoc reads.

import { DEFAULT_SETTINGS, FOOTNOTE_NUMBERINGS, FOOTNOTE_SEPARATORS, normalizeSettings, type DocSettings, type PaperName } from './settings';
import { CITATION_STYLES } from './citation-styles';

export interface FrontmatterFields {
  /** Raw Markdown (inline), or null when the key is absent. */
  titleMd?: string | null;
  /** Raw Markdown (inline); a YAML author list is joined with ", ". */
  authorsMd?: string | null;
  dateMd?: string | null;
  /** Raw Markdown (blocks: paragraphs separated by blank lines). */
  abstractMd?: string | null;
  settings?: Partial<DocSettings> | null;
  /** `plass.page-numbers.front-matter: roman` — the numbering_restart node. */
  frontMatterRestart?: boolean;
  /** Unknown keys and comments, verbatim YAML lines (doc.attrs.frontmatter). */
  extra?: string;
}

export interface FrontmatterRead {
  titleMd: string | null;
  authorsMd: string | null;
  dateMd: string | null;
  abstractMd: string | null;
  /** Only the settings the YAML sets, each valid (an invalid one is warned and left out). */
  settings: Partial<DocSettings>;
  /** `bibliography:` — a sidecar path to read once; never written back. */
  bibliography?: string;
  frontMatterRestart: boolean;
  extra: string;
  warnings: string[];
  /** The text after the closing `---`/`...` line; the whole input when it opens with no metadata block. */
  body: string;
}

// ---------------------------------------------------------------- the YAML subset

type YScalar = { t: 'scalar'; plain: boolean; value: string };
type YMap = { t: 'map'; entries: Array<[string, YNode]> };
type YSeq = { t: 'seq'; items: YNode[] };
type YNode = YScalar | YMap | YSeq | { t: 'null' };

/** YAML this subset cannot read: the entry is kept as written. */
class YamlError extends Error {}

const isBlank = (line: string): boolean => /^[ \t]*$/.test(line);
const isComment = (line: string): boolean => /^[ \t]*#/.test(line);
const indentOf = (line: string): number => /^ */.exec(line)![0].length;
// `key:` then whitespace or the end of the line. A plain key may hold a
// colon that no space follows (`a:b: c` is the key `a:b`).
const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{}[\],&*!|>%@`?:-][^\n]*?|[?:-][^\s][^\n]*?)[ \t]*:(?:[ \t]+(.*))?$/;
const SEQ_ITEM = /^-(?:[ \t]|$)/;

function decodeKey(raw: string): string {
  if (raw.startsWith('"')) return (new FlowReader(raw, []).node() as YScalar).value;
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw.trim();
}

function keyOf(line: string, indent: number): string | null {
  const m = KEY_RE.exec(line.slice(indent));
  return m ? decodeKey(m[1]) : null;
}

interface Item {
  kind: 'entry' | 'comment' | 'blank' | 'stray';
  start: number;
  end: number;
}

/** Partition lines into the items of a block map at `indent`: each entry
 *  runs from its key line through every deeper line (and a compact list at
 *  the same indent under an empty `key:`), trailing blank lines excluded;
 *  comments and blank lines between entries are items of their own; a line
 *  that is none of these is `stray`. */
function splitItems(lines: string[], indent: number): Item[] {
  const items: Item[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      items.push({ kind: 'blank', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (isComment(line)) {
      items.push({ kind: 'comment', start: i, end: i + 1 });
      i++;
      continue;
    }
    const m = indentOf(line) === indent ? KEY_RE.exec(line.slice(indent)) : null;
    if (!m) {
      items.push({ kind: 'stray', start: i, end: i + 1 });
      i++;
      continue;
    }
    const empty = !m[2] || isBlank(m[2]) || isComment(m[2]);
    let end = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      const ni = indentOf(next);
      if (isBlank(next)) {
        // Spaces past the indent (and a tab after them) can be block text.
        if (ni > indent) end = j + 1;
        continue;
      }
      if (ni > indent || (empty && ni === indent && SEQ_ITEM.test(next.slice(indent)))) end = j + 1;
      else break;
    }
    items.push({ kind: 'entry', start: i, end });
    i = end;
  }
  return items;
}

/** One `key: value` entry: `lines[0]` is the key line at `indent`, the rest its continuation. */
function parseEntry(lines: string[], indent: number, notes: string[]): { key: string; value: YNode } {
  const m = KEY_RE.exec(lines[0].slice(indent));
  if (!m) throw new YamlError('not a "key: value" line');
  return { key: decodeKey(m[1]), value: parseValue(m[2] ?? '', lines.slice(1), indent, notes) };
}

/** The value after `key:` (or after `- `): `rest` is the rest of its line,
 *  `cont` the deeper lines after it, `indent` the key's indentation. */
function parseValue(rest: string, cont: string[], indent: number, notes: string[]): YNode {
  rest = stripProperties(rest.trimStart(), notes);
  const r = rest.trim();
  if (r === '' || r.startsWith('#')) return parseNested(cont, indent, notes);
  if (r[0] === '|' || r[0] === '>') return parseBlockScalar(r, cont, indent);
  if ('"\'{['.includes(r[0])) {
    // Untrimmed at the end: a quoted line's trailing `\ ` is text.
    const reader = new FlowReader([rest, ...cont].join('\n'), notes);
    const node = reader.node();
    reader.end();
    return node;
  }
  if ('*&%@`'.includes(r[0])) notes.push(rejected(r[0]));
  return parsePlain(r, cont, notes);
}

/** An anchor (`&a`) or tag (`!t`, `!!str`) before a value: pandoc reads the
 *  value after it, and so does Plass (aliases are not resolved). */
function stripProperties(r: string, notes: string[]): string {
  for (;;) {
    const m = /^(&[^\s,[\]{}]+|![^\s,[\]{}]*)(?=[\s,[\]{}]|$)[ \t]*/.exec(r);
    if (!m) return r;
    notes.push(`the YAML ${m[1][0] === '&' ? 'anchor' : 'tag'} ${m[1]} is ignored`);
    r = r.slice(m[0].length);
  }
}

/** The note for an unquoted value pandoc's YAML reader rejects. */
const rejected = (c: string): string =>
  c === '*'
    ? 'a leading * is a YAML alias to pandoc, which rejects the file when it names no anchor; read as text'
    : c === '&'
      ? 'a bare & is an empty YAML anchor to pandoc, which rejects the file; read as text'
      : `YAML does not allow an unquoted value to start with ${c} (pandoc rejects the file); read as text`;

/** A value on the lines after its key: a block list, a block map, or a scalar. */
function parseNested(cont: string[], indent: number, notes: string[]): YNode {
  const first = cont.findIndex((line) => !isBlank(line) && !isComment(line));
  if (first < 0) return { t: 'null' };
  const line = cont[first];
  const ci = indentOf(line);
  const body = line.slice(ci);
  if (SEQ_ITEM.test(body)) return parseSeq(cont.slice(first), ci, notes);
  if (ci <= indent) throw new YamlError('expected an indented value');
  if (KEY_RE.test(body)) return parseMap(cont.slice(first), ci, notes);
  return parseValue(body, cont.slice(first + 1), indent, notes);
}

function parseMap(lines: string[], indent: number, notes: string[]): YMap {
  const entries: Array<[string, YNode]> = [];
  for (const item of splitItems(lines, indent)) {
    if (item.kind === 'blank' || item.kind === 'comment') continue;
    if (item.kind === 'stray') throw new YamlError(`unexpected line "${lines[item.start].trim()}"`);
    const { key, value } = parseEntry(lines.slice(item.start, item.end), indent, notes);
    const at = entries.findIndex(([k]) => k === key);
    if (at >= 0) entries.splice(at, 1); // the last one wins, as in pandoc
    entries.push([key, value]);
  }
  return { t: 'map', entries };
}

function parseSeq(lines: string[], indent: number, notes: string[]): YSeq {
  const items: YNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) {
      i++;
      continue;
    }
    if (indentOf(line) !== indent || !SEQ_ITEM.test(line.slice(indent))) {
      throw new YamlError(`unexpected line "${line.trim()}" in a list`);
    }
    let end = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (indentOf(lines[j]) > indent) end = j + 1;
      else if (!isBlank(lines[j])) break;
    }
    // The dash becomes a space, so a compact map (`- name: x`) or a nested
    // list reads at its own column.
    const head = ' '.repeat(indent + 1) + line.slice(indent + 1);
    items.push(parseNested([head, ...lines.slice(i + 1, end)], indent, notes));
    i = end;
  }
  return { t: 'seq', items };
}

function parseBlockScalar(header: string, cont: string[], indent: number): YScalar {
  const m = /^([|>])([1-9])?([+-])?([1-9])?[ \t]*(?:#.*)?$/.exec(header);
  if (!m || (m[2] && m[4])) throw new YamlError(`"${header}" is not a block-text header`);
  const folded = m[1] === '>';
  const chomp = m[3] ?? '';
  const explicit = m[2] ?? m[4];
  let contentIndent = explicit ? indent + Number(explicit) : -1;
  if (contentIndent < 0) {
    let deepestLeading = 0;
    for (const line of cont) {
      if (/^ *$/.test(line)) {
        deepestLeading = Math.max(deepestLeading, line.length);
        continue;
      }
      contentIndent = indentOf(line);
      break;
    }
    // No text at all: every line is empty, however deep.
    if (contentIndent < 0) contentIndent = Math.max(deepestLeading, indent + 1);
    if (contentIndent <= indent) throw new YamlError('block text must be indented');
    if (deepestLeading > contentIndent) throw new YamlError('a blank line before the text is indented deeper than the text');
  }
  const lines: string[] = [];
  for (let k = 0; k < cont.length; k++) {
    const line = cont[k];
    if (/^ *$/.test(line) && line.length <= contentIndent) {
      lines.push('');
      continue;
    }
    if (indentOf(line) < contentIndent) {
      // Only comments may follow the text, less indented than it.
      if (isComment(line) && cont.slice(k).every((l) => isBlank(l) || isComment(l))) break;
      throw new YamlError('a line of block text is less indented than the first');
    }
    lines.push(line.slice(contentIndent));
  }
  // Folding and chomping as YAML 1.2 (js-yaml's readBlockScalar).
  let out = '';
  let empty = 0;
  let didRead = false;
  let moreIndented = false;
  for (const line of lines) {
    if (line === '') {
      empty++;
      continue;
    }
    if (folded) {
      if (/^[ \t]/.test(line)) {
        moreIndented = true;
        out += '\n'.repeat(didRead ? 1 + empty : empty);
      } else if (moreIndented) {
        moreIndented = false;
        out += '\n'.repeat(empty + 1);
      } else if (empty === 0) {
        if (didRead) out += ' ';
      } else out += '\n'.repeat(empty);
    } else out += '\n'.repeat(didRead ? 1 + empty : empty);
    out += line;
    didRead = true;
    empty = 0;
  }
  if (chomp === '+') out += '\n'.repeat(didRead ? 1 + empty : empty);
  else if (chomp === '' && didRead) out += '\n';
  return { t: 'scalar', plain: false, value: out };
}

/** A multi-line plain scalar: continuation lines fold to one space, each blank line to a newline. */
function parsePlain(first: string, cont: string[], notes: string[]): YScalar {
  let out = '';
  let blanks = 0;
  let ended = false;
  let colon = false;
  const take = (text: string, isFirst: boolean): void => {
    const hash = text.search(/(?:^|[ \t])#/);
    if (hash >= 0) {
      text = text.slice(0, hash);
      ended = true;
    }
    text = text.trim();
    if (!text) return;
    if (/:(?:[ \t]|$)/.test(text)) colon = true;
    if (!isFirst) out += blanks ? '\n'.repeat(blanks) : ' ';
    out += text;
    blanks = 0;
  };
  take(first, true);
  for (const line of cont) {
    if (isBlank(line)) {
      blanks++;
      continue;
    }
    if (ended) {
      if (isComment(line)) continue;
      throw new YamlError('text after a comment');
    }
    take(line, false);
  }
  if (colon) notes.push('an unquoted ": " is not allowed in a YAML value (pandoc rejects the file); read as text');
  return { t: 'scalar', plain: true, value: out };
}

const ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
};

/** Quoted scalars and flow collections, read from one string that may span lines. */
class FlowReader {
  private i = 0;
  constructor(
    private readonly s: string,
    private readonly notes: string[],
  ) {}

  /** Skip whitespace, line breaks and comments (a `#` after whitespace). */
  private ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\n') this.i++;
      else if (c === '#' && (this.i === 0 || /\s/.test(s[this.i - 1]))) {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else return;
    }
  }

  end(): void {
    this.ws();
    if (this.i < this.s.length) throw new YamlError(`unexpected "${this.s.slice(this.i).split('\n')[0]}" after the value`);
  }

  node(inFlow = false): YNode {
    this.ws();
    if (inFlow && (this.s[this.i] === '&' || this.s[this.i] === '!')) {
      const rest = this.s.slice(this.i);
      this.i += rest.length - stripProperties(rest, this.notes).length;
      this.ws();
      // A property with no value after it (`{a: !t, …}`) is an empty value.
      if (this.i >= this.s.length || ',]}'.includes(this.s[this.i])) return { t: 'null' };
    }
    const c = this.s[this.i];
    if (c === '"') return this.double();
    if (c === "'") return this.single();
    if (c === '{') return this.map();
    if (c === '[') return this.seq();
    if (!inFlow) throw new YamlError('expected a quoted value or a flow collection');
    return this.plain();
  }

  private value(close: string): YNode {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined || c === ',' || c === close) return { t: 'null' };
    return this.node(true);
  }

  private map(): YMap {
    this.i++;
    const entries: Array<[string, YNode]> = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return { t: 'map', entries };
      }
      const key = this.key();
      this.ws();
      let value: YNode = { t: 'null' };
      if (this.s[this.i] === ':') {
        this.i++;
        value = this.value('}');
      }
      const at = entries.findIndex(([k]) => k === key);
      if (at >= 0) entries.splice(at, 1);
      entries.push([key, value]);
      this.ws();
      const c = this.s[this.i];
      if (c === ',') this.i++;
      else if (c !== '}') throw new YamlError(c === undefined ? 'a "{" is never closed' : `expected "," or "}" in a flow map, found "${c}"`);
    }
  }

  private seq(): YSeq {
    this.i++;
    const items: YNode[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') {
        this.i++;
        return { t: 'seq', items };
      }
      items.push(this.node(true));
      this.ws();
      const c = this.s[this.i];
      if (c === ',') this.i++;
      else if (c !== ']') throw new YamlError(c === undefined ? 'a "[" is never closed' : `expected "," or "]" in a flow list, found "${c}"`);
    }
  }

  private key(): string {
    const c = this.s[this.i];
    if (c === '"') return this.double().value;
    if (c === "'") return this.single().value;
    const start = this.i;
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (',{}[]'.includes(ch)) break;
      if (ch === ':' && /^(?:\s|[,\]}]|$)/.test(this.s.slice(this.i + 1, this.i + 2))) break;
      this.i++;
    }
    const key = this.s.slice(start, this.i).replace(/\s+/g, ' ').trim();
    if (!key) throw new YamlError('a flow map entry has no key');
    return key;
  }

  /** A plain scalar inside a flow collection: ends at `,[]{}`, `: ` or ` #`. */
  private plain(): YScalar {
    const s = this.s;
    const c = s[this.i];
    if (',[]{}'.includes(c)) throw new YamlError(`unexpected "${c}" in a flow collection`);
    if ('*&%@`'.includes(c)) this.notes.push(rejected(c));
    const start = this.i;
    while (this.i < s.length) {
      const ch = s[this.i];
      if (',[]{}'.includes(ch)) break;
      if (ch === ':' && /^(?:\s|[,[\]{}]|$)/.test(s.slice(this.i + 1, this.i + 2))) break;
      if (ch === '#' && /\s/.test(s[this.i - 1] ?? '')) break;
      this.i++;
    }
    const lines = s.slice(start, this.i).split('\n').map((line) => line.trim());
    let out = '';
    let blanks = 0;
    lines.forEach((line, k) => {
      if (!line) {
        if (k) blanks++;
        return;
      }
      if (out) out += blanks ? '\n'.repeat(blanks) : ' ';
      out += line;
      blanks = 0;
    });
    return { t: 'scalar', plain: true, value: out };
  }

  /** At a raw line break inside a quoted scalar: trim the line's raw
   *  trailing whitespace (never past `keep`, the end of the last escape),
   *  skip the next line's indentation, and fold — one break is a space, each
   *  further one a newline. */
  private fold(out: string, keep: number): string {
    let end = out.length;
    while (end > keep && (out[end - 1] === ' ' || out[end - 1] === '\t')) end--;
    out = out.slice(0, end);
    let breaks = 0;
    while (this.i < this.s.length && ' \t\n'.includes(this.s[this.i])) {
      if (this.s[this.i] === '\n') breaks++;
      this.i++;
    }
    return out + (breaks === 1 ? ' ' : '\n'.repeat(breaks - 1));
  }

  private single(): YScalar {
    const s = this.s;
    this.i++;
    let out = '';
    for (;;) {
      if (this.i >= s.length) throw new YamlError("a ' quote is never closed");
      const c = s[this.i];
      if (c === "'") {
        if (s[this.i + 1] === "'") {
          out += "'";
          this.i += 2;
          continue;
        }
        this.i++;
        return { t: 'scalar', plain: false, value: out };
      }
      if (c === '\n') {
        out = this.fold(out, 0);
        continue;
      }
      out += c;
      this.i++;
    }
  }

  private double(): YScalar {
    const s = this.s;
    this.i++;
    let out = '';
    let keep = 0;
    for (;;) {
      if (this.i >= s.length) throw new YamlError('a " quote is never closed');
      const c = s[this.i];
      if (c === '"') {
        this.i++;
        return { t: 'scalar', plain: false, value: out };
      }
      if (c === '\n') {
        out = this.fold(out, keep);
        keep = out.length;
        continue;
      }
      if (c !== '\\') {
        out += c;
        this.i++;
        continue;
      }
      const e = s[this.i + 1] ?? '';
      if (e === '\n') {
        // An escaped line break joins the lines with nothing between.
        this.i += 2;
        while (this.i < s.length && ' \t'.includes(s[this.i])) this.i++;
      } else if (e in ESCAPES) {
        out += ESCAPES[e];
        this.i += 2;
        // `"$\beta$"` is a backspace and "eta" to YAML — and to pandoc.
        if (/[a-zA-Z]/.test(e) && /[a-zA-Z]/.test(s[this.i] ?? '')) {
          const word = '\\' + e + /^[a-zA-Z]*/.exec(s.slice(this.i))![0];
          this.notes.push(`"${word}" inside double quotes is the YAML escape \\${e}, as pandoc reads it — write LaTeX unquoted or in single quotes`);
        }
      } else {
        const width = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
        const hex = width ? s.slice(this.i + 2, this.i + 2 + width) : '';
        const code = width && new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex) ? parseInt(hex, 16) : -1;
        if (code >= 0 && code <= 0x10ffff) {
          out += String.fromCodePoint(code);
          this.i += 2 + width;
        } else {
          // Not a YAML escape: pandoc rejects the file; keep the backslash.
          out += '\\' + e;
          this.i += 2;
          this.notes.push(`"\\${e}" inside double quotes is not a YAML escape (pandoc rejects the file); read as a backslash`);
        }
      }
      keep = out.length;
    }
  }
}

// ---------------------------------------------------------------- writing YAML scalars

// Plain scalars a YAML reader would not read back as the same string: the
// core schema's null, booleans and numbers, plus YAML 1.1's extra booleans,
// sexagesimals and underscored numbers (other readers still use 1.1).
const NOT_A_STRING =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|=|<<|[-+]?(?:\.?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|0[xob][0-9a-fA-F_]+|[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|\.(?:inf|Inf|INF))|\.(?:nan|NaN|NAN))$/;

function plainSafe(v: string, flow: boolean): boolean {
  if (!v || v !== v.trim() || /[\t\n\r]/.test(v)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(v)) return false;
  if (/:(?:\s|$)|\s#/.test(v)) return false;
  // In a flow map pandoc's YAML reader rejects any colon in a plain scalar.
  if (flow && /[,[\]{}:]/.test(v)) return false;
  if (/^(?:---|\.\.\.)/.test(v)) return false;
  return !NOT_A_STRING.test(v);
}

/** A string in the YAML form that needs no backslash escaping: plain when
 *  safe, else single-quoted with `''`. Only a value no such form can hold
 *  (a line break or a control character) is double-quoted, its control
 *  characters as `\uXXXX` (never `\n` or `\t`, which a letter after them
 *  would make look like LaTeX to the reader's warning). */
function scalar(v: string, flow = false): string {
  if (/[\u0000-\u0008\n\u000b-\u001f\u007f\u0085\u2028\u2029\ufeff]/.test(v) || v.includes('\r')) {
    return (
      '"' +
      v.replace(/[\\"\u0000-\u001f\u007f\u0085\u2028\u2029\ufeff]/g, (c) =>
        c === '\\' || c === '"' ? '\\' + c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ) +
      '"'
    );
  }
  return plainSafe(v, flow) ? v : `'${v.replace(/'/g, "''")}'`;
}

/** `key: |` block text, content at `indent` (two past the key). Trailing
 *  newlines are not part of the value (clip chomping writes one, the reader
 *  drops it); a first line that starts with a space gets an indicator. */
function blockLines(prefix: string, text: string, indent: number): string[] | null {
  const body = text.replace(/\n+$/, '');
  if (!body || /[\u0000-\u0008\u000b-\u001f\u007f\r\u0085\u2028\u2029\ufeff]/.test(body)) return null;
  const lines = body.split('\n');
  const first = lines.find((line) => line !== '') ?? '';
  const pad = ' '.repeat(indent);
  return [`${prefix}: |${/^[ \t]/.test(first) ? '2' : ''}`, ...lines.map((line) => (line ? pad + line : ''))];
}

/** Re-emit a parsed node on one line (an unknown child of a flow `plass:` map). */
function emitNode(node: YNode): string {
  switch (node.t) {
    case 'null':
      return '';
    case 'scalar':
      return node.plain && !/\n/.test(node.value) && !/^[*&!%@`]/.test(node.value) ? node.value : scalar(node.value, true);
    case 'map':
      return `{${node.entries.map(([k, v]) => `${scalar(k, true)}: ${emitNode(v)}`.trimEnd()).join(', ')}}`;
    case 'seq':
      return `[${node.items.map(emitNode).join(', ')}]`;
  }
}

const num = (n: number): string => String(n);

// ---------------------------------------------------------------- the vocabulary

/** Where each setting lives in the YAML (warnings name it). A Record over
 *  every DocSettings key, so a new setting does not compile until mapped. */
const FIELD_PATH: Record<keyof DocSettings, string> = {
  font: 'mainfont',
  sizePt: 'fontsize',
  lineHeight: 'linestretch',
  page: 'papersize',
  pageWidthIn: 'plass.page.width',
  pageHeightIn: 'plass.page.height',
  landscape: 'plass.landscape',
  marginTop: 'margin.top',
  marginRight: 'margin.right',
  marginBottom: 'margin.bottom',
  marginLeft: 'margin.left',
  hyphenate: 'plass.hyphenate',
  parIndent: 'indent',
  numberEquations: 'plass.number-equations',
  numberSections: 'section-numbering',
  pageNumShow: 'plass.page-numbers.show',
  pageNumFormat: 'plass.page-numbers.format',
  pageNumAlign: 'plass.page-numbers.align',
  pageNumPlace: 'plass.page-numbers.place',
  pageNumStart: 'plass.page-numbers.start',
  headerText: 'plass.header.text',
  headerAlign: 'plass.header.align',
  headerFirstPage: 'plass.header.first-page',
  footerText: 'plass.footer.text',
  footerAlign: 'plass.footer.align',
  footerFirstPage: 'plass.footer.first-page',
  mathMacros: 'plass.math-macros',
  citationStyle: 'bibliographystyle',
  footnoteNumbering: 'plass.footnotes.numbering',
  footnoteSeparator: 'plass.footnotes.separator',
};

const UNIT: Partial<Record<keyof DocSettings, 'pt' | 'in'>> = {
  sizePt: 'pt',
  pageWidthIn: 'in',
  pageHeightIn: 'in',
  marginTop: 'in',
  marginRight: 'in',
  marginBottom: 'in',
  marginLeft: 'in',
};

const show = (field: keyof DocSettings, value: unknown): string =>
  typeof value === 'number' ? `${num(value)}${UNIT[field] ?? ''}` : typeof value === 'string' ? scalar(value) : String(value);

/** Typst's paper names (pandoc's `papersize` for Typst output). */
const PAPER_YAML: Partial<Record<PaperName, string>> = { a4: 'a4', legal: 'us-legal', b5: 'iso-b5', a5: 'a5' };
const PAPER_READ: Record<string, PaperName> = {
  'us-letter': 'letter', letter: 'letter', a4: 'a4', 'us-legal': 'legal', legal: 'legal',
  'iso-b5': 'b5', b5: 'b5', a5: 'a5', 'half-letter': 'half-letter', 'us-statement': 'half-letter',
};
const MARGINS = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const;
const ALIGNS = ['left', 'center', 'right'] as const;
const PAGE_NUM_FORMATS = ['1', '— 1 —', 'i', '1 / 1'] as const;
const CITATION_STYLE_NAMES = CITATION_STYLES.map(([name]) => name);

const KNOWN_TOP = new Set([
  'title', 'author', 'date', 'abstract', 'papersize', 'margin', 'fontsize', 'mainfont',
  'section-numbering', 'bibliography', 'linestretch', 'indent', 'bibliographystyle', 'plass',
]);
const KNOWN_PLASS = new Set([
  'page', 'landscape', 'hyphenate', 'number-equations', 'page-numbers', 'header', 'footer', 'footnotes', 'math-macros',
]);
const TEXT_KEYS = new Set(['title', 'author', 'date', 'abstract']);

/** A value of the wrong kind or out of range: warned and left out. */
class Invalid extends Error {}

const isNull = (n: YNode): boolean => n.t === 'null' || (n.t === 'scalar' && n.plain && /^(?:~|null|Null|NULL)?$/.test(n.value));

function text(n: YNode): string | null {
  if (isNull(n)) return null;
  if (n.t !== 'scalar') throw new Invalid(`expected text, found a ${n.t === 'map' ? 'map' : 'list'}`);
  return n.value;
}

function bool(n: YNode): boolean {
  if (n.t === 'scalar' && n.plain) {
    if (/^(?:true|True|TRUE)$/.test(n.value)) return true;
    if (/^(?:false|False|FALSE)$/.test(n.value)) return false;
  }
  throw new Invalid(`expected true or false, found ${describe(n)}`);
}

function number(n: YNode): number {
  if (n.t === 'scalar' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(n.value.trim())) return Number(n.value);
  throw new Invalid(`expected a number, found ${describe(n)}`);
}

const PER_INCH = { in: 1, mm: 25.4, cm: 2.54, pt: 72 } as const;

function length(n: YNode, unit: 'in' | 'pt'): number {
  const m = n.t === 'scalar' ? /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)[ \t]*(in|mm|cm|pt)$/.exec(n.value.trim()) : null;
  if (!m) {
    const bare = n.t === 'scalar' && /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(n.value.trim());
    throw new Invalid(bare ? `${n.value.trim()} needs a unit (in, mm, cm or pt)` : `expected a length (in, mm, cm or pt), found ${describe(n)}`);
  }
  const from = m[2] as keyof typeof PER_INCH;
  const v = Number(m[1]);
  return from === unit ? v : (v / PER_INCH[from]) * PER_INCH[unit];
}

function choice<T extends string>(n: YNode, values: readonly T[]): T {
  const v = n.t === 'scalar' ? n.value : null;
  if (v !== null && (values as readonly string[]).includes(v)) return v as T;
  throw new Invalid(`${describe(n)} is not one of ${values.map((x) => scalar(x)).join(', ')}`);
}

function describe(n: YNode): string {
  if (n.t === 'scalar') return n.value === '' ? 'an empty value' : scalar(n.value);
  return n.t === 'null' ? 'nothing' : n.t === 'map' ? 'a map' : 'a list';
}

function entriesOf(n: YNode): Array<[string, YNode]> {
  if (n.t !== 'map') throw new Invalid(`expected a map, found ${describe(n)}`);
  return n.entries;
}

// ---------------------------------------------------------------- reading

const DELIMITER = /^(?:---|\.\.\.)[ \t]*$/;

/** The metadata block at the very top, as pandoc finds it: a `---` line
 *  whose next line is not blank, closed by a `---` or `...` line. */
function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const open = /^---[ \t]*\n/.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  if (/^[ \t]*(?:\n|$)/.test(rest)) return null;
  const close = /^(?:---|\.\.\.)[ \t]*$/m.exec(rest);
  if (!close) return null;
  let after = close.index + close[0].length;
  if (rest[after] === '\n') after++;
  return { yaml: rest.slice(0, close.index).replace(/\n$/, ''), body: rest.slice(after) };
}

type ExtraPart = { kind: 'blank' } | { kind: 'lines'; lines: string[] } | { kind: 'plass'; lines: string[] };

/** Join kept parts: runs of blank lines collapse to one, none at the ends. */
function joinExtra(parts: ExtraPart[]): string {
  const out: string[] = [];
  let pendingBlank = false;
  for (const part of parts) {
    if (part.kind === 'blank') {
      pendingBlank = out.length > 0;
      continue;
    }
    const lines = part.kind === 'plass' ? (part.lines.some((l) => !isBlank(l)) ? ['plass:', ...trimBlank(part.lines)] : []) : part.lines;
    if (!lines.length) continue;
    if (pendingBlank) out.push('');
    pendingBlank = false;
    out.push(...lines);
  }
  return out.join('\n');
}

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && isBlank(lines[a])) a++;
  while (b > a && isBlank(lines[b - 1])) b--;
  // Inside, runs of blank lines collapse to one.
  return lines.slice(a, b).filter((line, k, all) => !(isBlank(line) && k > 0 && isBlank(all[k - 1]))).map((line) => (isBlank(line) ? '' : line));
}

/** Shift a block from base indentation `from` to `to`, keeping relative indentation. */
function reindent(lines: string[], from: number, to: number): string[] {
  return lines.map((line) => {
    if (isBlank(line)) return '';
    const ind = indentOf(line);
    return ' '.repeat(to) + (ind >= from ? line.slice(from) : line.trimStart());
  });
}

interface Acc {
  s: Partial<DocSettings>;
  paperTop: PaperName | null;
  paperPlass: { page: PaperName; w?: number; h?: number } | null;
  restart: boolean;
  warn: (m: string) => void;
}

export function readFrontmatter(src: string): FrontmatterRead {
  const text = src.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const out: FrontmatterRead = {
    titleMd: null,
    authorsMd: null,
    dateMd: null,
    abstractMd: null,
    settings: {},
    frontMatterRestart: false,
    extra: '',
    warnings: [],
    body: text,
  };
  const block = splitFrontmatter(text);
  if (!block) return out;
  out.body = block.body;
  const warn = (m: string) => out.warnings.push(m);
  const lines = block.yaml ? block.yaml.split('\n') : [];
  const items = splitItems(lines, 0);
  const acc: Acc = { s: {}, paperTop: null, paperPlass: null, restart: false, warn };
  const parts: ExtraPart[] = [];

  // A known key given twice: the last one is read, as pandoc does.
  const lastAt = new Map<string, number>();
  items.forEach((item, k) => {
    const key = item.kind === 'entry' ? keyOf(lines[item.start], 0) : null;
    if (key && KNOWN_TOP.has(key)) {
      if (lastAt.has(key)) warn(`${key} is given twice — the last one is read`);
      lastAt.set(key, k);
    }
  });

  items.forEach((item, k) => {
    const raw = lines.slice(item.start, item.end);
    if (item.kind === 'blank') return parts.push({ kind: 'blank' });
    if (item.kind === 'comment') return parts.push({ kind: 'lines', lines: raw });
    if (item.kind === 'stray') {
      warn(`front matter line "${raw[0].trim()}" is not a "key: value" entry — kept as written`);
      return parts.push({ kind: 'lines', lines: raw });
    }
    const key = keyOf(raw[0], 0)!;
    if (!KNOWN_TOP.has(key)) return parts.push({ kind: 'lines', lines: raw });
    if (lastAt.get(key) !== k) return;
    if (key === 'plass') {
      const kept = readPlass(raw, acc);
      if (kept) parts.push(kept);
      return;
    }
    const notes: string[] = [];
    let value: YNode;
    try {
      value = parseEntry(raw, 0, notes).value;
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      warn(`${key}: ${e.message} — kept as written`);
      return parts.push({ kind: 'lines', lines: raw });
    }
    for (const note of notes) warn(`${key}: ${note}`);
    try {
      readTop(key, value, out, acc);
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      if (TEXT_KEYS.has(key)) {
        warn(`${key}: ${e.message} — kept as written`);
        parts.push({ kind: 'lines', lines: raw });
      } else warn(`${key}: ${e.message} — ignored`);
    }
  });

  // The page: plass.page (half letter, a custom size) over papersize.
  if (acc.paperPlass) {
    if (acc.paperTop) warn('papersize is ignored: plass.page sets the page');
    acc.s.page = acc.paperPlass.page;
    if (acc.paperPlass.w !== undefined) acc.s.pageWidthIn = acc.paperPlass.w;
    if (acc.paperPlass.h !== undefined) acc.s.pageHeightIn = acc.paperPlass.h;
  } else if (acc.paperTop) acc.s.page = acc.paperTop;

  // Out of range: normalizeSettings keeps the default; say so.
  const norm = normalizeSettings(acc.s);
  for (const field of Object.keys(acc.s) as Array<keyof DocSettings>) {
    if (norm[field] !== acc.s[field]) {
      const why = typeof acc.s[field] === 'number' ? 'is out of range' : 'is not allowed';
      warn(`${FIELD_PATH[field]}: ${show(field, acc.s[field])} ${why} — the default ${show(field, DEFAULT_SETTINGS[field])} is kept`);
      delete acc.s[field];
    }
  }
  out.settings = acc.s;
  out.frontMatterRestart = acc.restart;
  out.extra = joinExtra(parts);
  return out;
}

const dropTrailingNewlines = (v: string | null): string | null => (v === null ? null : v.replace(/\n+$/, ''));

function readTop(key: string, n: YNode, out: FrontmatterRead, acc: Acc): void {
  const s = acc.s;
  switch (key) {
    case 'title':
      out.titleMd = dropTrailingNewlines(text(n));
      return;
    case 'date':
      out.dateMd = dropTrailingNewlines(text(n));
      return;
    case 'abstract':
      out.abstractMd = dropTrailingNewlines(text(n));
      return;
    case 'author':
      out.authorsMd = authors(n, acc.warn);
      return;
    case 'papersize': {
      const v = text(n);
      const page = v === null ? undefined : PAPER_READ[v.toLowerCase()];
      if (!page) throw new Invalid(`${describe(n)} is not one of us-letter, a4, us-legal, iso-b5, a5`);
      acc.paperTop = page;
      return;
    }
    case 'margin': {
      if (n.t !== 'map') {
        const v = length(n, 'in');
        for (const f of MARGINS) s[f] = v;
        return;
      }
      // Typst's margin dict: `rest`, then `x`/`y`, then the sides.
      const sides: Partial<Record<(typeof MARGINS)[number], number>> = {};
      const order = ['rest', 'x', 'y', 'top', 'right', 'bottom', 'left'];
      const given = new Map(n.entries);
      for (const k of given.keys()) if (!order.includes(k)) acc.warn(`margin.${k} is not a margin side — ignored`);
      for (const k of order) {
        const v = given.get(k);
        if (!v) continue;
        let len: number;
        try {
          len = length(v, 'in');
        } catch (e) {
          if (!(e instanceof Invalid)) throw e;
          acc.warn(`margin.${k}: ${e.message} — ignored`);
          continue;
        }
        const targets: Record<string, Array<(typeof MARGINS)[number]>> = {
          rest: [...MARGINS], x: ['marginLeft', 'marginRight'], y: ['marginTop', 'marginBottom'],
          top: ['marginTop'], right: ['marginRight'], bottom: ['marginBottom'], left: ['marginLeft'],
        };
        for (const f of targets[k]) sides[f] = len;
      }
      Object.assign(s, sides);
      return;
    }
    case 'fontsize':
      s.sizePt = length(n, 'pt');
      return;
    case 'mainfont': {
      const v = text(n);
      if (v === null) throw new Invalid('expected a font name');
      s.font = v;
      return;
    }
    case 'section-numbering': {
      if (isNull(n)) s.numberSections = false;
      else if (n.t === 'scalar' && n.plain && /^(?:true|True|TRUE|false|False|FALSE)$/.test(n.value)) s.numberSections = bool(n);
      else {
        const v = text(n) ?? '';
        s.numberSections = v !== '';
        if (v !== '' && v !== '1.1') acc.warn(`section-numbering: Plass numbers sections "1.1", not ${scalar(v)}`);
      }
      return;
    }
    case 'bibliography': {
      if (isNull(n)) return;
      const files = n.t === 'seq' ? n.items : [n];
      const first = files[0] ? text(files[0]) : null;
      if (!first) throw new Invalid('expected a file path');
      if (files.length > 1) acc.warn(`bibliography: only the first file (${scalar(first)}) is read`);
      out.bibliography = first;
      return;
    }
    case 'linestretch':
      s.lineHeight = number(n);
      return;
    case 'indent':
      s.parIndent = bool(n);
      return;
    case 'bibliographystyle':
      s.citationStyle = choice(n, CITATION_STYLE_NAMES);
      return;
  }
}

function authors(n: YNode, warn: (m: string) => void): string | null {
  if (isNull(n)) return null;
  if (n.t === 'scalar') return dropTrailingNewlines(n.value);
  const names: string[] = [];
  let dropped = false;
  for (const item of n.t === 'seq' ? n.items : [n]) {
    if (isNull(item)) continue;
    if (item.t === 'scalar') names.push(item.value);
    else if (item.t === 'map') {
      const name = item.entries.find(([k]) => k === 'name')?.[1];
      if (!name || name.t !== 'scalar') throw new Invalid('an author is a name, or a map with a name:');
      names.push(name.value);
      if (item.entries.length > 1) dropped = true;
    } else throw new Invalid('an author is a name, or a map with a name:');
  }
  if (dropped) warn('author: only the names are kept (affiliations and other fields are dropped)');
  return names.length ? names.join(', ') : null;
}

/** The `plass:` entry. Known children are read; unknown ones, comments and
 *  children that cannot be read come back as a `plass` extra part (two-space
 *  indented child lines) for the writer to put back into the plass block. */
function readPlass(raw: string[], acc: Acc): ExtraPart | null {
  const head = KEY_RE.exec(raw[0])!;
  const inline = head[2] ?? '';
  const kept: string[] = [];
  const child = (key: string, value: YNode, rawLines: string[] | null): void => {
    if (!KNOWN_PLASS.has(key)) {
      acc.warn(`plass.${key} is not a Plass setting — kept as written`);
      kept.push(...(rawLines ?? [`  ${scalar(key)}:${value.t === 'null' ? '' : ' ' + emitNode(value)}`]));
      return;
    }
    try {
      readPlassChild(key, value, acc);
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      acc.warn(`plass.${key}: ${e.message} — ignored`);
    }
  };
  if (!isBlank(inline) && !isComment(inline)) {
    // `plass: {…}` on one line.
    const notes: string[] = [];
    let node: YNode;
    try {
      node = parseEntry(raw, 0, notes).value;
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      acc.warn(`plass: ${e.message} — kept as written`);
      return { kind: 'lines', lines: raw };
    }
    for (const note of notes) acc.warn(`plass: ${note}`);
    if (node.t !== 'map') {
      if (!isNull(node)) {
        acc.warn(`plass: expected a map, found ${describe(node)} — kept as written`);
        return { kind: 'lines', lines: raw };
      }
      return null;
    }
    for (const [key, value] of node.entries) child(key, value, null);
    return kept.length ? { kind: 'plass', lines: kept } : null;
  }
  const cont = raw.slice(1);
  const first = cont.find((line) => !isBlank(line) && !isComment(line));
  if (!first) return { kind: 'plass', lines: reindent(cont, indentOf(cont.find((l) => !isBlank(l)) ?? ''), 2) };
  const ci = indentOf(first);
  const items = splitItems(cont, ci);
  // A child given twice: the last one is read.
  const lastAt = new Map<string, number>();
  items.forEach((item, k) => {
    if (item.kind === 'entry') lastAt.set(keyOf(cont[item.start], ci)!, k);
  });
  items.forEach((item, k) => {
    const rawLines = reindent(cont.slice(item.start, item.end), ci, 2);
    if (item.kind === 'blank' || item.kind === 'comment') return kept.push(...rawLines);
    if (item.kind === 'stray') {
      acc.warn(`plass: the line "${cont[item.start].trim()}" is not a "key: value" entry — kept as written`);
      return kept.push(...rawLines);
    }
    const key = keyOf(cont[item.start], ci)!;
    if (lastAt.get(key) !== k) {
      acc.warn(`plass.${key} is given twice — the last one is read`);
      return;
    }
    if (!KNOWN_PLASS.has(key)) return child(key, { t: 'null' }, rawLines);
    const notes: string[] = [];
    let value: YNode;
    try {
      value = parseEntry(cont.slice(item.start, item.end), ci, notes).value;
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      acc.warn(`plass.${key}: ${e.message} — kept as written`);
      return kept.push(...rawLines);
    }
    for (const note of notes) acc.warn(`plass.${key}: ${note}`);
    child(key, value, rawLines);
  });
  return { kind: 'plass', lines: kept };
}

function readPlassChild(key: string, n: YNode, acc: Acc): void {
  const s = acc.s;
  // Each field of a sub-map on its own: one bad value leaves the rest.
  const fields = (path: string, readers: Record<string, (v: YNode) => void>): void => {
    for (const [k, v] of entriesOf(n)) {
      const read = readers[k];
      if (!read) {
        acc.warn(`plass.${path}.${k} is not a Plass setting — ignored`);
        continue;
      }
      try {
        read(v);
      } catch (e) {
        if (!(e instanceof Invalid)) throw e;
        acc.warn(`plass.${path}.${k}: ${e.message} — ignored`);
      }
    }
  };
  switch (key) {
    case 'page': {
      if (n.t === 'map') {
        const page: { page: PaperName; w?: number; h?: number } = { page: 'custom' };
        fields('page', {
          width: (v) => (page.w = length(v, 'in')),
          height: (v) => (page.h = length(v, 'in')),
        });
        if (page.w === undefined || page.h === undefined) throw new Invalid('a custom page needs both width and height');
        acc.paperPlass = page;
        return;
      }
      const v = text(n);
      const page = v === null ? undefined : PAPER_READ[v.toLowerCase()];
      if (!page) throw new Invalid(`${describe(n)} is not half-letter, a paper name, or {width, height}`);
      acc.paperPlass = { page };
      return;
    }
    case 'landscape':
      s.landscape = bool(n);
      return;
    case 'hyphenate':
      s.hyphenate = bool(n);
      return;
    case 'number-equations':
      s.numberEquations = bool(n);
      return;
    case 'page-numbers':
      fields('page-numbers', {
        show: (v) => (s.pageNumShow = bool(v)),
        format: (v) => (s.pageNumFormat = choice(v, PAGE_NUM_FORMATS)),
        align: (v) => (s.pageNumAlign = choice(v, ALIGNS)),
        place: (v) => (s.pageNumPlace = choice(v, ['bottom', 'top'] as const)),
        start: (v) => (s.pageNumStart = number(v)),
        'front-matter': (v) => {
          if (isNull(v) || (v.t === 'scalar' && /^(?:arabic|none|false)$/.test(v.value))) acc.restart = false;
          else if (v.t === 'scalar' && v.value === 'roman') acc.restart = true;
          else throw new Invalid(`${describe(v)} is not roman`);
        },
      });
      return;
    case 'header':
    case 'footer': {
      const H = key === 'header';
      fields(key, {
        text: (v) => {
          const t = dropTrailingNewlines(text(v)) ?? '';
          if (H) s.headerText = t;
          else s.footerText = t;
        },
        align: (v) => {
          const a = choice(v, ALIGNS);
          if (H) s.headerAlign = a;
          else s.footerAlign = a;
        },
        'first-page': (v) => {
          const b = bool(v);
          if (H) s.headerFirstPage = b;
          else s.footerFirstPage = b;
        },
      });
      return;
    }
    case 'footnotes':
      fields('footnotes', {
        numbering: (v) => (s.footnoteNumbering = choice(v, FOOTNOTE_NUMBERINGS)),
        separator: (v) => (s.footnoteSeparator = choice(v, FOOTNOTE_SEPARATORS)),
      });
      return;
    case 'math-macros':
      s.mathMacros = dropTrailingNewlines(text(n)) ?? '';
      return;
  }
}

// ---------------------------------------------------------------- writing

/** The front matter block (`---` … `---`, no trailing newline), or '' when
 *  there is nothing to write. Known keys first, in the plan's order and
 *  only when not the default; then `extra`, verbatim. An extra entry whose
 *  key the document now writes is dropped (with a warning); so is a
 *  `---`/`...` line, which would end the block. `bibliography:` is never
 *  written: the bibliography is embedded in the body. */
export function writeFrontmatter(fm: FrontmatterFields, warn: (m: string) => void = () => {}): string {
  const s = normalizeSettings(fm.settings ?? null);
  const D = DEFAULT_SETTINGS;
  const top: string[] = [];
  const written = new Set<string>();
  const put = (key: string, ...lines: string[]): void => {
    lines[0] = `${key}: ${lines[0]}`;
    top.push(...lines);
    written.add(key);
  };
  const block = (key: string, value: string): void => {
    const lines = blockLines(key, value, 2);
    if (lines) {
      top.push(...lines);
      written.add(key);
    } else put(key, scalar(value.replace(/\n+$/, '')));
  };

  if (fm.titleMd != null) put('title', scalar(fm.titleMd));
  if (fm.authorsMd != null) put('author', scalar(fm.authorsMd));
  if (fm.dateMd != null) put('date', scalar(fm.dateMd));
  if (fm.abstractMd != null) block('abstract', fm.abstractMd);
  const named = PAPER_YAML[s.page];
  if (named) put('papersize', named);
  if (MARGINS.some((f) => s[f] !== D[f])) {
    put('margin', `{top: ${num(s.marginTop)}in, right: ${num(s.marginRight)}in, bottom: ${num(s.marginBottom)}in, left: ${num(s.marginLeft)}in}`);
  }
  if (s.sizePt !== D.sizePt) put('fontsize', `${num(s.sizePt)}pt`);
  if (s.font !== D.font) put('mainfont', scalar(s.font));
  if (s.numberSections) put('section-numbering', scalar('1.1'));
  if (s.lineHeight !== D.lineHeight) put('linestretch', num(s.lineHeight));
  if (s.parIndent) put('indent', 'true');
  if (s.citationStyle !== D.citationStyle) put('bibliographystyle', s.citationStyle);

  const plass: string[] = [];
  const plassKeys = new Set<string>();
  const sub = (key: string, ...lines: string[]): void => {
    plass.push(`  ${key}: ${lines[0]}`, ...lines.slice(1));
    plassKeys.add(key);
  };
  const flow = (pairs: Array<[string, string | number | boolean, string | number | boolean]>): string | null => {
    const set = pairs.filter(([, v, d]) => v !== d);
    return set.length ? `{${set.map(([k, v]) => `${k}: ${typeof v === 'string' ? scalar(v, true) : String(v)}`).join(', ')}}` : null;
  };
  if (s.page === 'half-letter') sub('page', 'half-letter');
  else if (s.page === 'custom') sub('page', `{width: ${num(s.pageWidthIn)}in, height: ${num(s.pageHeightIn)}in}`);
  if (s.landscape !== D.landscape) sub('landscape', String(s.landscape));
  if (s.hyphenate !== D.hyphenate) sub('hyphenate', String(s.hyphenate));
  if (s.numberEquations !== D.numberEquations) sub('number-equations', String(s.numberEquations));
  const pageNumbers = flow([
    ['show', s.pageNumShow, D.pageNumShow],
    ['format', s.pageNumFormat, D.pageNumFormat],
    ['align', s.pageNumAlign, D.pageNumAlign],
    ['place', s.pageNumPlace, D.pageNumPlace],
    ['start', s.pageNumStart, D.pageNumStart],
    ['front-matter', fm.frontMatterRestart ? 'roman' : '', ''],
  ]);
  if (pageNumbers) sub('page-numbers', pageNumbers);
  for (const [key, t, align, first, dAlign, dFirst] of [
    ['header', s.headerText, s.headerAlign, s.headerFirstPage, D.headerAlign, D.headerFirstPage],
    ['footer', s.footerText, s.footerAlign, s.footerFirstPage, D.footerAlign, D.footerFirstPage],
  ] as const) {
    const v = flow([
      ['text', t, ''],
      ['align', align, dAlign],
      ['first-page', first, dFirst],
    ]);
    if (v) sub(key, v);
  }
  const footnotes = flow([
    ['numbering', s.footnoteNumbering, D.footnoteNumbering],
    ['separator', s.footnoteSeparator, D.footnoteSeparator],
  ]);
  if (footnotes) sub('footnotes', footnotes);
  if (s.mathMacros.trim()) {
    const lines = blockLines('math-macros', s.mathMacros, 4);
    if (lines) {
      plass.push('  ' + lines[0], ...lines.slice(1));
      plassKeys.add('math-macros');
    } else sub('math-macros', scalar(s.mathMacros.replace(/\n+$/, '')));
  }

  // The kept extra: unknown keys and comments in order; a kept `plass:`
  // block's children join the plass block written above.
  const rest: string[] = [];
  const plassKept: string[] = [];
  const extra = (fm.extra ?? '').replace(/\r\n?/g, '\n');
  const lines = extra.split('\n');
  let pendingBlank = false;
  const keep = (raw: string[]): void => {
    if (pendingBlank && rest.length) rest.push('');
    pendingBlank = false;
    rest.push(...raw);
  };
  for (const item of splitItems(lines, 0)) {
    const raw = lines.slice(item.start, item.end);
    if (item.kind === 'blank') {
      pendingBlank = true;
      continue;
    }
    if (item.kind === 'stray' && DELIMITER.test(raw[0])) {
      warn(`front matter: a "${raw[0].trim()}" line would end the block — dropped`);
      continue;
    }
    const key = item.kind === 'entry' ? keyOf(raw[0], 0) : null;
    const inline = item.kind === 'entry' ? (KEY_RE.exec(raw[0])![2] ?? '') : '';
    if (key === 'plass' && (isBlank(inline) || isComment(inline))) {
      const cont = raw.slice(1);
      const ci = indentOf(cont.find((line) => !isBlank(line) && !isComment(line)) ?? cont.find((l) => !isBlank(l)) ?? '');
      for (const child of splitItems(cont, ci)) {
        const childRaw = reindent(cont.slice(child.start, child.end), ci, 2);
        const childKey = child.kind === 'entry' ? keyOf(cont[child.start], ci) : null;
        if (childKey !== null && plassKeys.has(childKey)) {
          warn(`front matter: the document's plass.${childKey} replaces the one kept from the file`);
          continue;
        }
        plassKept.push(...childRaw);
      }
      continue;
    }
    if (key !== null && written.has(key)) {
      warn(`front matter: the document's ${key} replaces the one kept from the file`);
      continue;
    }
    if (key === 'bibliography') {
      warn('front matter: bibliography: is not written — the bibliography is embedded in the document');
      continue;
    }
    if (key === 'plass' && plass.length) {
      warn("front matter: the document's plass settings replace the plass entry kept from the file");
      continue;
    }
    keep(raw);
  }

  const kept = trimBlank(plassKept);
  if (plass.length || kept.length) top.push('plass:', ...plass, ...kept);
  const all = [...top, ...rest];
  return all.length ? `---\n${all.join('\n')}\n---` : '';
}
