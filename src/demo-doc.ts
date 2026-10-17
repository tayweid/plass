// The starter document: says what the app is, and is built to show it off:
// justified paragraphs, hyphenation, a footnote, citations, inline and
// display math, a figure and a table, across a few pages.

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
  return table.create({ style: 'booktabs', caption: 'Revenue at three prices.', label: 'tbl:revenue' }, [
    row(['Quantity', 'Price', 'Revenue'], true),
    row(['10', '8.00', '80.00']),
    row(['20', '6.50', '130.00']),
    row(['30', '5.00', '150.00']),
  ]);
}

export function demoDoc(): PMNode {
  const code = (text: string) => ({ text, marks: ['code'] });
  const item = (lead: string, rest: string) => schema.nodes.list_item.create(null, p({ text: lead, marks: ['strong'] }, rest));
  return schema.nodes.doc.create({ bib: { name: 'references.bib', content: DEMO_BIB } }, [
    h(1, 'Plass'),
    p(
      'This page is laid out the way it will print. Every line break, hyphen and page break you see is the one the PDF will have. Click anywhere and start typing: the paragraph sets itself again around your words, and the pages follow.',
      { note: ['This is a footnote. Type ', code('^['), ' to start one, or press ', code('⌘⌥F'), '; type ', code(']'), ' or press Enter to leave it. It sits at the foot of the page its number is on.'] },
    ),
    h(2, 'Why this exists'),
    p(
      'There have long been two kinds of writing tools. LaTeX and Typst make beautiful pages, but you write code and check a preview beside it. Word and Google Docs let you write on the page, but they break lines one at a time, hyphenate poorly, and print something a little different from what the screen showed.',
    ),
    p(
      'Plass is both at once. It runs a copy of Typst’s line and page breaking inside the app, so the screen and the PDF agree, and Typst itself prints the PDF. The way of breaking lines goes back to Knuth and Plass ',
      { cite: 'knuthplass81' },
      ', who built it for TeX ',
      { cite: 'knuth86' },
      '; Typst ',
      { cite: 'madje22' },
      ' carries it on. Citations like these are live: type ',
      code('@'),
      ' and pick a source, and the references at the end keep up.',
    ),
    h(2, 'Mathematics'),
    p(
      'Math is written in LaTeX and drawn by Typst. A formula such as ',
      { math: 'e^{i\\pi} + 1 = 0' },
      ' sits in the line like a word. Type ',
      code('$x^2$'),
      ' to make one, and click one to change it. A display equation gets its own line and a number:',
    ),
    schema.nodes.math_display.create({
      src: '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
      label: 'eq:gauss',
    }),
    p(
      'Type ',
      code('$$'),
      ' on an empty line for a new one. To refer to an equation, type ',
      code('@'),
      ' and pick it from the list. Equation ',
      { ref: 'eq:gauss' },
      ' renumbers itself whenever you add or move equations. In the file, a formula stays LaTeX between dollar signs, the way pandoc reads it; for the page and the PDF, Plass turns it into Typst math, so the two always show the same thing.',
    ),
    h(2, 'Figures'),
    schema.nodes.figure.create({ src: DEMO_CHART, label: 'fig:sd' }, inline([
      'Supply and demand. You edit the caption; the number is added for you.',
    ])),
    p(
      'Paste or drop an image to add a figure, or press ',
      code('⌘⌥I'),
      '. Figures number themselves too, and ',
      code('@'),
      ' refers to them the same way: ',
      { ref: 'fig:sd' },
      ' is the chart above.',
    ),
    h(2, 'Tables'),
    p(
      'Press ',
      code('⌘⌥T'),
      ' for a table, then click a cell and type. The controls that appear to its left add rows and columns, align cells and change the style.',
    ),
    demoTable(),
    p(
      'A table with a caption numbers itself like a figure, and ',
      code('@'),
      ' refers to it the same way: ',
      { ref: 'tbl:revenue' },
      ' shows revenue rising as the price falls. A long table breaks across pages and repeats its header row.',
    ),
    h(2, 'How it works'),
    schema.nodes.bullet_list.create(null, [
      item('Measure.', ' Words are shaped by the same code Typst uses, built into the app, so each word is exactly as wide as it will be in the PDF.'),
      item('Break.', ' Each paragraph is broken into lines the way Typst breaks it: the whole paragraph is weighed at once, hyphens included, and the best set of breaks wins.'),
      item('Fill the pages.', ' Lines go onto pages as Typst puts them, with room kept for footnotes, no line left alone at the top or bottom of a page, and each heading kept with the text after it.'),
      item('Print.', ' Export runs Typst inside the app to make the PDF. There is nothing to install, and nothing leaves your computer.'),
    ]),
    schema.nodes.blockquote.create(null, [
      p('A block quote. Type ', code('>'), ' at the start of a line to make one.'),
    ]),
    p(
      'Typing Markdown works: ',
      code('#'),
      ' for a heading, ',
      code('**bold**'),
      ', ',
      code('*italic*'),
      ', ',
      code('-'),
      ' for a list. The file is Markdown too, a plain ',
      code('.md'),
      ' you can open in any text editor, keep in git or run through pandoc. Press ',
      code('⌘/'),
      ' to see this page as that text. Export (',
      code('⌘E'),
      ') makes a PDF, or a Markdown, Typst or LaTeX file.',
    ),
    p(
      'In the Mac app, Plass also keeps a history of your folder in git as you write. History (',
      code('⇧⌘H'),
      ') shows every point in that record and can take the folder back to any of them. The record stays on your Mac.',
    ),
    schema.nodes.bibliography.create(),
  ]);
}
