// Markdown import/export round-trip: parse a representative document,
// serialize it back, re-parse, and require convergence.
// Run: npx tsx src/md-round.test.ts
import { mdToDoc } from './md-parser';
import { docToMd } from './md-serializer';

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
check('unknown frontmatter reported', first.warnings.some((w) => /keywords/.test(w)), JSON.stringify(first.warnings));
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

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall md round-trip tests passed');
}
