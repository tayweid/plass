import assert from 'node:assert/strict';
import { schema } from '../schema';
import {
  diffPageStarts,
  emptyPageParityStats,
  recordParityDiff,
  type PageStartEntry,
} from './page-parity';

const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const heading = (level: number, text: string) =>
  schema.nodes.heading.create({ level }, schema.text(text));
const doc = (...blocks: ReturnType<typeof paragraph>[]) => schema.nodes.doc.create(null, blocks);

function positions(value: ReturnType<typeof doc>): number[] {
  const result: number[] = [];
  value.forEach((_node, pos) => result.push(pos));
  return result;
}

const entry = (pos: number, line: number, unit: string): PageStartEntry => ({ pos, line, unit });

// --- agreement -------------------------------------------------------

{
  const same: PageStartEntry[] = [entry(10, 0, 'paragraph'), entry(40, 2, 'line')];
  const d = doc(paragraph('a'), paragraph('b'), paragraph('c'));
  assert.equal(diffPageStarts(same, same.map((e) => ({ ...e })), { doc: d }), null);
  console.log('  ok  identical lists agree');
}

// --- widow-orphan ------------------------------------------------------

{
  const longText = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const d = doc(paragraph('lead'), paragraph(longText));
  const [, paraPos] = positions(d);
  const local = [entry(paraPos, 5, 'line')];
  const exact = [entry(paraPos, 6, 'line')];
  const diff = diffPageStarts(local, exact, { doc: d });
  assert.ok(diff);
  assert.equal(diff!.cause, 'widow-orphan');
  assert.equal(diff!.firstDiffPage, 2);
  console.log('  ok  same-paragraph one-line-off classifies as widow-orphan');
}

// --- sticky --------------------------------------------------------------

{
  const d = doc(paragraph('lead'), heading(2, 'Section'), paragraph('body'));
  const [, headingPos, bodyPos] = positions(d);
  const local = [entry(headingPos, 0, 'h2')];
  const exact = [entry(bodyPos, 0, 'paragraph')];
  const diff = diffPageStarts(local, exact, { doc: d });
  assert.ok(diff);
  assert.equal(diff!.cause, 'sticky');
  console.log('  ok  heading at one boundary classifies as sticky');
}

// --- footnote --------------------------------------------------------------

{
  const withNote = schema.nodes.paragraph.create(null, [
    schema.text('claim'),
    schema.nodes.footnote.create(null, schema.text('note body')),
  ]);
  const d = doc(paragraph('lead'), withNote, paragraph('tail'));
  const [, notePos, tailPos] = positions(d);
  const local = [entry(notePos, 0, 'paragraph')];
  const exact = [entry(tailPos, 0, 'paragraph')];
  const diff = diffPageStarts(local, exact, { doc: d });
  assert.ok(diff);
  assert.equal(diff!.cause, 'footnote');
  console.log('  ok  a footnote ahead of the boundary classifies as footnote');
}

// --- breakable-block --------------------------------------------------------------

{
  const d = doc(paragraph('lead'), schema.nodes.code_block.create(null, schema.text('code')) as never, paragraph('tail'));
  const [, codePos, tailPos] = positions(d as never);
  const local = [entry(codePos, 0, 'block')];
  const exact = [entry(tailPos, 0, 'paragraph')];
  const diff = diffPageStarts(local, exact, { doc: d as never });
  assert.ok(diff);
  assert.equal(diff!.cause, 'breakable-block');
  console.log('  ok  a code block at the boundary classifies as breakable-block');
}

// --- spacing (same anchor, different unit label) -------------------------

{
  const d = doc(paragraph('lead'), paragraph('second'), paragraph('third'));
  const [, secondPos] = positions(d);
  const local = [entry(secondPos, 0, 'block')];
  const exact = [entry(secondPos, 0, 'paragraph')];
  const diff = diffPageStarts(local, exact, { doc: d });
  assert.ok(diff);
  assert.equal(diff!.cause, 'spacing');
  console.log('  ok  same-position unit mismatch classifies as spacing');
}

// --- spacing (adjacent whole-block shift) ---------------------------------

