// Markdown import/export round-trip: parse a representative document,
// serialize it back, re-parse, and require convergence.
// Run: npx tsx src/md-round.test.ts
import { mdToDoc } from './md-parser';
import { docToMd } from './md-serializer';
import { docToTyp } from './typ-serializer';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

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

\`\`\`typst
#pagebreak()
\`\`\`

---

Closing paragraph with a minus −3 and an em dash — here.

[^1]: The footnote body.

\`\`\`bibtex
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
check('display math with label', (() => {
  let ok = false;
  doc.descendants((n) => {
    if (n.type.name === 'math_display' && n.attrs.label === 'eq:main' && /Pi_/.test(n.attrs.src as string)) ok = true;
    return true;
  });
  return ok;
})());
check('unknown frontmatter kept, not reported', doc.attrs.frontmatter === 'keywords: "voting, econ"' && !first.warnings.some((w) => /keywords/.test(w)), JSON.stringify([doc.attrs.frontmatter, first.warnings]));
check('bib captured', /arrow1950/.test((doc.attrs.bib as { content: string })?.content ?? ''));
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
check('strikethrough becomes a mark', (() => {
  let ok = false;
  doc.descendants((n) => {
    if (n.isText && n.text === 'struck' && n.marks.some((m) => m.type.name === 'strike')) ok = true;
    return true;
  });
  return ok;
})());
check('literal ~~ in plain text stays literal', (() => {
  const { doc: d } = mdToDoc(docToMd(mdToDoc('tildes \\~~ here').doc));
  let ok = false;
  d.descendants((n) => {
    if (n.isText && n.text?.includes('~~') && !n.marks.some((m) => m.type.name === 'strike')) ok = true;
    return true;
  });
  return ok;
})());
check('table shape', (() => {
  let ok = false;
  doc.descendants((n) => {
    if (n.type.name === 'table' && n.childCount === 3) ok = true;
    return true;
  });
  return ok;
})());
check('typst island', (() => {
  let ok = false;
  doc.descendants((n) => {
    if (n.type.name === 'code_block' && n.attrs.params === 'typst-raw' && /pagebreak/.test(n.textContent)) ok = true;
    return true;
  });
  return ok;
})());

// round trip: md -> doc -> md -> doc -> md must be stable
const md1 = docToMd(doc);
{
  // A markdown space before an inline footnote never prints (Typst's marker
  // swallows it), so import drops it and the round-trip stays stable.
  const { doc: d } = mdToDoc('Word ^[inline note] after.\n');
  let para: typeof d | null = null;
  d.descendants((n) => {
    if (!para && n.type.name === 'paragraph') para = n;
    return !para;
  });
  const p = para!;
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
if (md1 !== md2) {
  const a = md1.split('\n'), b = md2.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { console.log('   first diff line', i, JSON.stringify(a[i]), 'vs', JSON.stringify(b[i])); break; }
  }
}
check('round-trip converges', md1 === md2);
check('round-trip keeps doc shape', second.doc.childCount === doc.childCount,
  `${doc.childCount} vs ${second.doc.childCount}`);

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
}

// HTML blocks — editorial comments above all — are Markdown the page
// cannot render: islands shown as code, verbatim in, verbatim out, and
// printed as the same code block.
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
  const kinds: string[] = [];
  doc.forEach((n) => kinds.push(n.type.name));
  check('HTML blocks become Markdown islands', JSON.stringify(kinds) === JSON.stringify(['paragraph', 'code_block', 'code_block', 'bullet_list', 'paragraph']) && doc.child(1).attrs.params === 'md-raw' && doc.child(2).attrs.params === 'md-raw', JSON.stringify(kinds));
  check('a comment keeps its dashes', doc.child(1).textContent === '<!-- ED: MOVED (2026-09-01) -- keep A3\'s closer pure — see chat. Marked {++stitches++} only. -->', doc.child(1).textContent);
  check('islands raise no warning', warnings.length === 0, warnings.join('; '));
  const out = docToMd(doc);
  check('islands are written back verbatim', out === md, out);
  const typ = docToTyp(doc, { islands: 'print' });
  check('islands print as raw blocks, never run', typ.includes('```\n<!-- ED: MOVED') && typ.includes('```\n<div style') && (typ.match(/^<div/gm) ?? []).length === (typ.match(/```\n<div/g) ?? []).length, typ);
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

