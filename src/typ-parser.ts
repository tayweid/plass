// Typst (.typ) -> ProseMirror import: the parse half of spec §3.3.
//
// Coverage contract (per the spec): full fidelity for documents our own
// serializer produced, plus a pragmatic subset of hand-written Typst
// (headings, paragraphs with */_/` markup, lists, quotes, fenced code,
// mitex math, images, labels and @references). Anything else — #let, #show,
// unknown directives — is preserved verbatim as a raw-Typst island
// (a code_block with params 'typst-raw'), which the serializer re-emits
// unchanged, so opening and saving a file never destroys what we don't
// understand.

import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { DEFAULT_SETTINGS, type DocSettings } from './settings';
import { parseBibTeX } from './bibtex';

export interface TypImport {
  doc: PMNode;
  warnings: string[];
}

// Import-scoped state: bibliography data found in the file, used to
// disambiguate inline `@key` (citation vs equation/figure reference).
let importBib: { name: string; content: string } | null = null;
let importBibKeys = new Set<string>();

const BIB_LINE = /^#bibliography\(bytes\((".*")\)(?:,\s*title:\s*"[^"]*")?(?:,\s*style:\s*"[^"]*")?\)$/;

export function typToDoc(src: string): TypImport {
  const warnings: string[] = [];
  const settings: DocSettings = { ...DEFAULT_SETTINGS };
  let sawSet = false;
  let sawNumbering = false;

  const lines = src.replace(/\r\n?/g, '\n').split('\n');

  // Prescan for an embedded bibliography so @key can disambiguate.
  importBib = null;
  importBibKeys = new Set();
  for (const line of lines) {
    const m = BIB_LINE.exec(line.trim());
    if (m) {
      try {
        const content = JSON.parse(m[1]) as string;
        importBib = { name: 'references.bib', content };
        importBibKeys = new Set(parseBibTeX(content).map((e) => e.key));
      } catch {
        warnings.push('could not decode embedded bibliography');
      }
      break;
    }
  }

  // Header pass: leading directives we understand become document settings.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const macroM = /^\/\/ typeset:math-macros (.*)$/.exec(line);
    if (macroM) {
      try {
        settings.mathMacros = JSON.parse(macroM[1]) as string;
      } catch {
        warnings.push('could not decode math macros directive');
      }
      i++;
      continue;
    }
    if (!line || line.startsWith('//')) {
      i++;
      continue;
    }
    if (/^#import "@preview\/mitex/.test(line) || /^#set par\(/.test(line)) {
      sawSet = true;
      i++;
      continue;
    }
    // Spacing-parity rules (regenerated from settings on export).
    if (
      /^#set (list|enum)\(spacing:/.test(line) ||
      /^#show heading\.where\(level: \d+\): set (text|block|par)\(/.test(line) ||
      /^#show raw\.where\(block: false\): set text\(/.test(line) ||
      /^#show math\.equation\.where\(block: true\): set block\(/.test(line)
    ) {
      sawSet = true;
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^#set page\(([^)]*)\)$/.exec(line))) {
      sawSet = true;
      const paper = /paper:\s*"([^"]+)"/.exec(m[1])?.[1];
      if (paper) settings.page = paper === 'a4' ? 'a4' : 'letter';
      const margin = /margin:\s*([\d.]+)in/.exec(m[1])?.[1];
      if (margin) settings.marginIn = parseFloat(margin);
      const numbering = /numbering:\s*"([^"]*)"/.exec(m[1])?.[1];
      if (numbering !== undefined) {
        settings.pageNumShow = true;
        if (numbering === '1' || numbering === '— 1 —' || numbering === 'i' || numbering === '1 / 1') {
          settings.pageNumFormat = numbering;
        }
      } else {
        settings.pageNumShow = false;
      }
      const nAlign = /number-align:\s*(left|center|right)/.exec(m[1])?.[1];
      if (nAlign) settings.pageNumAlign = nAlign as typeof settings.pageNumAlign;
      i++;
      continue;
    }
    if ((m = /^#set text\(([^)]*)\)$/.exec(line))) {
      sawSet = true;
      const size = /size:\s*([\d.]+)pt/.exec(m[1])?.[1];
      if (size) settings.sizePt = parseFloat(size);
      // accept both font: "F" and font: ("F", "Fallback")
      const font = /font:\s*\(?\s*"([^"]+)"/.exec(m[1])?.[1];
      if (font) settings.font = font;
      const hyph = /hyphenate:\s*(true|false)/.exec(m[1])?.[1];
      if (hyph) settings.hyphenate = hyph === 'true';
      i++;
      continue;
    }
    if (/^#set math\.equation\(numbering:/.test(line)) {
      sawSet = true;
      sawNumbering = true;
      i++;
      continue;
    }
    if (/^#set heading\(numbering:/.test(line)) {
      sawSet = true;
      settings.numberSections = true;
      i++;
      continue;
    }
    const counterM = /^#counter\(page\)\.update\((\d+)\)$/.exec(line);
    if (counterM) {
      sawSet = true;
      settings.pageNumStart = parseInt(counterM[1], 10);
      i++;
      continue;
    }
    break;
  }
  // Files with a settings header state equation numbering explicitly; bare
  // hand-written files get the default.
  settings.numberEquations = sawSet ? sawNumbering : DEFAULT_SETTINGS.numberEquations;

  const blocks = parseBlocks(lines.slice(i), warnings);
  if (!blocks.length) blocks.push(schema.nodes.paragraph.create());
  return { doc: schema.nodes.doc.create({ settings, bib: importBib }, blocks), warnings };
}

