// Pandoc Markdown front matter: the YAML metadata block at the top of a
// Plass `.md` (docs/MARKDOWN-SOURCE-PLAN.md, "The format › Front matter").
//
// A YAML subset, read and written with no dependency: plain, single- and
// double-quoted scalars (double-quoted escapes decoded as YAML 1.2 — and
// pandoc — decode them), block maps at any depth, flow maps and lists,
// block lists, block scalars (`|`, `>`, chomping and indentation
// indicators) and `#` comments. An anchor (`&a`) or tag (`!t`) is skipped
// and the value after it read (only `!!str` means anything: text), and an
// alias (`*a`) of an anchor read earlier is that anchor's value, as pandoc
// reads them; a value Plass carries but has to re-emit keeps its anchors
// and aliases as written. A boolean is any of YAML 1.1's spellings pandoc
// 3.4 reads as one (`yes`, `No`, `on`, `OFF`, `y`, `n` as well as `true`
// and `false`), so `section-numbering: no` is off, as it is to pandoc; the
// writer writes `true` and `false`. Tabs are expanded to four-column stops
// first, as pandoc expands them.
//
// Known keys are interpreted: pandoc's own names for the big knobs, Plass's
// settings under one `plass:` key (which pandoc ignores). Everything else —
// unknown keys, `#` comments, an entry that cannot be read — is carried, in
// order, in `extra` (doc.attrs.frontmatter) and written back after the known
// keys: an entry as written, a comment as a whole line at the margin of the
// block it sat in. (The `plass:` block is written with the known keys,
// unless a kept child of it aliases an anchor a kept entry before it
// defines: then where it was, after that anchor.) A comment inside or
// beside a known key moves out of it, since Plass rewrites that key.
// title, author, date and abstract come back as RAW Markdown for the body
// reader to parse; this module never interprets Markdown. The writer emits
// only non-default settings, in the plan's fixed order, `margin` as a dict,
// and every scalar in a form that needs no backslash escaping (plain when
// YAML reads it back as the same string, else single-quoted), so `$\beta$`
// survives a save.
//
// Where pandoc rejects a file whose intent is plain (an unquoted `: ` or a
// leading `*` in a title, an unknown `\` escape), the reader takes the
// intent, warns, and the next save writes the value in a form pandoc reads.
//
// The file is untrusted: every pattern here runs in time linear in its
// input; nesting is capped and an alias is never expanded (a few anchors
// that each alias the one before would grow exponentially), so a crafted
// file can neither overflow the stack nor exhaust memory; and a key read
// from the file is looked up among own properties only (`valueOf` is no
// setting).

import { DEFAULT_SETTINGS, FOOTNOTE_NUMBERINGS, FOOTNOTE_SEPARATORS, normalizeSettings, type DocSettings, type PaperName } from './settings';
import { CITATION_STYLES } from './citation-styles';

/** The keys whose values are the document's own text (Markdown). */
export type TextKey = 'title' | 'author' | 'date' | 'abstract';

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
  /** Text keys whose entry `extra` keeps as written (a double-quoted value
   *  whose escape reads as LaTeX, `"\today"`: see readFrontmatter) and the
   *  document has not edited: that entry is written in the key's place, as
   *  it was, instead of the value. Such an entry for a key not listed here
   *  was edited (or its block deleted): it is dropped, silently. */
  asWritten?: readonly TextKey[];
}

export interface FrontmatterRead {
  titleMd: string | null;
  authorsMd: string | null;
  dateMd: string | null;
  abstractMd: string | null;
  /** Only the settings the YAML sets, each valid (an invalid one is warned and left out). */
  settings: Partial<DocSettings>;
  /** `bibliography:` — a sidecar path to read once (the Markdown reader
   *  carries the line in `extra` until it is: bibliographyEntry). */
  bibliography?: string;
  /** Every file `bibliography:` names, the first one (`bibliography`)
   *  included: pandoc reads them all, Plass the first. */
  bibliographyFiles?: string[];
  frontMatterRestart: boolean;
  extra: string;
  warnings: string[];
  /** The text after the closing `---`/`...` line; the whole input when it opens with no metadata block. */
  body: string;
  /** The first line at the block's top level that is not YAML at all,
   *  where no entry can hold it — a list item, or prose after a blank line
   *  — when the block has one. Never a `key: value` line (however
   *  indented), a comment, a line a quoted or flow value continues, YAML
   *  this subset keeps as written (an anchored or tagged key, a `?`
   *  complex key), nor a line directly under an entry (kept as written).
   *  Pandoc rejects such a block; the Markdown reader then reads the file
   *  as having no front matter, so a document that opens with a horizontal
   *  rule never loses its text into one. Everything above is read as
   *  usual. */
  notYaml?: string;
  /** What YAML reads the block as when it is not a map (keys and values)
   *  — 'a list' or 'text' — and so neither Plass nor pandoc takes it for
   *  front matter: `body` is then the whole input. Unset when there is no
   *  `---` block at all. */
  notMap?: 'a list' | 'text';
}

// ---------------------------------------------------------------- the YAML subset

/** `anchor`: the anchor (`&a`) written on this node. `alias`: set on what
 *  an alias (`*a`) reads — a shallow copy of the anchored node, so a reader
 *  sees its value and a writer writes `*a`, never the value again. */
type YProps = { anchor?: string; alias?: string };
type YScalar = { t: 'scalar'; plain: boolean; value: string } & YProps;
type YMap = { t: 'map'; entries: Array<[string, YNode]> } & YProps;
type YSeq = { t: 'seq'; items: YNode[] } & YProps;
type YNode = YScalar | YMap | YSeq | ({ t: 'null' } & YProps);

/** YAML this subset cannot read: the entry is kept as written. */
class YamlError extends Error {}

/** What reading a value gathers besides the value. */
interface Ctx {
  /** Warnings: how pandoc reads a form, or that it rejects one. */
  notes: string[];
  /** The `# …` comments passed inside the value, in order. */
  comments: string[];
  /** The anchors (`&a`) read so far in the block, for an alias (`*a`) after them. */
  anchors: Map<string, YNode>;
  /** The anchors this value defines (a save drops them from a known key). */
  defined: string[];
  depth: number;
  /** The value is a text key's (title, author, date, abstract). */
  textKey: boolean;
  /** A double-quoted escape in it reads as LaTeX (`"\today"`): a text key's
   *  entry is then kept as written, beside the value read. */
  keepRaw: boolean;
}

const context = (anchors: Map<string, YNode> = new Map()): Ctx => ({ notes: [], comments: [], anchors, defined: [], depth: 0, textKey: false, keepRaw: false });

/** Values nested deeper than this are not read (kept as written). Plass
 *  reads three levels (`plass.page-numbers.start`); each level rescans the
 *  lines below it, so the cap also bounds the work on a crafted file. */
const MAX_DEPTH = 16;

function nest<T>(cx: Ctx, read: () => T): T {
  if (cx.depth >= MAX_DEPTH) throw new YamlError(`nested more than ${MAX_DEPTH} levels deep`);
  cx.depth++;
  try {
    return read();
  } finally {
    cx.depth--;
  }
}

const isBlank = (line: string): boolean => /^[ \t]*$/.test(line);
const isComment = (line: string): boolean => /^[ \t]*#/.test(line);
/** A line that is neither blank nor a comment. */
const isContent = (line: string): boolean => !isBlank(line) && !isComment(line);
const indentOf = (line: string): number => {
  const k = line.search(/[^ ]/);
  return k < 0 ? line.length : k;
};
/** Tabs expanded to the next multiple of four columns, as pandoc expands
 *  every tab in its input before it reads anything (so a tab-indented
 *  child of `plass:` is nested, four columns in). */
function detab(line: string): string {
  if (!line.includes('\t')) return line;
  let out = '';
  let col = 0;
  for (const ch of line) {
    const n = ch === '\t' ? 4 - (col % 4) : 1;
    out += ch === '\t' ? ' '.repeat(n) : ch;
    col += n;
  }
  return out;
}
const SEQ_ITEM = /^-(?:[ \t]|$)/;

/** The least indentation of the lines that hold content (0 when none does). */
function baseIndent(lines: string[]): number {
  let least = Infinity;
  for (const line of lines) if (isContent(line)) least = Math.min(least, indentOf(line));
  return least === Infinity ? 0 : least;
}

