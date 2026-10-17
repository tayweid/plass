import assert from 'node:assert/strict';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema';
import {
  planSuffixPagination,
  type SuffixPageMarker,
  type SuffixPageSpacer,
  type SuffixPaginationInput,
} from './pagination-suffix';

const paragraph = (text: string, attrs?: { keep?: boolean; align?: string | null }) =>
  schema.nodes.paragraph.create(attrs, text ? schema.text(text) : undefined);
const doc = (...blocks: ReturnType<typeof paragraph>[]) => schema.nodes.doc.create(null, blocks);

function positions(value: ReturnType<typeof doc>): number[] {
  const result: number[] = [];
  value.forEach((_node, pos) => result.push(pos));
  return result;
}

function input(
  basisDoc: ReturnType<typeof doc>,
  currentDoc: ReturnType<typeof doc>,
  markers: readonly SuffixPageMarker[],
  spacers: readonly SuffixPageSpacer[],
  epochs: readonly [number, number] = [4, 4],
): SuffixPaginationInput {
  return {
    basisDoc,
    currentDoc,
    markers,
    spacers,
    basisEpoch: epochs[0],
    currentEpoch: epochs[1],
  };
}

// Page two opens with its own paragraph; the edits below it are to the
// paragraph after the opener, so page two's start is above the dirty block.
const basis = doc(
  paragraph('first page words'),
  paragraph('second page opening words'),
  paragraph('second page original words'),
  paragraph('third paragraph words'),
);
const current = doc(
  paragraph('first page words'),
  paragraph('second page opening words'),
  paragraph('second page revised words'),
  paragraph('third paragraph words'),
);
const [, page2Pos, editedPos, fourthPos] = positions(current);
const page2Marker: SuffixPageMarker = { pos: page2Pos, line: 0, unit: 'paragraph', page: 1 };
const page2Gap: SuffixPageSpacer = { pos: page2Pos, height: 412.25, kind: 'block' };

const page2 = planSuffixPagination(input(basis, current, [page2Marker], [page2Gap]));
assert.equal(page2.kind, 'seed');
if (page2.kind !== 'seed') throw new Error('expected page-two seed');
assert.deepEqual(page2.seed, {
  startPos: page2Pos,
  startIndex: 1,
  dirtyPos: editedPos + 1 + 'second page '.length,
  dirtyIndex: 2,
  page: 1,
  shift: 412.25,
  prefixSpacers: [page2Gap],
  prefixMarkers: [page2Marker],
});
assert.notEqual(page2.seed.prefixSpacers[0], page2Gap);
assert.notEqual(page2.seed.prefixMarkers[0], page2Marker);
assert(Object.isFrozen(page2.seed));
assert(Object.isFrozen(page2.seed.prefixSpacers));
assert(Object.isFrozen(page2.seed.prefixMarkers));
assert(Object.isFrozen(page2.seed.prefixMarkers[0]));
console.log('  ok  page-two restart preserves one copied prefix gap and its exact shift');

// A page start AT the dirty block is never the anchor: the page before it
// ended by reading that block (do its first lines fit at the foot, the
// orphan rule over them), so an edit there can move that page's end — an
// Enter at the start of a page's opening paragraph makes an empty line that
// fits at the previous page's foot (found 2026-10-16 at 1 in margins). The
// seed backs off to the page start before, or rejects when there is none.
assert.deepEqual(
  planSuffixPagination(
    input(
      basis,
      doc(
        paragraph('first page words'),
        paragraph('second page reworded opening'),
        paragraph('second page original words'),
        paragraph('third paragraph words'),
      ),
      [page2Marker],
      [page2Gap],
    ),
  ),
  { kind: 'reject', reason: 'no-boundary-anchor' },
);
const page3Marker: SuffixPageMarker = { pos: fourthPos, line: 0, unit: 'paragraph', page: 2 };
const page3Gap: SuffixPageSpacer = { pos: fourthPos, height: 180.5, kind: 'block' };
const openerEdits = [
  // The opener's text changed.
  doc(
    paragraph('first page words'),
    paragraph('second page opening words'),
    paragraph('second page original words'),
    paragraph('third paragraph revised words'),
  ),
  // Enter at the opener's start: an empty paragraph above it.
  doc(
    paragraph('first page words'),
    paragraph('second page opening words'),
    paragraph('second page original words'),
    paragraph(''),
    paragraph('third paragraph words'),
  ),
  // Backspace at the opener's start: joined into the block above it.
  doc(
    paragraph('first page words'),
    paragraph('second page opening words'),
    paragraph('second page original wordsthird paragraph words'),
  ),
];
for (const edited of openerEdits) {
  const backedOff = planSuffixPagination(input(basis, edited, [page2Marker, page3Marker], [page2Gap, page3Gap]));
  assert.equal(backedOff.kind, 'seed');
  if (backedOff.kind !== 'seed') throw new Error('expected a seed on the page before');
  assert.equal(backedOff.seed.startPos, page2Pos);
  assert.equal(backedOff.seed.page, 1);
  assert.equal(backedOff.seed.shift, 412.25);
  assert.deepEqual(backedOff.seed.prefixMarkers, [page2Marker]);
  assert.deepEqual(backedOff.seed.prefixSpacers, [page2Gap]);
}
console.log('  ok  an edit to the block that opens a page anchors on the page before it');

