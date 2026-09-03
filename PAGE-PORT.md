# PAGE-PORT: porting Typst's page breaker

## Status (2026-09-02)

- Phase 3 (sticky blocks): **landed** (this commit). The sticky-heading
  pointer in `runFallbackPass` is replaced by Typst's snapshot/restore
  (`freshStickyState`/`stickyFrame`/`stickyFinish`/
  `stickyRelayoutCheckpoint` in flow-rules.ts, mirroring distribute.rs
  :340-369 and :445-458): a run of consecutive top-level headings takes one
  checkpoint at its first block, only when `may_progress()` holds there —
  by position identity (`mayProgressAt`: not the page's first frame, or
  footnote insertions already shrank the page), never by px, so the
  page-top ink adjustment cannot masquerade as consumed space; a run that
  starts a page is disabled for all its blocks (the infinite-loop guard the
  pointer lacked — it used to re-migrate a page-top heading into a blank
  page). A non-sticky non-empty frame anchors the run (a placed line, an
  atomic block, a container or container child that fits, the first child of
  a container that breaks inside); a non-forced region finish while the run
  is un-anchored restores the checkpoint, so the WHOLE run migrates — the
  old prefix-replay approximation is now the rule, and a container whose
  first child cannot start on the page migrates with the heading
  (`Distributor::multi`'s empty-first-frame finish, :286-294), which the
  pointer never did. Forced breaks (`page_break`) restore nothing. Every
  page break resets the state (a fresh distributor per region, :14-21):
  the suffix paginator's seed therefore starts from the same fresh state
  the full pass has at that page start, and the old prefix replay is gone
  (no seed-shape change). Footnote interaction kept in Typst's order:
  the sticky step runs before `footnotes()` (:372), so a footnote
  migration from a non-sticky frame leaves the heading behind while one
  from a heading restores its run; a strand at a paragraph's start is a
  finish inside the RELAYOUT (compose.rs:165-216), whose fresh distributor
  re-checkpoints the run with progress now possible even at the page top —
  `stickyRelayoutCheckpoint`. Fit-failure relocations are now guarded by
  `may_progress` the way Typst's are (the `traveled` flag became a
  3-relocation budget: restore-migrate, then break alone when the run at
  the new page top leaves too little room, plus one safety margin), which
  also aligns the oversize case with Phase 5's note: a too-tall unbreakable
  block moves to a fresh page from anywhere else and overflows only there.
  Soak (same harness and seed as Phase 4, 25 edits): footnote corpus 12
  predictions, agreements 5 → 5, byCause before spacing
  2 / widow-orphan 4 / footnote 1 / sticky 0, after identical;
  a new heading-heavy corpus (H2 before every third paragraph, an H1+H2
  run before every ninth, 12 pages): 12 predictions, agreements 3 →
  3, byCause before spacing 9 / sticky 0, after
  identical — the residue is a same-paragraph line-vs-block
  unit mismatch two lines above the page bottom (local breaks at line 2,
  Typst moves the paragraph whole), a Phase 2/6 height question, not a
  heading migration. Regression: tests/sticky-pagination.spec.ts (heading
  migrates with its paragraph; two headings migrate together; a run at a
  page top stays and does not loop).
- Phase 0 (parity telemetry): **landed** 9defb17. Soak at c316f99: 96
  predictions, 1 agreement; byCause page-top-adjust 30, widow-orphan 28,
  spacing 15, footnote 12, sticky 10.
