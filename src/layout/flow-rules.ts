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
// Footnote entry SPILL — ported from Typst's `Composer::footnote`,
// `Composer::footnote_spill` and `Composer::column`
// (typst-layout/src/flow/compose.rs, ~415-539, ~542-563, ~167-198).
//
// Typst never charges a footnote entry's whole height to the marker's page.
// It lays the entry into a POD sized to what is left of the region, keeps
// only the FIRST resulting frame there, and spills the remaining frames onto
// following pages, one frame per page (compose.rs ~529-532: `self
// .footnote_spill = Some(iter)`; ~542-563 consumes exactly one frame per
// column and re-spills the rest). A page carrying a spill charges a fresh
// separator (`push_footnote_separator`) unconditionally, then `gap +
// frame.height()` for the placed frame — the same `push_footnote` arithmetic
// `footnoteEntryCost` already models.
//
// Ordering rules that fall out of the Rust and are mirrored below:
//   - Spill is processed FIRST on the next column, before that page's own
//     content (`Composer::column`, ~171-173), and before any queued entry
//     (`column_contents`, ~228-230).
//   - While a spill or a queue is outstanding, every further footnote on the
//     page is queued rather than placed (`Composer::footnote`, ~437-441:
//     "we don't want to disrupt the order") — so at most ONE partial
//     placement happens per page, and everything after it carries.

/** One carried piece of footnote content: either an entry that could not be
 * placed at its marker at all (Typst's `footnote_queue`) or the unplaced
 * remainder of an entry whose first fragment was committed (Typst's
 * `footnote_spill`). Both live in one ordered pool here because Typst
 * processes them in exactly that order and both charge identically. */
export interface FootnoteCarryItem {
  /** Remaining un-placed height of the entry (px). */
  readonly heightPx: number;
  /** The entry's own line height (px), used to quantize a partial fragment
   * to whole lines. Omitted/0: fragments fall back to a plain pixel clamp. */
  readonly lineHeightPx?: number;
}

export interface FootnoteFitResult {
  /** Height committed to the current page (Typst's `first.height()`). */
  readonly fragment: number;
  /** Height carried to following pages (Typst's `footnote_spill`). */
  readonly remainder: number;
  /** Typst's `first.is_empty() && exist_non_empty_frame`: no content at all
   * fit in the pod although the entry has content. This is the ONLY state in
   * which the migrate/queue decision (`footnoteEmptyFrameAction`) runs. */
  readonly empty: boolean;
}

/**
 * Split one footnote entry against the space its marker's page has left,
 * mirroring `Composer::footnote`'s pod arithmetic (compose.rs ~466-475):
 *
 *     pod.size.y = regions.size.y - flow_need - separator_need - gap
 *
 * `availablePx` is `regions.size.y - flow_need`: the region height that
 * remains BELOW the in-flow content holding the marker — the full frame
 * height for an unbreakable frame, the marker's own y within the frame for a
 * breakable one (compose.rs ~381-386). `pageHasFootnotes` mirrors
 * `area.footnotes.is_empty()`: the clearance+separator head is charged only
 * by the page's first entry.
 *
 * Typst lays the entry out as text, so a partial fragment always contains a
 * whole number of lines; `lineHeightPx` reproduces that quantization from
 * the entry's measured line height. Without it (unknown/`normal` line
 * height) the fragment is a plain pixel clamp — never taller than the pod,
 * so the ledger can still not over-commit.
 */
export function footnoteEntryFit(
  entryHeightPx: number,
  availablePx: number,
  pageHasFootnotes: boolean,
  bodyPx: number,
  opts: { lineHeightPx?: number } = {},
): FootnoteFitResult {
  const separatorNeed = pageHasFootnotes ? 0 : footnoteHeadReservePx(bodyPx);
  const pod = availablePx - separatorNeed - FOOTNOTE_GAP_EM * bodyPx;
  if (fits(pod, entryHeightPx)) return { fragment: entryHeightPx, remainder: 0, empty: false };

  const lineHeightPx = opts.lineHeightPx;
  let fragment: number;
  if (typeof lineHeightPx === 'number' && Number.isFinite(lineHeightPx) && lineHeightPx > 0) {
    const lines = Math.floor((pod + ABS_EPS) / lineHeightPx);
    fragment = Math.min(entryHeightPx, Math.max(0, lines) * lineHeightPx);
  } else {
    fragment = Math.max(0, Math.min(entryHeightPx, pod));
  }
  const remainder = Math.max(0, entryHeightPx - fragment);
  // `exist_non_empty_frame` is true exactly when the entry has any content
  // at all: a zero-height entry produces only empty frames, so Typst falls
  // through to committing it (no queue, no migration) even in no space.
  return { fragment, remainder, empty: fragment <= 0 && entryHeightPx > 0 };
}

