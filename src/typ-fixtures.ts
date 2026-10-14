// The .typ reader's test documents, shared: typ-parser.test.ts runs its
// import/export checks on them, and md-round.test.ts runs the cross-format
// check (a Markdown trip changes nothing the compiler sees, apart from the
// drops each fixture declares).

import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';

// --- 4. hand-written Typst: pragmatic subset + raw preservation ---
export const HAND_WRITTEN_TYP = [
  '#let answer = 42',
  '#show heading: set text(blue)',
  '',
  '= Intro',
  '',
  'Some *bold*, _italic_, and `code` here. Math like $x^2 + 1$ inline.',
  'A second source line of the same paragraph.',
  '',
  '- first item',
  '- second item',
  '',
  'Escaped \\* star and \\@ at-sign.',
].join('\n');

// --- 5. labels and references ---
export const LABELS_TYP = ['#mitex(`', 'a^2 + b^2 = c^2', '`) <eq:pyth>', '', 'See @eq:pyth. Done.'].join('\n');

// --- 6. a figure with a marked-up, bracketed caption ---
export const FIGURE_TYP = '#figure(image("chart.png"), caption: [The *elasticity* of demand [inelastic case]]) <fig:el>';

// --- strikethrough ---
export const STRIKE_TYP = 'Keep this, #strike[drop *this* part], continue.\n';

// --- 7. footnotes ---
export const FOOTNOTE_TYP = 'A claim#footnote[See *Smith 2020*, ch. 3 — and $x^2$ holds.] with a note.\n';

// --- 8. citations + embedded bibliography ---
export const CITATION_BIB = '@book{knuth86, title={The TeXbook}, author={Knuth, Donald E.}, year={1986}}';
export const CITATIONS_TYP = ['See @knuth86 and @eq:foo for details.', '', `#bibliography(bytes(${JSON.stringify(CITATION_BIB)}), style: "ieee")`].join('\n');

// --- 9. a table with a header and a merged cell ---
export const TABLE_MERGES_TYP = [
  '#table(',
  '  columns: 3,',
  '  table.header([Model], [Coef.], [SE]),',
  '  [OLS], [0.42], [0.05],',
  '  table.cell(colspan: 2)[Fixed effects], [yes],',
  ')',
].join('\n');

// --- 10. table style and alignment ---
export const TABLE_STYLES_TYP = [
  '#table(',
  '  columns: 2,',
  '  align: (left, right),',
  '  stroke: none,',
  '  table.hline(stroke: 0.08em),',
  '  table.header([Variable], [Estimate]),',
  '  table.hline(stroke: 0.05em),',
  '  [Constant], [1.234],',
  '  [Slope], table.cell(align: center)[0.567],',
  '  table.hline(stroke: 0.08em),',
  ')',
].join('\n');

// --- 11. custom #table arguments kept verbatim (params) ---
export const TABLE_PARAMS_TYP = [
  '#table(',
  '  columns: (2fr, 1fr, 1fr),',
  '  inset: 6pt,',
  '  fill: (x, y) => if calc.odd(y) { luma(245) },',
  '  table.header([A], [B], [C]),',
  '  [1], [2], [3],',
  ')',
].join('\n');

// --- 12. page numbering, sections, macros, heading labels ---
export const POLISH_TYP = [
  '// Exported from Plass',
  '#set page(paper: "us-letter", margin: 1.25in, numbering: "— 1 —", number-align: right)',
  '#set par(justify: true)',
  '#set text(size: 12.5pt, font: "New Computer Modern", hyphenate: true)',
  '#set math.equation(numbering: "(1)")',
  '#set heading(numbering: "1.1")',
  '#counter(page).update(3)',
  '// typeset:math-macros "\\\\E = \\\\mathbb{E}"',
  '#import "@preview/mitex:0.2.7": mi, mitex',
  '',
  '= Introduction <sec:intro>',
  '',
  'See @sec:intro and the mean #mi(`\\E[X]`).',
].join('\n');

