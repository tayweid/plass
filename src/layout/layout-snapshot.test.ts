import assert from 'node:assert/strict';
import { createLayoutSnapshot, snapshotBreaksFor } from './layout-snapshot';

const source = {
  revision: 7,
  documentKey: 'doc-v1',
  pageCount: 2,
  pageStarts: [{ pos: 18, line: 1, unit: 'line' }],
  blocks: [{ pos: 4, type: 'paragraph', contentKey: 'hello', breaks: [{ at: 8, hyphen: false }] }],
};
const snapshot = createLayoutSnapshot(source);

source.pageStarts[0].pos = 99;
source.blocks[0].breaks[0].at = 99;
assert.equal(snapshot.pageStarts?.[0].pos, 18);
assert.equal(snapshot.revision, 7);
assert.deepEqual(snapshotBreaksFor(snapshot, 4, 'hello'), [{ at: 8, hyphen: false }]);
assert.equal(snapshotBreaksFor(snapshot, 5, 'hello'), undefined);
assert.equal(snapshotBreaksFor(snapshot, 4, 'other'), undefined);
assert(Object.isFrozen(snapshot));
assert(Object.isFrozen(snapshot.blocks));
assert(Object.isFrozen(snapshot.blocks[0].breaks));

const lineOnly = createLayoutSnapshot({
  revision: 8,
  documentKey: 'partial',
  pageCount: 3,
  pageStarts: null,
  blocks: source.blocks,
});
assert.equal(lineOnly.pageStarts, null);
assert.deepEqual(snapshotBreaksFor(lineOnly, 4, 'hello'), [{ at: 99, hyphen: false }]);

console.log('layout snapshot tests passed');