/** What Typst does with an entry whose FIRST frame came back empty
 * (`Composer::footnote`, compose.rs ~493-501). `migratable` is true only for
 * the first footnote of an UNBREAKABLE frame (compose.rs ~370-372, ~399:
 * `migratable = migratable && !breakable`, then cleared after the first
 * note); `mayProgress` is `regions.may_progress()` (this module's
 * `mayProgress`), the guard against migrating forever; `flowNeed` is the
 * same flow need that shrank the pod — a non-zero one means queueing can
 * still help, because the next page charges no flow need. */
export type FootnoteEmptyFrameAction = 'migrate' | 'queue' | 'place';

export function footnoteEmptyFrameAction(
  migratable: boolean,
  mayProgressNow: boolean,
  flowNeed: number,
): FootnoteEmptyFrameAction {
  if (migratable && mayProgressNow) return 'migrate';
  if (mayProgressNow || flowNeed !== 0) return 'queue';
  // Terminal case: neither moving the frame nor deferring the entry can free
  // any space, so Typst lays it out anyway and lets it overflow rather than
  // loop forever.
  return 'place';
}

export interface FootnoteCarrySettlement {
  /** Fragment heights committed on this page, in order. Each costs
   * `footnoteEntryCost(fragment, bodyPx)`; the once-per-page head reserve is
   * added by the caller exactly when that sum is non-zero — the same
   * decomposition `footnoteAreaHeight` uses. */
  readonly placed: number[];
  /** The pool still owed to later pages. Non-empty means this page is
   * "blocked": every footnote marker it carries queues instead of placing. */
  readonly carry: FootnoteCarryItem[];
}

/**
 * Settle the carried pool at the top of a fresh page, mirroring
 * `Composer::column` (compose.rs ~167-198) + `Composer::footnote_spill`
 * (~542-563) + `column_contents`' queue drain (~228-230):
 *
 *  - The active spill goes first and unconditionally charges a separator.
 *  - Exactly ONE frame of the spill is consumed per page; a leftover
 *    re-spills and blocks everything behind it.
 *  - Queued entries are then laid out with flow need ZERO (compose.rs ~229:
 *    `self.footnote(note, &mut regions.clone(), Abs::zero(), false)`), so
 *    each takes as much of the page as remains; the first one that cannot
 *    take all of it makes this page's last placement.
 *
 * `contentPx` is the page's full content height. Deviation from the Rust,
 * deliberately: Typst's spill frames were sized by the ORIGINAL pod, whose
 * later regions are full-height, so a spill frame can be taller than the
 * separator+gap leave room for and simply overflows. Here every fragment is
 * re-fitted against `contentPx - head - gap`, which clamps the reservation
 * to the page — the ledger must never hand the flow a negative content area.
 */
