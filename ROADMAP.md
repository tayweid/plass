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

## Planned: Plass.app on the Claerbout shell (Electron)

Decided 2026-09-29 for the whole suite (ManimLive's `maniml/docs/app_plan.md`,
"Claerbout: Electron for all three apps"); Plass moves when it opens to
researchers. Knuth went first and shipped on it 2026-09-29/30: the shell is
knuth's `app/shell/`, and knuth `docs/APP.md` ("What building it found") has
the record. What that means here:

- **Chromium is Plass's reference engine**, so the in-app WebKit caveats go:
  no `SubpixelInlineLayoutEnabled` private flag, no separate app-parity
  story, and the `webkit-app` Playwright project and `tests/fixture.ts`'s
  Swift-bridge stand-in are replaced by driving the app with Playwright's
  `_electron`.
- **The file bridge moves to the Claerbout protocol**
  (`window.claerbout.request`), answered in Electron's main process.
  `native-fs.ts` speaks the Swift shell's `plass` handler today
  (`permission`, `stat`, `read`, `write`, `child`, `list`, `rename`,
  `openPanel`, `savePanel`, `folderPanel`, `document`); those become
  protocol messages, and the grants model (`grants.json`) comes along. Or,
  since Electron is Chromium, the File System Access API may simply work
  in the window and most of the bridge can go: to try first.
- **Probably no engine.** The suite plan gave Plass a small one; Knuth's
  shell already serves its page from a custom scheme and does file
  operations itself, which is what Plass needs. OPEN until ported.
- **Inherited as is**: the page served from `plass://app/` in the bundle
  (compiler WASM and fonts included, so the zip stays ~20 MB plus a few
  for the shell); the app shipping without Electron's framework and
  completing itself on first launch (cloned from Knuth or ManimLive if
  installed, else a one-time ~125 MB download), through the same compiled
  launcher; the install line running the app's own `complete.sh`; ad-hoc
  signing of the helpers and Electron's small frameworks, without which a
  browser download is called "damaged"; no asar and no fuses, so the
  framework stays clonable; macOS 13 or later.

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
