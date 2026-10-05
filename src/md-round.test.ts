// Markdown import/export (docs/MARKDOWN-FORMAT.md): every form reads into
// the model, writes back, and converges (md1 === md2); the fixtures under
// tests/fixtures/md all parse and converge; and a Markdown trip changes
// nothing the compiler sees beyond the drops a document declares.
// Run: npx tsx src/md-round.test.ts
import { readFileSync, readdirSync } from 'node:fs';
import type { Node as PMNode } from 'prosemirror-model';
import { mdToDoc } from './md-parser';
import { docToMd } from './md-serializer';
import { docToTyp } from './typ-serializer';
import { typToDoc } from './typ-parser';
import { demoDoc } from './demo-doc';
import { DEFAULT_SETTINGS } from './settings';
import { schema } from './schema';
import * as F from './typ-fixtures';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

function firstDiff(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return `line ${i + 1}:\n  a: ${JSON.stringify(al[i])}\n  b: ${JSON.stringify(bl[i])}`;
  }
  return '';
}

/** Read, write, read, write: the doc, its warnings, both writes. */
function trip(md: string) {
  const first = mdToDoc(md);
  const written: string[] = [];
  const md1 = docToMd(first.doc, (w) => written.push(w));
  const second = mdToDoc(md1);
  const md2 = docToMd(second.doc);
  return { doc: first.doc, warnings: first.warnings, written, md1, md2, doc2: second.doc, converges: md1 === md2 };
}

const kinds = (doc: PMNode) => {
  const out: string[] = [];
  doc.forEach((n) => out.push(n.type.name + (n.type.name === 'code_block' && n.attrs.params ? `:${n.attrs.params as string}` : '')));
  return out;
};

function find(doc: PMNode, pred: (n: PMNode) => boolean): PMNode | null {
  let hit: PMNode | null = null;
  doc.descendants((n) => {
    if (!hit && pred(n)) hit = n;
    return !hit;
  });
  return hit;
}
const all = (doc: PMNode, pred: (n: PMNode) => boolean): PMNode[] => {
  const out: PMNode[] = [];
  doc.descendants((n) => {
    if (pred(n)) out.push(n);
    return true;
  });
  return out;
};

const SRC = `---
title: "Voting Notes"
author: "Taylor J. Weidman"
keywords: "voting, econ"
---

# Introduction

This is **bold**, *italic*, ~~struck~~, and \`code\`, with math $a_C^2$ inline and a
[link](https://example.org) plus a citation [@arrow1950] and a reference
@eq:main. A footnote[^1] too.

$$
\\Pi_{A,B,C} = x^2
$$ {#eq:main}

## Lists

- first item
- second item

1. one
2. two

> A quoted remark.

| Left | Right |
| --- | ---: |
| a | 1 |
| b | 2 |

\`\`\`python
print("hi")
\`\`\`

\`\`\`{=typst}
#pagebreak()
\`\`\`

\`\`\`typst
#let x = 1
\`\`\`

---

Closing paragraph with a minus −3 and an em dash — here.

[^1]: The footnote body.

\`\`\`{=bibtex}
@article{arrow1950, title={A Difficulty}}
\`\`\`
`;

const first = mdToDoc(SRC);
const doc = first.doc;

// structural spot checks
const types: string[] = [];
doc.forEach((n) => types.push(n.type.name + (n.attrs.level ? n.attrs.level : '')));
check('front matter + blocks', types[0] === 'doc_title' && types[1] === 'doc_authors', JSON.stringify(types));
check('heading levels', types.includes('heading1') && types.includes('heading2'), JSON.stringify(types));
check('display math with label', !!find(doc, (n) => n.type.name === 'math_display' && n.attrs.label === 'eq:main' && /Pi_/.test(n.attrs.src as string)));
check('unknown frontmatter kept, not reported', doc.attrs.frontmatter === 'keywords: "voting, econ"' && !first.warnings.some((w) => /keywords/.test(w)), JSON.stringify([doc.attrs.frontmatter, first.warnings]));
check('a {=bibtex} fence is the bibliography, where it stands', /arrow1950/.test((doc.attrs.bib as { content: string })?.content ?? '') && doc.lastChild!.type.name === 'bibliography');
check('inline pieces', (() => {
  let cite = false, ref = false, math = false, fn = false, link = false;
  doc.descendants((n) => {
    if (n.type.name === 'citation' && n.attrs.key === 'arrow1950') cite = true;
    if (n.type.name === 'eq_ref' && n.attrs.label === 'eq:main') ref = true;
    if (n.type.name === 'math_inline' && n.attrs.src === 'a_C^2') math = true;
    if (n.type.name === 'footnote' && /footnote body/.test(n.textContent)) fn = true;
    if (n.isText && n.marks.some((m) => m.type.name === 'link')) link = true;
    return true;
  });
  return cite && ref && math && fn && link;
})());
check('strikethrough becomes a mark', !!find(doc, (n) => n.isText && n.text === 'struck' && n.marks.some((m) => m.type.name === 'strike')));
check('literal ~~ in plain text stays literal', (() => {
  const { doc: d } = mdToDoc(docToMd(mdToDoc('tildes \\~~ here').doc));
  return !!find(d, (n) => n.isText && !!n.text?.includes('~~') && !n.marks.some((m) => m.type.name === 'strike'));
})());
check('table shape', !!find(doc, (n) => n.type.name === 'table' && n.childCount === 3));
check('a {=typst} fence is the raw-Typst island', !!find(doc, (n) => n.type.name === 'code_block' && n.attrs.params === 'typst-raw' && /pagebreak/.test(n.textContent)));
check('a typst fence is a code listing', !!find(doc, (n) => n.type.name === 'code_block' && n.attrs.params === 'typst' && n.textContent === '#let x = 1'));

