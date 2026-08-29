import assert from 'node:assert/strict';
import {
  FOOTNOTE_CLEARANCE_EM,
  FOOTNOTE_GAP_EM,
  footnoteAreaHeight,
  footnoteEntryCost,
  footnoteHeadReservePx,
  footnotePositions,
  footnoteSeparatorHeightPx,
} from './flow-rules';

const F = 16.666666666666668; // bodyPx at the app default (12.5pt @ 96dpi)

// --- footnoteAreaHeight --------------------------------------------------

{
  assert.equal(footnoteAreaHeight([], F), 0);
  console.log('  ok  no entries reserves nothing');
}

{
  const h1 = 20;
  const expected = FOOTNOTE_CLEARANCE_EM * F + footnoteSeparatorHeightPx() + FOOTNOTE_GAP_EM * F + h1;
  assert.ok(Math.abs(footnoteAreaHeight([h1], F) - expected) < 1e-9);
  console.log('  ok  single entry: clearance + separator + one gap + height');
}

{
  const heights = [20, 15, 30];
  const head = footnoteHeadReservePx(F);
  const expected = head + heights.reduce((sum, h) => sum + footnoteEntryCost(h, F), 0);
  assert.ok(Math.abs(footnoteAreaHeight(heights, F) - expected) < 1e-9);
  // n gaps for n entries (one precedes each, including the first — between
  // the separator and entry 1 — none trails the last).
  const naive = head + heights.reduce((s, h) => s + h, 0) + FOOTNOTE_GAP_EM * F * heights.length;
  assert.ok(Math.abs(footnoteAreaHeight(heights, F) - naive) < 1e-9);
  console.log('  ok  n entries charge n gaps, once-per-page head reservation');
}

// --- footnoteEntryCost ----------------------------------------------------

{
  assert.equal(footnoteEntryCost(0, F), FOOTNOTE_GAP_EM * F);
  assert.equal(footnoteEntryCost(10, F), FOOTNOTE_GAP_EM * F + 10);
  console.log('  ok  entry cost is gap + height');
}

// --- footnotePositions ------------------------------------------------

{
  const heights = [20, 15, 30];
  const bottomEdgeY = 1000;
  const { separatorTop, entryTops } = footnotePositions(heights, F, bottomEdgeY);

  // The reserved region starts exactly `footnoteAreaHeight` above the edge,
  // and clearance is the space between that start and the separator.
  const regionTop = bottomEdgeY - footnoteAreaHeight(heights, F);
  assert.ok(Math.abs(separatorTop - (regionTop + FOOTNOTE_CLEARANCE_EM * F)) < 1e-9);

  // Entry 1 sits `gap + separator height` below the separator's top.
  assert.ok(
    Math.abs(entryTops[0] - (separatorTop + footnoteSeparatorHeightPx() + FOOTNOTE_GAP_EM * F)) < 1e-9,
  );

  // Each subsequent entry sits `gap` below the previous entry's bottom.
  for (let i = 1; i < heights.length; i++) {
    assert.ok(Math.abs(entryTops[i] - (entryTops[i - 1] + heights[i - 1] + FOOTNOTE_GAP_EM * F)) < 1e-9);
  }

  // The last entry's bottom lands exactly on the page's content bottom edge
  // — no gap is reserved past the last entry.
  const last = heights.length - 1;
  assert.ok(Math.abs(entryTops[last] + heights[last] - bottomEdgeY) < 1e-9);

  console.log('  ok  positions match Insertions::finalize placement exactly');
}

console.log('all flow-rules tests passed');