/** next[k]: the first line at or after k that holds content (lines.length when none does). */
function nextContent(lines: string[]): number[] {
  const next = new Array<number>(lines.length + 1);
  next[lines.length] = lines.length;
  for (let k = lines.length - 1; k >= 0; k--) next[k] = isContent(lines[k]) ? k : next[k + 1];
  return next;
}

/** `s` without its trailing line breaks (a loop: `/\n+$/` is quadratic on a long run of them). */
function trimNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '\n') end--;
  return s.slice(0, end);
}

/** `into.push(...lines)` without spreading: a kept block can hold more lines than a call takes arguments. */
function append(into: string[], lines: string[]): void {
  for (const line of lines) into.push(line);
}

/** File text quoted in a warning, cut short. */
const clip = (s: string): string => (s.length > 60 ? s.slice(0, 57) + '…' : s);

interface KeyLine {
  /** The key as written: quoted, or plain with any spaces before the colon. */
  raw: string;
  /** The rest of the line after the colon and its whitespace. */
  rest: string;
}

/** A `key:` line, from the key on: the colon is followed by whitespace or
 *  ends the line. A plain key may hold a colon no space follows (`a:b: c`
 *  is the key `a:b`); a ` #` before the colon makes the line a value and a
 *  comment, not a key. A scan, not one regex: the obvious pattern
 *  backtracks quadratically on a long run of spaces with no colon. */
function matchKey(s: string): KeyLine | null {
  const c = s[0];
  if (c === undefined) return null;
  let colon: number;
  let raw: string;
  if (c === '"' || c === "'") {
    let i = 1;
    for (;;) {
      if (i >= s.length) return null;
      const ch = s[i];
      if (c === '"' && ch === '\\') i += 2;
      else if (ch !== c) i++;
      else if (c === "'" && s[i + 1] === "'") i += 2;
      else break;
    }
    raw = s.slice(0, i + 1);
    colon = i + 1;
    while (s[colon] === ' ' || s[colon] === '\t') colon++;
    if (s[colon] !== ':') return null;
  } else {
    if (/[\s#'"{}[\],&*!|>%@`]/.test(c)) return null;
    // `-`, `?` and `:` start a plain key only when text follows at once.
    if ((c === '-' || c === '?' || c === ':') && !/\S/.test(s[1] ?? ' ')) return null;
    const m = /:(?=[ \t]|$)|[ \t]#/.exec(s);
    if (!m || m[0] !== ':') return null;
    colon = m.index;
    raw = s.slice(0, colon);
  }
  const after = s.slice(colon + 1);
  if (after !== '' && after[0] !== ' ' && after[0] !== '\t') return null;
  return { raw, rest: after.replace(/^[ \t]+/, '') };
}

/** A line YAML reads as part of a map that this subset does not: a key
 *  after an anchor or a tag (`&a key: v`, `!!str key: v`, both read by
 *  pandoc), or a complex key's `? key` and `: value` lines. Kept as
 *  written, never taken for prose. */
const yamlOnly = (s: string): boolean => /^[?:](?:[ \t]|$)/.test(s) || (/^[&!]/.test(s) && matchKey(afterProperties(s)) !== null);

function decodeKey(raw: string): string {
  if (raw.startsWith('"')) return (new FlowReader(raw, context()).node() as YScalar).value;
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw.trim();
}

function keyOf(line: string, indent: number): string | null {
  const m = matchKey(line.slice(indent));
  return m ? decodeKey(m.raw) : null;
}

interface Item {
  kind: 'entry' | 'comment' | 'blank' | 'stray';
  start: number;
  end: number;
}

/** Whether a quoted scalar or a flow collection (`[…]`, `{…}`) is still
 *  open after the lines fed to it. YAML continues one on the lines after it
 *  at any indentation, the margin included: pandoc reads `keywords: [a,`
 *  over `b]`, and a quoted title folded onto a line at the margin. Only the
 *  value a line starts (after its `- `, its key, an anchor or tag) is
 *  scanned; a block scalar's text and a plain value's continuation lines
 *  (indented deeper than their node) are passed over, never scanned, so a
 *  quote in prose there opens nothing. */
class OpenFlow {
  /** The brackets open, innermost last. */
  private brackets: string[] = [];
  private quote: '"' | "'" | null = null;
  /** Lines indented deeper than this column continue a block scalar or a
   *  plain value: not scanned (-1: none). */
  private passOver = -1;

  get open(): boolean {
    return this.quote !== null || this.brackets.length > 0;
  }

  line(l: string): void {
    if (this.open) return this.scan(l, 0);
    if (!isContent(l)) return;
    const ind = indentOf(l);
    if (this.passOver >= 0 && ind > this.passOver) return;
    this.passOver = -1;
    // The node the line starts, and the column it belongs to: after its
    // `- ` indicators and one key (a second `key: ` on the line is a plain
    // value's text to this scan — YAML rejects it either way).
    let at = ind;
    let col = ind;
    while (l[at] === '-' && (at + 1 === l.length || l[at + 1] === ' ' || l[at + 1] === '\t')) {
      col = at;
      at++;
      while (l[at] === ' ' || l[at] === '\t') at++;
    }
    const m = matchKey(l.slice(at));
    if (m) {
      col = at;
      at = l.length - m.rest.length;
    }
    const v = afterProperties(l.slice(at));
    if (v === '' || v[0] === '#') return;
    if ('"\'[{'.includes(v[0])) return this.scan(l, l.length - v.length);
    // Block text or a plain value: the lines deeper than its node continue it.
    this.passOver = col;
  }

  /** Scan from `from` until what is open closes (the rest of that line is
   *  the value's tail, a comment or a fault: not scanned). */
  private scan(l: string, from: number): void {
    // The last character before k on this line that is not a space ('' at its start).
    let last = '';
    for (let k = from; k < l.length; k++) {
      const c = l[k];
      if (this.quote === '"') {
        if (c === '\\') k++;
        else if (c === '"') this.quote = null;
      } else if (this.quote === "'") {
        if (c === "'" && l[k + 1] === "'") k++;
        else if (c === "'") this.quote = null;
      } else if (c === '"' || c === "'") {
        // A quote opens a scalar only where a node starts: not inside a plain one (`[it's]`).
        if (k === from || last === '' || '[{,:'.includes(last)) this.quote = c;
      } else if (c === '#' && (k === 0 || l[k - 1] === ' ' || l[k - 1] === '\t')) return;
      else if (c === '[' || c === '{') this.brackets.push(c);
      else if (c === ']' || c === '}') this.brackets.pop();
      if (!this.open) return;
      if (c !== ' ' && c !== '\t') last = c;
    }
  }
}

/** The end of a block item starting at `i`: past the lines `deeper` takes
 *  (and blank and comment lines between them); past every line a quoted
 *  or flow value left open takes, at any indentation, when `flow` — unless
 *  it never closes, which is not YAML: then null. */
function itemEnd(lines: string[], next: number[], i: number, deeper: (k: number) => boolean, indent: number, flow: boolean): number | null {
  const open = new OpenFlow();
  if (flow) open.line(lines[i]);
  let end = i + 1;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (open.open) {
      open.line(l);
      end = j + 1;
    } else if (isContent(l)) {
      if (!deeper(j)) break;
      end = j + 1;
      if (flow) open.line(l);
    } else if (indentOf(l) > indent) {
      // Spaces past the indent may be block text, a comment there the entry's own.
      end = j + 1;
    } else if (isComment(l) && !(next[j] < lines.length && deeper(next[j]))) break;
  }
  return open.open ? null : end;
}

/** Partition lines into the items of a block map at `indent`. An entry runs
 *  from its key line through every line indented deeper (and through a
 *  compact list, `- item` lines at the key's own indentation directly under
 *  a `key:` with no value on its line, an anchor or tag aside), and through
 *  any line a quoted or flow value left open continues (OpenFlow). Comment and blank lines are not content: one at the
 *  margin stays inside the entry when more of the entry follows it, and
 *  trailing blank lines are left out. Comments and blank lines between
 *  entries are items of their own; a line that is none of these is `stray`. */
function splitItems(lines: string[], indent: number): Item[] {
  const next = nextContent(lines);
  const items: Item[] = [];
  // A value left open to the end is not YAML: from there on, lines are
  // split by indentation alone (and each is scanned at most once more).
  let flow = true;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!isContent(line)) {
      items.push({ kind: isBlank(line) ? 'blank' : 'comment', start: i, end: i + 1 });
      i++;
      continue;
    }
    const m = indentOf(line) === indent ? matchKey(line.slice(indent)) : null;
    if (!m) {
      items.push({ kind: 'stray', start: i, end: i + 1 });
      i++;
      continue;
    }
    const first = next[i + 1];
    const bare = afterProperties(m.rest);
    const compact =
      (bare === '' || bare[0] === '#') && first < lines.length && indentOf(lines[first]) === indent && SEQ_ITEM.test(lines[first].slice(indent));
    const continues = (k: number): boolean => {
      const ni = indentOf(lines[k]);
      return ni > indent || (compact && ni === indent && SEQ_ITEM.test(lines[k].slice(indent)));
    };
    let end = flow ? itemEnd(lines, next, i, continues, indent, true) : null;
    if (end === null) {
      flow = false;
      end = itemEnd(lines, next, i, continues, indent, false)!;
    }
    items.push({ kind: 'entry', start: i, end });
    i = end;
  }
  return items;
}