export function settleFootnoteCarry(
  carry: readonly FootnoteCarryItem[],
  contentPx: number,
  bodyPx: number,
): FootnoteCarrySettlement {
  if (carry.length === 0) return { placed: [], carry: [] };
  const placed: number[] = [];
  const rest = carry.slice();
  // The carrying page always pays the separator head once, up front.
  let used = footnoteHeadReservePx(bodyPx);
  while (rest.length > 0) {
    const item = rest[0];
    const fit = footnoteEntryFit(item.heightPx, contentPx - used, true, bodyPx, {
      lineHeightPx: item.lineHeightPx,
    });
    // Nothing at all fits: the whole item (and everything behind it) waits.
    if (fit.empty) break;
    placed.push(fit.fragment);
    used += footnoteEntryCost(fit.fragment, bodyPx);
    rest.shift();
    if (fit.remainder > 0) {
      // One frame per page: the remainder re-spills and blocks the rest.
      rest.unshift({ heightPx: fit.remainder, lineHeightPx: item.lineHeightPx });
      break;
    }
  }
  return { placed, carry: rest };
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

/** Shared pairing-activation logic for `lineNeeds`/`lineNeedSpans`, kept in
 *  one place so the two functions' notions of "which lines are grouped"
 *  cannot drift apart. */
function pairingActivation(len: number, opts: LineNeedsOptions) {
  const isEmpty = opts.isEmpty ?? (() => false);
  const preventOrphans = opts.preventOrphans ?? true;
  const preventWidows = opts.preventWidows ?? true;

  const orphanActive = preventOrphans && len >= 2 && !isEmpty(1);
  const widowActive = preventWidows && len >= 2 && !isEmpty(len - 2);
  const preventAll = len === 3 && orphanActive && widowActive;

  return { orphanActive, widowActive, preventAll };
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
  const { orphanActive, widowActive, preventAll } = pairingActivation(len, opts);

  const h = (i: number) => heights[i] ?? 0;

  return heights.map((height, i) => {
    if (preventAll && i === 0) return h(0) + leading + h(1) + leading + h(len - 1);
    if (orphanActive && i === 0) return h(0) + leading + h(1);
    if (widowActive && i >= 2 && i + 2 === len) return h(len - 2) + leading + h(len - 1);
    return height;
  });
}

// ---------------------------------------------------------------------------
// Regions — ported from Typst's `typst-library/src/layout/regions.rs`. The
// editor's pages are all the same height (no column balancing, no shrinking
// last region), so this is intentionally small: it exists to give the
// spacing-collapse rules below (and future ported rules) Typst's own
// vocabulary for "how much room is left" and "would breaking help", rather
// than each rule re-deriving its own ad hoc version of the same guard.
// `may_progress` in particular is Typst's infinite-migration guard: it is
// `false` exactly when the next region would be identical to this one, i.e.
// advancing cannot possibly create more room.

/** Typst's `Abs::EPS` (`typst-library/src/layout/abs.rs`): the slack
 * `Abs::fits` allows so an exact-equality boundary rounds toward "fits"
 * instead of failing on float error. Shared by `fits` and the spacing
 * collapse helpers below, which compare the same kind of length. */
export const ABS_EPS = 1e-4;

/** Typst's `Abs::fits(self, other)`: whether `content` fits into
 * `container` — `container` may be a hair short of `content`, within
 * `ABS_EPS`, and still be judged as fitting it. */
export function fits(container: number, content: number): boolean {
  return container + ABS_EPS >= content;
}

/**
 * A sequence of regions to lay out into (Typst's `Regions`), specialized to
 * the editor's world: every page has the same content height, so `backlog`
 * is always empty and `last` always repeats that one height. Built via
 * `uniformRegions`, not as a literal, so that invariant lives in one place.
 */
export interface Regions {
  /** Remaining height of the CURRENT region. */
  size: number;
  /** The current region's own full height (for relative sizing — unused by
   * the editor's absolute-height rules today, kept for parity with the
   * Rust and for any future rule that needs it). */
  full: number;
  /** Heights of already-known upcoming regions that differ from `last`.
   * Always empty for the editor (every page is the same height): kept as a
   * real field, not dropped, so this stays a faithful `Regions` rather than
   * a uniform-only stand-in. */
  backlog: readonly number[];
  /** The height every region repeats once `backlog` drains. `null`
   * (Typst's `None`) means no further region exists — representable here
   * for testing, though the editor's own paginator always has a next page
   * available and never actually constructs this case. */
  last: number | null;
}

/** Build a `Regions` for the editor's uniform pages: `remaining` is how much
 * of the CURRENT page is left, `pageHeight` is every page's full height. */
export function uniformRegions(remaining: number, pageHeight: number): Regions {
  return { size: remaining, full: pageHeight, backlog: [], last: pageHeight };
}

/** Typst's `Regions::is_full`: whether the first region is already so full
 * that a region break is called for. */
export function isFull(r: Regions): boolean {
  return fits(0, r.size) && mayProgress(r);
}

/** Typst's `Regions::may_break`: whether breaking to a following region is
 * possible at all. */
export function mayBreak(r: Regions): boolean {
  return r.backlog.length > 0 || r.last !== null;
}

/** Typst's `Regions::may_progress`: whether advancing to the next region
 * could improve a lack-of-space situation. `false` exactly when the next
 * region would be identical to this one (empty backlog, and `last` repeats
 * the CURRENT size) — the guard against migrating content forever into
 * regions that can never fit it. */
export function mayProgress(r: Regions): boolean {
  return r.backlog.length > 0 || (r.last !== null && r.size !== r.last);
}

/** Typst's `Regions::next`: advance to the next region. Pure (returns the
 * advanced copy) rather than mutating in place — callers evaluate a
 * hypothetical next region far more often than they commit to one. */
export function regionsNext(r: Regions): Regions {
  if (r.backlog.length > 0) {
    const [head, ...rest] = r.backlog;
    return { ...r, size: head, full: head, backlog: rest };
  }
  if (r.last !== null) return { ...r, size: r.last, full: r.last };
  return r;
}

// ---------------------------------------------------------------------------
// Spacing collapse — ported from Typst's flow distributor
// (`typst-layout/src/flow/distribute.rs`::{rel, keep_spacing, trim_spacing,
// weak_spacing}) over the weakness tiers its collector assigns
// (`typst-layout/src/flow/collect.rs`): explicit `#v()` = 0 (1 if `weak:
// true`), explicit block `above`/`below` = 3, auto block spacing (inherits
// `par.spacing`) = 4, a paragraph's own leading between lines = 5. Weakness
// 0 is "strong": always kept, never collapsed against, and transparent to
// every scan below (a strong item never blocks a weak one from finding what
// lies further back). Every weakness >= 1 is "weak": subject to collapse —
// dropped entirely if only strong spacing (or nothing) precedes it in the
// current region (region top), replaced-in-place by (or dropped in favor
// of) an adjacent weak item per the dominance rule below, and trimmed if it
// ends up trailing at the region's bottom.
//
// The port is restricted to the two item kinds the editor's flat top-level
// block list actually produces: spacing (`Item::Abs`) and real content
// (`Item::Frame`, or an `Item::Fr` carrying a block — folded here into one
// "content" marker, since the editor's schema exposes neither introspection
// tags, floats/placed elements, nor bare fractional spacing at the top
// level that `distribute.rs` also has to handle).

export const SPACING_WEAKNESS = {
  /** Explicit `#v(amount)` — never collapses. Unused by this editor's
   * top-level block schema (no user-facing strong-`#v` construct); kept for
   * parity with Typst's own tier numbering and for tests. */
  explicit: 0,
  /** Explicit `#v(amount, weak: true)` — the weakest weak tier: any
   * competing weak item at 3/4/5 dominates it outright. Unused by this
   * editor's schema; kept for the same reason as `explicit`. */
  explicitWeak: 1,
  /** Explicit block `above`/`below`: headings (via the exporter's show
   * rule, `typ-serializer.ts`'s `headingBlockSpacingEm`/
   * `equationBlockSpacingEm`) and `#quote(block: true)`'s own built-in
   * default (`vendor/typst`'s `QuoteElem` show-set — 2.4em/1.8em, which
   * this editor's exporter never overrides). */
  blockExplicit: 3,
  /** Auto block spacing — falls back to `par.spacing`
   * (`typ-serializer.ts`'s `parSpacingEm`): plain paragraphs, lists, plain
   * code blocks, raw-Typst islands, figures, and tables all get this on
   * both sides (Auto is resolved independently for `above` and `below`). */
  blockAuto: 4,
  /** Leading between a paragraph's own lines. */
  parLeading: 5,
} as const;

export type FlowItem =
  | { kind: 'spacing'; amount: number; weakness: number }
  | { kind: 'content' };

/**
 * Typst's `Distributor::keep_spacing`: scanning backward from the end of
 * `items`, find the first weak spacing item — skipping over strong spacing,
 * which is transparent to the scan — and decide the new candidate's fate:
 *
 * - A `content` marker is the nearest thing found (no pending weak spacing
 *   to compete with): the candidate stands right after real content and
 *   should be pushed as a normal new item. Returns `true`.
 * - A pending weak spacing item is found: the candidate REPLACES it in
 *   place (mutating `items`, and adjusting `regions.size` by the delta —
 *   Typst's `self.regions.size.y -= amount - prev_amount`) when it is at
 *   least as strong (numerically <=) AND either strictly stronger or
 *   larger in amount; otherwise the pending item is left untouched. Either
 *   way the candidate itself is never separately appended — callers must
 *   not also push it. Returns `false`.
 * - Nothing is found before the start of `items` (region top: no content,
 *   no pending spacing precedes it at all): region-top drop. Returns
 *   `false`.
 */
export function keepSpacing(regions: Regions, items: FlowItem[], amount: number, weakness: number): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'spacing' && item.weakness >= 1) {
      if (weakness <= item.weakness && (weakness < item.weakness || amount > item.amount)) {
        regions.size -= amount - item.amount;
        items[i] = { kind: 'spacing', amount, weakness };
      }
      return false;
    }
    if (item.kind === 'content') return true;
    // Strong spacing (weakness 0) is transparent to the scan: keep looking.
  }
  return false;
}