{
  const d = doc(paragraph('lead'), paragraph('second'), paragraph('third'), paragraph('fourth'));
  const [, secondPos, thirdPos] = positions(d);
  const local = [entry(secondPos, 0, 'paragraph')];
  const exact = [entry(thirdPos, 0, 'paragraph')];
  const diff = diffPageStarts(local, exact, { doc: d });
  assert.ok(diff);
  assert.equal(diff!.cause, 'spacing');
  console.log('  ok  adjacent top-level block shift classifies as spacing');
}

// --- page-top-adjust (previous boundary agreed) ---------------------------

{
  const d = doc(paragraph('lead'), paragraph('second'), paragraph('third'), paragraph('fourth'), paragraph('fifth'));
  const [, secondPos, , fourthPos, fifthPos] = positions(d);
  const local = [entry(secondPos, 0, 'paragraph'), entry(fourthPos, 0, 'paragraph')];
  const exact = [entry(secondPos, 0, 'paragraph'), entry(fifthPos, 0, 'paragraph')];
  const diff = diffPageStarts(local, exact, { doc: d });
  assert.ok(diff);
  assert.equal(diff!.firstDiffPage, 3);
  assert.equal(diff!.cause, 'page-top-adjust');
  console.log('  ok  an agreeing prior boundary attributes the next mismatch to page-top-adjust');
}

// --- oversize --------------------------------------------------------------

{
  const d = doc(paragraph('lead'), paragraph('big'), paragraph('tail'));
  const [, bigPos, tailPos] = positions(d);
  const local = [entry(bigPos, 0, 'paragraph')];
  const exact = [entry(tailPos, 0, 'paragraph')];
  const diff = diffPageStarts(local, exact, {
    doc: d,
    contentHeightPx: 500,
    blockHeightPx: (pos) => (pos === bigPos ? 900 : 40),
  });
  assert.ok(diff);
  assert.equal(diff!.cause, 'oversize');
  console.log('  ok  a block taller than the content area classifies as oversize');
}

// --- unknown fallback --------------------------------------------------------------

{
  const d = doc(paragraph('lead'), paragraph('second'), paragraph('third'), paragraph('fourth'), paragraph('fifth'), paragraph('sixth'));
  const [, secondPos, , fourthPos, , sixthPos] = positions(d);
  const local = [entry(secondPos, 0, 'paragraph'), entry(fourthPos, 0, 'paragraph')];
  const exact = [entry(secondPos + 1000, 0, 'paragraph'), entry(sixthPos, 0, 'paragraph')];
  // Position out of range on the exact side (simulating a document large
  // enough that no other rule fires): falls through to unknown.
  const diff = diffPageStarts(local, exact, { doc: d });
  assert.ok(diff);
  assert.equal(diff!.cause, 'unknown');
  console.log('  ok  an unrecognized divergence falls back to unknown');
}

// --- list length mismatch (one side ran out of pages) ----------------------

{
  const d = doc(paragraph('lead'), paragraph('second'), paragraph('third'));
  const [, secondPos] = positions(d);
  const local = [entry(secondPos, 0, 'paragraph')];
  const exact: PageStartEntry[] = [];
  const diff = diffPageStarts(local, exact, { doc: d });
  assert.ok(diff);
  assert.equal(diff!.exactStart, null);
  assert.equal(diff!.firstDiffPage, 2);
  console.log('  ok  a shorter list surfaces a diff with a null start on that side');
}

// --- stats folding -----------------------------------------------------------

{
  const stats = emptyPageParityStats();
  recordParityDiff(stats, null);
  recordParityDiff(stats, { firstDiffPage: 3, cause: 'sticky', localStart: null, exactStart: null });
  recordParityDiff(stats, { firstDiffPage: 5, cause: 'sticky', localStart: null, exactStart: null });
  assert.equal(stats.predictions, 3);
  assert.equal(stats.agreements, 1);
  assert.equal(stats.disagreements, 2);
  assert.equal(stats.byCause.sticky, 2);
  assert.equal(stats.last?.firstDiffPage, 5);
  console.log('  ok  recordParityDiff folds agreements and disagreements into stats');
}

console.log('page-parity: all assertions passed');
