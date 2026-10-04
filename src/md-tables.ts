// Pipe tables and the `.table` div: the Markdown form of a native table
// (docs/MARKDOWN-SOURCE-PLAN.md, "The format", table div grammar).
//
// A pipe table says what pandoc's pipe tables can say: the cells (one line
// each), the header row, and one alignment per column. Everything else a
// Plass table holds rides as attributes on a wrapping fenced div, which
// pandoc keeps and ignores:
//
//   ::: {#tbl:x .table caption="Results" style=grid density=compact inset=9pt
//        columns="auto 1fr 2fr" font-size=0.85em decimal="2" rules="1:light 3:none"
//        fills="r0:gray-dark r3c1:yellow" valign="r1c2:middle" spans="r2c0:2x1"
//        aligns="r2c1:center"}
//   | Name | Score | Note |
//   ...
//   :::
//
// Positions are 0-based written-grid coordinates: `rN` counts Plass rows
// (the synthetic blank header line is not a row), `cM` counts columns
// including cells a span covers, and a cell is named by its origin. The
// div is written only when the table needs one; a table with nothing to
// say beyond its pipe table is a bare pipe table.
//
// Everything here is a pure function over table nodes. The reader and the
// writer own the surrounding syntax: the div fence and its attribute block
// (md-attrs), the markdown-it tokens a pipe table arrives as, and the
// inline Markdown of a cell (`cellMd`). The writer only ever writes values
// the reader accepts, so a file Plass wrote reads back with no warning.

import type { Node as PMNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { schema } from './schema';
import { normalizeInsetPt, normalizeTableColumns } from './table-geometry';
import { CELL_FILL_TYPST } from './table-fills';
import { ROW_RULE_STROKE } from './table-rules';
import { TABLE_DENSITY_INSET_PT } from './table-density';

/** A pandoc attribute block, `{#id .class key=value}`, in pandoc's own
 *  shape: identifier, classes, and the key–value pairs in written order. */
export interface DivAttrs {
  id: string;
  classes: string[];
  keyvals: Array<[string, string]>;
}

type Warn = (message: string) => void;
type CellAlign = 'left' | 'center' | 'right' | 'decimal' | null;

const noWarn: Warn = () => {};

/** Each distinct message once per table, however many cells raise it. */
function once(warn: Warn): Warn {
  const seen = new Set<string>();
  return (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    warn(message);
  };
}

const STYLES = ['booktabs', 'grid', 'plain'];
const DENSITIES = Object.keys(TABLE_DENSITY_INSET_PT).filter(Boolean);
const FILLS = Object.keys(CELL_FILL_TYPST);
const RULES = Object.keys(ROW_RULE_STROKE);
const VALIGNS = ['top', 'middle', 'bottom'];
const ALIGNS = ['left', 'center', 'right', 'decimal'];

/** The attribute keys, in the order the writer emits them. */
const KEYS = ['caption', 'style', 'density', 'inset', 'columns', 'font-size', 'decimal', 'rules', 'fills', 'valign', 'spans', 'aligns'];

/** A font size the reader accepts: a positive em length, as the `.typ`
 *  reader accepts `text(size: …em, table(…))`. */
const FONT_SIZE_RE = /^(?:\d+(?:\.\d+)?|\.\d+)em$/;
/** An identifier pandoc 3.4 reads in an attribute block: letters, digits
 *  and `-_:.` (it may start with any of them; `/`, `+`, `@`, a quote end
 *  the block). Every portable citation key is one. */
const IDENTIFIER_RE = /^[\p{L}\p{N}_:.-]+$/u;

// ---------- the written grid ----------

/** A cell at its origin in the written grid. */
interface GridCell {
  node: PMNode;
  row: number;
  col: number;
  colspan: number;
  rowspan: number;
}

interface Grid {
  width: number;
  height: number;
  /** Origin cells, row-major. */
  cells: GridCell[];
}

function gridOf(table: PMNode): Grid {
  const map = TableMap.get(table);
  const cells: GridCell[] = [];
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const pos = map.map[r * map.width + c];
      if (!pos) continue; // a hole in a malformed table: written empty
      const rect = map.findCell(pos);
      if (rect.left !== c || rect.top !== r) continue; // covered by a span
      cells.push({ node: table.nodeAt(pos)!, row: r, col: c, colspan: rect.right - rect.left, rowspan: rect.bottom - rect.top });
    }
  }
  return { width: map.width, height: map.height, cells };
}