/**
 * Typst's `Distributor::rel`: push relative spacing, honoring the collapse
 * rule for weak items (`weakness > 0`) via `keepSpacing`, and charging the
 * kept amount against `regions.size` — the region-scoped "how much room is
 * left" this spacing item actually consumes, ready for the immediately
 * following content's `fits` check to compare against (Typst charges the
 * gap before testing whether the content after it fits — see this module's
 * top-of-file doc comment on the spacing-collapse port). Strong spacing
 * (`weakness === 0`) is always pushed and charged unconditionally. Mutates
 * both `items` and `regions` in place, mirroring the Rust.
 */
export function pushSpacing(regions: Regions, items: FlowItem[], amount: number, weakness: number): void {
  if (weakness > 0 && !keepSpacing(regions, items, amount, weakness)) return;
  regions.size -= amount;
  items.push({ kind: 'spacing', amount, weakness });
}

/**
 * Typst's `Distributor::trim_spacing`: remove ONE trailing weak spacing
 * item from the end of `items` (scanning back past strong spacing, again
 * transparent to the scan), giving its amount back to `regions.size` and
 * returning the amount removed (0 if none — including when a `content`
 * marker is the last non-strong thing found, meaning nothing trails).
 * Mirrors the Rust's `break` semantics: the scan stops at the first
 * weak-spacing-or-content boundary, so at most one item is ever removed
 * per call.
 */
