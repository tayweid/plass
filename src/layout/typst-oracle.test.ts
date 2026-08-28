import assert from 'node:assert/strict';
import { schema } from '../schema';
import {
  buildSpec,
  groupSelectionRuns,
  matchParagraph,
  selectionRunTolerance,
} from './typst-oracle';

const prefix = 'Invariant ';
const suffix = ' remains stable';
const paragraph = schema.nodes.paragraph.create(null, [
  schema.text(prefix),
  schema.nodes.math_inline.create({ src: '\\sum_{i=1}^{n} x_i' }),
  schema.text(suffix),
]);
const spec = buildSpec(paragraph, (node) =>
  node.type.name === 'math_inline'
    ? {
        markup: '#mi(`\\sum_{i=1}^{n} x_i`)',
        // Deliberately unlike the document SVG. Cached formula selection
        // text must never decide how the one-offset PM atom is mapped.
        text: 'stale cached formula glyphs',
      }
    : null,
);
assert(spec);

const sumRuns = groupSelectionRuns([
  { text: 'Invariant ', top: 3.226, bottom: 15.726 },
  { text: '∑', top: 3.226, bottom: 15.726 },
  { text: '𝑛', top: 0, bottom: 8.75 },
  { text: '𝑖=1', top: 11.875, bottom: 20.625 },
  { text: '𝑥', top: 3.226, bottom: 15.726 },
  { text: '𝑖', top: 9.337, bottom: 18.087 },
  { text: ' remains stable', top: 3.226, bottom: 15.726 },
  { text: 'Next visual line', top: 21.979, bottom: 34.479 },
], selectionRunTolerance(18.75));

assert.deepEqual(sumRuns, [
  { text: 'Invariant ∑𝑛𝑖=1𝑥𝑖 remains stable', y: 3.226 },
  { text: 'Next visual line', y: 21.979 },
]);

assert.deepEqual(
  groupSelectionRuns([
    { text: 'small footnote line one', top: 0, bottom: 8.5 },
    { text: 'small footnote line two', top: 10, bottom: 18.5 },
  ], selectionRunTolerance(18.75)),
  [
    { text: 'small footnote line one', y: 0 },
    { text: 'small footnote line two', y: 10 },
  ],
);

// The page oracle removes selection runs owned by the compiled atom rectangle
// before prose matching, then supplies the atom's physical baseline line.
const oneLine = matchParagraph(spec, [
  { text: 'Invariant  remains stable', y: 3.226 },
], 0, undefined, new Map([[1, 0]]));
assert.equal(oneLine.status, 'ok');
if (oneLine.status === 'ok') assert.deepEqual(oneLine.entry.breaks, []);

// Paint-only inline Typst has an exact crop but no selectable glyph. Typst
// emits the prose on either side as separate foreignObjects on one baseline;
// after line grouping the opaque atom must be allowed to consume zero text.
const paintOnlyParagraph = schema.nodes.paragraph.create(null, [
  schema.text('Exact atom '),
  schema.nodes.typst_inline.create({ src: '#box[#circle(radius: 3pt)]' }),
  schema.text(' in document context.'),
]);
const paintOnlySpec = buildSpec(paintOnlyParagraph, (node) =>
  node.type.name === 'typst_inline' ? { markup: node.attrs.src as string } : null,
);
assert(paintOnlySpec);
const paintOnlyLines = groupSelectionRuns([
  { text: 'Exact atom ', top: 3.226, bottom: 15.726 },
  { text: ' in document context.', top: 3.226, bottom: 15.726 },
], selectionRunTolerance(18.75));
const paintOnlyMatch = matchParagraph(
  paintOnlySpec,
  paintOnlyLines,
  0,
  undefined,
  new Map([[2, 0]]),
);
assert.equal(paintOnlyMatch.status, 'ok');
if (paintOnlyMatch.status === 'ok') assert.deepEqual(paintOnlyMatch.entry.breaks, []);

// Text alone is never allowed to certify an opaque atom. In particular, a
// selectable atom can paint the same word that follows it and make an
// unbounded wildcard complete one line too early.
assert.equal(matchParagraph(paintOnlySpec, paintOnlyLines, 0).status, 'fail');