function parseBlocks(lines: string[], warnings: string[]): PMNode[] {
  const out: PMNode[] = [];
  const n = lines.length;
  let i = 0;

  while (i < n) {
    const line = lines[i];
    const t = line.trim();
    if (!t || t.startsWith('//')) {
      i++;
      continue;
    }

    // fenced code block
    let m = /^```(.*)$/.exec(t);
    if (m) {
      const params = m[1].trim();
      const body: string[] = [];
      i++;
      while (i < n && lines[i].trim() !== '```') body.push(lines[i++]);
      i++; // closing fence
      const text = body.join('\n');
      out.push(schema.nodes.code_block.create({ params }, text ? [schema.text(text)] : []));
      continue;
    }

    // display math: #mitex(` … `) <label>
    if (t === '#mitex(`') {
      const body: string[] = [];
      let label = '';
      i++;
      while (i < n) {
        const close = /^`\)\s*(?:<([^>]+)>)?\s*$/.exec(lines[i].trim());
        if (close) {
          label = close[1] ?? '';
          i++;
          break;
        }
        body.push(lines[i++]);
      }
      out.push(schema.nodes.math_display.create({ src: body.join('\n').trim(), label }));
      continue;
    }

    // blockquote
    if (t === '#quote(block: true)[') {
      const body: string[] = [];
      i++;
      while (i < n && lines[i].trim() !== ']') body.push(lines[i++].replace(/^  /, ''));
      i++; // closing bracket
      const inner = parseBlocks(body, warnings);
      out.push(schema.nodes.blockquote.create(null, inner.length ? inner : [schema.nodes.paragraph.create()]));
      continue;
    }

    // heading (with optional trailing <label>)
    m = /^(={1,3})\s+(.*)$/.exec(t);
    if (m && t === line.trimEnd()) {
      let text = m[2];
      let label = '';
      const lm = /\s*<([a-zA-Z0-9:._-]+)>$/.exec(text);
      if (lm) {
        label = lm[1];
        text = text.slice(0, lm.index);
      }
      out.push(schema.nodes.heading.create({ level: m[1].length, label }, parseInline(text)));
      i++;
      continue;
    }

    // horizontal rule
    if (/^#line\(/.test(t)) {
      out.push(schema.nodes.horizontal_rule.create());
      i++;
      continue;
    }

    // embedded bibliography (content captured in the prescan)
    if (BIB_LINE.test(t)) {
      out.push(schema.nodes.bibliography.create());
      i++;
      continue;
    }

    // table: #align(center, table(…)) — centered on export — or bare #table(…)
    const centered = t.startsWith('#align(center, table(');
    if (centered || t.startsWith('#table(')) {
      const body: string[] = [line];
      let depth = countParens(line);
      i++;
      while (i < n && depth > 0) {
        body.push(lines[i]);
        depth += countParens(lines[i]);
        i++;
      }
      let src = body.join('\n');
      if (centered) {
        // Strip the alignment wrapper: '#align(center, table(…))' → '#table(…)'
        src = src.trim().replace(/^#align\(center,\s*table\(/, '#table(').replace(/\)\)$/, ')');
      }
      const table = parseTable(src);
      if (table) {
        out.push(table);
      } else {
        warnings.push('kept as raw Typst: #table(…) (unrecognized form)');
        out.push(schema.nodes.code_block.create({ params: 'typst-raw' }, [schema.text(body.join('\n'))]));
      }
      continue;
    }

    // lists (marker at line start; continuation lines indented two spaces)
    m = /^([-+]) /.exec(line);
    if (m) {
      const marker = m[1];
      const itemRe = new RegExp(`^\\${marker} (.*)$`);
      const items: PMNode[] = [];
      while (i < n) {
        const im = itemRe.exec(lines[i]);
        if (!im) break;
        const body: string[] = [im[1]];
        i++;
        while (
          i < n &&
          (/^  /.test(lines[i]) || (lines[i].trim() === '' && /^  /.test(lines[i + 1] ?? '')))
        ) {
          body.push(lines[i++].replace(/^  /, ''));
        }
        const inner = parseBlocks(body, warnings);
        const content =
          inner.length && inner[0].type === schema.nodes.paragraph
            ? inner
            : [schema.nodes.paragraph.create(), ...inner];
        items.push(schema.nodes.list_item.create(null, content));
      }
      const type = marker === '-' ? schema.nodes.bullet_list : schema.nodes.ordered_list;
      out.push(type.create(null, items));
      continue;
    }

    // figure: #figure(image("src"), caption: [ … ]) <label>
    m = /^#figure\(image\("([^"]*)"\)\s*,\s*caption:\s*\[/.exec(t);
    if (m) {
      const capStart = m[0].length - 1; // index of '['
      const capEnd = matchBracket(t, capStart);
      if (capEnd > 0) {
        const caption = t.slice(capStart + 1, capEnd);
        const rest = t.slice(capEnd + 1);
        const label = /^\)\s*<([^>]+)>/.exec(rest)?.[1] ?? '';
        out.push(schema.nodes.figure.create({ src: m[1], label }, parseInline(caption)));
        i++;
        continue;
      }
    }

    // standalone image
    m = /^#image\("([^"]+)"\)$/.exec(t);
    if (m) {
      out.push(schema.nodes.paragraph.create(null, [schema.nodes.image.create({ src: m[1] })]));
      i++;
      continue;
    }

    // unknown directive / scripting: preserve verbatim as a raw island
    if (t.startsWith('#')) {
      const body: string[] = [];
      while (i < n && lines[i].trim() !== '') body.push(lines[i++]);
      warnings.push(`kept as raw Typst: ${body[0].trim().slice(0, 48)}`);
      out.push(schema.nodes.code_block.create({ params: 'typst-raw' }, [schema.text(body.join('\n'))]));
      continue;
    }

    // paragraph: consume until a blank line or the start of another construct
    const para: string[] = [];
    while (i < n) {
      const pt = lines[i].trim();
      if (!pt || /^(```|={1,3} |[-+] |#)/.test(pt)) break;
      para.push(lines[i++]);
    }
    out.push(schema.nodes.paragraph.create(null, parseParagraph(para)));
  }
  return out;
}

