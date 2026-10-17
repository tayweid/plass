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
   re-indents, loose lists written with their blank lines);
   `node --import tsx scripts/pandoc-parity.ts` on the course folder
   reports no divergence from pandoc beyond the accepted ones
   (`npm run test:parity` holds the fixtures to the same); and
   `MD_FILE=… npx playwright test tests/md-comments.spec.ts` passes on a
   sample through the live editor.
3. **Markdown follow-ups.** On 2026-10-05 the referee found 34 of 470
   econ-0100 notes diverging from pandoc. Each item is a decision first,
   then a reader fix:
   - Fancy list markers (`a.`, `i.`) are lists to pandoc and text to Plass
     (decided, pitfall 19 in `docs/MARKDOWN-FORMAT.md`; reported by design).
   - A list, quote or table directly after paragraph text interrupts the
     paragraph in CommonMark (Plass) but not in pandoc.
   - A line of only underscores is a rule to pandoc, a fill-in blank to
     Plass.
   - Four emphasis edge cases (`*…(*$R$*)…*`, `*~~*1*~~*`, `**P*=4**`,
     `*… L * w*`) and task-list boxes (`[ ]`, ☐ to pandoc).
   - A hand-written `H~2~O` or `x^2^` gets no import warning.
   - A link on an image or a formula is dropped silently.
