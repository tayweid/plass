import assert from 'node:assert/strict';
import {
  HeightIndex,
  createPaginationSnapshot,
  type PaginationHeightSample,
} from './pagination-snapshot';

function linearHeightAbove(samples: readonly PaginationHeightSample[], pos: number): number {
  let height = 0;
  for (const sample of [...samples].sort((a, b) => a.pos - b.pos)) {
    if (sample.pos <= pos) height += sample.height;
    else break;
  }
  return height;
}

const spacers = [
  { pos: 10, height: 5 },
  { pos: 20, height: 0 },
  { pos: 30, height: -5 },
  { pos: Number.POSITIVE_INFINITY, height: 50 },
  { pos: 10, height: 2.5 },
  { pos: 15, height: 3 },
  { pos: 40, height: Number.NaN },
];
const tableExtras = [
  { pos: 5, height: -2 },
  { pos: 10, height: -1 },
  { pos: 15, height: 0 },
  { pos: 20, height: 4 },
  { pos: Number.NaN, height: 100 },
];
const snapshot = createPaginationSnapshot({ spacers, tableExtras });

assert.deepEqual(snapshot.spacers, [
  { pos: 10, height: 5 },
  { pos: 10, height: 2.5 },
  { pos: 15, height: 3 },
]);
assert.deepEqual(snapshot.tableExtras, [
  { pos: 5, height: -2 },
  { pos: 10, height: -1 },
  { pos: 15, height: 0 },
  { pos: 20, height: 4 },
]);
assert.equal(snapshot.heights.size, 7);
console.log('  ok  snapshots filter invalid/page-gap heights while preserving signed table extras');

const captured = [...snapshot.spacers, ...snapshot.tableExtras];
for (const pos of [Number.NEGATIVE_INFINITY, 4.99, 5, 9, 10, 15, 20, 100, Number.POSITIVE_INFINITY]) {
  assert.equal(snapshot.heights.heightAbove(pos), linearHeightAbove(captured, pos));
}
assert.equal(snapshot.heights.heightAbove(10), 4.5);
assert.equal(snapshot.heights.heightAbove(Number.POSITIVE_INFINITY), 11.5);
assert.equal(snapshot.heights.heightAbove(Number.NaN), 0);
console.log('  ok  upper-bound lookup matches the inclusive linear reference at duplicates and Infinity');

const orderSensitive = createPaginationSnapshot({
  spacers: [
    { pos: 8, height: 1e16 },
    { pos: 8, height: 1 },
  ],
  tableExtras: [{ pos: 8, height: -1e16 }],
});
assert.equal(orderSensitive.heights.heightAbove(8), 0);
assert.equal(
  orderSensitive.heights.heightAbove(8),
  linearHeightAbove([...orderSensitive.spacers, ...orderSensitive.tableExtras], 8),
);
console.log('  ok  duplicate positions retain spacer-then-table stable addition order');

spacers[0].height = 500;
spacers.push({ pos: 1, height: 500 });
tableExtras[0].height = 500;
assert.equal(snapshot.heights.heightAbove(Number.POSITIVE_INFINITY), 11.5);
assert.deepEqual(snapshot.spacers[0], { pos: 10, height: 5 });
assert(Object.isFrozen(snapshot));
assert(Object.isFrozen(snapshot.spacers));
assert(Object.isFrozen(snapshot.spacers[0]));
console.log('  ok  a captured pass is isolated from later source mutation');

const signed = new HeightIndex([
  { pos: 2, height: 0.1 },
  { pos: 2, height: 0.2 },
  { pos: 3, height: -0.05 },
  { pos: Number.POSITIVE_INFINITY, height: 100 },
  { pos: 4, height: Number.NaN },
]);
assert.equal(signed.size, 3);
assert.equal(signed.heightAbove(2), 0.1 + 0.2);
assert.equal(signed.heightAbove(Number.POSITIVE_INFINITY), 0.1 + 0.2 - 0.05);
assert.equal(new HeightIndex([]).heightAbove(Number.POSITIVE_INFINITY), 0);
console.log('  ok  HeightIndex stores finite signed samples with Float64 prefix sums');

let seed = 0x5eed1234;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x1_0000_0000;
};
for (let run = 0; run < 100; run++) {
  const samples = Array.from({ length: 80 }, () => ({
    pos: Math.floor(random() * 25),
    height: (random() - 0.35) * 200,
  }));
  const index = new HeightIndex(samples);
  for (let query = -1; query <= 26; query += 0.5) {
    assert.equal(index.heightAbove(query), linearHeightAbove(samples, query));
  }
}
console.log('  ok  seeded randomized queries remain byte-identical to the legacy scan');

console.log('\nall pagination snapshot tests passed');