/** One `key: value` entry: `lines[0]` is the key line at `indent`, the rest its continuation. */
function parseEntry(lines: string[], indent: number, cx: Ctx): { key: string; value: YNode } {
  const m = matchKey(lines[0].slice(indent));
  if (!m) throw new YamlError('not a "key: value" line');
  return { key: decodeKey(m.raw), value: parseValue(m.rest, lines.slice(1), indent, cx) };
}

/** The value after `key:` (or after `- `): `rest` is the rest of its line,
 *  `cont` the lines after it, `indent` the key's indentation. */
function parseValue(rest: string, cont: string[], indent: number, cx: Ctx): YNode {
  const props: Props = { anchors: [], str: false };
  const node = typed(valueOf(stripProperties(rest.trimStart(), cx, props), cont, indent, cx), props);
  for (const name of props.anchors) define(cx, name, node);
  return node;
}

function valueOf(rest: string, cont: string[], indent: number, cx: Ctx): YNode {
  const r = rest.trim();
  if (r === '' || r[0] === '#') {
    if (r) cx.comments.push(r);
    return parseNested(cont, indent, cx);
  }
  if (r[0] === '|' || r[0] === '>') return parseBlockScalar(r, cont, indent, cx);
  if ('"\'{['.includes(r[0])) {
    // Untrimmed at the end: a quoted line's trailing `\ ` is text.
    const reader = new FlowReader([rest, ...cont].join('\n'), cx);
    const node = reader.node();
    reader.end();
    return node;
  }
  if (r[0] === '*') {
    const node = alias(r, cont, cx);
    if (node) return node;
  }
  if ('*&%@`'.includes(r[0])) cx.notes.push(rejected(r[0]));
  return parsePlain(r, cont, cx);
}

/** One anchor (`&a`) or tag (`!t`, `!!str`) at the start of a value. */
const PROPERTY = /^(&[^\s,[\]{}]+|![^\s,[\]{}]*)(?=[\s,[\]{}]|$)[ \t]*/;

/** What the properties before a value say: the anchors it defines, and
 *  whether a `!!str` tag makes it text. */
interface Props {
  anchors: string[];
  str: boolean;
}

/** An anchor (`&a`) or tag (`!t`, `!!str`) before a value: pandoc reads the
 *  value after it, and so does Plass. Anchor names go to `props.anchors`
 *  (whether one is written back depends on where it is: dropAnchors). Of
 *  the tags pandoc 3.4 honors only `!!str` (verified with `-t json`:
 *  `!!str yes` and `!!str ~` are text, `!t yes`, `! yes`, `!!int yes` a
 *  boolean); so does Plass (`typed`), and warns that any other is ignored. */
function stripProperties(r: string, cx: Ctx, props: Props): string {
  for (;;) {
    const m = PROPERTY.exec(r);
    if (!m) return r;
    if (m[1][0] === '&') props.anchors.push(m[1].slice(1));
    else if (m[1] === '!!str') props.str = true;
    else cx.notes.push(`the YAML tag ${m[1]} is ignored`);
    r = r.slice(m[0].length);
  }
}

/** A plain value tagged `!!str` is text, never a boolean, a number or null:
 *  read as if it were quoted (`!!str` alone is the empty text). */
function typed(node: YNode, props: Props): YNode {
  if (!props.str || node.alias !== undefined) return node;
  if (node.t === 'null') return { t: 'scalar', plain: false, value: '' };
  if (node.t === 'scalar' && node.plain) return { ...node, plain: false };
  return node;
}

/** The rest of a line after its properties: what decides whether the value
 *  is on the lines below (a compact list may follow `key: &a`). */
const afterProperties = (r: string): string => {
  for (let m = PROPERTY.exec(r); m; m = PROPERTY.exec(r)) r = r.slice(m[0].length);
  return r;
};

function define(cx: Ctx, name: string, node: YNode): void {
  node.anchor = name;
  cx.anchors.set(name, node);
  cx.defined.push(name);
}

/** What the alias `*name` of `node` reads: its value, marked as the alias
 *  (one small object, however large the value is). */
const aliasOf = (name: string, node: YNode): YNode => ({ ...node, alias: name });

