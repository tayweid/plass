# Roadmap

What is open, in the order it matters. Everything that landed is in git
history; the day-by-day record of the 2026-09 push is
[`docs/archive/ROADMAP-2026-09-11.md`](./docs/archive/ROADMAP-2026-09-11.md),
older plans in [`docs/archive/IMPROVEMENT_PLAN.md`](./docs/archive/IMPROVEMENT_PLAN.md).
Evaluate every item against "Typst on rails" (CLAUDE.md) before scope.

## Next

1. **Dogfood.** Write real documents in Plass — the course notes, a problem
   set with math, figures, citations — and let the frictions found there
   reorder everything below. Frictions harvested become the top of this
   file.
2. **Markdown fidelity, exit criterion.** `scripts/md-corpus.ts` reports the
   course-notes folder byte-identical except for the decided normalizations
   (smart quotes, one-time reflow of hard-wrapped paragraphs, list
   re-indents, loose lists written with their blank lines), and
   `MD_FILE=… npx playwright test tests/md-comments.spec.ts` passes on a
   sample through the live editor.
3. **Small open items** (each a short session):
   - Multi-paragraph footnotes flatten to one paragraph.
   - A `.typ` save has no home for the Markdown-only carry (frontmatter
     extras) and drops it silently.
   - A *numbered* heading keeps browser layout (its painted section number
     is not in the port's text); the audit reports it as `browser-mismatch`
     when it wraps differently from Typst.
   - A table row Typst splits across pages (a rowspan across the break, a
     tall cell) is placed whole instead — declared, not mirrored.
   - A `#grid` off the rail (auto or fixed columns, spans, fills, differing
     row and column gutters) stays an island; add a rail only if a real
     document needs it.
   - Citations: linking picker entries to local PDFs when keys match
     filenames.

## Done: Plass.app on the Claerbout shell (Electron, 2026-09-30)

Decided 2026-09-29 for the whole suite (ManimLive's `maniml/docs/app_plan.md`,
"Claerbout: Electron for all three apps"); shipped 2026-09-30, the day
after Knuth. The work, in order, with what each step found, is
`docs/CLAERBOUT-SHELL.md`. What it settled:

- **Chromium is Plass's reference engine.** The in-app WebKit caveats are
  gone: no private flag, no separate app-parity story, no `webkit-app`
  test project; the `chromium` project is the app's page, and
  `app/smoke.mjs` drives the built app with Playwright's `_electron`.
- **No file bridge.** The File System Access API works in the window and
  handles stored in IndexedDB reopen after a relaunch (the shell's
  permission handler grants what the page holds); a Finder open is dropped
  on the page as a real handle. `native-fs.ts`, the grants model and the
  Swift shell's whole file protocol retired with it.
- **No engine.** The shell serves the page from `plass://app/` in the
  bundle (compiler WASM and fonts included, 20 MB zips) and does the rest
  itself.
- **Inherited from Knuth**: the app ships without Electron's framework and
  completes itself (cloned from an installed Claerbout app, else a
  one-time download), the install line runs its `complete.sh`, ad-hoc
  signing, no asar, macOS 13 or later. The shell is its own repository,
  `github.com/tayweid/claerbout`, pinned by tag; a bump is one tag and one
  pull request per app the same day.

## Parked (Taylor, 2026-09-11)

- **Incremental pagination** for 50+ page documents — until speed has been
  tested more. The suffix planner and the full-versus-suffix comparator
  exist as development shadow telemetry (the full result is always
  installed); the 40–50-page fixture requires a late-edit candidate to visit
  less than 25% of the top-level units while preserving selection, undo,
  spellcheck, and caret/scroll position within 2 px. With the compile out
  of the edit loop a 50-page settle is a full walk, but it no longer shows
  as lag.
- **Offline launch for the installed PWA** — until things are more settled.
  No service worker: the installed app fetches plass.tayweid.io on every
  launch. The useful version is a shell-plus-sidecar cache that opens
  documents and types immediately; the 28 MB compiler WASM and Pages'
  `max-age=600` decide how an update reaches an open app.
- **Float placement** (`placement: top/bottom`) — assessed not easy: the
  figure leaves the flow for the page edge while the document keeps it
  mid-flow; a new page-layout mechanism, not a fixture.
- The four ICU 1.5 → 2.x sidecar bumps — until the sidecar's version-pinned
  identity is re-verified against them.

## Dropped (Taylor, 2026-09-11)

A keep-together control and "keep heading with next"; the draft niceties
(double spacing, DRAFT watermark, margin line numbers); paragraph typography
odds and ends (hyphenation language, a justification toggle, sans headings);
two-sided margins; page-wide multiple columns (the grid rail and the
half-letter paper size cover the two real needs); per-page footnote
numbering (Typst has none either).

## Not planned (Taylor, 2026-09-16)

A warm "bookish" editor look — the cream-paper mockup set in Iowan Old
Style. The palette alone was tried and dropped the same day: without the
typeface it is not the look, and the typeface is a certification job (a
warmer serif made exact for layout and export: TeX Gyre Pagella or
Libertinus Serif, both bundled, neither calibrated — parity metrics, the
compiler's font set, the audit fixtures under the new face), not a
screen-only swap, which would break the editor/Typst contract. Iowan
itself is Apple's and cannot be bundled.

## Not on this roadmap

The formal-release gate — replacing the precompiled Typst binaries with an
audited build or recording independent risk decisions per RustSec finding,
plus the remaining one-time items in [`RELEASING.md`](./RELEASING.md) — is
tracked there, not here. It gates a *tagged release*, not daily use of the
deployed preview.