/** A cell's horizontal alignment; a value with no Markdown form (a pasted
 *  `justify`) reads as none, and `tableDivAttrs` reports it. */
function alignOf(cell: PMNode): CellAlign {
  const align = cell.attrs.align as unknown;
  return typeof align === 'string' && ALIGNS.includes(align) ? (align as CellAlign) : null;
}

/** Each column's alignment as its delimiter row says it: the value most of
 *  the column's origin cells hold (the first one seen wins a tie). Every
 *  cell that differs is an `aligns` override. */
function columnAligns(grid: Grid): CellAlign[] {
  return Array.from({ length: grid.width }, (_, c) => {
    const counts = new Map<CellAlign, number>();
    for (const cell of grid.cells) {
      if (cell.col !== c) continue;
      const align = alignOf(cell.node);
      counts.set(align, (counts.get(align) ?? 0) + 1);
    }
    let best: CellAlign = null;
    let most = 0;
    for (const [align, n] of counts) {
      if (n > most) {
        best = align;
        most = n;
      }
    }
    return best;
  });
}

/** `pos:value` with exactly one colon; null otherwise. */
function pair(entry: string): [string, string] | null {
  const m = /^([^:]+):([^:]+)$/.exec(entry);
  return m ? [m[1], m[2]] : null;
}

const DELIMITER: Record<string, string> = { left: ':---', center: ':---:', right: '---:', decimal: '---:' };

// ---------- writing ----------

/** The `.table` div's attributes for `table`, or null when it needs none
 *  and is written as a bare pipe table. The table's `params` (verbatim
 *  Typst arguments only the `.typ` reader produces) have no Markdown form:
 *  dropped with a warning. */
