// Content-parity skeletons (docs/MARKDOWN-SOURCE-PLAN.md, step 4).
//
// The referee (step 10) parses a `.md` file twice — with Plass's `mdToDoc`
// and with `pandoc -f markdown-smart -t json` — and compares what the two
// say the document holds. Neither tree can be compared with the other
// directly, so both are reduced here to the same ordered list of records:
// block kinds and order, printed text, math sources, labels and reference
// targets, which text is a comment, image sources, table shape and
// alignment. It is NOT a rendering comparison (the brief's principle 2).
//
// Pandoc runs with `smart` OFF, so its text arrives as the file wrote it;
// this module then applies Plass's own normalizers to pandoc's text —
// `printedForm` (dashes, ellipsis, the minus before a digit), `smartenText`
// (Typst's quoter, with the `before` stand-ins `beforeAfterNode` uses) and
// the footnote-space rule (`trimSpaceBeforeMarker`) — exactly where the
// Markdown importer applies them: `printedForm` per markdown-it text token
// (so a run of prose is cut where markdown-it cuts one: emphasis, links,
// code, footnote markers, raw HTML, breaks), the quoter across the whole
// paragraph. The ProseMirror side is only flattened: the importer already
// normalized it, and normalizing it again would hide an importer bug.
// Both sides then collapse whitespace runs the way the edit-time
// normalizer does (Typst prints a run of spaces as one).
//
// Records are flat and carry their nesting `depth` (0 = top level; a
// solution's paragraphs are depth 1, a grid's `column` records depth 1 and
// their blocks depth 2). `classes` holds a paragraph's center/right/keep,
// display math's numbered/unnumbered, a list's bullet/ordered (and
// `start=N`), a listing's language. A paragraph with no content is
// dropped on both sides, except a table cell, which is always one
// `paragraph` record. Inline atoms appear in `text` as sentinels:
//   ⟦$⟧ inline math (source in `math`, whitespace-normalized)
//   ⟦$$⟧ display math inside running text (pandoc only; Plass never does it)
//   ⟦cite:key⟧ a citation, its pandoc mode in `mode` ('normal' |
//     'in-text' | 'suppress'; Plass's are all 'normal' — the referee's
//     accepted divergence), ⟦ref:eq:x⟧ a reference (a key whose prefix
//     is eq:, fig:, sec: or tbl:, in either mode)
//   ⟦fn⟧ a footnote marker (its text is the `footnote` record after the
//     block), ⟦br⟧ a hard break, ⟦img:src⟧ an inline image,
//   ⟦typst:src⟧ / ⟦html:src⟧ inline raw Typst / inline HTML.
// A citation's pandoc prefix, `-` and suffix stay beside the sentinel as
// text: `[see @c, p. 3]` is `see ⟦cite:c⟧, p. 3`, `[-@c]` is `-⟦cite:c⟧`,
// `@c [p. 3]` is `⟦cite:c⟧ [p. 3]`, and the items of one group are joined
// by `; ` when text separates them, by nothing otherwise
// (`[@a; @b]` is `⟦cite:a⟧⟦cite:b⟧`).
//
// Pandoc-side rules the plan settled (and the readings this module picked
// where it was silent; see the step-4 commit message):
// - a nested comment (a `RawBlock`/`RawInline` html comment anywhere below
//   the top level) is hoisted to its top-level block's boundary: before
//   the block when no printed content precedes it in that block, after
//   otherwise; the payload is the comment without `<!--`/`-->`, trimmed,
//   with `--&gt;` decoded (the old tagged `<!-- plass:comment` frame is
//   decoded the old way);
// - a `Div` with no rail class (solution, columns, table, center, right,
//   keep) and a non-comment HTML block (swallowed through its closing tag)
//   reduce to one `island` record, children not descended — but comments
//   inside a div are still hoisted (a div is a container until its class
//   decides), and whole-line comments inside an HTML element are lifted
//   out after it (the element's first line is printed code);
// - a grid is written one `.columns` div per row (the plan's grid rows):
//   a `.columns` div holding only `.column` divs is a row, and every
//   following sibling `.columns` row that carries `.continued` (comments
//   between rows allowed) is a later row of the SAME grid — one `columns`
//   record whose `cols` is the first row's cell count (the model's
//   `columns.length`), then each row's `column` records in order. A row
//   without `.continued` starts a new grid, so two adjacent unmarked rows
//   are two grids; a `.continued` row with no grid before it starts one.
//   A comment between rows is inside the grid and hoisted after it. Shares,
//   gutters and `cols=` attributes are geometry, not content: not read;
// - a table's comments are placed by its cells alone: one before the
//   first non-empty cell's text goes before the table, any other after
//   it; the caption does not count (a `.table` attribute, or a `: Caption`
//   line pandoc takes from before or after the table — its AST does not
//   say which). A comment in a figure's caption goes after the figure (the
//   image precedes its caption);
// - `Para [Image]` is `paragraph > image` (`image`), unless the image has
//   an id: then it is a labeled figure with an empty caption; `Figure` is
//   `figure`; a lone image in a `Plain` reads the same way;
// - display math is a `Para` holding only `DisplayMath`, each optionally
//   followed by a pandoc attribute block that pandoc leaves as text
//   (`{#eq:x .unnumbered}`); `.numbered`/`.unnumbered` become `classes`;
// - a heading id equal to pandoc's own auto-identifier is not a label
//   (pandoc invents one for every heading; a hand-written `{#intro}` on
//   "Intro" is therefore indistinguishable and reads as no label). A
//   `[^ref]` footnote marker in a heading puts its reference label into
//   pandoc's id (`# Slope[^s]` is `slopes`), which the AST does not keep,
//   so any identifier characters at a note's place still match;
// - a `.table` div lends the table its id, caption, `decimal` columns,
//   `aligns` overrides and `spans` (covered cells are skipped); a header
//   row whose cells are all empty is dropped (the headerless form); cells
//   are one `paragraph` record each, row-major, their blocks joined by a
//   space, and `aligns` lists every cell's alignment in the same order;
// - a footnote's paragraphs are joined by a space (Plass flattens them).
//
// Known limitation: an HTML `<div class="solution">` (or any rail class)
// is the same `Div` in pandoc's JSON as `::: solution` (`native_divs`), so
// it reduces as the rail, while Plass (markdown-it) reads it as an
// `md-raw` island. The referee reports that divergence and the format
// cannot heal it from pandoc's side: an accepted-divergence candidate for
// step 10 and a MARKDOWN-FORMAT.md pitfall ("write `:::`, not
// `<div class>`"). The course corpus has no classed `<div>`.

import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { printedForm, trimSpaceBeforeMarker } from './collapse-spaces';
import { OBJECT, createQuoteState, lastVisible, smartenText, type QuoteState } from './smart-quotes';