/** The names after every `*` (aliases) or `&` (anchors) that can start one, in one pass. */
function propertyNames(text: string, sigil: '*' | '&'): Set<string> {
  const names = new Set<string>();
  const re = sigil === '*' ? /(?:^|[\s[{,])\*([^\s,[\]{}]+)/g : /(?:^|[\s[{,])&([^\s,[\]{}]+)/g;
  for (const m of text.matchAll(re)) names.add(m[1]);
  return names;
}

/** `*a` alone (a comment may follow): the value of the anchor `&a` read
 *  earlier in the block, as pandoc reads it; null when none was. */
function alias(r: string, cont: string[], cx: Ctx): YNode | null {
  const m = /^\*([^\s,[\]{}]+)/.exec(r);
  const node = m ? cx.anchors.get(m[1]) : undefined;
  if (!m || !node || cont.some(isContent)) return null;
  const after = r.slice(m[0].length).trimStart();
  if (after && after[0] !== '#') return null;
  if (after) cx.comments.push(after);
  for (const line of cont) if (isComment(line)) cx.comments.push(line.trim());
  return aliasOf(m[1], node);
}

/** The note for an unquoted value pandoc's YAML reader rejects. */
const rejected = (c: string): string =>
  c === '*'
    ? 'a leading * is a YAML alias to pandoc, which rejects the file when it names no anchor; read as text'
    : c === '&'
      ? 'a bare & is an empty YAML anchor to pandoc, which rejects the file; read as text'
      : `YAML does not allow an unquoted value to start with ${c} (pandoc rejects the file); read as text`;

/** A value on the lines after its key: a block list, a block map, or a scalar. */
function parseNested(cont: string[], indent: number, cx: Ctx): YNode {
  return nest(cx, () => {
    let first = 0;
    for (; first < cont.length && !isContent(cont[first]); first++) {
      if (isComment(cont[first])) cx.comments.push(cont[first].trim());
    }
    if (first === cont.length) return { t: 'null' };
    const line = cont[first];
    const ci = indentOf(line);
    const body = line.slice(ci);
    if (SEQ_ITEM.test(body)) return parseSeq(cont.slice(first), ci, cx);
    if (ci <= indent) throw new YamlError('expected an indented value');
    if (matchKey(body)) return parseMap(cont.slice(first), ci, cx);
    return parseValue(body, cont.slice(first + 1), indent, cx);
  });
}

function parseMap(lines: string[], indent: number, cx: Ctx): YMap {
  const entries = new Map<string, YNode>();
  for (const item of splitItems(lines, indent)) {
    if (item.kind === 'blank') continue;
    if (item.kind === 'comment') {
      cx.comments.push(lines[item.start].trim());
      continue;
    }
    if (item.kind === 'stray') throw new YamlError(`unexpected line "${clip(lines[item.start].trim())}"`);
    const { key, value } = parseEntry(lines.slice(item.start, item.end), indent, cx);
    entries.delete(key); // the last one wins, as in pandoc
    entries.set(key, value);
  }
  return { t: 'map', entries: [...entries] };
}

function parseSeq(lines: string[], indent: number, cx: Ctx): YSeq {
  const next = nextContent(lines);
  const items: YNode[] = [];
  const deeper = (k: number): boolean => indentOf(lines[k]) > indent;
  let flow = true;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!isContent(line)) {
      if (isComment(line)) cx.comments.push(line.trim());
      i++;
      continue;
    }
    if (indentOf(line) !== indent || !SEQ_ITEM.test(line.slice(indent))) {
      throw new YamlError(`unexpected line "${clip(line.trim())}" in a list`);
    }
    // An item runs through the lines deeper than its dash, and through any
    // a quoted or flow value left open continues (`- "Alice` over `Smith"`).
    let end = flow ? itemEnd(lines, next, i, deeper, indent, true) : null;
    if (end === null) {
      flow = false;
      end = itemEnd(lines, next, i, deeper, indent, false)!;
    }
    // The dash becomes a space, so a compact map (`- name: x`) or a nested
    // list reads at its own column.
    const head = ' '.repeat(indent + 1) + line.slice(indent + 1);
    items.push(parseNested([head, ...lines.slice(i + 1, end)], indent, cx));
    i = end;
  }
  return { t: 'seq', items };
}

function parseBlockScalar(header: string, cont: string[], indent: number, cx: Ctx): YScalar {
  const m = /^([|>])([1-9])?([+-])?([1-9])?[ \t]*(#[\s\S]*)?$/.exec(header);
  if (!m || (m[2] && m[4])) throw new YamlError(`"${clip(header)}" is not a block-text header`);
  if (m[5]) cx.comments.push(m[5]);
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
      const tail = cont.slice(k);
      if (isComment(line) && !tail.some(isContent)) {
        for (const c of tail) if (isComment(c)) cx.comments.push(c.trim());
        break;
      }
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
function parsePlain(first: string, cont: string[], cx: Ctx): YScalar {
  let out = '';
  let blanks = 0;
  let ended = false;
  let colon = false;
  const take = (text: string, isFirst: boolean): void => {
    const hash = text.search(/(?:^|[ \t])#/);
    if (hash >= 0) {
      cx.comments.push(text.slice(hash).trim());
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
      if (!isComment(line)) throw new YamlError('text after a comment');
      cx.comments.push(line.trim());
      continue;
    }
    take(line, false);
  }
  if (colon) cx.notes.push('an unquoted ": " is not allowed in a YAML value (pandoc rejects the file); read as text');
  return { t: 'scalar', plain: true, value: out };
}

const ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
};

const codePoint = (c: string): string => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

/** Quoted scalars and flow collections, read from one string that may span lines. */
class FlowReader {
  private i = 0;
  constructor(
    private readonly s: string,
    private readonly cx: Ctx,
  ) {}

  /** Skip whitespace, line breaks and comments (a `#` after whitespace). */
  private ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\n') this.i++;
      else if (c === '#' && (this.i === 0 || /\s/.test(s[this.i - 1]))) {
        const start = this.i;
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        this.cx.comments.push(s.slice(start, this.i).trim());
      } else return;
    }
  }

  end(): void {
    this.ws();
    if (this.i < this.s.length) throw new YamlError(`unexpected "${clip(this.s.slice(this.i).split('\n', 1)[0])}" after the value`);
  }

  node(inFlow = false): YNode {
    this.ws();
    const found: Props = { anchors: [], str: false };
    const props = inFlow && (this.s[this.i] === '&' || this.s[this.i] === '!');
    if (props) {
      const rest = this.s.slice(this.i);
      this.i += rest.length - stripProperties(rest, this.cx, found).length;
      this.ws();
    }
    // A property with no value after it (`{a: !t, b: &x, c: *x}`) is an empty value.
    const empty = props && (this.i >= this.s.length || ',]}'.includes(this.s[this.i]));
    const node = typed(empty ? { t: 'null' } : this.bare(inFlow), found);
    for (const name of found.anchors) define(this.cx, name, node);
    return node;
  }

  private bare(inFlow: boolean): YNode {
    const c = this.s[this.i];
    if (c === '"') return this.double();
    if (c === "'") return this.single();
    if (c === '{') return nest(this.cx, () => this.map());
    if (c === '[') return nest(this.cx, () => this.seq());
    if (!inFlow) throw new YamlError('expected a quoted value or a flow collection');
    if (c === '*') {
      const m = /^\*([^\s,[\]{}]+)/.exec(this.s.slice(this.i));
      const node = m ? this.cx.anchors.get(m[1]) : undefined;
      if (m && node) {
        this.i += m[0].length;
        return aliasOf(m[1], node);
      }
    }
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
    const entries = new Map<string, YNode>();
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return { t: 'map', entries: [...entries] };
      }
      const key = this.key();
      this.ws();
      let value: YNode = { t: 'null' };
      if (this.s[this.i] === ':') {
        this.i++;
        value = this.value('}');
      }
      entries.delete(key); // the last one wins
      entries.set(key, value);
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
    if ('*&%@`'.includes(c)) this.cx.notes.push(rejected(c));
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
      } else if (Object.hasOwn(ESCAPES, e)) {
        out += ESCAPES[e];
        this.i += 2;
        // `"$\beta$"` is a backspace and "eta" to YAML — and to pandoc.
        if (/[a-zA-Z]/.test(e) && /[a-zA-Z]/.test(s[this.i] ?? '')) {
          const word = '\\' + e + /^[a-zA-Z]*/.exec(s.slice(this.i))![0];
          const ch = codePoint(ESCAPES[e]);
          // The document's own text is never rewritten out from under its
          // author: a text key's line is kept as written until the text is
          // edited (readFrontmatter); a setting's value is the setting.
          const save = this.cx.textKey ? `Plass writes the line back as it is until the text is edited` : `a save keeps ${ch}, not ${word}`;
          if (this.cx.textKey) this.cx.keepRaw = true;
          this.cx.notes.push(`"${word}" inside double quotes is the YAML escape \\${e} (${ch}), as pandoc reads it; ${save} — write LaTeX unquoted or in single quotes`);
        }
      } else {
        const width = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
        const hex = width ? s.slice(this.i + 2, this.i + 2 + width) : '';
        const code = hex.length === width && /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : -1;
        // A surrogate is no character: pandoc rejects its escape.
        if (code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
          out += String.fromCodePoint(code);
          this.i += 2 + width;
        } else {
          // Not a YAML escape: pandoc rejects the file; keep the backslash.
          out += '\\' + e;
          this.i += 2;
          this.cx.notes.push(`"\\${e}" inside double quotes is not a YAML escape (pandoc rejects the file); read as a backslash`);
        }
      }
      keep = out.length;
    }
  }
}

// ---------------------------------------------------------------- writing YAML scalars

/** The plain values pandoc 3.4 reads as booleans: YAML 1.1's, each one
 *  verified with `pandoc -t json` to be a MetaBool (a mixed case such as
 *  `yEs` or `tRue` is text, and so is any of these quoted or tagged
 *  `!!str`). Every boolean setting is read through these (`boolOf`). */
const YAML_TRUE: readonly string[] = ['true', 'True', 'TRUE', 'yes', 'Yes', 'YES', 'y', 'Y', 'on', 'On', 'ON'];
const YAML_FALSE: readonly string[] = ['false', 'False', 'FALSE', 'no', 'No', 'NO', 'n', 'N', 'off', 'Off', 'OFF'];

// Plain scalars a YAML reader would not read back as the same string: the
// core schema's null and numbers, YAML 1.1's booleans (pandoc's), and its
// sexagesimals and underscored numbers (other readers still use 1.1).
const NOT_A_STRING = new RegExp(
  String.raw`^(?:~|null|Null|NULL|${[...YAML_TRUE, ...YAML_FALSE].join('|')}|=|<<|[-+]?(?:\.?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|0[xob][0-9a-fA-F_]+|[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|\.(?:inf|Inf|INF))|\.(?:nan|NaN|NAN))$`,
);

/** Characters no plain, single-quoted or block scalar can hold: C0 and C1
 *  controls, DEL and U+FFFE/U+FFFF, which YAML does not allow as written;
 *  NEL, LS and PS, which pandoc's YAML reader takes as line breaks; the
 *  byte-order mark; and the tab, which pandoc turns into spaces before it
 *  reads the YAML. A line feed is handled by each writer. */
const UNWRITABLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/;
/** The same, with the line feed, as `\uXXXX` in a double-quoted scalar. */
const ESCAPED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g;
/** As written in a file: what the reader warns about (pandoc rejects the file, or breaks the line there). */
const NOT_YAML_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff]/g;

