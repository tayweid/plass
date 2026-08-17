# Systematic Improvement Plan

This program improves Plass's correctness, maintainability, efficiency, and
writing experience without changing either line-breaking implementation:

- `src/layout/knuth-plass.ts`
- `src/layout/port/linebreak.ts`

Those files are algorithmic reference implementations. Optimization belongs
around them: font selection, input preparation, browser measurement, caching,
decoration updates, scheduling, and pagination.

## Invariants

1. For every supported font and content type, the live port's break signature
   must equal the compiled Typst oracle's signature.
2. No browser-greedy typing mode, frozen-prefix approximation, stability cost,
   or other change may alter the selected breaks.
3. A committed edit should install one exact line layout before paint. A normal
   background oracle confirmation must not cause a visual correction.
4. Decorations remain presentation-only: document content, undo, clipboard,
   accessibility, serialization, and persistence stay unchanged.
5. Page geometry is held during an edit burst and replaced atomically by a
   fresh authoritative result.
6. Every session ends with a working editor, passing tests, and one focused
   commit.

## Session 1: safety net and baselines

- Repair the Node-compatible port smoke harness.
- Add an owned `test:layout` command and browser regression coverage.
- Record development-only live and settled phase timings.
- Establish fixtures for long paragraphs and long documents.
- Measure edit-to-layout time, geometry reads, decoration dispatches, and
  oracle corrections.

Exit gate: CI detects changed break decisions, post-oracle corrections, stale
pagination, and meaningful performance regressions.

## Session 2: central font registry

- Replace the independent UI, CSS, compiler, sidecar, parity, and oracle font
  lists with one capability registry.
- Define one deterministic effective font for the DOM, live port, and compiler.
- Make New Computer Modern the first explicitly certified exact family.
- Preserve historical settings while resolving unsupported families to the
  same bundled fallback in both editor and export.

Exit gate: default-font documents have one unambiguous font identity through
the complete renderer.

## Session 3: certify or narrow additional fonts

- Pass the effective family and style to sidecar shaping.
- Register complete faces for each candidate family.
- Add browser faces and compiler assets from the same supported family.
- Differential-test each family before exposing it in the selector.
- Keep unproven families unavailable rather than presenting approximate
  WYSIWYG behavior.

Exit gate: every selectable font produces identical live and compiled breaks.

## Session 4: correctness and vestige cleanup

- Fix multi-page-to-single-page spacer removal.
- Add generation checks for stale asynchronous oracle/table results.
- Remove dead table helpers and confirmed unused code.
- Enable TypeScript unused checking.
- Break the `typeset-plugin` / `table-split` import cycle.
- Make long-lived watchers disposable.

Exit gate: the layout import graph is acyclic, strict checking passes, and the
known asynchronous and pagination edge cases have regression tests.

## Session 5: extract decoration and block layout

- Move break, hyphen, spacing, page-gap, and no-spell decoration creation into
  a cohesive module.
- Move cache keys, atom resolution, and paragraph/caption/footnote preparation
  into a block-layout module.
- Preserve all existing signatures and scheduling.

Exit gate: exactness, page starts, and exported documents are identical to the
Session 1 baseline.

## Session 6: extract scheduling and oracle coordination

- Separate edit, idle, resize, font, and asset scheduling from the ProseMirror
  plugin state.
- Isolate paragraph/page oracle lifecycle and confidence state.
- Keep `TypesetView` as a small orchestrator rather than the owner of every
  algorithm and state transition.

Exit gate: behavior is unchanged and the central coordinator has clear,
testable responsibilities.

## Session 7: exact forced-layout fast path

- Once the port has selected breaks, partition only at forced breaks, style-run
  boundaries, atoms, and hard breaks.
- Do not syllabify again or rebuild the legacy KP item stream.
- Measure only the natural browser widths required to calculate the existing
  conservative `word-spacing` values.
- Cache stable block measures and batch atom reads.

Exit gate: break/line signatures and pixel tolerances are unchanged while DOM
Range reads and warm per-keystroke time fall materially.

## Session 8: incremental decorations

- Replace the whole-document signature with block-relative layout signatures.
- Compare exact live output with the already-mapped decoration state and skip
  no-op dispatches.
- Update only invalidated block decorations.
- Track broad dependency versions for settings, citations, references,
  figures, and footnotes.

Exit gate: a normal text edit causes at most one layout decoration dispatch and
settling does not reinstall the same layout.

## Session 9: pagination snapshots and stale-result control

- Snapshot spacers, table extras, page metrics, and cumulative heights once per
  run.
- Replace repeated linear spacer scans with prefix sums and binary lookup.
- Coalesce page-oracle requests and ignore superseded generations.
- Represent pagination confidence explicitly as exact, held, or fallback.

Exit gate: pagination decisions are unchanged and repeated work is removed.

## Session 10: suffix pagination and writing stability

- Track the earliest invalidated top-level block.
- Preserve authoritative page starts before the affected page and recompute the
  suffix only; retain a full fallback for global invalidations.
- Optionally anchor the caret's viewport position by adjusting only scrolling
  after exact reflow—never the chosen breaks.
- Validate IME, selection, spellcheck, undo, and 50-page fixtures.

Exit gate: late-document edits do not rescan earlier pages and the caret remains
visually stable without changing exact layout.

## Session 11: documentation and release audit

- Reconcile README, PORT, ROADMAP, contributor guidance, and code comments with
  the implemented architecture.
- Document supported-font and fallback guarantees.
- Document layout benchmarks and the maintainer checklist.
- Run unit, layout, browser, production, license, and security verification.

Exit gate: documentation describes the code that actually ships and the full
release suite passes from a clean checkout.

## Required check for any layout change

- The two algorithm files are unchanged.
- Cached and live differential corpora pass.
- The compiled oracle causes no correction in supported cases.
- Browser line ranges and page-start signatures remain unchanged.
- Performance does not exceed the recorded budget.
- Typst/Markdown round trips, persistence, security, and browser tests pass.