const midLine = planSuffixPagination(
  input(
    basis,
    current,
    [{ ...page2Marker, line: 1, unit: 'line' }],
    [{ pos: page2Pos + 8, height: 300, kind: 'line' }],
  ),
);
assert.deepEqual(midLine, { kind: 'reject', reason: 'mid-line-anchor' });
console.log('  ok  a latest mid-line page start cannot seed a block suffix');

// A later mid-line start does not doom the plan when an earlier block-start
// marker exists: the anchor skips back and the mid-line break joins the
// recomputed suffix.
const fourBlocks = doc(
  paragraph('first page words'),
  paragraph('a paragraph long enough to split across pages two and three'),
  paragraph('fourth page original words'),
);
const fourEdited = doc(
  paragraph('first page words'),
  paragraph('a paragraph long enough to split across pages two and three'),
  paragraph('fourth page revised words'),
);
const [, splitParaPos] = positions(fourEdited);
const skipBack = planSuffixPagination(
  input(
    fourBlocks,
    fourEdited,
    [
      { pos: splitParaPos, line: 0, unit: 'paragraph', page: 1 },
      { pos: splitParaPos, line: 3, unit: 'line', page: 2 },
    ],
    [
      { pos: splitParaPos, height: 410, kind: 'block' },
      { pos: splitParaPos + 20, height: 180, kind: 'line' },
    ],
  ),
);
assert.equal(skipBack.kind, 'seed');
if (skipBack.kind !== 'seed') throw new Error('expected skip-back seed');
assert.equal(skipBack.seed.startPos, splitParaPos);
assert.equal(skipBack.seed.page, 1);
assert.equal(skipBack.seed.shift, 410);
assert.equal(skipBack.seed.prefixSpacers.length, 1);
// The post-anchor mid-line marker joins the recomputed suffix, so it must not
// leak into the prefix markers a reference pass would re-force.
assert.deepEqual(skipBack.seed.prefixMarkers, [
  { pos: splitParaPos, line: 0, unit: 'paragraph', page: 1 },
]);
console.log('  ok  the anchor skips back over a mid-line start to the latest block start');

const thirdDirty = doc(
  paragraph('first page words'),
  paragraph('second page opening words'),
  paragraph('second page original words'),
  paragraph('third paragraph revised words'),
);
const nestedMarker = { ...page2Marker, pos: page2Pos + 1 };
assert.deepEqual(
  planSuffixPagination(
    input(basis, thirdDirty, [nestedMarker], [{ ...page2Gap, pos: nestedMarker.pos }]),
  ),
  { kind: 'reject', reason: 'anchor-boundary' },
);
console.log('  ok  a marker inside a paragraph is not a block-boundary anchor');

assert.deepEqual(
  planSuffixPagination(input(basis, current, [{ ...page2Marker, page: 2 }], [page2Gap])),
  { kind: 'reject', reason: 'invalid-page-ordinal' },
);
assert.deepEqual(
  planSuffixPagination(
    input(
      basis,
      thirdDirty,
      [page2Marker, { ...page2Marker, page: 2 }],
      [page2Gap, { ...page2Gap, height: 200 }],
    ),
  ),
  { kind: 'reject', reason: 'marker-order' },
);
console.log('  ok  page ordinals must be contiguous and marker positions/lines monotone');