// round trip: md -> doc -> md -> doc -> md must be stable
const md1 = docToMd(doc);
{
  // A markdown space before an inline footnote never prints (Typst's marker
  // swallows it), so import drops it and the round-trip stays stable.
  const { doc: d } = mdToDoc('Word ^[inline note] after.\n');
  const p = find(d, (n) => n.type.name === 'paragraph')!;
  check(
    'import drops the space before a footnote marker',
    p.child(0).text === 'Word' && p.child(1).type.name === 'footnote' && p.child(2).text === ' after.',
    JSON.stringify(p.toJSON()),
  );
  const again = mdToDoc(docToMd(d)).doc;
  check('footnote-glued paragraph round-trips', docToMd(again) === docToMd(d), docToMd(d));
}

{
  // Block offsets: where each top-level block starts in the Markdown text,
  // frontmatter excluded; blocks with no Markdown of their own point at
  // what follows them.
  const { doc: d } = mdToDoc(SRC);
  const offsets: number[] = [];
  const md = docToMd(d, () => {}, offsets);
  check('md offsets do not change the output', md === docToMd(d));
  check('one md offset per top-level block', offsets.length === d.childCount, `${offsets.length} vs ${d.childCount}`);
  check('md offsets are non-decreasing', offsets.every((o, i) => i === 0 || o >= offsets[i - 1]));
  let mismatches = '';
  d.forEach((node, _o, i) => {
    const at = md.slice(offsets[i], offsets[i] + 40);
    const want =
      node.type.name === 'heading'
        ? '#'.repeat(node.attrs.level as number) + ' '
        : node.type.name === 'paragraph'
          ? node.textContent.slice(0, 6)
          : null;
    if (want !== null && !at.startsWith(want)) mismatches += `\n  block ${i} ${node.type.name}: ${JSON.stringify(at)} !~ ${JSON.stringify(want)}`;
  });
  check('each md heading/paragraph offset lands on its own markup', mismatches === '', mismatches);
}

const second = mdToDoc(md1);
const md2 = docToMd(second.doc);
check('round-trip converges', md1 === md2, firstDiff(md1, md2));
check('round-trip keeps doc shape', second.doc.childCount === doc.childCount, `${doc.childCount} vs ${second.doc.childCount}`);

// Inline math inside a bold/italic span stays inside the span (Typst's
// strong emboldens math, so the run must survive as one span).
{
  const md = 'Have **$2$ drinks** now, *and $x$ too*.\n';
  const out = docToMd(mdToDoc(md).doc);
  check('bold math keeps its span in Markdown', out.trim() === md.trim(), out);
  const p = mdToDoc(md).doc.firstChild!;
  let bold = false;
  p.forEach((n) => { if (n.type.name === 'math_inline' && n.attrs.src === '2') bold = n.marks.some((m) => m.type.name === 'strong'); });
  check('markdown import marks math inside bold', bold);
}

// Nothing Markdown says is stripped on the way through the page view.
{
  const fm = '---\ntitle: "T"\nauthor:\n  - Alice\n  - Bob\nkeywords: [a, b]\nabstract: |\n  Two lines\n  of it\n---\n\nBody.\n';
  const { doc, warnings } = mdToDoc(fm);
  check('unknown and block frontmatter is kept verbatim', doc.attrs.frontmatter === 'author:\n  - Alice\n  - Bob\nkeywords: [a, b]\nabstract: |\n  Two lines\n  of it', JSON.stringify(doc.attrs.frontmatter));
  check('kept frontmatter raises no warning', warnings.length === 0, warnings.join('; '));
  const out = docToMd(doc);
  check('kept frontmatter is written back', out === fm, out);

  const code = 'Para.\n\n    indented one\n    indented two\n\nAfter.\n';
  const outCode = docToMd(mdToDoc(code).doc);
  check('indented code survives as a fence', outCode === 'Para.\n\n```\nindented one\nindented two\n```\n\nAfter.\n', outCode);

  const link = 'A [link](http://x.y "The \\"title\\"") here.\n';
  const outLink = docToMd(mdToDoc(link).doc);
  check('link titles survive', outLink === link, outLink);

  // An item with a blank line inside makes the whole list loose
  // (CommonMark), so the save writes the blank line between the items too.
  const list = '1. one\n2. two\n\n   para in item\n\n   - nested\n';
  const outList = docToMd(mdToDoc(list).doc);
  check('list continuation hangs under the marker once', outList === '1. one\n\n2. two\n\n   para in item\n\n   - nested\n', outList);
  const tightNested = '- a\n  - b\n- c\n';
  check('a tight list keeps its sublist tight', docToMd(mdToDoc(tightNested).doc) === tightNested, docToMd(mdToDoc(tightNested).doc));
}