// --- 13b. a captioned table (figure) with number, label and midrule ---
export const CAPTIONED_TABLE_TYP = [
  '#set page(paper: "us-letter", margin: 1.25in)',
  '',
  '#figure(',
  '  table(',
  '    columns: 2,',
  '    stroke: none,',
  '    table.hline(stroke: 0.08em),',
  '    table.header([A], [B]),',
  '    table.hline(stroke: 0.05em),',
  '    [1], [2],',
  '    table.hline(stroke: 0.08em),',
  '  ),',
  '  caption: [Results of the thing],',
  ') <tab:results>',
].join('\n');

// --- 13c. a decimal-aligned column ---
export function decimalTableDoc(): PMNode {
  const { table, table_row, table_cell, table_header, paragraph, doc: docType } = schema.nodes;
  const mk = (text: string, header = false, align: string | null = null) =>
    (header ? table_header : table_cell).create({ align }, [paragraph.create(null, text ? [schema.text(text)] : [])]);
  const t = table.create({ style: 'booktabs' }, [
    table_row.create(null, [mk('Item', true), mk('Price', true, 'decimal')]),
    table_row.create(null, [mk('Apples'), mk('12.5', false, 'decimal')]),
    table_row.create(null, [mk('Pears'), mk('3.75', false, 'decimal')]),
    table_row.create(null, [mk('Total'), mk('16', false, 'decimal')]),
  ]);
  return docType.create(null, [t]);
}

// --- 13d. table font size, caption, label and a vline in params ---
export function sizedTableDoc(): PMNode {
  const { table, table_row, table_cell, table_header, paragraph, doc: docType } = schema.nodes;
  const mk2 = (text: string, header = false) =>
    (header ? table_header : table_cell).create(null, [paragraph.create(null, text ? [schema.text(text)] : [])]);
  const t = table.create(
    { style: 'booktabs', fontSize: '0.85em', params: 'table.vline(x: 1, stroke: 0.05em)', caption: 'Sized', label: 'tab:sized' },
    [
      table_row.create(null, [mk2('A', true), mk2('B', true)]),
      table_row.create(null, [mk2('1'), mk2('2')]),
    ],
  );
  return docType.create(null, [t]);
}

// --- 13e. front matter: title, authors, date, abstract ---
export function frontMatterDoc(): PMNode {
  const { doc_title, doc_authors, doc_date, abstract, paragraph, doc: docType } = schema.nodes;
  return docType.create(null, [
    doc_title.create(null, [schema.text('On Widgets')]),
    doc_authors.create(null, [schema.text('T. Weidman and A. Nother')]),
    doc_date.create(null, [schema.text('July 8, 2026')]),
    abstract.create(null, [paragraph.create(null, [schema.text('We study widgets carefully.')])]),
    paragraph.create(null, [schema.text('Body starts here.')]),
  ]);
}

// --- 18. a solution block beside a plain quote ---
export function solutionDoc(): PMNode {
  const p = schema.nodes.paragraph;
  return schema.nodes.doc.create(null, [
    p.create(null, schema.text('Problem 1. Show that the sum is finite.')),
    schema.nodes.blockquote.create({ kind: 'solution' }, [
      p.create(null, schema.text('Bound each term by a geometric series.')),
      p.create(null, schema.text('The partial sums are therefore Cauchy.')),
    ]),
    schema.nodes.blockquote.create(null, [p.create(null, schema.text('A plain quote stays a quote.'))]),
  ]);
}

// --- 19c. table density presets ---
export const DENSITY_TYP = '#align(center, table(\n  columns: 2,\n  inset: 3pt,\n  stroke: none,\n  table.hline(stroke: 0.08em),\n  table.header([A], [B]),\n  table.hline(stroke: 0.05em),\n  [1], [2],\n  table.hline(stroke: 0.08em),\n))\n';
/** A non-uniform inset: no preset, kept in params. */
export const DENSITY_CUSTOM_TYP = DENSITY_TYP.replace('inset: 3pt', 'inset: (x: 2pt, y: 1pt)');