// A top-level split or insertion no longer rejects: the clean prefix before
// the first differing block still anchors the suffix restart, at the latest
// page start strictly above it.
const insertedParagraph = doc(
  paragraph('first page words'),
  paragraph('second page opening words'),
  paragraph('new structural paragraph'),
  paragraph('second page original words'),
  paragraph('third paragraph words'),
);
const inserted = planSuffixPagination(input(basis, insertedParagraph, [page2Marker], [page2Gap]));
assert.equal(inserted.kind, 'seed');
if (inserted.kind !== 'seed') throw new Error('expected structural-insert seed');
assert.equal(inserted.seed.startPos, page2Pos);
assert.equal(inserted.seed.dirtyIndex, 2);
const removedParagraph = doc(
  paragraph('first page words'),
  paragraph('second page opening words'),
  paragraph('third paragraph words'),
);
const removed = planSuffixPagination(input(basis, removedParagraph, [page2Marker], [page2Gap]));
assert.equal(removed.kind, 'seed');
if (removed.kind !== 'seed') throw new Error('expected structural-remove seed');
assert.equal(removed.seed.startPos, page2Pos);
console.log('  ok  block splits and joins keep the clean-prefix anchor');

// A block attribute change dirties that block; the prefix anchor still holds.
const changedAttrs = doc(
  paragraph('first page words'),
  paragraph('second page opening words'),
  paragraph('second page original words', { keep: true }),
  paragraph('third paragraph words'),
);
const attrsDirty = planSuffixPagination(input(basis, changedAttrs, [page2Marker], [page2Gap]));
assert.equal(attrsDirty.kind, 'seed');
if (attrsDirty.kind !== 'seed') throw new Error('expected attribute-change seed');
assert.equal(attrsDirty.seed.dirtyIndex, 2);
console.log('  ok  a paragraph attribute change is a dirty block, not a rejection');

// Inline atoms — math, citations, footnote markers, hard breaks — are
// eligible: the paginator only measures the enclosing line boxes, and the
// runner reserves footnote-body heights identically on both passes.
const citation = schema.nodes.citation.create({ key: 'special' });
const specialCurrent = doc(
  paragraph('first page words'),
  paragraph('second page opening words'),
  schema.nodes.paragraph.create(null, [schema.text('second page '), citation, schema.text(' words')]),
  paragraph('third paragraph words'),
);
const specialBasis = doc(
  paragraph('first page words'),
  paragraph('second page opening words'),
  schema.nodes.paragraph.create(null, [schema.text('second base '), citation, schema.text(' words')]),
  paragraph('third paragraph words'),
);
const citationSeed = planSuffixPagination(input(specialBasis, specialCurrent, [page2Marker], [page2Gap]));
assert.equal(citationSeed.kind, 'seed');
const footnote = schema.nodes.footnote.create(null, schema.text('nested note'));
const mathInline = schema.nodes.math_inline.create({ src: 'x^2' });
const hardBreak = schema.nodes.hard_break.create();
const atomBasis = doc(
  paragraph('first page words'),
  paragraph('second page opening words'),
  schema.nodes.paragraph.create(null, [schema.text('claim'), footnote, hardBreak, mathInline]),
);
const atomCurrent = doc(
  paragraph('first page words'),
  paragraph('second page opening words'),
  schema.nodes.paragraph.create(null, [schema.text('revised claim'), footnote, hardBreak, mathInline]),
);
const [, atomPage] = positions(atomCurrent);
const atomSeed = planSuffixPagination(
  input(
    atomBasis,
    atomCurrent,
    [{ pos: atomPage, line: 0, unit: 'paragraph', page: 1 }],
    [{ pos: atomPage, height: 200, kind: 'block' }],
  ),
);
assert.equal(atomSeed.kind, 'seed');
console.log('  ok  inline atoms, footnote markers, and hard breaks stay eligible');

// Headings, code blocks, blockquotes, figures, and math blocks are all
// deterministic fallback units; a heading may itself anchor the restart.
const heading = (text: string, level = 2) =>
  schema.nodes.heading.create({ level }, schema.text(text));
