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