/** Paragraph lines -> inline nodes, handling ` \` hard breaks and line joins. */
function parseParagraph(lines: string[]): PMNode[] {
  const out: PMNode[] = [];
  lines.forEach((raw, idx) => {
    let text = raw.trim();
    let hardBreak = false;
    // A trailing ` \` is a Typst line break (but `\\` is an escaped backslash).
    if (/ \\$/.test(text) && !/\\\\$/.test(text)) {
      hardBreak = true;
      text = text.slice(0, -2).trimEnd();
    }
    scanInline(text, [], out);
    if (hardBreak) out.push(schema.nodes.hard_break.create());
    else if (idx < lines.length - 1) out.push(schema.text(' '));
  });
  return out;
}

export function parseInline(text: string): PMNode[] {
  const out: PMNode[] = [];
  scanInline(text, [], out);
  return out;
}

/** Net change in paren depth over a line (ignoring escaped parens). */
function countParens(line: string): number {
  let d = 0;
  for (let j = 0; j < line.length; j++) {
    if (line[j] === '\\') {
      j++;
      continue;
    }
    if (line[j] === '(') d++;
    else if (line[j] === ')') d--;
  }
  return d;
}

interface ParsedCell {
  content: string;
  colspan: number;
  rowspan: number;
  header: boolean;
  align: string | null;
}

/** Split a Typst argument list at depth-0 commas. */
function splitTopArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  args.push(inner.slice(start));
  return args.map((a) => a.trim()).filter(Boolean);
}