const richBasis = schema.nodes.doc.create(null, [
  paragraph('first page words'),
  heading('Results'),
  schema.nodes.code_block.create(null, schema.text('let x = 1;')),
  schema.nodes.blockquote.create(null, [paragraph('quoted words')]),
  schema.nodes.figure.create({ src: 'fig.png' }),
  schema.nodes.math_display.create({ src: 'e = mc^2' }),
  paragraph('closing original words'),
]);
const richCurrent = schema.nodes.doc.create(null, [
  paragraph('first page words'),
  heading('Results'),
  schema.nodes.code_block.create(null, schema.text('let x = 1;')),
  schema.nodes.blockquote.create(null, [paragraph('quoted words')]),
  schema.nodes.figure.create({ src: 'fig.png' }),
  schema.nodes.math_display.create({ src: 'e = mc^2' }),
  paragraph('closing revised words'),
]);
const richPositions = positions(richCurrent);
const headingPos = richPositions[1];
const richSeed = planSuffixPagination(
  input(
    richBasis,
    richCurrent,
    [{ pos: headingPos, line: 0, unit: 'h2', page: 1 }],
    [{ pos: headingPos, height: 240, kind: 'block' }],
  ),
);
assert.equal(richSeed.kind, 'seed');
if (richSeed.kind !== 'seed') throw new Error('expected heading-anchored seed');
assert.equal(richSeed.seed.startPos, headingPos);
assert.equal(richSeed.seed.startIndex, 1);
assert.equal(richSeed.seed.dirtyIndex, 6);
console.log('  ok  headings, code, quotes, figures, and math blocks seed a heading anchor');

// A heading is sticky (src/layout/flow-rules.ts): a page that ends before
// the frame anchoring a heading run takes the whole run along, so a page
// opening with a heading ended its previous page by reading every block of
// the run and the one that anchors it. When that reaches the dirty block,
// the page start is not a sound anchor even though it is above the edit:
// the seed steps back a page. A hard-break-only paragraph may be empty
// lines alone (no anchor), so the run reads past it too.
const stickyBlocks = (...middle: PMNode[]) => [
  paragraph('first page words'),
  paragraph('second page opening words'),
  ...middle,
  paragraph('closing original words'),
];
const stickyEdited = (...middle: PMNode[]) => [
  paragraph('first page words'),
  paragraph('second page opening words'),
  ...middle,
  paragraph('closing revised words'),
];
const hardBreakOnly = schema.nodes.paragraph.create(null, [schema.nodes.hard_break.create()]);
const stickyCases: Array<{ name: string; middle: PMNode[]; anchorPage: 1 | 2 }> = [
  { name: 'a heading directly above the edit', middle: [heading('Results')], anchorPage: 1 },
  { name: 'a run of two headings', middle: [heading('Part', 1), heading('Results')], anchorPage: 1 },
  { name: 'a heading over a hard-break-only paragraph', middle: [heading('Results'), hardBreakOnly], anchorPage: 1 },
  { name: 'a heading anchored by a clean paragraph', middle: [heading('Results'), paragraph('clean words')], anchorPage: 2 },
  { name: 'a heading over an empty paragraph', middle: [heading('Results'), paragraph('')], anchorPage: 2 },
];
for (const { name, middle, anchorPage } of stickyCases) {
  const stickyBasis = schema.nodes.doc.create(null, stickyBlocks(...middle));
  const stickyCurrent = schema.nodes.doc.create(null, stickyEdited(...middle));
  const [, openerPos, headingPos2] = positions(stickyCurrent);
  const markers: SuffixPageMarker[] = [
    { pos: openerPos, line: 0, unit: 'paragraph', page: 1 },
    { pos: headingPos2, line: 0, unit: 'h2', page: 2 },
  ];
  const spacers: SuffixPageSpacer[] = [
    { pos: openerPos, height: 300, kind: 'block' },
    { pos: headingPos2, height: 150, kind: 'block' },
  ];
  const decision = planSuffixPagination(input(stickyBasis, stickyCurrent, markers, spacers));
  assert.equal(decision.kind, 'seed', name);
  if (decision.kind !== 'seed') throw new Error(`expected a seed: ${name}`);
  assert.equal(decision.seed.page, anchorPage, name);
  assert.equal(decision.seed.startPos, anchorPage === 1 ? openerPos : headingPos2, name);
  assert.deepEqual(decision.seed.prefixMarkers, markers.slice(0, anchorPage), name);
}
// The run reaching the dirty block from the only page start: no anchor.
const loneHeadingBasis = schema.nodes.doc.create(null, [
  paragraph('first page words'),
  heading('Results'),
  paragraph('closing original words'),
]);
const loneHeadingCurrent = schema.nodes.doc.create(null, [
  paragraph('first page words'),
  heading('Results'),
  paragraph('closing revised words'),
]);
const [, loneHeadingPos] = positions(loneHeadingCurrent);
assert.deepEqual(
  planSuffixPagination(
    input(
      loneHeadingBasis,
      loneHeadingCurrent,
      [{ pos: loneHeadingPos, line: 0, unit: 'h2', page: 1 }],
      [{ pos: loneHeadingPos, height: 150, kind: 'block' }],
    ),
  ),
  { kind: 'reject', reason: 'sticky-look-ahead' },
);
// Removing the block after a closing heading changes the run as surely as
// editing it: the run reads to the document's end, which is dirty.
assert.deepEqual(
  planSuffixPagination(
    input(
      loneHeadingBasis,
      schema.nodes.doc.create(null, [paragraph('first page words'), heading('Results')]),
      [{ pos: loneHeadingPos, line: 0, unit: 'h2', page: 1 }],
      [{ pos: loneHeadingPos, height: 150, kind: 'block' }],
    ),
  ),
  { kind: 'reject', reason: 'sticky-look-ahead' },
);
console.log('  ok  a heading run that reaches the dirty block steps the anchor back a page');