/** One reduced block. Optional fields are present only when set. */
export interface SkeletonRecord {
  kind: string;
  /** Nesting depth: 0 for a top-level block. */
  depth: number;
  /** False only for an editorial comment: kept in the file, never printed. */
  printed: boolean;
  text?: string;
  math?: string[];
  label?: string;
  src?: string;
  cols?: number;
  rows?: number;
  head?: number;
  aligns?: string[];
  mode?: string[];
  classes?: string[];
}

/** pandoc's JSON AST (pandoc-types 1.23): every element is `{t, c}`. */
export interface PandocNode {
  t: string;
  c?: unknown;
}

export interface PandocDoc {
  'pandoc-api-version': number[];
  meta: Record<string, PandocNode>;
  blocks: PandocNode[];
}

// ---------------------------------------------------------------- shared

/** Flattened inline content: printed text with sentinels, and what the
 *  sentinels stand for. */
interface Flat {
  text: string;
  math: string[];
  mode: string[];
  notes: Flat[];
}

const emptyFlat = (): Flat => ({ text: '', math: [], mode: [], notes: [] });

const REF_PREFIX = /^(?:eq|fig|sec|tbl):/;
const RAIL_CLASSES = ['table', 'columns', 'solution', 'center', 'right', 'keep'];
const ALIGN_CLASSES = new Set(['center', 'right', 'keep']);

const normMath = (src: string) => src.replace(/\s+/g, ' ').trim();

/** The edit-time normalizer's whitespace rule (collapse-spaces.ts): a run of
 *  spaces holding a plain space prints as one space; a pure nbsp run is
 *  glue and stays. Then the paragraph's ends, as both parsers trim them. */
function collapse(text: string): string {
  return text
    .replace(/[\t\n ]+/g, (run) => (run.includes('\n') || run.includes('\t') ? ' ' : run))
    .replace(/[ \u00a0]{2,}/g, (run) => (run.includes(' ') ? ' ' : run))
    .replace(/^ +| +$/g, '');
}

/** 32-bit FNV-1a, hex: a short stand-in for a long payload. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** An image source as the skeleton shows it: a data URL longer than a
 *  line becomes its media type, length and digest (identity kept, the
 *  printout readable). */
function srcKey(src: string): string {
  const m = /^data:([^,]*),/.exec(src);
  return m && src.length > 80 ? `data:${m[1]},…${src.length}#${digest(src)}` : src;
}

