// PM doc -> Typst markup (.typ) serialization (spec §3.3, serialize half).
//
// Math is authored as LaTeX (KaTeX) in v1, so exported math goes through the
// mitex Typst package, which compiles LaTeX math inside Typst documents.

import type { Node as PMNode } from 'prosemirror-model';
import { DEFAULT_SETTINGS, parseMathMacros, type DocSettings } from './settings';

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
export interface ParityMetrics {
  cssA: number;
  cssD: number;
  typAsc: number;
  typDesc: number;
  extent: number;
}

export const FONT_PARITY: Record<string, ParityMetrics> = {
  'New Computer Modern': { cssA: 1.127, cssD: 0.29, typAsc: 0.6723, typDesc: 0.0123, extent: 0.6828 },
  'STIX Two Text': { cssA: 0.762, cssD: 0.238, typAsc: 0.657, typDesc: -0.0001, extent: 0.657 },
  'Libertinus Serif': { cssA: 0.9, cssD: 0.25, typAsc: 0.6547, typDesc: -0.0053, extent: 0.6582 },
};

/**
 * First-baseline offset difference (Typst − editor CSS) in body em for a
 * unit type standing at a page top: Typst suppresses leading block spacing
 * and places the first baseline one ascender below the margin, while the
 * editor's CSS line boxes/padding still apply. The paginator shifts its
 * page spacers by this amount so page-top ink coincides with the PDF.
 */
export function pageTopAdjustEm(s: DocSettings, unit: 'paragraph' | 'line' | 'h1' | 'h2' | 'h3'): number {
  const m = FONT_PARITY[s.font] ?? FONT_PARITY['New Computer Modern'];
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

/** The parity header: set/show rules reproducing editor spacing in Typst. */
export function parityRules(s: DocSettings): string {
  const m = FONT_PARITY[s.font] ?? FONT_PARITY['New Computer Modern'];
  const lh = s.lineHeight;
  const pt = (em: number) => `${(em * s.sizePt).toFixed(3)}pt`;
  // Baseline → block-edge slack of a body paragraph line (em).
  const pSlackBelow = lh / 2 + (m.cssD - m.cssA) / 2;
  const pSlackAbove = lh / 2 + (m.cssA - m.cssD) / 2;
  let out = '';
  out += `#set par(justify: true, leading: ${pt(lh - m.extent)}, spacing: ${pt(lh + 0.9 - m.extent)})\n`;
  out += `#set list(spacing: ${pt(lh + 0.25 - m.extent)})\n`;
  out += `#set enum(spacing: ${pt(lh + 0.25 - m.extent)})\n`;
  for (const h of HEADINGS) {
    const hSlackAbove = (h.hs * (1.25 + m.cssA - m.cssD)) / 2;
    const hSlackBelow = (h.hs * (1.25 + m.cssD - m.cssA)) / 2;
    const above = pSlackBelow + 0.9 + h.padTop * h.hs + hSlackAbove - (m.typDesc + m.typAsc * h.hs) - h.shift;
    const below = hSlackBelow + h.marginBottom * h.hs + pSlackAbove - (m.typDesc * h.hs + m.typAsc) + h.shift;
    out += `#show heading.where(level: ${h.level}): set text(size: ${pt(h.hs)})\n`;
    out += `#show heading.where(level: ${h.level}): set block(above: ${pt(above)}, below: ${pt(below)})\n`;
    out += `#show heading.where(level: ${h.level}): set par(leading: ${pt((1.25 - m.extent) * h.hs)})\n`;
  }
  // Inline raw: pin Typst's defaults so editor code spans (same font file,
  // same ratio) have identical advance widths.
  out += `#show raw.where(block: false): set text(font: "DejaVu Sans Mono", size: ${pt(0.8)})\n`;
  // Display math: the editor shows Typst's own ink inside 0.5em padding.
  const eqAbove = pSlackBelow + 0.9 + 0.5 - m.typDesc;
  const eqBelow = 0.5 + 0.9 + pSlackAbove - m.typAsc;
  out += `#show math.equation.where(block: true): set block(above: ${pt(eqAbove)}, below: ${pt(eqBelow)})\n`;
  return out;
}

let exportOpts: TypExportOptions = {};
let eqLabels = new Set<string>();
let docBib: { name: string; content: string } | null = null;
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
  const fonts = fontFallback?.length
    ? `(${[s.font, ...fontFallback.filter((f) => f !== s.font)].map((f) => `"${f}"`).join(', ')})`
    : `"${s.font}"`;
  return `#set text(size: ${s.sizePt}pt, font: ${fonts}, hyphenate: ${s.hyphenate})\n`;
}