// Lists are eligible; a page start between list children is a valid PREFIX
// marker (block spacer at the nested child boundary) but never an anchor.
const listItem = (text: string) => schema.nodes.list_item.create(null, [paragraph(text)]);
const list = schema.nodes.bullet_list.create(null, [
  listItem('first item words'),
  listItem('second item words'),
]);
const listBasis = schema.nodes.doc.create(null, [
  list,
  paragraph('middle page words'),
  paragraph('last original words'),
]);
const listCurrent = schema.nodes.doc.create(null, [
  list,
  paragraph('middle page words'),
  paragraph('last revised words'),
]);
const listPositions = positions(listCurrent);
const secondItemPos = listPositions[0] + 1 + listCurrent.child(0).child(0).nodeSize;
const middlePos = listPositions[1];
const listSeed = planSuffixPagination(
  input(
    listBasis,
    listCurrent,
    [
      { pos: secondItemPos, line: 0, unit: 'list_item', page: 1 },
      { pos: middlePos, line: 0, unit: 'paragraph', page: 2 },
    ],
    [
      { pos: secondItemPos, height: 130, kind: 'block' },
      { pos: middlePos, height: 210, kind: 'block' },
    ],
  ),
);
assert.equal(listSeed.kind, 'seed');
if (listSeed.kind !== 'seed') throw new Error('expected list-prefix seed');
assert.equal(listSeed.seed.startPos, middlePos);
assert.equal(listSeed.seed.page, 2);
assert.equal(listSeed.seed.shift, 340);
const listAnchorInside = planSuffixPagination(
  input(
    listBasis,
    doc(list, paragraph('middle edited words'), paragraph('last original words')),
    [{ pos: secondItemPos, line: 0, unit: 'list_item', page: 1 }],
    [{ pos: secondItemPos, height: 130, kind: 'block' }],
  ),
);
assert.deepEqual(listAnchorInside, { kind: 'reject', reason: 'anchor-boundary' });
console.log('  ok  list-internal page starts validate as prefix gaps but never anchor');