// --- 19d. row rule presets ---
export const ROW_RULES_TYP = '#align(center, table(\n  columns: 2,\n  stroke: none,\n  table.hline(y: 2, stroke: 0.05em),\n  table.hline(stroke: 0.08em),\n  table.header([A], [B]),\n  table.hline(stroke: 0.05em),\n  [1], [2],\n  [3], [4],\n  table.hline(stroke: 0.08em),\n))\n';
export const ROW_RULE_NONE_TYP = '#align(center, table(\n  columns: 2,\n  stroke: none,\n  table.hline(y: 1, stroke: none),\n  table.hline(stroke: 0.08em),\n  table.header([A], [B]),\n  [1], [2],\n  table.hline(stroke: 0.08em),\n))\n';
/** An unrecognized rule weight: no preset, kept in params. */
export const ROW_RULES_CUSTOM_TYP = ROW_RULES_TYP.replace('table.hline(y: 2, stroke: 0.05em)', 'table.hline(y: 2, stroke: 1pt)');

// --- 19e. cell fill presets ---
export const FILLS_TYP = '#align(center, table(\n  columns: 2,\n  stroke: none,\n  table.hline(stroke: 0.08em),\n  table.header([A], [B]),\n  table.hline(stroke: 0.05em),\n  table.cell(fill: luma(240))[1], [2],\n  [3], table.cell(align: right, fill: rgb("#fff3b0"))[4],\n  table.hline(stroke: 0.08em),\n))\n';

// --- 19b. a paragraph that starts with inline math ---
export const LEADING_MATH_TYP = 'Intro.\n\n$P^*$: \\_\\_\\_\n\nPrice is\n$Delta$ now.\n\n#grid(\n  columns: (1fr, 1fr),\n  gutter: 1em,\n  [\n    $Q^*$: \\_\\_\\_\n  ],\n  [\n    b\n  ],\n)\n';

// --- 20. grids: a blank line inside a cell, and the rail's richer content ---
export const GRID_TYP = 'Intro.\n\n#grid(\n  columns: 2,\n  [first para\n\n  second para],\n  [b],\n)\n\nAfter.\n';
export const RICH_GRID_TYP = [
  '#grid(',
  '  columns: (2fr, 1fr, 1fr),',
  '  gutter: 1.5em,',
  '  [',
  '    == Left',
  '',
  '    Text on the left.',
  '',
  '    - one',
  '    - two',
  '  ],',
  '  [',
  '    #table(',
  '      columns: 2,',
  '      [a], [b],',
  '    )',
  '  ],',
  '  [],',
  '  [',
  '    Second row.',
  '  ],',
  '  [],',
  '  [],',
  ')',
  '',
].join('\n');

// --- loose and tight lists in Typst markup ---
export const LISTS_TYP = 'Intro.\n\n- one\n\n- two\n\n+ a\n+ b\n\nAfter.\n';

// --- page chrome: running header and footer ---
const SECTION = '#context { let hs = query(selector(heading.where(level: 1)).before(here())); if hs.len() > 0 { hs.last().body } }';
const PAGE = '#context counter(page).display()';
export const CHROME_TYP =
  `#set page(paper: "us-letter", margin: 1in, numbering: "— 1 —", number-align: top + right, header: context if(counter(page).get().first() > 1) { align(left)[Notes · ${SECTION} · ${PAGE}] }, footer: align(center)[Econ 0100 · ${PAGE}])\n` +
  '#set text(font: "New Computer Modern", size: 12.5pt)\n\n= Title\n\nBody.\n';

// --- the Skillsheet's measured table controls ---
export const SKILLSHEET_TYP = '#table(columns: (auto, 1fr, auto), inset: 9pt, align: (center + horizon, left + horizon, center + horizon), fill: (x, y) => if y == 0 { luma(220) }, table.header([Code], [Skill], [Practice]), [B1.1], [Demand], [Exercise B1])';
/** Table expressions no attribute can say: each kept in params. */
export const UNSUPPORTED_TABLE_EXPRESSIONS = ['columns: (auto, calc.max(1fr, 2fr), auto)', 'inset: (x: 9pt, y: 5pt)', 'align: (x, y) => center', 'fill: (x, y) => if calc.odd(y) { luma(220) }'];
export const unsupportedTableTyp = (expression: string) => `#table(columns: 3, ${expression}, [A], [B], [C])`;

// --- image widths, inside grid cells too ---
export const IMAGE_GRID_TYP = '#grid(columns: (1fr, 1fr), gutter: 1em, [\n#image("axes.svg", width: 75%)\n], [\n#figure(image("curve.svg", width: 100%), caption: [A curve]) <fig:curve>\n])';
