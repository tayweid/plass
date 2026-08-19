# Systematic Improvement Plan

This program improves Plass's correctness, maintainability, efficiency, and
writing experience without changing either line-breaking implementation:

- `src/layout/knuth-plass.ts`
- `src/layout/port/linebreak.ts`

Those files are algorithmic reference implementations. Optimization belongs
around them: font selection, input preparation, browser measurement, caching,
decoration updates, scheduling, and pagination.

## Current status

Sessions 1–9 are complete. Session 10 delivered a conservative suffix planner,
pure rejection tests, and large-document shadow comparison; it deliberately
does not promote the suffix result into production geometry yet. Session 11
completed the documentation and release audit, and deliberately left the
formal-release gate closed on known findings in the upstream precompiled Typst
WASM. The implementation commits are recorded below so future work can
distinguish shipped behavior from the original plan.

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

Outcome — completed in `9d50bd7`:

- The Node-compatible port smoke test became the owned `test:layout` command.
- Development-only hooks record live and settled timing, changed blocks,
  forced-path use, decoration dispatches, and pagination behavior.
- Browser fixtures assert that a live exact paragraph is unchanged after the
  compiled oracle settles and that multi-page spacers disappear when a
  document shrinks to one page.
- Wall-clock values remain diagnostic because they vary by machine; structural
  counters and exact signatures are the release regression budgets.

## Session 2: central font registry

- Replace the independent UI, CSS, compiler, sidecar, parity, and oracle font
  lists with one capability registry.
- Define one deterministic effective font for the DOM, live port, and compiler.
- Make New Computer Modern the first explicitly certified exact family.
- Preserve historical settings while resolving unsupported families to the
  same bundled fallback in both editor and export.

Exit gate: default-font documents have one unambiguous font identity through
the complete renderer.

Outcome — completed in `7a4c837`:

- `src/font-registry.ts` is the single capability inventory for settings, CSS,
  compiler assets, sidecar keys, parity metrics, and fallback identities.
- Stored font preferences remain round-trippable while `effectiveFont` gives
  every renderer and exporter one deterministic family.
- Registry and security tests reject arbitrary font names and duplicate or
  shadowed compiler/sidecar identities.

## Session 3: certify or narrow additional fonts

- Pass the effective family and style to sidecar shaping.
- Register complete faces for each candidate family.
- Add browser faces and compiler assets from the same supported family.
- Differential-test each family before exposing it in the selector.
- Keep unproven families unavailable rather than presenting approximate
  WYSIWYG behavior.

Exit gate: every selectable font produces identical live and compiled breaks.

Outcome — completed in `17435f1`:

- New Computer Modern is the only family marked both `exact` and `selectable`.
  Its regular, italic, bold, and bold-italic faces are explicitly registered
  across the browser, compiler, and sidecar.
- Historical and uncertified bundled names resolve to New Computer Modern for
  layout and export instead of making an unsupported fidelity claim.
- Pure certification and browser tests enforce the public selector and shared
  effective-family contract. Adding another family requires equivalent proof,
  not only bundled files.

## Session 4: correctness and vestige cleanup

- Fix multi-page-to-single-page spacer removal.
- Add generation checks for stale asynchronous oracle/table results.
- Remove dead table helpers and confirmed unused code.
- Enable TypeScript unused checking.
- Break the `typeset-plugin` / `table-split` import cycle.
- Make long-lived watchers disposable.

Exit gate: the layout import graph is acyclic, strict checking passes, and the
known asynchronous and pagination edge cases have regression tests.

Outcome — completed in `87a4638`:

- Paragraph, page, and table results carry generations so superseded async
  work cannot publish into a newer document state.
- The multi-page-to-single-page spacer regression is covered in the browser.
- The `typeset-plugin`/table cycle and dead table helpers were removed; build
  now checks unused code and the static value-import graph.
- Image, preview, font, and table watchers have explicit teardown paths.

## Session 5: extract decoration and block layout

- Move break, hyphen, spacing, page-gap, and no-spell decoration creation into
  a cohesive module.
- Move cache keys, atom resolution, and paragraph/caption/footnote preparation
  into a block-layout module.
- Preserve all existing signatures and scheduling.

Exit gate: exactness, page starts, and exported documents are identical to the
Session 1 baseline.

Outcome — completed in `1e370fa`:

- Decoration construction and semantic page-gap roles live in
  `src/layout/line-decorations.ts`.
- Cache keys, atom widths, painted caption/footnote prefixes, and reusable
  block-layout contracts live in `src/layout/block-layout.ts`.
- Focused pure tests protect cache tolerances, settings keys, and decoration
  output while the ProseMirror plugin remains the coordinator.

## Session 6: extract scheduling and oracle coordination

- Separate edit, idle, resize, font, and asset scheduling from the ProseMirror
  plugin state.
