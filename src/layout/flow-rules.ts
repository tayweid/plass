// Ported decision rules from Typst's page/flow breaker (PAGE-PORT.md),
// mirroring pinned vendor/typst @ 951788cc so local pagination reserves and
// paints exactly what the compiled answer does. Each rule lands here as a
// pure function, shared by the full fallback pass and the suffix pass
// (`src/typeset-plugin.ts`) so neither can drift from the other.

/**
 * Footnote separator/reservation constants, ported from Typst's defaults
 * (typst-library/src/model/footnote.rs, `FootnoteEntry::clearance`/`gap`,
 * and the default `separator` line's `Abs::pt(0.5)` stroke). The exporter
 * (typ-serializer.ts) emits no `#set footnote.entry(...)` override, so these
 * unmodified defaults are exactly what the compiled document obeys.
 *
 * `clearance` and `gap` are `Em` lengths that resolve against the BODY text
 * size, not the footnote entry's own 0.85em content size: Typst builds the
 * flow's `FootnoteConfig` from the style chain active where the flow itself
 * is laid out (typst-layout/src/flow/mod.rs::configuration), before the
 * entry's `ShowSet` narrows text size to 0.85em for rendering the entry's
 * own content. Hence both convert with the paginator's `bodyPx` (the same
 * body font-size source used everywhere else in the paginator).
 *
 * The separator stroke is an ABSOLUTE `Abs::pt(0.5)`, not an `Em` — its
 * height is independent of the document's body font size.
 */
export const FOOTNOTE_CLEARANCE_EM = 1;
export const FOOTNOTE_GAP_EM = 0.5;
export const FOOTNOTE_SEPARATOR_PT = 0.5;

/** CSS pt → px (96 px/in ÷ 72 pt/in). */
export const PT_TO_PX = 96 / 72;

/** The footnote separator's own painted height (px) — a fixed physical
 * 0.5pt stroke, independent of body font size. */
export function footnoteSeparatorHeightPx(): number {
  return FOOTNOTE_SEPARATOR_PT * PT_TO_PX;
}

/**
 * The once-per-page head reservation: clearance between the last body
 * content and the separator, plus the separator's own height. Mirrors
 * `Insertions::push_footnote_separator` (flow/compose.rs), which is called
 * exactly once per page/region that carries any footnotes.
 */
export function footnoteHeadReservePx(bodyPx: number): number {
  return FOOTNOTE_CLEARANCE_EM * bodyPx + footnoteSeparatorHeightPx();
}

/**
 * The ledger contribution of a single footnote entry: the gap that precedes
 * it, plus its own height. Mirrors `Insertions::push_footnote`
 * (flow/compose.rs), which runs once per entry, including the FIRST entry
 * on the page (its preceding gap sits between the separator and it) — no
 * entry is charged a gap that follows it, so the last entry on a page never
 * reserves space beyond its own height.
 */
export function footnoteEntryCost(heightPx: number, bodyPx: number): number {
  return FOOTNOTE_GAP_EM * bodyPx + heightPx;
}

/**
 * Total bottom-of-page reservation for a page carrying footnote entries
 * with the given painted heights (px): the shared formula used by both the
 * fit test (incrementally, via `footnoteHeadReservePx`/`footnoteEntryCost`)
 * and the paint step (`footnotePositions`, below) so they cannot drift.
 * Zero when there are no entries — Typst reserves nothing on a page with no
 * footnotes.
 */
export function footnoteAreaHeight(heights: readonly number[], bodyPx: number): number {
  if (heights.length === 0) return 0;
  let total = footnoteHeadReservePx(bodyPx);
  for (const h of heights) total += footnoteEntryCost(h, bodyPx);
  return total;
}

/**
 * Top offsets for the separator and each entry, in the same coordinate
 * space as `bottomEdgeY` (the page's content bottom edge, before footnote
 * reservation). Mirrors `Insertions::finalize`'s placement loop exactly:
 * clearance, then the separator, then (gap, entry) in order for each entry.
 * Returns empty entryTops (and a meaningless separatorTop) for zero entries.
 */