export function tableDivAttrs(table: PMNode, warnTo: Warn = noWarn): DivAttrs | null {
  const warn = once(warnTo);
  const attrs = table.attrs;
  const grid = gridOf(table);
  const keyvals: Array<[string, string]> = [];
  const put = (key: string, value: string) => keyvals.push([key, value]);

  if ((attrs.params as string)?.trim()) warn('table Typst parameters (params) have no Markdown form — dropped');

  let id = (attrs.label as string) || '';
  if (id && !IDENTIFIER_RE.test(id)) {
    warn(`table label "${id}" is not a Markdown identifier — dropped`);
    id = '';
  }
  const caption = (attrs.caption as string) || '';
  if (caption) put('caption', caption);
  // An empty style is the Typst exporter's grid; booktabs is the default.
  const style = (attrs.style as string) || 'grid';
  if (style !== 'booktabs') {
    if (STYLES.includes(style)) put('style', style);
    else warn(`table style "${style}" has no Markdown form — written as the default`);
  }
  const density = (attrs.density as string) || '';
  if (density) {
    if (DENSITIES.includes(density)) put('density', density);
    else warn(`table density "${density}" has no Markdown form — dropped`);
  }
  const inset = normalizeInsetPt(attrs.insetPt);
  if (inset !== null) put('inset', `${inset}pt`);
  const columns = normalizeTableColumns(attrs.columnWidths);
  if (columns) {
    if (columns.length === grid.width) put('columns', columns.join(' '));
    else warn('table column widths do not match its column count — dropped');
  }
  const fontSize = (attrs.fontSize as string) || '';
  if (fontSize) {
    if (FONT_SIZE_RE.test(fontSize)) put('font-size', fontSize);
    else warn(`table font size "${fontSize}" has no Markdown form — dropped`);
  }

  const aligns = columnAligns(grid);
  const decimal = aligns.flatMap((align, c) => (align === 'decimal' ? [String(c)] : []));
  if (decimal.length) put('decimal', decimal.join(' '));

  const rules: string[] = [];
  table.forEach((row, _offset, r) => {
    const rule = (row.attrs.rule as string) || '';
    if (!rule) return;
    if (RULES.includes(rule)) rules.push(`${r}:${rule}`);
    else warn(`table row rule "${rule}" has no Markdown form — dropped`);
  });
  if (rules.length) put('rules', rules.join(' '));

  // A fill shared by every cell of a row is said once for the row.
  const fillOf = (cell: GridCell): string => {
    const fill = (cell.node.attrs.fill as string) || '';
    if (!fill || FILLS.includes(fill)) return fill;
    warn(`table cell fill "${fill}" has no Markdown form — dropped`);
    return '';
  };
  const fills: string[] = [];
  for (let r = 0; r < grid.height; r++) {
    const row = grid.cells.filter((cell) => cell.row === r);
    const values = row.map(fillOf);
    if (values.length && values[0] && values.every((v) => v === values[0])) fills.push(`r${r}:${values[0]}`);
    else row.forEach((cell, i) => values[i] && fills.push(`r${r}c${cell.col}:${values[i]}`));
  }
  if (fills.length) put('fills', fills.join(' '));

  // One vertical alignment shared by every cell is said once for the table.
  const valignOf = (cell: GridCell): string => {
    const valign = (cell.node.attrs.valign as string) || '';
    if (!valign || VALIGNS.includes(valign)) return valign;
    warn(`table cell vertical alignment "${valign}" has no Markdown form — dropped`);
    return '';
  };
  const valigns = grid.cells.map(valignOf);
  if (valigns.length && valigns[0] && valigns.every((v) => v === valigns[0])) put('valign', valigns[0]);
  else {
    const entries = grid.cells.flatMap((cell, i) => (valigns[i] ? [`r${cell.row}c${cell.col}:${valigns[i]}`] : []));
    if (entries.length) put('valign', entries.join(' '));
  }

  const spans = grid.cells.flatMap((cell) =>
    cell.colspan > 1 || cell.rowspan > 1 ? [`r${cell.row}c${cell.col}:${cell.colspan}x${cell.rowspan}`] : [],
  );
  if (spans.length) put('spans', spans.join(' '));

  const unsupported = new Set<string>();
  const overrides = grid.cells.flatMap((cell) => {
    const raw = cell.node.attrs.align as unknown;
    if (raw != null && raw !== '' && !ALIGNS.includes(raw as string)) unsupported.add(String(raw));
    const align = alignOf(cell.node);
    return align === aligns[cell.col] ? [] : [`r${cell.row}c${cell.col}:${align ?? 'default'}`];
  });
  for (const value of unsupported) warn(`table cell alignment "${value}" has no Markdown form — written as the default`);
  if (overrides.length) put('aligns', overrides.join(' '));

  if (!id && !keyvals.length) return null;
  return { id, classes: ['table'], keyvals };
}

/** The pipe table for `table`: a header line, the delimiter row, one line
 *  per body row. `cellMd` writes a paragraph's inline Markdown (the
 *  serializer's inline writer); this escapes its pipes and folds it onto
 *  one line.
 *
 *  The first Plass row is the header line when all its cells are header
 *  cells and at least one has text. Otherwise the header line is blank
 *  (`|   |   |`, pandoc's headerless form, which the reader drops) and
 *  every Plass row is a body line; a header row of empty cells, and header
 *  cells anywhere else, are written as body cells with a warning. Cells a
 *  span covers are written empty. */
export function pipeTableMd(table: PMNode, cellMd: (paragraph: PMNode) => string, warnTo: Warn = noWarn): string {
  const warn = once(warnTo);
  const grid = gridOf(table);
  if (!grid.width || !grid.height) {
    warn('a table with no cells has no Markdown form — dropped');
    return '';
  }
  const text = Array.from({ length: grid.height }, () => new Array<string>(grid.width).fill(''));
  for (const cell of grid.cells) {
    text[cell.row][cell.col] = escapeCellProse(cellMd(cellParagraph(cell.node, warn))).replace(/^[ \t]+|[ \t]+$/g, '');
  }

  const first = table.child(0);
  const headerRow = first.childCount > 0 && allHeader(first);
  const writeHeader = headerRow && text[0].some(Boolean);
  if (headerRow && !writeHeader) warn('a table header row with no text is written as an ordinary row');
  let strayHeader = false;
  table.forEach((row, _offset, r) => {
    if (writeHeader && r === 0) return;
    row.forEach((cell) => {
      if (cell.type.name === 'table_header') strayHeader = true;
    });
  });
  if (strayHeader) warn('table header cells outside a header first row are written as ordinary cells');

  const line = (cells: string[]) => `|${cells.map((t) => (t ? ` ${t} ` : '   ')).join('|')}|`;
  const delimiter = `|${columnAligns(grid).map((align) => ` ${align ? DELIMITER[align] : '---'} `).join('|')}|`;
  const header = writeHeader ? text[0] : new Array<string>(grid.width).fill('');
  const body = writeHeader ? text.slice(1) : text;
  return [line(header), delimiter, ...body.map(line)].join('\n');
}

