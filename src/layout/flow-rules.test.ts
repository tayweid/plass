import assert from 'node:assert/strict';
import {
  FOOTNOTE_CLEARANCE_EM,
  FOOTNOTE_GAP_EM,
  footnoteAreaHeight,
  footnoteEntryCost,
  footnoteHeadReservePx,
  footnotePositions,
  footnoteSeparatorHeightPx,
  lineNeeds,
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

// --- lineNeeds --------------------------------------------------------
// Scenarios traced from Collector::lines (flow/collect.rs, ~196-238).

const LEAD = 6; // an arbitrary leading, distinct from any height below

{
  // Single line: len < 2, no pairing possible either direction.
  assert.deepEqual(lineNeeds([10], LEAD), [10]);
  console.log('  ok  1-line paragraph: needs equal own heights (no pairing)');
}

{
  // 2-line paragraph, both non-empty: orphan protects the only pair. The
  // widow branch's own `i >= 2` guard means it never fires separately for
  // len == 2 — both guards would otherwise target the same index.
  const heights = [10, 12];
  assert.deepEqual(lineNeeds(heights, LEAD), [10 + LEAD + 12, 12]);
  console.log('  ok  2-line paragraph: orphan need covers both lines, line 1 unchanged');
}

{
  // 2-line paragraph, second (only) line empty: no partner to anchor on,
  // so no pairing at all — needs fall back to own heights.
  const heights = [10, 12];
  assert.deepEqual(lineNeeds(heights, LEAD, { isEmpty: (i) => i === 1 }), [10, 12]);
  console.log('  ok  2-line paragraph, empty line 1: orphan guard disabled, no need inflation');
}

{
  // 3-line paragraph, both guards active: prevent_all — line 0's need
  // covers all three lines; lines 1 and 2 stay at their own heights.
  const heights = [10, 12, 14];
  assert.deepEqual(lineNeeds(heights, LEAD), [10 + LEAD + 12 + LEAD + 14, 12, 14]);
  console.log('  ok  3-line paragraph: prevent_all groups all three lines under need[0]');
}

{
  // 3-line paragraph, middle line (the shared orphan/widow partner index)
  // empty: both guards disabled — no grouping anywhere.
  const heights = [10, 12, 14];
  assert.deepEqual(lineNeeds(heights, LEAD, { isEmpty: (i) => i === 1 }), heights);
  console.log('  ok  3-line paragraph, empty middle line: prevent_all disabled entirely');
}

{
  // 4-line paragraph, all non-empty: orphan groups [0,1], widow groups
  // [2,3] (the true second-to-last/last pair) — independently, since
  // prevent_all only applies at exactly 3 lines.
  const heights = [10, 12, 14, 16];
  assert.deepEqual(lineNeeds(heights, LEAD), [
    10 + LEAD + 12,
    12,
    14 + LEAD + 16,
    16,
  ]);
  console.log('  ok  4-line paragraph: orphan and widow needs are independent pairs');
}

{
  // 4-line paragraph, line 1 (orphan partner) empty: only the orphan
  // pairing is disabled; widow's pairing (different index) is untouched.
  const heights = [10, 12, 14, 16];
  const needs = lineNeeds(heights, LEAD, { isEmpty: (i) => i === 1 });
  assert.deepEqual(needs, [10, 12, 14 + LEAD + 16, 16]);
  console.log('  ok  4-line paragraph, empty line 1: orphan disabled, widow intact');
}

{
  // 4-line paragraph, line 2 (widow partner, len-2) empty: only the widow
  // pairing is disabled; orphan's pairing is untouched.
  const heights = [10, 12, 14, 16];
  const needs = lineNeeds(heights, LEAD, { isEmpty: (i) => i === 2 });
  assert.deepEqual(needs, [10 + LEAD + 12, 12, 14, 16]);
  console.log('  ok  4-line paragraph, empty line 2: widow disabled, orphan intact');
}

{
  // Boundary: needs are additive but otherwise dimensionless — a "does
  // this fit" comparison one unit under vs. exactly at the threshold sees
  // the difference cleanly (no accidental rounding baked into the port).
  const heights = [10, 12];
  const need0 = lineNeeds(heights, LEAD)[0];
  assert.equal(need0, 28);
  assert.ok(27 < need0 && need0 <= 28);
  console.log('  ok  need is exact — no slack folded into the port itself');
}

{
  // Cost-gated toggles off (costs == 0 in Typst): no prevention at all,
  // needs degrade to plain per-line heights regardless of length.
  const heights = [10, 12, 14];
  assert.deepEqual(
    lineNeeds(heights, LEAD, { preventOrphans: false, preventWidows: false }),
    heights,
  );
  console.log('  ok  both costs disabled: needs equal own heights (opt-out honored)');
}

console.log('all flow-rules tests passed');