/** A lone surrogate has no UTF-8 form: U+FFFD, as any UTF-8 encoder writes it. */
const wellFormed = (v: string): string => v.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');

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
 *  (a line break or an UNWRITABLE character) is double-quoted, those
 *  characters as `\uXXXX` (never `\n` or `\t`, which a letter after them
 *  would make look like LaTeX to the reader's warning). */
function scalar(v: string, flow = false): string {
  v = wellFormed(v);
  if (v.includes('\n') || UNWRITABLE.test(v)) {
    return '"' + v.replace(/[\\"]/g, '\\$&').replace(ESCAPED, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '"';
  }
  return plainSafe(v, flow) ? v : `'${v.replace(/'/g, "''")}'`;
}

/** `key: |` block text, content at `indent` (two past the key). Trailing
 *  newlines are not part of the value (clip chomping writes one, the reader
 *  drops it); a first line that starts with a space gets an indicator. */
function blockLines(prefix: string, text: string, indent: number): string[] | null {
  const body = trimNewlines(wellFormed(text));
  if (!body || UNWRITABLE.test(body)) return null;
  const lines = body.split('\n');
  const first = lines.find((line) => line !== '') ?? '';
  const pad = ' '.repeat(indent);
  return [`${prefix}: |${/^[ \t]/.test(first) ? '2' : ''}`, ...lines.map((line) => (line ? pad + line : ''))];
}

/** Re-emit a parsed node on one line (an unknown child of a flow `plass:`
 *  map, an entry of a block written as one flow map), with its anchors and
 *  aliases as written: an alias is written `*a`, never its value again. So
 *  the output is as long as the input, give or take quoting, and nests as
 *  deep as the parse let it (an alias never restarts the depth count) —
 *  expanded, a few anchors that each alias the one before grow
 *  exponentially, and a long chain of them overflows the stack. The names
 *  of the anchors written are added to `anchors`. */
function emitNode(node: YNode, anchors: Set<string>): string {
  if (node.alias !== undefined) return `*${node.alias}`;
  let out: string;
  switch (node.t) {
    case 'null':
      out = '';
      break;
    case 'scalar':
      // Plain only when it reads back the same in a flow collection: a
      // boolean, number or null keeps its type; a string read in block
      // context may hold `, [ ] { }`, which end a plain value in a flow one.
      out = node.plain && NOT_A_STRING.test(node.value) ? node.value : scalar(node.value, true);
      break;
    case 'map':
      out = `{${node.entries.map(([k, v]) => `${scalar(k, true)}: ${emitNode(v, anchors)}`.trimEnd()).join(', ')}}`;
      break;
    case 'seq':
      out = `[${node.items.map((v) => emitNode(v, anchors)).join(', ')}]`;
      break;
  }
  if (node.anchor === undefined) return out;
  anchors.add(node.anchor);
  return out ? `&${node.anchor} ${out}` : `&${node.anchor}`;
}

/** A parsed entry as one block-map line, `key: value` (emitNode). */
const emitEntry = (key: string, value: YNode, anchors: Set<string>): string => {
  const v = emitNode(value, anchors);
  return `${scalar(key)}:${v ? ' ' + v : ''}`;
};

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
  typeof value === 'number' ? `${num(value)}${UNIT[field] ?? ''}` : typeof value === 'string' ? clip(scalar(value)) : String(value);

/** Typst's paper names (pandoc's `papersize` for Typst output). */
const PAPER_YAML: Partial<Record<PaperName, string>> = { a4: 'a4', legal: 'us-legal', b5: 'iso-b5', a5: 'a5' };
const PAPER_READ: Record<string, PaperName> = {
  'us-letter': 'letter', letter: 'letter', a4: 'a4', 'us-legal': 'legal', legal: 'legal',
  'iso-b5': 'b5', b5: 'b5', a5: 'a5', 'half-letter': 'half-letter', 'us-statement': 'half-letter',
};

/** `table[key]` for a key read from the file: own properties only, so
 *  `constructor` or `__proto__` is no entry, not something Object.prototype has. */
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** The paper a name means (`papersize`, `plass.page`), or undefined. */
const paperNamed = (n: YNode): PaperName | undefined => {
  const v = text(n);
  return v === null ? undefined : own(PAPER_READ, v.toLowerCase());
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
/** Where the plass block's children sit: the reader keeps a child there
 *  (re-indented from wherever the file had it), the writer looks for them
 *  there, so a stray line kept deeper stays a stray. */
const PLASS_INDENT = 2;

/** A value of the wrong kind or out of range: warned and left out. */
class Invalid extends Error {}

const isNull = (n: YNode): boolean => n.t === 'null' || (n.t === 'scalar' && n.plain && /^(?:~|null|Null|NULL)?$/.test(n.value));

function text(n: YNode): string | null {
  if (isNull(n)) return null;
  if (n.t !== 'scalar') throw new Invalid(`expected text, found a ${n.t === 'map' ? 'map' : 'list'}`);
  return n.value;
}

/** The boolean a value is to pandoc (YAML_TRUE, YAML_FALSE), or undefined. */
function boolOf(n: YNode): boolean | undefined {
  if (n.t !== 'scalar' || !n.plain) return undefined;
  return YAML_TRUE.includes(n.value) ? true : YAML_FALSE.includes(n.value) ? false : undefined;
}

function bool(n: YNode): boolean {
  const b = boolOf(n);
  if (b !== undefined) return b;
  // `"yes"` or `!!str yes`: the spelling of a boolean, written as text.
  const text = n.t === 'scalar' && (YAML_TRUE.includes(n.value) || YAML_FALSE.includes(n.value));
  throw new Invalid(`expected true or false, found ${describe(n)}${text ? ' (text, as quoted or tagged !!str: write it bare)' : ''}`);
}

// A number: digits with an optional fraction, or a bare fraction. One way
// to match each digit run (`\d+\.?\d*` has many, and backtracks
// quadratically on a long run of digits that fails to match).
const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)`;
const NUMBER_RE = new RegExp(`^${NUMBER}(?:[eE][-+]?\\d+)?$`);
const LENGTH_RE = new RegExp(`^(${NUMBER}(?:[eE][-+]?\\d+)?)[ \\t]*(in|mm|cm|pt)$`);
const BARE_RE = new RegExp(`^${NUMBER}$`);

function number(n: YNode): number {
  if (n.t === 'scalar' && NUMBER_RE.test(n.value.trim())) return Number(n.value);
  throw new Invalid(`expected a number, found ${describe(n)}`);
}

const PER_INCH = { in: 1, mm: 25.4, cm: 2.54, pt: 72 } as const;

function length(n: YNode, unit: 'in' | 'pt'): number {
  const m = n.t === 'scalar' ? LENGTH_RE.exec(n.value.trim()) : null;
  if (!m) {
    const bare = n.t === 'scalar' && BARE_RE.test(n.value.trim());
    throw new Invalid(bare ? `${clip(n.value.trim())} needs a unit (in, mm, cm or pt)` : `expected a length (in, mm, cm or pt), found ${describe(n)}`);
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
  if (n.t === 'scalar') return n.value === '' ? 'an empty value' : clip(scalar(n.value));
  return n.t === 'null' ? 'nothing' : n.t === 'map' ? 'a map' : 'a list';
}

function entriesOf(n: YNode): Array<[string, YNode]> {
  if (n.t !== 'map') throw new Invalid(`expected a map, found ${describe(n)}`);
  return n.entries;
}

// ---------------------------------------------------------------- reading

const DELIMITER = /^(?:---|\.\.\.)[ \t]*$/;
const MAX_WARNINGS = 50;

/** The metadata block at the top, as pandoc finds it: after any blank
 *  lines, a `---` line whose next line is not blank, closed by a `---` or
 *  `...` line. */
function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  let at = 0;
  for (;;) {
    const nl = text.indexOf('\n', at);
    if (nl < 0 || !isBlank(text.slice(at, nl))) break;
    at = nl + 1;
  }
  const open = /^---[ \t]*\n/.exec(text.slice(at));
  if (!open) return null;
  const rest = text.slice(at + open[0].length);
  if (/^[ \t]*(?:\n|$)/.test(rest)) return null;
  const close = /^(?:---|\.\.\.)[ \t]*$/m.exec(rest);
  if (!close) return null;
  let after = close.index + close[0].length;
  if (rest[after] === '\n') after++;
  return { yaml: rest.slice(0, close.index).replace(/\n$/, ''), body: rest.slice(after) };
}

type ExtraPart = { kind: 'blank' } | { kind: 'lines'; lines: string[] } | { kind: 'plass'; lines: string[] };

/** Join kept parts: runs of blank lines between parts collapse to one, none at the ends. */
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
    append(out, lines);
  }
  return out.join('\n');
}

/** Lines without the blank lines at their ends; the lines between are kept as they are (inside block text they are text). */
function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && isBlank(lines[a])) a++;
  while (b > a && isBlank(lines[b - 1])) b--;
  return lines.slice(a, b);
}

/** Shift lines from base indentation `from` to `to`, each keeping the
 *  indentation it has past `from` (a whitespace-only line too: inside
 *  block text it can be text); a line less indented than `from` (a comment
 *  at the margin) moves to `to`. */
function reindent(lines: string[], from: number, to: number): string[] {
  if (from === to) return lines;
  const pad = ' '.repeat(to);
  return lines.map((line) => {
    const ind = indentOf(line);
    if (isBlank(line)) return ind > from ? pad + line.slice(from) : '';
    return pad + (ind >= from ? line.slice(from) : line.trimStart());
  });
}

interface Acc {
  s: Partial<DocSettings>;
  paperTop: PaperName | null;
  paperPlass: { page: PaperName; w?: number; h?: number } | null;
  restart: boolean;
  warn: (m: string) => void;
  /** The block holds a `&`: kept entries are read for their anchors. */
  hasAnchors: boolean;
  anchors: Map<string, YNode>;
  /** Anchors defined inside known keys, which a save rewrites without them: [where, name]. */
  dropped: Array<[string, string]>;
}

/** A kept entry (written back as it is) read only for the anchors an alias
 *  after it may name, as pandoc reads them; when the block has none, not read. */
function scanAnchors(entry: string[], indent: number, acc: Acc): void {
  if (!acc.hasAnchors) return;
  try {
    parseEntry(entry, indent, context(acc.anchors));
  } catch (e) {
    if (!(e instanceof YamlError)) throw e;
  }
}

/** Anchors defined in a value a save rewrites without them: warned, and
 *  remembered so that an alias of one in a kept entry is warned about too. */
function dropAnchors(acc: Acc, where: string, names: Iterable<string>): void {
  for (const name of names) {
    acc.warn(`${where}: the YAML anchor &${clip(name)} is not written back`);
    acc.dropped.push([where, name]);
  }
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
  let orig = block.yaml ? block.yaml.split('\n') : [];
  let lines = orig.map(detab);
  // Pandoc takes the block as metadata only when YAML reads it as a map (or
  // as nothing: comments alone); a scalar or a list is body text to it.
  const firstContent = lines.find(isContent);
  const opener = firstContent?.trimStart()[0];
  if (firstContent !== undefined && opener !== '{' && opener !== '?' && !matchKey(firstContent.trim()) && !yamlOnly(firstContent.trim())) {
    // Not front matter, to pandoc either: the Markdown reader warns.
    out.notMap = SEQ_ITEM.test(firstContent.trim()) || opener === '[' ? 'a list' : 'text';
    return out;
  }
  out.body = block.body;
  // A crafted block can hold any number of faults: the first ones are listed, the rest counted.
  let unlisted = 0;
  const warn = (m: string): void => {
    if (out.warnings.length < MAX_WARNINGS) out.warnings.push(m);
    else unlisted++;
  };
  const bad = block.yaml.match(NOT_YAML_TEXT);
  if (bad) {
    warn(
      `front matter: ${bad.length === 1 ? 'a character' : `${bad.length} characters`} YAML does not allow as written (${codePoint(bad[0])}) — pandoc rejects the file or breaks the line there; the values Plass writes are escaped`,
    );
  }
  if (opener === '{') {
    // The whole block as one flow map: read on, one key per line.
    const cx = context();
    try {
      const reader = new FlowReader(lines.join('\n'), cx);
      const node = reader.node();
      reader.end();
      if (node.t === 'map') {
        for (const note of cx.notes) warn(`front matter: ${note}`);
        // Anchors and aliases are written as they are, never expanded (emitNode).
        const written = new Set<string>();
        orig = lines = [...node.entries.map(([k, v]) => emitEntry(k, v, written)), ...cx.comments];
      }
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
    }
  }
  // The keys sit at the least indentation: a uniformly indented block is a map too.
  const root = baseIndent(lines);
  const asWritten = (item: Item): string[] => (root ? reindent(lines.slice(item.start, item.end), root, 0) : orig.slice(item.start, item.end));
  const items = splitItems(lines, root);
  // A top-level line that is not YAML at all makes the block one pandoc
  // rejects: say which. Only where no entry can hold it — a list item (a
  // `key:` that takes one already has: splitItems), or prose after a blank
  // line, which is how a document that opens with a horizontal rule
  // reads. A line directly under an entry may be a mistyped continuation
  // of it, and one YAML reads that Plass does not (yamlOnly) is no fault:
  // both are kept as written, and the block stays front matter.
  const prose = items.find((item, k) => {
    if (item.kind !== 'stray') return false;
    const s = lines[item.start].trim();
    if (matchKey(s) || yamlOnly(s)) return false;
    return SEQ_ITEM.test(s) || items[k - 1]?.kind === 'blank';
  });
  if (prose) out.notYaml = clip(lines[prose.start].trim());
  const acc: Acc = { s: {}, paperTop: null, paperPlass: null, restart: false, warn, hasAnchors: block.yaml.includes('&'), anchors: new Map(), dropped: [] };
  const parts: ExtraPart[] = [];

  // A known key given twice: the last one is read, as pandoc does.
  const lastAt = new Map<string, number>();
  items.forEach((item, k) => {
    const key = item.kind === 'entry' ? keyOf(lines[item.start], root) : null;
    if (key && KNOWN_TOP.has(key)) {
      if (lastAt.has(key)) warn(`${key} is given twice — the last one is read`);
      lastAt.set(key, k);
    }
  });

  items.forEach((item, k) => {
    const entry = lines.slice(item.start, item.end);
    if (item.kind === 'blank') return parts.push({ kind: 'blank' });
    // A comment at the margin, where it cannot join the entry written before it.
    if (item.kind === 'comment') return parts.push({ kind: 'lines', lines: [orig[item.start].trimStart()] });
    if (item.kind === 'stray') {
      const s = entry[0].trim();
      warn(
        yamlOnly(s)
          ? `front matter line "${clip(s)}" is YAML Plass does not read (an anchor, a tag or a ? before a key) — kept as written`
          : `front matter line "${clip(s)}" is not a "key: value" entry — kept as written`,
      );
      return parts.push({ kind: 'lines', lines: asWritten(item) });
    }
    const key = keyOf(entry[0], root)!;
    if (!KNOWN_TOP.has(key)) {
      scanAnchors(entry, root, acc);
      return parts.push({ kind: 'lines', lines: asWritten(item) });
    }
    if (lastAt.get(key) !== k) return;
    if (key === 'plass') {
      const kept = readPlass(entry, root, acc);
      if (kept) parts.push(kept);
      return;
    }
    const cx = context(acc.anchors);
    cx.textKey = TEXT_KEYS.has(key);
    let value: YNode;
    try {
      value = parseEntry(entry, root, cx).value;
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      warn(`${key}: ${e.message} — kept as written`);
      return parts.push({ kind: 'lines', lines: asWritten(item) });
    }
    for (const note of cx.notes) warn(`${key}: ${note}`);
    try {
      readTop(key, value, out, acc);
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      if (TEXT_KEYS.has(key)) {
        warn(`${key}: ${e.message} — kept as written`);
        return parts.push({ kind: 'lines', lines: asWritten(item) });
      }
      warn(`${key}: ${e.message} — ignored`);
    }
    // A text key whose double-quoted value decodes an escape that reads as
    // LaTeX (`date: "\today"` is a tab and "oday" to YAML and pandoc): the
    // value is read, and the entry is kept as written beside it, so that a
    // save leaves the author's text alone until the document edits it
    // (writeFrontmatter's `asWritten`). Its comments and anchors are in its
    // lines.
    if (cx.keepRaw) return parts.push({ kind: 'lines', lines: asWritten(item) });
    // The key is rewritten; its comments stay, as whole lines after the known keys.
    if (cx.comments.length) parts.push({ kind: 'lines', lines: cx.comments });
    dropAnchors(acc, key, cx.defined);
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
  out.extra = joinExtra(parts);
  // An alias in a kept entry of an anchor the save drops would name nothing.
  if (acc.dropped.length) {
    const aliases = propertyNames(out.extra, '*');
    for (const [key, name] of acc.dropped) {
      if (aliases.has(name)) warn(`${key}: *${clip(name)} in a kept entry names its anchor &${clip(name)}, which a save does not write back (pandoc then rejects the file) — write the value there instead`);
    }
  }
  if (unlisted) out.warnings.push(`front matter: ${unlisted} more warning(s) not listed`);
  out.settings = acc.s;
  out.frontMatterRestart = acc.restart;
  return out;
}

function readTop(key: string, n: YNode, out: FrontmatterRead, acc: Acc): void {
  const s = acc.s;
  const textOf = (node: YNode): string | null => {
    const v = text(node);
    return v === null ? null : trimNewlines(v);
  };
  switch (key) {
    case 'title':
      out.titleMd = textOf(n);
      return;
    case 'date':
      out.dateMd = textOf(n);
      return;
    case 'abstract':
      out.abstractMd = textOf(n);
      return;
    case 'author':
      out.authorsMd = authors(n, acc.warn);
      return;
    case 'papersize': {
      const page = paperNamed(n);
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
      for (const k of given.keys()) if (!order.includes(k)) acc.warn(`margin.${clip(k)} is not a margin side — ignored`);
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
      // Present = numbered, as pandoc's Typst template reads it: a pattern,
      // or a boolean (`no` and `off` are false to pandoc, as `false` is).
      const b = boolOf(n);
      if (isNull(n)) s.numberSections = false;
      else if (b !== undefined) s.numberSections = b;
      else {
        const v = text(n) ?? '';
        s.numberSections = v !== '';
        if (v !== '' && v !== '1.1') acc.warn(`section-numbering: Plass numbers sections "1.1", not ${clip(scalar(v))}`);
      }
      return;
    }
    case 'bibliography': {
      if (isNull(n)) return;
      const files = n.t === 'seq' ? n.items : [n];
      const first = files[0] ? text(files[0]) : null;
      if (!first) throw new Invalid('expected a file path');
      const all = files.map(text).filter((f): f is string => !!f);
      if (files.length > 1) {
        const others = all.slice(1).map((f) => clip(scalar(f))).join(', ') || 'the others';
        acc.warn(`bibliography: only the first file (${clip(scalar(first))}) is read — once it is, a save embeds its entries and drops the line, ${others} with it (until then a save keeps every file)`);
      }
      out.bibliography = first;
      out.bibliographyFiles = all;
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
  if (n.t === 'scalar') return trimNewlines(n.value);
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

/** The `plass:` entry (its key line at `root`). Known children are read;
 *  unknown ones, comments and children that cannot be read come back as a
 *  `plass` extra part (child lines at two spaces — PLASS_INDENT, where the
 *  writer looks for them) for the writer to put back into the plass block. */
function readPlass(raw: string[], root: number, acc: Acc): ExtraPart | null {
  const head = matchKey(raw[0].slice(root))!;
  const kept: string[] = [];
  const keepComments = (comments: string[]): void => {
    for (const c of comments) kept.push('  ' + c);
  };
  const unknown = (key: string): void => acc.warn(`plass.${clip(key)} is not a Plass setting — kept as written`);
  const known = (key: string, value: YNode): void => {
    try {
      readPlassChild(key, value, acc);
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      acc.warn(`plass.${key}: ${e.message} — ignored`);
    }
  };
  if (head.rest !== '' && head.rest[0] !== '#') {
    // `plass: {…}` on one line (or an alias of a map).
    const cx = context(acc.anchors);
    let node: YNode;
    try {
      node = parseEntry(raw, root, cx).value;
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      acc.warn(`plass: ${e.message} — kept as written`);
      return { kind: 'lines', lines: reindent(raw, root, 0) };
    }
    for (const note of cx.notes) acc.warn(`plass: ${note}`);
    if (node.t !== 'map') {
      if (!isNull(node)) {
        acc.warn(`plass: expected a map, found ${describe(node)} — kept as written`);
        return { kind: 'lines', lines: reindent(raw, root, 0) };
      }
      return cx.comments.length ? { kind: 'lines', lines: cx.comments } : null;
    }
    // An unknown child is re-emitted, its anchors and aliases as written.
    const written = new Set<string>();
    for (const [key, value] of node.entries) {
      if (KNOWN_PLASS.has(key)) known(key, value);
      else {
        unknown(key);
        kept.push('  ' + emitEntry(key, value, written));
      }
    }
    keepComments(cx.comments);
    dropAnchors(acc, 'plass', cx.defined.filter((name) => !written.has(name)));
    return kept.length ? { kind: 'plass', lines: kept } : null;
  }
  if (head.rest) kept.push('  ' + head.rest); // a comment after `plass:`
  const cont = raw.slice(1);
  const ci = baseIndent(cont);
  const items = splitItems(cont, ci);
  // A child given twice: the last one is read.
  const lastAt = new Map<string, number>();
  items.forEach((item, k) => {
    if (item.kind === 'entry') lastAt.set(keyOf(cont[item.start], ci)!, k);
  });
  items.forEach((item, k) => {
    const rawLines = reindent(cont.slice(item.start, item.end), ci, PLASS_INDENT);
    if (item.kind === 'blank') {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      return;
    }
    if (item.kind === 'comment') return kept.push('  ' + cont[item.start].trim());
    if (item.kind === 'stray') {
      acc.warn(`plass: the line "${clip(cont[item.start].trim())}" is not a "key: value" entry — kept as written`);
      return append(kept, rawLines);
    }
    const key = keyOf(cont[item.start], ci)!;
    if (lastAt.get(key) !== k) {
      acc.warn(`plass.${clip(key)} is given twice — the last one is read`);
      return;
    }
    if (!KNOWN_PLASS.has(key)) {
      scanAnchors(cont.slice(item.start, item.end), ci, acc);
      unknown(key);
      return append(kept, rawLines);
    }
    const cx = context(acc.anchors);
    let value: YNode;
    try {
      value = parseEntry(cont.slice(item.start, item.end), ci, cx).value;
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      acc.warn(`plass.${key}: ${e.message} — kept as written`);
      return append(kept, rawLines);
    }
    for (const note of cx.notes) acc.warn(`plass.${key}: ${note}`);
    known(key, value);
    keepComments(cx.comments);
    dropAnchors(acc, `plass.${key}`, cx.defined);
  });
  return { kind: 'plass', lines: kept };
}

function readPlassChild(key: string, n: YNode, acc: Acc): void {
  const s = acc.s;
  // Each field of a sub-map on its own: one bad value leaves the rest.
  const fields = (path: string, readers: Record<string, (v: YNode) => void>): void => {
    for (const [k, v] of entriesOf(n)) {
      const read = own(readers, k);
      if (!read) {
        acc.warn(`plass.${path}.${clip(k)} is not a Plass setting — ignored`);
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
      const page = paperNamed(n);
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
          if (isNull(v) || boolOf(v) === false || (v.t === 'scalar' && /^(?:arabic|none|false)$/.test(v.value))) acc.restart = false;
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
          const t = trimNewlines(text(v) ?? '');
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
      s.mathMacros = trimNewlines(text(n) ?? '');
      return;
  }
}

// ---------------------------------------------------------------- writing

/** How kept lines before the first kept entry are written. A line there
 *  indented deeper than `indent` with no key above it would join the entry
 *  written before it; when the first such line reads as a key where it
 *  stands, the run goes first, as it was read ('first'); otherwise it moves
 *  to the margin ('margin'). 'none': nothing to move. */
function leadingRun(items: Item[], lines: string[], indent: number): { count: number; place: 'none' | 'first' | 'margin' } {
  const n = items.findIndex((item) => item.kind === 'entry');
  const run = n < 0 ? items : items.slice(0, n);
  const stray = run.find((item) => item.kind === 'stray');
  if (!stray) return { count: 0, place: 'none' };
  const line = lines[stray.start];
  const ind = indentOf(line);
  if (ind <= indent) return { count: 0, place: 'none' };
  return { count: run.length, place: matchKey(line.slice(ind)) ? 'first' : 'margin' };
}

/** The front matter block (`---` … `---`, no trailing newline), or '' when
 *  there is nothing to write. Known keys first, in the plan's order and
 *  only when not the default; then `extra`: its entries as written, its
 *  comments at the margin. An extra entry whose key the document now
 *  writes is dropped (with a warning); so is a `---`/`...` line, which
 *  would end the block. `bibliography:` is never written: the
 *  bibliography is embedded in the body — but a `bibliography:` entry
 *  kept in `extra` is, like any kept line: the Markdown reader carries one
 *  while its sidecar is unread, and takes it out once it reads it
 *  (md-parser's withSidecarBib). A text key's entry `extra` keeps as written is
 *  written in the key's place when the document has not edited it
 *  (`fm.asWritten`), and dropped otherwise. */
export function writeFrontmatter(fm: FrontmatterFields, warn: (m: string) => void = () => {}): string {
  const s = normalizeSettings(fm.settings ?? null);
  const D = DEFAULT_SETTINGS;
  const top: string[] = [];
  const written = new Set<string>();
  const put = (key: string, ...lines: string[]): void => {
    lines[0] = `${key}: ${lines[0]}`;
    append(top, lines);
    written.add(key);
  };
  const block = (key: string, value: string): void => {
    // An empty abstract (one empty paragraph) is the empty string.
    if (!trimNewlines(value).trim()) return put(key, "''");
    const lines = blockLines(key, value, 2);
    if (lines) {
      append(top, lines);
      written.add(key);
    }
    // Quoted, with the final line break block text has: pandoc reads a
    // value that ends in one as blocks, not as one line of inlines.
    else put(key, scalar(trimNewlines(value) + '\n'));
  };
  const keptText = keptTextEntries(fm.extra ?? '');
  /** A text key: its kept entry as written when the document left it alone, else its value. */
  const text = (key: TextKey, value: string | null | undefined, write: (v: string) => void): void => {
    const kept = keptText.get(key);
    if (kept && fm.asWritten?.includes(key)) {
      append(top, kept);
      written.add(key);
    } else if (value != null) write(value);
  };

  text('title', fm.titleMd, (v) => put('title', scalar(v)));
  text('author', fm.authorsMd, (v) => put('author', scalar(v)));
  text('date', fm.dateMd, (v) => put('date', scalar(v)));
  text('abstract', fm.abstractMd, (v) => block('abstract', v));
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
      plass.push('  ' + lines[0]);
      append(plass, lines.slice(1));
      plassKeys.add('math-macros');
    } else sub('math-macros', scalar(trimNewlines(s.mathMacros)));
  }

  // The kept extra: unknown keys and comments in order; a kept `plass:`
  // block's children join the plass block written above. Comments go at
  // the margin of their block, where none can join the entry written
  // before it.
  const head: string[] = [];
  const rest: string[] = [];
  const plassHead: string[] = [];
  const plassRest: string[] = [];
  /** Where the kept `plass:` entry sat among the kept lines (`rest`). */
  let plassAt = -1;
  let pendingBlank = false;
  const keep = (into: string[], raw: string[]): void => {
    if (pendingBlank && into.length) into.push('');
    pendingBlank = false;
    append(into, raw);
  };
  const orig = (fm.extra ?? '').replace(/\r\n?/g, '\n').split('\n');
  const lines = orig.map(detab);
  const items = splitItems(lines, 0);
  const lead = leadingRun(items, lines, 0);
  items.forEach((item, k) => {
    const raw = orig.slice(item.start, item.end);
    const into = k < lead.count && lead.place === 'first' ? head : rest;
    if (item.kind === 'blank') {
      pendingBlank = true;
      return;
    }
    if (item.kind === 'comment') return keep(into, [raw[0].trimStart()]);
    if (item.kind === 'stray') {
      if (DELIMITER.test(raw[0])) {
        warn(`front matter: a "${raw[0].trim()}" line would end the block — dropped`);
        return;
      }
      return keep(into, k < lead.count && lead.place === 'margin' ? [raw[0].trimStart()] : raw);
    }
    const key = keyOf(lines[item.start], 0);
    const inline = matchKey(lines[item.start])!.rest;
    if (key === 'plass' && (inline === '' || inline[0] === '#')) {
      plassAt = rest.length;
      const cont = lines.slice(item.start + 1, item.end);
      // Not the children's own least indentation: when every kept child is
      // a stray deeper than PLASS_INDENT, that would make them entries.
      const ci = PLASS_INDENT;
      const children = splitItems(cont, ci);
      const childLead = leadingRun(children, cont, ci);
      if (inline) plassRest.push('  ' + inline); // a comment after `plass:`
      let blank = false;
      children.forEach((child, c) => {
        const into = c < childLead.count && childLead.place === 'first' ? plassHead : plassRest;
        if (child.kind === 'blank') {
          blank = true;
          return;
        }
        const childKey = child.kind === 'entry' ? keyOf(cont[child.start], ci) : null;
        if (childKey !== null && plassKeys.has(childKey)) {
          warn(`front matter: the document's plass.${clip(childKey)} replaces the one kept from the file`);
          return;
        }
        if (blank && into.length) into.push('');
        blank = false;
        if (child.kind === 'comment') into.push('  ' + cont[child.start].trim());
        else if (child.kind === 'stray' && c < childLead.count && childLead.place === 'margin') into.push('  ' + cont[child.start].trim());
        else append(into, cont.slice(child.start, child.end));
      });
      return;
    }
    // A text key's entry kept as written: written in its place above, or
    // replaced by the document's edit.
    if (key !== null && keptText.get(key as TextKey)?.join('\n') === raw.join('\n')) return;
    if (key !== null && written.has(key)) {
      warn(`front matter: the document's ${clip(key)} replaces the one kept from the file`);
      return;
    }
    if (key === 'plass' && plass.length) {
      warn("front matter: the document's plass settings replace the plass entry kept from the file");
      return;
    }
    keep(into, raw);
  });

  const kept = [...trimBlank(plassHead), ...plass, ...trimBlank(plassRest)];
  let after: string[] = [];
  if (kept.length) {
    // With the known keys, unless a kept plass line aliases an anchor that a
    // kept entry before the plass entry defines: then where the plass entry
    // was, after that anchor (pandoc rejects an alias before its anchor).
    const aliases = propertyNames(kept.join('\n'), '*');
    const anchors = aliases.size && plassAt > 0 ? propertyNames(rest.slice(0, plassAt).join('\n'), '&') : new Set<string>();
    if ([...aliases].some((name) => anchors.has(name))) {
      after = rest.splice(plassAt);
      rest.push('plass:');
      append(rest, kept);
    } else {
      top.push('plass:');
      append(top, kept);
    }
  }
  const all = [...head, ...top, ...rest, ...after];
  return all.length ? `---\n${all.join('\n')}\n---` : '';
}