function allHeader(row: PMNode): boolean {
  let all = true;
  row.forEach((cell) => {
    if (cell.type.name !== 'table_header') all = false;
  });
  return all;
}

/** A cell as the one paragraph a pipe table can hold. Paragraphs join with
 *  a space; the content a pipe-table cell cannot carry is dropped (the
 *  `.typ` exporter refuses the same content in a cell); every loss warns. */
function cellParagraph(cell: PMNode, warn: Warn): PMNode {
  const inlines: PMNode[] = [];
  let paragraphs = 0;
  const join = () => {
    if (paragraphs++ > 0) inlines.push(schema.text(' '));
  };
  const addInline = (node: PMNode) => {
    switch (node.type.name) {
      case 'footnote':
        warn('footnotes in table cells have no Markdown form — dropped');
        return;
      case 'image':
        warn('images in table cells have no Markdown form — dropped');
        return;
      case 'typst_inline':
        if (node.attrs.lang === 'html') {
          warn('inline HTML in table cells has no Markdown form — dropped');
          return;
        }
        break;
      case 'hard_break':
        warn('a line break in a table cell is written as a space');
        inlines.push(schema.text(' ', node.marks));
        return;
    }
    inlines.push(node);
  };
  const flattened = () => warn('a table cell holds one paragraph in Markdown — other blocks are flattened into it');
  cell.forEach(function block(node: PMNode) {
    if (node.type.name === 'paragraph') {
      if (node.attrs.keep || node.attrs.align) warn('paragraph alignment and keep inside table cells have no Markdown form — dropped');
      join();
      node.forEach(addInline);
    } else if (node.isTextblock) {
      flattened();
      join();
      node.forEach(addInline);
    } else if (node.type.name === 'math_display') {
      flattened();
      join();
      inlines.push(schema.nodes.math_inline.create({ src: node.attrs.src as string }));
    } else if (node.isLeaf) {
      warn(`a ${node.type.name.replace(/_/g, ' ')} in a table cell has no Markdown form — dropped`);
    } else {
      flattened();
      node.forEach(block);
    }
  });
  if (paragraphs > 1) warn('a table cell with several paragraphs is written as one, joined by a space');
  return schema.nodes.paragraph.create(null, inlines);
}

/** Escape a cell's inline Markdown for a pipe-table row. A `|` in plain
 *  text becomes `\|`; a `|` inside a code span or `$…$` math is left alone,
 *  because pandoc's cell splitter skips both and reads a backslash there
 *  literally (`` `a\|b` `` is the code `a\|b`; `\|` in math is ‖). A row is
 *  one line, so line breaks fold to spaces. Math is recognized by pandoc's
 *  `tex_math_dollars` rule: an opening `$` followed by a non-space, a
 *  closing `$` preceded by a non-space and not followed by a digit,
 *  backslash escapes inside. */
export function escapeCellProse(md: string): string {
  let out = '';
  let i = 0;
  while (i < md.length) {
    const ch = md[i];
    if (ch === '\\') {
      const next = md[i + 1];
      if (next === undefined) {
        out += ch;
        i++;
      } else {
        // A backslash before a newline is a hard break; on one line it is a space.
        out += next === '\n' ? ' ' : ch + next;
        i += 2;
      }
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (md[i + run] === '`') run++;
      const close = codeSpanClose(md, i + run, run);
      if (close < 0) {
        out += md.slice(i, i + run);
        i += run;
      } else {
        out += md.slice(i, close).replace(/\n/g, ' ');
        i = close;
      }
      continue;
    }
    if (ch === '$') {
      const end = mathEnd(md, i);
      if (end < 0) {
        out += ch;
        i++;
      } else {
        out += md.slice(i, end).replace(/\n/g, ' ');
        i = end;
      }
      continue;
    }
    out += ch === '|' ? '\\|' : ch === '\n' ? ' ' : ch;
    i++;
  }
  return out;
}

