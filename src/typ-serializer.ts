// PM doc -> Typst markup (.typ) serialization (spec §3.3, serialize half).
//
// Math is authored as LaTeX (KaTeX) in v1, so exported math goes through the
// mitex Typst package, which compiles LaTeX math inside Typst documents.

import type { Node as PMNode } from 'prosemirror-model';
import { DEFAULT_SETTINGS, type DocSettings } from './settings';

export interface TypExportOptions {
  /** Rewrite image sources (e.g. data: URLs to VFS paths for compilation). */
  resolveImage?: (src: string) => string;
  /** Extra font families appended to #set text(font: …) as fallbacks. */
  fontFallback?: string[];
}

let exportOpts: TypExportOptions = {};
let eqLabels = new Set<string>();
let docBib: { name: string; content: string } | null = null;

function imageSrc(src: string): string {
  return exportOpts.resolveImage ? exportOpts.resolveImage(src) : src;
}

function escapeTyp(text: string): string {
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
      out += `#mi(\`${child.attrs.src}\`)`;
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
    case 'heading':
      return indent + '='.repeat(node.attrs.level) + ' ' + inlineToTyp(node) + '\n\n';
    case 'blockquote':
      return indent + '#quote(block: true)[\n' + blocksToTyp(node, indent + '  ') + indent + ']\n\n';
    case 'code_block':
      // Raw-Typst escape-hatch islands (from import) pass through verbatim.
      if (node.attrs.params === 'typst-raw') return indent + node.textContent + '\n\n';
      return indent + '```' + (node.attrs.params ?? '') + '\n' + node.textContent + '\n```\n\n';
    case 'math_display': {
      const label = node.attrs.label ? ` <${node.attrs.label}>` : '';
      return indent + '#mitex(`\n' + node.attrs.src + '\n`)' + label + '\n\n';
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
      node.forEach((row) => {
        const cells: string[] = [];
        let allHeader = row.childCount > 0;
        let col = 0;
        row.forEach((cell) => {
          if (cell.type.name !== 'table_header') allHeader = false;
          const parts: string[] = [];
          cell.forEach((block) => {
            if (block.isTextblock) parts.push(inlineToTyp(block));
          });
          const content = parts.join(' ').trim();
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

      const custom = ((node.attrs.params as string) || '').trim();
      const customHas = (name: string) => new RegExp(`(^|[\\s,(])${name}\\s*:`).test(custom);

      const params: string[] = [];
      if (!customHas('columns')) params.push(`  columns: ${columns},`);
      if (anyAlign && !customHas('align')) {
        params.push(`  align: (${colAligns.map((a) => a ?? 'auto').join(', ')}),`);
      }
      if (custom) {
        // Full-control mode: user's raw arguments replace the style preset.
        const block = custom
          .split('\n')
          .map((l) => '  ' + l.trim())
          .join('\n');
        params.push(block.replace(/,?\s*$/, ','));
      } else {
        if (style !== 'grid') params.push('  stroke: none,');
        if (style === 'booktabs') {
          rows.unshift('  table.hline(stroke: 0.08em),');
          if (hasHeader) {
            const idx = rows.findIndex((r) => r.includes('table.header('));
            rows.splice(idx + 1, 0, '  table.hline(stroke: 0.05em),');
          }
          rows.push('  table.hline(stroke: 0.08em),');
        }
      }
      return indent + `#table(\n${params.join('\n')}\n${rows.join('\n')}\n)\n\n`;
    }
    case 'bibliography': {
      // Embedded inline so the .typ stays self-contained (bytes() source).
      const bib = docBib;
      if (!bib?.content) return '';
      return indent + `#bibliography(bytes(${JSON.stringify(bib.content)}), title: "References", style: "ieee")\n\n`;
    }
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
    let out = '// Exported from Typeset\n';
    out += `#set page(paper: "${s.page === 'a4' ? 'a4' : 'us-letter'}", margin: ${s.marginIn}in)\n`;
    out += '#set par(justify: true)\n';
    const fonts = [s.font, ...(opts.fontFallback ?? []).filter((f) => f !== s.font)];
    const fontSpec = fonts.length > 1 ? `(${fonts.map((f) => `"${f}"`).join(', ')})` : `"${fonts[0]}"`;
    out += `#set text(size: ${s.sizePt}pt, font: ${fontSpec}, hyphenate: ${s.hyphenate})\n`;
    if (s.numberEquations) out += '#set math.equation(numbering: "(1)")\n';
    if (containsMath(doc)) out += '#import "@preview/mitex:0.2.5": mi, mitex\n';
    out += '\n';
    out += blocksToTyp(doc, '');
    return out.trimEnd() + '\n';
  } finally {
    exportOpts = {};
  }
}