- Isolate paragraph/page oracle lifecycle and confidence state.
- Keep `TypesetView` as a small orchestrator rather than the owner of every
  algorithm and state transition.

Exit gate: behavior is unchanged and the central coordinator has clear,
testable responsibilities.

Outcome — completed in `397e984`:

- `LayoutScheduler` owns microtask live layout, the edit settle window,
  resize/font observation, and disposal.
- `OracleCoordinator` owns paragraph/page oracle construction, generation
  lifecycle, teardown, cache clearing, and exact/held/fallback confidence.
- Deterministic scheduler and oracle tests cover coalescing, stale completion,
  failure streaks, recovery, and destruction.

## Session 7: exact forced-layout fast path

- Once the port has selected breaks, partition only at forced breaks, style-run
  boundaries, atoms, and hard breaks.
- Do not syllabify again or rebuild the legacy KP item stream.
- Measure only the natural browser widths required to calculate the existing
  conservative `word-spacing` values.
- Cache stable block measures and batch atom reads.

Exit gate: break/line signatures and pixel tolerances are unchanged while DOM
Range reads and warm per-keystroke time fall materially.

Outcome — completed in `95a96fb`:

- `layoutForcedBlock` partitions authoritative output directly at forced
  breaks, style boundaries, atoms, and hard breaks, retaining the legacy path
  as a fail-closed fallback and development auditor.
- The deterministic long-paragraph fixture reduced Range reads from **499 to
  19** (about 96%). The browser differential corpus requires every direct case
  to use no more reads or probe populations than legacy, the long case to use
  at most half as many reads, and aggregate reads to stay at or below 65%.
- Mixed marks, atoms, captions, 0.85-scale footnotes, whitespace, hyphens, and
  hard breaks retain their line semantics. The direct path also fixed the
  legacy partitioner's lost hard-break suffix without changing either frozen
  line-breaking algorithm.

## Session 8: incremental decorations

- Replace the whole-document signature with block-relative layout signatures.
- Compare exact live output with the already-mapped decoration state and skip
  no-op dispatches.
- Update only invalidated block decorations.
- Track broad dependency versions for settings, citations, references,
  figures, and footnotes.

Exit gate: a normal text edit causes at most one layout decoration dispatch and
settling does not reinstall the same layout.

Outcome — completed in `f2159e5`:

- Every typesetting decoration has an explicit semantic kind and a canonical,
  order-independent digest. Block-relative ownership survives ProseMirror
  mapping and excludes adjacent or nested footnote-owned ranges.
- Live edits rebuild only affected body, caption, or footnote decorations and
  reuse a port layout when the compiled break signature agrees.
- Browser regressions require exactly one line-decoration dispatch for normal
  body, caption, and footnote edits; after a 1.2-second oracle/settle window the
  break signature and dispatch count must remain unchanged.

## Session 9: pagination snapshots and stale-result control

- Snapshot spacers, table extras, page metrics, and cumulative heights once per
  run.
- Replace repeated linear spacer scans with prefix sums and binary lookup.
- Coalesce page-oracle requests and ignore superseded generations.
- Represent pagination confidence explicitly as exact, held, or fallback.

Exit gate: pagination decisions are unchanged and repeated work is removed.

Outcome — completed in `935ab96`:

- Each pagination pass captures one immutable stream of page gaps and table
  extras, then uses a Float64 prefix-sum `HeightIndex` with binary lookup.
- The randomized pure differential runs 100 sets of 80 signed samples across
  the query range and requires byte-identical results to the stable linear
  reference, including duplicate positions and addition order.
- Browser counters require one spacer scan and one table scan per captured
  pass. Page confidence is explicit (`exact`, `held`, or `fallback`), and
  paragraph, page, and table generations reject stale completions.

## Session 10: suffix pagination and writing stability

- Track the earliest invalidated top-level block.
- Preserve authoritative page starts before the affected page and recompute the
  suffix only; retain a full fallback for global invalidations.
- Optionally anchor the caret's viewport position by adjusting only scrolling
  after exact reflow—never the chosen breaks.
- Validate IME, selection, spellcheck, undo, and 50-page fixtures.

Exit gate: late-document edits do not rescan earlier pages and the caret remains
visually stable without changing exact layout.

Outcome — shadow infrastructure completed in `f45c42f`:

- A pure planner compares the last basis document directly with the current
  document, finds the earliest accumulated edit, and accepts only an exact
  top-level paragraph/page boundary with contiguous marker ordinals and an
  exact one-for-one spacer prefix.
- Structural edits, non-paragraph top-level content, inline atoms, footnotes,
  mid-line or nested anchors, changed global epochs, malformed markers, and
  mismatched spacer prefixes all reject to the complete paginator.
- A 960-paragraph browser fixture produces 40–50 pages, edits paragraph 901,
  and requires the candidate suffix to visit less than 25% as many units as
  the full reference. It also checks an unchanged prefix signature, selection,
  spellcheck, undo, and caret/scroll movement within 2 px.
