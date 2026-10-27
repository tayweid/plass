import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { expect, test, type Page } from './fixture';

// The port audit: Plass has one renderer (the ported line breaker and the
// local paginator); Typst is the printer. This spec is how the two are kept
// honest. It opens each document through the app's own file manager, lets
// the editor lay it out, compiles it once with Typst, and reports every
// block whose line breaks differ and the first page start that differs.
//
//   npm run audit                      the built-in fixtures, strict
//   AUDIT=<file-or-folder> npm run audit   your own documents, report only
//
// Nothing here runs in the edit loop: the editor never compiles.

interface PortAuditReport {
  compileMs: number;
  analyzeMs: number;
  typst: { status: 'ok' | 'fail'; reason?: string; pageCount: number };
  chrome: Array<{ page: number; typst: string[]; editor: string[] }>;
  pages: {
    local: Array<{ pos: number; line: number; unit: string }>;
    typst: Array<{ pos: number; line: number; unit: string }>;
    localCount: number;
    agree: boolean;
    firstDiff: { firstDiffPage: number; cause: string; localStart: unknown; exactStart: unknown } | null;
  };
  blocks: Array<{ pos: number; type: string; text: string; status: string; port?: string; typst?: string; authority?: string | null; reason?: string; unmeasured?: string[] }>;
  summary: { blocks: number; match: number; mismatch: number; typstFail: number; noPort: number; browserMismatch: number; pagesAgree: boolean; chromeMismatch: number; unmeasuredAtoms: number };
}

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> };
    __pagCount: () => number;
    __blockAuthority: (pos: number) => { authority: string | null } | null;
    __audit: () => Promise<PortAuditReport | null>;
    __mathInk: () => Record<string, number>;
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';

/** Built-in fixtures: the rails, each in enough volume to paginate. */
const FIXTURES: Array<{ name: string; text: string }> = [
  {
    name: 'prose.md',
    // Every fourth paragraph opens with a red run (text-color.ts) that
    // outlasts its first line: a fill is paint, so the breaks must hold.
    text: ['# Prose', '', ...Array.from({ length: 14 }, (_, i) => (i % 4 === 1 ? `[${FILLER.trimEnd()}]{.red} ` : '') + FILLER.repeat(3 + (i % 4)).trimEnd() + '\n')].join('\n'),
  },
  {
    name: 'structure.md',
    text: [
      '# Structure',
      '',
      FILLER.repeat(4).trimEnd(),
      '',
      '## Lists',
      '',
      '- ' + FILLER.repeat(2).trimEnd(),
      '- ' + FILLER.repeat(1).trimEnd(),
      '- ' + FILLER.repeat(3).trimEnd(),
      '',
      '1. ' + FILLER.repeat(2).trimEnd(),
      '2. ' + FILLER.repeat(2).trimEnd(),
      '',
      '> ' + FILLER.repeat(3).trimEnd(),
      '',
      ...Array.from({ length: 8 }, () => FILLER.repeat(4).trimEnd() + '\n'),
      '### Math and notes',
      '',
      'Inline math [$x^2 + y^2 = z^2$ sits red]{.red} in the run.[^1] ' + FILLER.repeat(3).trimEnd(),
      '',
      '$$ \\int_0^1 f(x) \\, dx = F(1) - F(0) $$',
      '',
      ...Array.from({ length: 6 }, () => FILLER.repeat(5).trimEnd() + '\n'),
      '[^1]: A footnote with a little body text of its own.',
    ].join('\n'),
  },
];

const TABLE_ROWS = 45;
FIXTURES.push(
  {
    name: 'lists.md',
    text: [
      '# Lists',
      '',
      FILLER.repeat(2).trimEnd(),
      '',
      ...Array.from({ length: 4 }, (_, i) => '- ' + FILLER.repeat(2 + (i % 3)).trimEnd()),
      '  - Nested ' + FILLER.repeat(2).trimEnd(),
      '    - Third level ' + FILLER.repeat(2).trimEnd(),
      '',
      ...Array.from({ length: 12 }, (_, i) => `${i + 1}. Item ${i + 1}: ` + FILLER.repeat(1 + (i % 2)).trimEnd()),
      '',
      ...Array.from({ length: 6 }, () => FILLER.repeat(4).trimEnd() + '\n'),
    ].join('\n'),
  },
  {
    name: 'footnotes.md',
    text: [
      '# Footnotes',
      '',
      ...Array.from({ length: 12 }, (_, i) => FILLER.repeat(3).trimEnd() + ` A remark.[^${i + 1}] ` + FILLER.repeat(2).trimEnd() + '\n'),
      ...Array.from({ length: 12 }, (_, i) => `[^${i + 1}]: Footnote ${i + 1}. ` + FILLER.repeat(i % 2 ? 2 : 1).trimEnd()),
    ].join('\n'),
  },
  {
    name: 'math.md',
    text: [
      '# Math',
      '',
      ...Array.from({ length: 10 }, (_, i) => `Inline math $x^${i} + y^2 = z^2$ sits in the run. ` + FILLER.repeat(3).trimEnd() + ` Then $\\alpha_${i}$ again. ` + FILLER.repeat(2).trimEnd() + '\n'),
      '$$ \\int_0^1 f(x) \\, dx = F(1) - F(0) $$',
      '',
      ...Array.from({ length: 6 }, () => FILLER.repeat(4).trimEnd() + '\n'),
    ].join('\n'),
  },
  {
    name: 'table.md',
    text: [
      '# A long table',
      '',
      'An introductory paragraph sits above the table.',
      '',
      '| Item | Value |',
      '| --- | --- |',
      ...Array.from({ length: TABLE_ROWS - 1 }, (_, i) => `| Row ${i + 1} | ${i + 1} |`),
      '',
      'A closing paragraph follows the table. ' + FILLER.repeat(3).trimEnd(),
      '',
    ].join('\n'),
  },
);

