import assert from 'node:assert/strict';
import { buildContextTargets, matchContextRegion } from './layout/page-oracle.ts';
import { buildSpec, type AtomResolver } from './layout/typst-oracle.ts';
import { schema } from './schema.ts';
import {
  parseTypstLayoutRegions,
  TYPST_LAYOUT_REGION_KIND,
  type TypstLayoutRegion,
  type TypstLayoutRegionKind,
} from './typst-layout-regions.ts';

const position = (page: number, x: string, y: string) => ({ page, x, y });
const edge = (
  index: number,
  kind: TypstLayoutRegionKind,
  side: 'start' | 'end',
  page: number,
  x: string,
  y: string,
) => ({ index, kind, edge: side, pos: position(page, x, y) });
const query = (regions: unknown[]) => [{ value: { kind: TYPST_LAYOUT_REGION_KIND, regions } }];

// Query order is not an authority. A complete, uniquely paired index is
// parsed into numeric physical coordinates and returned in stable index order.
{
  const parsed = parseTypstLayoutRegions([
    { value: { kind: 'unrelated-user-metadata', regions: [] } },
    ...query([
      edge(4, 'footnote', 'end', 3, '71.25pt', '210.5pt'),
      edge(1, 'figure-caption', 'start', 1, '-2pt', '18pt'),
      edge(4, 'footnote', 'start', 2, '32pt', '700pt'),
      edge(1, 'figure-caption', 'end', 1, '96.125pt', '39pt'),
    ]),
  ]);
  assert.deepEqual(parsed, [
    {
      index: 1,
      kind: 'figure-caption',
      start: { page: 1, x: -2, y: 18 },
      end: { page: 1, x: 96.125, y: 39 },
    },
    {
      index: 4,
      kind: 'footnote',
      start: { page: 2, x: 32, y: 700 },
      end: { page: 3, x: 71.25, y: 210.5 },
    },
  ]);
}

// Malformed or ambiguous records fail closed per index without poisoning an
// independent valid pair in the same compiler publication.
{
  const parsed = parseTypstLayoutRegions(query([
    edge(0, 'figure-caption', 'start', 1, '10pt', '20pt'),
    edge(0, 'figure-caption', 'end', 1, '80pt', '30pt'),
    edge(1, 'footnote', 'start', 1, '10pt', '40pt'),
    edge(1, 'footnote', 'start', 1, '11pt', '41pt'), // duplicate edge
    edge(1, 'footnote', 'end', 1, '80pt', '50pt'),
    edge(2, 'figure-caption', 'start', 1, '10pt', '60pt'),
    edge(2, 'footnote', 'end', 1, '80pt', '70pt'), // kind collision
    { index: 3, kind: 'footnote', edge: '__proto__', pos: position(1, '10pt', '80pt') },
    edge(3, 'footnote', 'end', 1, '80pt', '90pt'),
    { index: 4, kind: 'footnote', edge: 'start', pos: position(1, 10 as unknown as string, '100pt') },
    edge(4, 'footnote', 'end', 1, '80pt', '110pt'),
    { index: '5', kind: 'footnote', edge: 'start', pos: position(1, '10pt', '120pt') },
    edge(5, 'footnote', 'end', 1, '80pt', '130pt'),
    edge(6, 'footnote', 'start', 0, '10pt', '140pt'), // invalid page
    edge(6, 'footnote', 'end', 1, '80pt', '150pt'),
    edge(7, 'footnote', 'start', 1, '1e3pt', '160pt'), // non-canonical length
    edge(7, 'footnote', 'end', 1, '80pt', '170pt'),
    edge(9, 'footnote', 'end', 2, '90pt', '25pt'),
    edge(9, 'footnote', 'start', 1, '20pt', '680pt'),
  ]));
  assert.deepEqual(parsed.map(({ index }) => index), [0, 9]);
}

// A second payload with the reserved kind is an authority collision, even if
// either payload looks valid on its own. Foreign metadata remains harmless.
{
  const pair = [
    edge(0, 'footnote', 'start', 1, '10pt', '20pt'),
    edge(0, 'footnote', 'end', 1, '80pt', '30pt'),
  ];
  assert.deepEqual(parseTypstLayoutRegions([...query(pair), ...query(pair)]), []);
  assert.deepEqual(parseTypstLayoutRegions({ value: { kind: TYPST_LAYOUT_REGION_KIND, regions: pair } }), []);
  assert.deepEqual(parseTypstLayoutRegions(null), []);
}

const { doc, figure, paragraph, footnote } = schema.nodes;
const text = (value: string) => (value ? [schema.text(value)] : []);
const resolveFootnote: AtomResolver = (node) => node.type === footnote
  ? { markup: `#footnote[${node.textContent}]` }
  : null;