export function footnotePositions(
  heights: readonly number[],
  bodyPx: number,
  bottomEdgeY: number,
): { separatorTop: number; entryTops: number[] } {
  const total = footnoteAreaHeight(heights, bodyPx);
  let y = bottomEdgeY - total + FOOTNOTE_CLEARANCE_EM * bodyPx;
  const separatorTop = y;
  y += footnoteSeparatorHeightPx();
  const entryTops: number[] = [];
  for (const h of heights) {
    y += FOOTNOTE_GAP_EM * bodyPx;
    entryTops.push(y);
    y += h;
  }
  return { separatorTop, entryTops };
}

// ---------------------------------------------------------------------------
// Widow/orphan "need" — ported from Typst's `Collector::lines`
// (typst-layout/src/flow/collect.rs, ~196-238) and consumed the same way
// `flow/distribute.rs::Distributor::line` does: a line's `need` is checked
// against the remaining region height INSTEAD of the line's own height, so a
// protected pair (or triple) is judged as a unit BEFORE either line is
// placed. Typst decides before placement; a scheme that detects the overflow
// after the fact and pulls the break back one line disagrees with Typst at
// knife edges — this is the mechanism that replaces that after-the-fact
// pull-back in the local paginator.
//
// - Orphan prevention (line 0): needs room for lines 0 and 1 together, so
//   the paragraph never starts a page with a single line stranded above a
//   break.
// - Widow prevention (the second-to-last line): needs room for the last two
//   lines together, so the paragraph never leaves a single line stranded
//   alone at the top of a page.
// - A 3-line paragraph with both active is indivisible (`prevent_all`):
//   line 0's need covers all three lines, matching Typst's `prevent_all`.
// - Both guards additionally require their partner line to carry real
//   content (`!lines[1].is_empty()` / `!lines[len-2].is_empty()`) — a blank
//   line (e.g. from consecutive hard breaks) cannot anchor a pairing, and
//   the Rust's own `i >= 2` guard on the widow branch means a 2-line
//   paragraph is protected only via the orphan branch (both branches would
//   otherwise target the same index), never doubly.
//
// Every other line's need is simply its own height — Typst's default when a
// line participates in no pairing.

export interface LineNeedsOptions {
  /** True when index i is an empty line (Typst's `Frame::is_empty()`) — an
   *  empty partner line disables the pairing it would otherwise anchor.
   *  Omitted: every line is treated as non-empty. */
  isEmpty?: (index: number) => boolean;
  /** Cost-gated toggles (`text.costs.orphan()`/`.widow()` > 0 in Typst).
   *  Both default on: the exporter emits no `#set text(costs: ..)`
   *  override, so unmodified (on) Typst defaults apply. */
  preventOrphans?: boolean;
  preventWidows?: boolean;
}

/**
 * Per-line `need` for a paragraph's laid-out lines, mirroring
 * `Collector::lines` exactly. `heights` are each line's own frame height
 * (Typst's `frame.height()` — NOT including `leading`); `leading` is the
 * paragraph's resolved inter-line leading (`ParElem::leading`). Both must be
 * in the same unit (the local paginator uses px, derived from the same
 * parity metrics the exporter tells Typst to use).
 */
export function lineNeeds(
  heights: readonly number[],
  leading: number,
  opts: LineNeedsOptions = {},
): number[] {
  const len = heights.length;
  const isEmpty = opts.isEmpty ?? (() => false);
  const preventOrphans = opts.preventOrphans ?? true;
  const preventWidows = opts.preventWidows ?? true;

  const orphanActive = preventOrphans && len >= 2 && !isEmpty(1);
  const widowActive = preventWidows && len >= 2 && !isEmpty(len - 2);
  const preventAll = len === 3 && orphanActive && widowActive;

  const h = (i: number) => heights[i] ?? 0;

  return heights.map((height, i) => {
    if (preventAll && i === 0) return h(0) + leading + h(1) + leading + h(len - 1);
    if (orphanActive && i === 0) return h(0) + leading + h(1);
    if (widowActive && i >= 2 && i + 2 === len) return h(len - 2) + leading + h(len - 1);
    return height;
  });
}