FIXTURES.push({
  // Item pitch: tight lists, loose lists (blank lines between items), an
  // item holding two paragraphs, a loose list nested in a tight one.
  name: 'lists-loose.md',
  text: [
    '# Pitch',
    '',
    FILLER.repeat(2).trimEnd(),
    '',
    ...Array.from({ length: 3 }, (_, i) => '- ' + FILLER.repeat(1 + (i % 2)).trimEnd()),
    '',
    FILLER.repeat(1).trimEnd(),
    '',
    ...Array.from({ length: 3 }, (_, i) => '- ' + FILLER.repeat(1 + (i % 2)).trimEnd() + '\n'),
    FILLER.repeat(1).trimEnd(),
    '',
    ...Array.from({ length: 3 }, (_, i) => `${i + 1}. ` + FILLER.repeat(1 + (i % 2)).trimEnd() + '\n'),
    FILLER.repeat(1).trimEnd(),
    '',
    '- ' + FILLER.repeat(1).trimEnd(),
    '',
    '  ' + FILLER.repeat(1).trimEnd(),
    '',
    '- ' + FILLER.repeat(1).trimEnd(),
    '',
    FILLER.repeat(1).trimEnd(),
    '',
    '- ' + FILLER.repeat(1).trimEnd(),
    '  - ' + FILLER.repeat(1).trimEnd(),
    '',
    '  - ' + FILLER.repeat(1).trimEnd(),
    '- ' + FILLER.repeat(1).trimEnd(),
    '',
    ...Array.from({ length: 4 }, () => FILLER.repeat(3).trimEnd() + '\n'),
    ...Array.from({ length: 6 }, (_, i) => '- ' + FILLER.repeat(2 + (i % 3)).trimEnd() + '\n'),
    FILLER.repeat(3).trimEnd(),
    '',
  ].join('\n'),
});

FIXTURES.push({
  // Lists with indented (classic) paragraphs: spaced from their neighbours
  // by the leading alone, as a paragraph is (the page added 0.9em after
  // every list and over every nested list, and broke a page later than
  // Typst from page 3). Tight lists, a nested list in the middle and at the
  // end, an enum, a loose list whose first item ends in a nested list,
  // headings after them.
  name: 'lists-classic.md',
  text: [
    '---',
    'indent: true',
    '---',
    '',
    '# Classic lists',
    '',
    ...Array.from({ length: 4 }, (_, k) => [
      FILLER.repeat(3).trimEnd(),
      '',
      FILLER.repeat(2).trimEnd(),
      '',
      '- ' + FILLER.trimEnd(),
      '- ' + FILLER.repeat(2).trimEnd(),
      '  - ' + FILLER.trimEnd(),
      '  - ' + FILLER.trimEnd(),
      '- ' + FILLER.trimEnd(),
      '',
      FILLER.repeat(2).trimEnd(),
      '',
      '1. ' + FILLER.trimEnd(),
      '2. ' + FILLER.repeat(2).trimEnd(),
      '    - ' + FILLER.trimEnd(),
      '',
      FILLER.trimEnd(),
      '',
      '- ' + FILLER.trimEnd(),
      '  - ' + FILLER.trimEnd(),
      '',
      '- ' + FILLER.trimEnd(),
      '',
      `## Section ${k + 1}`,
      '',
      FILLER.repeat(2).trimEnd(),
      '',
    ]).flat(),
  ].join('\n'),
});

