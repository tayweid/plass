import assert from 'node:assert/strict';
import { schema } from './schema.ts';
import {
  parseTypstPreviewRegions,
  TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX,
  TYPST_PREVIEW_REGION_KIND,
  typstPreviewInlineMathIndexFromLink,
  typstPreviewInlineMathLink,
  typstPreviewRegionIndexAt,
  type TypstPreviewRegionKind,
} from './typst-preview-regions.ts';

const position = (page: number, x: unknown, y: unknown) => ({ page, x, y });
const edge = (
  index: number,
  kind: TypstPreviewRegionKind | string,
  side: 'baseline' | 'start' | 'end' | string,
  page: number,
  x: unknown,
  y: unknown,
) => ({ index, kind, edge: side, pos: position(page, x, y) });
const query = (regions: unknown[]) => [{ value: { kind: TYPST_PREVIEW_REGION_KIND, regions } }];

// Query and record order are not an authority. Every complete index is
// decoded into numeric physical coordinates and returned in stable preorder.
{
  assert.deepEqual(parseTypstPreviewRegions([
    { value: { kind: 'user-metadata', regions: [] } },
    ...query([
      edge(5, 'bibliography', 'end', 3, '480.5pt', '700pt'),
      edge(0, 'math-inline', 'baseline', 1, '-2pt', '18.25pt'),
      edge(1, 'typst-inline', 'baseline', 1, '12pt', '19pt'),
      edge(2, 'math-display', 'end', 2, '500pt', '80pt'),
      edge(5, 'bibliography', 'start', 2, '40pt', '120pt'),
      edge(2, 'math-display', 'start', 2, '40pt', '42pt'),
    ]),
  ]), [
    { index: 0, kind: 'math-inline', baseline: { page: 1, x: -2, y: 18.25 } },
    { index: 1, kind: 'typst-inline', baseline: { page: 1, x: 12, y: 19 } },
    {
      index: 2,
      kind: 'math-display',
      start: { page: 2, x: 40, y: 42 },
      end: { page: 2, x: 500, y: 80 },
    },
    {
      index: 5,
      kind: 'bibliography',
      start: { page: 2, x: 40, y: 120 },
      end: { page: 3, x: 480.5, y: 700 },
    },
  ]);
}

// Bad edges, coordinates, duplicates, kind collisions, and incomplete
// records fail only their own index. A later valid index still survives.
{
  const parsed = parseTypstPreviewRegions(query([
    edge(0, 'math-inline', 'baseline', 1, '10pt', '20pt'),
    edge(0, 'math-inline', 'baseline', 1, '11pt', '21pt'), // duplicate
    edge(1, 'math-inline', 'start', 1, '10pt', '30pt'), // wrong edge
    edge(2, 'math-display', 'start', 1, '10pt', '40pt'), // incomplete
    edge(3, 'math-display', 'start', 1, '10pt', '50pt'),
    edge(3, 'bibliography', 'end', 1, '80pt', '60pt'), // kind collision
    edge(4, 'bibliography', 'start', 1, '10pt', '70pt'),
    edge(4, 'bibliography', '__proto__', 1, '80pt', '80pt'),
    edge(5, 'math-inline', 'baseline', 0, '10pt', '90pt'), // invalid page
    edge(6, 'math-inline', 'baseline', 1, '1e3pt', '100pt'), // invalid pt
    edge(7, 'math-inline', 'baseline', 1, 10, '110pt'), // non-string pt
    edge(8, 'unknown', 'baseline', 1, '10pt', '120pt'),
    { index: '9', kind: 'math-inline', edge: 'baseline', pos: position(1, '10pt', '130pt') },
    null,
    edge(10, 'math-inline', 'baseline', 2, '15pt', '140pt'),
  ]));
  assert.deepEqual(parsed, [
    { index: 10, kind: 'math-inline', baseline: { page: 2, x: 15, y: 140 } },
  ]);
}

// Exactly one reserved payload is required. Foreign payloads do not collide;
// a second reserved payload does, even when one is itself malformed.
{
  const valid = query([edge(0, 'math-inline', 'baseline', 1, '1pt', '2pt')]);
  assert.equal(parseTypstPreviewRegions(valid).length, 1);
  assert.deepEqual(parseTypstPreviewRegions([
    { value: { kind: 'foreign', regions: [] } },
    ...valid,
  ]).map(({ index }) => index), [0]);
  assert.deepEqual(parseTypstPreviewRegions([...valid, ...valid]), []);
  assert.deepEqual(parseTypstPreviewRegions([
    ...valid,
    { value: { kind: TYPST_PREVIEW_REGION_KIND, regions: null } },
  ]), []);
  assert.deepEqual(parseTypstPreviewRegions({ value: valid[0].value }), []);
  assert.deepEqual(parseTypstPreviewRegions(null), []);
}

// Link metadata accepts only the exact reserved prefix and a canonical,
// non-negative safe integer suffix.
{
  assert.equal(typstPreviewInlineMathLink(0), `${TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX}0`);
  assert.equal(typstPreviewInlineMathLink(42), `${TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX}42`);
  assert.equal(typstPreviewInlineMathIndexFromLink(typstPreviewInlineMathLink(42)), 42);
  for (const invalid of [
    `${TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX}`,
    `${TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX}01`,
    `${TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX}-1`,
    `${TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX}1?x`,
    `${TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX}9007199254740992`,
    'http://plass.invalid/.well-known/preview-region/math-inline/1',
    null,
  ]) assert.equal(typstPreviewInlineMathIndexFromLink(invalid), null);
  assert.throws(() => typstPreviewInlineMathLink(-1), RangeError);
  assert.throws(() => typstPreviewInlineMathLink(Number.MAX_SAFE_INTEGER + 1), RangeError);
}

// The index follows ProseMirror descendant preorder across all four preview
// kinds. Empty atoms are represented in the protocol and therefore count.
{
  const inline0 = schema.nodes.math_inline.create({ src: '' });
  const inline1 = schema.nodes.math_inline.create({ src: 'x' });
  const typstInline = schema.nodes.typst_inline.create({ src: '#sym.arrow.r' });
  const paragraph = schema.nodes.paragraph.create(null, [
    typstInline,
    schema.text(' before '),
    inline0,
    schema.text(' between '),
    inline1,
  ]);
  const display = schema.nodes.math_display.create({ src: '' });
  const bibliography = schema.nodes.bibliography.create();
  const document = schema.nodes.doc.create(null, [paragraph, display, bibliography]);

  const positions = new Map<string, number>();
  document.descendants((node, pos) => {
    if (node === typstInline) positions.set('typstInline', pos);
    if (node === inline0) positions.set('inline0', pos);
    if (node === inline1) positions.set('inline1', pos);
    if (node === display) positions.set('display', pos);
    if (node === bibliography) positions.set('bibliography', pos);
  });
  assert.equal(typstPreviewRegionIndexAt(document, positions.get('typstInline')!), 0);
  assert.equal(typstPreviewRegionIndexAt(document, positions.get('inline0')!), 1);
  assert.equal(typstPreviewRegionIndexAt(document, positions.get('inline1')!), 2);
  assert.equal(typstPreviewRegionIndexAt(document, positions.get('display')!), 3);
  assert.equal(typstPreviewRegionIndexAt(document, positions.get('bibliography')!), 4);
  assert.equal(typstPreviewRegionIndexAt(document, 0), null); // paragraph, not a preview node
  assert.equal(typstPreviewRegionIndexAt(document, -1), null);
  assert.equal(typstPreviewRegionIndexAt(document, document.content.size + 1), null);
}

console.log('all Typst preview region tests passed');