const impersonatingParagraph = schema.nodes.paragraph.create(null, [
  schema.text('P '),
  schema.nodes.typst_inline.create({ src: '#box[in]' }),
  schema.text(' in'),
]);
const impersonatingSpec = buildSpec(impersonatingParagraph, (node) =>
  node.type.name === 'typst_inline' ? { markup: node.attrs.src as string } : null,
);
assert(impersonatingSpec);
// The atom-painted first `in` was removed by its link rectangle. Its queried
// baseline owns line 0; the real following prose is therefore line 1.
const impersonatingMatch = matchParagraph(impersonatingSpec, [
  { text: 'P', y: 3.226 },
  { text: 'in', y: 21.976 },
], 0, undefined, new Map([[1, 0]]));
assert.equal(impersonatingMatch.status, 'ok');
if (impersonatingMatch.status === 'ok') {
  assert.deepEqual(impersonatingMatch.entry.breaks, [{ at: 3, hyphen: false }]);
}

// The queried baseline resolves whether a paint-only atom beside a physical
// boundary belongs to the preceding or following line.
const geometryOwnedPaintOnlyBreak = matchParagraph(paintOnlySpec, [
  { text: 'Exact atom', y: 3.226 },
  { text: 'in document context.', y: 21.976 },
], 0, undefined, new Map([[2, 0]]));
assert.equal(geometryOwnedPaintOnlyBreak.status, 'ok');
if (geometryOwnedPaintOnlyBreak.status === 'ok') {
  assert.deepEqual(geometryOwnedPaintOnlyBreak.entry.breaks, [{ at: 12, hyphen: false }]);
}

// Consecutive opaque atoms are partitioned by their individual baselines,
// independent of which one happened to contribute selectable glyphs.
const groupedAtomsParagraph = schema.nodes.paragraph.create(null, [
  schema.text('P '),
  schema.nodes.typst_inline.create({ src: '#circle(radius: 3pt)' }),
  schema.text(' '),
  schema.nodes.math_inline.create({ src: 'x' }),
  schema.text(' tail'),
]);
const groupedAtomsSpec = buildSpec(groupedAtomsParagraph, (node) =>
  node.type.name === 'typst_inline'
    ? { markup: node.attrs.src as string }
    : node.type.name === 'math_inline'
      ? { markup: '$x$' }
      : null,
);
assert(groupedAtomsSpec);
const geometryOwnedAtomGroup = matchParagraph(groupedAtomsSpec, [
  { text: 'P', y: 3.226 },
  { text: 'tail', y: 21.976 },
], 0, undefined, new Map([[1, 0], [2, 1]]));
assert.equal(geometryOwnedAtomGroup.status, 'ok');
if (geometryOwnedAtomGroup.status === 'ok') {
  assert.deepEqual(geometryOwnedAtomGroup.entry.breaks, [{ at: 3, hyphen: false }]);
}

// A terminal paint-only atom completes on its own baseline line and leaves
// the following block's first selectable line untouched.
const terminalAtomParagraph = schema.nodes.paragraph.create(null, [
  schema.text('P '),
  schema.nodes.typst_inline.create({ src: '#circle(radius: 3pt)' }),
]);
const terminalAtomSpec = buildSpec(terminalAtomParagraph, (node) =>
  node.type.name === 'typst_inline' ? { markup: node.attrs.src as string } : null,
);
assert(terminalAtomSpec);
const terminalAtomSteal = matchParagraph(terminalAtomSpec, [
  { text: 'P', y: 3.226 },
  { text: 'Next paragraph', y: 21.976 },
], 0, undefined, new Map([[1, 0]]));
assert.equal(terminalAtomSteal.status, 'ok');
if (terminalAtomSteal.status === 'ok') assert.equal(terminalAtomSteal.next, 1);

