// PM doc -> Typst markup (.typ) serialization (spec §3.3, serialize half).
//
// Math is authored as LaTeX (KaTeX) in v1, so exported math goes through the
// mitex Typst package, which compiles LaTeX math inside Typst documents.

import type { Node as PMNode } from 'prosemirror-model';
import { normalizeSettings, parseMathMacros, type DocSettings } from './settings';
import { wrapAligned } from './math-src';
import { isPortableCitationKey, parseBibTeX } from './bibtex';
import { effectiveFont, parityMetrics } from './font-registry';

export interface TypExportOptions {
  /** Rewrite image sources (e.g. data: URLs to VFS paths for compilation). */
  resolveImage?: (src: string) => string;
  /** Extra font families appended to #set text(font: …) as fallbacks. */
  fontFallback?: string[];
  /**
   * Preview-only: wrap each table cell body in #link("cell://row-col")[…] so
   * compiled SVGs expose per-cell hit geometry for in-place editing.
   */
  cellLinks?: boolean;
}

// ---------- editor↔Typst vertical parity ----------
//
// The editor lays text on a CSS grid (line-height, margins, paddings); Typst
// spaces tight glyph boxes (leading, par spacing, block above/below). These
// measured font constants + the formulas below make the exported document
// reproduce the editor's baseline geometry exactly (calibrated empirically;
// see README "Fidelity").
//   cssA/cssD: Chrome's ascent/descent for the font (line-box placement)
//   typAsc/typDesc: Typst's first/last-baseline offsets from block edges
//   extent: Typst's baseline pitch at leading 0
/**
 * First-baseline offset difference (Typst − editor CSS) in body em for a
 * unit type standing at a page top: Typst suppresses leading block spacing
 * and places the first baseline one ascender below the margin, while the
 * editor's CSS line boxes/padding still apply. The paginator shifts its
 * page spacers by this amount so page-top ink coincides with the PDF.
 */
export function pageTopAdjustEm(s: DocSettings, unit: 'paragraph' | 'line' | 'h1' | 'h2' | 'h3'): number {
  const m = parityMetrics(s.font);
  const pSlackAbove = s.lineHeight / 2 + (m.cssA - m.cssD) / 2;
  if (unit === 'paragraph' || unit === 'line') return m.typAsc - pSlackAbove;
  const h = HEADINGS[unit === 'h1' ? 0 : unit === 'h2' ? 1 : 2];
  const hSlackAbove = (h.hs * (1.25 + m.cssA - m.cssD)) / 2;
  return m.typAsc * h.hs - (h.padTop * h.hs + hSlackAbove);
}

// Heading scale mirrored from the editor CSS (.ProseMirror h1/h2/h3).
// `shift` is a measured per-level baseline correction (em of body size):
// Typst places heading baselines slightly lower than the metric model
// predicts; calibrated against the live editor (NCM defaults).
const HEADINGS: Array<{ level: number; hs: number; padTop: number; marginBottom: number; shift: number }> = [
  { level: 1, hs: 1.9, padTop: 0.2, marginBottom: 0.5, shift: 0.1932 },
  { level: 2, hs: 1.4, padTop: 1.4, marginBottom: 0.5, shift: 0.1269 },
  { level: 3, hs: 1.15, padTop: 1.4, marginBottom: 0.5, shift: 0.1833 },
];

/**
 * `#set par(spacing: ...)` in body em: the Auto block-spacing fallback
 * Typst resolves for every block whose `above`/`below` isn't explicitly
 * set (`styles.resolve(ParElem::spacing)` in `flow/collect.rs::block`) —
 * paragraphs, lists, plain code blocks, raw-Typst islands, figures, and
 * tables all collapse to this SAME value on both sides when adjacent,
 * since Auto is independently resolved for `above` and `below` alike.
 * Exported so `flow-rules.ts` can build the weakness-tagged spacing item
 * Typst's collector assigns this construct (weakness 4) without
 * duplicating the formula.
 */
export function parSpacingEm(s: DocSettings): number {
  const m = parityMetrics(s.font);
  // Classic (indented) paragraphs flow with no extra gap: spacing = leading.
  const parGapEm = s.parIndent ? 0 : 0.9;
  return s.lineHeight + parGapEm - m.extent;
}

