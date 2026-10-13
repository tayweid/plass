// The grid split's grammar and display (grid-split.ts): what the Grid
// layout panel's Custom field accepts and shows.
// Run: npx tsx src/grid-split.test.ts
import { canonicalShares, displayColumnShares, parseColumnShares, sameSplit, splitPresets, splitRatio } from './grid-split';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('grid-split:');

// Today's grammar, unchanged.
for (const [text, want] of [
  ['2 : 1', [2, 1]],
  ['2 1', [2, 1]],
  ['2,1', [2, 1]],
  ['60/40', [1.5, 1]],
  ['2fr 1fr', [2, 1]],
  ['1 : 1.174', [1, 1.174]],
] as const) check(`parses ${JSON.stringify(text)}`, eq(parseColumnShares(text), want), JSON.stringify(parseColumnShares(text)));

// Plus a trailing % per value.
check('parses percents', eq(parseColumnShares('46% : 54%'), [1, 1.174]), JSON.stringify(parseColumnShares('46% : 54%')));
check('parses 60% 40%', eq(parseColumnShares('60% 40%'), [1.5, 1]));
for (const bad of ['', '0 : 1', '-1 1', 'a : b', Array(13).fill('1').join(' ')]) {
  check(`rejects ${JSON.stringify(bad)}`, parseColumnShares(bad) === null);
}

// The display rule: a small whole ratio, else percents to 0.1.
check('ratio 1:4:1:4:1', displayColumnShares([1, 4, 1, 4, 1]) === '1 : 4 : 1 : 4 : 1', displayColumnShares([1, 4, 1, 4, 1]));
check('ratio 3:2 from 1.5:1', displayColumnShares([1.5, 1]) === '3 : 2', displayColumnShares([1.5, 1]));
check('ratio 1:1', displayColumnShares([1, 1]) === '1 : 1');
check('ratio from thirds', displayColumnShares([1, 1.333]) === '3 : 4', displayColumnShares([1, 1.333]));
check('percent 46% : 54%', displayColumnShares([1, 1.174]) === '46% : 54%', displayColumnShares([1, 1.174]));
check('percent compact', displayColumnShares([1, 1.174], true) === '46:54', displayColumnShares([1, 1.174], true));
check('percent to 0.1, trailing .0 dropped', displayColumnShares([1, 1.5, 7.1]) === '10.4% : 15.6% : 74%', displayColumnShares([1, 1.5, 7.1]));
check('no ratio past 12', splitRatio([1, 13]) === null);
// The display reads back as the same split.
for (const shares of [[1, 1.174], [1, 4, 1, 4, 1], [1.5, 1], [1, 2.37, 1.01]]) {
  const back = parseColumnShares(displayColumnShares(shares))!;
  check(`round trip ${shares.join(':')}`, sameSplit(back, shares), JSON.stringify(back));
}

// Presets for the current count only.
check('2-column presets', splitPresets(2).length === 5 && splitPresets(2).every((p) => p.length === 2));
check('3-column presets', splitPresets(3).length === 4 && splitPresets(3).every((p) => p.length === 3));
check('5 columns: Equal', eq(splitPresets(5), [[1, 1, 1, 1, 1]]));
check('canonical 2:3', eq(canonicalShares([2, 3]), [1, 1.5]));
check('same split by ratio', sameSplit([2, 1], [4, 2]) && !sameSplit([2, 1], [1, 2]) && !sameSplit([1, 1], [1, 1, 1]));

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all grid-split checks passed');