/** A bibliography's identity: its entry keys in order and a digest. */
function bibText(content: string): string {
  const body = content.trim();
  const keys = [...body.matchAll(/@\w+\s*[{(]\s*([^,\s]+)\s*,/g)].map((m) => m[1]);
  return [...keys, `#${digest(body)}`].join(' ');
}

function record(kind: string, depth: number, fields: Partial<SkeletonRecord> = {}): SkeletonRecord {
  const r: SkeletonRecord = { kind, depth, printed: fields.printed ?? true };
  if (fields.text !== undefined) r.text = fields.text;
  if (fields.math?.length) r.math = fields.math;
  if (fields.label) r.label = fields.label;
  if (fields.src !== undefined) r.src = fields.src;
  if (fields.cols !== undefined) r.cols = fields.cols;
  if (fields.rows !== undefined) r.rows = fields.rows;
  if (fields.head !== undefined) r.head = fields.head;
  if (fields.aligns?.length) r.aligns = fields.aligns;
  if (fields.mode?.length) r.mode = fields.mode;
  if (fields.classes?.length) r.classes = [...fields.classes].sort();
  return r;
}

/** A text-bearing record and the footnote records its markers own. */
function textRecords(kind: string, depth: number, flat: Flat, extra: Partial<SkeletonRecord> = {}): SkeletonRecord[] {
  return [
    record(kind, depth, { ...extra, text: flat.text, math: flat.math, mode: flat.mode }),
    ...flat.notes.map((n) => record('footnote', depth + 1, { text: n.text, math: n.math, mode: n.mode })),
  ];
}

const isEmptyFlat = (f: Flat) => !f.text && !f.math.length && !f.notes.length;

function joinFlats(flats: Flat[]): Flat {
  const out = emptyFlat();
  out.text = collapse(flats.map((f) => f.text).filter(Boolean).join(' '));
  for (const f of flats) {
    out.math.push(...f.math);
    out.mode.push(...f.mode);
    out.notes.push(...f.notes);
  }
  return out;
}

/** The first difference between two skeletons, or -1 when they agree.
 *  `ignore` names fields left out of the comparison (the referee's
 *  accepted divergences, such as `mode`). */
export function firstDivergence(a: SkeletonRecord[], b: SkeletonRecord[], ignore: Array<keyof SkeletonRecord> = []): number {
  const key = (r: SkeletonRecord | undefined) => {
    if (!r) return '';
    const copy: Record<string, unknown> = { ...r };
    for (const k of ignore) delete copy[k];
    return JSON.stringify(Object.keys(copy).sort().map((k) => [k, copy[k]]));
  };
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (key(a[i]) !== key(b[i])) return i;
  return -1;
}

// ------------------------------------------------------- ProseMirror side

function pmFlat(parent: PMNode): Flat {
  const flat = emptyFlat();
  let text = '';
  parent.forEach((child) => {
    if (child.isText) {
      text += child.text ?? '';
      return;
    }
    switch (child.type.name) {
      case 'math_inline':
        text += '⟦$⟧';
        flat.math.push(normMath(child.attrs.src as string));
        break;
      case 'citation':
        text += `⟦cite:${child.attrs.key as string}⟧`;
        flat.mode.push('normal');
        break;
      case 'eq_ref':
        text += `⟦ref:${child.attrs.label as string}⟧`;
        break;
      case 'footnote':
        text += '⟦fn⟧';
        flat.notes.push(pmFlat(child));
        break;
      case 'hard_break':
        text += '⟦br⟧';
        break;
      case 'image':
        text += `⟦img:${srcKey(child.attrs.src as string)}⟧`;
        break;
      case 'typst_inline':
        text += `⟦${child.attrs.lang === 'html' ? 'html' : 'typst'}:${child.attrs.src as string}⟧`;
        break;
      default:
        text += `⟦${child.type.name}⟧`;
    }
  });
  flat.text = collapse(text);
  return flat;
}

/** Every textblock below `node`, flattened and joined by a space (a table
 *  cell holds one paragraph in the Markdown form). */
function pmBlocksFlat(node: PMNode): Flat {
  const flats: Flat[] = [];
  node.descendants((child) => {
    if (!child.isTextblock) return true;
    flats.push(pmFlat(child));
    return false;
  });
  return joinFlats(flats);
}

function pmCodeClass(params: string): string[] {
  const first = params.trim().split(/\s+/)[0]?.replace(/^\{/, '').replace(/^\./, '').replace(/\}$/, '') ?? '';
  return first ? [first] : [];
}

function pmBlocks(parent: PMNode, depth: number, out: SkeletonRecord[]): void {
  parent.forEach((node) => pmBlock(node, depth, out));
}

function pmBlock(node: PMNode, depth: number, out: SkeletonRecord[]): void {
  const a = node.attrs;
  switch (node.type.name) {
    case 'doc_title':
      out.push(...textRecords('title', depth, pmFlat(node)));
      return;
    case 'doc_authors':
      out.push(...textRecords('author', depth, pmFlat(node)));
      return;
    case 'doc_date':
      out.push(...textRecords('date', depth, pmFlat(node)));
      return;
    case 'abstract':
      out.push(record('abstract', depth));
      pmBlocks(node, depth + 1, out);
      return;
    case 'paragraph': {
      const classes = [...(a.align === 'center' || a.align === 'right' ? [a.align as string] : []), ...(a.keep ? ['keep'] : [])];
      if (node.childCount === 1 && node.firstChild!.type.name === 'image') {
        out.push(record('image', depth, { src: srcKey(node.firstChild!.attrs.src as string), classes }));
        return;
      }
      const flat = pmFlat(node);
      if (!isEmptyFlat(flat)) out.push(...textRecords('paragraph', depth, flat, { classes }));
      return;
    }
    case 'heading':
      out.push(...textRecords(`heading-${a.level as number}`, depth, pmFlat(node), { label: a.label as string }));
      return;
    case 'math_display':
      out.push(
        record('math', depth, {
          math: [normMath(a.src as string)],
          label: a.label as string,
          classes: a.numbered === true ? ['numbered'] : a.numbered === false ? ['unnumbered'] : [],
        }),
      );
      return;
    case 'figure': {
      const flat = pmFlat(node);
      out.push(...textRecords('figure', depth, flat, { label: a.label as string, src: srcKey(a.src as string) }));
      return;
    }
    case 'blockquote':
      out.push(record(a.kind === 'solution' ? 'solution' : 'quote', depth));
      pmBlocks(node, depth + 1, out);
      return;
    case 'grid':
      out.push(record('columns', depth, { cols: (a.columns as number[]).length }));
      node.forEach((row) =>
        row.forEach((cell) => {
          out.push(record('column', depth + 1));
          pmBlocks(cell, depth + 2, out);
        }),
      );
      return;
    case 'bullet_list':
    case 'ordered_list': {
      const ordered = node.type.name === 'ordered_list';
      const order = ordered ? (a.order as number) : 1;
      out.push(record('list', depth, { classes: ordered ? ['ordered', ...(order !== 1 ? [`start=${order}`] : [])] : ['bullet'] }));
      node.forEach((item) => {
        out.push(record('item', depth + 1));
        pmBlocks(item, depth + 2, out);
      });
      return;
    }
    case 'table': {
      const cells: SkeletonRecord[] = [];
      const aligns: string[] = [];
      let head = 0;
      let headDone = false;
      node.forEach((row) => {
        let allHeader = row.childCount > 0;
        row.forEach((cell) => {
          if (cell.type.name !== 'table_header') allHeader = false;
          aligns.push((cell.attrs.align as string | null) || 'left');
          cells.push(...textRecords('paragraph', depth + 1, pmBlocksFlat(cell)));
        });
        if (allHeader && !headDone) head++;
        else headDone = true;
      });
      let cols = 0;
      node.firstChild?.forEach((cell) => (cols += (cell.attrs.colspan as number) || 1));
      out.push(
        record('table', depth, {
          text: (a.caption as string) ? collapse(a.caption as string) : undefined,
          label: a.label as string,
          rows: node.childCount,
          head,
          cols,
          aligns,
        }),
        ...cells,
      );
      return;
    }
    case 'code_block': {
      const params = a.params as string;
      if (params === 'typst-raw') out.push(record('raw-typst', depth, { text: node.textContent }));
      else if (params === 'md-raw') out.push(record('island', depth));
      else out.push(record('code', depth, { text: node.textContent, classes: pmCodeClass(params) }));
      return;
    }
    case 'page_break':
      out.push(record('pagebreak', depth));
      return;
    case 'horizontal_rule':
      out.push(record('hr', depth));
      return;
    case 'bibliography':
      // Its text (the document's BibTeX) is filled in by docSkeleton.
      out.push(record('bibliography', depth));
      return;
    case 'editor_comment':
      out.push(record('comment', depth, { printed: false, text: node.textContent.trim() }));
      return;
    case 'numbering_restart':
      // YAML-only (`plass.page-numbers.front-matter`): no pandoc content.
      return;
    default:
      out.push(record('island', depth));
  }
}

/** A ProseMirror document reduced to skeleton records. */
export function docSkeleton(doc: PMNode): SkeletonRecord[] {
  const out: SkeletonRecord[] = [];
  pmBlocks(doc, 0, out);
  const bib = doc.attrs.bib as { content?: string } | null;
  if (bib?.content) for (const r of out) if (r.kind === 'bibliography') r.text = bibText(bib.content);
  return out;
}

// ------------------------------------------------------------ pandoc side

interface Citation {
  citationId: string;
  citationPrefix: PandocNode[];
  citationSuffix: PandocNode[];
  citationMode: PandocNode;
}

type Attr = [string, string[], Array<[string, string]>];

interface Ctx {
  /** Printed content seen so far in the current top-level block. */
  seen: boolean;
  before: SkeletonRecord[];
  after: SkeletonRecord[];
  /** Heading identifiers pandoc has handed out so far (document-wide). */
  ids: Set<string>;
  /** Inside an HTML element's island: inline comments share a line with
   *  the element's text and stay in it. */
  keepInline: boolean;
}

const kids = (n: PandocNode) => n.c as PandocNode[];
const attrOf = (a: unknown): Attr => (a as Attr) ?? ['', [], []];
const kv = (a: Attr, key: string) => a[2].find(([k]) => k === key)?.[1];

/** The payload of a block or inline that is nothing but HTML comments, or
 *  null. `--&gt;` decodes to `-->`; the old tagged frame decodes the old way
 *  (editor-comments-format.ts `readMdComment`). */
function commentPayloads(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!/^(?:<!--[\s\S]*?-->\s*)+$/.test(trimmed)) return null;
  return [...trimmed.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => {
    const tagged = /^ plass:comment\n(?:([\s\S]*)\n)?$/.exec(m[1]);
    if (tagged) return (tagged[1] ?? '').replace(/&#45;/g, '-').replace(/&amp;/g, '&').trim();
    return m[1].trim().replace(/--&gt;/g, '-->');
  });
}

const htmlComments = (n: PandocNode): string[] | null => {
  const [format, raw] = n.c as [string, string];
  return format === 'html' ? commentPayloads(raw) : null;
};

function hoist(ctx: Ctx, payloads: string[], seen: boolean): void {
  for (const p of payloads) (seen ? ctx.after : ctx.before).push(record('comment', 0, { printed: false, text: p }));
}

// pandoc's `stringify` and `auto_identifiers` (Text.Pandoc.Shared,
// pandoc 3.4): a heading's generated id, so it is not taken for a label.
// The Markdown reader names a heading before it resolves footnote
// references, so a `[^ref]` marker is still the text `[^ref]` then and its
// label lands in the id (`# Slope[^s]` is `slopes`); an inline `^[…]` note
// is already a Note and adds nothing. The AST keeps neither the label nor
// which form a note had, so NOTE_MARK stands in for it and `isAutoId`
// matches it as any run of identifier characters.
const NOTE_MARK = '\uE000';

function stringify(inlines: PandocNode[]): string {
  let s = '';
  for (const n of inlines) {
    switch (n.t) {
      case 'Str':
        s += n.c as string;
        break;
      case 'Space':
      case 'SoftBreak':
      case 'LineBreak':
        s += ' ';
        break;
      case 'Code':
      case 'Math':
        s += (n.c as [unknown, string])[1];
        break;
      case 'RawInline': {
        const [format, raw] = n.c as [string, string];
        if (format === 'html' && raw.startsWith('<br')) s += ' ';
        break;
      }
      case 'Quoted': {
        const [type, inner] = n.c as [PandocNode, PandocNode[]];
        const [o, c] = type.t === 'SingleQuote' ? ['‘', '’'] : ['“', '”'];
        s += o + stringify(inner) + c;
        break;
      }
      case 'Cite': // the citation's own text, `[@key]`
      case 'Link':
      case 'Image':
      case 'Span':
        s += stringify((n.c as unknown[])[1] as PandocNode[]);
        break;
      case 'Note':
        s += NOTE_MARK;
        break;
      default:
        if (Array.isArray(n.c) && n.c.every((x) => typeof x === 'object' && x !== null && 't' in x)) s += stringify(n.c as PandocNode[]);
    }
  }
  return s;
}

const SPACE = /[\t\n\v\f\r \u00a0\p{Zs}]+/u;
function autoIdentifier(inlines: PandocNode[], used: Set<string>): string {
  const filtered = [...stringify(inlines).toLowerCase()]
    .filter((c) => c === NOTE_MARK || SPACE.test(c) || /[\p{L}\p{N}_.-]/u.test(c))
    .join('');
  const base = filtered.split(SPACE).filter(Boolean).join('-').replace(/^[^\p{L}\uE000]+/u, '') || 'section';
  if (base.includes(NOTE_MARK) || !used.has(base)) return base;
  for (let n = 1; n <= 60000; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  return base;
}

/** Whether `id` is the identifier pandoc generated for the heading. With a
 *  footnote in it, the note's reference label (unknown here) may stand
 *  where NOTE_MARK is, and a duplicate's `-N` may follow. */
function isAutoId(id: string, auto: string): boolean {
  if (!auto.includes(NOTE_MARK)) return id === auto;
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${auto.split(NOTE_MARK).map(escape).join('[\\p{L}\\p{N}_.-]*')}(?:-\\d+)?$`, 'u').test(id);
}

/** A pandoc attribute block left as text after display math
 *  (`{#eq:x .unnumbered}`): its id and the numbering class. */
function parseAttrText(text: string): { id: string; classes: string[] } | null {
  const m = /^\{([^{}]*)\}$/.exec(text.trim());
  if (!m) return null;
  let id = '';
  const classes: string[] = [];
  for (const part of m[1].trim().split(/\s+/).filter(Boolean)) {
    if (part.startsWith('#')) id = part.slice(1);
    else if (part === '.numbered' || part === '.unnumbered') classes.push(part.slice(1));
    else if (part === '-') classes.push('unnumbered');
    else if (!part.startsWith('.') && !part.includes('=')) return null;
  }
  return { id, classes };
}

// Inline flattening. A segment list first, then printedForm per run, then
// the quoter across the paragraph.

type Atom = {
  k: 'atom';
  sent: string;
  /** Inside a markdown-it text token (math, citations and references are
   *  sentinels within the token text): no run boundary. */
  inRun: boolean;
  before: (prev: string | null) => string | null;
  note?: boolean;
};
type Seg = { k: 'prose'; s: string } | { k: 'code'; s: string } | { k: 'cut' } | Atom;

interface InlineState {
  segs: Seg[];
  flat: Flat;
  ctx: Ctx;
  /** Printed content seen in this inline sequence. */
  content: boolean;
}

const BOUNDARY_WRAPPERS = new Set(['Emph', 'Strong', 'Strikeout']);
const TRANSPARENT_WRAPPERS = new Set(['Underline', 'SmallCaps', 'Superscript', 'Subscript']);

function citeSegs(st: InlineState, cites: Citation[]): void {
  cites.forEach((cite, i) => {
    const prefix = cite.citationPrefix ?? [];
    const suffix = cite.citationSuffix ?? [];
    const mode = cite.citationMode?.t;
    if (i > 0) {
      const prevSuffix = cites[i - 1].citationSuffix ?? [];
      if (prevSuffix.length || prefix.length) st.segs.push({ k: 'prose', s: '; ' });
    }
    if (prefix.length) {
      inlineSegs(st, prefix);
      st.segs.push({ k: 'prose', s: ' ' });
    }
    if (mode === 'SuppressAuthor') st.segs.push({ k: 'prose', s: '-' });
    const id = cite.citationId;
    if (REF_PREFIX.test(id)) {
      st.segs.push({ k: 'atom', sent: `⟦ref:${id}⟧`, inRun: true, before: () => ')' });
    } else {
      st.segs.push({ k: 'atom', sent: `⟦cite:${id}⟧`, inRun: true, before: () => ']' });
      st.flat.mode.push(mode === 'AuthorInText' ? 'in-text' : mode === 'SuppressAuthor' ? 'suppress' : 'normal');
    }
    st.content = true;
    if (suffix.length) {
      if (mode === 'AuthorInText') {
        // `@c [p. 3]`: the bracket pandoc took the suffix from.
        st.segs.push({ k: 'prose', s: ' [' });
        inlineSegs(st, suffix);
        st.segs.push({ k: 'prose', s: ']' });
      } else inlineSegs(st, suffix);
    }
  });
}

function inlineSegs(st: InlineState, inlines: PandocNode[]): void {
  for (const n of inlines) {
    switch (n.t) {
      case 'Str':
        st.segs.push({ k: 'prose', s: n.c as string });
        if ((n.c as string).trim()) st.content = true;
        break;
      case 'Space':
        st.segs.push({ k: 'prose', s: ' ' });
        break;
      case 'SoftBreak':
        st.segs.push({ k: 'cut' }, { k: 'prose', s: ' ' }, { k: 'cut' });
        break;
      case 'LineBreak':
        st.segs.push({ k: 'atom', sent: '⟦br⟧', inRun: false, before: () => '\n' });
        break;
      case 'Code':
        st.segs.push({ k: 'code', s: (n.c as [unknown, string])[1] });
        st.content = true;
        break;
      case 'Math': {
        const [type, src] = n.c as [PandocNode, string];
        st.segs.push({ k: 'atom', sent: type.t === 'DisplayMath' ? '⟦$$⟧' : '⟦$⟧', inRun: true, before: () => OBJECT });
        st.flat.math.push(normMath(src));
        st.content = true;
        break;
      }
      case 'Cite':
        citeSegs(st, (n.c as [Citation[], unknown])[0]);
        break;
      case 'Note': {
        const blocks = n.c as PandocNode[];
        // A comment inside a footnote follows the marker: after.
        st.flat.notes.push(blocksFlat(blocks, st.ctx, true));
        st.segs.push({ k: 'atom', sent: '⟦fn⟧', inRun: false, before: () => OBJECT, note: true });
        st.content = true;
        break;
      }
      case 'Image': {
        const [, , [url]] = n.c as [unknown, unknown, [string, string]];
        st.segs.push({ k: 'atom', sent: `⟦img:${srcKey(url)}⟧`, inRun: false, before: () => OBJECT });
        st.content = true;
        break;
      }
      case 'RawInline': {
        const [format, raw] = n.c as [string, string];
        const comments = format === 'html' ? commentPayloads(raw) : null;
        if (comments) {
          if (!st.ctx.keepInline) hoist(st.ctx, comments, st.ctx.seen || st.content);
          st.segs.push({ k: 'cut' });
        } else if (format === 'html' || format === 'typst') {
          const lang = format;
          st.segs.push({ k: 'atom', sent: `⟦${lang}:${raw}⟧`, inRun: false, before: (prev) => lastVisible(raw, prev) });
          st.content = true;
        } else {
          // Raw TeX (`\LaTeX`) and other formats: prose to markdown-it.
          st.segs.push({ k: 'prose', s: raw });
          st.content = true;
        }
        break;
      }
      case 'Link':
        st.segs.push({ k: 'cut' });
        inlineSegs(st, (n.c as [unknown, PandocNode[]])[1]);
        st.segs.push({ k: 'cut' });
        break;
      case 'Span':
        inlineSegs(st, (n.c as [unknown, PandocNode[]])[1]);
        break;
      case 'Quoted': {
        const [type, inner] = n.c as [PandocNode, PandocNode[]];
        const q = type.t === 'SingleQuote' ? "'" : '"';
        st.segs.push({ k: 'prose', s: q });
        inlineSegs(st, inner);
        st.segs.push({ k: 'prose', s: q });
        break;
      }
      default:
        if (BOUNDARY_WRAPPERS.has(n.t)) {
          st.segs.push({ k: 'cut' });
          inlineSegs(st, kids(n));
          st.segs.push({ k: 'cut' });
        } else if (TRANSPARENT_WRAPPERS.has(n.t)) inlineSegs(st, kids(n));
    }
  }
}

const RUN_MARK = '\uE001';

/** Pandoc inlines → printed text, normalized the way the importer
 *  normalizes markdown-it's tokens. */
function flattenInlines(inlines: PandocNode[], ctx: Ctx): Flat {
  const st: InlineState = { segs: [], flat: emptyFlat(), ctx, content: false };
  inlineSegs(st, inlines);

  // printedForm per run (a markdown-it text token).
  type Piece = { k: 'prose'; s: string } | { k: 'code'; s: string } | Atom;
  const pieces: Piece[] = [];
  let run: Array<{ k: 'prose'; s: string } | Atom> = [];
  const flush = () => {
    if (!run.length) return;
    const atoms = run.filter((x): x is Atom => x.k === 'atom');
    const parts = printedForm(run.map((x) => (x.k === 'prose' ? x.s : RUN_MARK)).join('')).split(RUN_MARK);
    parts.forEach((s, i) => {
      if (s) pieces.push({ k: 'prose', s });
      if (i < atoms.length) pieces.push(atoms[i]);
    });
    run = [];
  };
  for (const seg of st.segs) {
    if (seg.k === 'prose' || (seg.k === 'atom' && seg.inRun)) run.push(seg);
    else {
      flush();
      if (seg.k === 'code' || seg.k === 'atom') {
        if (seg.k === 'atom' && seg.note) {
          // The footnote marker swallows the space run before it.
          const last = pieces[pieces.length - 1];
          if (last?.k === 'prose') {
            const nodes = [schema.text(last.s)];
            trimSpaceBeforeMarker(nodes);
            if (nodes.length) last.s = nodes[0].text ?? '';
            else pieces.pop();
          }
        }
        pieces.push(seg);
      }
    }
  }
  flush();

  // Typst's quoter across the paragraph.
  const quotes: QuoteState = createQuoteState();
  let before: string | null = null;
  let text = '';
  for (const p of pieces) {
    if (p.k === 'prose') {
      const r = smartenText(p.s, quotes, before);
      text += r.text;
      before = r.before;
    } else if (p.k === 'code') {
      text += p.s;
      before = lastVisible(p.s, before);
    } else {
      text += p.sent;
      before = p.before(before);
    }
  }
  st.flat.text = collapse(text);
  return st.flat;
}

/** Every inline container in `blocks`, flattened and joined by a space
 *  (a footnote's paragraphs, a table cell's blocks). */
function blocksFlat(blocks: PandocNode[], ctx: Ctx, seenOverride = false): Flat {
  const flats: Flat[] = [];
  const saved = ctx.seen;
  if (seenOverride) ctx.seen = true;
  const walk = (list: PandocNode[]) => {
    for (const b of list) {
      switch (b.t) {
        case 'Para':
        case 'Plain':
          flats.push(flattenInlines(kids(b), ctx));
          break;
        case 'Header':
          flats.push(flattenInlines((b.c as [number, unknown, PandocNode[]])[2], ctx));
          break;
        case 'LineBlock':
          flats.push(flattenInlines((b.c as PandocNode[][]).flatMap((line, i) => (i ? [{ t: 'LineBreak' }, ...line] : line)), ctx));
          break;
        case 'RawBlock': {
          const comments = htmlComments(b);
          if (comments) hoist(ctx, comments, true);
          break;
        }
        case 'BlockQuote':
          walk(kids(b));
          break;
        case 'Div':
          walk((b.c as [unknown, PandocNode[]])[1]);
          break;
        case 'BulletList':
          for (const item of b.c as PandocNode[][]) walk(item);
          break;
        case 'OrderedList':
          for (const item of (b.c as [unknown, PandocNode[][]])[1]) walk(item);
          break;
        default:
          break;
      }
    }
  };
  walk(blocks);
  if (seenOverride) ctx.seen = saved || flats.some((f) => !isEmptyFlat(f));
  return joinFlats(flats);
}

/** Splits comment inlines off: those before any other content (`lead`)
 *  and those after some (`trail`), and the rest. */
function withoutComments(inlines: PandocNode[]): { rest: PandocNode[]; lead: string[]; trail: string[] } {
  const rest: PandocNode[] = [];
  const lead: string[] = [];
  const trail: string[] = [];
  for (const n of inlines) {
    const comments = n.t === 'RawInline' ? htmlComments(n) : null;
    if (comments) (rest.some((r) => r.t !== 'Space' && r.t !== 'SoftBreak') ? trail : lead).push(...comments);
    else rest.push(n);
  }
  return { rest, lead, trail };
}

/** A Para/Plain's records: an image, a labeled figure, display math, or a
 *  paragraph. */
function paraRecords(inlines: PandocNode[], depth: number, ctx: Ctx, classes: string[] = []): SkeletonRecord[] {
  const { rest, lead, trail } = withoutComments(inlines);
  const solid = rest.filter((n) => n.t !== 'Space' && n.t !== 'SoftBreak');
  const hoistBoth = () => {
    if (!ctx.keepInline) {
      hoist(ctx, lead, ctx.seen);
      hoist(ctx, trail, true);
    }
    ctx.seen = true;
  };

  // A lone image: `paragraph > image`, or a labeled figure (pandoc keeps
  // the id of `![](src){#fig:x}` on the image).
  if (solid.length === 1 && solid[0].t === 'Image') {
    const [attr, , [url]] = solid[0].c as [Attr, PandocNode[], [string, string]];
    hoistBoth();
    if (attrOf(attr)[0]) return [record('figure', depth, { text: '', label: attrOf(attr)[0], src: srcKey(url) })];
    return [record('image', depth, { src: srcKey(url), classes })];
  }

  // Display math, each optionally followed by its attribute block.
  if (solid.some((n) => n.t === 'Math' && (n.c as [PandocNode])[0].t === 'DisplayMath')) {
    const groups: Array<{ src: string; attr: string[] }> = [];
    let ok = true;
    for (const n of solid) {
      if (n.t === 'Math' && (n.c as [PandocNode])[0].t === 'DisplayMath') groups.push({ src: (n.c as [unknown, string])[1], attr: [] });
      else if (n.t === 'Str' && groups.length) groups[groups.length - 1].attr.push(n.c as string);
      else {
        ok = false;
        break;
      }
    }
    const parsed = ok ? groups.map((g) => (g.attr.length ? parseAttrText(g.attr.join(' ')) : { id: '', classes: [] })) : [];
    if (ok && parsed.every(Boolean)) {
      hoistBoth();
      return groups.map((g, i) => record('math', depth, { math: [normMath(g.src)], label: parsed[i]!.id, classes: parsed[i]!.classes }));
    }
  }

  // Nothing but raw HTML elements: an HTML block to markdown-it.
  if (solid.length && solid.every((n) => n.t === 'RawInline' && (n.c as [string])[0] === 'html')) {
    hoistBoth();
    return [record('island', depth)];
  }

  const flat = flattenInlines(inlines, ctx);
  if (isEmptyFlat(flat)) return [];
  ctx.seen = true;
  return textRecords('paragraph', depth, flat, { classes });
}

const VOID_HTML = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** The tag an HTML block opens and leaves open, or null. */
function openTag(raw: string): string | null {
  const m = /^\s*<([A-Za-z][\w-]*)(?:\s[^>]*)?>/.exec(raw);
  if (!m || /\/>\s*$/.test(m[0]) || VOID_HTML.has(m[1].toLowerCase())) return null;
  return tagBalance(raw, m[1]) > 0 ? m[1] : null;
}

function tagBalance(raw: string, tag: string): number {
  const opens = raw.match(new RegExp(`<${tag}(?=[\\s>/])(?![^>]*/>)`, 'gi'))?.length ?? 0;
  const closes = raw.match(new RegExp(`</${tag}\\s*>`, 'gi'))?.length ?? 0;
  return opens - closes;
}

/** The index of the block that closes the HTML element opened at `i`, or
 *  `i` when nothing does. Raw HTML at any depth counts. */
function elementEnd(blocks: PandocNode[], i: number, tag: string): number {
  let depth = tagBalance((blocks[i].c as [string, string])[1], tag);
  for (let j = i + 1; j < blocks.length; j++) {
    const b = blocks[j];
    if (b.t === 'RawBlock' && (b.c as [string])[0] === 'html') {
      depth += tagBalance((b.c as [string, string])[1], tag);
      if (depth <= 0) return j;
    }
  }
  return i;
}

function reduceBlocks(blocks: PandocNode[], depth: number, ctx: Ctx | null, ids: Set<string>, out: SkeletonRecord[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // A top-level comment is a comment where it stands.
    if (!ctx && b.t === 'RawBlock') {
      const comments = htmlComments(b);
      if (comments) {
        for (const p of comments) out.push(record('comment', 0, { printed: false, text: p }));
        continue;
      }
    }
    const local: Ctx = ctx ?? { seen: false, before: [], after: [], ids, keepInline: false };
    const recs: SkeletonRecord[] = [];
    // An HTML element: one island through its closing tag.
    const tag = b.t === 'RawBlock' && (b.c as [string])[0] === 'html' && !htmlComments(b) ? openTag((b.c as [string, string])[1]) : null;
    if (tag) {
      const end = elementEnd(blocks, i, tag);
      local.seen = true;
      const keep = local.keepInline;
      local.keepInline = true;
      reduceBlocks(blocks.slice(i + 1, end), depth + 1, local, ids, []);
      local.keepInline = keep;
      recs.push(record('island', depth));
      i = end;
    } else if (isGridRow(b)) {
      // A grid: this row and every `.continued` row after it.
      const end = gridEnd(blocks, i);
      gridRecords(blocks.slice(i, end + 1), depth, local, recs);
      i = end;
    } else reduceBlock(b, depth, local, recs);
    if (ctx) out.push(...recs);
    else out.push(...local.before, ...recs, ...local.after);
  }
}

function reduceBlock(b: PandocNode, depth: number, ctx: Ctx, out: SkeletonRecord[]): void {
  switch (b.t) {
    case 'Para':
    case 'Plain':
      out.push(...paraRecords(kids(b), depth, ctx));
      return;
    case 'LineBlock': {
      const flat = flattenInlines((b.c as PandocNode[][]).flatMap((line, i) => (i ? [{ t: 'LineBreak' }, ...line] : line)), ctx);
      if (!isEmptyFlat(flat)) {
        ctx.seen = true;
        out.push(...textRecords('paragraph', depth, flat));
      }
      return;
    }
    case 'Header': {
      const [level, attr, inlines] = b.c as [number, Attr, PandocNode[]];
      const id = attrOf(attr)[0];
      const auto = autoIdentifier(inlines, ctx.ids);
      ctx.ids.add(id || auto);
      const flat = flattenInlines(inlines, ctx);
      ctx.seen = true;
      out.push(...textRecords(`heading-${level}`, depth, flat, { label: isAutoId(id, auto) ? '' : id }));
      return;
    }
    case 'CodeBlock': {
      const [attr, code] = b.c as [Attr, string];
      ctx.seen = true;
      out.push(record('code', depth, { text: code, classes: attrOf(attr)[1].slice(0, 1) }));
      return;
    }
    case 'RawBlock': {
      const [format, raw] = b.c as [string, string];
      const comments = format === 'html' ? commentPayloads(raw) : null;
      if (comments) {
        hoist(ctx, comments, ctx.seen);
        return;
      }
      ctx.seen = true;
      if (format === 'typst') out.push(record('raw-typst', depth, { text: raw }));
      else if (format === 'bibtex') out.push(record('bibliography', depth, { text: bibText(raw) }));
      else if (format === 'tex' && /^\\(?:newpage|pagebreak)$/.test(raw.trim())) out.push(record('pagebreak', depth));
      else if (format === 'tex') out.push(...paraRecords([{ t: 'Str', c: raw }], depth, ctx));
      else if (format === 'html') out.push(record('island', depth));
      else out.push(record('code', depth, { text: raw, classes: [`=${format}`] }));
      return;
    }
    case 'BlockQuote':
      out.push(record('quote', depth));
      reduceBlocks(kids(b), depth + 1, ctx, ctx.ids, out);
      return;
    case 'BulletList':
    case 'OrderedList': {
      const ordered = b.t === 'OrderedList';
      const [start, items] = ordered ? [(b.c as [[number], PandocNode[][]])[0][0], (b.c as [unknown, PandocNode[][]])[1]] : [1, b.c as PandocNode[][]];
      out.push(record('list', depth, { classes: ordered ? ['ordered', ...(start !== 1 ? [`start=${start}`] : [])] : ['bullet'] }));
      for (const item of items) {
        out.push(record('item', depth + 1));
        reduceBlocks(item, depth + 2, ctx, ctx.ids, out);
      }
      return;
    }
    case 'HorizontalRule':
      ctx.seen = true;
      out.push(record('hr', depth));
      return;
    case 'Figure': {
      const [attr, [, caption], content] = b.c as [Attr, [unknown, PandocNode[]], PandocNode[]];
      ctx.seen = true;
      let src = '';
      const findImage = (list: PandocNode[]): void => {
        for (const n of list) {
          if (src) return;
          if (n.t === 'Image') src = (n.c as [unknown, unknown, [string]])[2][0];
          else if (Array.isArray(n.c)) findImage((n.c as unknown[]).filter((x): x is PandocNode => typeof x === 'object' && x !== null && 't' in x));
        }
      };
      findImage(content);
      out.push(...textRecords('figure', depth, blocksFlat(caption, ctx), { label: attrOf(attr)[0], src: srcKey(src) }));
      return;
    }
    case 'Table':
      out.push(...tableRecords(b, null, depth, ctx));
      return;
    case 'Div':
      divRecords(b, depth, ctx, out);
      return;
    case 'DefinitionList':
    default: {
      // Off the rails (definition lists and anything newer): an island.
      // Its content is walked only for the comments it hoists and the
      // heading ids it takes; the records are discarded.
      const inner: SkeletonRecord[] = [];
      if (b.t === 'DefinitionList') {
        for (const [term, defs] of b.c as Array<[PandocNode[], PandocNode[][]]>) {
          flattenInlines(term, ctx);
          for (const d of defs) reduceBlocks(d, depth + 1, ctx, ctx.ids, inner);
        }
      }
      ctx.seen = true;
      out.push(record('island', depth));
    }
  }
}

const divClasses = (b: PandocNode) => attrOf((b.c as [Attr])[0])[1];
const railOf = (classes: string[]) => RAIL_CLASSES.find((c) => classes.includes(c));
const isComment = (b: PandocNode) => b.t === 'RawBlock' && htmlComments(b) !== null;

/** A `.columns` div in the grid-row form: nothing but `.column` divs
 *  (and comments). Any other content makes it the unknown-div island. */
function isGridRow(b: PandocNode): boolean {
  if (b.t !== 'Div' || railOf(divClasses(b)) !== 'columns') return false;
  const solid = (b.c as [unknown, PandocNode[]])[1].filter((n) => !isComment(n));
  return solid.length > 0 && solid.every((n) => n.t === 'Div' && divClasses(n).includes('column'));
}

/** The index of a grid's last row: the row at `i` and every `.continued`
 *  row after it, comments between rows allowed. A row without the class
 *  starts a new grid (the plan's step 4: consecutive divs merge only
 *  through `.continued`). */
function gridEnd(blocks: PandocNode[], i: number): number {
  let end = i;
  for (let j = i + 1; j < blocks.length; j++) {
    const b = blocks[j];
    if (isComment(b)) continue;
    if (!isGridRow(b) || !divClasses(b).includes('continued')) break;
    end = j;
  }
  return end;
}

/** One grid from its row divs: one `columns` record, its `cols` the first
 *  row's cell count (the model's `columns.length`), then every row's
 *  `column` records in order. A comment between rows or between cells is
 *  inside the grid, so it is hoisted like any nested comment. */
function gridRecords(group: PandocNode[], depth: number, ctx: Ctx, out: SkeletonRecord[]): void {
  const cells = (row: PandocNode) => (row.c as [unknown, PandocNode[]])[1];
  out.push(record('columns', depth, { cols: cells(group[0]).filter((n) => n.t === 'Div').length }));
  for (const row of group) {
    if (row.t !== 'Div') {
      reduceBlock(row, depth, ctx, out);
      continue;
    }
    for (const child of cells(row)) {
      if (child.t !== 'Div') {
        reduceBlock(child, depth + 1, ctx, out);
        continue;
      }
      out.push(record('column', depth + 1));
      reduceBlocks(cells(child), depth + 2, ctx, ctx.ids, out);
    }
  }
}

function divRecords(b: PandocNode, depth: number, ctx: Ctx, out: SkeletonRecord[]): void {
  const [rawAttr, children] = b.c as [Attr, PandocNode[]];
  const attr = attrOf(rawAttr);
  const classes = attr[1];
  const rail = railOf(classes);
  const solid = children.filter((n) => !isComment(n));
  const island = () => {
    // A div is a container until its class decides: its comments are
    // hoisted by the same rule as a solution's.
    reduceBlocks(children, depth + 1, ctx, ctx.ids, []);
    ctx.seen = true;
    out.push(record('island', depth));
  };
  if (rail === 'solution') {
    out.push(record('solution', depth));
    reduceBlocks(children, depth + 1, ctx, ctx.ids, out);
    return;
  }
  if (rail === 'columns') {
    // Reached outside a block list (reduceBlocks groups the rows): one row.
    if (!isGridRow(b)) return island();
    gridRecords([b], depth, ctx, out);
    return;
  }
  if (rail === 'table') {
    if (solid.length !== 1 || solid[0].t !== 'Table') return island();
    for (const child of children) {
      if (child === solid[0]) out.push(...tableRecords(child, attr, depth, ctx));
      else reduceBlock(child, depth, ctx, out);
    }
    return;
  }
  if (rail && ALIGN_CLASSES.has(rail)) {
    if (solid.length !== 1 || (solid[0].t !== 'Para' && solid[0].t !== 'Plain')) return island();
    const own = classes.filter((c) => ALIGN_CLASSES.has(c));
    for (const child of children) {
      if (child !== solid[0]) {
        reduceBlock(child, depth, ctx, out);
        continue;
      }
      const recs = paraRecords(kids(child), depth, ctx, own);
      if (recs.length && recs[0].kind !== 'paragraph' && recs[0].kind !== 'image') {
        ctx.seen = true;
        out.push(record('island', depth));
      } else out.push(...recs);
    }
    return;
  }
  island();
}

const ALIGN_NAME: Record<string, string> = { AlignDefault: 'left', AlignLeft: 'left', AlignRight: 'right', AlignCenter: 'center' };

/** `rNcM:value` entries of a `.table` div attribute. */
function cellMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (value ?? '').trim().split(/\s+/).filter(Boolean)) {
    const m = /^(r\d+c\d+):(.+)$/.exec(part);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

function tableRecords(t: PandocNode, divAttr: Attr | null, depth: number, ctx: Ctx): SkeletonRecord[] {
  const [attr, [, captionBlocks], colspecs, [, headRows], bodies, [, footRows]] = t.c as [
    Attr,
    [unknown, PandocNode[]],
    Array<[PandocNode, unknown]>,
    [unknown, PandocNode[]],
    Array<[unknown, unknown, PandocNode[], PandocNode[]]>,
    [unknown, PandocNode[]],
  ];
  // For placing a comment, a table's printed content is its cells,
  // row-major: a comment before the first non-empty cell's text goes
  // before the table, any later one after it. The caption does not count
  // (a `.table` attribute, or a `: Caption` line pandoc accepts before or
  // after the table; its AST does not say which).
  const cols = colspecs.length;
  const colAlign = colspecs.map(([a]) => ALIGN_NAME[a.t] ?? 'left');
  const decimal = new Set((divAttr ? kv(divAttr, 'decimal') ?? '' : '').split(/[\s,]+/).filter(Boolean).map(Number));
  const alignOverride = cellMap(divAttr ? kv(divAttr, 'aligns') : undefined);
  const covered = new Set<string>();
  for (const [origin, size] of cellMap(divAttr ? kv(divAttr, 'spans') : undefined)) {
    const [r, c] = origin.slice(1).split('c').map(Number);
    const m = /^(\d+)x(\d+)$/.exec(size);
    if (!m) continue;
    for (let dr = 0; dr < +m[2]; dr++) for (let dc = 0; dc < +m[1]; dc++) if (dr || dc) covered.add(`r${r + dr}c${c + dc}`);
  }

  // Row = [Attr, [Cell]]; Cell = [Attr, Alignment, RowSpan, ColSpan, [Block]].
  type Cell = [unknown, PandocNode, number, number, PandocNode[]];
  const rowCells = (row: unknown) => (row as [unknown, Cell[]])[1];
  const emptyCell = (cell: Cell) => cell[4].every((b) => (b.t === 'Plain' || b.t === 'Para') && !kids(b).length);
  // The headerless form: a header row of empty cells is not a row.
  const head = (headRows as unknown[]).filter((row) => !rowCells(row).every(emptyCell));
  const body = [...bodies.flatMap(([, , inter, rows]) => [...(inter as unknown[]), ...(rows as unknown[])]), ...(footRows as unknown[])];
  const rows = [...head, ...body];

  const cells: SkeletonRecord[] = [];
  const aligns: string[] = [];
  rows.forEach((row, r) => {
    let c = 0;
    for (const cell of rowCells(row)) {
      // A pipe table writes the cells a span covers as empty cells.
      if (!covered.has(`r${r}c${c}`)) {
        const base = colAlign[c] ?? 'left';
        aligns.push(alignOverride.get(`r${r}c${c}`) ?? (decimal.has(c) && base === 'right' ? 'decimal' : base));
        const flat = blocksFlat(cell[4], ctx);
        if (!isEmptyFlat(flat)) ctx.seen = true;
        cells.push(...textRecords('paragraph', depth + 1, flat));
      }
      c += cell[3] || 1;
    }
  });

  let label = divAttr?.[0] || attrOf(attr)[0];
  const divCaption = divAttr ? kv(divAttr, 'caption') : undefined;
  let caption: string;
  if (divCaption !== undefined) caption = flattenInlines([{ t: 'Str', c: divCaption }], ctx).text;
  else {
    caption = blocksFlat(captionBlocks, ctx).text;
    // `: Caption {#tbl:x}` keeps the attribute block as text in 3.4.
    const m = /^(.*?)\s*\{#([^\s{}]+)\}$/.exec(caption);
    if (m && !label) {
      label = m[2];
      caption = m[1];
    }
  }
  ctx.seen = true; // a table is printed even when every cell is empty
  return [record('table', depth, { text: caption || undefined, label, rows: rows.length, head: head.length, cols, aligns }), ...cells];
}

function metaInlines(v: PandocNode | undefined): PandocNode[] | null {
  if (!v) return null;
  switch (v.t) {
    case 'MetaInlines':
      return kids(v);
    case 'MetaString':
      return [{ t: 'Str', c: v.c as string }];
    case 'MetaBlocks': {
      const blocks = kids(v);
      return blocks.length === 1 && (blocks[0].t === 'Para' || blocks[0].t === 'Plain') ? kids(blocks[0]) : null;
    }
    case 'MetaList':
      return kids(v).flatMap((item, i) => {
        const inl = metaInlines(item) ?? [];
        return i ? [{ t: 'Str', c: ',' }, { t: 'Space' }, ...inl] : inl;
      });
    default:
      return null;
  }
}

/** A pandoc JSON document (`pandoc -f markdown-smart -t json`) reduced to
 *  skeleton records: the front matter (title, author, date, abstract) and
 *  then the body. */
export function pandocSkeleton(ast: PandocDoc): SkeletonRecord[] {
  const out: SkeletonRecord[] = [];
  const ids = new Set<string>();
  const fresh = (): Ctx => ({ seen: false, before: [], after: [], ids, keepInline: false });
  for (const [key, kind] of [
    ['title', 'title'],
    ['author', 'author'],
    ['date', 'date'],
  ] as const) {
    const inl = metaInlines(ast.meta[key]);
    if (!inl) continue;
    const ctx = fresh();
    const recs = textRecords(kind, 0, flattenInlines(inl, ctx));
    out.push(...ctx.before, ...recs, ...ctx.after);
  }
  const abstract = ast.meta.abstract;
  if (abstract) {
    const blocks = abstract.t === 'MetaBlocks' ? kids(abstract) : [{ t: 'Para', c: metaInlines(abstract) ?? [] }];
    const ctx = fresh();
    const recs: SkeletonRecord[] = [record('abstract', 0)];
    reduceBlocks(blocks, 1, ctx, ids, recs);
    out.push(...ctx.before, ...recs, ...ctx.after);
  }
  reduceBlocks(ast.blocks, 0, null, ids, out);
  return out;
}