// Every HTML comment is an editorial comment: kept in the file, shown as a
// strip, absent from the print. A comment inside a block moves out of it.
// Any other HTML block is an island, shown and printed as code.
{
  const md = [
    'Para one.',
    '',
    '<!-- ED: MOVED (2026-09-01) -- keep A3\'s closer pure — see chat. Marked {++stitches++} only. -->',
    '',
    '<div style="margin-top: -70px;"></div>',
    '',
    '- item',
    '',
    '  <!-- inside a list item -->',
    '',
    'Para two with {++an insertion++} and ~~a strike~~.',
    '',
  ].join('\n');
  const { doc, warnings } = mdToDoc(md);
  check('comments are notes, the <div> an island', JSON.stringify(kinds(doc)) === JSON.stringify(['paragraph', 'editor_comment', 'code_block:md-raw', 'bullet_list', 'editor_comment', 'paragraph']), JSON.stringify(kinds(doc)));
  check('a comment keeps its dashes and quotes verbatim', doc.child(1).textContent === 'ED: MOVED (2026-09-01) -- keep A3\'s closer pure — see chat. Marked {++stitches++} only.', doc.child(1).textContent);
  check('the list item\'s comment moved after the list, and says so', doc.child(4).textContent === 'inside a list item' && warnings.length === 1 && /1 comment\(s\) moved out of nested blocks/.test(warnings[0]), warnings.join('; '));
  const out = docToMd(doc);
  const want = md.replace('- item\n\n  <!-- inside a list item -->', '- item\n\n<!-- inside a list item -->');
  check('the file is written back with the comment hoisted', out === want, firstDiff(out, want));
  check('the hoisted file is canonical', docToMd(mdToDoc(out).doc) === out && mdToDoc(out).warnings.length === 0);
  const typ = docToTyp(doc, { islands: 'print' });
  check('the print holds no comment', !typ.includes('ED: MOVED') && !typ.includes('inside a list item'), typ);
  check('the <div> island prints as a raw block, never runs', typ.includes('```\n<div style') && (typ.match(/^<div/gm) ?? []).length === (typ.match(/```\n<div/g) ?? []).length, typ);
  check('critic marks survive as text', out.includes('{++an insertion++}') && out.includes('~~a strike~~'), out);
}

// Heading levels 4–6 are real levels: kept on import, written back.
{
  const md = '#### Four\n\n##### Five\n\n###### Six\n';
  const { doc, warnings } = mdToDoc(md);
  const levels: number[] = [];
  doc.forEach((n) => levels.push(n.attrs.level as number));
  check('h4–h6 keep their level', JSON.stringify(levels) === '[4,5,6]' && warnings.length === 0, JSON.stringify([levels, warnings]));
  check('h4–h6 round-trip', docToMd(doc) === md, docToMd(doc));
}

// Inline HTML is an inline island; an inline comment moves out of its
// paragraph; image titles are carried.
{
  const md = 'Water is H<sub>2</sub>O <!-- inline note -- keep --> and <span class="x">x</span>.\n\n![A figure](fig.png "Its title")\n';
  const { doc, warnings } = mdToDoc(md);
  const inline: string[] = [];
  doc.firstChild!.forEach((n) => inline.push(n.type.name + (n.type.name === 'typst_inline' ? `:${n.attrs.lang}` : '')));
  check('inline HTML becomes inline islands', inline.filter((k) => k === 'typst_inline:html').length === 4, JSON.stringify(inline));
  check('the inline comment is a note after its paragraph', JSON.stringify(kinds(doc)) === '["paragraph","editor_comment","figure"]' && doc.child(1).textContent === 'inline note -- keep' && warnings.length === 1, JSON.stringify([kinds(doc), warnings]));
  check('the gap the comment left closes to one space', doc.firstChild!.textContent === 'Water is H2O and x.', JSON.stringify(doc.firstChild!.textContent));
  const want = 'Water is H<sub>2</sub>O and <span class="x">x</span>.\n\n<!-- inline note -- keep -->\n\n![A figure](fig.png "Its title")\n';
  check('inline HTML and image titles round-trip', docToMd(doc) === want, firstDiff(docToMd(doc), want));
  check('an inline HTML island prints as inline raw', docToTyp(doc, { islands: 'print' }).includes('#raw("<sub>")'), docToTyp(doc));
}

// Fill-in blanks, brackets, and an HTML element's spacing come back as
// written.
{
  const blank = 'Between \\_________\\_ and \\_________\\_ per unit.\n';
  const { doc } = mdToDoc(blank);
  check('an underscore run is text, not emphasis', doc.firstChild!.textContent === 'Between __________ and __________ per unit.', JSON.stringify(doc.firstChild!.textContent));
  const out = docToMd(doc);
  check('an underscore run round-trips through escapes', mdToDoc(out).doc.firstChild!.textContent === doc.firstChild!.textContent && docToMd(mdToDoc(out).doc) === out, out);
  check('a bracketed note stays bare', docToMd(mdToDoc('[To be developed] and a [b] c\n').doc) === '[To be developed] and a [b] c\n', docToMd(mdToDoc('[To be developed] and a [b] c\n').doc));
  {
    // Literal text that only looks like a link or footnote reference stays
    // text through a save and a reload.
    const lit = 'x \\[a\\](b) and \\[^n] here\n';
    const out = docToMd(mdToDoc(lit).doc);
    const again = mdToDoc(out).doc;
    const links = all(again, (n) => n.isText && n.marks.some((m) => m.type.name === 'link')).length;
    const notes = all(again, (n) => n.type.name === 'footnote').length;
    check('a would-be link or footnote stays literal text', links === 0 && notes === 0 && again.textContent === 'x [a](b) and [^n] here' && docToMd(again) === out, out);
  }
  // A comment directly against its neighbours is a note with blank lines
  // around it after the first save; an HTML element keeps its spacing.
  const tight = '# Title\n<!-- from extract: filed by hand -->\n\nBody.\n\n<!-- ED: note -->\nNext para.\n';
  const t = mdToDoc(tight).doc;
  check('comments against their neighbours are notes', JSON.stringify(kinds(t)) === '["heading","editor_comment","paragraph","editor_comment","paragraph"]', JSON.stringify(kinds(t)));
  check('the first save puts blank lines around a comment', docToMd(t) === '# Title\n\n<!-- from extract: filed by hand -->\n\nBody.\n\n<!-- ED: note -->\n\nNext para.\n', docToMd(t));
  const element = '# Title\n<div class="x">kept</div>\n\nBody.\n';
  const e = mdToDoc(element).doc;
  check('an HTML element records its spacing', e.child(1).attrs.tight === 'before', JSON.stringify(e.child(1).attrs));
  check('an HTML element\'s spacing round-trips byte for byte', docToMd(e) === element, docToMd(e));
  const offsets: number[] = [];
  const md = docToMd(e, () => {}, offsets);
  check('offsets follow tight joins', md.slice(offsets[1], offsets[1] + 4) === '<div', JSON.stringify(offsets));
  const inComment = 'Para.\n\n<!-- keep ___ and $x$ and *stars* verbatim -->\n';
  check('nothing inside a comment is touched', docToMd(mdToDoc(inComment).doc) === inComment, docToMd(mdToDoc(inComment).doc));
}

{
  // Item pitch: blank lines between items make a loose list (paragraph
  // spacing); the flag rides the list node and comes back out as the
  // blank lines. A tight list stays tight.
  const loose = '- one\n\n- two\n\n- three\n';
  const tight = '- one\n- two\n- three\n';
  const ld = mdToDoc(loose).doc;
  const td = mdToDoc(tight).doc;
  check('a list with blank lines between items is loose', ld.firstChild!.attrs.tight === false, JSON.stringify(ld.firstChild!.attrs));
  check('a list without blank lines is tight', td.firstChild!.attrs.tight === true, JSON.stringify(td.firstChild!.attrs));
  check('a loose list round-trips with its blank lines', docToMd(ld) === loose, docToMd(ld));
  check('a tight list round-trips without them', docToMd(td) === tight, docToMd(td));
  const nested = '1. one\n\n   - a\n   - b\n\n2. two\n';
  const nd = mdToDoc(nested).doc;
  check('looseness is per list: loose outer, tight inner', nd.firstChild!.attrs.tight === false && nd.firstChild!.child(0).child(1).attrs.tight === true, JSON.stringify([nd.firstChild!.attrs, nd.firstChild!.child(0).child(1).attrs]));
  check('nested pitch round-trips', docToMd(nd) === nested, docToMd(nd));
  const typ = docToTyp(ld);
  check('a loose list exports with Typst blank lines and its own item pitch', /#set list\(spacing: [\d.]+pt\)\n- one\n\n- two\n\n- three\n#set list\(spacing: [\d.]+pt\)\n/.test(typ), typ);
}

// Grids: one `.columns` div per row, `.column` cells, later rows
// `.continued`; shares canonical (each over the smallest).
{
  const md = 'Intro.\n\n:::: {.columns gutter=1em}\n\n::: {.column width=66.667%}\n\nLeft text.\n\n:::\n\n::: {.column width=33.333%}\n\nRight text.\n\n:::\n\n::::\n\nAfter.\n';
  const { doc, warnings } = mdToDoc(md);
  check('a .columns div is a native grid', JSON.stringify(kinds(doc)) === '["paragraph","grid","paragraph"]' && !warnings.length, JSON.stringify([kinds(doc), warnings]));
  check('the grid keeps its shares and cells', JSON.stringify(doc.child(1).attrs.columns) === '[2,1]' && doc.child(1).attrs.gutter === 1 && doc.child(1).child(0).child(1).textContent === 'Right text.', JSON.stringify(doc.child(1).toJSON()));
  check('a grid round-trips byte for byte', docToMd(doc) === md, firstDiff(docToMd(doc), md));
  const grid = (body: string) => mdToDoc(body).doc.firstChild!;
  const cols = (w: string[], gutter = '1em') => `:::: {.columns gutter=${gutter}}\n\n${w.map((x, k) => `::: {.column${x ? ` width=${x}` : ''}}\n\ncell ${k}\n\n:::`).join('\n\n')}\n\n::::\n`;
  check('[2,2] reads as equal shares and writes no width', JSON.stringify(grid(cols(['2fr', '2fr'])).attrs.columns) === '[1,1]' && !docToMd(mdToDoc(cols(['2fr', '2fr'])).doc).includes('width'));
  check('[60,40] reads as [1.5,1] and writes 60%/40%', JSON.stringify(grid(cols(['60%', '40%'])).attrs.columns) === '[1.5,1]' && docToMd(mdToDoc(cols(['60%', '40%'])).doc).includes('width=60%') && docToMd(mdToDoc(cols(['60%', '40%'])).doc).includes('width=40%'));
  check('[1,2] written as 33.333%/66.667% reads back as [1,2]', JSON.stringify(grid(cols(['33.333%', '66.667%'])).attrs.columns) === '[1,2]');
  check('[1.5,1] as bare numbers', JSON.stringify(grid(cols(['1.5', '1'])).attrs.columns) === '[1.5,1]');
  check('a point gutter converts to em at the font size', grid(cols(['', ''], '12.5pt')).attrs.gutter === 1, JSON.stringify(grid(cols(['', ''], '12.5pt')).attrs));
  const two = cols(['', '']) + '\n' + cols(['', '']).replace('{.columns ', '{.columns .continued ');
  const g2 = mdToDoc(two).doc;
  check('a .continued row joins the grid before it', g2.childCount === 1 && g2.firstChild!.childCount === 2, JSON.stringify(kinds(g2)));
  check('a two-row grid writes its second row .continued', docToMd(g2).includes(':::: {.columns .continued gutter=1em}') && trip(two).converges);
  const pair = cols(['', '']) + '\n' + cols(['', '']);
  check('two adjacent equal grids stay two grids', JSON.stringify(kinds(mdToDoc(pair).doc)) === '["grid","grid"]' && trip(pair).converges);
  const ragged = cols(['', '']) + '\n' + cols(['', '', '']).replace('{.columns ', '{.columns .continued ');
  const r = mdToDoc(ragged);
  check('a .continued row of another width warns and is refit', r.warnings.some((w) => /has 3 cell\(s\) where its grid has 2/.test(w)) && r.doc.firstChild!.childCount === 3 && r.doc.firstChild!.child(2).childCount === 2, JSON.stringify([r.warnings, r.doc.firstChild!.childCount]));
  const fence = 'Intro.\n\n```typst\n#grid(\n  columns: (2fr, 1fr),\n  [a],\n  [b],\n)\n```\n';
  const f = mdToDoc(fence).doc;
  check('a typst fence holding a grid is a code listing', f.child(1).type.name === 'code_block' && f.child(1).attrs.params === 'typst' && docToMd(f) === fence, docToMd(f));
}

// Image sizes and table geometry are representable now: no warnings.
{
  const image = schema.nodes.image.create({ src: 'axes.svg', alt: 'Axes [graph]', title: 'Demand', widthPct: 75 });
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('Before '), image, schema.text(' after.')]));
  const warnings: string[] = [];
  const md = docToMd(doc, (warning) => warnings.push(warning));
  check('inline images keep alt, title and width in Markdown', md.includes('Before ![Axes \\[graph\\]](axes.svg "Demand"){width=75%} after.') && !warnings.length, md + warnings.join('; '));
  const back = find(mdToDoc(md).doc, (n) => n.type.name === 'image');
  check('an inline image reads back the same', JSON.stringify(back?.attrs) === JSON.stringify(image.attrs), JSON.stringify(back?.attrs));
  const table = schema.nodes.table.create({ columnWidths: ['1fr'], insetPt: 9 }, schema.nodes.table_row.create(null,
    schema.nodes.table_header.create({ valign: 'middle', fill: 'gray-dark' }, schema.nodes.paragraph.create(null, schema.text('A')))));
  const tableWarnings: string[] = [];
  const tmd = docToMd(schema.nodes.doc.create(null, table), (warning) => tableWarnings.push(warning));
  check('table geometry rides on the .table div, with no warning', !tableWarnings.length && tmd.includes('inset=9pt') && tmd.includes('columns=1fr') && tmd.includes('valign=middle') && tmd.includes('fills=r0:gray-dark'), tmd + tableWarnings.join('; '));
  check('the table reads back exactly', JSON.stringify(mdToDoc(tmd).doc.firstChild!.toJSON()) === JSON.stringify(table.toJSON()), JSON.stringify(mdToDoc(tmd).doc.firstChild!.toJSON()));
}