// Tables (PAGE-PORT.md Phase 7): the fallback paginator breaks them between
// rows from painted `<tr>` heights, a pure walk both passes reproduce, so a
// table document is eligible. A row start is stored as the table's boundary
// plus the row index and validates against a 'row' spacer before that row;
// like a mid-line start it never anchors the seed.
const tableCell = (text: string) => schema.nodes.table_cell.create(null, [paragraph(text)]);
const tableRow = (text: string) => schema.nodes.table_row.create(null, [tableCell(text)]);
const tableNode = schema.nodes.table.create(null, [tableRow('row one'), tableRow('row two'), tableRow('row three')]);
const tableBasis = schema.nodes.doc.create(null, [
  paragraph('first page words'),
  tableNode,
  paragraph('after table words'),
  paragraph('last original words'),
]);
const tableCurrent = schema.nodes.doc.create(null, [
  paragraph('first page words'),
  tableNode,
  paragraph('after table words'),
  paragraph('last revised words'),
]);
const [, tablePos, tableAfterPos] = positions(tableCurrent);
const row2Pos = tablePos + 1 + tableNode.child(0).nodeSize + tableNode.child(1).nodeSize;
const tableSeed = planSuffixPagination(
  input(
    tableBasis,
    tableCurrent,
    [
      { pos: tablePos, line: 0, unit: 'table', page: 1 },
      { pos: tablePos, line: 2, unit: 'table', page: 2 },
      { pos: tableAfterPos, line: 0, unit: 'paragraph', page: 3 },
    ],
    [
      { pos: tablePos, height: 100, kind: 'block' },
      { pos: row2Pos, height: 300, kind: 'row', hdr: 25 },
      { pos: tableAfterPos, height: 120, kind: 'block' },
    ],
  ),
);
assert.equal(tableSeed.kind, 'seed');
if (tableSeed.kind !== 'seed') throw new Error('expected table seed');
assert.equal(tableSeed.seed.startPos, tableAfterPos);
assert.equal(tableSeed.seed.page, 3);
assert.equal(tableSeed.seed.shift, 520);
console.log('  ok  a row start validates as a prefix gap of a table document');

const tableRowAnchor = planSuffixPagination(
  input(
    tableBasis,
    schema.nodes.doc.create(null, [
      paragraph('first page words'),
      tableNode,
      paragraph('after table revised words'),
      paragraph('last original words'),
    ]),
    [
      { pos: tablePos, line: 0, unit: 'table', page: 1 },
      { pos: tablePos, line: 2, unit: 'table', page: 2 },
    ],
    [
      { pos: tablePos, height: 100, kind: 'block' },
      { pos: row2Pos, height: 300, kind: 'row', hdr: 25 },
    ],
  ),
);
assert.equal(tableRowAnchor.kind, 'seed');
if (tableRowAnchor.kind !== 'seed') throw new Error('expected table-start seed');
assert.equal(tableRowAnchor.seed.startPos, tablePos);
assert.equal(tableRowAnchor.seed.page, 1);
console.log('  ok  a row start never anchors: the seed backs up to the table start');

assert.deepEqual(
  planSuffixPagination(
    input(
      tableBasis,
      tableCurrent,
      [
        { pos: tablePos, line: 0, unit: 'table', page: 1 },
        { pos: tablePos, line: 2, unit: 'table', page: 2 },
        { pos: tableAfterPos, line: 0, unit: 'paragraph', page: 3 },
      ],
      [
        { pos: tablePos, height: 100, kind: 'block' },
        { pos: row2Pos + 1, height: 300, kind: 'row' },
        { pos: tableAfterPos, height: 120, kind: 'block' },
      ],
    ),
  ),
  { kind: 'reject', reason: 'prefix-spacer-mismatch' },
);
assert.deepEqual(
  planSuffixPagination(
    input(tableBasis, tableCurrent, [{ pos: tablePos, line: 2, unit: 'paragraph', page: 1 }], [{ pos: row2Pos, height: 300, kind: 'row' }]),
  ),
  { kind: 'reject', reason: 'invalid-marker' },
);
console.log('  ok  a row spacer off its row, or a split marker of the wrong unit, rejects');

// Document attributes carry settings and the bibliography: a change there
// invalidates every stored page start.
const bibDoc = schema.nodes.doc.create(
  { ...basis.attrs, bib: { name: 'refs.bib', content: '@book{k}' } },
  [paragraph('first page words'), paragraph('second page revised words'), paragraph('third paragraph words')],
);
assert.deepEqual(
  planSuffixPagination(input(basis, bibDoc, [page2Marker], [page2Gap])),
  { kind: 'reject', reason: 'doc-attrs' },
);
console.log('  ok  a document attribute change rejects edit-only reuse');

assert.deepEqual(
  planSuffixPagination(input(basis, current, [page2Marker], [page2Gap], [4, 5])),
  { kind: 'reject', reason: 'epoch-changed' },
);
console.log('  ok  a global geometry epoch change rejects edit-only reuse');

