// Vanilla LaTeX export: clean, idiomatic article-class .tex for journal
// submission (journals reformat manuscripts, so this is SEMANTIC export —
// no attempt at pixel parity, which is the .typ/PDF pipeline's job).
//
// Free wins baked into the document model: math sources are stored as
// LaTeX (KaTeX) and pass through untouched; the bibliography is raw BibTeX
// (emitted via filecontents*, so the export stays a single file); booktabs
// styling maps 1:1, including light/heavy rule weights.

import type { Node as PMNode } from 'prosemirror-model';
import { normalizeSettings, parseMathMacros, type DocSettings } from './settings';

let macros: Record<string, string> = {};
let unnumberedEq = new Set<string>();

/** Escape plain text for LaTeX (backslash first, then specials). */
export function escapeTex(s: string): string {
  return s
    .replace(/\\/g, '\u0000')
    .replace(/([{}$&#%_])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/\u0000/g, '\\textbackslash{}')
    .replace(/\u2014/g, '---')
    .replace(/\u2013/g, '--')
    .replace(/\u201C/g, '``')
    .replace(/\u201D/g, "''")
    .replace(/\u2018/g, '`')
    .replace(/\u2019/g, "'")
    .replace(/\u2026/g, '\\ldots{}')
    .replace(/\u00A0/g, '~')
    // macOS key glyphs (docs about shortcuts) — pdflatex takes no unicode
    // symbols; degrade to readable text.
    .replace(/\u2318/g, '\\textsf{Cmd-}')
    .replace(/\u2325/g, '\\textsf{Opt-}')
    .replace(/\u21E7/g, '\\textsf{Shift-}')
    .replace(/\u2303/g, '\\textsf{Ctrl-}')
    .replace(/\u22EF/g, '$\\cdots$')
    .replace(/\u00B7/g, '\\textperiodcentered{}');
}

function inlineToTex(node: PMNode): string {
  let out = '';
  node.forEach((child) => {
    if (child.isText && child.text) {
      const marks = new Set(child.marks.map((m) => m.type.name));
      let t = escapeTex(child.text);
      if (marks.has('code')) t = `\\texttt{${t}}`;
      if (marks.has('strong')) t = `\\textbf{${t}}`;
      if (marks.has('em')) t = `\\emph{${t}}`;
      out += t;
    } else if (child.type.name === 'math_inline') {
      out += `$${child.attrs.src}$`;
    } else if (child.type.name === 'eq_ref') {
      const label = child.attrs.label as string;
      out += unnumberedEq.has(label)
        ? escapeTex(`@${label}`)
        : /^(fig|tab|sec):/.test(label)
          ? `\\ref{${label}}`
          : `\\eqref{${label}}`;
    } else if (child.type.name === 'citation') {
      out += `\\cite{${child.attrs.key}}`;
    } else if (child.type.name === 'footnote') {
      out += `\\footnote{${inlineToTex(child)}}`;
    } else if (child.type.name === 'hard_break') {
      out += ' \\\\\n';
    } else if (child.type.name === 'image') {
      out += `\\includegraphics{${imagePath(child.attrs.src as string)}}`;
    }
  });
  return out;
}

let dataUrlNote = false;
function imagePath(src: string): string {
  if (src.startsWith('data:')) {
    dataUrlNote = true;
    return 'embedded-image.png';
  }
  return src;
}

function blocksToTex(parent: PMNode, s: DocSettings): string {
  let out = '';
  parent.forEach((node) => {
    out += blockToTex(node, s);
  });
  return out;
}

function tableToTex(node: PMNode, s: DocSettings): string {
  void s;
  interface Cell {
    node: PMNode;
    colspan: number;
    rowspan: number;
    header: boolean;
    align: string | null;
  }
  const rows: Cell[][] = [];
  node.forEach((row) => {
    const cells: Cell[] = [];
    row.forEach((cell) => {
      cells.push({
        node: cell,
        colspan: (cell.attrs.colspan as number) ?? 1,
        rowspan: (cell.attrs.rowspan as number) ?? 1,
        header: cell.type.name === 'table_header',
        align: (cell.attrs.align as string | null) ?? null,
      });
    });
    rows.push(cells);
  });
  const nCols = Math.max(...rows.map((r) => r.reduce((n, c) => n + c.colspan, 0)));

  // Occupancy: rowspans cover cells in later rows, which LaTeX still wants
  // as empty & slots.
  const covered: boolean[][] = rows.map(() => new Array<boolean>(nCols).fill(false));
  const colAlign: string[] = new Array<string>(nCols).fill('l');
  rows.forEach((cells, r) => {
    let g = 0;
    for (const cell of cells) {
      while (g < nCols && covered[r][g]) g++;
      if (cell.align && !cell.header) {
        colAlign[g] = cell.align === 'right' ? 'r' : cell.align === 'center' ? 'c' : 'l';
      }
      for (let dr = 1; dr < cell.rowspan; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) {
          if (covered[r + dr]) covered[r + dr][g + dc] = true;
        }
      }
      g += cell.colspan;
    }
  });

  // User rules from params ('none' = an explicitly suppressed preset rule).
  const params = (node.attrs.params as string) || '';
  const hlines = new Map<number, 'light' | 'heavy' | 'none'>();
  const vlines = new Map<number, 'light' | 'heavy' | 'none'>();
  const weight = (s: string | undefined): 'light' | 'heavy' | 'none' =>
    s === 'none' ? 'none' : parseFloat(s ?? '0.05') >= 0.07 ? 'heavy' : 'light';
  for (const m of params.matchAll(/table\.hline\(\s*y\s*:\s*(\d+)(?:[^)]*?stroke\s*:\s*(none|[\d.]+em))?[^)]*\)/g)) {
    hlines.set(+m[1], weight(m[2]));
  }
  for (const m of params.matchAll(/table\.vline\(\s*x\s*:\s*(\d+)(?:[^)]*?stroke\s*:\s*(none|[\d.]+em))?[^)]*\)/g)) {
    vlines.set(+m[1], weight(m[2]));
  }
  const midrule = (w: 'light' | 'heavy'): string => (w === 'heavy' ? '\\midrule[\\heavyrulewidth]' : '\\midrule');

  const cellTex = (cell: Cell): string => {
    // Cells hold block content (paragraphs); flatten inline.
    let inner = '';
    cell.node.forEach((p) => {
      if (inner) inner += ' ';
      inner += inlineToTex(p);
    });
    if (cell.header) inner = `\\textbf{${inner}}`;
    if (cell.rowspan > 1) inner = `\\multirow{${cell.rowspan}}{*}{${inner}}`;
    if (cell.colspan > 1) inner = `\\multicolumn{${cell.colspan}}{c}{${inner}}`;
    return inner;
  };

  let body = '';
  rows.forEach((cells, r) => {
    const w = hlines.get(r);
    if (r > 0 && w && w !== 'none') body += midrule(w) + '\n';
    const slots: string[] = [];
    let g = 0;
    let ci = 0;
    while (g < nCols) {
      if (covered[r][g]) {
        slots.push('');
        g++;
        continue;
      }
      const cell = cells[ci++];
      if (!cell) break;
      slots.push(cellTex(cell));
      g += cell.colspan;
    }
    body += slots.join(' & ') + ' \\\\\n';
    // The preset header midrule yields to an explicit y:1 rule (drawn above).
    if (r === 0 && cells.some((c) => c.header) && !hlines.has(1)) body += '\\midrule\n';
  });

  const caption = (node.attrs.caption as string) || '';
  const label = (node.attrs.label as string) || '';
  // Outer edges honor explicit overrides ('none' drops the rule entirely).
  const edge = (y: number, rule: string): string => {
    const w = hlines.get(y);
    if (!w) return rule + '\n';
    return w === 'none' ? '' : midrule(w) + '\n';
  };
  const spec = colAlign.map((a, g) => (vlines.get(g) && vlines.get(g) !== 'none' ? '|' + a : a)).join('');
  const rightEdge = vlines.get(nCols) && vlines.get(nCols) !== 'none' ? '|' : '';
  const tabular =
    `\\begin{tabular}{${spec}${rightEdge}}\n` +
    edge(0, '\\toprule') +
    body +
    edge(rows.length, '\\bottomrule') +
    `\\end{tabular}`;
  if (caption) {
    return (
      `\\begin{table}[htbp]\n\\centering\n\\caption{${escapeTex(caption)}}\n` +
      (label ? `\\label{${label}}\n` : '') +
      `${tabular}\n\\end{table}\n\n`
    );
  }
  return `\\begin{center}\n${tabular}\n\\end{center}\n\n`;
}