// Math: wrapped inline math is one formula; display math splits a
// paragraph and takes its attributes on the closing line or the next.
{
  const wrapped = mdToDoc('Math $a +\nb$ here.\n').doc;
  const math = all(wrapped, (n) => n.type.name === 'math_inline');
  check('$a +\\nb$ is one formula', math.length === 1 && math[0].attrs.src === 'a +\nb', JSON.stringify(math.map((m) => m.attrs.src)));
  check('a wrapped formula writes on one line and converges', trip('Math $a +\nb$ here.\n').converges && trip('Math $a +\nb$ here.\n').md1 === 'Math $a + b$ here.\n');
  const quoted = mdToDoc('> A $c +\n> d$ e.\n').doc;
  check('a formula wraps through a quote marker', find(quoted, (n) => n.type.name === 'math_inline')?.attrs.src === 'c +\nd');
  const items = mdToDoc('- x $a\n- b$ y\n').doc;
  check('a formula never runs into the next list item', !find(items, (n) => n.type.name === 'math_inline'), JSON.stringify(items.toJSON()));
  const split = mdToDoc('The supply relationship is\n$$\nP = 10 - Q\n$$\nand the rest follows.\n');
  check('display math after text splits the paragraph', JSON.stringify(kinds(split.doc)) === '["paragraph","math_display","paragraph"]' && split.doc.child(1).attrs.src === 'P = 10 - Q' && split.doc.child(2).textContent === 'and the rest follows.', JSON.stringify(split.doc.toJSON()));
  check('no sentinel leaks out of a split paragraph', !/\uE000/.test(JSON.stringify(split.doc.toJSON())));
  const attrs = mdToDoc('$$\nx\n$$ {#eq:a .unnumbered}\n\n$$\ny\n$$\n{#eq:b}\n\n$$ z $$ {.numbered}\n\nA $$w$$ mid-line.\n').doc;
  const eq = all(attrs, (n) => n.type.name === 'math_display').map((n) => [n.attrs.src, n.attrs.label, n.attrs.numbered]);
  check('display attributes: closing line, next line, numbering, mid-line', JSON.stringify(eq) === JSON.stringify([['x', 'eq:a', false], ['y', 'eq:b', null], ['z', '', true], ['w', '', null]]), JSON.stringify(eq));
  check('display math round-trips', trip('$$\nx\n$$ {#eq:a .unnumbered}\n\n$$\ny\n$$ {.numbered}\n').md1 === '$$\nx\n$$ {#eq:a .unnumbered}\n\n$$\ny\n$$ {.numbered}\n');
  const quotes = mdToDoc('He said "a\n$$\nx\n$$\nb" then.\n').doc;
  check(
    'each piece of a split paragraph is smartened on its own (a fresh quote state, as its own Typst paragraph)',
    quotes.child(0).textContent === 'He said “a' && quotes.child(2).textContent === mdToDoc('b" then.\n').doc.firstChild!.textContent,
    JSON.stringify([quotes.child(0).textContent, quotes.child(2).textContent]),
  );
  const cell = mdToDoc('| $x|y$ | `a|b` |\n| --- | --- |\n| 1 | 2 |\n').doc.firstChild!;
  check('math and code spans keep their pipes in a cell', cell.childCount === 2 && cell.child(0).childCount === 2 && find(cell, (n) => n.type.name === 'math_inline')?.attrs.src === 'x|y' && cell.child(0).child(1).textContent === 'a|b', JSON.stringify(cell.toJSON()));
  const text = mdToDoc('$\\text{a $ b}|c$ and $a\\$b$.\n').doc;
  check('pandoc\'s math rule: \\text{…$…} and \\$ inside math', JSON.stringify(all(text, (n) => n.type.name === 'math_inline').map((n) => n.attrs.src)) === JSON.stringify(['\\text{a $ b}|c', 'a\\$b']));
  check('a dollar before a digit is prose', !find(mdToDoc('Costs $5 and $6.\n').doc, (n) => n.type.name === 'math_inline'));
}

