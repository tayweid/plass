import assert from 'node:assert/strict';
import {
  FOOTNOTE_CLEARANCE_EM,
  FOOTNOTE_GAP_EM,
  footnoteAreaHeight,
  footnoteEmptyFrameAction,
  footnoteEntryCost,
  footnoteEntryFit,
  footnoteHeadReservePx,
  settleFootnoteCarry,
  footnotePositions,
  footnoteSeparatorHeightPx,
  lineNeeds,
  fits,
  uniformRegions,
  isFull,
  mayBreak,
  mayProgress,
  regionsNext,
  SPACING_WEAKNESS,
  type FlowItem,
  keepSpacing,
  pushSpacing,
  trimSpacing,
  peekWeakSpacing,
  containerPageTopDropEm,
  lineNeedSpans,
  type LineNeedsOptions,
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

// --- footnoteEntryFit / settleFootnoteCarry -----------------------------
// Scenarios traced from Composer::footnote (flow/compose.rs, ~415-539),
// Composer::footnote_spill (~542-563) and Composer::column (~167-198).

const HEAD = footnoteHeadReservePx(F);
const GAP = FOOTNOTE_GAP_EM * F;

{
  // Everything fits: the ledger charge is identical to the pre-spill one
  // (footnoteEntryCost over the whole entry), with no carry.
  const entry = 40;
  const fit = footnoteEntryFit(entry, 500, false, F);
  assert.equal(fit.fragment, entry);
  assert.equal(fit.remainder, 0);
  assert.equal(fit.empty, false);
  assert.equal(footnoteEntryCost(fit.fragment, F), footnoteEntryCost(entry, F));
  // An exact-fit pod (available == head + gap + entry) still counts as fitting.
  const exact = footnoteEntryFit(entry, HEAD + GAP + entry, false, F);
  assert.equal(exact.fragment, entry);
  assert.equal(exact.remainder, 0);
  // A page that already carries footnotes charges no second separator, so
  // the same entry fits in a pod smaller by exactly the head reserve.
  const second = footnoteEntryFit(entry, GAP + entry, true, F);
  assert.equal(second.fragment, entry);
  assert.equal(second.remainder, 0);
  console.log('  ok  full fit is a no-op equivalent of footnoteEntryCost');
}

{
  // Partial fit, quantized DOWN to whole lines of the entry: a pod holding
  // 2.7 lines commits 2 and spills the rest.
  const line = 14;
  const entry = 5 * line;
  const pod = 2.7 * line;
  const fit = footnoteEntryFit(entry, HEAD + GAP + pod, false, F, { lineHeightPx: line });
  assert.equal(fit.fragment, 2 * line);
  assert.ok(Math.abs(fit.remainder - 3 * line) < 1e-9);
  assert.equal(fit.empty, false);
  // Without a known line height the fragment is a plain pixel clamp.
  const unquantized = footnoteEntryFit(entry, HEAD + GAP + pod, false, F);
  assert.ok(Math.abs(unquantized.fragment - pod) < 1e-9);
  assert.ok(Math.abs(unquantized.remainder - (entry - pod)) < 1e-9);
  console.log('  ok  partial fit keeps whole lines, spills the remainder');
}

{
  // Zero fit: less than one line of room. `empty` is Typst's
  // `first.is_empty() && exist_non_empty_frame` — the flag that hands the
  // decision to footnoteEmptyFrameAction.
  const line = 14;
  const fit = footnoteEntryFit(3 * line, HEAD + GAP + 0.9 * line, false, F, { lineHeightPx: line });
  assert.equal(fit.fragment, 0);
  assert.equal(fit.remainder, 3 * line);
  assert.equal(fit.empty, true);
  // A negative pod is the same case.
  assert.equal(footnoteEntryFit(3 * line, 0, false, F, { lineHeightPx: line }).empty, true);
  // A zero-height entry produces only empty frames, so `exist_non_empty_frame`
  // is false and Typst commits it rather than queueing: not `empty`.
  assert.equal(footnoteEntryFit(0, 0, false, F).empty, false);
  assert.equal(footnoteEntryFit(0, 0, false, F).fragment, 0);
  console.log('  ok  zero fit reports the empty-first-frame case');
}

{
  // The pod invariant the paginator's post-insertion recheck rests on
  // (Composer::footnote, compose.rs:448-450: `pod = remaining − flow_need −
  // separator − gap`): whatever fragment is committed, its ledger charge —
  // gap + fragment, plus the page's head reserve when this is the first
  // entry — never exceeds the space that was available below the marker's
  // frame. So inserting a line's own entries can never make that line stop
  // fitting; only a widow/orphan partner's room below it can be consumed.
  const line = 14;
  for (const has of [false, true]) {
    for (const entry of [line, 3 * line, 7 * line, 100]) {
      for (let avail = -20; avail <= 200; avail += 3.7) {
        for (const lineHeightPx of [undefined, line]) {
          const fit = footnoteEntryFit(entry, avail, has, F, { lineHeightPx });
          if (fit.empty) continue;
          const charge = footnoteEntryCost(fit.fragment, F) + (has ? 0 : HEAD);
          assert.ok(
            charge <= avail + 1e-6,
            `charge ${charge} exceeds avail ${avail} (entry ${entry}, has ${has}, lh ${lineHeightPx})`,
          );
          assert.ok(Math.abs(fit.fragment + fit.remainder - entry) < 1e-9);
        }
      }
    }
  }
  console.log('  ok  a committed fragment never charges more than the space below its marker');
}

{
  // Migrate/queue/place decision (compose.rs ~493-501).
  assert.equal(footnoteEmptyFrameAction(true, true, 100), 'migrate');
  // Not migratable (breakable frame, or a second footnote): queue.
  assert.equal(footnoteEmptyFrameAction(false, true, 100), 'queue');
  // No progress possible, but a non-zero flow need means the next page (with
  // flow need zero) can still be better: queue.
  assert.equal(footnoteEmptyFrameAction(true, false, 100), 'queue');
  // Alone in a pristine region with no flow need: lay it out anyway, or the
  // entry would migrate forever.
  assert.equal(footnoteEmptyFrameAction(true, false, 0), 'place');
  assert.equal(footnoteEmptyFrameAction(false, false, 0), 'place');
  console.log('  ok  empty-first-frame action mirrors migrate/queue/place');
}

{
  // Carry settle, single page: the whole carry fits, head charged once.
  const settled = settleFootnoteCarry([{ heightPx: 30 }, { heightPx: 20 }], 600, F);
  assert.deepEqual(settled.placed, [30, 20]);
  assert.deepEqual(settled.carry, []);
  const charged = settled.placed.reduce((sum, h) => sum + footnoteEntryCost(h, F), 0) + HEAD;
  assert.ok(Math.abs(charged - footnoteAreaHeight([30, 20], F)) < 1e-9);
  console.log('  ok  carry settle: a fitting pool charges exactly footnoteAreaHeight');
}

{
  // Nothing to settle is a strict no-op (documents without footnotes take
  // this path on every page advance).
  const settled = settleFootnoteCarry([], 600, F);
  assert.deepEqual(settled.placed, []);
  assert.deepEqual(settled.carry, []);
  console.log('  ok  carry settle: empty pool is a no-op');
}

{
  // Carry settle across MULTIPLE pages: one 3-page-tall spill is consumed a
  // page at a time, and the queued entry behind it waits its turn.
  const line = 10;
  const contentPx = 100;
  const perPage = Math.floor((contentPx - HEAD - GAP) / line) * line;
  const carry = [{ heightPx: 3 * perPage, lineHeightPx: line }, { heightPx: 25, lineHeightPx: line }];

  const p1 = settleFootnoteCarry(carry, contentPx, F);
  assert.deepEqual(p1.placed, [perPage]);
  // The clamp: head + gap + fragment never exceeds the page's content height.
  assert.ok(HEAD + GAP + p1.placed[0] <= contentPx);
  assert.equal(p1.carry.length, 2);
  assert.equal(p1.carry[0].heightPx, 2 * perPage);
  assert.equal(p1.carry[1].heightPx, 25);

  const p2 = settleFootnoteCarry(p1.carry, contentPx, F);
  assert.deepEqual(p2.placed, [perPage]);
  assert.equal(p2.carry[0].heightPx, perPage);

  // Final spill page: the last fragment takes the whole footnote area, so
  // the queued entry behind it still has no room and waits one more page.
  const p3 = settleFootnoteCarry(p2.carry, contentPx, F);
  assert.deepEqual(p3.placed, [perPage]);
  assert.equal(p3.carry.length, 1);
  assert.equal(p3.carry[0].heightPx, 25);

  const p4 = settleFootnoteCarry(p3.carry, contentPx, F);
  assert.deepEqual(p4.placed, [25]);
  assert.deepEqual(p4.carry, []);
  console.log('  ok  carry settle: one partial per page, queue drains behind the spill');
}

{
  // A queued entry that cannot fit behind the placed fragments carries on:
  // at most one PARTIAL placement per page, everything after it waits.
  const line = 10;
  const contentPx = HEAD + GAP + 3 * line + GAP + 1.5 * line;
  const settled = settleFootnoteCarry(
    [{ heightPx: 3 * line, lineHeightPx: line }, { heightPx: 4 * line, lineHeightPx: line }],
    contentPx,
    F,
  );
  assert.deepEqual(settled.placed, [3 * line, line]);
  assert.equal(settled.carry.length, 1);
  assert.ok(Math.abs(settled.carry[0].heightPx - 3 * line) < 1e-9);
  console.log('  ok  carry settle: second entry splits, its remainder re-carries');
}

{
  // A page too small for even one line of the head: nothing is placed and
  // the whole pool carries (the page still shows no footnote area, since the
  // caller charges only what `placed` reports).
  const settled = settleFootnoteCarry([{ heightPx: 40, lineHeightPx: 10 }], HEAD, F);
  assert.deepEqual(settled.placed, []);
  assert.equal(settled.carry.length, 1);
  assert.equal(settled.carry[0].heightPx, 40);
  console.log('  ok  carry settle: an unplaceable pool carries whole');
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

// --- Regions (typst-library/src/layout/regions.rs) ------------------------

{
  assert.equal(fits(10, 10), true);
  assert.equal(fits(10, 10 + 1e-5), true); // within ABS_EPS
  assert.equal(fits(10, 10.1), false);
  assert.equal(fits(0, 0), true);
  console.log('  ok  fits: container holds content within EPS slack, Abs::fits semantics');
}

{
  const r = uniformRegions(500, 800);
  assert.equal(r.size, 500);
  assert.equal(r.full, 800);
  assert.deepEqual(r.backlog, []);
  assert.equal(r.last, 800);
  console.log('  ok  uniformRegions: same-height pages repeat via `last`, empty backlog');
}

{
  // is_full: Abs::zero().fits(size.y) && may_progress() — full exactly when
  // the remaining space is ~0 AND a next region would actually differ.
  assert.equal(isFull(uniformRegions(0, 800)), true);
  assert.equal(isFull(uniformRegions(1e-5, 800)), true); // within EPS of zero
  assert.equal(isFull(uniformRegions(5, 800)), false);
  // A region already at its own repeating height ("last") is not "full"
  // even at size 0 in the pathological single-region case (no progress
  // possible): mayProgress() is false when size === last.
  assert.equal(isFull({ size: 0, full: 0, backlog: [], last: 0 }), false);
  console.log('  ok  isFull: zero-remaining AND a next region could help');
}

{
  assert.equal(mayBreak(uniformRegions(500, 800)), true);
  assert.equal(mayBreak({ size: 500, full: 800, backlog: [], last: null }), false);
  assert.equal(mayBreak({ size: 500, full: 800, backlog: [200], last: null }), true);
  console.log('  ok  mayBreak: a following region exists (backlog or last)');
}

{
  // may_progress: false exactly when advancing changes nothing (empty
  // backlog, and `last` repeats the CURRENT size) — Typst's guard against
  // migrating forever into regions that can never fit the content.
  assert.equal(mayProgress(uniformRegions(500, 800)), true); // size(500) != last(800)
  assert.equal(mayProgress({ size: 800, full: 800, backlog: [], last: 800 }), false);
  assert.equal(mayProgress({ size: 800, full: 800, backlog: [800], last: 800 }), true);
  assert.equal(mayProgress({ size: 800, full: 800, backlog: [], last: null }), false);
  console.log('  ok  mayProgress: false iff the next region would be identical');
}

{
  const r = regionsNext(uniformRegions(120, 800));
  assert.equal(r.size, 800);
  assert.equal(r.full, 800);
  console.log('  ok  regionsNext: uniform pages advance to a fresh full region');
}

{
  const r = regionsNext({ size: 50, full: 800, backlog: [600, 700], last: 800 });
  assert.equal(r.size, 600);
  assert.equal(r.full, 600);
  assert.deepEqual(r.backlog, [700]);
  const r2 = regionsNext(r);
  assert.equal(r2.size, 700);
  assert.deepEqual(r2.backlog, []);
  const r3 = regionsNext(r2);
  assert.equal(r3.size, 800); // backlog drained: repeats `last`
  console.log('  ok  regionsNext: backlog drains before repeating `last`');
}

// --- Spacing collapse (flow/distribute.rs::{rel,keep_spacing,trim_spacing})
// Scenarios mirror the Rust: weak-at-top drops, dominance replacement,
// trailing trim.

function content(): FlowItem {
  return { kind: 'content' };
}

{
  // Weak spacing at region top (nothing precedes it at all) drops entirely
  // — AND does not charge the region's remaining size, since it was never
  // actually kept.
  const items: FlowItem[] = [];
  const r = uniformRegions(500, 800);
  pushSpacing(r, items, 12, SPACING_WEAKNESS.blockAuto);
  assert.deepEqual(items, []);
  assert.equal(r.size, 500);
  console.log('  ok  weak spacing at region top drops entirely, charging nothing');
}

{
  // Weak spacing right after content (nothing pending) is kept as a normal
  // new item, and its amount is charged against the region.
  const items: FlowItem[] = [content()];
  const r = uniformRegions(500, 800);
  pushSpacing(r, items, 12, SPACING_WEAKNESS.blockAuto);
  assert.deepEqual(items, [content(), { kind: 'spacing', amount: 12, weakness: SPACING_WEAKNESS.blockAuto }]);
  assert.equal(r.size, 488);
  console.log('  ok  weak spacing right after content is kept and charged');
}

{
  // Strong spacing (weakness 0) is transparent to the region-top scan: a
  // weak item that only has strong spacing ahead of it still drops.
  const items: FlowItem[] = [{ kind: 'spacing', amount: 3, weakness: SPACING_WEAKNESS.explicit }];
  const r = uniformRegions(500, 800);
  pushSpacing(r, items, 12, SPACING_WEAKNESS.blockAuto);
  assert.deepEqual(items, [{ kind: 'spacing', amount: 3, weakness: SPACING_WEAKNESS.explicit }]);
  assert.equal(r.size, 500);
  console.log('  ok  strong spacing is transparent: a weak item behind only strong spacing still drops at top');
}

{
  // Dominance: a strictly stronger (lower-numbered) weak item REPLACES a
  // pending weaker one, regardless of amount (heading `above`, weakness 3,
  // displacing a smaller-tier paragraph auto-spacing, weakness 4). The
  // region is only charged the DELTA (3 - 5 = -2: it gets 2 back).
  const items: FlowItem[] = [content(), { kind: 'spacing', amount: 5, weakness: SPACING_WEAKNESS.blockAuto }];
  const r = uniformRegions(500, 800);
  pushSpacing(r, items, 3, SPACING_WEAKNESS.blockExplicit);
  assert.deepEqual(items, [content(), { kind: 'spacing', amount: 3, weakness: SPACING_WEAKNESS.blockExplicit }]);
  assert.equal(r.size, 502);
  console.log('  ok  a strictly stronger weak item replaces a pending weaker one outright (even if smaller)');
}

{
  // Dominance: a strictly WEAKER item never displaces a pending stronger
  // one, even if larger in amount — and never charges the region either.
  const items: FlowItem[] = [content(), { kind: 'spacing', amount: 3, weakness: SPACING_WEAKNESS.blockExplicit }];
  const r = uniformRegions(500, 800);
  pushSpacing(r, items, 100, SPACING_WEAKNESS.blockAuto);
  assert.deepEqual(items, [content(), { kind: 'spacing', amount: 3, weakness: SPACING_WEAKNESS.blockExplicit }]);
  assert.equal(r.size, 500);
  console.log('  ok  a strictly weaker item never displaces a pending stronger one, however large');
}

{
  // Dominance at a tie: same weakness, the LARGER amount replaces (e.g. two
  // adjacent headings' explicit above/below both at weakness 3), charging
  // only the incremental delta.
  const items: FlowItem[] = [content(), { kind: 'spacing', amount: 5, weakness: SPACING_WEAKNESS.blockExplicit }];
  const r = uniformRegions(500, 800);
  pushSpacing(r, items, 8, SPACING_WEAKNESS.blockExplicit);
  assert.deepEqual(items, [content(), { kind: 'spacing', amount: 8, weakness: SPACING_WEAKNESS.blockExplicit }]);
  assert.equal(r.size, 497);
  console.log('  ok  tied weakness: the larger amount replaces the smaller');
}

{
  // Dominance at a tie: same weakness, an EQUAL or SMALLER amount does NOT
  // replace — the first (earlier-pushed) item survives. This is exactly why
  // two ordinary adjacent paragraphs (same par.spacing amount, both
  // weakness 4) only ever produce ONE gap, not two summed.
  const items: FlowItem[] = [content(), { kind: 'spacing', amount: 8, weakness: SPACING_WEAKNESS.blockAuto }];
  const r = uniformRegions(500, 800);
  pushSpacing(r, items, 8, SPACING_WEAKNESS.blockAuto); // equal amount, same weakness
  assert.deepEqual(items, [content(), { kind: 'spacing', amount: 8, weakness: SPACING_WEAKNESS.blockAuto }]);
  pushSpacing(r, items, 3, SPACING_WEAKNESS.blockAuto); // smaller amount, same weakness
  assert.deepEqual(items, [content(), { kind: 'spacing', amount: 8, weakness: SPACING_WEAKNESS.blockAuto }]);
  assert.equal(r.size, 500);
  console.log('  ok  tied weakness, equal-or-smaller amount: the earlier item survives unchanged');
}

{
  // keepSpacing never appends the candidate itself — callers rely on this:
  // when it returns false (drop or in-place replace), `items.length` is
  // unchanged relative to before the call.
  const items: FlowItem[] = [content(), { kind: 'spacing', amount: 5, weakness: SPACING_WEAKNESS.blockAuto }];
  const r = uniformRegions(500, 800);
  const lenBefore = items.length;
  const kept = keepSpacing(r, items, 2, SPACING_WEAKNESS.blockAuto);
  assert.equal(kept, false);
  assert.equal(items.length, lenBefore);
  console.log('  ok  keepSpacing never grows items itself: callers push only when it returns true');
}

{
  // Trailing weak spacing trims at region end (finalize()'s trim_spacing),
  // giving the trimmed amount back to the region.
  const items: FlowItem[] = [content(), { kind: 'spacing', amount: 7, weakness: SPACING_WEAKNESS.blockAuto }];
  const r = uniformRegions(100, 800);
  const trimmed = trimSpacing(r, items);
  assert.equal(trimmed, 7);
  assert.deepEqual(items, [content()]);
  assert.equal(r.size, 107);
  console.log('  ok  trailing weak spacing trims at region end and is credited back');
}

{
  // trim_spacing scans past strong spacing (transparent) to find the
  // trailing weak item.
  const items: FlowItem[] = [
    content(),
    { kind: 'spacing', amount: 7, weakness: SPACING_WEAKNESS.blockAuto },
    { kind: 'spacing', amount: 2, weakness: SPACING_WEAKNESS.explicit },
  ];
  const r = uniformRegions(100, 800);
  const trimmed = trimSpacing(r, items);
  assert.equal(trimmed, 7);
  assert.deepEqual(items, [content(), { kind: 'spacing', amount: 2, weakness: SPACING_WEAKNESS.explicit }]);
  console.log('  ok  trim_spacing scans past strong spacing to reach the trailing weak item');
}

{
  // Nothing trails (region ends right on content, or is empty): trim is a
  // no-op, returning 0 and leaving the region untouched.
  const r = uniformRegions(100, 800);
  assert.equal(trimSpacing(r, [content()]), 0);
  assert.equal(trimSpacing(r, []), 0);
  assert.equal(r.size, 100);
  console.log('  ok  trim_spacing is a no-op with nothing weak trailing');
}

{
  // weak_spacing peeks without mutating.
  const items: FlowItem[] = [content(), { kind: 'spacing', amount: 4, weakness: SPACING_WEAKNESS.blockAuto }];
  assert.equal(peekWeakSpacing(items), 4);
  assert.equal(items.length, 2);
  assert.equal(peekWeakSpacing([content()]), 0);
  console.log('  ok  peekWeakSpacing reads the trailing weak amount without removing it');
}

// --- containerPageTopDropEm ------------------------------------------------

{
  assert.equal(containerPageTopDropEm('blockquote'), 0.66);
  assert.equal(containerPageTopDropEm('code_block'), 0.8);
  assert.equal(containerPageTopDropEm('code_block', true), 0); // typst-raw: no padding-top
  assert.equal(containerPageTopDropEm('figure'), 0.4);
  assert.equal(containerPageTopDropEm('bullet_list'), 0); // no padding-top to drop
  assert.equal(containerPageTopDropEm('table'), 0);
  assert.equal(containerPageTopDropEm('paragraph'), 0); // handled by pageTopAdjustEm instead
  console.log('  ok  containerPageTopDropEm: only the padded container kinds drop, typst-raw excluded');
}

// --- lineNeedSpans ------------------------------------------------------
// Same scenarios as the lineNeeds suite above, checking the span's END
// INDEX instead of the need's height.

{
  // Single line: no pairing possible either direction.
  assert.deepEqual(lineNeedSpans(1), [0]);
  console.log('  ok  1-line paragraph: span is just the line itself');
}

{
  // 2-line paragraph, both non-empty: orphan pairs [0,1]; line 1 spans only
  // itself.
  assert.deepEqual(lineNeedSpans(2), [1, 1]);
  console.log('  ok  2-line paragraph: orphan span covers both lines');
}

{
  // 2-line paragraph, line 1 empty: no partner, no pairing.
  assert.deepEqual(lineNeedSpans(2, { isEmpty: (i) => i === 1 }), [0, 1]);
  console.log('  ok  2-line paragraph, empty line 1: orphan span disabled');
}

{
  // 3-line paragraph, both guards active: prevent_all — line 0's span
  // covers all three lines.
  assert.deepEqual(lineNeedSpans(3), [2, 1, 2]);
  console.log('  ok  3-line paragraph: prevent_all span covers all three lines');
}

{
  // 3-line paragraph, middle line empty: both guards disabled.
  assert.deepEqual(lineNeedSpans(3, { isEmpty: (i) => i === 1 }), [0, 1, 2]);
  console.log('  ok  3-line paragraph, empty middle line: prevent_all span disabled');
}

{
  // 4-line paragraph, all non-empty: orphan spans [0,1], widow spans [2,3]
  // independently.
  assert.deepEqual(lineNeedSpans(4), [1, 1, 3, 3]);
  console.log('  ok  4-line paragraph: orphan and widow spans are independent pairs');
}

{
  // 4-line paragraph, line 1 (orphan partner) empty: only orphan disabled.
  assert.deepEqual(lineNeedSpans(4, { isEmpty: (i) => i === 1 }), [0, 1, 3, 3]);
  console.log('  ok  4-line paragraph, empty line 1: orphan span disabled, widow intact');
}

{
  // 4-line paragraph, line 2 (widow partner) empty: only widow disabled.
  assert.deepEqual(lineNeedSpans(4, { isEmpty: (i) => i === 2 }), [1, 1, 2, 3]);
  console.log('  ok  4-line paragraph, empty line 2: widow span disabled, orphan intact');
}

{
  // preventOrphans/preventWidows opt-outs disable spans exactly like they
  // disable needs.
  assert.deepEqual(lineNeedSpans(3, { preventOrphans: false, preventWidows: false }), [0, 1, 2]);
  console.log('  ok  both costs disabled: spans equal own index (opt-out honored)');
}

{
  // Agreement test: for every scenario above, `needs[i] > heights[i]`
  // exactly when `spans[i] > i` — the two functions must never disagree on
  // which lines are grouped.
  const scenarios: Array<{ heights: number[]; opts?: LineNeedsOptions }> = [
    { heights: [10] },
    { heights: [10, 12] },
    { heights: [10, 12], opts: { isEmpty: (i) => i === 1 } },
    { heights: [10, 12, 14] },
    { heights: [10, 12, 14], opts: { isEmpty: (i) => i === 1 } },
    { heights: [10, 12, 14, 16] },
    { heights: [10, 12, 14, 16], opts: { isEmpty: (i) => i === 1 } },
    { heights: [10, 12, 14, 16], opts: { isEmpty: (i) => i === 2 } },
    { heights: [10, 12, 14], opts: { preventOrphans: false, preventWidows: false } },
  ];
  for (const { heights, opts } of scenarios) {
    const needs = lineNeeds(heights, LEAD, opts);
    const spans = lineNeedSpans(heights.length, opts);
    for (let i = 0; i < heights.length; i++) {
      assert.equal(needs[i] > heights[i], spans[i] > i, `mismatch at i=${i} for heights=${heights}`);
    }
  }
  console.log('  ok  needs[i] > heights[i] exactly when spans[i] > i, across all scenarios');
}

console.log('all flow-rules tests passed');