/** The end (exclusive) of the code span whose opening run of `run`
 *  backticks ends at `from`: the next run of exactly `run` backticks. */
function codeSpanClose(md: string, from: number, run: number): number {
  let i = from;
  while (i < md.length) {
    if (md[i] !== '`') {
      i++;
      continue;
    }
    let n = 1;
    while (md[i + n] === '`') n++;
    if (n === run) return i + n;
    i += n;
  }
  return -1;
}

/** The end (exclusive) of the math that opens at `md[start] === '$'`, or
 *  -1 when that dollar is literal (pandoc's `tex_math_dollars`). */
function mathEnd(md: string, start: number): number {
  if (md[start + 1] === '$') {
    // Display math: up to the next `$$`, no blank line inside.
    const close = md.indexOf('$$', start + 2);
    if (close < 0 || close === start + 2 || /\n[ \t]*\n/.test(md.slice(start, close))) return -1;
    return close + 2;
  }
  const first = md[start + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  let i = start + 1;
  while (i < md.length) {
    const ch = md[i];
    if (ch === '\\') {
      if (md.startsWith('\\text{', i)) {
        // \text{…} may hold a `$`: skip its balanced braces.
        let depth = 0;
        let j = i + 5;
        for (; j < md.length; j++) {
          if (md[j] === '\\') j++;
          else if (md[j] === '{') depth++;
          else if (md[j] === '}' && --depth === 0) break;
        }
        if (j >= md.length) return -1;
        i = j + 1;
      } else i += 2;
      continue;
    }
    if (ch === '$') return /\d/.test(md[i + 1] ?? '') ? -1 : i + 1;
    if (/\s/.test(ch)) {
      const ws = /^\s+/.exec(md.slice(i))![0];
      // Whitespace may not precede the closing dollar, and math never
      // crosses a blank line.
      if (md[i + ws.length] === '$' || /\n[ \t]*\n/.test(ws)) return -1;
      i += ws.length;
      continue;
    }
    i++;
  }
  return -1;
}

// ---------- reading ----------

/** A cell's alignment from its delimiter-row column, given the `style`
 *  markdown-it writes on the `th`/`td` (`text-align:left`, …): `---` is no
 *  alignment (pandoc's AlignDefault), `:---` left, `:---:` center, `---:`
 *  right. */
export function delimiterAlign(style: string | null): 'left' | 'center' | 'right' | null {
  const m = /text-align:\s*(left|center|right)/.exec(style ?? '');
  return m ? (m[1] as 'left' | 'center' | 'right') : null;
}

/** The caption a line states, by pandoc's `table_captions` rule (the line
 *  directly before or after a table): `:` not followed by punctuation, or
 *  `Table:`/`table:`, then the caption text. Null when it is not one. */
export function captionFromLine(text: string): string | null {
  const m = /^(?::(?!\p{P})|[Tt]able:)\s*(\S[\s\S]*)$/u.exec(text.trim());
  return m ? m[1].trim() : null;
}

/** markdown-it reads the caption line directly after a pipe table as one
 *  more body row: its first cell is the line, the others are empty. Pop
 *  that row and return its caption; null when the last row is not one.
 *  `lastLine`, when the reader has it, is the source line that row came
 *  from: a line with a cell pipe is a row to pandoc, never a caption, so a
 *  written row `| : x |   |` stays a row. A table caption is plain text, so
 *  emphasis is read as its text and a footnote or an image in the line is
 *  dropped with a warning. */
export function takeCaptionLine(table: PMNode, warn: Warn = noWarn, lastLine?: string): { table: PMNode; caption: string } | null {
  if (table.childCount < 2) return null;
  if (lastLine !== undefined && hasRowPipe(lastLine)) return null;
  const last = table.child(table.childCount - 1);
  if (!last.childCount || last.child(0).type.name !== 'table_cell') return null;
  let rest = true;
  last.forEach((cell, _offset, i) => {
    if (i > 0 && !isEmptyCell(cell)) rest = false;
  });
  if (!rest) return null;
  const dropped = new Set<string>();
  const caption = captionFromLine(plainText(last.child(0), dropped));
  if (caption === null) return null;
  for (const name of dropped) warn(`a ${name} in a table caption line has no place in the caption — dropped`);
  const rows: PMNode[] = [];
  table.forEach((row, _offset, i) => {
    if (i < table.childCount - 1) rows.push(row);
  });
  return { table: table.type.create(table.attrs, rows), caption };
}

/** A cell's text as a plain caption holds it: inline math stays `$…$`,
 *  citations and references keep their Markdown form. */
function plainText(cell: PMNode, dropped: Set<string>): string {
  let text = '';
  cell.descendants((node) => {
    switch (node.type.name) {
      case 'text':
        text += node.text;
        break;
      case 'math_inline':
        text += `$${node.attrs.src as string}$`;
        break;
      case 'citation':
        text += `[@${node.attrs.key as string}]`;
        break;
      case 'eq_ref':
        text += `@${node.attrs.label as string}`;
        break;
      case 'typst_inline':
        text += node.attrs.src as string;
        break;
      case 'hard_break':
        text += ' ';
        break;
      case 'footnote':
      case 'image':
        dropped.add(node.type.name);
        return false;
      default:
        if (node.isBlock && text) text += ' ';
    }
    return true;
  });
  return text;
}

/** Whether a line holds a pipe that separates cells: unescaped, outside
 *  code and math (exactly the pipes `escapeCellProse` would escape). */
function hasRowPipe(line: string): boolean {
  const flat = line.replace(/\n/g, ' ');
  return escapeCellProse(flat) !== flat;
}

function isEmptyCell(cell: PMNode): boolean {
  let empty = true;
  cell.descendants((node) => {
    if (node.isInline) empty = false;
    return empty;
  });
  return empty;
}

/** A header row whose cells are all empty is the blank header line of a
 *  headerless table: not a Plass row. A table that has no other row keeps
 *  it as one empty body row. */
function dropBlankHeaderRow(table: PMNode): PMNode {
  const first = table.child(0);
  if (!first.childCount || !allHeader(first)) return table;
  let blank = true;
  first.forEach((cell) => {
    if (!isEmptyCell(cell)) blank = false;
  });
  if (!blank) return table;
  const rows: PMNode[] = [];
  table.forEach((row, _offset, i) => {
    if (i > 0) rows.push(row);
  });
  if (!rows.length) {
    const cells: PMNode[] = [];
    first.forEach((cell) => cells.push(schema.nodes.table_cell.create(cell.attrs, cell.content)));
    rows.push(first.type.create(first.attrs, cells));
  }
  return table.type.create(table.attrs, rows);
}

/** Read a pipe table as markdown-it delivered it (header row as header
 *  cells, each cell aligned by `delimiterAlign`) together with its `.table`
 *  div, if any: a trailing caption line becomes the caption (unless the div
 *  sets one), the blank header line of a headerless table is dropped, and
 *  the div's attributes apply. `lastLine` is the source of the table's last
 *  row, as for `takeCaptionLine`. */
export function readPipeTable(table: PMNode, attrs: DivAttrs | null, warnTo: Warn = noWarn, lastLine?: string): PMNode {
  const warn = once(warnTo);
  let result = table;
  let caption: string | null = null;
  if (attrs?.keyvals.some(([key]) => key === 'caption')) {
    if (takeCaptionLine(result, noWarn, lastLine)) warn('a table has both a caption attribute and a caption line — the line is kept as a row');
  } else {
    const line = takeCaptionLine(result, warn, lastLine);
    if (line) {
      result = line.table;
      caption = line.caption;
    }
  }
  result = dropBlankHeaderRow(result);
  if (attrs) result = applyTableDivAttrs(result, attrs, warn);
  if (caption !== null) result = result.type.create({ ...result.attrs, caption }, result.content);
  return result;
}

interface Position {
  row: number;
  col: number;
}

/** Apply a `.table` div's attributes to the table read from its pipe table
 *  (blank header line already dropped, so `rN` is the Nth Plass row). A
 *  value the grammar does not allow, an unknown key or class, or a
 *  position outside the table or not at a cell's origin warns and is
 *  ignored; nothing in the table is dropped. */
export function applyTableDivAttrs(table: PMNode, attrs: DivAttrs, warnTo: Warn = noWarn): PMNode {
  const warn = once(warnTo);
  const grid = gridOf(table);
  const values = new Map<string, string>();
  for (const [key, value] of attrs.keyvals) {
    if (KEYS.includes(key)) values.set(key, value);
    else warn(`unknown table attribute "${key}" dropped`);
  }
  for (const cls of attrs.classes) if (cls !== 'table') warn(`unknown table class ".${cls}" dropped`);

  const bad = (name: string, entry: string, why = 'is not understood') => warn(`table attribute ${name}: "${entry}" ${why} — ignored`);
  const entries = (name: string) => (values.get(name) ?? '').split(/[\s,]+/).filter(Boolean);
  const key = (p: Position) => `${p.row},${p.col}`;
  /** `rNcM:value` (or `rN:value` where a whole row may be named) with an
   *  allowed value, inside the table; null after a warning otherwise. */
  const located = (name: string, entry: string, allowed: (value: string) => boolean, wholeRow = false) => {
    const parts = pair(entry);
    const m = parts && /^r(\d+)(?:c(\d+))?$/.exec(parts[0]);
    if (!parts || !m || !allowed(parts[1]) || (m[2] === undefined && !wholeRow)) {
      bad(name, entry);
      return null;
    }
    const at: Position = { row: +m[1], col: m[2] === undefined ? 0 : +m[2] };
    if (at.row >= grid.height || at.col >= grid.width) {
      bad(name, entry, 'is outside the table');
      return null;
    }
    return { at, whole: m[2] === undefined, value: parts[1] };
  };

  // Table-level attributes.
  const tableAttrs: Record<string, unknown> = { ...table.attrs, label: attrs.id };
  if (values.has('caption')) tableAttrs.caption = values.get('caption');
  const style = values.get('style');
  if (style !== undefined) {
    if (STYLES.includes(style)) tableAttrs.style = style;
    else bad('style', style);
  }
  const density = values.get('density');
  if (density !== undefined) {
    if (DENSITIES.includes(density)) tableAttrs.density = density;
    else bad('density', density);
  }
  const inset = values.get('inset');
  if (inset !== undefined) {
    const m = /^(\d+(?:\.\d+)?|\.\d+)(?:pt)?$/.exec(inset);
    const pt = m ? normalizeInsetPt(Number(m[1])) : null;
    if (pt !== null) tableAttrs.insetPt = pt;
    else bad('inset', inset, 'is not a length from 0pt to 72pt');
  }
  const columns = values.get('columns');
  if (columns !== undefined) {
    const widths = normalizeTableColumns(columns.split(/[\s,]+/).filter(Boolean));
    if (!widths) bad('columns', columns, 'is not a list of auto, Nfr and Npt');
    else if (widths.length !== grid.width) bad('columns', columns, `does not name ${grid.width} column(s)`);
    else tableAttrs.columnWidths = widths;
  }
  const fontSize = values.get('font-size');
  if (fontSize !== undefined) {
    if (FONT_SIZE_RE.test(fontSize)) tableAttrs.fontSize = fontSize;
    else bad('font-size', fontSize, 'is not an em size');
  }

  // Row rules: `N:rule` (an `rN` is read the same).
  const rowRules = new Map<number, string>();
  for (const entry of entries('rules')) {
    const parts = pair(entry);
    const m = parts && /^r?(\d+)$/.exec(parts[0]);
    if (!parts || !m || !RULES.includes(parts[1])) bad('rules', entry);
    else if (+m[1] >= grid.height) bad('rules', entry, 'is outside the table');
    else rowRules.set(+m[1], parts[1]);
  }

  // Spans first: they decide which positions are cells' origins. A span
  // covers only lone, empty cells no other span claims, so it never
  // swallows text; anything else is ignored with a warning.
  const origin = new Map<string, GridCell>(grid.cells.map((cell) => [key(cell), cell]));
  const span = new Map<string, { colspan: number; rowspan: number }>();
  const covered = new Set<string>();
  for (const entry of entries('spans')) {
    const e = located('spans', entry, (v) => /^[1-9]\d*x[1-9]\d*$/.test(v));
    if (!e) continue;
    const [colspan, rowspan] = e.value.split('x').map(Number);
    const p = e.at;
    if (p.row + rowspan > grid.height || p.col + colspan > grid.width) {
      bad('spans', entry, 'does not fit the table');
      continue;
    }
    const free = (k: string) => {
      const cell = origin.get(k);
      return !!cell && cell.colspan === 1 && cell.rowspan === 1 && !covered.has(k) && !span.has(k);
    };
    if (!free(key(p))) {
      bad('spans', entry, 'does not start at a free cell');
      continue;
    }
    const cover: string[] = [];
    for (let r = p.row; r < p.row + rowspan; r++) {
      for (let c = p.col; c < p.col + colspan; c++) if (r !== p.row || c !== p.col) cover.push(`${r},${c}`);
    }
    if (!cover.every((k) => free(k) && isEmptyCell(origin.get(k)!.node))) {
      bad('spans', entry, 'would cover a cell that has text or another span');
      continue;
    }
    span.set(key(p), { colspan, rowspan });
    for (const k of cover) covered.add(k);
  }
  const atOrigin = (name: string, entry: string, p: Position) => {
    if (origin.has(key(p)) && !covered.has(key(p))) return true;
    bad(name, entry, 'names a position a span covers');
    return false;
  };

  // Decimal columns: a `---:` column (right-aligned by its delimiter row).
  const decimal = new Set<number>();
  for (const entry of entries('decimal')) {
    const m = /^c?(\d+)$/.exec(entry);
    if (!m) bad('decimal', entry);
    else if (+m[1] >= grid.width) bad('decimal', entry, 'is outside the table');
    else {
      const column = grid.cells.filter((cell) => cell.col === +m[1]);
      if (column.length && column.every((cell) => cell.node.attrs.align === 'right')) decimal.add(+m[1]);
      else bad('decimal', entry, 'needs ---: for its column in the delimiter row');
    }
  }

  // Per-cell values, by origin. A whole-row fill or a table-wide vertical
  // alignment applies wherever a cell names none of its own, whatever the
  // written order.
  const own = new Map<string, Record<string, unknown>>();
  const set = (p: Position, name: string, value: unknown) => own.set(key(p), { ...(own.get(key(p)) ?? {}), [name]: value });
  const rowFills = new Map<number, string>();
  for (const entry of entries('fills')) {
    const e = located('fills', entry, (v) => FILLS.includes(v), true);
    if (!e) continue;
    if (e.whole) rowFills.set(e.at.row, e.value);
    else if (atOrigin('fills', entry, e.at)) set(e.at, 'fill', e.value);
  }
  let tableValign: string | null = null;
  for (const entry of entries('valign')) {
    if (VALIGNS.includes(entry)) {
      tableValign = entry;
      continue;
    }
    const e = located('valign', entry, (v) => VALIGNS.includes(v));
    if (e && atOrigin('valign', entry, e.at)) set(e.at, 'valign', e.value);
  }
  for (const entry of entries('aligns')) {
    const e = located('aligns', entry, (v) => v === 'default' || ALIGNS.includes(v));
    if (e && atOrigin('aligns', entry, e.at)) set(e.at, 'align', e.value === 'default' ? null : e.value);
  }

  // Rebuild: every row keeps the cells that start in it.
  const rows: PMNode[] = [];
  table.forEach((row, _offset, r) => {
    const cells: PMNode[] = [];
    for (const cell of grid.cells) {
      if (cell.row !== r || covered.has(key(cell))) continue;
      const next: Record<string, unknown> = { ...cell.node.attrs };
      if (decimal.has(cell.col) && next.align === 'right') next.align = 'decimal';
      const s = span.get(key(cell));
      if (s) Object.assign(next, s, { colwidth: null });
      const mine = own.get(key(cell)) ?? {};
      const fill = rowFills.get(r);
      if (fill !== undefined && !('fill' in mine)) next.fill = fill;
      if (tableValign !== null && !('valign' in mine)) next.valign = tableValign;
      Object.assign(next, mine);
      cells.push(cell.node.type.create(next, cell.node.content, cell.node.marks));
    }
    const rule = rowRules.get(r);
    rows.push(row.type.create(rule === undefined ? row.attrs : { ...row.attrs, rule }, cells));
  });
  return table.type.create(tableAttrs, rows);
}