// Pandoc's sub/superscript and citation marks typed by hand converge: the
// save escapes them, and the escaped forms read back as the characters.
{
  for (const [src, text] of [['H~2~O', 'H~2~O'], ['x^2^', 'x^2^'], ['note^[x]', 'note']] as const) {
    const t = trip(src + '\n');
    check(`${src} converges`, t.converges && t.doc.firstChild!.textContent.startsWith(text), JSON.stringify([t.md1, t.md2]));
  }
  const at = trip('follow @plass and mail a@b.org, or \\@plass.\n');
  check('bare @plass is a citation, an email and \\@plass are text', all(at.doc, (n) => n.type.name === 'citation').length === 1 && at.doc.firstChild!.textContent.includes('a@b.org') && at.doc.firstChild!.textContent.endsWith('@plass.'), at.md1);
  check('an escaped @ stays escaped through a save', at.md1 === 'follow [@plass] and mail a@b.org, or \\@plass.\n' && at.converges, at.md1);
  const sub = trip('Water is H\\~2\\~O and x\\^2\\^ and note\\^[x].\n');
  check('the written escapes read back as the characters', sub.doc.firstChild!.textContent === 'Water is H~2~O and x^2^ and note^[x].' && sub.md1 === 'Water is H\\~2\\~O and x\\^2\\^ and note\\^[x].\n', sub.md1);
}

