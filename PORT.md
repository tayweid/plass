# The Port: a scoped Typst line-breaking mirror in the editor

Goal: within Plass's certified font and content contract, the real-time
breaker should produce the same ordered break offsets and hyphen kinds as the
pinned Typst compiler. That is a narrower and testable promise than "all Typst
documents, always": constructs the adapter cannot represent and environments
where the shaping sidecar is unavailable deliberately fall back to the legacy
breaker. The compiled Typst oracle remains the verifier and authority.

Reference source: [Typst at commit
`951788cc614cd805d5d786e17bbf93796df73d10`](https://github.com/typst/typst/tree/951788cc614cd805d5d786e17bbf93796df73d10),
the pinned upstream tree embedded in our compiler WASM
(`@myriaddreamin/typst-ts-web-compiler` 0.7.0, typst-assets 0.14.2; verified
via panic-path strings in the binary). Everything below cites that upstream
tree.

## Current status

- **Implemented:** the Rust/WASM primitives sidecar, the TypeScript mirror in
  `src/layout/port/`, the ProseMirror adapter, and the direct forced-break
  translator. The port is enabled by default for New Computer Modern body
  paragraphs, figure captions, and footnote bodies that the adapter can map.
- **Certified scope:** New Computer Modern is the only exact/selectable body
  family. Its regular, italic, bold, and bold-italic faces, plus the shared
  DejaVu Sans Mono face, are registered explicitly across the browser,
  compiler, and sidecar. Other bundled or historical names resolve to New
  Computer Modern for live layout and export while their stored preference is
  preserved.
- **Live behavior:** a changed block uses cached compiled breaks when present,
  otherwise the local port, otherwise legacy Knuth–Plass. Authoritative
  offsets go through `layoutForcedBlock`, which skips a second break search;
  its conservative legacy translator remains the fail-closed fallback.
  Block-relative decoration updates make a matching settled oracle result a
  no-op.
- **Proof status:** the differ harness and browser audits cover the supported
  contexts, while port smoke and face-registration checks run under
  `npm run test:layout`. This is not a universal certification of arbitrary
  Typst markup, scripts, languages, fonts, or fallback shaping.
- **Pagination is separate:** whole-document Typst page starts are used when
  they compile and map safely, then may be held while a replacement is
  pending. The complete local paginator remains the fallback. The suffix-only
  planner is a development shadow comparison: whenever it runs, the full
  fallback result is installed, and production does not invoke the planner.

## Finding: Typst is not TeX, and we implemented TeX

`src/layout/knuth-plass.ts` is classic Knuth–Plass 1981: box/glue/penalty
items, fitness classes, adjacent-demerits, double-hyphen demerits applied
after squaring, tolerance-escalation passes, flat hyphen penalty (45).

Typst (`crates/typst-layout/src/inline/linebreak.rs`) is a deliberate
departure — the comment at the top says so ("Typst doesn't have the
concept of glue, so things work a bit differently"):

- **No item model.** The DP walks text byte offsets produced by a
  breakpoint generator; every candidate line is built as a real `Line`
  with shaped-glyph metrics (`line()` in `line.rs`).
- **No fitness classes, no adjacent demerits, no tolerance passes.**
- **Cost** (`raw_cost`): `(1 + badness + penalty)²` where
  - badness = `1_000_000` if `ratio < min_ratio`, else `100·|ratio|³`,
    else `0` for an unjustified mandatory-break line that needs no shrink
  - hyphen penalty = `(1 + 0.15·steps) · 135` with
    `steps = max(0,5−l) + max(0,5−r)` — hyphenating < 5 chars from either
    word edge costs extra (l, r = chars before/after the hyphen)
  - consecutive-dash penalty `+135` when this line *and* its predecessor
    end in any dash (soft hyphen, `-`, `–`, `—`) — inside the square,
    unlike TeX
  - runt penalty `+100` when the final line is a single unbreakable chunk
  - cost factors scale by `par.costs` (defaults 100%)
- **Ratio** (`raw_ratio`): `delta / adjustability`, with `approx_eq`
  zeroing (`|delta| < 1e-4` raw), NaN→0; if ratio > 1 the extra stretch
  spills over justifiable glyphs, normalized by `font_size / 2`;
  final clamp to `[−2, 10]`. `min_ratio` = −1 justified, 0 ragged.
- **Two DP passes** (`linebreak_optimized`): an *approximate* pass over
  cumulative width/stretch/shrink/justifiable arrays (hyphen estimated at
  0.33 em) computes a cost upper bound; the *exact bounded* pass re-runs
  the DP building real lines, pruning with the bound (`BOUND_EPS 1e-3`),
  an `active` window (advanced on overfull-from-front and mandatory
  breaks), and per-breakpoint lower bounds. Bail to `INFINITY` bound if
  the approximate layout is overfull. Tie-break: **later predecessor wins
  on equal total** (`best.total >= total`).
- **Breakpoints** (`breakpoints()`): ICU4X UAX #14 line segmentation
  (LSTM segmenter, typst-assets ICU blob), special-cased URL breaking
  (`linebreak_link`), hyphenation via `hypher` within
  `split_word_bounds` segments that are all-alphabetic, with the
  Glue/WordJoiner/ZWJ last-char filter and per-offset
  hyphenate/lang lookups. `Breakpoint::Hyphen(l, r)` carries the char
  counts the cost function needs.
- **Line construction** (`line()`): breakpoint-specific end trim
  (whitespace+ZWS for Normal; mandatory-break chars for Mandatory;
  nothing for Hyphen — `Breakpoint::trim`), a real shaped `-` glyph
  appended on soft breaks (its width comes from the font, not a
  constant), hard-dash repetition at next-line start for some languages,
  weak-spacing trimmed at line edges, CJ boundary adjustments,
  `width = Σ natural_width`. Dash classification: Soft (hyphenation or
  text ending in U+00AD), Hard (`-`), Other (`–`/`—`).
- **Adjustability** (`shaping.rs::base_adjustability` +
  `par.justification-limits` defaults): a space stretches
  `(150% − 100%)·width` and shrinks `(100% − 66⅔%)·width` (shrink capped
  at 75% of glyph width); tracking limits default 0; CJK punctuation
  classes shrink by ½/¼-width rules. `justifiables()` counts justifiable
  glyphs minus a trailing-CJ exception. (Our glue constants w/2, w/3
  were calibrated to exactly these — the constants were never the
  problem; the algebra around them was.)

Every knife-edge flip we chased is this dialect difference. Calibrating
constants inside the TeX algebra can never converge — the *shape* of the
cost function differs (e.g. edge-distance hyphen scaling, prefer-fewer-
lines "+1", runts, no fitness).

## Strategy: version-pinned data, mirrored algorithm, preserved arithmetic

Exactness decomposes into three layers, each handled differently:

1. **Data (version-pinned):** UAX #14 breaks, hyphenation points, glyph
   advances. These come from specific versions of `icu_segmenter` (+ICU
   blob), `hypher`, `rustybuzz` + the font bytes. No JS lookalike
   (`linebreak` npm, JS Hypher, canvas measureText) is trustworthy at
   knife-edge precision. The implemented Rust → WASM primitives sidecar
   pins the versions selected by the authenticated typst.ts 0.7.0 outer
   source graph associated with the npm-registry-reported gitHead (which
   resolves Typst source 951788c) and the same
   data (ICU blob from typst-assets, our NCM font bytes) and exposes the
   required synchronous primitives:
   - UAX #14 segment offsets and line-break classes, plus UAX #29 word
     boundaries
   - `hyphenate(word, lang)` syllable byte offsets
   - a font-registering `Shaper` with glyph metrics and shaped glyph tuples
     (glyph id, byte cluster, advance, offset, and unsafe-to-break flag)
   The bridge in `src/layout/primitives.ts` loads these synchronous,
   cacheable operations alongside the compiler WASM. Version and asset
   identity remove known sources of drift; differential tests remain the
   guard against integration or porting mistakes.
2. **Algorithm (pure):** the mirror ports `linebreak.rs` + the metrics half of
   `line.rs`/`shaping.rs` to TypeScript, function-for-function with the
   Rust names kept (`breakpoints`, `raw_ratio`, `raw_cost`,
   `linebreak_optimized_approximate`, `linebreak_optimized_bounded`,
   `line`, `Breakpoint::trim`, …), field-for-field (`Line { width,
   justify, dash }`), constant-for-constant. Rust f64 and JS number are
   both IEEE-754 doubles: identical operations in identical order give
   identical bits. Porting rules:
   - `powi(2)`/`powi(3)` → explicit `x*x` / `x*x*x` (NOT `Math.pow`,
     which may differ in ULPs)
   - keep Typst's op order in every formula; no algebraic "cleanup"
   - `Abs` = raw f64 pt with `EPS = 1e-4` (`fits`, `approx_eq`,
     `approx_empty` ported as-is); `Em` = raw f64
   - tie-breaks preserved (`>=` keeps the later predecessor)
   - both DP passes ported (the bound is a pure optimization, but port
     it anyway — same code, same behavior, same performance shape)
3. **Inputs (ours to control):** the `(text, items, config)` triple the
   algorithm consumes must equal what real Typst builds from our
   *emitted* `.typ` (`collect.rs`/`prepare.rs`). Plass owns this mapping
   and rejects the port path when the adapter cannot express it safely.
   Supported inputs include text runs, mapped math/cite
   atoms as `Item::Frame`-equivalents with their measured widths, SHY,
   first-line indent, footnote/caption 0.85-em contexts, justify flag,
   font size, lang.

**Alternative considered — vendor the whole inline module as Rust/WASM**
(compile Typst's own `linebreak()` directly): zero algorithm-divergence
risk, but `Preparation`/`Engine` are entangled with the full style
system and World; the surgery to decouple is larger than the port and
leaves us with a Rust fork to maintain. The sidecar-primitives + TS
mirror keeps version-pinned shaping data and the algorithm
readable/debuggable in our codebase. If the differ (phase 4) exposes a
disagreement we cannot pin down in the TS mirror, this remains the
fallback.

## Implementation phases and status

### 0. Toolchain + sidecar — implemented

- `sidecar/` pins `icu_segmenter`, `icu_properties`, `icu_provider*`,
  `hypher`, `rustybuzz`, and `typst-assets` to the versions selected by the
  authenticated typst.ts 0.7.0 outer source graph. That graph selects
  `hypher` 0.1.6 even though the nested Typst checkout's lock at 951788c
  records 0.1.5, and the shipped compiler embeds the 0.1.6 crate path. The npm
  tarballs omit a verifiable gitHead, so this is strong version corroboration,
  not a demonstrated reproducible source-to-compiler build.
- `src/layout/primitives.ts` loads the checked-in WASM and registers
  namespaced face keys. The sidecar shapes with the compiler font files;
  browser tests separately verify the declared web faces.
- Sidecar notices and asset registration are release-checked. New Computer
  Modern's four faces and the shared mono face are part of the current public
  certification gate.

### 1. The mirror — implemented

- `src/layout/port/bytes.ts`, `shaping.ts`, `prepare.ts`, and `linebreak.ts`
  mirror Typst's byte indexing, shaped-run model, line construction, cost
  calculation, breakpoint generation, and two optimized DP passes.
- Operation order, explicit powers, epsilon behavior, and equal-cost
  tie-breaking are kept visible in the code rather than algebraically
  simplified.
- The mirror produces Typst-style line ranges; `src/layout/port/adapter.ts`
  translates them to the forced-break contract consumed by the DOM renderer.

### 2. Inputs: ProseMirror block → `Preparation` — implemented for the certified scope

- The adapter maps text and supported marks, the shared mono code face,
  hard breaks, measured inline atoms, first-line indents, real caption-prefix
  text, and the 0.85-em footnote context.
- Runs are shaped as runs, preserving cross-word shaping and safe-to-break
  slice behavior. Unsupported structures return `null` instead of inventing
  an approximately equivalent Typst input.

### 3. Live wiring — implemented, with a fail-closed fallback

- The port is on by default after the primitives load. Cached compiled breaks
  take precedence; the port supplies an immediate full-block answer when no
  compiled entry is ready; classic Knuth–Plass handles degraded or unmapped
  cases.
- Both compiled and port break lists go through `layoutForcedBlock`. If its
  validation rejects an input, the established forced-layout translator is
  retained rather than weakening the selected break signature.
- Downstream line, hyphen, spacing, and page-gap decorations remain
  presentation-only and use the same ProseMirror contract whichever source
  selected the breaks.

### 4. Differential proof — active and intentionally scoped

- `differ.html` / `src/differ.ts` can compare plain, ProseMirror-level, and
  caption/footnote cases against the in-app compiler. The layout test command
  covers port smoke behavior and every selectable sidecar face; browser tests
  cover face loading, forced-translation equivalence, and settled no-op
  behavior.
- The original broader corpora and knife-edge measure sweeps remain the
  standard for widening the exact contract. A divergence is a bug or a reason
  to narrow support, not a tolerance to hide.
- Current documentation therefore claims exactness only for the certified
  family and mapped constructs covered by these gates, not every input Typst
  can typeset.

### 5. Writing path — implemented

- `LayoutScheduler` coalesces changed-block work into the next microtask and
  schedules a complete verification pass after a 250 ms quiet period.
- The old caret-ownership, frozen-prefix, and healing-window policy is gone.
  Live layout evaluates the complete changed block, then rebuilds only that
  block's owned decorations.
- Semantic break signatures let the compiled verifier reuse a matching port
  layout. Browser regressions require one line-decoration dispatch for an
  ordinary body, caption, or footnote edit and no identical settle reinstall.
- The keystroke path is incremental across runs
  (`src/layout/port/incremental.ts`): both DP passes always re-execute in
  full — the approximate pass's paragraph-global cost bound and the
  float-accumulated totals make cached-DP-state splicing unprovable at knife
  edges — but `line()` construction, the per-candidate O(paragraph) cost, is
  served from the previous run wherever a byte range lies inside a region
  whose text and shaped glyph values are verified equal (offset-mapped).
  Any mismatch, non-'en' language, or CJ-mutation-capable glyph fails open
  to fresh construction; `incremental-linebreak.test.ts` differentially
  gates the served path against from-scratch runs per edit.
- Conservative forced-layout tolerances and the legacy translator remain as
  browser-rendering guards; they are not alternate break-selection policies.

### 6. Page breaking — partial, separate from the line port

- The whole-document Typst oracle provides exact page starts when compilation
  and DOM mapping succeed. Mapped starts can be held while a fresh result is
  pending; confidence failure or invalid geometry returns to the full local
  paginator for footnotes, widow/orphan rules, and block placement.
- Each pass captures one immutable geometry snapshot and uses prefix sums for
  height queries. Long-table splits come from paged Typst mini-compiles and
  can be checked against whole-document oracle boundaries.
- A conservative suffix planner accepts only simple top-level paragraph edits
  at proven page anchors. It currently runs in development as a full-versus-
  suffix shadow and records comparison telemetry. The full result is always
  installed; no production optimization claim is made yet.

## Remaining certification work

- Turn the broader real-document, randomized, punctuation/hyphenation, and
  knife-edge sweep corpus into a reproducible release gate before expanding
  the supported-content claim.
- Certify additional languages, scripts, fallback-glyph behavior, and font
  families independently; keep them unavailable until browser, sidecar, and
  compiler identity is demonstrated for all required faces.
- Keep mapping more inline constructs only when their emitted Typst inputs can
  be represented without approximation.
- Do not promote suffix pagination until a production-mode exact-source
  browser fixture proves mapped marker and painted-spacer provenance with zero
  corrections. A direct port of Typst's `flow/` logic would be a separate
  project, not an implied property of the line-breaking mirror.