FIXTURES.push({
  // Numbered lists that start past 1: each prints from its start, its label
  // column as wide as its last label (9 to 10, 98 to 100, 2026), a list
  // from 0, a nested list with its own start, one long enough to cross a
  // page. Paragraphs that only look like list or term items, opening the
  // paragraph or a line after a hard break, and a running footer opening
  // with a dash print as the text they are.
  name: 'lists-start.md',
  text: [
    '---',
    'plass:',
    '  footer: {text: "- {page} -", align: center}',
    '---',
    '',
    '# Numbering',
    '',
    FILLER.repeat(2).trimEnd(),
    '',
    '3. ' + FILLER.repeat(2).trimEnd(),
    '4. ' + FILLER.repeat(1).trimEnd(),
    '',
    FILLER.repeat(1).trimEnd(),
    '',
    '9. Nine: ' + FILLER.repeat(2).trimEnd(),
    '10. Ten: ' + FILLER.repeat(2).trimEnd(),
    '',
    FILLER.repeat(2).trimEnd(),
    '',
    '98. ' + FILLER.repeat(1).trimEnd(),
    '99. ' + FILLER.repeat(2).trimEnd(),
    '100. ' + FILLER.repeat(1).trimEnd(),
    '',
    FILLER.repeat(1).trimEnd(),
    '',
    '0. Zero: ' + FILLER.repeat(1).trimEnd(),
    '1. One: ' + FILLER.repeat(1).trimEnd(),
    '',
    FILLER.repeat(1).trimEnd(),
    '',
    '2026. ' + FILLER.repeat(2).trimEnd(),
    '',
    '- ' + FILLER.repeat(1).trimEnd(),
    '',
    '  5. Nested from five: ' + FILLER.repeat(1).trimEnd(),
    '  6. ' + FILLER.repeat(1).trimEnd(),
    '',
    '- ' + FILLER.repeat(1).trimEnd(),
    '',
    '3\\. Only looks like a list item: ' + FILLER.repeat(2).trimEnd(),
    '',
    '/ Only looks like a term: ' + FILLER.repeat(2).trimEnd(),
    '',
    'A line ends here.\\',
    '\\- And this one only looks like a bullet: ' + FILLER.repeat(2).trimEnd(),
    '',
    ...Array.from({ length: 5 }, () => FILLER.repeat(4).trimEnd() + '\n'),
    ...Array.from({ length: 6 }, (_, i) => `${i + 12}. ` + FILLER.repeat(2 + (i % 2)).trimEnd()),
    '',
    ...Array.from({ length: 3 }, () => FILLER.repeat(4).trimEnd() + '\n'),
  ].join('\n'),
});

FIXTURES.push({
  name: 'headings.md',
  text: [
    '# A first-level heading long enough to wrap onto a second line of the page at the default size',
    '',
    FILLER.repeat(2).trimEnd(),
    '',
    '## A second-level heading that also runs long enough to need a second line, and perhaps a third one too',
    '',
    FILLER.repeat(2).trimEnd(),
    '',
    '### Third level: the algorithm evaluates a complete paragraph and preserves globally optimal line endings',
    '',
    FILLER.repeat(3).trimEnd(),
    '',
    '## Hyphenation candidates: extraordinarily uncharacteristically straightforward internationalization',
    '',
    FILLER.repeat(2).trimEnd(),
    '',
  ].join('\n'),
});

FIXTURES.push({
  // Slashes Typst would read as comments anywhere in markup: `//` in prose
  // and in a footnote, a slash beside a strong run's stars (`/*`, `*/`), a
  // scheme Typst does not link. The print must hold every word the page
  // shows; a URL Typst links keeps its slashes.
  name: 'slashes.md',
  text: [
    '# Slashes',
    '',
    ...Array.from(
      { length: 6 },
      (_, i) =>
        FILLER.repeat(2).trimEnd() +
        ' Keep this // and this too: **either**/**or**, km/**h**, ftp://host/x and HTTP://EXAMPLE.COM/x as plain text. ' +
        FILLER.repeat(1).trimEnd() +
        ` A remark.[^${i + 1}] ` +
        FILLER.repeat(2).trimEnd() +
        '\n',
    ),
    'See https://typst.app/docs/reference//model for the rest. ' + FILLER.repeat(3).trimEnd(),
    '',
    ...Array.from({ length: 6 }, (_, i) => `[^${i + 1}]: See a // b. ` + FILLER.repeat(1).trimEnd()),
  ].join('\n'),
});

FIXTURES.push({
  // URLs Typst links on its own, touching markup: a strong and an emph URL,
  // a footnote, a citation and a no-break space right after a URL, a URL
  // holding `_`, `#` and `~`, one whose formatting changes partway, one
  // with an unbalanced bracket. Typst's link ran on into each: the print
  // failed to compile or printed what the page does not show.
  name: 'urls.md',
  text: [
    '# URLs',
    '',
    ...Array.from(
      { length: 6 },
      (_, i) =>
        FILLER.repeat(2).trimEnd() +
        ' See **https://example.com/strong** and *https://example.com/em*, a note at https://example.com/n' +
        `[^${i + 1}], a source at https://example.com/c[@knuth86], https://example.com/glued\u00a0here, ` +
        'https://en.wikipedia.org/wiki/Knuth_Plass#Line~breaking, https://x.com**/path** and https://example.com/a(b too. ' +
        FILLER.repeat(2).trimEnd() +
        '\n',
    ),
    ...Array.from({ length: 6 }, (_, i) => `[^${i + 1}]: See https://example.com/foo_bar for more. ` + FILLER.repeat(1).trimEnd() + '\n'),
    '```{=bibtex}',
    '@book{knuth86, author = {Knuth, Donald E.}, title = {The TeXbook}, publisher = {Addison-Wesley}, year = {1986}}',
    '```',
    '',
  ].join('\n'),
});