// Citations: pandoc's group grammar; a namespaced key is a reference.
{
  const p = mdToDoc('A [see @c, p. 3] b [@a; @b] c [-@a] d @s [p. 33] e [@eq:x] and @fig:y.\n').doc.firstChild!;
  const atoms = all(p, (n) => n.type.name === 'citation' || n.type.name === 'eq_ref').map((n) => `${n.type.name}:${(n.attrs.key ?? n.attrs.label) as string}`);
  check('every key is a node, namespaced keys references', JSON.stringify(atoms) === JSON.stringify(['citation:c', 'citation:a', 'citation:b', 'citation:a', 'citation:s', 'eq_ref:eq:x', 'eq_ref:fig:y']), JSON.stringify(atoms));
  check('prefix, suffix and the suppressed author stay as text', p.textContent === 'A see , p. 3 b  c - d  [p. 33] e  and .', JSON.stringify(p.textContent));
  const t = trip('Two [@a; @b] and [@eq:x] and @eq:y.5 and x[@c].\n');
  check('adjacent citations are written as one group; a key runs on through .5 (pandoc)', t.md1 === 'Two [@a; @b] and @eq:x and @eq:y.5 and x[@c].\n' && t.converges && !!find(t.doc, (n) => n.attrs.label === 'eq:y.5'), t.md1);
  const glued = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('see'), schema.nodes.eq_ref.create({ label: 'eq:y' }), schema.text('.5 and '), schema.nodes.eq_ref.create({ label: 'eq:z' }), schema.text('.')]));
  const gm = docToMd(glued);
  check('a reference glued to a word or a key character is bracketed', gm === 'see[@eq:y].5 and @eq:z.\n' && JSON.stringify(mdToDoc(gm).doc.toJSON().content) === JSON.stringify(glued.toJSON().content), gm);
  const group = mdToDoc('[@a][x](u)').doc.firstChild!;
  check('a citation before a link stays a citation', all(group, (n) => n.type.name === 'citation').length === 1);
  check('a citation followed by ( is escaped', trip('See [@a] (2020).\n').md1 === 'See [@a] (2020).\n' && docToMd(schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.nodes.citation.create({ key: 'a' }), schema.text('(x)')]))) === '[@a]\\(x)\n');
}

// Figures and images by pandoc's alt rule; SVG data URLs survive.
{
  const svg = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';
  const md = `![The frontier](${svg}){#fig:f width=60%}\n\n![](${svg}){#fig:g}\n\n![](${svg}){width=40%}\n\nInline ![x](${svg}) image.\n`;
  const { doc } = mdToDoc(md);
  check('captioned → figure; labeled → figure; bare → image in a paragraph', JSON.stringify(kinds(doc)) === '["figure","figure","paragraph","paragraph"]' && doc.child(2).firstChild!.type.name === 'image', JSON.stringify(kinds(doc)));
  check('the figure keeps label, width, caption and its SVG data URL', doc.child(0).attrs.label === 'fig:f' && doc.child(0).attrs.widthPct === 60 && doc.child(0).textContent === 'The frontier' && doc.child(0).attrs.src === svg, JSON.stringify(doc.child(0).attrs));
  check('the bare image keeps its width', doc.child(2).firstChild!.attrs.widthPct === 40);
  check('figures and images round-trip byte for byte', docToMd(doc) === md, firstDiff(docToMd(doc), md));
  const plain = schema.nodes.doc.create(null, [schema.nodes.figure.create({ src: 'a.svg' }), schema.nodes.figure.create({ src: 'b.svg', label: 'fig:figure-1' })]);
  const pm = docToMd(plain);
  check('an uncaptioned, unlabeled figure keeps a made-up label (its only Markdown form)', pm === '![](a.svg){#fig:figure-2}\n\n![](b.svg){#fig:figure-1}\n' && JSON.stringify(kinds(mdToDoc(pm).doc)) === '["figure","figure"]', pm);
  const lone = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.nodes.image.create({ src: 'a.svg', alt: 'An icon' })));
  const lm = docToMd(lone);
  check('a lone image with alt text stays an image, not a figure', lm === '![An icon](a.svg)\u00a0\n' && mdToDoc(lm).doc.firstChild!.type.name === 'paragraph' && trip(lm).converges, JSON.stringify(lm));
  const width = mdToDoc('![](a.svg){width=3in}\n');
  check('a non-percent width warns and is dropped', width.warnings.some((w) => /width "3in"/.test(w)) && width.doc.firstChild!.firstChild!.attrs.widthPct === null);
}