- Phase 4 (footnote arithmetic): **landed** 7b55335. Entry SPILL +
  migration ported on top (`footnoteEntryFit`/`settleFootnoteCarry`/
  `footnoteEmptyFrameAction` in flow-rules.ts): the ledger charges only the
  fragment that fits beside the marker and carries the rest onto following
  pages, one frame per page. Ledger only — `placeFootnotes` still paints
  every `.fn-body` whole on its marker's page, so a spilled entry paints
  above its reserved area (page starts are the parity target; split painting
  is the follow-up). Suffix seeds decline while a prefix entry could still
  be carrying across the boundary (`footnoteCarryCrossesSeed`). The
  interaction with Phase 2's fresh-page need check is unified into one
  per-line cycle in the paragraph closure, in Typst's order: stage 1
  pre-insertion fit (distribute.rs:226-248, against the page's already
  committed entries only); footnote MIGRATION when the line's first entry
  can't start below it (compose.rs:494-496 — no sticky restore, since
  `Distributor::frame` drops the snapshot at distribute.rs:367 before
  :372 raises the finish); INSERTION of the line's entries against the
  space below the line's BOTTOM (a line is an unbreakable frame,
  distribute.rs:247, so `flow_need = frame.height()`, compose.rs:385/450),
  first fragment charged and the rest carried; stage 2 recheck after that
  charge (the relayout, compose.rs:165-216). Because the pod arithmetic
  keeps a fragment below its own line, only the widow/orphan NEED can newly
  fail at stage 2 — then the entries strand on the page and the pair
  migrates to a raw fresh page (regions.rs:133-138). The partner's entries
  are never stranded (they sit below the partner, where the need ends), so
  there is no cross-span peek/take. Fast paths (whole paragraph, container,
  container child) keep a conservative whole-entry peek as their sufficient
  condition and fall through to the exact walk otherwise.
- **Filed vertical-parity bug (not a rule bug): the phantom space before a
  footnote marker.** Measured 2026-08-29 on the footnote soak corpus (seed
  424242). The whole layout stack models Typst's gluing — a source space
  immediately before a footnote marker is dropped from the width model
  (`paragraph.ts` `plan.glueLeft`, `forced-layout.ts`'s
  `trimTrailingSpaces()` on footnote, `typst-oracle.ts`'s
  `spaceBefore: false`), because Typst renders `word1`, not `word 1`. The
  DOM still **paints** that space: it is an ordinary character in the
  paragraph's text node, and nothing hides it. Consequence, measured at
  body 16.6667px / measure 576px: the model computes the marker line's
  natural width 5.563px (one space) short, justification hands that slack
  back to the line's other spaces, and the painted line comes out
  `space + wordSpacing` = 6.05–6.27px wider than the `measure − eps`
  (574.5px) target — 580.55px / 580.77px against a 576px measure. The
  browser soft-wraps the forced line, so **every footnote-bearing paragraph
  renders one line box (25px) taller than its oracle line count**, plus
  0.547px of superscript overhang. The paginator then reads that inflated
  DOM height and breaks a page early. Root-cause probe:
  `tests/_probe-fn-ledger.spec.ts` (untracked). Cost, measured by
  temporarily charging the painted space in the two width models and
  re-running the soak: 12 predictions, **0 → 4 agreements**, byCause
  footnote **11 → 1** (the residue re-buckets to widow-orphan 1 → 7, the
  separate Phase 2 boundary issue). The fix belongs in the renderer (stop
  painting the space, so the DOM matches Typst) or in the justification
  width model (charge what is painted) — **not** in `runFallbackPass`,
  which is correctly consuming DOM heights. Footnote reservation arithmetic
  (head reserve, gap, entry cost, spill) was exonerated: the ledger's page-1
  numbers reproduce Typst's break exactly once the paragraph height is right.
- Phase 2 (widow/orphan need): **landed** 9a2b21b. Plain-prose agreement
  6/25 → 19/25; most "page-top-adjust" disagreements were downstream of
  the old retro-pull heuristic. The footnote interaction (a73a0fc's
  two-stage fit) now lives in the unified cycle described under Phase 4;
  `lineNeedSpans` stays in flow-rules.ts as a tested mirror but the
  paginator no longer consumes it.
- Phase 1 (Regions + spacing collapse): **landed** cbd4410 (fit-test and
  container page-top scope; painted CSS untouched). Residual plain-prose
  spacing disagreement traced to pageTopAdjustEm rounding → Phase 6.
- Oracle coverage fixes along the way: 613b11d (ordered-list markers,
  footnote glue), 9d35355 (opaque-block resync vs list markers). Known
  open oracle family: inline math butted against a known token
  (typst-oracle.ts ~482–502) — not yet reproduced in isolation.
- Next up: Phase 6 (retire pageTopAdjustEm — now the dominant residual,
  with the same-paragraph line-vs-block unit mismatch the heading soak
  shows), Phase 5's breakable blocks, Phase 7 below.