function imageSrc(src: string): string {
  return exportOpts.resolveImage ? exportOpts.resolveImage(src) : src;
}

export function escapeTyp(text: string): string {
  return text.replace(/[\\#$*_`@<>[\]]/g, (c) => '\\' + c);
}

function inlineToTyp(node: PMNode): string {
  let out = '';
  node.forEach((child) => {
    if (child.isText && child.text) {
      const marks = new Set(child.marks.map((m) => m.type.name));
      if (marks.has('code')) {
        out += '`' + child.text + '`';
        return;
      }
      let t = escapeTyp(child.text);
      if (marks.has('strong')) t = `*${t}*`;
      if (marks.has('em')) t = `_${t}_`;
      out += t;
    } else if (child.type.name === 'math_inline') {
      out += `#mi(\`${expandMacros(child.attrs.src)}\`)`;
    } else if (child.type.name === 'eq_ref') {
      // Equation refs render as "(1)" to match the editor (Typst's default
      // would be "Equation 1"); figure refs keep "Figure 1".
      out += eqLabels.has(child.attrs.label)
        ? `(#ref(<${child.attrs.label}>, supplement: none))`
        : `@${child.attrs.label}`;
    } else if (child.type.name === 'citation') {
      out += `@${child.attrs.key}`;
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
      // A leading =, - or + would re-parse as heading/list syntax.
      if (/^[=\-+]/.test(s)) s = '\\' + s;
      return indent + s + '\n\n';
    }
    case 'heading': {
      const label = node.attrs.label ? ` <${node.attrs.label}>` : '';
      return indent + '='.repeat(node.attrs.level) + ' ' + inlineToTyp(node) + label + '\n\n';
    }
    case 'blockquote':
      return indent + '#quote(block: true)[\n' + blocksToTyp(node, indent + '  ') + indent + ']\n\n';
    case 'code_block':
      // Raw-Typst escape-hatch islands (from import) pass through verbatim.
      if (node.attrs.params === 'typst-raw') return indent + node.textContent + '\n\n';
      return indent + '```' + (node.attrs.params ?? '') + '\n' + node.textContent + '\n```\n\n';
    case 'math_display': {
      const label = node.attrs.label ? ` <${node.attrs.label}>` : '';
      return indent + '#mitex(`\n' + expandMacros(node.attrs.src) + '\n`)' + label + '\n\n';
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

      let hasHeader = false;
      const rows: string[] = [];
      node.forEach((row, _rowOffset, rowIndex) => {
        const cells: string[] = [];
        let allHeader = row.childCount > 0;
        let col = 0;
        row.forEach((cell, _cellOffset, cellIndex) => {
          if (cell.type.name !== 'table_header') allHeader = false;
          const parts: string[] = [];
          cell.forEach((block) => {
            if (block.isTextblock) parts.push(inlineToTyp(block));
          });
          let content = parts.join(' ').trim();
          if (exportOpts.cellLinks) {
            content = `#link("cell://${rowIndex}-${cellIndex}")[${content || '#h(1em)'}]`;
          }
          const colspan = (cell.attrs.colspan as number) ?? 1;
          const rowspan = (cell.attrs.rowspan as number) ?? 1;
          const align = cell.attrs.align as string | null;
          const args: string[] = [];
          if (colspan > 1) args.push(`colspan: ${colspan}`);
          if (rowspan > 1) args.push(`rowspan: ${rowspan}`);
          if (align && align !== colAligns[col]) args.push(`align: ${align}`);
          cells.push(args.length ? `table.cell(${args.join(', ')})[${content}]` : `[${content}]`);
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
        .replace(/table\.hline\([^)]*\)\s*,?/g, (m) => {
          userRules.push(m.replace(/,?\s*$/, ''));
          return '';
        })
        .replace(/,\s*,/g, ',')
        .replace(/^\s*,\s*/, '')
        .replace(/[,\s]+$/, '')
        .trim();
      const customHas = (name: string) => new RegExp(`(^|[\\s,(])${name}\\s*:`).test(custom);

      const params: string[] = [];
      if (!customHas('columns')) params.push(`  columns: ${columns},`);
      if (anyAlign && !customHas('align')) {
        params.push(`  align: (${colAligns.map((a) => a ?? 'auto').join(', ')}),`);
      }
      // Style preset and custom params are ADDITIVE: the preset renders
      // unless a custom key overrides it (stroke overrides the preset
      // stroke; the booktabs rules stay unless the style itself changes).
      if (style !== 'grid' && !customHas('stroke')) params.push('  stroke: none,');
      if (custom) {
        const block = custom
          .split('\n')
          .map((l) => '  ' + l.trim())
          .join('\n');
        params.push(block.replace(/,?\s*$/, ','));
      }
      if (style === 'booktabs') {
        rows.unshift('  table.hline(stroke: 0.08em),');
        if (hasHeader) {
          const idx = rows.findIndex((r) => r.includes('table.header('));
          rows.splice(idx + 1, 0, '  table.hline(stroke: 0.05em),');
        }
        rows.push('  table.hline(stroke: 0.08em),');
      }
      for (const rule of userRules) params.push(`  ${rule},`);
      return indent + `#align(center, table(\n${params.join('\n')}\n${rows.join('\n')}\n))\n\n`;
    }
    case 'bibliography': {
      // Embedded inline so the .typ stays self-contained (bytes() source).
      const bib = docBib;
      if (!bib?.content) return '';
      return indent + `#bibliography(bytes(${JSON.stringify(bib.content)}), title: "References", style: "ieee")\n\n`;
    }
    case 'page_break':
      return indent + '#pagebreak()\n\n';
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

export function docToTyp(doc: PMNode, opts: TypExportOptions = {}): string {
  exportOpts = opts;
  docBib = (doc.attrs?.bib as { name: string; content: string } | null) ?? null;
  eqLabels = new Set();
  doc.descendants((n) => {
    if (n.type.name === 'math_display' && n.attrs.label) eqLabels.add(n.attrs.label as string);
    return true;
  });
  try {
    const s: DocSettings = { ...DEFAULT_SETTINGS, ...((doc.attrs?.settings as Partial<DocSettings>) ?? {}) };
    docMacros = parseMathMacros(s.mathMacros);
    let out = '// Exported from Typeset\n';
    const paperName = { letter: 'us-letter', a4: 'a4', legal: 'us-legal', b5: 'iso-b5' }[s.page] ?? 'us-letter';
    const pageArgs = [`paper: "${paperName}"`, `margin: ${s.marginIn}in`];
    if (s.landscape) pageArgs.push('flipped: true');
    if (s.pageNumShow) pageArgs.push(`numbering: "${s.pageNumFormat}"`, `number-align: ${s.pageNumAlign}`);
    out += `#set page(${pageArgs.join(', ')})\n`;
    out += parityRules(s);
    const fonts = [s.font, ...(opts.fontFallback ?? []).filter((f) => f !== s.font)];
    const fontSpec = fonts.length > 1 ? `(${fonts.map((f) => `"${f}"`).join(', ')})` : `"${fonts[0]}"`;
    out += `#set text(size: ${s.sizePt}pt, font: ${fontSpec}, hyphenate: ${s.hyphenate})\n`;
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