/** The text-key entries readFrontmatter kept in `extra` as written beside
 *  the value it read: the ones whose double-quoted value decodes an escape
 *  that reads as LaTeX, found by the same test. Any other text key there
 *  (one that could not be read, a list an older Plass carried) is not one.
 *  Raw lines by key. */
function keptTextEntries(extra: string): Map<TextKey, string[]> {
  const found = new Map<TextKey, string[]>();
  if (!/^(?:title|author|date|abstract)[ \t]*:/m.test(extra)) return found;
  const orig = extra.replace(/\r\n?/g, '\n').split('\n');
  const lines = orig.map(detab);
  for (const item of splitItems(lines, 0)) {
    if (item.kind !== 'entry') continue;
    const key = keyOf(lines[item.start], 0);
    if (key === null || !TEXT_KEYS.has(key)) continue;
    const cx = context();
    cx.textKey = true;
    try {
      const value = parseEntry(lines.slice(item.start, item.end), 0, cx).value;
      if (cx.keepRaw && (key === 'author' ? authors(value, () => {}) : text(value)) !== null) found.set(key as TextKey, orig.slice(item.start, item.end));
    } catch (e) {
      if (!(e instanceof YamlError) && !(e instanceof Invalid)) throw e;
    }
  }
  return found;
}

/** The `bibliography:` entry the Markdown reader keeps in
 *  doc.attrs.frontmatter while the sidecar it names is unread: every file
 *  the file named, so a save before the read keeps them all. */
export function bibliographyEntry(files: readonly string[]): string {
  if (files.length === 1) return `bibliography: ${scalar(files[0])}`;
  return ['bibliography:', ...files.map((f) => `  - ${scalar(f)}`)].join('\n');
}

/** A kept `extra` without its top-level entries for `key` (the blank lines
 *  around one collapse to one; none at the ends). */
export function withoutEntry(extra: string, key: string): string {
  const orig = extra.replace(/\r\n?/g, '\n').split('\n');
  const lines = orig.map(detab);
  const kept: string[] = [];
  let pendingBlank = false;
  for (const item of splitItems(lines, 0)) {
    if (item.kind === 'blank') {
      pendingBlank = kept.length > 0;
      continue;
    }
    if (item.kind === 'entry' && keyOf(lines[item.start], 0) === key) continue;
    if (pendingBlank) kept.push('');
    pendingBlank = false;
    append(kept, orig.slice(item.start, item.end));
  }
  return kept.join('\n');
}
