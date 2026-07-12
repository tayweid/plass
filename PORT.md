# The Port: bit-exact Typst line breaking in the editor

Goal: the editor's real-time line breaker produces **the same breaks as
Typst, always** — not calibrated, not approximately, but exactly, because
it is a one-to-one port of Typst's algorithm fed by identical data. Then
the entire live-typing diplomacy stack (ownership, frozen prefixes,
hold-until-truth, healing windows) gets deleted: one engine, run globally
on the whole paragraph on every keystroke, with the WASM oracle demoted
to a background auditor.

Reference source: `vendor/typst/` — typst at commit
`951788cc614cd805d5d786e17bbf93796df73d10`, the **exact commit embedded in
our compiler WASM** (`@myriaddreamin/typst-ts-web-compiler` 0.7.0,
typst-assets 0.14.2; verified via panic-path strings in the binary).
Everything below cites that tree.

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

## Strategy: same data, same algorithm, same arithmetic

Exactness decomposes into three layers, each handled differently:

1. **Data (unforgeable):** UAX #14 breaks, hyphenation points, glyph
   advances. These come from specific versions of `icu_segmenter` (+ICU
   blob), `hypher`, `rustybuzz` + the font bytes. No JS lookalike
   (`linebreak` npm, JS Hypher, canvas measureText) is trustworthy at
   knife-edge precision, and drift is permanent. **Plan: a tiny Rust →
   WASM "primitives sidecar"** that vendors the *same crates at the same
   versions* (pinned from typst's `Cargo.lock` at 951788c) and the same
   data (ICU blob from typst-assets, our NCM font bytes) and exposes
   three synchronous calls:
   - `segment(text) → [{offset, mandatory, eaten}]`
   - `hyphenate(word, lang) → [syllable byte offsets + char counts]`
   - `shape(text, fontIdx, sizePt, features) → [{cluster, xAdvanceEm,
     safeToBreak, char, isSpace}]`
   ~100 lines of Rust, compiled once with wasm-pack, loaded alongside
   the compiler WASM. Synchronous, cacheable, and *identical to Typst by
   construction* — these three can never disagree.
2. **Algorithm (pure):** port `linebreak.rs` + the metrics half of
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
   *emitted* `.typ` (`collect.rs`/`prepare.rs`). We already own this
   mapping — the oracle spec (`buildSpec`) proves our text extraction
   round-trips. The port consumes the same spec: text runs, math/cite
   atoms as `Item::Frame`-equivalents with their measured widths, SHY,
   first-line indent, footnote/caption 0.85-em contexts, justify flag,
   font size, lang.

**Alternative considered — vendor the whole inline module as Rust/WASM**
(compile Typst's own `linebreak()` directly): zero algorithm-divergence
risk, but `Preparation`/`Engine` are entangled with the full style
system and World; the surgery to decouple is larger than the port and
leaves us with a Rust fork to maintain. The sidecar-primitives + TS-
mirror plan gets data-exactness by construction and keeps the algorithm
readable/debuggable in our codebase. If the differ (phase 4) exposes a
disagreement we cannot pin down in the TS mirror, this remains the
fallback.

## Phases

### 0. Toolchain + sidecar (once)
- Install rustup + `wasm32-unknown-unknown` + wasm-pack.
- `sidecar/` crate pinned to the `Cargo.lock` versions typst 951788c
  uses: `icu_segmenter`, `icu_properties`, `icu_provider*`, `hypher`,
  `rustybuzz`, `typst-assets` (ICU blob only).
- Verify our `public/fonts` NCM TTFs are byte-identical to what the
  compiler WASM embeds (the sidecar must shape with the same bytes the
  oracle shapes with).
- Bridge module `src/layout/primitives.ts`: loads the WASM, memoizes
  (`segment` per paragraph text, `shape` per run, `hyphenate` per word —
  vocabulary saturates fast).

### 1. The mirror: `src/layout/typst-linebreak.ts`
- Port in this order, testing each against the sidecar as we go:
  1. `Breakpoint`, `Trim`, `breakpoints()` (incl. `linebreak_link`,
     hyphenation filters, `hyphenate_at`/`lang_at` for our config shape)
  2. shaped-run model: glyph arrays with `x_advance`, `adjustability`
     (`base_adjustability` + justification limits), `is_justifiable`,
     dash/space classification
  3. `line()`: trim, soft-hyphen glyph, hard-dash repeat
     (`should_repeat_hyphen`), weak-spacing trim, width/stretch/shrink/
     justifiables sums (skip CJ adjust paths initially but keep the call
     sites marked — English-first, structure preserved)
  4. `raw_ratio`, `raw_cost`, `CostMetrics`
  5. `linebreak_optimized_approximate` (+ `Estimates`, `CumulativeVec`),
     `linebreak_optimized_bounded`, `linebreak_optimized`
- Output adapter: Typst `Line` ranges → our `LineBox[]` (from/to
  positions, break style br/hy, per-line ratio for spacing decos).

### 2. Inputs: spec → `Preparation`
- Map our paragraph spec to `(text, items, config)` exactly as
  `collect.rs` does for the constructs we emit: words/spaces as text,
  atoms as frame items (measured width), the `~`-blank-line convention,
  footnote/caption prefix indents, per-context font size (0.85 em),
  `justify: true`, `lang: en`, costs defaults.
- One subtlety to nail here: Typst shapes *runs*, not words — cross-word
  kerning and safe-to-break reshaping are part of width truth. The
  sidecar `shape()` returns whole-run glyphs with safe-to-break flags;
  line width = glyph-range sum with boundary reshape when the cut is not
  safe-to-break (mirroring `ShapedText::slice` semantics).

### 3. Wire-up behind a flag
- `layoutBlock` gains an engine switch: `typst-port` vs legacy KP.
  Everything downstream (decos, spacers, pagination) is unchanged — the
  port emits the same `LineBox[]` shape.

### 4. The differ (the actual proof)
- Harness: batch-compile paragraphs through the *existing oracle* (same
  WASM = ground truth by definition) and diff against the port:
  break offsets, hyphen presence, per-line text — string-for-string.
- Corpora:
  a. our real documents (demo doc, Taylor's drafts)
  b. hyphenation-dense and dash-dense synthetic text; quotes, links,
     numbers/units, runt-bait endings
  c. paragraphs with math atoms, footnote bodies, captions
  d. random fuzz (word-length distributions, mixed punctuation)
- **Knife-edge sweep** (the test that encodes the original bug): for
  each corpus paragraph, sweep the measure across ±30 px in 0.1 px
  steps; the set of widths where breaks flip must be *identical* in both
  engines. Any mismatch = a bug with a minimal repro attached.
- Run in CI (`npm test`) against cached oracle outputs; a live-oracle
  mode for regenerating.
- Exit criterion: **zero divergences across all corpora and sweeps.**
  Not "rare", zero — divergence means the port has a bug; find it.

### 5. The deletion spree (the payoff)
Once the differ is clean:
- liveRun: full-paragraph port on every keystroke — global, honest,
  no frozen prefix, no minus-2 window, no quality backstop.
- Settle: oracle audits (dev-mode assert + divergence telemetry);
  its result is *expected* to be a no-op.
- Delete from `typeset-plugin.ts` / `paragraph.ts`: ownership
  (`owned`/`ownTimer`), `prefixForced`/`partitionPrefix`,
  hold-instead-of-guess, `FORCED_EPS` fudges, the 60 %-measure backstop,
  stale-deco resurrection in liveRun. Keep: oracle plumbing (audit +
  page oracle + math ink), pagination as-is.
- Re-run the jitter/stability measurements; update ROADMAP.

### 6. Follow-on (separate effort): page breaking
Same treatment for `typst-layout/src/flow/` (widows/orphans, footnote
placement costs) so live pagination is exact too. The JS paginator
already runs real-time as the fallback path; today's page oracle stays
authoritative until that port happens.

## Open items to resolve during phase 0–1
- `par.costs` defaults and where `config.costs` comes from in
  `prepare.rs` (expected: 100%/100%; confirm).
- `hypher` en minimums and exact pattern set (vendored in sidecar, so
  exact regardless — but the TS `Hyphen(l, r)` char counts must match
  its syllable boundaries).
- `ShapedText::hyphen` details (which codepoint is shaped, fallback
  handling) for the soft-hyphen width.
- Reshape-on-slice rules (`safe_to_break`) — port the exact conditions
  from `shaping.rs`.
- Confirm the editor's DOM rendering of the port's breaks needs no
  change (it shouldn't: same LineBox contract).