// A stale or unmappable marker AFTER the anchor ends the prefix scan instead
// of rejecting: the seeded pass recomputes everything past the anchor anyway.
const staleTail = planSuffixPagination(
  input(
    basis,
    current,
    [page2Marker, { pos: Number.NaN, line: 0, unit: 'paragraph', page: 2 }],
    [page2Gap],
  ),
);
assert.equal(staleTail.kind, 'seed');
if (staleTail.kind !== 'seed') throw new Error('expected stale-tail seed');
assert.equal(staleTail.seed.startPos, page2Pos);
console.log('  ok  an unmappable post-anchor marker only ends the prefix scan');

const accumulatedBasis = doc(
  paragraph('page one'),
  paragraph('page two opening'),
  paragraph('page two original'),
  paragraph('page three'),
  paragraph('page three original'),
);
const accumulatedCurrent = doc(
  paragraph('page one'),
  paragraph('page two opening'),
  paragraph('page two first edit'),
  paragraph('page three'),
  paragraph('page three later edit'),
);
const [, accumulatedPage2, accumulatedEdit, accumulatedPage3] = positions(accumulatedCurrent);
const accumulated = planSuffixPagination(
  input(
    accumulatedBasis,
    accumulatedCurrent,
    [
      { pos: accumulatedPage2, line: 0, unit: 'paragraph', page: 1 },
      { pos: accumulatedPage3, line: 0, unit: 'paragraph', page: 2 },
    ],
    [
      { pos: accumulatedPage2, height: 350, kind: 'block' },
      { pos: accumulatedPage3, height: 200, kind: 'block' },
    ],
  ),
);
assert.equal(accumulated.kind, 'seed');
if (accumulated.kind !== 'seed') throw new Error('expected accumulated-edit seed');
assert.equal(accumulated.seed.startPos, accumulatedPage2);
assert.equal(accumulated.seed.dirtyIndex, 2);
assert.equal(accumulated.seed.dirtyPos, accumulatedEdit + 1 + 'page two '.length);
assert.equal(accumulated.seed.prefixSpacers.length, 1);
console.log('  ok  direct basis-to-current diff retains the earliest of two accumulated edits');

const clonedBasis = schema.nodeFromJSON(basis.toJSON());
assert.deepEqual(
  planSuffixPagination(input(basis, clonedBasis, [], [])),
  { kind: 'none', reason: 'unchanged' },
);
console.log('  ok  undo back to the exact basis requires no pagination work');

const prefixBasis = doc(
  paragraph('a very long first paragraph on two pages'),
  paragraph('third physical page opening'),
  paragraph('third physical page original'),
);
const prefixCurrent = doc(
  paragraph('a very long first paragraph on two pages'),
  paragraph('third physical page opening'),
  paragraph('third physical page revised'),
);
const [, page3Pos] = positions(prefixCurrent);
const validMixedPrefix = planSuffixPagination(
  input(
    prefixBasis,
    prefixCurrent,
    [
      { pos: 0, line: 4, unit: 'line', page: 1 },
      { pos: page3Pos, line: 0, unit: 'paragraph', page: 2 },
    ],
    [
      { pos: 12, height: 180, kind: 'line' },
      { pos: page3Pos, height: 210, kind: 'block' },
    ],
  ),
);
assert.equal(validMixedPrefix.kind, 'seed');
if (validMixedPrefix.kind !== 'seed') throw new Error('expected exact mixed prefix seed');
assert.equal(validMixedPrefix.seed.page, 2);
assert.equal(validMixedPrefix.seed.shift, 390);
assert.equal(validMixedPrefix.seed.prefixSpacers.length, 2);
assert.deepEqual(validMixedPrefix.seed.prefixMarkers, [
  { pos: 0, line: 4, unit: 'line', page: 1 },
  { pos: page3Pos, line: 0, unit: 'paragraph', page: 2 },
]);
assert.deepEqual(
  planSuffixPagination(
    input(
      prefixBasis,
      prefixCurrent,
      [
        { pos: 0, line: 4, unit: 'line', page: 1 },
        { pos: page3Pos, line: 0, unit: 'paragraph', page: 2 },
      ],
      [
        { pos: 12, height: 180, kind: 'line' },
        { pos: page3Pos - 1, height: 210, kind: 'block' },
      ],
    ),
  ),
  { kind: 'reject', reason: 'prefix-spacer-mismatch' },
);
console.log('  ok  copied prefix gaps match every preserved marker and end exactly at the anchor');

