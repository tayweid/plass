import assert from 'node:assert/strict';
import { schema } from '../schema';
import {
  planSuffixPagination,
  type SuffixPageMarker,
  type SuffixPageSpacer,
  type SuffixPaginationInput,
} from './pagination-suffix';

const paragraph = (text: string, attrs?: { keep?: boolean; align?: string | null }) =>
  schema.nodes.paragraph.create(attrs, text ? schema.text(text) : undefined);
const doc = (...paragraphs: ReturnType<typeof paragraph>[]) => schema.nodes.doc.create(null, paragraphs);

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

const basis = doc(
  paragraph('first page words'),
  paragraph('second page original words'),
  paragraph('third paragraph words'),
);
const current = doc(
  paragraph('first page words'),
  paragraph('second page revised words'),
  paragraph('third paragraph words'),
);
const [, page2Pos] = positions(current);
const page2Marker: SuffixPageMarker = { pos: page2Pos, line: 0, unit: 'paragraph', page: 1 };
const page2Gap: SuffixPageSpacer = { pos: page2Pos, height: 412.25, kind: 'block' };

const page2 = planSuffixPagination(input(basis, current, [page2Marker], [page2Gap]));
assert.equal(page2.kind, 'seed');
if (page2.kind !== 'seed') throw new Error('expected page-two seed');
assert.deepEqual(page2.seed, {
  startPos: page2Pos,
  startIndex: 1,
  dirtyPos: page2Pos + 1 + 'second page '.length,
  dirtyIndex: 1,
  page: 1,
  shift: 412.25,
  prefixSpacers: [page2Gap],
});
assert.notEqual(page2.seed.prefixSpacers[0], page2Gap);
assert(Object.isFrozen(page2.seed));
assert(Object.isFrozen(page2.seed.prefixSpacers));
console.log('  ok  page-two restart preserves one copied prefix gap and its exact shift');

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

const thirdDirty = doc(
  paragraph('first page words'),
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
console.log('  ok  a marker nested inside a paragraph is not a top-level anchor');

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

const insertedParagraph = doc(
  paragraph('first page words'),
  paragraph('new structural paragraph'),
  paragraph('second page original words'),
  paragraph('third paragraph words'),
);
assert.deepEqual(
  planSuffixPagination(input(basis, insertedParagraph, [page2Marker], [page2Gap])),
  { kind: 'reject', reason: 'top-level-structure' },
);
const changedAttrs = doc(
  paragraph('first page words'),
  paragraph('second page revised words', { keep: true }),
  paragraph('third paragraph words'),
);
assert.deepEqual(
  planSuffixPagination(input(basis, changedAttrs, [page2Marker], [page2Gap])),
  { kind: 'reject', reason: 'top-level-structure' },
);
console.log('  ok  top-level insertion and paragraph attribute changes reject suffix work');

const citation = schema.nodes.citation.create({ key: 'special' });
const specialCurrent = doc(
  paragraph('first page words'),
  schema.nodes.paragraph.create(null, [schema.text('second page '), citation, schema.text(' words')]),
  paragraph('third paragraph words'),
);
assert.deepEqual(
  planSuffixPagination(input(basis, specialCurrent, [page2Marker], [page2Gap])),
  { kind: 'reject', reason: 'special-inline' },
);
const footnote = schema.nodes.footnote.create(null, schema.text('nested note'));
const footnoteBasis = doc(paragraph('first page words'), schema.nodes.paragraph.create(null, [schema.text('claim'), footnote]));
const footnoteCurrent = doc(
  paragraph('first page words'),
  schema.nodes.paragraph.create(null, [schema.text('revised claim'), footnote]),
);
const [, footnotePage] = positions(footnoteCurrent);
assert.deepEqual(
  planSuffixPagination(
    input(
      footnoteBasis,
      footnoteCurrent,
      [{ pos: footnotePage, line: 0, unit: 'paragraph', page: 1 }],
      [{ pos: footnotePage, height: 200, kind: 'block' }],
    ),
  ),
  { kind: 'reject', reason: 'special-inline' },
);
console.log('  ok  inline atoms and editable footnotes retain full pagination');

const listItem = (text: string) =>
  schema.nodes.list_item.create(null, [paragraph(text)]);
const listBasis = schema.nodes.doc.create(null, [
  paragraph('first page words'),
  schema.nodes.bullet_list.create(null, [listItem('nested list words')]),
  paragraph('last original words'),
]);
const listCurrent = schema.nodes.doc.create(null, [
  paragraph('first page words'),
  schema.nodes.bullet_list.create(null, [listItem('nested list words')]),
  paragraph('last revised words'),
]);
assert.deepEqual(
  planSuffixPagination(input(listBasis, listCurrent, [], [])),
  { kind: 'reject', reason: 'non-paragraph-document' },
);

const tableCell = (text: string) =>
  schema.nodes.table_cell.create(null, [paragraph(text)]);
const tableRow = (text: string) =>
  schema.nodes.table_row.create(null, [tableCell(text)]);
const tableBasis = schema.nodes.doc.create(null, [
  paragraph('first page words'),
  schema.nodes.table.create(null, [tableRow('table words')]),
  paragraph('last original words'),
]);
const tableCurrent = schema.nodes.doc.create(null, [
  paragraph('first page words'),
  schema.nodes.table.create(null, [tableRow('table words')]),
  paragraph('last revised words'),
]);
assert.deepEqual(
  planSuffixPagination(input(tableBasis, tableCurrent, [], [])),
  { kind: 'reject', reason: 'non-paragraph-document' },
);
console.log('  ok  lists and tables retain full pagination');

assert.deepEqual(
  planSuffixPagination(input(basis, current, [page2Marker], [page2Gap], [4, 5])),
  { kind: 'reject', reason: 'epoch-changed' },
);
console.log('  ok  a global geometry epoch change rejects edit-only reuse');

const accumulatedBasis = doc(
  paragraph('page one'),
  paragraph('page two original'),
  paragraph('page three'),
  paragraph('page four original'),
);
const accumulatedCurrent = doc(
  paragraph('page one'),
  paragraph('page two first edit'),
  paragraph('page three'),
  paragraph('page four later edit'),
);
const [, accumulatedPage2, accumulatedPage3] = positions(accumulatedCurrent);
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
assert.equal(accumulated.seed.dirtyIndex, 1);
assert.equal(accumulated.seed.dirtyPos, accumulatedPage2 + 1 + 'page two '.length);
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
  paragraph('third physical page original'),
);
const prefixCurrent = doc(
  paragraph('a very long first paragraph on two pages'),
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
