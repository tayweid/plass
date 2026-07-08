// The starter document: explains the app, and is built to show it off —
// justified paragraphs, hyphenation, inline and display math.

import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';

type InlineSpec =
  | string
  | { text: string; marks?: string[] }
  | { math: string }
  | { ref: string }
  | { cite: string }
  | { note: InlineSpec[] };

function inline(specs: InlineSpec[]): PMNode[] {
  return specs.map((s) => {
    if (typeof s === 'string') return schema.text(s);
    if ('math' in s) return schema.nodes.math_inline.create({ src: s.math });
    if ('ref' in s) return schema.nodes.eq_ref.create({ label: s.ref });
    if ('cite' in s) return schema.nodes.citation.create({ key: s.cite });
    if ('note' in s) return schema.nodes.footnote.create(null, inline(s.note));
    return schema.text(s.text, (s.marks ?? []).map((m) => schema.marks[m].create()));
  });
}

const DEMO_BIB = `@book{knuth86,
  author    = {Knuth, Donald E.},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1986}
}
@article{knuthplass81,
  author  = {Knuth, Donald E. and Plass, Michael F.},
  title   = {Breaking Paragraphs into Lines},
  journal = {Software: Practice and Experience},
  year    = {1981}
}
@misc{madje22,
  author = {M{\\"a}dje, Laurenz},
  title  = {Typst: A Programmable Markup Language for Typesetting},
  year   = {2022}
}`;

const p = (...specs: InlineSpec[]) => schema.nodes.paragraph.create(null, inline(specs));
const h = (level: number, text: string) => schema.nodes.heading.create({ level }, schema.text(text));