// Divs: solution, aligned and kept paragraphs, unknown classes, tables.
{
  const sol = trip('::: {.solution}\n\nThe answer.\n\n:::\n');
  check('::: {.solution} is the solution block, written ::: solution', sol.doc.firstChild!.attrs.kind === 'solution' && sol.md1 === '::: solution\n\nThe answer.\n\n:::\n', sol.md1);
  const align = trip('::: {.keep .center}\n\nHeld.\n\n:::\n\n::: right\n\nSigned.\n\n:::\n');
  check('center/right/keep set the paragraph\'s attrs', align.doc.child(0).attrs.keep === true && align.doc.child(0).attrs.align === 'center' && align.doc.child(1).attrs.align === 'right' && align.converges, align.md1);
  const two = mdToDoc('::: center\n\nOne.\n\nTwo.\n\n:::\n');
  check('an align div holding two paragraphs is kept as source, with a warning', two.doc.firstChild!.attrs.params === 'md-raw' && two.doc.firstChild!.textContent === '::: center\n\nOne.\n\nTwo.\n\n:::' && two.warnings.length === 1, JSON.stringify([two.doc.toJSON(), two.warnings]));
  const unknown = '::: {.callout-note}\n\n<!-- a note -->\n\nText with $x$ and `c`.\n\n::: inner\n\nNested.\n\n:::\n\n:::\n';
  const u = mdToDoc(unknown);
  check('an unknown div is one island of its own source', JSON.stringify(kinds(u.doc)) === '["editor_comment","code_block:md-raw"]' && u.doc.child(1).textContent === '::: {.callout-note}\n\nText with $x$ and `c`.\n\n::: inner\n\nNested.\n\n:::\n\n:::', JSON.stringify(u.doc.toJSON()));
  check('the comment inside it moved out and is not printed', u.doc.child(0).textContent === 'a note' && !docToTyp(u.doc, { islands: 'print' }).includes('a note') && trip(unknown).converges);
  const extra = mdToDoc('::: {.solution color=red}\n\nRed.\n\n:::\n');
  check('an attribute a known div has no use for is dropped with a warning', extra.doc.firstChild!.attrs.kind === 'solution' && extra.warnings.some((w) => /color/.test(w)), extra.warnings.join('; '));
  const glued = mdToDoc('Text.\n::: solution\n\nA.\n\n:::\n');
  check('an opener right after text is read, with a warning', glued.doc.child(1).attrs.kind === 'solution' && glued.warnings.some((w) => /add a blank line/.test(w)), glued.warnings.join('; '));
  const afterBreak = mdToDoc('\\newpage\n::: solution\n\nA.\n\n:::\n');
  check('an opener right after \\newpage is not glued (pandoc opens it there)', JSON.stringify(kinds(afterBreak.doc)) === '["page_break","blockquote"]' && !afterBreak.warnings.length, JSON.stringify([kinds(afterBreak.doc), afterBreak.warnings]));
  const open = mdToDoc('::: solution\n\nNever closed.\n');
  check('an unclosed div runs to the end, with a warning', open.doc.firstChild!.attrs.kind === 'solution' && open.warnings.some((w) => /no closing/.test(w)) && docToMd(open.doc) === '::: solution\n\nNever closed.\n\n:::\n');
  const tbl = trip('::: {#tbl:t .table caption="It\'s -- here"}\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n\n:::\n');
  const tn = tbl.doc.firstChild!;
  check('a .table div gives the table its label and caption, in printed form', tn.type.name === 'table' && tn.attrs.label === 'tbl:t' && tn.attrs.caption === 'It’s – here' && tbl.converges, JSON.stringify(tn.attrs));
  const cap = trip('| A |\n|---|\n| 1 |\n\n: A caption line\n');
  check('a caption line after a table is its caption', cap.doc.childCount === 1 && cap.doc.firstChild!.attrs.caption === 'A caption line' && cap.converges, JSON.stringify(cap.doc.toJSON()));
  const before = mdToDoc(': Caption before\n\n| A |\n|---|\n| 1 |\n').doc;
  check('a caption line before a table is its caption', before.childCount === 1 && before.firstChild!.attrs.caption === 'Caption before');
  const colon = trip('| A |\n|---|\n| 1 |\n\n\\: not a caption\n');
  check('an escaped colon paragraph next to a table stays a paragraph', colon.doc.childCount === 2 && colon.converges, colon.md1);
}

// Page breaks, raw Typst, bibliography at its position, nbsp, headings.
{
  const pb = trip('One.\n\n\\pagebreak\n\nTwo.\n');
  check('\\pagebreak is a page break, written \\newpage', JSON.stringify(kinds(pb.doc)) === '["paragraph","page_break","paragraph"]' && pb.md1 === 'One.\n\n\\newpage\n\nTwo.\n', pb.md1);
  const nested = mdToDoc('::: solution\n\n\\newpage\n\n:::\n');
  check('a page break inside a block is kept as source', nested.doc.firstChild!.firstChild!.attrs.params === 'md-raw' && nested.warnings.length === 1);
  const bib = trip('A [@k].\n\n```{=bibtex}\n@book{k, title={T}}\n```\n\n## After\n\nMore.\n');
  check('the {=bibtex} fence stays where the bibliography is', JSON.stringify(kinds(bib.doc)) === '["paragraph","bibliography","heading","paragraph"]' && bib.md1.indexOf('{=bibtex}') < bib.md1.indexOf('## After') && bib.converges, bib.md1);
  const listing = mdToDoc('```bibtex\n@book{k}\n```\n');
  check('a bibtex fence is a code listing', listing.doc.firstChild!.attrs.params === 'bibtex' && !listing.doc.attrs.bib);
  const nbsp = mdToDoc('5\\ cakes\n').doc;
  check('\\  reads as a no-break space', nbsp.textContent === '5\u00a0cakes' && docToMd(nbsp) === '5\u00a0cakes\n');
  const h = trip('# Intro {#sec:intro}\n\n## Aside {-}\n\n# T `c`{.l}\n');
  check('heading labels; {-} ignored; a code span\'s attributes are not the heading\'s', h.doc.child(0).attrs.label === 'sec:intro' && h.doc.child(1).attrs.label === '' && h.doc.child(2).attrs.label === '' && h.converges, h.md1);
  const raw = trip('Inline `#h(1fr)`{=typst} here.\n');
  check('inline raw Typst', !!find(raw.doc, (n) => n.type.name === 'typst_inline' && n.attrs.src === '#h(1fr)') && raw.md1 === 'Inline `#h(1fr)`{=typst} here.\n');
}