export function trimSpacing(regions: Regions, items: FlowItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'spacing' && item.weakness >= 1) {
      regions.size += item.amount;
      items.splice(i, 1);
      return item.amount;
    }
    if (item.kind === 'content') return 0;
  }
  return 0;
}

/** Typst's `Distributor::weak_spacing`: peek the amount of trailing weak
 * spacing without removing it (0 if none). */
export function peekWeakSpacing(items: readonly FlowItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'spacing' && item.weakness >= 1) return item.amount;
    if (item.kind === 'content') return 0;
  }
  return 0;
}

/**
 * Page-top drop for the top-level block kinds whose own CSS encodes their
 * Auto (weakness-4) "above" spacing as `padding-top` on the block's own box
 * rather than as a calibrated ascent formula the way paragraphs/headings/
 * lines get via `pageTopAdjustEm` (`typ-serializer.ts`): blockquote
 * (`#quote(block: true)`, 0.66em), a plain (non-`typst-raw`) code block
 * (`.ProseMirror pre`, 0.8em), and a figure (`.ts-figure`, 0.4em). Lists and
 * tables paint zero padding-top already (their CSS puts spacing entirely in
 * the PREVIOUS sibling's margin-bottom), so they need no entry here — there
 * is nothing to drop.
 *
 * Every weakness this editor's schema assigns to a block's own "above" item
 * is >= 1 (weak, `SPACING_WEAKNESS`), so `keepSpacing`/`pushSpacing` drop it
 * UNCONDITIONALLY the moment it becomes the very first thing in a fresh
 * region (`pushSpacing([], amount, weakness)` always returns without
 * appending — the scan in `keepSpacing` finds nothing and falls through to
 * `return false`). That drop is certain regardless of amount; only the
 * "how much of the block's own box is really the above-spacing that
 * vanished" side is a per-kind approximation (the padding-top figure,
 * treating the block's own visible first ink as already sitting flush with
 * its padding boundary — the same zeroth-order assumption the "atomic"
 * default already makes for zero-padding kinds like tables and lists).
 */