4. **The rest of the Markdown plan** (`docs/MARKDOWN-SOURCE-PLAN.md`):
   step 12, the course conversion (Taylor's, outside the repo); step 13,
   `.typ` import-only (required, after 12); step 14, comments in place
   instead of hoisted; step 16, citation supplements; step 17, unresolved
   references printed as text.
5. **Small open items** (each a short session):
   - Multi-paragraph footnotes flatten to one paragraph.
   - A `.typ` save has no home for the Markdown-only carry (frontmatter
     extras) and drops it silently.
   - A *numbered* heading keeps browser layout (its painted section number
     is not in the port's text); the audit reports it as `browser-mismatch`
     when it wraps differently from Typst.
   - A table row Typst splits across pages (a rowspan across the break, a
     tall cell) is placed whole instead — declared, not mirrored.
   - A `#grid` off the rail (auto or fixed columns, rowspans, fills,
     differing row and column gutters) stays an island; add a rail only if
     a real document needs it. Merging down (a rowspan) would tie rows the
     paginator now moves one at a time, and Markdown's one div per row has
     no home for it.
   - Citations: linking picker entries to local PDFs when keys match
     filenames.
   - Page bottoms at the layout unit. Since 2026-10-16 headings are exact
     too (their frame is the bold cap height, every spacing is a gap
     between frames, heading boxes are snapped to 1/64 px) and the fit
     tolerance is 1/64 px: the heading-run sweep (nine level pairs × top
     margins 1.00–1.26 in) agrees in 242 of 243 cases. The one left, H2+H1
     at 1.21 in, is a quantization limit: Typst's line runs 0.016 px past
     the margin, and the page's frame sits 0.019 px high (Chrome places
     boxes in 1/64 px; the page-top spacer and the run follower's padding
     each round). Not worth chasing further unless a real document lands
     there. Paragraph margins and display equations are in layout units
     too since 2026-10-16 (tests/margin-drift.spec.ts): 0.9em was
     truncated to 14.984375 px at 12.5 pt, so a spaced page's paragraphs
     crept up 1/64 px a gap, 0.33 px by the 22nd, and an equation's
     paddings, frame and margin lost 0.02-0.03 px more. At 12.5 pt a page of
     paragraphs is now exact; an equation keeps its own rounding (at most
     1/128 px, the same each time for the same formula), and at a size
     where 0.9 em is no whole 1/64 px (11, 12, 13, 14 pt) so does each
     paragraph gap (12 pt: 1/160 px a gap, 0.13 px by the 22nd); only
     per-block margins would take that out. The other blocks' em lengths
     followed the same day (same spec): a tight list item's 0.25em margin
     (1/96 px short an item at 12.5 pt; now the nearest layout unit, 1/192
     px long), the fixed 0.9em margin of a list, a nested list, figures,
     the abstract and the bibliography (`--block-margin`, 1/64 px short
     each), a quote's padding and spacing below (rounded from the quote's
     top: 0.001 px a quote, it was 0.017 short) and a code block's padding
     and margin (rounded from its top; a spaced block was 1/64 px short).
     A code line's pitch is the nearest layout unit to Typst's raw line, so
     each line keeps that difference (12.5 pt: 1/370 px long, 11 pt: 1/143
     short); per-block margins again would take it out. Still published
     with four decimals, so truncated, and not measured: a table's margins
     (`--table-mt`/`--table-mb`), the footnote lengths, `--par-cap-slack`
     and `--par-inset` (an equation at a quote's edge), and the front
     matter's em margins (title, authors, date). And the line box, which
     no margin can absorb: at 10 and 13 pt Chrome lays every line 1/64 px
     short (19.984375 and 25.984375 px at line spacing 1.5), 0.6 px by a
     10 pt page's 40th line, and at 12.5 pt with line spacing 1.3 1/192 px
     long (measured 2026-10-16). Line height stays a ratio because inline
     atoms inherit it, so publishing it in px is a design question.
   - The page paints heading ink lower than the print does: Chrome's
     baseline of an H1 is 2.8 px below Typst's, an H2's 1.5 px, an H3's
     1.8 px, while body lines are 0.65 px above (measured 2026-10-16 at
     12.5 pt from the audit's SVG). The headings' part is HEADINGS `rise`
     in typ-serializer.ts, a July calibration that moves no frame; the
     body's is Chrome rounding the font's ascent. A paint-only transform,
     or a re-calibrated `rise` (which moves the print), would close it; a
     design choice.
   - Display equations are laid out at their Typst frames since
     2026-10-16 (tests/equation-frame.spec.ts): the box's content was a
     line box (the svg on a 1.5-line strut, 6-13 px too tall), the ink's
     page is rounded up to whole points (the frame is Typst's `measure`
     now), a numbered equation grows to hold its number as Typst's does,
     rows are set at the document's leading, and the paginator lands and
     fits an equation by its frame inside the 0.5 em padding. math.md's
     page starts agree with Typst. Paint only, still open: the number is
     centered on the frame (Typst sets a one-line equation's number on
     its baseline); a display svg is centered by its whole-point width,
     up to 0.1 pt right of the print; an inline svg is given Typst's
     exact width over its whole-point viewBox, so its ink is drawn up to
     0.3 % small.
   - Classic (indented) paragraphs: headings and display equations print at
     the page's gap since 2026-10-16 (the spacing above them carried the
     spaced mode's 0.9 em margin). The blocks with a fixed 0.9 em margin
     carry it the same way (measured 2026-10-16 at 12.5 pt against the
     audit's SVG): Typst spaces a list, a nested list, a figure, the
     abstract and the bibliography from their neighbours by the leading
     alone in classic mode, and the page adds 0.9 em, so the line after a
     list (or the first line of a nested list, or the line after any of
     the others) is 15 px lower on the page than in print, and a classic
     page holding lists breaks later than Typst's. Quotes and code blocks
     agree (their boxes read the mode's paragraph spacing). Not changed
     yet: classic spacing is to be written up first. The fix publishes
     those margins from `parMarginEm` (0 in classic mode), and a tight
     list's last item would then need its 0.25 em margin dropped too
     (today it collapses into the list's 0.9 em).
   - Blocks the page lays out off their print, found while putting their
     margins in layout units (2026-10-16, 12.5 pt, spaced, against the
     audit's SVG; none is in an audit fixture). A figure (a 120×80 image
     at 20 % width, one-line caption) is 8.3 px taller than Typst's: the
     caption's line is 5 px lower, and the paragraph after it 3.3 px lower
     again (the figure's 0.2 em padding-bottom; its 0.4 em, 0.2 em and
     0.55 em are a July raster calibration). The abstract's first line is
     2.55 px higher than in print (its painted "Abstract" label and 0.75 em
     margin). The paragraph after the bibliography is 1.61 px higher (the
     compiled list's box and its 0.75 em padding). Inside a quote, Typst
     spaces a list 2.4 em above and 1.8 em below (the quote's block
     spacing reaches its children), where the page uses paragraph
     spacing: a list after a quote's paragraph prints 11.38 px (0.683 em)
     lower, a paragraph after a list inside a quote 1.38 px lower. And the
     environment fingerprint's document (tests/environment-fingerprint.
     spec.ts: an H1, a long paragraph, an H2 + H3 run, a quote, a code
     block, then 30 paragraphs) disagrees at page 2: Typst moves page 1's
     last paragraph from its fifth line on to page 2, the page keeps it
     whole (the same before and after the layout-unit work; not
     diagnosed).
   - Spacing found off by a sweep of quotes and solutions at line heights
     1.3 and 1.8 and with indented paragraphs (2026-10-16), none of it the
     quote's: at `linestretch: 1.8` a document that opens with a level-1
     heading puts a line more on page 1 than Typst (the same paragraphs
     without the heading agree), so the heading's spacing is off there
     (found before heading frames were made exact the same day; recheck).
     A quote's neighbour with explicit spacing of its own (a heading, an
     equation or another quote) gets the sum of the two spacings where
     Typst keeps the larger, and a table or code block at a quote's edge
     keeps its own box (`quoteBoxEm` is exact for paragraph-like edges).
     The sweep's other finding, the gap over a display equation after an
     indented paragraph, is fixed (`equationBlockSpacingEm` reads
     `parMarginEm`).
6. **Live coauthoring, Overleaf's way** (horizon, 2026-10-11; one design
   for Plass and Knuth, Knuth's `docs/ROADMAP.md` carries the same
   entry, and `docs/COAUTHOR.md` there is the git-only design it
   replaces for live partners). The idea, from a chat of Taylor's: the
   document shared live through a CRDT (Yjs; y-prosemirror binds to
   the editor Plass already has), relayed and kept by a Cloudflare
   Durable Object (one per document, WebSockets; y-partyserver is the
   relay in a few dozen lines). The owner registers once and sets it up
   at the front; a coauthor joins by link with a name and no account,
   and sees the other's cursor and edits as they land. The shell's
   autosave record stays underneath, untouched: the owner's shell
   commits the owner's working tree as now. Plass goes first: a paper
   is what two people write at once, and one ProseMirror document binds
   as it is, with the `.typ` and `.md` serializers working from the
   owner's side; the editorial comments
   (`src/editor-comments-format.ts`) need a home in the shared document.
   Knuth follows only if it makes sense there (Taylor is not sure it
   does), and never shares kernel access: editing the file, nothing
   else. The way to find out before any server account exists: two
   shells on one Mac with their own state folders, a local relay
   (`wrangler dev`), a morning of writing in both. Costs on record: a
   hosted service is a new dependency for a local-first app; a coauthor
   without the app needs a hosted edit-only page; per-line authorship in
   the record blurs to the owner, with coauthors named in the commit
   message.

## Done: Tables and grids, a UI pass (2026-10-13)

The 2026-10-12 review (a floating text-button bar over the page, dashed
cell boxes cutting through text) is answered by the block chrome: a pill
of rail icons in the page's left margin beside the table or grid, its
menus and the Table settings / Grid layout panels, and rounded cell
washes with an active ring, all paint only (the audit and
`tests/block-chrome.spec.ts` hold the layout still). The old docked bars
are gone. The design, its rules and where the code lives:
[`docs/BLOCK-CHROME.md`](./docs/BLOCK-CHROME.md), keyboard included
(Escape selects the block, ⌘⏎ / ⇧⌘⏎ add rows in a cell, ↑/↓ leave a
grid, Tab into the pill). Still open from the same design: an optional
dark-glass image bar. Grid cells align (2026-10-15): the pill's Align
panel, as a table's, sets a cell's `align` (across: the last line of each
paragraph) and `valign` (down: the cell in its row), kept as
`grid.cell(align: …)` in `.typ` and `align=` / `valign=` on the
`::: column` div in `.md`; the audit's grid fixture carries both.
Grid cells merge across (2026-10-16): Columns › Merge with cell right /
Split cell, `grid.cell(colspan: …)` in `.typ`, `span=` and the covered
columns' width on the `::: column` div in `.md` (a merged first row also
writes `widths=` on its `.columns` div); the audit's grid fixture carries
a two- and a three-column merge.

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

## Later: journal and thesis targets (Taylor, 2026-10-16)

The last mile — a paper into a journal's class, a thesis into the school's
template — is rare, but it would be a large win if the page could carry
the target's typesetting. Assessed 2026-10-16: exactness against an
arbitrary class is not reachable by mirroring (a class is a program —
output routines, floats, two-column, microtype — and the only exact
renderer of arbitrary TeX is TeX, which would make the page a compiled
preview, the architecture rejected for lag). What is reachable is an
approximation on the existing rails, exact against Plass's own print of
the preset and close to the class where the fonts match, since both
breakers are Knuth–Plass over the same hyphenation patterns. None of it
needs a different engine. In the order they pay off:

1. **Class-aware `.tex` export.** The serializer hard-codes `article`
   (`tex-serializer.ts`). Make the target class a setting, emit it, and
   give each curated class a small front-matter adapter (every class spells
   author, affiliation and abstract its own way); an unknown class falls
   back to article-style front matter. With a class set, the export carries
   no layout overrides, so the class rules. The smallest piece and the one
   that removes the friction actually felt; it never touches the page.
2. **Journal and thesis presets.** A preset is today's settings list in a
   file, importable and shippable; a curated set hand-derived from common
   classes and thesis templates. The work is vocabulary: a class also sets
   heading font/size/spacing per level, paragraph spacing amounts, caption
   style and the title block, and each missing knob is a new rail (local
   mirror plus audit fixture, one at a time). Fonts are the other cost: a
   Times journal needs TeX Gyre Termes bundled and certified (the Nimbus
   metrics newtx/mathptmx share); Computer Modern classes are near the
   bundled New Computer Modern; Palatino is the Pagella above. Theses are
   the better first target than journals: single column, fixed margins,
   chapter headings, double spacing — preset material almost entirely.
   The residual against the real class is measurable with the audit's
   method pointed at pdfLaTeX offline (compile the export with the class,
   read breaks from `\tracingparagraphs` or synctex, count agreeing
   paragraphs) — a dev-time number, never in the app.
3. **A LaTeX render of the PDF in Plass.app.** Not in the browser (no
   usable TeX in a page, no server behind the deploy). In the Mac app it is
   a Claerbout capability: run `latexmk` when a TeX is installed, or bundle
   tectonic (XeTeX-based, fetches packages on first use; some classes
   assume pdfTeX). A second printer that writes a file, never a second
   opinion on the page. On the web the equivalent is download the `.tex`
   and compile in Overleaf.
4. **Deriving a preset from a `.cls`.** The page cannot read TeX macros;
   the reliable route is a probe document compiled with the class, its
   lengths and fonts read back from the log, which needs a TeX on the
   machine (item 3's). Last, or never — the curated set may be enough.

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
