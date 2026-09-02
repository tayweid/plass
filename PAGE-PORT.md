# PAGE-PORT: porting Typst's page breaker

## Status (2026-08-30)

- Phase 0 (parity telemetry): **landed** 9defb17. Soak at c316f99: 96
  predictions, 1 agreement; byCause page-top-adjust 30, widow-orphan 28,
  spacing 15, footnote 12, sticky 10.
- Phase 4 (footnote arithmetic): **landed** 7b55335 (migration rule still
  deferred). Known interaction gap with Phase 2's fresh-page need check —
  chipped as its own task.
- Phase 2 (widow/orphan need): **landed** 9a2b21b. Plain-prose agreement
  6/25 → 19/25; most "page-top-adjust" disagreements were downstream of
  the old retro-pull heuristic.
- Phase 1 (Regions + spacing collapse): **landed** cbd4410 (fit-test and
  container page-top scope; painted CSS untouched). Residual plain-prose
  spacing disagreement traced to pageTopAdjustEm rounding → Phase 6.
- Oracle coverage fixes along the way: 613b11d (ordered-list markers,
  footnote glue), 9d35355 (opaque-block resync vs list markers). Known
  open oracle family: inline math butted against a known token
  (typst-oracle.ts ~482–502) — not yet reproduced in isolation.
- Next up: Phase 3 (sticky), Phase 6 (retire pageTopAdjustEm — now the
  dominant residual), Phase 4's migration rule, Phase 7 below.
- Native-tables port: **done** on `codex/native-tables-port` (5788e87) —
  see HANDOFF-TABLES-REPORT.md. Tables are native ProseMirror trees and
  land atomic; `table-split.ts` and the mini-compile split path are gone.
  Phase 7 below is unblocked once that branch reaches `main`.

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
Typst itself computes. Tables are atomic until Phase 7: a compiled page
start inside one declines the exact map rather than being mirrored.