export const CONTAINER_PAGE_TOP_PADDING_EM: Readonly<Record<string, number>> = {
  blockquote: 0.66,
  code_block: 0.8,
  figure: 0.4,
};

/** The page-top spacing drop (body em) for a container `kind`, or 0 for a
 * kind not in `CONTAINER_PAGE_TOP_PADDING_EM` (nothing to drop). `isRaw`
 * must be `true` for a `code_block` with `params === 'typst-raw'`: that
 * variant paints via `.ts-raw` (margin-bottom only, no padding-top), not
 * `.ProseMirror pre` — the drop does not apply to it. */
export function containerPageTopDropEm(kind: string, isRaw = false): number {
  if (kind === 'code_block' && isRaw) return 0;
  return CONTAINER_PAGE_TOP_PADDING_EM[kind] ?? 0;
}

/**
 * For each line i, the index of the LAST line covered by `lineNeeds`'
 * need span at i — i.e. how far the pairing `needs[i]` grouped forward.
 * Mirrors the same `Collector::lines` grouping `lineNeeds` computes, but
 * returns the span's end index instead of a height, so callers that must
 * reason about which lines a `need` check actually covers (not just how
 * tall it is) don't have to re-derive the grouping from heights.
 *
 * `needs[i] > heights[i]` exactly when `spans[i] > i` — the two functions
 * agree on every index by construction (`pairingActivation` is shared).
 */
export function lineNeedSpans(count: number, opts: LineNeedsOptions = {}): number[] {
  const { orphanActive, widowActive, preventAll } = pairingActivation(count, opts);

  return Array.from({ length: count }, (_, i) => {
    if (preventAll && i === 0) return count - 1;
    if (orphanActive && i === 0) return 1;
    if (widowActive && i >= 2 && i + 2 === count) return count - 1;
    return i;
  });
}

// ---------------------------------------------------------------------------
// Sticky blocks — ported from Typst's flow distributor
// (`typst-layout/src/flow/distribute.rs`: the `sticky`/`stickable` fields at
// :42-64, the checkpoint logic in `Distributor::frame` at :340-369, and the
// restore in `Distributor::finalize` at :445-458). Headings are sticky by
// default through their show-set rule (`typst-library/src/model/heading.rs:
// 294`, `BlockElem::sticky = true`); nothing else in this editor's schema is,
// so the paginator hard-wires heading kinds until a user-facing flag exists.
//
// The mechanism, in Typst's words: a sticky block "should not be the last
// thing on a page". When a run of consecutive sticky blocks begins, the
// distributor takes a CHECKPOINT of its work — but only if `regions
// .may_progress()`: a run that starts at the very top of a region cannot be
// helped by migrating (it would land at the top of the next region, which is
// the same situation — the infinite-loop guard at :48-63). The verdict is
// taken once per run (`stickable.get_or_insert_with`, :359): every later
// block of the same run inherits it, and a `Some(false)` run stays disabled
// until a non-sticky frame resets it. A non-sticky NON-EMPTY frame anchors
// the run: the snapshot and the verdict are both forgotten (:363-369) — an
// empty frame changes nothing. When the region then ends before the run was
// anchored (any non-forced `Stop::Finish`, :448-457), `finalize` restores
// the checkpoint: the whole run — not just its last block — migrates to the
// next region along with whatever finished it. A FORCED finish (an explicit
// page break, `Child::Break` → `Stop::Finish(true)`) restores nothing
// (:445-447).
//
// One more consequence, from the composer rather than the distributor: a
// footnote insertion RELAYOUTS the region from scratch against a pod
// shrunken by the inserted entries (`flow/compose.rs:165-216`). The fresh
// distributor sees the same sticky run again — now with `may_progress()`
// true, since the insertions made `size.y != last` — so its checkpoint sits
// at the run's first block regardless of the earlier verdict. The paginator
// models that relayout's second look as `stickyRelayoutCheckpoint` below.
//
// The state is generic over the checkpoint payload: Typst snapshots the
// whole work list (:565-571); the paginator only needs to know WHERE to
// break (the run's first block and its natural y).