/** Parse one positional cell argument: [content] or table.cell(args)[content]. */
function parseCellArg(arg: string, header: boolean): ParsedCell | null {
  if (arg.startsWith('[')) {
    const end = matchBracket(arg, 0);
    if (end !== arg.length - 1) return null;
    return { content: arg.slice(1, end), colspan: 1, rowspan: 1, header, align: null };
  }
  if (arg.startsWith('table.cell(')) {
    const argsStart = 'table.cell('.length;
    const argsEnd = arg.indexOf(')', argsStart);
    const bracket = arg.indexOf('[', argsEnd);
    if (argsEnd < 0 || bracket < 0) return null;
    const end = matchBracket(arg, bracket);
    if (end !== arg.length - 1) return null;
    const a = arg.slice(argsStart, argsEnd);
    return {
      content: arg.slice(bracket + 1, end),
      colspan: parseInt(/colspan:\s*(\d+)/.exec(a)?.[1] ?? '1', 10),
      rowspan: parseInt(/rowspan:\s*(\d+)/.exec(a)?.[1] ?? '1', 10),
      header,
      align: /align:\s*(left|center|right)/.exec(a)?.[1] ?? null,
    };
  }
  return null;
}

/**
 * Parse our emitted #table form into a table node; null if unrecognized
 * (the caller preserves the source verbatim as a raw island). Named
 * arguments we don't model are kept on the table (full-control escape
 * hatch) and re-emitted verbatim.
 */
export function parseTable(src: string): PMNode | null {
  const open = src.indexOf('(');
  if (open < 0) return null;
  let d = 0;
  let close = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '(') d++;
    else if (src[j] === ')') {
      d--;
      if (d === 0) {
        close = j;
        break;
      }
    }
  }
  if (close < 0) return null;

  const args = splitTopArgs(src.slice(open + 1, close));
  let columns = 0;
  let strokeNone = false;
  let alignTuple: string | null = null;
  let hlines = 0;
  const userHlines: string[] = [];
  const customParams: string[] = [];
  const cells: ParsedCell[] = [];

  for (const arg of args) {
    if (/^columns\s*:/.test(arg)) {
      const num = /^columns\s*:\s*(\d+)$/.exec(arg);
      if (num) {
        columns = parseInt(num[1], 10);
      } else {
        const tup = /^columns\s*:\s*\((.*)\)$/s.exec(arg);
        if (!tup) return null;
        columns = splitTopArgs(tup[1]).length;
        customParams.push(arg); // non-numeric column spec round-trips verbatim
      }
    } else if (/^align\s*:/.test(arg)) {
      const tup = /^align\s*:\s*\(([^)]*)\)$/.exec(arg);
      const vals = tup ? tup[1].split(',').map((s) => s.trim()) : null;
      if (vals && vals.every((v) => ['left', 'center', 'right', 'auto'].includes(v))) alignTuple = tup![1];
      else customParams.push(arg);
    } else if (/^stroke\s*:\s*none$/.test(arg)) {
      strokeNone = true;
    } else if (arg.startsWith('table.hline(')) {
      // Explicit-position rules (y:) are user midrules — carried in params;
      // bare rules are the style preset's own.
      if (/[(,]\s*y\s*:/.test(arg)) userHlines.push(arg);
      else hlines++;
    } else if (arg.startsWith('table.header(')) {
      const hEnd = arg.lastIndexOf(')');
      if (hEnd < 0) return null;
      for (const inner of splitTopArgs(arg.slice('table.header('.length, hEnd))) {
        const cell = parseCellArg(inner, true);
        if (!cell) return null;
        cells.push(cell);
      }
    } else if (arg.startsWith('[') || arg.startsWith('table.cell(')) {
      const cell = parseCellArg(arg, false);
      if (!cell) return null;
      cells.push(cell);
    } else if (/^[a-zA-Z_][\w.-]*\s*:/.test(arg)) {
      customParams.push(arg); // unknown named arg → full-control passthrough
    } else {
      return null; // unknown positional construct (vline, …) → raw island
    }
  }

  if (!(columns > 0) || !cells.length) return null;
  const hasHeader = cells.some((c) => c.header);

  // Style detection with fidelity guards: nonstandard rule layouts can't be
  // reconstructed from presets, so those tables stay raw. Custom params are
  // additive and coexist with presets.
  let style = 'grid';
  if (strokeNone) {
    style = hlines ? 'booktabs' : 'plain';
    if (style === 'booktabs' && hlines !== (hasHeader ? 3 : 2)) return null;
  } else if (hlines > 0) {
    return null;
  } else if (customParams.some((a) => /^stroke\s*:/.test(a))) {
    // A custom stroke without preset markers: keep style neutral.
    style = 'plain';
  }
  const params = [...customParams, ...userHlines].join(',\n');

  const colAligns: Array<string | null> = new Array(columns).fill(null);
  if (alignTuple) {
    alignTuple.split(',').forEach((a, i) => {
      const v = a.trim();
      if (i < columns && (v === 'left' || v === 'center' || v === 'right')) colAligns[i] = v;
    });
  }

  // Chunk the flat cell list into rows, honoring col/rowspans.
  const { table, table_row, table_cell, table_header, paragraph } = schema.nodes;
  const rows: PMNode[] = [];
  const pending = new Array<number>(columns).fill(0); // rows still occupied by rowspans
  let idx = 0;
  while (idx < cells.length) {
    const rowCells: PMNode[] = [];
    let col = 0;
    while (col < columns) {
      if (pending[col] > 0) {
        pending[col]--;
        col++;
        continue;
      }
      const c = cells[idx++];
      if (!c) break;
      const type = c.header ? table_header : table_cell;
      const para = paragraph.create(null, parseInline(c.content.trim()));
      rowCells.push(
        type.create({ colspan: c.colspan, rowspan: c.rowspan, align: c.align ?? colAligns[col] }, [para]),
      );
      for (let k = col; k < Math.min(columns, col + c.colspan); k++) {
        if (c.rowspan > 1) pending[k] += c.rowspan - 1;
      }
      col += c.colspan;
    }
    if (rowCells.length) rows.push(table_row.create(null, rowCells));
    else break;
  }
  if (!rows.length) return null;
  try {
    return table.create({ style, params }, rows);
  } catch {
    return null;
  }
}