- Native-tables port: **done** on `codex/native-tables-port` (5788e87) —
  see HANDOFF-TABLES-REPORT.md. Tables are native ProseMirror trees and
  land atomic; `table-split.ts` and the mini-compile split path are gone.
- Phase 7 (table row breaks): **in progress** on `claude/page-port-phase7`.
  Step 1 (oracle row matching) landed: `buildTableUnit`/`matchPageStarts`
  in page-oracle.ts match a breakable table row by row against the
  compiled text layer (cells merge with no separator on one baseline —
  `Alpha 1` | `1.5` | `n1` extracts as `Alpha 11.5n1`), require the
  repeating header's exact text at the top of every continuation page,
  and fail closed on a split inside a row, a missing/mismatched header, an
  all-empty row, a captioned (figure, unbreakable) table or a sub-header.
  A page start inside a table is now `{pos: table, line: ROW, unit:
  'table'}`. Step 2 (local paginator + install) landed: `paginateForced`
  installs a row start as a `row` spacer — a widget `<tr>` between the two
  real rows (table-break-widget.ts: exact-height gap + a non-editable copy
  of the repeating header sized to the real header row), declining and
  withdrawing retained markers for anything the widget cannot mirror (a
  rowspan across the boundary, a figure table, a stale row index). The
  fallback pass's table branch measures `<tr>` heights and replays
  `planTableRowBreaks` (table-rows.ts: region-full finish, header orphan
  prevention, repeated-header reservation per continuation page, rowspan
  crossing → atomic) through the shared `breakStart`/`breakBefore`
  primitives. tests/table-pagination.spec.ts: a 40-row table reaches
  `exact[` with the break between consecutive rows, the header copy at
  page 2's content top (0px) and the next row directly under it (0px);
  a rowspan across Typst's own break row stays atomic; cell edits on both
  pages keep one table node and return to exact. Step 3 (presentation) +
  step 4 (fail open) landed: the widget row paints, as pseudo-elements
  only, the table's closing rule at the interrupted page's bottom and the
  opening rule + header rule on the continuation page — what
  `render_fills_strokes` strokes at a region boundary (the bottom-border
  hline index is chained after every region's rows, layouter.rs:600-604;
  top-border hlines take priority at a region top, :674-680; the header's
  own hlines repeat under the repeated header, :634-645, so the midrule
  copy appears only when the repeated row is the row the exporter's midrule
  sits under). Grid tables keep their collapsed cell strokes and the header
  copy paints its own; the widget adds no height beyond gap + header copy
  (asserted). Rowspan across the boundary, figure tables and sub-headers
  decline exact and stay atomic (tests). Remaining: step 5 (suffix seeding
  + parity telemetry relaxation).

Goal: the local paginator's page decisions become identical to Typst's for
supported content, the same way the line-break port (PORT.md) made local line
decisions identical. Typst's compiled answer remains the runtime authority
and checker throughout; each phase only shrinks the set of cases where the
local prediction disagrees with it. Reference source: `vendor/typst` pinned
at 951788cc (the same tree the line port certifies against).

## Why this is a different project than the line port

Typst's line breaker is a self-contained function: paragraph in, break
offsets out. Its page breaker is a *distributor*: `layout_flow`
(`crates/typst-layout/src/flow/`) walks a flat list of pre-measured children
(already-broken lines, blocks, spacing items) and fills fixed-height regions,
with four stateful mechanisms layered on: weakness-tagged spacing collapse,
widow/orphan "need" grouping, sticky-block snapshot/restore, and
footnote/float insertion areas with region relayout. The good news from the
source survey: those four mechanisms are each small, pure, and mirrorable.
The entangled parts (per-region block relayout, the comemo memoization,
introspection plumbing) are avoidable because the editor already has real
measured heights for every block — we port the *decision rules*, not the
measurement engine.

The local paginator today (`runFallbackPass` in `src/typeset-plugin.ts`)
imitates these rules with hand-tuned approximations: spacing is whatever the
painted CSS produced, widow/orphan is two inline conditionals, sticky
headings are a pointer variable, footnote reservations use fixed px
constants (FN_SEP=30, FN_GAP=6) with a known slight over-reservation, and
page-top spacing uses a calibrated per-kind em adjustment
(`pageTopAdjustEm`). Every one of these is a potential source of
one-line disagreements with the exact answer.