- **Promotion remains shadow-gated.** Every eligible run computes and compares
  both candidates, records the result, and installs the full pagination result.
  Production selection is blocked until a deterministic production-mode
  exact-source fixture exercises mapped authoritative markers and spacer
  provenance with zero corrections. Cumulative-height cancellation is not
  sufficient: painted spacer geometry must agree at every page boundary.

## Session 11: documentation and release audit

- Reconcile README, PORT, ROADMAP, contributor guidance, and code comments with
  the implemented architecture.
- Document supported-font and fallback guarantees.
- Document layout benchmarks and the maintainer checklist.
- Run unit, layout, browser, production, license, and security verification.

Exit gate: documentation describes the code that actually ships and the full
release suite passes from a clean checkout.

Outcome — audit completed; formal release remains blocked:

- README, PORT, ROADMAP, contributor guidance, release/security policy, UI
  hints, and the session record now describe the implementation that actually
  ships. Stale screenshots, an attributed development transcript, and an
  unrelated unimplemented backend plan were removed from release artifacts;
  the checklist explicitly calls out the optional pre-public history decision.
- The workflow runs npm and sidecar Rust audits, license, unit, layout,
  browser, sidecar source, build, and production-artifact checks; whole-workflow
  cancellation and a separate global Pages lock prevent stale deployment. A
  parallel Linux job rebuilds the sidecar byte-for-byte before deployment.
- The sidecar was corrected from `hypher` 0.1.5 to the 0.1.6 version selected
  by the reconstructed typst.ts outer graph and corroborated by the shipped
  compiler's embedded crate path. Rust 1.97.0 and wasm-pack 0.15.0 are pinned;
  host paths are remapped; source, lock, toolchain, and generated-artifact
  hashes are recorded and verified. The frozen break algorithms were not
  changed.
- Plass's MIT license, sidecar notices, and a conservative 436-crate Typst WASM
  inventory ship in the static artifact. The exact MPL-2.0 `option-ext` source
  archive is distributed and checksum-verified. The three Typst npm packages
  are exact-pinned at 0.7.0, and their tarball SRI and WASM hashes are checked.
- `npm audit` reports zero vulnerabilities. The Plass-owned sidecar RustSec
  audit reports zero vulnerabilities and two documented unmaintained-package
  warnings retained for compiler parity. A timeout now opens an epoch-scoped
  compiler circuit: automatic retries cannot create more workers until new
  user input, while a timeout from an older epoch cannot cancel newer work.
- Project-image object URLs and watcher state are scoped to the active
  directory handle and generation. Switching projects revokes the previous
  URLs, and asynchronous reads from an old directory cannot populate the new
  project's cache even when relative paths, timestamps, and sizes coincide.
- **The exit gate is intentionally not satisfied for a formal release.** A
  partial binary RustSec scan finds nine advisories in the precompiled compiler
  and two in the renderer; `quick-xml` is plausibly reachable through raw
  Typst/CSL XML. Worker isolation, input/output limits, deadlines, and the
  circuit reduce impact but do not erase the findings. Replace the binaries
  with a reviewed build or record an explicit independent per-advisory risk
  decision before removing the public-preview label.

## Required check for any layout change

- The two frozen algorithm files have no diff against the target branch.
- `npm test` and `npm run test:layout` pass, including cached/pure and live
  differential corpora.
- The compiled oracle causes no correction in supported cases, and a normal
  edit performs at most one line-decoration dispatch.
- Browser line ranges and page-start signatures remain unchanged.
- Range reads, geometry scans, suffix units, dispatches, and other performance
  counters do not exceed their checked-in budgets.
- Typst/Markdown round trips, persistence, undo, selection, spellcheck,
  security boundaries, and browser tests pass.
- Suffix output remains shadow-only until the exact-source production gate
  above is satisfied.

## Full release command gate

Run from a clean checkout of the exact release commit:

```sh
npm ci
npm audit --audit-level=moderate
cargo install cargo-audit --locked --version 0.22.2
cargo audit --file sidecar/Cargo.lock
cargo audit bin \
  node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm \
  node_modules/@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm
npm run verify:licenses
npm run verify:sidecar
npm test
cargo test --locked --manifest-path sidecar/Cargo.toml
npm run test:layout
npx --no-install playwright install chromium firefox webkit
npm run test:browser
npm run build
npm run verify:production
```

`npm run build` includes unused-code, import-cycle, TypeScript, and production
bundle checks. `npm run verify:production` must follow it because it inspects
the built artifact. Complete the manual and deployment checks in
`RELEASING.md`; a passing local suite does not replace CodeQL, Dependabot
review, supported-browser smoke tests, or verification of the deployed HTTPS
site. The precompiled-WASM binary audit is expected to fail on the current
upstream 0.7.0 artifacts; that failure is the formal-release blocker, not a
check to suppress or omit.
