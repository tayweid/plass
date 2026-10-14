// Display geometry with editorial comments: sheets grow by their notes,
// later sheets move down by the cumulative amount, print pages stay
// uniform. Run: npx tsx src/layout/page-geometry.test.ts
import { displayPages, printPageIndex, stackHeight } from './page-geometry';
import { createPaginationSnapshot } from './pagination-snapshot';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

{
  const pages = displayPages(3, 1056, 28, [100, 0, 40.5]);
  check('first sheet at the top, grown by its notes', pages[0].top === 0 && pages[0].height === 1156 && pages[0].extra === 100);
  check('second sheet moves down by the first sheet growth', pages[1].top === 1156 + 28 && pages[1].height === 1056);
  check('third sheet cumulative', pages[2].top === 1156 + 28 + 1056 + 28 && pages[2].height === 1096.5);
  check('stack height is the last sheet bottom', stackHeight(pages) === pages[2].top + 1096.5);
  check('no notes: the classic k·(H+gap) stride', JSON.stringify(displayPages(2, 1056, 28, [])) === JSON.stringify([{ top: 0, height: 1056, extra: 0 }, { top: 1084, height: 1056, extra: 0 }]));
  check('a negative or missing extra counts as zero', displayPages(2, 10, 1, [-5])[0].height === 10 && displayPages(2, 10, 1, [])[1].extra === 0);
  check('empty stack', stackHeight([]) === 0);
}

{
  check('print page index: uniform pages', printPageIndex(0, 1056, 28, 4) === 0 && printPageIndex(1083.9, 1056, 28, 4) === 0 && printPageIndex(1084, 1056, 28, 4) === 1);
  check('print page index clamps', printPageIndex(-3, 1056, 28, 4) === 0 && printPageIndex(99999, 1056, 28, 4) === 3 && printPageIndex(Number.NaN, 1056, 28, 4) === 0);
}

{
  // A note between two blocks: keyed at its END, so the note's own start
  // subtracts nothing of itself while everything after subtracts it all.
  const snap = createPaginationSnapshot({ spacers: [{ pos: 40, height: 300 }], tableExtras: [], comments: [{ pos: 20, height: 60 }] });
  check('snapshot carries the comments', snap.comments.length === 1 && snap.commentHeights.heightAbove(19) === 0 && snap.commentHeights.heightAbove(20) === 60);
  check('the combined index sums spacers and comments', snap.heights.heightAbove(19) === 0 && snap.heights.heightAbove(20) === 60 && snap.heights.heightAbove(40) === 360);
  check('zero-height comments are dropped', createPaginationSnapshot({ spacers: [], tableExtras: [], comments: [{ pos: 5, height: 0 }] }).comments.length === 0);
  check('comments default to none', createPaginationSnapshot({ spacers: [], tableExtras: [] }).commentHeights.totalHeight === 0);
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('page-geometry: all checks passed');