## Doctrine for the port

- Heights stay DOM-measured. Vertical parity (editor block heights ==
  Typst's) is an existing doctrine enforced elsewhere; the page port
  consumes those heights and ports only what Typst's flow layer *does* with
  heights. If a disagreement traces to a height mismatch rather than a rule
  mismatch, that's a vertical-parity bug, filed separately — the telemetry
  must distinguish the two (see Phase 0).
- Decisions, not pixels, are the parity target: a run "agrees" when every
  page starts at the same (block, line) as Typst's page starts. Spacer
  heights follow from agreeing decisions plus parity heights.
- Fail open at every phase: an unported or unsupported construct keeps
  today's behavior. The exact answer keeps replacing local output at settle
  regardless — the port only makes that replacement a no-op more often.
- Every ported rule lands as a pure function in a new module
  (`src/layout/flow-rules.ts`), unit-tested against scenarios derived from
  the pinned Rust, and consumed by both the full pass and the suffix pass
  (which shares the same closures). No rule logic stays inline in
  `runFallbackPass` once ported.

## Phase 0 — parity telemetry (build first, before any rule changes)

Instrument the disagreement instead of guessing at it.

- When a Typst-exact page answer arrives (`entry.status === 'ok'`) and a
  local prediction exists for the same doc revision, diff the page-start
  lists: first differing page, the (block kind, line index) on each side,
  and a *classified cause* — which rule domain the diverging boundary falls
  under: `spacing`, `widow-orphan`, `sticky`, `footnote`, `page-top-adjust`,
  `breakable-block`, `figure`, `oversize`, `height-mismatch` (parity bug,
  not rule bug), `unknown`. Classification is heuristic (inspect the blocks
  around the boundary) and only needs to be good enough to rank work.
- Add a DEV predict-always mode: on a healthy document the exact path
  installs directly and the local paginator never runs, so fallback-window
  telemetry alone would starve. In DEV, run the local pass as a shadow
  prediction against every exact publication (throttled: at most one shadow
  prediction per settle) and feed the same diff.
- Expose `__pageParityStats`: predictions, agreements, disagreement
  histogram by cause, plus capped detail for the most recent disagreement.
- Soak harness: scripted browser session over the corpus (demo doc + a
  footnote/figure/list/heading-rich document + long-paragraph documents),
  ~100 edits, report the histogram. This ranks Phases 2–6 by evidence and
  is rerun as each phase's acceptance gate.

Acceptance: telemetry merged, histogram produced, phases below re-ranked by
the measured frequencies (the order given here is the survey's prediction).

## Phase 1 — the Regions skeleton and the spacing model

The structural gap: Typst computes inter-block spacing by rule; the local
paginator inherits it from painted CSS margins. Port the two small value
systems everything else hangs off:

- `Regions` (`typst-library/src/layout/regions.rs`): size/full/backlog/last,
  `fits`, `may_progress`, `may_break`, `next()`. For the editor this is
  near-trivial (all pages identical) but gives ported rules Typst's exact
  vocabulary, including the `may_progress` guards that prevent
  migrate-forever loops.
- Spacing items with weakness tiers (`flow/collect.rs`,
  `flow/distribute.rs::keep_spacing/trim_spacing`): explicit `#v` = 0 (or 1
  if weak), explicit block above/below = 3, auto block spacing / paragraph
  spacing = 4, paragraph leading = 5. Collapse rules: at region top weak
  spacing drops; between items the dominant weak spacing survives
  (strictly-stronger-or-larger replaces); trailing weak spacing trims at
  region bottom.
- Build the child list for the fit walk: for each top-level block, a
  spacing item (derived from the same `parityRules` constants the
  serializer emits — `typ-serializer.ts:61-83` is already the single source
  of truth for what Typst is told) followed by the block's measured height.
  The pass then *decides* what spacing exists at each boundary instead of
  reading collapsed CSS margins, which also subsumes the
  `pageTopAdjustEm` heuristic's job over time (Phase 6 retires it).

This phase changes fit arithmetic, so it lands behind the Phase 0 telemetry
and a DEV flag until the histogram shows `spacing` disagreements at zero
across the soak; then the flag flips.

## Phase 2 — widow/orphan: the `need` mechanism

Replace the two inline conditionals with Typst's exact grouping
(`flow/collect.rs::Collector::lines`): per line, precompute `need` — line 0
carries `h0 + leading + h1` when orphan prevention applies; the
second-to-last line carries `h(n-2) + leading + h(n-1)` when widow
prevention applies; a 3-line paragraph with both active is indivisible.
Distribution checks `need` against remaining region height and finishes the
region early rather than splitting a protected pair
(`flow/distribute.rs::line`). Defaults are on (costs > 0), matching current
editor behavior in spirit but not in mechanism — the current code decides
*after* overflow ("pull the break back"), Typst decides *before* placement
("does the pair fit"), and the two disagree at knife edges.

Line heights come from the existing per-line caret geometry the paginator
already reads; leading from the parity line-height. Unit tests mirror the
Rust: 2/3/4-line paragraphs at region boundaries, empty-line edge cases
(`!lines[1].is_empty()` guards).

## Phase 3 — sticky blocks: snapshot/restore

Replace the sticky-heading pointer with Typst's mechanism
(`flow/distribute.rs::frame` + `finalize`): entering a run of sticky blocks
takes a checkpoint (only if `may_progress` — a sticky block already at a
region top must not migrate, Typst's infinite-loop guard, which the current
pointer logic lacks); a non-sticky non-empty frame anchors the run; a region
that ends mid-run restores the checkpoint, migrating the whole sticky run.
Consecutive headings (a sticky *run*, not one block) come along together —
the current code approximates this with prefix replay; the port makes it the
rule itself. Headings are sticky by default (`heading.rs:294`); the schema
has no user-facing sticky flag yet, so the port hard-wires heading kinds
until one exists.

## Phase 4 — footnotes: exact reservation and migration

Replace FN_SEP/FN_GAP px constants with Typst's derivation
(`model/footnote.rs` defaults + `flow/compose.rs`): separator reservation =
clearance (1em) + separator height (0.5pt line), applied once per page that
carries footnotes; gap between entries = 0.5em; entry indent 1em. Fix the
known over-reservation (the local fit test charges `FN_GAP` after the last
note on a page; Typst charges gaps only between entries). Port the
migration rule: the first footnote in an unbreakable frame whose entry
cannot take any space on the current page migrates its whole frame to the
next region when progress is possible; otherwise the entry queues to the
next page (marker and entry may then be on different pages — matching
Typst, which the current local rule never allows). The CSS separator
(`.fn-body.fn-first::before`) is re-derived from the same em values so
paint and reservation cannot drift.

Still unported, and the dominant residual by measurement: entry SPILL
(`flow/compose.rs::footnote_spill` — one entry's body split across pages,
only its first fragment reserving on the marker's page). The local ledger
charges every entry's full height to one page; a Phase 0 soak on a
10-footnote/8-page fixture showed 11/12 divergences with the local pass
ending pages roughly one whole entry early wherever a footnote sits
upstream — the signature of whole-entry charging where Typst spilled.

## Phase 5 — breakable blocks, figures, oversize

- Blocks: Typst's atomicity map (`Child::Single` iff `breakable: false` or
  fractional height; default breakable) vs. the editor's coarser
  everything-atomic-except-paragraphs/lists/tables. The telemetry says
  whether this matters in practice for the supported schema (code blocks
  and display math are the candidates: Typst can split them, the editor
  moves them whole). Port only what the histogram convicts.
- Figures: default placement is `none` (in-flow block) — likely already
  agreeing; float placement (`placement: top/bottom/auto`) is out of scope
  until the editor exposes it.
- Oversize: Typst places a too-tall unbreakable block into an empty region
  and lets it overflow (`may_progress` false → place anyway); the local
  rule matches in spirit — verify exactly at the boundary (the
  `r.height <= contentH` guard) and align.

## Phase 6 — retire the calibrated page-top adjustment

With Phases 1–5 agreeing, the `pageTopAdjustEm` heuristic (a per-kind em
correction applied at every page top so oracle misses "don't visibly shift
the page rhythm") should be re-derivable: region-top spacing collapse plus
parity heights should land blocks where Typst lands them with no fudge
term. Measure with the telemetry; retire the constant table
(`typ-serializer.ts:41-58`) or reduce it to documented ascent physics.
This is last because it is calibration removal — safe only once the rules
underneath are exact.

## Engineering order and shape

1. Phase 0 lands first and alone (pure instrumentation, no behavior change).
2. Each rule phase: extract-current-rule → port → unit tests from the Rust
   → DEV flag → soak until its telemetry bucket is zero → flip → next.
   One commit per phase minimum; the extract step may be its own commit.
3. The suffix paginator consumes every ported rule automatically (shared
   closures), but its seed replay must reproduce ported *state* (spacing
   collapse context and sticky checkpoints at the boundary — same replay
   discipline as its existing footnote/sticky handling). Each phase updates
   the replay and the suffix differential tests together.
4. `paginateForced` (the exact-answer installer) keeps its own math — it
   imposes known-good answers and needs none of these rules; only
   `runFallbackPass` and the suffix pass change.
5. End state: `flow-rules.ts` is a testable mirror of
   `flow/distribute.rs` + `flow/collect.rs` decision logic over
   editor-measured heights; the telemetry histogram is flat zero on the
   corpus; disagreement with an exact answer is treated as a bug with a
   named bucket, exactly like a line-break mismatch today.

## Phase 7 — table row-breaking (after the native-tables port merges)

Native tables land atomic: a compiled page start inside a table declines
the exact page map. This phase restores mid-table page breaks as pure
presentation, the same trick paragraphs use — the document keeps one
editable table node; the break is decorations:

Measured before step 1 (probe on a 40-row booktabs table, letter/NCM 12.5pt):
`#align(center, table(..))` and `#text(size: .., table(..))` both break
between rows; `#figure(table(..))` (any caption/label) never does
(figure.rs:412, `breakable: false`). Only the LAST of consecutive
`table.header` rows repeats (resolve.rs:1834-1843 marks the earlier ones
short-lived); the repeated header sits at the very top of the continuation
region, followed by the row Typst broke before. Vertical-parity note, filed
here rather than fixed: a single-line cell row is 18.54pt in Typst
(2×5pt inset + cap-height extent at 12.5pt) = 24.72px, while the editor row
is the 25px line box — +0.283px per row, constant per line count (a 3-line
cell row measured 74.72 vs 75px). Over 28 rows that is 7.9px; local
decisions can differ from Typst's by one row at a knife edge until the
cell box model charges exactly `10pt + extent·em` per first line.

1. Oracle: accept page starts inside tables by matching row text against
   the compiled SVG lines (a new row-level unit in the matcher, built like
   paragraph line matching; fail closed on ambiguity).
2. Local paginator: row boundaries become break candidates with
   DOM-measured row heights, mirroring Typst's grid rules — break between
   rows, never inside one, and account for repeated-header height
   (`table.header` repetition) on continuation pages.
3. Presentation: the break at row boundary = per-cell padding (or a
   spacer row) sized to the page gap, a closing rule at the page bottom,
   and a non-editable repeated header decoration at the next page top.
   Booktabs styling (no vertical borders, no background) makes the
   interrupted-table visual correct with only these pieces.
4. Fail open: a merged cell (rowspan) crossing the candidate boundary
   declines exact for that map — the table goes atomic/continuous exactly
   as the ported baseline behaves. Typst's rowspan-splitting logic
   (grid/rowspans.rs) is explicitly out of scope until the simple case is
   proven.

## Non-goals

Multi-column layout, floats, parity/two-sided pages, footnote-in-footnote,
per-region block relayout (`MultiChild` semantics beyond Phase 7's
row-level table breaks), and any change to `.typ` serialization or to what
Typst itself computes. Inside tables, Typst's own splits of a rowspan
(grid/rowspans.rs) and of a tall cell across regions (`layout_multi_row`)
are not mirrored: the oracle fails closed on such a page start and the
table is placed atomically, exactly as before Phase 7.