function blockToTex(node: PMNode, s: DocSettings): string {
  switch (node.type.name) {
    case 'paragraph': {
      const t = inlineToTex(node);
      if (!t.trim()) return '~\\par\n\n';
      return t + '\n\n';
    }
    case 'heading': {
      const cmd = ['\\section', '\\subsection', '\\subsubsection'][Math.min(3, node.attrs.level as number) - 1];
      const star = s.numberSections ? '' : '*';
      const label = node.attrs.label ? `\\label{${node.attrs.label}}` : '';
      return `${cmd}${star}{${inlineToTex(node)}}${label}\n\n`;
    }
    case 'math_display': {
      const label = node.attrs.label ? `\\label{${node.attrs.label}}` : '';
      const src = node.attrs.src as string;
      const numbered = (node.attrs.numbered as boolean | null) ?? (s.numberEquations || !!node.attrs.label);
      // Multi-line sources become an aligned block (one number, Typst-style).
      const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
      const body = (lines.length > 1 || /(?<!\\)&/.test(src)) && !src.includes('\\begin{')
        ? `\\begin{aligned}\n${lines.join(' \\\\\n')}\n\\end{aligned}`
        : src;
      if (numbered) {
        return `\\begin{equation}${label}\n${body}\n\\end{equation}\n\n`;
      }
      return `\\[\n${body}\n\\]\n\n`;
    }
    case 'figure': {
      const label = node.attrs.label ? `\\label{${node.attrs.label}}\n` : '';
      const caption = inlineToTex(node);
      return (
        `\\begin{figure}[htbp]\n\\centering\n` +
        `\\includegraphics[width=0.8\\linewidth]{${imagePath(node.attrs.src as string)}}\n` +
        (caption ? `\\caption{${caption}}\n` : '') +
        label +
        `\\end{figure}\n\n`
      );
    }
    case 'bullet_list':
    case 'ordered_list': {
      const env = node.type.name === 'bullet_list' ? 'itemize' : 'enumerate';
      let out = `\\begin{${env}}\n`;
      node.forEach((item) => {
        out += '\\item ' + blocksToTex(item, s).trim() + '\n';
      });
      return out + `\\end{${env}}\n\n`;
    }
    case 'blockquote':
      return `\\begin{quote}\n${blocksToTex(node, s).trim()}\n\\end{quote}\n\n`;
    case 'code_block': {
      if ((node.attrs.params as string) === 'typst-raw') {
        const lines = node.textContent.split('\n').map((l) => '% ' + l);
        return `% [Typeset] raw Typst block with no LaTeX equivalent:\n${lines.join('\n')}\n\n`;
      }
      return `\\begin{verbatim}\n${node.textContent}\n\\end{verbatim}\n\n`;
    }
    case 'table':
      return tableToTex(node, s);
    case 'bibliography':
      return `\\bibliographystyle{unsrt}\n\\bibliography{refs}\n\n`;
    case 'page_break':
      return '\\clearpage\n\n';
    case 'numbering_restart':
      return '\\clearpage\n\\pagenumbering{arabic}\n\n';
    case 'horizontal_rule':
      return '\\noindent\\hrulefill\n\n';
    case 'image':
      return `\\begin{center}\\includegraphics[width=0.8\\linewidth]{${imagePath(node.attrs.src as string)}}\\end{center}\n\n`;
    default:
      return '';
  }
}