/**
 * Explicit `#set block(above/below: ...)` (body em) a heading's show rule
 * emits — Typst's weakness-3 explicit block spacing for headings (see
 * `parityRules` below, which calls this per level so the emitted text and
 * this value can never drift apart). Exported for `flow-rules.ts`'s
 * region-top spacing-drop rule.
 */
export function headingBlockSpacingEm(s: DocSettings, level: 1 | 2 | 3): { above: number; below: number } {
  const m = parityMetrics(s.font);
  const lh = s.lineHeight;
  const pSlackBelow = lh / 2 + (m.cssD - m.cssA) / 2;
  const pSlackAbove = lh / 2 + (m.cssA - m.cssD) / 2;
  const h = HEADINGS[level - 1];
  const hSlackAbove = (h.hs * (1.25 + m.cssA - m.cssD)) / 2;
  const hSlackBelow = (h.hs * (1.25 + m.cssD - m.cssA)) / 2;
  const above = pSlackBelow + 0.9 + h.padTop * h.hs + hSlackAbove - (m.typDesc + m.typAsc * h.hs) - h.shift;
  const below = hSlackBelow + h.marginBottom * h.hs + pSlackAbove - (m.typDesc * h.hs + m.typAsc) + h.shift;
  return { above, below };
}

/**
 * Explicit `#set block(above/below: ...)` (body em) the display-math show
 * rule emits — weakness-3 explicit block spacing, same status as headings'.
 * Exported for `flow-rules.ts`'s region-top spacing-drop rule.
 */
export function equationBlockSpacingEm(s: DocSettings): { above: number; below: number } {
  const m = parityMetrics(s.font);
  const lh = s.lineHeight;
  const pSlackBelow = lh / 2 + (m.cssD - m.cssA) / 2;
  const pSlackAbove = lh / 2 + (m.cssA - m.cssD) / 2;
  const above = pSlackBelow + 0.9 + 0.5 - m.typDesc;
  const below = 0.5 + 0.9 + pSlackAbove - m.typAsc;
  return { above, below };
}

/** The parity header: set/show rules reproducing editor spacing in Typst. */
export function parityRules(s: DocSettings): string {
  const m = parityMetrics(s.font);
  const lh = s.lineHeight;
  const pt = (em: number) => `${(em * s.sizePt).toFixed(3)}pt`;
  let out = '';
  out += `#set par(justify: true, leading: ${pt(lh - m.extent)}, spacing: ${pt(parSpacingEm(s))})\n`;
  if (s.parIndent) out += `#set par(first-line-indent: 1.5em)\n`;
  out += `#set list(spacing: ${pt(lh + 0.25 - m.extent)})\n`;
  out += `#set enum(spacing: ${pt(lh + 0.25 - m.extent)})\n`;
  for (const h of HEADINGS) {
    const { above, below } = headingBlockSpacingEm(s, h.level as 1 | 2 | 3);
    out += `#show heading.where(level: ${h.level}): set text(size: ${pt(h.hs)})\n`;
    out += `#show heading.where(level: ${h.level}): set block(above: ${pt(above)}, below: ${pt(below)})\n`;
    out += `#show heading.where(level: ${h.level}): set par(leading: ${pt((1.25 - m.extent) * h.hs)})\n`;
  }
  // Inline raw: pin Typst's defaults so editor code spans (same font file,
  // same ratio) have identical advance widths.
  out += `#show raw.where(block: false): set text(font: "DejaVu Sans Mono", size: ${pt(0.8)})\n`;
  // Display math: the editor shows Typst's own ink inside 0.5em padding.
  const { above: eqAbove, below: eqBelow } = equationBlockSpacingEm(s);
  out += `#show math.equation.where(block: true): set block(above: ${pt(eqAbove)}, below: ${pt(eqBelow)})\n`;
  // Tables remain continuous structured editor content. Typst breaks them
  // between rows with the repeating table.header row laid at the top of each
  // continuation page; the editor mirrors that as a row-boundary widget
  // (PAGE-PORT.md Phase 7) and places a table atomically only when it
  // cannot certify the split.
  return out;
}

let exportOpts: TypExportOptions = {};
let eqLabels = new Set<string>();
let docBib: { name: string; content: string } | null = null;
let docBibKeys = new Set<string>();
let docMacros: Record<string, string> = {};