// A small self-contained supply-and-demand chart (no network needed).
const DEMO_CHART =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="230" viewBox="0 0 420 230">
<rect width="420" height="230" fill="white"/>
<line x1="50" y1="190" x2="390" y2="190" stroke="#333" stroke-width="1.5"/>
<line x1="50" y1="190" x2="50" y2="20" stroke="#333" stroke-width="1.5"/>
<line x1="70" y1="170" x2="360" y2="40" stroke="#305c8a" stroke-width="2"/>
<line x1="70" y1="40" x2="360" y2="170" stroke="#a33d2f" stroke-width="2"/>
<circle cx="215" cy="105" r="4" fill="#222"/>
<text x="365" y="38" font-family="Georgia" font-size="13" fill="#305c8a">S</text>
<text x="365" y="178" font-family="Georgia" font-size="13" fill="#a33d2f">D</text>
<text x="222" y="98" font-family="Georgia" font-size="12" fill="#222">E</text>
<text x="385" y="205" font-family="Georgia" font-size="12" fill="#333">Q</text>
<text x="32" y="30" font-family="Georgia" font-size="12" fill="#333">P</text>
</svg>`,
  );

function demoTable(): PMNode {
  const { table, table_row, table_cell, table_header, paragraph } = schema.nodes;
  const aligns: Array<string | null> = [null, 'right', 'right'];
  const cell = (text: string, col: number, header = false) =>
    (header ? table_header : table_cell).create({ align: aligns[col] }, [
      paragraph.create(null, text ? [schema.text(text)] : []),
    ]);
  const row = (texts: string[], header = false) =>
    table_row.create(null, texts.map((t, col) => cell(t, col, header)));
  return table.create({ style: 'booktabs' }, [
    row(['Quantity', 'Price', 'Revenue'], true),
    row(['10', '8.00', '80.00']),
    row(['20', '6.50', '130.00']),
    row(['30', '5.00', '150.00']),
  ]);
}

export function demoDoc(): PMNode {
  return schema.nodes.doc.create({ bib: { name: 'references.bib', content: DEMO_BIB } }, [
    h(1, 'Typeset'),
    p(
      { text: 'What you are reading is being typeset right now, as you edit it. ', marks: [] },
      'Every line break in this document was chosen by the ',
      { text: 'Knuth–Plass algorithm', marks: ['strong'] },
      ' — the same optimizing paragraph breaker used by TeX and Typst — and imposed on ordinary, fully editable browser text. Click anywhere and start typing: the paragraph re-typesets around your cursor in about a millisecond, and every line lands exactly where the PDF will put it.',
      { note: ['Footnotes live at the bottom of the page their marker lands on — this text is editable right here, and the paginator reserves space for it when breaking pages. Type ', { text: '^[', marks: ['code'] }, ' anywhere to open one (', { text: ']', marks: ['code'] }, ' or Enter hops back out), or use ', { text: '⌘⌥F', marks: ['code'] }, '.'] },
    ),
    h(2, 'Why this exists'),
    p(
      'Markup-and-compile tools like LaTeX produce beautiful pages but make you write in a two-pane workflow, forever glancing between source and preview. WYSIWYG editors are pleasant to write in, but their typography tops out at what CSS does by default: first-fit line breaking, no global optimization, no hyphenation worth the name. The gap between them has persisted for decades, with characteristically institutional explanations — backward compatibility, standardization inertia, disciplinary boundaries between the people who care about editing and the people who care about typography.',
    ),
    p(
      'The line-breaking problem was formalized by Knuth and Plass ',
      { cite: 'knuthplass81' },
      ' and realized in TeX ',
      { cite: 'knuth86' },
      '; Typst ',
      { cite: 'madje22' },
      ' modernized the whole stack. Citations here are live: type ',
      { text: '@', marks: ['code'] },
      ' and pick an entry — works are numbered by first use and collected in the references list at the end, exactly as the PDF will render them.',
    ),
    p(
      'The insight this editor is built on: ',
      { text: 'every layout decision a TeX-class engine makes can be expressed in CSS', marks: ['em'] },
      '. Line breaks, per-line word spacing, hyphenation points — all of it. So the document stays in the DOM, where selection, cursor movement, IME, spell-check, and screen readers all work natively, and a layout oracle demotes the browser from layout engine to rasterizer, imposing optimal breaks through generated styling. The editing surface ',
      { text: 'is', marks: ['em'] },
      ' the output surface.',
    ),
    h(2, 'Mathematics'),
    p(
      'Inline math renders in place: ',
      { math: 'e^{i\\pi} + 1 = 0' },
      ' sits in the text flow and the oracle treats it as an unbreakable box, justifying around it like any other word. Click a formula to edit its source; type ',
      { text: '$\\alpha^2$', marks: ['code'] },
      ' anywhere to create one. Type ',
      { text: '@', marks: ['code'] },
      ' to reference any labeled equation or figure — a picker lists them with their current numbers. Display equations get their own block:',
    ),
    schema.nodes.math_display.create({
      src: '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
      label: 'eq:gauss',
    }),
    p(
      'Type ',
      { text: '$$', marks: ['code'] },
      ' on an empty line for a new equation. Equations are numbered automatically and renumber live as you add or reorder them; give one a label in its editor and reference it in text by typing ',
      { text: '@eq:gauss', marks: ['code'] },
      ' — like this: equation ',
      { ref: 'eq:gauss' },
      ' stays correct no matter where it moves, and clicking the reference jumps to it. Math is entered as LaTeX and rendered by KaTeX; the Typst export wraps it with mitex so exported files compile to camera-ready PDF.',
    ),
    h(2, 'Figures'),
    schema.nodes.figure.create({ src: DEMO_CHART, label: 'fig:sd' }, inline([
      'Supply and demand. The caption is ordinary editable text; the ',
      { text: 'Figure 1', marks: ['em'] },
      ' prefix is painted by the numbering plugin.',
    ])),
    p(
      'Insert figures with ⌘⌥I (or the ⋯ menu), or just paste or drop an image. Click a figure to select it, click the label chip to name it, and reference it in text the same way as equations: ',
      { ref: 'fig:sd' },
      ' renumbers live, exactly like equation ',
      { ref: 'eq:gauss' },
      '.',
    ),
    h(2, 'Tables'),
    p(
      'Insert a table with ',
      { text: '⌘⌥T', marks: ['code'] },
      '. What you see is the compiled table — click it to edit in a focused card (cells, rows, columns, alignment, style) with a live result. Tables export as native Typst ',
      { text: '#table', marks: ['code'] },
      ':',
    ),
    demoTable(),
    h(2, 'How it works'),
    schema.nodes.bullet_list.create(null, [
      schema.nodes.list_item.create(null, p(
        { text: 'Measure.', marks: ['strong'] },
        ' Every word is measured with the browser’s own font metrics, so the oracle’s arithmetic and the renderer’s pixels agree by construction.',
      )),
      schema.nodes.list_item.create(null, p(
        { text: 'Optimize.', marks: ['strong'] },
        ' Knuth–Plass considers every feasible set of break points for the whole paragraph — including hyphenation points from Liang’s patterns, TeX’s own hyphenation algorithm — and minimizes total demerits.',
      )),
      schema.nodes.list_item.create(null, p(
        { text: 'Impose.', marks: ['strong'] },
        ' The chosen breaks and per-line spacing are applied as editor decorations: presentation only, invisible to the document model, the clipboard, and assistive technology.',
      )),
    ]),
    schema.nodes.blockquote.create(null, [
      p(
        'The first true WYSIWYG typesetting editor is not a research project; it is a translation layer between two mature systems, plus product polish.',
      ),
    ]),
    p(
      'Everything is markdown-flavored: ',
      { text: '#', marks: ['code'] },
      ' for headings, ',
      { text: '**bold**', marks: ['code'] },
      ', ',
      { text: '*italic*', marks: ['code'] },
      ', ',
      { text: '>', marks: ['code'] },
      ' for quotes, ',
      { text: '-', marks: ['code'] },
      ' for lists. Documents autosave locally. Export produces a clean ',
      { text: '.typ', marks: ['code'] },
      ' file — human-readable, git-friendly, and one ',
      { text: 'typst compile', marks: ['code'] },
      ' away from publication-quality PDF with real page layout, floats, and microtypography.',
    ),
    schema.nodes.bibliography.create(),
  ]);
}