const trailingAtomGroupParagraph = schema.nodes.paragraph.create(null, [
  schema.text('P '),
  schema.nodes.math_inline.create({ src: 'a' }),
  schema.text(' '),
  schema.nodes.math_inline.create({ src: 'b' }),
]);
const trailingAtomGroupSpec = buildSpec(trailingAtomGroupParagraph, (node) =>
  node.type.name === 'math_inline' ? { markup: `$${node.attrs.src as string}$` } : null,
);
assert(trailingAtomGroupSpec);
assert.equal(matchParagraph(trailingAtomGroupSpec, [
  { text: 'P', y: 3.226 },
  { text: '', y: 21.976 },
], 0, undefined, new Map([[1, 0], [2, 1]])).status, 'ok');

const atomBeforeHardBreakParagraph = schema.nodes.paragraph.create(null, [
  schema.text('P '),
  schema.nodes.math_inline.create({ src: 'x' }),
  schema.nodes.hard_break.create(),
  schema.text('tail'),
]);
const atomBeforeHardBreakSpec = buildSpec(atomBeforeHardBreakParagraph, (node) =>
  node.type.name === 'math_inline' ? { markup: '$x$' } : null,
);
assert(atomBeforeHardBreakSpec);
const atomBeforeHardBreak = matchParagraph(atomBeforeHardBreakSpec, [
  { text: 'P', y: 3.226 },
  { text: 'tail', y: 21.976 },
], 0, undefined, new Map([[1, 0]]));
assert.equal(atomBeforeHardBreak.status, 'ok');
if (atomBeforeHardBreak.status === 'ok') assert.deepEqual(atomBeforeHardBreak.entry.breaks, []);
assert.equal(matchParagraph(atomBeforeHardBreakSpec, [
  { text: 'P tail', y: 3.226 },
], 0, undefined, new Map([[1, 0]])).status, 'fail');

const ordinaryHardBreakParagraph = schema.nodes.paragraph.create(null, [
  schema.text('P'),
  schema.nodes.hard_break.create(),
  schema.text('tail'),
]);
const ordinaryHardBreakSpec = buildSpec(ordinaryHardBreakParagraph, () => null);
assert(ordinaryHardBreakSpec);
const ordinaryHardBreak = matchParagraph(ordinaryHardBreakSpec, [
  { text: 'P', y: 3.226 },
  { text: 'tail', y: 21.976 },
], 0);
assert.equal(ordinaryHardBreak.status, 'ok');
if (ordinaryHardBreak.status === 'ok') assert.deepEqual(ordinaryHardBreak.entry.breaks, []);
assert.equal(matchParagraph(ordinaryHardBreakSpec, [
  { text: 'P tail', y: 3.226 },
], 0).status, 'fail');

const hyphenThenAtomParagraph = schema.nodes.paragraph.create(null, [
  schema.text('abcdef '),
  schema.nodes.math_inline.create({ src: 'x' }),
]);
const hyphenThenAtomSpec = buildSpec(hyphenThenAtomParagraph, (node) =>
  node.type.name === 'math_inline' ? { markup: '$x$' } : null,
);
assert(hyphenThenAtomSpec);
const hyphenThenAtom = matchParagraph(hyphenThenAtomSpec, [
  { text: 'abc-', y: 3.226 },
  { text: 'def', y: 21.976 },
], 0, undefined, new Map([[1, 1]]));
assert.equal(hyphenThenAtom.status, 'ok');
if (hyphenThenAtom.status === 'ok') {
  assert.deepEqual(hyphenThenAtom.entry.breaks, [{ at: 3, hyphen: true }]);
}
assert.equal(matchParagraph(hyphenThenAtomSpec, [
  { text: 'abc-', y: 3.226 },
  { text: 'def', y: 21.976 },
], 0, undefined, new Map([[1, 0]])).status, 'fail');

// When Typst really wraps after the formula, the returned break is the
// atom's PM end (one offset), independent of how many SVG glyphs it painted.
const wrapped = matchParagraph(spec, [
  { text: 'Invariant', y: 0 },
  { text: 'remains stable', y: 18.75 },
], 0, undefined, new Map([[1, 0]]));
assert.equal(wrapped.status, 'ok');
if (wrapped.status === 'ok') {
  assert.deepEqual(wrapped.entry.breaks, [{ at: prefix.length + 1, hyphen: false }]);
  assert(wrapped.entry.breaks![0].at <= paragraph.content.size);
}

console.log('typst oracle tests passed');