// Inline HTML and image titles are carried, not stripped.
{
  const md = 'Water is H<sub>2</sub>O <!-- inline note -- keep --> and <span class="x">x</span>.\n\n![A figure](fig.png "Its title")\n';
  const { doc, warnings } = mdToDoc(md);
  const kinds: string[] = [];
  doc.firstChild!.forEach((n) => kinds.push(n.type.name + (n.type.name === 'typst_inline' ? `:${n.attrs.lang}` : '')));
  check('inline HTML becomes inline islands', kinds.filter((k) => k === 'typst_inline:html').length === 5 && warnings.length === 0, JSON.stringify([kinds, warnings]));
  check('inline HTML and image titles round-trip', docToMd(doc) === md, docToMd(doc));
  check('an inline HTML island prints as inline raw', docToTyp(doc, { islands: 'print' }).includes('#raw("<sub>")') && docToTyp(doc).includes('#raw("<!-- inline note -- keep -->")'), docToTyp(doc));
}

// Fill-in blanks, brackets, and a comment's spacing come back as written.
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
    let links = 0;
    let notes = 0;
    again.descendants((n) => {
      if (n.type.name === 'footnote') notes++;
      if (n.isText && n.marks.some((m) => m.type.name === 'link')) links++;
      return true;
    });
    check('a would-be link or footnote stays literal text', links === 0 && notes === 0 && again.textContent === 'x [a](b) and [^n] here' && docToMd(again) === out, out);
  }
  const tight = '# Title\n<!-- from extract: filed by hand -->\n\nBody.\n\n<!-- ED: note -->\nNext para.\n';
  const t = mdToDoc(tight).doc;
  check('island spacing is recorded', t.child(1).attrs.tight === 'before' && t.child(3).attrs.tight === 'after', JSON.stringify([t.child(1).attrs.tight, t.child(3).attrs.tight]));
  check('island spacing round-trips byte for byte', docToMd(t) === tight, docToMd(t));
  const offsets: number[] = [];
  const md = docToMd(t, () => {}, offsets);
  check('offsets follow tight joins', md.slice(offsets[1], offsets[1] + 4) === '<!--' && md.slice(offsets[4], offsets[4] + 4) === 'Next', JSON.stringify(offsets));
  const inComment = 'Para.\n\n<!-- keep ___ and $x$ and *stars* verbatim -->\n';
  check('nothing inside an HTML block is touched', docToMd(mdToDoc(inComment).doc) === inComment, docToMd(mdToDoc(inComment).doc));
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

{
  // A grid rides Markdown as a ```typst fence in the rail's form; the
  // importer reads it back as the native block, an unknown fence stays raw.
  const md = 'Intro.\n\n```typst\n#grid(\n  columns: (2fr, 1fr),\n  gutter: 1em,\n  [\n    Left text.\n  ],\n  [\n    Right text.\n  ],\n)\n```\n\nAfter.\n';
  const { doc } = mdToDoc(md);
  const kinds: string[] = [];
  doc.forEach((n) => kinds.push(n.type.name));
  check('a typst fence holding a grid is native', JSON.stringify(kinds) === JSON.stringify(['paragraph', 'grid', 'paragraph']), JSON.stringify(kinds));
  check('the grid keeps its shares and cells', JSON.stringify(doc.child(1).attrs.columns) === '[2,1]' && doc.child(1).child(0).child(1).textContent === 'Right text.', JSON.stringify(doc.child(1).toJSON()));
  check('a grid round-trips byte for byte', docToMd(doc) === md, docToMd(doc));
  const other = 'Intro.\n\n```typst\n#grid(columns: (auto, 1fr), [a], [b])\n```\n';
  check('a grid off the rail stays a raw fence', mdToDoc(other).doc.child(1).type.name === 'code_block' && docToMd(mdToDoc(other).doc) === other, docToMd(mdToDoc(other).doc));
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall md round-trip tests passed');
}