/** Serialize the document to vanilla article-class LaTeX. */
export function docToTex(doc: PMNode): string {
  const s = normalizeSettings(doc.attrs?.settings as Partial<DocSettings> | null);
  macros = parseMathMacros(s.mathMacros);
  dataUrlNote = false;

  const classSize = s.sizePt <= 10.5 ? 10 : s.sizePt <= 11.5 ? 11 : 12;
  const paper = { letter: 'letterpaper', a4: 'a4paper', legal: 'legalpaper', b5: 'b5paper' }[s.page] ?? 'letterpaper';

  // Front matter + structure scan.
  let title = '';
  let authors = '';
  let date = '';
  let abstract: PMNode | null = null;
  let hasRestart = false;
  let usesMultirow = false;
  doc.forEach((n) => {
    if (n.type.name === 'doc_title') title = inlineToTex(n);
    else if (n.type.name === 'doc_authors') authors = inlineToTex(n);
    else if (n.type.name === 'doc_date') date = inlineToTex(n);
    else if (n.type.name === 'abstract') abstract = n;
    else if (n.type.name === 'numbering_restart') hasRestart = true;
  });
  doc.descendants((n) => {
    if ((n.type.name === 'table_cell' || n.type.name === 'table_header') && ((n.attrs.rowspan as number) ?? 1) > 1) {
      usesMultirow = true;
    }
    return true;
  });
  unnumberedEq = new Set();
  doc.descendants((n) => {
    if (n.type.name === 'math_display' && n.attrs.label && n.attrs.numbered === false) {
      unnumberedEq.add(n.attrs.label as string);
    }
    return true;
  });
  const bib = doc.attrs?.bib as { name: string; content: string } | null;

  let out = '% Exported from Typeset (semantic export: content and structure,\n';
  out += '% not layout — your journal template does the formatting).\n';
  if (bib?.content) {
    out += `\\begin{filecontents*}[overwrite]{refs.bib}\n${bib.content.trim()}\n\\end{filecontents*}\n\n`;
  }
  out += `\\documentclass[${classSize}pt,${paper}]{article}\n`;
  out += '\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n';
  out += '\\usepackage{amsmath,amssymb}\n\\usepackage{graphicx}\n\\usepackage{booktabs}\n';
  if (usesMultirow) out += '\\usepackage{multirow}\n';
  if (!s.parIndent) out += '\\usepackage{parskip}\n';
  out += `\\usepackage[${paper},top=${s.marginTop}in,right=${s.marginRight}in,bottom=${s.marginBottom}in,left=${s.marginLeft}in]{geometry}\n`;
  for (const [name, expansion] of Object.entries(macros)) {
    out += `\\newcommand{\\${name}}{${expansion}}\n`;
  }
  out += '\n';
  if (title) out += `\\title{${title}}\n`;
  if (authors) out += `\\author{${authors}}\n`;
  out += date ? `\\date{${date}}\n` : title ? '\\date{}\n' : '';
  out += '\\begin{document}\n\n';
  if (hasRestart) out += '\\pagenumbering{roman}\n';
  if (title) out += '\\maketitle\n\n';
  if (abstract) {
    out += `\\begin{abstract}\n${blocksToTex(abstract, s).trim()}\n\\end{abstract}\n\n`;
  }

  doc.forEach((n) => {
    if (['doc_title', 'doc_authors', 'doc_date', 'abstract'].includes(n.type.name)) return;
    out += blockToTex(n, s);
  });

  out += '\\end{document}\n';
  if (dataUrlNote) {
    out =
      '% NOTE: this document contains pasted (embedded) images. Save the\n' +
      '% paper as a project folder in Typeset so figures become real files,\n' +
      '% then re-export; embedded-image.png below is a placeholder name.\n' + out;
  }
  return out;
}