// Inline code and inline raw never grow a line, on the page or in print:
// a long table with code in every row, at the body's size and at 0.8em,
// and prose at 10 pt and line spacing 1.3 with code on every line, in
// list items, a quote, footnote entries and a wrapping heading. The page's
// code box hung below the line and grew each row by 2-3 px, each body
// line by 0.55 px; in print, raw sized from the body grew the smaller
// table's rows and set a heading's code at the wrong width.
{
  const CODE_FILLER = 'The Knuth Plass algorithm evaluates `a_complete` paragraph and preserves `globally_optimal` line endings while `editing` without visible jitter. ';
  const codeTable = (div: string) => [
    '# A long table with code',
    '',
    'An introductory paragraph sits above the table.',
    '',
    ...(div ? [div, ''] : []),
    '| Item | Value |',
    '| --- | --- |',
    ...Array.from({ length: TABLE_ROWS - 1 }, (_, i) => `| Row \`${i + 1}\` | value \`v${i + 1}\` |`),
    '',
    ...(div ? [':::', ''] : []),
    'A closing paragraph follows the table. ' + FILLER.repeat(3).trimEnd(),
    '',
  ].join('\n');
  FIXTURES.push(
    { name: 'code-table.md', text: codeTable('') },
    { name: 'code-table-small.md', text: codeTable('::: {.table font-size=0.8em}') },
    {
      name: 'code-lines.md',
      text: [
        '---',
        'fontsize: 10pt',
        'linestretch: 1.3',
        '---',
        '',
        '# Code on every line, and `inline_code` in a heading long enough to wrap onto a second line',
        '',
        ...Array.from({ length: 8 }, (_, i) => CODE_FILLER.repeat(5).trimEnd() + ` A remark.[^${i + 1}] ` + CODE_FILLER.repeat(2).trimEnd() + '\n'),
        '- ' + CODE_FILLER.repeat(2).trimEnd(),
        '- ' + CODE_FILLER.repeat(1).trimEnd(),
        '',
        '> ' + CODE_FILLER.repeat(3).trimEnd(),
        '',
        ...Array.from({ length: 6 }, () => CODE_FILLER.repeat(4).trimEnd() + '\n'),
        ...Array.from({ length: 8 }, (_, i) => `[^${i + 1}]: Footnote ${i + 1} with \`code_in_it\`. ` + CODE_FILLER.repeat(1 + (i % 2)).trimEnd()),
      ].join('\n'),
    },
  );
}

const TYP_HEAD = (page: string, extra = '') =>
  `#set page(${page})\n#set par(justify: true, leading: 10.215pt, spacing: 21.465pt)\n#set list(spacing: 13.34pt)\n#set enum(spacing: 13.34pt)\n${extra}#set text(font: "New Computer Modern", size: 12.5pt)\n\n`;