/** Index of the `]` matching the `[` at `open`, honoring escapes and nesting. */
function matchBracket(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Find the next unescaped occurrence of `ch` at or after `from`. */
function findClose(src: string, from: number, ch: string): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') {
      j++;
      continue;
    }
    if (src[j] === ch) return j;
  }
  return -1;
}

function scanInline(src: string, marks: Mark[], out: PMNode[]) {
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(schema.text(buf, marks));
      buf = '';
    }
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\' && i + 1 < src.length) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (src.startsWith('(#ref(<', i) || src.startsWith('#ref(<', i)) {
      const re = src[i] === '('
        ? /^\(#ref\(<([^>]+)>,\s*supplement:\s*none\)\)/
        : /^#ref\(<([^>]+)>,\s*supplement:\s*none\)/;
      const m = re.exec(src.slice(i));
      if (m) {
        flush();
        out.push(schema.nodes.eq_ref.create({ label: m[1] }));
        i += m[0].length;
        continue;
      }
    }
    if (src.startsWith('#footnote[', i)) {
      const open = i + '#footnote'.length;
      const end = matchBracket(src, open);
      if (end > 0) {
        flush();
        out.push(schema.nodes.footnote.create(null, parseInline(src.slice(open + 1, end))));
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith('#mi(`', i)) {
      const end = src.indexOf('`)', i + 5);
      if (end >= 0) {
        flush();
        out.push(schema.nodes.math_inline.create({ src: src.slice(i + 5, end) }));
        i = end + 2;
        continue;
      }
    }
    if (src.startsWith('#image("', i)) {
      const end = src.indexOf('")', i + 8);
      if (end >= 0) {
        flush();
        out.push(schema.nodes.image.create({ src: src.slice(i + 8, end) }));
        i = end + 2;
        continue;
      }
    }
    if (ch === '@') {
      const m = /^@([a-zA-Z0-9:._-]+)/.exec(src.slice(i));
      if (m) {
        // Typst-style: a trailing period/colon belongs to the sentence.
        const label = m[1].replace(/[.:]+$/, '');
        if (label) {
          flush();
          out.push(
            importBibKeys.has(label)
              ? schema.nodes.citation.create({ key: label })
              : schema.nodes.eq_ref.create({ label }),
          );
          i += 1 + label.length;
          continue;
        }
      }
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(schema.text(src.slice(i + 1, end), [...marks, schema.marks.code.create()]));
        i = end + 1;
        continue;
      }
    }
    if (ch === '$') {
      const end = findClose(src, i + 1, '$');
      if (end > i + 1) {
        flush();
        out.push(schema.nodes.math_inline.create({ src: src.slice(i + 1, end) }));
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      const end = findClose(src, i + 1, ch);
      if (end > i + 1) {
        flush();
        const mark = ch === '*' ? schema.marks.strong.create() : schema.marks.em.create();
        scanInline(src.slice(i + 1, end), [...marks, mark], out);
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
}