console.log('\nall suffix pagination eligibility tests passed');

// Exact-basis seed construction: markers shaped exactly as the plugin retains
// them from a Typst publication (contiguous page ordinals in publication
// order, mid-paragraph starts as line markers) with the forced pass's spacer
// geometry (a line gap sits inside its textblock, after the split line's
// start). An edit below the last page start seeds from the full exact prefix.
const exactBasis = doc(
  paragraph('exactly settled opening words'),
  paragraph('a long middle paragraph that Typst split across pages two and three'),
  paragraph('a paragraph opening the last page'),
  paragraph('a closing paragraph with the original tail words'),
);
const exactCurrent = doc(
  paragraph('exactly settled opening words'),
  paragraph('a long middle paragraph that Typst split across pages two and three'),
  paragraph('a paragraph opening the last page'),
  paragraph('a closing paragraph with the revised tail words'),
);
const [, exactMiddlePos, exactLastPagePos] = positions(exactCurrent);
const exactPublication = [
  { pos: exactMiddlePos, line: 0, unit: 'paragraph' },
  { pos: exactMiddlePos, line: 5, unit: 'line' },
  { pos: exactLastPagePos, line: 0, unit: 'paragraph' },
];
const exactMarkers: SuffixPageMarker[] = exactPublication.map((ps, index) => ({
  pos: ps.pos,
  line: ps.line,
  unit: ps.unit,
  page: index + 1,
}));
const exactSpacers: SuffixPageSpacer[] = [
  { pos: exactMiddlePos, height: 371.5, kind: 'block' },
  { pos: exactMiddlePos + 24, height: 96.25, kind: 'line' },
  { pos: exactLastPagePos, height: 233.75, kind: 'block' },
];
const exactSeed = planSuffixPagination(input(exactBasis, exactCurrent, exactMarkers, exactSpacers));
assert.equal(exactSeed.kind, 'seed');
if (exactSeed.kind !== 'seed') throw new Error('expected exact-basis seed');
assert.equal(exactSeed.seed.startPos, exactLastPagePos);
assert.equal(exactSeed.seed.page, 3);
assert.equal(exactSeed.seed.shift, 371.5 + 96.25 + 233.75);
assert.deepEqual(exactSeed.seed.prefixMarkers, exactMarkers);
assert.deepEqual(exactSeed.seed.prefixSpacers, exactSpacers);
console.log('  ok  a retained exact publication seeds the suffix with its full settled prefix');

// An edit ABOVE every retained page start cannot hold any of them constant:
// the planner rejects per-attempt (no-boundary-anchor) — retention never has
// to clear the basis for structural damage above the boundary.
const exactEditedAbove = doc(
  paragraph('exactly settled revised opening words'),
  paragraph('a long middle paragraph that Typst split across pages two and three'),
  paragraph('a paragraph opening the last page'),
  paragraph('a closing paragraph with the original tail words'),
);
assert.deepEqual(
  planSuffixPagination(input(exactBasis, exactEditedAbove, exactMarkers, exactSpacers)),
  { kind: 'reject', reason: 'no-boundary-anchor' },
);
console.log('  ok  an edit above the first retained page start rejects instead of seeding');

// A mid-burst edit to the block that opens the last page: only the starts
// strictly above the dirty block survive into the seed, and of those the
// split middle paragraph's line start cannot anchor, so the seed is the
// middle paragraph's own start; the rest are recomputed suffix.
const exactMidEdit = doc(
  paragraph('exactly settled opening words'),
  paragraph('a long middle paragraph that Typst split across pages two and three'),
  paragraph('a paragraph someone reworded mid burst'),
  paragraph('a closing paragraph with the original tail words'),
);
const exactMid = planSuffixPagination(input(exactBasis, exactMidEdit, exactMarkers, exactSpacers));
assert.equal(exactMid.kind, 'seed');
if (exactMid.kind !== 'seed') throw new Error('expected mid-burst exact seed');
assert.equal(exactMid.seed.startPos, exactMiddlePos);
assert.equal(exactMid.seed.page, 1);
assert.equal(exactMid.seed.shift, 371.5);
assert.deepEqual(exactMid.seed.prefixMarkers, [exactMarkers[0]]);
console.log('  ok  a mid-burst edit keeps only the exact page starts above it');