const NOTES = Array.from({ length: 8 }, (_, i) => FILLER.repeat(3).trimEnd() + ` A remark.#footnote[Note ${i + 1}. ${FILLER.repeat(i % 2 ? 2 : 1).trimEnd()}] ` + FILLER.repeat(2).trimEnd()).join('\n\n');
FIXTURES.push(
  {
    // Half letter (notes printed two to a sheet): a custom size whose margins
    // are not whole pixels, lists at a knife-edge measure, a list item at a
    // page top.
    name: 'half-letter.typ',
    text:
      TYP_HEAD('width: 5.5in, height: 8.5in, margin: 0.6in') +
      '= Half sheets\n\n' +
      Array.from({ length: 14 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      `\n\n- ${FILLER.repeat(2).trimEnd()}\n- ${FILLER.repeat(1).trimEnd()}\n\n` +
      Array.from({ length: 6 }, () => FILLER.repeat(4).trimEnd()).join('\n\n') +
      '\n',
  },
  {
    // Footnote numbering by letters and no separator rule.
    name: 'footnotes-a.typ',
    text: TYP_HEAD('paper: "us-letter", margin: 1.25in', '#set footnote(numbering: "a")\n#set footnote.entry(separator: none)\n') + '= Notes\n\n' + NOTES + '\n',
  },
  {
    // Symbol markers and a full-width rule.
    name: 'footnotes-symbols.typ',
    text: TYP_HEAD('paper: "us-letter", margin: 1.25in', '#set footnote(numbering: "*")\n#set footnote.entry(separator: line(length: 100%, stroke: 0.5pt))\n') + '= Notes\n\n' + NOTES + '\n',
  },
);

FIXTURES.push(
  {
    // Page chrome: a running header with the section in force and the page
    // number in the document's format, a running footer (which replaces
    // the automatic number), neither on page 1.
    name: 'chrome.typ',
    text:
      TYP_HEAD(
        'paper: "us-letter", margin: 1.25in, numbering: "— 1 —", number-align: center, ' +
          'header: context if(counter(page).get().first() > 1) { align(right)[Notes · #context { let hs = query(selector(heading.where(level: 1)).before(here())); if hs.len() > 0 { hs.last().body } } · #context counter(page).display()] }, ' +
          'footer: context if(counter(page).get().first() > 1) { align(center)[Econ 0100 · #context counter(page).display()] }',
      ) +
      '= Introduction\n\n' +
      Array.from({ length: 5 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      '\n\n= Supply and demand\n\n' +
      Array.from({ length: 6 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      '\n\n= Elasticity\n\n' +
      Array.from({ length: 7 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      '\n',
  },
  {
    // The automatic number in the header (number-align: top), a two-number
    // format, and a footer whose {page} shows the counter alone.
    name: 'chrome-top.typ',
    text:
      TYP_HEAD('paper: "us-letter", margin: 1.25in, numbering: "1 / 1", number-align: top + right, footer: align(center)[Page #context counter(page).display()]') +
      '= Numbers\n\n' +
      Array.from({ length: 12 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      '\n',
  },
);

FIXTURES.push({
  // The grid rail: text beside a table, three fraction columns, and a
  // three-row grid tall enough to break between rows.
  name: 'grid.typ',
  text:
    TYP_HEAD('paper: "us-letter", margin: 1.25in') +
    '= Grids\n\n' +
    FILLER.repeat(3).trimEnd() +
    '\n\n#grid(\n  columns: (2fr, 1fr),\n  gutter: 1em,\n  [\n    ' +
    FILLER.repeat(2).trimEnd() +
    '\n\n    ' +
    FILLER.repeat(1).trimEnd() +
    '\n  ],\n  [\n    #table(\n      columns: 2,\n      table.header([Item], [Value]),\n      [Alpha], [1],\n      [Beta], [2],\n      [Gamma], [3],\n    )\n  ],\n)\n\n' +
    FILLER.repeat(3).trimEnd() +
    // Aligned cells (grid.cell(align:)): the breaks are the port's as
    // before; only the last line and the cell's place in the row move.
    '\n\n#grid(\n  columns: (1fr, 1fr, 1fr),\n  gutter: 1.5em,\n  [\n    == Left\n\n    ' +
    FILLER.repeat(1).trimEnd() +
    '\n  ],\n  grid.cell(align: right + horizon)[\n    - one\n    - two\n    - three\n  ],\n  grid.cell(align: center)[\n    ' +
    FILLER.repeat(1).trimEnd() +
    // Merged cells (grid.cell(colspan:)): two columns and the gutter
    // between them, then all three; the port breaks at the merged width.
    '\n  ],\n  grid.cell(colspan: 2)[\n    ' +
    FILLER.repeat(2).trimEnd() +
    '\n  ],\n  [\n    Short.\n  ],\n  grid.cell(colspan: 3, align: center)[\n    ' +
    FILLER.repeat(1).trimEnd() +
    // Short cells side by side: Typst's text layer joins lines that share
    // a baseline with no separator ("Beside.Third.", "abc", a one-line
    // cell and its neighbour's first line); the matcher splits them back,
    // around a code block and an island too ("let x = 1;Beside it.#text…").
    '\n  ],\n)\n\n#grid(\n  columns: (2fr, 1fr, 1fr),\n  gutter: 1em,\n  [\n    ' +
    FILLER.repeat(1).trimEnd() +
    '\n  ],\n  [\n    Beside.\n  ],\n  [\n    Third.\n  ],\n  [\n    a\n  ],\n  [\n    b\n  ],\n  [\n    c\n  ],\n  [\n    One line.\n  ],\n  grid.cell(colspan: 2)[\n    ' +
    FILLER.repeat(1).trimEnd() +
    '\n  ],\n  [\n    ```\n    let x = 1;\n    ```\n  ],\n  [\n    Beside it.\n  ],\n  [\n    #text(fill: red)[Kept.]\n  ],\n)\n\n' +
    Array.from({ length: 4 }, () => FILLER.repeat(4).trimEnd()).join('\n\n') +
    '\n\n#grid(\n  columns: (1fr, 1fr),\n  gutter: 1em,\n' +
    Array.from({ length: 6 }, (_, i) => `  ${i === 3 ? 'grid.cell(align: right + bottom)' : ''}[\n    ` + FILLER.repeat(2 + (i % 2)).trimEnd() + '\n  ],').join('\n') +
    '\n)\n\n' +
    Array.from({ length: 3 }, () => FILLER.repeat(4).trimEnd()).join('\n\n') +
    '\n',
});

// Editorial comments (editor-comments.ts): notes at every kind of seam —
// leading, between paragraphs, before a heading, stacked, beside a list,
// beside a footnote, after an explicit page break, trailing. The compile
// never sees them; every break and page start must still agree.
{
  const typNote = (t: string) => '// plass:comment\n' + t.split('\n').map((l) => '// | ' + l).join('\n') + '\n// /plass:comment';
  const mdNote = (t: string) => '<!-- plass:comment\n' + t + '\n-->';
  const body = (note: (t: string) => string, heading: (t: string, level: number) => string, pageBreak: string, footnote: (t: string) => string) =>
    [
      note('Leading note: a place to stand first.'),
      heading('Comments', 1),
      FILLER.repeat(3).trimEnd(),
      note('Between paragraphs.\nA second line.\n\nAfter a blank line.'),
      FILLER.repeat(4).trimEnd(),
      FILLER.repeat(2).trimEnd() + ' With a note' + footnote('The entry at the foot of the page, long enough to wrap onto a second line of the entry area.') + ' beside it.',
      note('Before a heading.'),
      note('Stacked: a second note right after the first.'),
      heading('Lists and breaks', 2),
      '- ' + FILLER.repeat(1).trimEnd() + '\n- ' + FILLER.repeat(1).trimEnd() + '\n- ' + FILLER.repeat(1).trimEnd(),
      note('After a list.'),
      ...Array.from({ length: 5 }, () => FILLER.repeat(4).trimEnd()),
      pageBreak,
      note('After the explicit page break.'),
      ...Array.from({ length: 3 }, () => FILLER.repeat(3).trimEnd()),
      note('Trailing note.'),
    ].join('\n\n') + '\n';
  FIXTURES.push(
    {
      name: 'comments.typ',
      text: TYP_HEAD('paper: "us-letter", margin: 1.25in, numbering: "1", number-align: center') + body(typNote, (t, l) => '='.repeat(l) + ' ' + t, '#pagebreak()', (t) => `#footnote[${t}]`),
    },
    {
      // The page break is Markdown's `\newpage`. It used to be a ```typst
      // fence, which has always reopened as an island, so this twin never
      // exercised the seam after an explicit break; now it does.
      name: 'comments.md',
      text: body(mdNote, (t, l) => '#'.repeat(l) + ' ' + t, '\\newpage', (t) => `^[${t}]`),
    },
  );
}

// The Markdown source's rails together in a course-style solutions file
// long enough to paginate (the step-4 fixture the referee also reads):
// front matter with plass: keys, a solution holding a two-column grid with
// a data-URL image, labeled and unnumbered equations, a table with math in
// a .table div, comments at the top level and nested, a page break, a
// {=typst} block, a {=bibtex} fence, footnotes, a strike and a {++ ++} mark.
// Markdown grid cells whose lines share a baseline around blocks the
// matcher does not lay out: text then a display equation (matched by its
// ink's glyphs), an equation then text, a code block then text.
{
  const row = (cells: string[]) =>
    '::: {.columns gutter=1em}\n' + cells.map((c) => '::: {.column width=50%}\n' + c + '\n:::').join('\n') + '\n:::';
  FIXTURES.push({
    name: 'grid-joins.md',
    text: [
      '# Grid joins',
      FILLER.repeat(2).trimEnd(),
      row(['Beside.', '$$ x^2 + y^2 = z^2 $$']),
      row(['$$ a + b = c $$', 'Beside it.']),
      row(['```\nlet x = 1;\n```', 'After the code.']),
      FILLER.repeat(3).trimEnd(),
    ].join('\n\n') + '\n',
  });
}

FIXTURES.push({ name: 'guide.md', text: readFileSync(new URL('./fixtures/md/guide.md', import.meta.url), 'utf8') });

// tests/environment-fingerprint.spec.ts's document. A quote right after a
// heading: both spacings are explicit and Typst keeps the larger (the
// quote's 2.4em), where the page added the quote's padding to the
// heading's spacing; 3.98 px short after the third-level heading, so page
// 1 held the whole of a paragraph Typst breaks after its fourth line.
{
  const sentence = 'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';
  FIXTURES.push({
    name: 'fingerprint.md',
    text: [
      '# Fingerprint',
      '',
      sentence.repeat(6).trim(),
      '',
      '## Second level',
      '',
      '### Third level',
      '',
      '> ' + sentence.trim(),
      '',
      '```',
      'print("hi")',
      'x = 1',
      '```',
      '',
      'Inline `code` and text.',
      '',
      ...Array.from({ length: 30 }, () => [sentence.repeat(5).trim(), '']).flat(),
    ].join('\n'),
  });
}

FIXTURES.push({
  name: 'table-bare.md',
  text: ['| Item | Value |', '| --- | --- |', ...Array.from({ length: TABLE_ROWS - 1 }, (_, i) => `| Row ${i + 1} | ${i + 1} |`), ''].join('\n'),
});

// Display math at a page's edge (the 2026-10-16 sweep: an equation walked
// across page 1's bottom at 1 in margins). Each document is the sweep's at
// a point the editor once got wrong. A display equation's frame is its
// content box, inside 0.5em of padding; Typst trims the equation's spacing
// at a page's end (bottom: it fits by its frame) and drops it at a page's
// top (top: it lands with its frame at the margin, and the audit names the
// start `math_display` on both sides), inside a quote and at a grid cell's
// edges too (quote, grid); a numbered equation shorter than its number is
// the number's height (numbered: `x` is 8.675pt, not 5.6625pt). A quote is
// 2.4em above and 1.8em below, frame to frame, whatever it opens with
// (quote-mid: the quote mid-page, opening with the equation; the editor's
// quote was 1.35pt short and fit two more lines on page 2).
{
  const words = FILLER.repeat(8).trim().split(' ');
  const edge = (w: number, block: string[]) =>
    [
      '# Sweep',
      '',
      ...Array.from({ length: 3 }, () => [FILLER.repeat(4).trim(), '']).flat(),
      words.slice(0, w).join(' ') + '.',
      '',
      ...block,
      ...Array.from({ length: 6 }, () => [FILLER.repeat(4).trim(), '']).flat(),
    ].join('\n');
  const frac = '$$ \\frac{a+b}{c} = d $$';
  // A block inside a quote takes the quote's spacing (Typst's quote sets
  // it as a show-set its content inherits): a list, a list nested in an
  // item, a code block are 2.4em below the paragraph before them and 1.8em
  // above the one after. Spaced as paragraphs, the list was 11.38 px
  // higher than its print at 12.5 pt and the page held a line more.
  FIXTURES.push(
    {
      name: 'quote-list-edge.md',
      text: edge(32, ['> Quote with a list. ' + FILLER.trim(), '>', '> - Item a. ' + FILLER.trim(), '> - Item b.', '>', '> Closing. ' + FILLER.repeat(2).trim(), '']),
    },
    {
      name: 'quote-nested-list-edge.md',
      text: edge(36, ['> - Item a. ' + FILLER.trim(), '>   - Sub a. ' + FILLER.trim(), '> - Item b.', '>', '> Closing. ' + FILLER.repeat(2).trim(), '']),
    },
    {
      name: 'quote-code-edge.md',
      text: edge(4, ['> Quote with code. ' + FILLER.trim(), '>', '> ```', '> let x = 1', '> let y = 2', '> let z = 3', '> ```', '>', '> Closing. ' + FILLER.repeat(2).trim(), '']),
    },
  );
  // A table that opens a page: Typst drops the spacing above it and its
  // frame starts at the margin. The page landed it a margin-top higher
  // (8.27 px at 12.5 pt) and page 2 held a line more than Typst's; the
  // sweep disagreed from 48 to 80 words of lead-in at the top level and
  // from 40 to 80 in a quote. A page gap before a table carries the
  // table's margin-top now (style.css).
  const table = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'];
  FIXTURES.push(
    { name: 'table-edge.md', text: edge(64, ['Quote with a table. ' + FILLER.trim(), '', ...table, '', 'Closing. ' + FILLER.repeat(2).trim(), '']) },
    {
      name: 'quote-table-edge.md',
      text: edge(64, ['> Quote with a table. ' + FILLER.trim(), '>', ...table.map((line) => '> ' + line), '>', '> Closing. ' + FILLER.repeat(2).trim(), '']),
    },
  );
  FIXTURES.push(
    { name: 'math-edge-bottom.md', text: edge(69, ['$$ \\int_0^1 f(x) \\, dx = F(1) - F(0) $$', '']) },
    { name: 'math-edge-top.md', text: edge(82, [frac, '']) },
    { name: 'math-edge-numbered.md', text: edge(147, ['$$ x $$', '']) },
    { name: 'math-edge-quote.md', text: edge(108, ['> ' + frac, '>', '> ' + FILLER.repeat(2).trim(), '']) },
    { name: 'math-edge-quote-mid.md', text: edge(121, ['> ' + frac, '>', '> ' + FILLER.repeat(2).trim(), '']) },
    {
      name: 'math-edge-grid.md',
      text: edge(30, [
        '::: {.columns gutter=1em}',
        '::: {.column}',
        frac,
        '',
        FILLER.trim(),
        ':::',
        '::: {.column}',
        FILLER.trim(),
        '',
        '$$ x^2 $$',
        ':::',
        ':::',
        '',
      ]),
    },
  );
  // A figure at a page's edge. Typst prints it as one unbreakable block at
  // paragraph spacing, its frame from the image's top to the caption's last
  // baseline (`figureBoxEm`): at a page's end it fits by that baseline
  // (bottom: at 23 % width it is the last thing on page 1), at a page's top
  // the image lands at the margin and the page after it is filled by its
  // full height (top: it opens page 2, and page 3 starts a line later than
  // the July box let it, 8.3 px taller than the print).
  const rect = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#38786d"/></svg>';
  const figure = (pct: number) => [`![A one-line caption.](data:image/svg+xml;base64,${Buffer.from(rect).toString('base64')}){width=${pct}%}`, ''];
  FIXTURES.push({ name: 'figure-edge-bottom.md', text: edge(44, figure(23)) }, { name: 'figure-edge-top.md', text: edge(60, figure(31)) });
}

function collect(target: string): string[] {
  const p = resolve(target);
  const st = statSync(p);
  if (st.isFile()) return [p];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (/\.(md|typ)$/i.test(name)) out.push(full);
    }
  };
  walk(p);
  return out.sort();
}

async function openText(page: Page, name: string, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(
    async ({ name, text }) => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      await window.__fm.loadHandle(h);
    },
    { name, text },
  );
  // The port must be up (first paragraph laid out by it, not the legacy
  // breaker), and pagination must have gone quiet.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          let pos = -1;
          window.view.state.doc.descendants((n, p) => {
            if (pos >= 0) return false;
            if (n.type.name === 'paragraph' && n.textContent.length > 40) pos = p;
            return pos < 0;
          });
          return pos < 0 ? 'none' : window.__blockAuthority(pos)?.authority ?? null;
        }),
      { timeout: 30_000, intervals: [250, 500, 1000] },
    )
    .toMatch(/port|none/);
  // Every formula, inline and display, has settled: its Typst ink arrived,
  // or the compiler said it will not (the report lists those). Pagination
  // can go quiet while formulas still sit at KaTeX's box.
  await expect
    .poll(() => page.evaluate(() => window.__mathInk().pending ?? 0), { timeout: 90_000, intervals: [250, 500, 1000] })
    .toBe(0);
  let last = -1;
  await expect
    .poll(
      async () => {
        const n = await page.evaluate(() => window.__pagCount());
        const stable = n === last;
        last = n;
        return stable;
      },
      { timeout: 30_000, intervals: [800] },
    )
    .toBe(true);
}

function describe(report: PortAuditReport): string {
  const s = report.summary;
  const lines = [
    `blocks ${s.blocks}: match ${s.match}, mismatch ${s.mismatch}, browser-mismatch ${s.browserMismatch}, typst-fail ${s.typstFail}, no-port ${s.noPort}` +
      ` | pages local ${report.pages.localCount} typst ${report.typst.pageCount} ${s.pagesAgree ? 'agree' : 'DIFFER'}` +
      ` | compile ${Math.round(report.compileMs)} ms, analyze ${Math.round(report.analyzeMs)} ms` +
      (s.unmeasuredAtoms ? ` | ${s.unmeasuredAtoms} formula(s) without a Typst width` : ''),
  ];
  for (const b of report.blocks.filter((b) => b.status === 'mismatch' || b.status === 'browser-mismatch' || b.status === 'typst-fail' || b.status === 'no-port')) {
    lines.push(
      `  ${b.status.padEnd(10)} ${b.type}@${b.pos} "${b.text}"` +
        (b.reason ? ` — ${b.reason}` : b.port ? ` port ${b.port} typst ${b.typst}` : '') +
        (b.unmeasured ? ` — formulas without a Typst width: ${b.unmeasured.join(', ')}` : ''),
    );
  }
  for (const c of report.chrome) lines.push(`  chrome page ${c.page + 1}: typst ${JSON.stringify(c.typst)} editor ${JSON.stringify(c.editor)}`);
  if (!s.pagesAgree) {
    const d = report.pages.firstDiff;
    lines.push(`  pages: first difference on page ${d?.firstDiffPage} (${d?.cause}) local ${JSON.stringify(d?.localStart)} typst ${JSON.stringify(d?.exactStart)}`);
    if (report.typst.status === 'fail') lines.push(`  typst pages partial: ${report.typst.reason}`);
  }
  return lines.join('\n');
}

const target = process.env.AUDIT;
const docs = target
  ? collect(target).map((p) => ({ name: basename(p), text: readFileSync(p, 'utf8'), path: p }))
  : FIXTURES.map((f) => ({ ...f, path: f.name }));

for (const doc of docs) {
  test(`port audit: ${doc.path}`, async ({ page }) => {
    test.setTimeout(180_000);
    await openText(page, doc.name, doc.text);
    const report = await page.evaluate(() => window.__audit());
    expect(report, 'Typst compile failed').not.toBeNull();
    console.log(`AUDIT ${doc.path}\n${describe(report!)}`);
    if (!target) {
      expect(report!.summary.mismatch, 'port breaks differ from Typst').toBe(0);
      expect(report!.summary.browserMismatch, 'browser-laid breaks differ from Typst').toBe(0);
      expect(report!.summary.typstFail, 'blocks Typst could not be matched to').toBe(0);
      expect(report!.summary.pagesAgree, 'page starts differ from Typst').toBe(true);
      expect(report!.summary.chromeMismatch, 'page chrome differs from Typst').toBe(0);
      expect(report!.summary.unmeasuredAtoms, 'formulas Typst never measured').toBe(0);
    }
  });
}