// The abstract (until front matter carries it) rides as a quote led by
// **Abstract.**; quoted paragraphs are separated by a bare `>` line.
{
  const abs = schema.nodes.doc.create(null, [
    schema.nodes.abstract.create(null, [schema.nodes.paragraph.create(null, schema.text('First.')), schema.nodes.paragraph.create(null, schema.text('Second.'))]),
    schema.nodes.paragraph.create(null, schema.text('Body.')),
  ]);
  const md = docToMd(abs);
  check('the abstract is a quote with a bare > between paragraphs', md === '> **Abstract.** First.\n>\n> Second.\n\nBody.\n', JSON.stringify(md));
  check('the abstract reads back exactly', JSON.stringify(mdToDoc(md).doc.toJSON().content) === JSON.stringify(abs.toJSON().content), JSON.stringify(mdToDoc(md).doc.toJSON()));
  const quote = trip('> One.\n>\n> Two.\n');
  check('a two-paragraph quote round-trips byte for byte', quote.md1 === '> One.\n>\n> Two.\n' && quote.doc.firstChild!.childCount === 2, quote.md1);
}

// Every fixture under tests/fixtures/md parses and converges.
{
  const dir = new URL('../tests/fixtures/md/', import.meta.url);
  const names = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const bad: string[] = [];
  for (const name of names) {
    try {
      const t = trip(readFileSync(new URL(name, dir), 'utf8'));
      if (!t.converges) bad.push(`${name}: ${firstDiff(t.md1, t.md2)}`);
      if (/\uE000/.test(JSON.stringify(t.doc.toJSON()))) bad.push(`${name}: a sentinel leaked`);
    } catch (e) {
      bad.push(`${name}: ${(e as Error).message}`);
    }
  }
  check(`all ${names.length} Markdown fixtures parse and converge`, names.length > 20 && !bad.length, bad.join('\n'));
}

// The cross-format check: a Markdown trip changes nothing the compiler
// sees, except what a document declares it drops. `params` (verbatim
// #table arguments only the .typ reader makes) has no Markdown form, and
// document settings reach Markdown in the next step.
{
  const stripUnrepresentable = (doc: PMNode): PMNode => {
    const strip = (node: PMNode): PMNode => {
      if (node.isText) return node;
      const kids: PMNode[] = [];
      node.forEach((c) => kids.push(strip(c)));
      const attrs = node.type.name === 'table' ? { ...node.attrs, params: '' } : node.type.name === 'doc' ? { ...node.attrs, settings: DEFAULT_SETTINGS } : node.attrs;
      return node.type.create(attrs, kids, node.marks);
    };
    return strip(doc);
  };
  const body = (typ: string) => typ.slice(typ.indexOf('\n\n'));
  const hasParams = (doc: PMNode) => !!find(doc, (n) => n.type.name === 'table' && !!(n.attrs.params as string));
  const fixtures: Array<[string, PMNode, boolean]> = [
    ['demo', demoDoc(), false],
    ...([
      ['4 hand-written', F.HAND_WRITTEN_TYP],
      ['5 labels', F.LABELS_TYP],
      ['6 figure', F.FIGURE_TYP + '\n'],
      ['strike', F.STRIKE_TYP],
      ['7 footnote', F.FOOTNOTE_TYP],
      ['8 citations', F.CITATIONS_TYP],
      ['9 merges', F.TABLE_MERGES_TYP + '\n'],
      ['10 styles', F.TABLE_STYLES_TYP + '\n'],
      ['11 params', F.TABLE_PARAMS_TYP + '\n'],
      ['12 polish', F.POLISH_TYP + '\n'],
      ['13b captioned', F.CAPTIONED_TABLE_TYP + '\n'],
      ['19c density', F.DENSITY_TYP],
      ['19c custom', F.DENSITY_CUSTOM_TYP],
      ['19d rules', F.ROW_RULES_TYP],
      ['19d none', F.ROW_RULE_NONE_TYP],
      ['19d custom', F.ROW_RULES_CUSTOM_TYP],
      ['19e fills', F.FILLS_TYP],
      ['19b leading math', F.LEADING_MATH_TYP],
      ['20 grid', F.GRID_TYP],
      ['20 rich grid', F.RICH_GRID_TYP],
      ['lists', F.LISTS_TYP],
      ['chrome', F.CHROME_TYP],
      ['skillsheet', F.SKILLSHEET_TYP],
      ...F.UNSUPPORTED_TABLE_EXPRESSIONS.map((e) => [`852 ${e}`, F.unsupportedTableTyp(e)]),
      ['955 image grid', F.IMAGE_GRID_TYP],
    ] as Array<[string, string]>).map(([name, src]): [string, PMNode, boolean] => [name, typToDoc(src).doc, false]),
    ['13c decimal', F.decimalTableDoc(), false],
    ['13d sized', F.sizedTableDoc(), false],
    ['13e front matter', F.frontMatterDoc(), false],
    ['18 solution', F.solutionDoc(), false],
  ];
  // The params cases, declared: the drop list is executable, not prose.
  const PARAMS = ['11 params', '13d sized', '19c custom', '19d custom', ...F.UNSUPPORTED_TABLE_EXPRESSIONS.map((e) => `852 ${e}`)];
  const undeclared = fixtures.filter(([name, doc]) => hasParams(doc) !== PARAMS.includes(name)).map(([name]) => name);
  check('exactly the declared fixtures carry table params', !undeclared.length, undeclared.join(', '));
  for (const [name, doc] of fixtures) {
    const md = docToMd(doc);
    const back = mdToDoc(md).doc;
    const want = body(docToTyp(stripUnrepresentable(doc), { islands: 'print' }));
    const got = body(docToTyp(back, { islands: 'print' }));
    check(`cross-format: ${name}`, got === want, firstDiff(want, got) + '\n' + md.slice(0, 600));
    check(`cross-format converges: ${name}`, docToMd(back) === docToMd(mdToDoc(docToMd(back)).doc));
  }
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall md round-trip tests passed');
}