export interface StickyState<C> {
  /** `Distributor::sticky` (:44): the checkpoint to restore should the
   * region end while the current sticky run is still un-anchored. */
  checkpoint: C | null;
  /** `Distributor::stickable` (:64): `null` outside a sticky run; the
   * once-per-run verdict (`may_progress()` at the run's first block) while
   * inside one. */
  stickable: boolean | null;
  /** The current run's first sticky frame, kept even when the verdict was
   * `false` — what the footnote relayout's fresh distributor would checkpoint
   * (see `stickyRelayoutCheckpoint`). `null` outside a run. Not a Typst
   * field: the Rust re-derives it by re-running the region. */
  runStart: C | null;
}

/** A fresh distributor's sticky state (distribute.rs:19-20). Typst creates
 * one distributor per region (:14-30), so the state never survives a page
 * break: every page starts here, and the suffix paginator's seed — which
 * restarts at a page start — needs no replay of the prefix's headings. */
export function freshStickyState<C>(): StickyState<C> {
  return { checkpoint: null, stickable: null, runStart: null };
}

/**
 * `Distributor::frame`'s sticky bookkeeping (distribute.rs:340-369), run for
 * every in-flow frame (a paragraph line, an unbreakable block, a breakable
 * block's first frame) BEFORE that frame's footnotes are handled (:372) and
 * before it is charged against the region (:381).
 *
 * - `sticky` with no checkpoint yet: decide `stickable` for the run if it is
 *   undecided (`mayProgressNow`, the run's first block), and take
 *   `snapshot()` when the verdict is true. A run that began with a `false`
 *   verdict never checkpoints, even once later blocks could progress.
 * - non-sticky and non-empty: forget the checkpoint and the verdict (and the
 *   run start) — the run is anchored to this frame.
 * - non-sticky and EMPTY (`frame.is_empty()`, e.g. a blank line): nothing.
 *
 * Mutates `state` in place, mirroring the Rust.
 */
export function stickyFrame<C>(
  state: StickyState<C>,
  sticky: boolean,
  empty: boolean,
  mayProgressNow: boolean,
  snapshot: () => C,
): void {
  if (sticky) {
    if (state.checkpoint === null) {
      if (state.stickable === null) {
        // `get_or_insert_with(|| self.regions.may_progress())` (:359): the
        // run's first block decides for the whole run.
        state.stickable = mayProgressNow;
        state.runStart = snapshot();
      }
      if (state.stickable) state.checkpoint = state.runStart;
    }
    return;
  }
  if (!empty) {
    state.checkpoint = null;
    state.stickable = null;
    state.runStart = null;
  }
}

/**
 * `Distributor::finalize`'s restore decision (distribute.rs:445-458) for a
 * region that just ended: returns the checkpoint the region must be rolled
 * back to — the sticky run's first block, meaning "break BEFORE it, so the
 * run migrates with the frame that ended the region" — or `null` when the
 * region simply ends where it ended. Takes the checkpoint (`self.sticky
 * .take()`, :455), like the Rust. A `forced` finish (an explicit page
 * break) never restores (:445-447).
 */
export function stickyFinish<C>(state: StickyState<C>, forced: boolean): C | null {
  if (forced) return null;
  const checkpoint = state.checkpoint;
  state.checkpoint = null;
  return checkpoint;
}

/**
 * What a footnote-insertion RELAYOUT of the current region would checkpoint
 * at this point (`flow/compose.rs:165-216` re-runs `distribute` from the
 * region's start with `regions.size.y` reduced by the inserted entries, so
 * `may_progress()` is true for every block, including one at the very top):
 * the current run's first block, if the frame about to be placed follows an
 * un-anchored sticky run; `null` otherwise. Read this BEFORE calling
 * `stickyFrame` for the (non-sticky) frame whose entries were inserted — that
 * call anchors the run, but the relayout looks at the region as it stood
 * before the frame was placed.
 */
export function stickyRelayoutCheckpoint<C>(state: StickyState<C>): C | null {
  return state.runStart;
}
