import assert from 'node:assert/strict';
import { EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { schema } from '../schema';
import type { LineLayout } from './paragraph';
import {
  appendLineDecorations,
  blockDecorationDigest,
  blockSpacerDecoration,
  decorationSetDigest,
  decorationSignature,
  decorationsOwnedByBlock,
  pageSpacerDecoration,
  rebuildDecorationsOwnedByBlock,
  removeDecorationsOwnedByBlock,
  stripActiveLineDecorations,
  type BlockDecorationScope,
  type TypesetDecorationKind,
} from './line-decorations';

function paragraph(text: string) {
  return schema.nodes.paragraph.create(null, schema.text(text));
}

function kindOf(decoration: Decoration): TypesetDecorationKind | undefined {
  return (decoration.spec as { tsKind?: TypesetDecorationKind }).tsKind;
}

function blockScope(pos: number, node: { nodeSize: number }): BlockDecorationScope {
  return { from: pos, to: pos + node.nodeSize };
}

function buildFirstDecorations(node: ReturnType<typeof paragraph>, spacing = 1.2344): Decoration[] {
  const lines: LineLayout[] = [
    { from: 0, to: 10, spacing, breakPos: 11, hyphen: false },
    { from: 11, to: 13, spacing: 0, breakPos: 13, hyphen: true },
    { from: 13, to: node.content.size, spacing: 0, breakPos: null, hyphen: false },
  ];
  const decorations: Decoration[] = [];
  appendLineDecorations(decorations, node, 0, lines);
  decorations.push(pageSpacerDecoration(5, 19.6, true));
  return decorations;
}

const first = paragraph('alpha beta hyphenation');
const second = paragraph('second paragraph ending');
const firstPos = 0;
const secondPos = first.nodeSize;
const doc = schema.nodes.doc.create(null, [first, second]);
const firstScope = blockScope(firstPos, first);
const secondScope = blockScope(secondPos, second);

const firstDecorations = buildFirstDecorations(first);
const secondDecorations: Decoration[] = [];
const secondLines: LineLayout[] = [
  { from: 0, to: 6, spacing: 0.875, breakPos: 7, hyphen: false },
  { from: 7, to: second.content.size, spacing: 0, breakPos: null, hyphen: false },
];
appendLineDecorations(secondDecorations, second, secondPos, secondLines);
const blockGap = blockSpacerDecoration({ pos: secondPos, height: 27.2, kind: 'block' });
const allDecorations = [...firstDecorations, ...secondDecorations, blockGap];

assert.deepEqual(
  new Set(allDecorations.map(kindOf)),
  new Set<TypesetDecorationKind>([
    'word-spacing',
    'line-break',
    'hyphen-break',
    'no-spell',
    'line-page-gap',
    'block-page-gap',
  ]),
);
assert(firstDecorations.some((decoration) => decoration.spec.sig === 'word-spacing:1.234px'));
assert(firstDecorations.some((decoration) => decoration.spec.sig === 'nospell'));
assert(firstDecorations.some((decoration) => decoration.spec.key === 'br:12'));
assert(firstDecorations.some((decoration) => decoration.spec.key === 'hy:14'));
assert(firstDecorations.some((decoration) => decoration.spec.key === 'pg:5:20:h'));
assert.equal(blockGap.spec.key, `pgb:${secondPos}:27`);
console.log('  ok  every emitted decoration has an explicit semantic kind without changing key/sig identity');

const originalOrder = allDecorations.slice();
assert.equal(decorationSignature(allDecorations), decorationSignature([...allDecorations].reverse()));
assert.deepEqual(allDecorations, originalOrder);
const set = DecorationSet.create(doc, allDecorations.slice());
assert.equal(decorationSetDigest(set), decorationSignature(allDecorations));
console.log('  ok  decoration digests are canonical and do not consume caller arrays');

assert.equal(decorationsOwnedByBlock(set, firstScope).length, firstDecorations.length);
assert.equal(decorationsOwnedByBlock(set, secondScope).length, secondDecorations.length);
assert(!decorationsOwnedByBlock(set, firstScope).includes(blockGap));
assert.equal(
  set.find(undefined, undefined, (spec) => spec.tsKind === 'block-page-gap').length,
  1,
);
console.log('  ok  range ownership excludes adjacent blocks and block-level page gaps');

const nativeFirst = stripActiveLineDecorations(set, firstScope);
assert.deepEqual(
  decorationsOwnedByBlock(nativeFirst, firstScope).map(kindOf),
  ['line-page-gap'],
);
assert.equal(blockDecorationDigest(nativeFirst, secondScope), blockDecorationDigest(set, secondScope));
assert.equal(nativeFirst.find(undefined, undefined, (spec) => spec.tsKind === 'block-page-gap').length, 1);
console.log('  ok  active-block handoff removes forced lines while retaining settled page geometry');

const sameReplacements = [...firstDecorations].reverse();
const sameReplacementsBefore = sameReplacements.slice();
const unchanged = rebuildDecorationsOwnedByBlock(set, doc, firstScope, sameReplacements);
assert.equal(unchanged.changed, false);
assert.equal(unchanged.decos, set);
assert.deepEqual(sameReplacements, sameReplacementsBefore);

const secondDigest = blockDecorationDigest(set, secondScope);
const changedReplacements = buildFirstDecorations(first, 2.125);
const changed = rebuildDecorationsOwnedByBlock(set, doc, firstScope, changedReplacements);
assert.equal(changed.changed, true);
assert.equal(changed.removed, firstDecorations.length);
assert.equal(changed.added, changedReplacements.length);
assert.equal(blockDecorationDigest(changed.decos, firstScope), changed.digest);
assert.equal(blockDecorationDigest(changed.decos, secondScope), secondDigest);
assert.equal(changed.decos.find(undefined, undefined, (spec) => spec.tsKind === 'block-page-gap').length, 1);

const removed = removeDecorationsOwnedByBlock(changed.decos, firstScope);
assert.equal(decorationsOwnedByBlock(removed, firstScope).length, 0);
assert.equal(blockDecorationDigest(removed, secondScope), secondDigest);
assert.equal(removed.find(undefined, undefined, (spec) => spec.tsKind === 'block-page-gap').length, 1);
assert.throws(
  () => rebuildDecorationsOwnedByBlock(set, doc, firstScope, [blockGap]),
  /not block-owned/,
);
console.log('  ok  equal rebuilds reuse the set and changed rebuilds leave no owned orphans');

// Absolute widget keys remain unchanged under mapping. The block digest must
// nevertheless compare equal when an insertion before the block merely moves
// all of its decorations together.
const inserted = paragraph('inserted before');
const state = EditorState.create({ schema, doc });
const tr = state.tr.insert(0, inserted);
const mapped = set.map(tr.mapping, tr.doc);
const movedSecondScope = blockScope(secondPos + inserted.nodeSize, second);
assert.equal(blockDecorationDigest(mapped, movedSecondScope), blockDecorationDigest(set, secondScope));
const mappedSecond = decorationsOwnedByBlock(mapped, movedSecondScope);
assert(mappedSecond.some((decoration) => decoration.spec.key === `br:${secondPos + 1 + 7}`));
const freshMovedSecond: Decoration[] = [];
appendLineDecorations(freshMovedSecond, second, movedSecondScope.from, secondLines);
assert(freshMovedSecond.some((decoration) => decoration.spec.key === `br:${movedSecondScope.from + 1 + 7}`));
assert.equal(decorationSignature(mappedSecond), decorationSignature(freshMovedSecond));
console.log('  ok  range ownership and relative digests survive mapping before a block');

// Nested footnote bodies own their own line decorations. An outer paragraph
// update can explicitly exclude the current mapped footnote node range.
const footnote = schema.nodes.footnote.create(null, schema.text('nested footnote words'));
const outer = schema.nodes.paragraph.create(null, [schema.text('outer '), footnote, schema.text(' ending words')]);
const outerDoc = schema.nodes.doc.create(null, [outer]);
const footnoteOffset = 6;
const footnotePos = 1 + footnoteOffset;
const nestedDecorations: Decoration[] = [];
appendLineDecorations(nestedDecorations, outer, 0, [
  { from: 0, to: outer.content.size, spacing: 0.5, breakPos: null, hyphen: false },
]);
const outerDecorationCount = nestedDecorations.length;
appendLineDecorations(nestedDecorations, footnote, footnotePos, [
  { from: 0, to: 6, spacing: 0.75, breakPos: 7, hyphen: false },
  { from: 7, to: footnote.content.size, spacing: 0, breakPos: null, hyphen: false },
]);
const nestedSet = DecorationSet.create(outerDoc, nestedDecorations.slice());
const footnoteScope = blockScope(footnotePos, footnote);
const outerWithoutFootnote: BlockDecorationScope = {
  ...blockScope(0, outer),
  exclude: [footnoteScope],
};
assert.equal(decorationsOwnedByBlock(nestedSet, outerWithoutFootnote).length, outerDecorationCount);
assert.equal(
  decorationsOwnedByBlock(nestedSet, footnoteScope).length,
  nestedDecorations.length - outerDecorationCount,
);
console.log('  ok  nested editable block exclusions prevent cross-owner removal');

console.log('\nall line decoration ownership tests passed');