// Target indices mirror serializer preorder: the outer figure caption is
// allocated before an inline footnote inside it. Empty contexts are omitted.
{
  const captionLead = 'Caption lead ';
  const nested = footnote.create(null, text('nested note'));
  const pictured = figure.create(
    { src: 'figure.svg', label: '', name: '' },
    [schema.text(captionLead), nested, schema.text(' tail')],
  );
  const bodyLead = 'Body ';
  const bodyNote = footnote.create(null, text('body note'));
  const emptyNote = footnote.create();
  const body = paragraph.create(null, [schema.text(bodyLead), bodyNote, emptyNote]);
  const emptyFigure = figure.create({ src: 'empty.svg', label: '', name: '' });
  const document = doc.create(null, [pictured, body, emptyFigure]);

  const targets = buildContextTargets(document, resolveFootnote);
  assert.deepEqual(
    targets.map((target) => ({
      index: target.index,
      kind: target.kind,
      pos: target.pos,
      hasSpec: target.spec !== null,
    })),
    [
      { index: 0, kind: 'figure-caption', pos: 0, hasSpec: true },
      { index: 1, kind: 'footnote', pos: 1 + captionLead.length, hasSpec: true },
      { index: 2, kind: 'footnote', pos: pictured.nodeSize + 1 + bodyLead.length, hasSpec: true },
    ],
  );
}

interface TestPhysicalLine {
  id: number;
  page: number;
  text: string;
  y: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const physicalLine = (id: number, page: number, top: number, value: string): TestPhysicalLine => ({
  id,
  page,
  text: value,
  y: top,
  top,
  bottom: top + 7,
  left: 20,
  right: 180,
});

const match = (
  spec: NonNullable<ReturnType<typeof buildSpec>>,
  lines: TestPhysicalLine[],
  region: TypstLayoutRegion,
) => matchContextRegion(
  spec,
  lines as Parameters<typeof matchContextRegion>[1],
  region,
  12,
);

// Figure numbering is paint-only, so a bounded prefix may be stripped while
// the complete caption body and its exact wrap offsets still have to match.
{
  const value = 'Caption wraps across two lines';
  const spec = buildSpec(figure.create({ src: '', label: '', name: '' }, text(value)), () => null);
  assert.ok(spec);
  const region: TypstLayoutRegion = {
    index: 0,
    kind: 'figure-caption',
    start: { page: 1, x: 20, y: 10 },
    end: { page: 1, x: 150, y: 31 },
  };
  const result = match(spec, [
    physicalLine(101, 0, 8, 'Figure 12: Caption wraps'),
    physicalLine(102, 0, 28, 'across two lines'),
  ], region);
  assert.deepEqual(result, {
    breaks: [{ at: 'Caption wraps'.length, hyphen: false }],
    lineIds: [101, 102],
  });

  // Once matching starts on a page, unrelated text inside the marker range
  // makes it ambiguous; it must not be silently skipped.
  assert.equal(match(spec, [
    physicalLine(101, 0, 8, 'Figure 12: Caption wraps'),
    physicalLine(999, 0, 18, 'unrelated painted text'),
    physicalLine(102, 0, 28, 'across two lines'),
  ], region), null);
}

// A split footnote may skip page-leading body/header lines on a continuation
// page, but it still maps only the exact footnote text and returned line ids.
{
  const value = 'Long footnote continues cleanly';
  const spec = buildSpec(footnote.create(null, text(value)), () => null);
  assert.ok(spec);
  const region: TypstLayoutRegion = {
    index: 1,
    kind: 'footnote',
    start: { page: 1, x: 20, y: 90 },
    end: { page: 2, x: 120, y: 26 },
  };
  const lines = [
    physicalLine(201, 0, 88, '1Long footnote'),
    physicalLine(202, 1, 4, 'Running header'),
    physicalLine(203, 1, 24, 'continues cleanly'),
  ];
  assert.deepEqual(match(spec, lines, region), {
    breaks: [{ at: 'Long footnote'.length, hyphen: false }],
    lineIds: [201, 203],
  });

  // The same permissive continuation search is never granted to captions.
  assert.equal(match(spec, lines, { ...region, kind: 'figure-caption' }), null);
}

// Invalid physical bounds and an unreasonably long paint-only prefix cannot
// turn nearby page text into a contextual line authority.
{
  const spec = buildSpec(figure.create({ src: '', label: '', name: '' }, text('Target text')), () => null);
  assert.ok(spec);
  const base: TypstLayoutRegion = {
    index: 0,
    kind: 'figure-caption',
    start: { page: 1, x: 20, y: 10 },
    end: { page: 1, x: 120, y: 10 },
  };
  assert.equal(match(spec, [physicalLine(301, 0, 8, `${'x'.repeat(160)}: Target text`)], base), null);
  assert.equal(match(spec, [physicalLine(301, 0, 8, 'Target text')], {
    ...base,
    start: { ...base.start, page: 2 },
  }), null);
  assert.equal(match(spec, [physicalLine(301, 0, 80, 'Target text')], base), null);
}

console.log('typst layout region tests passed');
