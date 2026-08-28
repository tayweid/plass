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

const oneLine = matchParagraph(spec, sumRuns.slice(0, 1), 0);
assert.equal(oneLine.status, 'ok');
if (oneLine.status === 'ok') assert.deepEqual(oneLine.entry.breaks, []);

// When Typst really wraps after the formula, the returned break is the
// atom's PM end (one offset), independent of how many SVG glyphs it painted.
const wrapped = matchParagraph(spec, [
  { text: 'Invariant ∑𝑛𝑖=1𝑥𝑖', y: 0 },
  { text: 'remains stable', y: 18.75 },
], 0);
assert.equal(wrapped.status, 'ok');
if (wrapped.status === 'ok') {
  assert.deepEqual(wrapped.entry.breaks, [{ at: prefix.length + 1, hyphen: false }]);
  assert(wrapped.entry.breaks![0].at <= paragraph.content.size);
}

console.log('typst oracle tests passed');