/** Expand math macros so exported LaTeX compiles anywhere. */
export function expandMacrosWith(src: string, macros: Record<string, string>): string {
  let out = src;
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const [name, expansion] of Object.entries(macros)) {
      const re = new RegExp('\\\\' + name.slice(1) + '(?![a-zA-Z])', 'g');
      const next = out.replace(re, expansion.replace(/\$/g, '$$$$'));
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

function expandMacros(src: string): string {
  return expandMacrosWith(src, docMacros);
}

/** The #set text(...) header line (shared with the layout oracle's probes). */
export function textSetLine(s: DocSettings, fontFallback?: string[]): string {
  const primary = effectiveFont(s.font).typstFamily;
  const fonts = fontFallback?.length
    ? `(${[primary, ...fontFallback.filter((f) => f !== primary)].map((f) => JSON.stringify(f)).join(', ')})`
    : JSON.stringify(primary);
  return `#set text(size: ${s.sizePt}pt, font: ${fonts}, hyphenate: ${s.hyphenate})\n`;
}

function imageSrc(src: string): string {
  return exportOpts.resolveImage ? exportOpts.resolveImage(src) : src;
}

export function escapeTyp(text: string): string {
  // A literal ~ must escape — Typst reads a bare ~ as a non-breaking
  // space, silently gluing the words around it. A real U+00A0 in the text
  // emits AS Typst's ~, so the printed glue matches the editor's.
  return text.replace(/[\\#$*_`@<>[\]~]/g, (c) => '\\' + c).replace(/\u00a0/g, '~');
}

/** Table cells are serialized through a deliberately narrower path. A Typst
 * comment opener is executable even inside a content block, so keep it inert
 * without changing the established encoding of ordinary document prose. */
function escapeTableCellText(text: string): string {
  return escapeTyp(text).replace(/\/\//g, '\\/\\/');
}

function portableTableLabel(label: unknown): string {
  const value = String(label ?? '');
  if (!value) return '';
  if (!isPortableCitationKey(value)) {
    throw new Error(`Cannot export table: reference label ${JSON.stringify(value)} is not portable Typst syntax`);
  }
  return ` <${value}>`;
}

function inlineToTyp(node: PMNode, tableCell = false): string {
  let out = '';
  node.forEach((child) => {
    if (child.isText && child.text) {
      const marks = new Set(child.marks.map((m) => m.type.name));
      if (marks.has('code')) {
        // Typst has no variable-length inline raw fence. Use its string form
        // for certified table cells when a literal backtick would close `...`.
        out += tableCell && child.text.includes('`')
          ? `#raw(${JSON.stringify(child.text)}, block: false)`
          : '`' + child.text + '`';
        return;
      }
      let t = tableCell ? escapeTableCellText(child.text) : escapeTyp(child.text);
      if (marks.has('strong')) t = `*${t}*`;
      if (marks.has('em')) t = `_${t}_`;
      if (marks.has('strike')) t = `#strike[${t}]`;
      out += t;
    } else if (child.type.name === 'typst_inline') {
      // Raw Typst: the source IS the export.
      out += child.attrs.src;
    } else if (child.type.name === 'math_inline') {
      const source = expandMacros(child.attrs.src);
      out += tableCell
        ? `#mi(raw(${JSON.stringify(source)}, block: false))`
        : `#mi(\`${source}\`)`;
    } else if (child.type.name === 'eq_ref') {
      // Equation refs render as "(1)" to match the editor (Typst's default
      // would be "Equation 1"); figure refs keep "Figure 1".
      out += unnumberedEqLabels.has(child.attrs.label as string)
        ? escapeTyp(`@${child.attrs.label}`)
        : eqLabels.has(child.attrs.label)
          ? `(#ref(<${child.attrs.label}>, supplement: none))`
          : `@${child.attrs.label}`;
    } else if (child.type.name === 'citation') {
      const key = child.attrs.key as string;
      // Invalid keys may exist in an old/local JSON snapshot. Keep their
      // visible text without letting them become executable Typst syntax.
      out += isPortableCitationKey(key) ? `@${key}` : escapeTyp(`@${key}`);
    } else if (child.type.name === 'footnote') {
      out += `#footnote[${inlineToTyp(child)}]`;
    } else if (child.type.name === 'hard_break') {
      out += ' \\\n';
    } else if (child.type.name === 'image') {
      out += `#image("${imageSrc(child.attrs.src)}")`;
    }
  });
  return out;
}

const TABLE_CELL_MARKS = new Set(['strong', 'em', 'strike', 'code']);
const TABLE_CELL_INLINE = new Set([
  'text',
  'hard_break',
  'math_inline',
  'eq_ref',
  'citation',
]);

/**
 * Serialize only the table-cell subset that the importer can reconstruct
 * without guessing. The schema permits arbitrary blocks; an explicit failure
 * leaves the ProseMirror document untouched instead of silently dropping them.
 */
function tableCellContentToTyp(cell: PMNode, row: number, column: number): string {
  const where = `table cell ${row + 1}:${column + 1}`;
  const paragraphs: string[] = [];
  cell.forEach((block) => {
    if (block.type.name !== 'paragraph') {
      throw new Error(`Cannot export ${where}: unsupported ${block.type.name} block; content was not discarded`);
    }
    if (block.attrs.keep || block.attrs.align) {
      throw new Error(`Cannot export ${where}: paragraph layout attributes are not supported inside table cells`);
    }
    block.descendants((child) => {
      if (!TABLE_CELL_INLINE.has(child.type.name)) {
        throw new Error(`Cannot export ${where}: unsupported inline ${child.type.name}; content was not discarded`);
      }
      const markNames = child.marks.map((mark) => mark.type.name);
      const unsupported = markNames.find((name) => !TABLE_CELL_MARKS.has(name));
      if (unsupported) {
        throw new Error(`Cannot export ${where}: unsupported ${unsupported} mark; content was not discarded`);
      }
      if (!child.isText && markNames.length) {
        throw new Error(`Cannot export ${where}: marks on ${child.type.name} are not supported`);
      }
      if (markNames.includes('code') && markNames.length > 1) {
        throw new Error(`Cannot export ${where}: code combined with another mark is not supported`);
      }
      const inlineSource = child.isText
        ? (child.text ?? '')
        : child.type.name === 'math_inline'
          ? (child.attrs.src as string)
          : '';
      if (/[\r\n]/.test(inlineSource)) {
        throw new Error(`Cannot export ${where}: multiline inline content is not supported`);
      }
      if (child.type.name === 'citation') {
        const key = child.attrs.key as string;
        if (!isPortableCitationKey(key) || !docBibKeys.has(key)) {
          throw new Error(`Cannot export ${where}: citation ${JSON.stringify(key)} has no portable bibliography entry`);
        }
      }
      if (child.type.name === 'eq_ref') {
        const label = child.attrs.label as string;
        if (!isPortableCitationKey(label)) {
          throw new Error(`Cannot export ${where}: reference label ${JSON.stringify(label)} is not portable Typst syntax`);
        }
        if (unnumberedEqLabels.has(label)) {
          throw new Error(`Cannot export ${where}: a reference to an unnumbered equation is not lossless`);
        }
      }
      return true;
    });
    let body = inlineToTyp(block, true);
    // In a Typst content block these prefixes otherwise acquire block syntax.
    body = body.replace(/(^|\n)([=+\-])/g, '$1\\$2');
    if (/\n[ \t]*\n/.test(body)) {
      throw new Error(`Cannot export ${where}: an inline source contains a blank line`);
    }
    paragraphs.push(body);
  });
  if (paragraphs.length === 1 && !paragraphs[0]) return '';
  return paragraphs
    .map((body) => body || '// typeset:empty-table-paragraph\n~')
    .join('\n\n');
}

function tableCellBrackets(content: string): string {
  if (!content.includes('\n')) return `[${content}]`;
  return `[\n${content.split('\n').map((line) => `    ${line}`).join('\n')}\n  ]`;
}

function blocksToTyp(parent: PMNode, indent: string): string {
  let out = '';
  parent.forEach((node) => {
    out += blockToTyp(node, indent);
  });
  return out;
}

function blockToTyp(node: PMNode, indent = ''): string {
  switch (node.type.name) {
    case 'paragraph': {
      let s = inlineToTyp(node);
      // An empty paragraph is one blank line of vertical space — in the PDF
      // too (a bare ~ renders as an empty line of full line height). Without
      // this, Typst sees nothing where the editor shows a gap, and the page
      // oracle's breaks drift below the editor's real heights.
      if (!s.trim()) return indent + '~\n\n';
      // A leading =, - or + would re-parse as heading/list syntax.
      if (/^[=\-+]/.test(s)) s = '\\' + s;
      const body = node.attrs.keep ? `#block(breakable: false)[${s}]` : s;
      // Aligned paragraphs (top level only): the MULTI-line #align form —
      // the single-line form right after a title is the authors line.
      if (node.attrs.align && !indent) {
        return `#align(${node.attrs.align})[\n  ${body}\n]\n\n`;
      }
      if (node.attrs.keep) return indent + body + '\n\n';
      return indent + s + '\n\n';
    }
    case 'heading': {
      const label = node.attrs.label ? ` <${node.attrs.label}>` : '';
      return indent + '='.repeat(node.attrs.level) + ' ' + inlineToTyp(node) + label + '\n\n';
    }
    case 'doc_title':
      return indent + `#align(center, text(size: 1.55em, weight: 700)[${inlineToTyp(node)}])\n\n`;
    case 'doc_authors':
      return indent + `#align(center)[${inlineToTyp(node)}]\n\n`;
    case 'doc_date':
      return indent + `#align(center, text(style: "italic")[${inlineToTyp(node)}])\n\n`;
    case 'abstract':
      return (
        indent +
        '#align(center, text(weight: 600)[Abstract])\n' +
        indent +
        '#pad(x: 1.8em)[\n' +
        blocksToTyp(node, indent + '  ') +
        indent +
        ']\n\n'
      );
    case 'blockquote':
      return indent + '#quote(block: true)[\n' + blocksToTyp(node, indent + '  ') + indent + ']\n\n';
    case 'code_block':
      // Raw-Typst escape-hatch islands (from import) pass through verbatim.
      if (node.attrs.params === 'typst-raw') return indent + node.textContent + '\n\n';
      return indent + '```' + (node.attrs.params ?? '') + '\n' + node.textContent + '\n```\n\n';
    case 'math_display': {
      const numberedAttr = node.attrs.numbered as boolean | null;
      const effNumbered = numberedAttr ?? emitNumberEquations;
      // A label on an unnumbered equation would make every reference to it
      // a compile error (Typst: cannot ref an unnumbered equation) — drop
      // it; the references degrade to literal placeholders.
      const label = node.attrs.label && effNumbered ? ` <${node.attrs.label}>` : '';
      const body = '#mitex(`\n' + expandMacros(wrapAligned(node.attrs.src as string)) + '\n`)' + label;
      const numbered = node.attrs.numbered as boolean | null;
      // Per-equation override as bare set/restore rules: a wrapping content
      // block (#[...]) changes Typst's block spacing (~0.5em) and shifted
      // the whole page when toggling; set rules are style-only.
      const docNum = emitNumberEquations ? '"(1)"' : 'none';
      if (numbered === false && emitNumberEquations) {
        return indent + '#set math.equation(numbering: none)\n' + body + '\n#set math.equation(numbering: ' + docNum + ')\n\n';
      }
      if (numbered === true && !emitNumberEquations) {
        return indent + '#set math.equation(numbering: "(1)")\n' + body + '\n#set math.equation(numbering: ' + docNum + ')\n\n';
      }
      return indent + body + '\n\n';
    }
    case 'figure': {
      // src is emitted verbatim (even data: URLs) so our own files round-trip
      // losslessly; swap in a real image path for Typst compilation.
      const label = node.attrs.label ? ` <${node.attrs.label}>` : '';
      return indent + `#figure(image("${imageSrc(node.attrs.src)}"), caption: [${inlineToTyp(node)}])${label}\n\n`;
    }
    case 'bullet_list':
    case 'ordered_list': {
      const marker = node.type.name === 'bullet_list' ? '- ' : '+ ';
      let out = '';
      node.forEach((item) => {
        const body = blocksToTyp(item, '').trimEnd().split('\n').join('\n' + indent + '  ');
        out += indent + marker + body + '\n';
      });
      return out + '\n';
    }
    case 'table': {
      // Row-major cell list; header rows via table.header, merges via
      // table.cell(colspan/rowspan), style presets via stroke/hline —
      // Typst's grid model matches PM's.
      const style = (node.attrs.style as string) || 'grid';
      let columns = 0;
      const firstRow = node.child(0);
      firstRow?.forEach((cell) => {
        columns += (cell.attrs.colspan as number) ?? 1;
      });

      // Per-column alignment: first non-null cell alignment wins.
      const colAligns: Array<string | null> = new Array(columns).fill(null);
      node.forEach((row) => {
        let col = 0;
        row.forEach((cell) => {
          const span = (cell.attrs.colspan as number) ?? 1;
          const a = cell.attrs.align as string | null;
          if (a && col < columns && colAligns[col] === null) colAligns[col] = a;
          col += span;
        });
      });
      const anyAlign = colAligns.some(Boolean);

      // Decimal columns split into paired sub-columns at the point (integer
      // part right-aligned, fraction left-aligned, zero inner inset so the
      // halves join). A directive comment lets the importer fuse them back.
      const decimalCols: number[] = [];
      colAligns.forEach((a, i) => {
        if (a === 'decimal') decimalCols.push(i);
      });
      const decimalsIn = (c: number, span: number) => decimalCols.filter((d) => d >= c && d < c + span).length;

      let hasHeader = false;
      const rows: string[] = [];
      node.forEach((row, _rowOffset, rowIndex) => {
        const cells: string[] = [];
        let allHeader = row.childCount > 0;
        let col = 0;
        row.forEach((cell, _cellOffset, cellIndex) => {
          if (cell.type.name !== 'table_header') allHeader = false;
          let content = tableCellContentToTyp(cell, rowIndex, cellIndex);
          if (exportOpts.cellLinks) {
            content = `#link("cell://${rowIndex}-${cellIndex}")[${content || '#h(1em)'}]`;
          }
          const body = tableCellBrackets(content);
          const colspan = (cell.attrs.colspan as number) ?? 1;
          const rowspan = (cell.attrs.rowspan as number) ?? 1;
          const align = cell.attrs.align as string | null;

          const inDecimal = decimalCols.includes(col) && colspan === 1;
          if (inDecimal) {
            const plain = cell.textContent.trim();
            const isHeader = cell.type.name === 'table_header';
            const numM = /^([-+]?[\d,]*)(\.\d*)?$/.exec(plain);
            if (!isHeader && plain && numM && !exportOpts.cellLinks) {
              const intPart = numM[1] ?? '';
              const fracPart = numM[2] ?? '';
              const rs = rowspan > 1 ? `, rowspan: ${rowspan}` : '';
              cells.push(`table.cell(align: right, inset: (right: 0pt)${rs})[${escapeTyp(intPart)}]`);
              cells.push(`table.cell(align: left, inset: (left: 0pt)${rs})[${escapeTyp(fracPart)}]`);
            } else {
              // Headers, empties, and non-numeric content span the pair.
              const args = [`colspan: 2`];
              if (rowspan > 1) args.push(`rowspan: ${rowspan}`);
              args.push(`align: ${isHeader ? 'center' : 'right'}`);
              cells.push(`table.cell(${args.join(', ')})${body}`);
            }
            col += colspan;
            return;
          }

          const emitSpan = colspan + decimalsIn(col, colspan);
          const args: string[] = [];
          if (emitSpan > 1) args.push(`colspan: ${emitSpan}`);
          if (rowspan > 1) args.push(`rowspan: ${rowspan}`);
          if (align && align !== colAligns[col]) args.push(`align: ${align}`);
          cells.push(args.length ? `table.cell(${args.join(', ')})${body}` : body);
          col += colspan;
        });
        if (allHeader) hasHeader = true;
        rows.push(allHeader ? `  table.header(${cells.join(', ')}),` : `  ${cells.join(', ')},`);
      });

      // User midrules (table.hline(y: …)) coexist with style presets; the
      // rest of the custom params replace the preset entirely.
      const customAll = ((node.attrs.params as string) || '').trim();
      const userRules: string[] = [];
      const custom = customAll
        .replace(/table\.[hv]line\([^)]*\)\s*,?/g, (m) => {
          userRules.push(m.replace(/,?\s*$/, ''));
          return '';
        })
        .replace(/,\s*,/g, ',')
        .replace(/^\s*,\s*/, '')
        .replace(/[,\s]+$/, '')
        .trim();
      const customHas = (name: string) => new RegExp(`(^|[\\s,(])${name}\\s*:`).test(custom);

      // Decimal columns double up: expand the count, the align tuple, and
      // any user width tuple (the pair gets the width plus an auto).
      let customExpanded = custom;
      const mapVlineX = (src: string) =>
        src.replace(/table\.vline\(\s*x\s*:\s*(\d+)/g, (_, x: string) => {
          const n = parseInt(x, 10);
          return `table.vline(x: ${n + decimalCols.filter((d) => d < n).length}`;
        });
      if (decimalCols.length) {
        for (let i = 0; i < userRules.length; i++) userRules[i] = mapVlineX(userRules[i]);
        customExpanded = mapVlineX(custom).replace(/columns\s*:\s*\(([^)]*)\)/, (_, tuple: string) => {
          const widths = tuple.split(',').map((w: string) => w.trim());
          const out: string[] = [];
          widths.forEach((w, i) => {
            if (decimalCols.includes(i)) out.push(w === 'auto' ? 'auto' : w, 'auto');
            else out.push(w);
          });
          return `columns: (${out.join(', ')})`;
        });
      }

      const params: string[] = [];
      if (!customHas('columns')) params.push(`  columns: ${columns + decimalCols.length},`);
      if (anyAlign && !customHas('align')) {
        const emitted: string[] = [];
        colAligns.forEach((a, i) => {
          if (decimalCols.includes(i)) emitted.push('right', 'left');
          else emitted.push(a === 'decimal' ? 'right' : (a ?? 'auto'));
        });
        params.push(`  align: (${emitted.join(', ')}),`);
      }
      // Style preset and custom params are ADDITIVE: the preset renders
      // unless a custom key overrides it (stroke overrides the preset
      // stroke; the booktabs rules stay unless the style itself changes).
      if (style !== 'grid' && !customHas('stroke')) params.push('  stroke: none,');
      if (customExpanded) {
        const block = customExpanded
          .split('\n')
          .map((l) => '  ' + l.trim())
          .join('\n');
        params.push(block.replace(/,?\s*$/, ','));
      }
      if (style === 'booktabs') {
        // Each preset rule yields to an explicit table.hline at its own
        // boundary (the card cycles them light/heavy/none via y: rules).
        const hasY = (y: number) => new RegExp(`table\\.hline\\(\\s*y\\s*:\\s*${y}[,)]`).test(customAll);
        if (!hasY(0)) rows.unshift('  table.hline(stroke: 0.08em),');
        if (hasHeader && !hasY(1)) {
          const idx = rows.findIndex((r) => r.includes('table.header('));
          rows.splice(idx + 1, 0, '  table.hline(stroke: 0.05em),');
        }
        if (!hasY(node.childCount)) rows.push('  table.hline(stroke: 0.08em),');
      }
      for (const rule of userRules) params.push(`  ${rule},`);
      let tableCall = `table(\n${params.join('\n')}\n${rows.join('\n')}\n)`;
      const fontSize = (node.attrs.fontSize as string) || '';
      if (fontSize) {
        tableCall = `text(size: ${fontSize}, ${tableCall})`;
      }
      const directive = decimalCols.length ? `// typeset:decimal-columns ${decimalCols.join(',')}\n` : '';
      const caption = (node.attrs.caption as string) || '';
      const tLabel = (node.attrs.label as string) || '';
      if (caption || tLabel) {
        // A captioned table is a figure: numbered "Table N", referenceable.
        const cap = caption ? `,\n  caption: [${escapeTableCellText(caption)}]` : '';
        const kind = fontSize ? ',\n  kind: table' : '';
        const lab = portableTableLabel(tLabel);
        return indent + directive + `#figure(\n${tableCall.split('\n').map((l) => '  ' + l).join('\n')}${cap}${kind},\n)${lab}\n\n`;
      }
      return indent + directive + `#align(center, ${tableCall})\n\n`;
    }
    case 'bibliography': {
      // Embedded inline so the .typ stays self-contained (bytes() source).
      const bib = docBib;
      if (!bib?.content) return '';
      return indent + `#bibliography(bytes(${JSON.stringify(bib.content)}), title: "References", style: "ieee")\n\n`;
    }
    case 'page_break':
      return indent + '#pagebreak()\n\n';
    case 'numbering_restart':
      // Front matter ends: switch to the document's numbering format and
      // restart at 1 (the set page rule itself starts a new page).
      return indent + `#set page(numbering: "${docNumFormat}")\n#counter(page).update(1)\n\n`;
    case 'horizontal_rule':
      return indent + '#line(length: 100%)\n\n';
    case 'image':
      return indent + `#image("${imageSrc(node.attrs.src)}")\n\n`;
    default:
      return node.isTextblock ? indent + inlineToTyp(node) + '\n\n' : '';
  }
}

function containsMath(doc: PMNode): boolean {
  let found = false;
  doc.descendants((n) => {
    if (n.type.name === 'math_inline' || n.type.name === 'math_display') found = true;
    return !found;
  });
  return found;
}

let docNumFormat = '1';
let emitNumberEquations = true;
let unnumberedEqLabels = new Set<string>();

export function docToTyp(doc: PMNode, opts: TypExportOptions = {}): string {
  exportOpts = opts;
  docBib = (doc.attrs?.bib as { name: string; content: string } | null) ?? null;
  docBibKeys = new Set(docBib ? parseBibTeX(docBib.content).map((entry) => entry.key) : []);
  eqLabels = new Set();
  unnumberedEqLabels = new Set();
  doc.descendants((n) => {
    if (n.type.name === 'math_display' && n.attrs.label) {
      eqLabels.add(n.attrs.label as string);
      if (n.attrs.numbered === false) unnumberedEqLabels.add(n.attrs.label as string);
    }
    return true;
  });
  try {
    const s: DocSettings = normalizeSettings(doc.attrs?.settings as Partial<DocSettings> | null);
    docMacros = parseMathMacros(s.mathMacros);
    let out = '// Exported from Plass\n';
    const paperName = { letter: 'us-letter', a4: 'a4', legal: 'us-legal', b5: 'iso-b5' }[s.page] ?? 'us-letter';
    const uniform = s.marginTop === s.marginRight && s.marginTop === s.marginBottom && s.marginTop === s.marginLeft;
    const marginArg = uniform
      ? `margin: ${s.marginTop}in`
      : `margin: (top: ${s.marginTop}in, right: ${s.marginRight}in, bottom: ${s.marginBottom}in, left: ${s.marginLeft}in)`;
    const pageArgs = [`paper: "${paperName}"`, marginArg];
    if (s.landscape) pageArgs.push('flipped: true');
    let hasRestart = false;
    doc.forEach((n) => {
      if (n.type.name === 'numbering_restart') hasRestart = true;
    });
    docNumFormat = s.pageNumFormat;
    // With a restart marker, front-matter pages number in roman.
    const frontFormat = hasRestart ? 'i' : s.pageNumFormat;
    if (s.pageNumShow) pageArgs.push(`numbering: "${frontFormat}"`, `number-align: ${s.pageNumAlign}`);
    if (s.headerText) {
      const inner = escapeTyp(s.headerText).replace(/\\\{page\\\}|\{page\}/g, '#context counter(page).display()');
      const body = `align(${s.headerAlign})[${inner}]`;
      pageArgs.push(
        s.headerFirstPage
          ? `header: ${body}`
          : `header: context if(counter(page).get().first() > 1) { ${body} }`,
      );
    }
    out += `#set page(${pageArgs.join(', ')})\n`;
    out += parityRules(s);
    out += textSetLine(s, opts.fontFallback);
    emitNumberEquations = s.numberEquations;
    if (s.numberEquations) out += '#set math.equation(numbering: "(1)")\n';
    if (s.numberSections) out += '#set heading(numbering: "1.1")\n';
    if (s.pageNumStart !== 1) out += `#counter(page).update(${s.pageNumStart})\n`;
    if (s.mathMacros.trim()) out += `// typeset:math-macros ${JSON.stringify(s.mathMacros)}\n`;
    if (containsMath(doc)) out += '#import "@preview/mitex:0.2.5": mi, mitex\n';
    out += '\n';
    out += blocksToTyp(doc, '');
    return out.trimEnd() + '\n';
  } finally {
    exportOpts = {};
  }
}
