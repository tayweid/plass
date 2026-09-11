# Roadmap

The next milestone is not a feature: **write a real document in Plass** — a
problem set or lecture note with math, figures, and citations — and let the
frictions found there reorder everything below. The ordering here is a
pre-dogfood guess (value ÷ effort for academic writing); parity notes flag
where a feature touches the port and its audit. Completed work lives in git
history and [`docs/archive/IMPROVEMENT_PLAN.md`](./docs/archive/IMPROVEMENT_PLAN.md).

## Session queue

1. **Dogfood.** Write the document. Frictions harvested there become the new
   top of this file and outrank everything queued below.
   *Harvested 2026-09-10 from the course notes (Markdown files with
   hundreds of editorial `<!-- -->` comments and CriticMarkup):*
   - Done: HTML blocks and comments are islands shown as code (the dash
     normalizer was turning `<!--` into `<!–`); frontmatter lines with no
     Plass field ride along verbatim; indented code blocks and link titles
     survive; list continuations indent once. Code blocks are now a
     calibrated rail (Typst's raw block metrics, DejaVu Sans Mono), so a
     document full of comment islands keeps exact page starts; a page
     break *inside* a wrapped island still moves it whole (PAGE-PORT
     Phase 5, breakable blocks).
   - Done 2026-09-11: smart quotes. `src/smart-quotes.ts` ports Typst's
     quoter (open/close/apostrophe/prime, per paragraph, looking back over
     inline nodes); the importers and the edit-time normalizer hold the
     printed glyph, and a straight quote in the document exports escaped
     (`\"`) so it prints straight. Apostrophe paragraphs now get compiled
     verification. English quote set only (no language setting yet).
   - Done 2026-09-11: headings 4–6 are real levels (they print like level
     3, so the calibrated metrics hold; numbering goes six deep); a run of
     underscores (a blank to fill in) is text, not emphasis, in and out;
     `[a note]` stays bare, brackets escape only where they would read as
     a link, footnote, or citation; a comment's spacing against its
     neighbours (`# Title` directly over `<!-- … -->`) is recorded on the
     island and written back.
   - Done 2026-09-11: inline HTML (`<sub>`, an inline `<!-- comment -->`)
     is an inline island — verbatim in the file, inline code in the page
     and the print; an image's `"title"` is carried.
   - Done 2026-09-11: double-clicking a file already open in Plass opened a
     blank window (the new window found the file held elsewhere and
     stopped). The manifest's `launch_handler` now routes the launch to an
     existing window, and a window that already shows the file keeps it
     (no reload, no unsaved-changes prompt). Reinstall the app for the
     manifest to take effect. With several Plass windows open, the launch
     lands in the last-focused one and names the window that has the
     file — no web API can focus another independent window.
   - Done 2026-09-11: **one renderer.** The 50-page announcements file
     lagged 250–750 ms every few keystrokes; measured, the typing path was
     2–9 ms and the freeze was the whole-document Typst compile's result
     being sanitized and laid out on the main thread after every pause
     (and failing every time on a `...` the document did not hold as
     `…`). Taylor's call: Plass is an exact port, not two renderers. The
     compile no longer runs while editing and Typst's page starts are
     never installed; the port audit (`npm run audit`, `AUDIT=<path>`)
     measures the port and the local paginator against Typst on demand.
     `...` now imports and types as an ellipsis. `.md` windows show `.md`
     in the title.
   - Done 2026-09-11: **the divergences the first audit found**, each
     reproduced as an audit fixture (`npm run audit`: prose, structure,
     lists, footnotes, math, table, table-bare) and fixed at the cause; all
     fixtures and the 33-page announcements file now agree with Typst on
     every line break and page start:
     1. Page bottoms: the paginator tested browser boxes against the page
        bottom; Typst tests frames (cap top to last baseline). Every fit
        test now subtracts the unit's bottom inset (`pageBottomInsetEm`)
        and starts a line at its cap top, with a 0.1 px tolerance (Typst
        allows none; 0.5 px placed lines Typst rejected by half a point).
        Footnote entries are reserved and painted as frames too, at
        Typst's entry pitch (cap height + 0.5em of the entry size,
        `--fn-line`), and a heading at a page top carries its calibrated
        baseline shift.
     2. Lists: the editor indented list bodies 1.6em; Typst's grid puts
        the body after the marker's shaped width plus 0.5em (• 0.78em,
        ‣ 0.375em from the fallback face, – 0.5em; enums after the widest
        label). The stylesheet now takes the indents the plugin publishes
        from the port's shaper (`--list-indent-N`, `--enum-indent-N` by
        item-count digits via `list-indent.ts`) and paints Typst's markers
        out of flow. A nested list follows its item's text at the full
        block spacing and adds nothing after itself.
     3. The "bold/link" paragraphs were list items too — same fix.
     4. Inline math: a formula's block was laid out with the placeholder's
        width and the cached layout survived the ink's arrival; atom widths
        are part of the layout cache key now, and the ink's width is
        measured in Typst (`measure()`) rather than read off a page that
        rounds to whole points.
     5. Tables: their block spacing (Typst's Auto = paragraph spacing,
        frame to frame) was short by 6.8 px above and 8.5 px below;
        `--table-mt/--table-mb` carry it, and the margin-top is dropped at a
        page top like every weak spacing (the bare 45-row table).
   - Done 2026-09-11: headings. Typst justifies and hyphenates a heading
     with the document's paragraph settings, bold at the level's size; the
     editor wrapped them ragged, and a second-level heading took three
     lines where Typst needed two. The port lays headings out now (bold
     base face, level scale), measured in the bold face for justification.
     The audit reads a browser-laid block's painted breaks back from the
     DOM (`browser-match`/`browser-mismatch`), so nothing is unmeasured.
     Open, small: a *numbered* heading keeps browser layout (its painted
     section number is not in the port's text); it shows in the audit as
     `browser-mismatch` if it wraps differently.
   - Open, smaller: multi-paragraph footnotes flatten; tight/loose list
     spacing normalizes; a `.typ` save has no home for the Markdown-only
     carry (frontmatter extras) and drops it silently.
   - *Corpus after this pass:* 22 byte-identical, 37 trailing-whitespace
     only, 27 blank lines only, 388 changed — 202 of them first at a smart
     quote (the decided normalization), the rest hard-wrapped paragraphs
     re-flowed, underscore blanks re-escaped, and list re-indents.
   - *Corpus baseline (474 files, parser round trip only, no editor):*
     29 byte-identical, 43 differ only in trailing whitespace, 402 change.
     By first difference: 317 hard-wrapped paragraphs re-flowed to one
     line (a save rewrites every wrapped line — not a loss, but every
     first save is a whole-file diff), 28 over-escaped brackets
     (`[To be developed]` → `\[To be developed\]`), 23 h4+ demotions,
     12 list re-indents, 1 table separator restyled. 310 files carry
     straight quotes, 191 carry h4+ headings. Script: parse → serialize
     each file and classify the first differing line; worth keeping as
     `scripts/md-corpus.ts` with a folder argument.
2. **Finish the started features** — each is one short session:
   - *Keep-together*: machinery exists (⌘⌥K, atomic pagination,
     `block(breakable: false)` emission/import). Open: a discoverable UI
     control and "keep heading with next block."
   - *Running headers/footers*: header text, alignment, `{page}`
     substitution, first-page suppression, and emission/import are done.
     Open: custom footer content, section-aware values via `context`, a
     first-page behavior control in the settings UI, and moving the ordinary
     folio into the header.
   - *Draft niceties*: 1.5 spacing exists. Open: double spacing, DRAFT
     watermark/background, margin line numbers.
3. **Tables as daily tools.** Done 2026-09-11 — every item below landed
   in one day of slices. First slice — what
   made them "clunky to edit": the floating control bar covered the
   paragraph above the table (now docked under the toolbar); typing into
   a fresh table prepended to "Column 1" (the placeholder is selected);
   Tab from the last cell did nothing (adds a row); Enter split a cell
   into paragraphs (moves down a row, adds one at the bottom); a table
   that ended the document could not be left by keyboard (ArrowDown and
   ArrowUp step out, creating a paragraph if needed). A new table's headers
   start empty. Styling remainder:
   - ~~Rule weights~~ — done 2026-09-11: a per-row rule preset (light /
     heavy / none / the style's) cycled from the control bar, painted
     as a shadow (no layout cost) and exported as Typst's own
     `table.hline(y:, stroke:)`, read back into the row on import.
   - ~~Cell insets~~ — done 2026-09-11: density presets (compact 3pt /
     normal 5pt / roomy 8pt → `inset:`), with the cell box made exact for
     every preset (the 0.283px-per-row drift PAGE-PORT tracked is gone).
   - ~~Merges + shape ops together~~ — done 2026-09-11. The library's
     insert/delete were already span-aware, but deleting from a caret
     inside a merged cell removed the whole span (a two-column cell took
     both columns); now one row or column goes and the merge shrinks, a
     cell selection still removes what it covers, and a row added below
     the header is a body row rather than a second header.
   - ~~Rich cells~~ — checked 2026-09-11: math in cells already worked
     everywhere it works in a paragraph (`$…$` typing, ⌘M, click to edit,
     Enter to save; display math is refused with a notice), now pinned by
     a spec. What the check found instead was a document-wide bug: a space
     typed right after any inline formula was stored as a non-breaking
     space (Chrome's artifact under `white-space: normal`) and exported as
     `~`, welding the formula to the next word. Fixed in the normalizer,
     which recognizes the artifact by how it arrives (a typing transaction
     inserting one nbsp) so a `~` written in the file stays glue.
   - ~~Per-selection cell fills~~ — done 2026-09-11: a Fill control cycles
     a preset (gray / yellow / blue — verified colours, not a picker) over
     the selected cells; exported as `table.cell(fill: …)`, read back, and
     a non-preset fill makes the table a raw island rather than a native
     table that lost its colour. Complex-table stress testing. Mid-table page breaks
     ship (PAGE-PORT Phase 7): a table breaks between rows with the
     header repeated, as Typst lays it; a rowspan across the break, a
     tall cell split by Typst, or a captioned (figure) table still places
     the table whole.
4. **Citations** (see the worked plan below — the largest planned feature).
5. **Paragraph typography odds and ends** — hyphenation language selection,
   per-document justification toggle, heading font pairing (sans headings
   over serif body).

## Citations (worked plan)

1. ~~Library bib — external location, merge-on-cite~~ — done 2026-09-11
   (`src/library-bib.ts`). Bib → **Library…** points Plass at a `.bib`;
   the file handle is persisted in the shared IndexedDB store
   (`kv-store.ts`, the same store as recents) and re-read when the file's
   modification time changes, checked when the @ picker opens. Where the
   File System Access API is missing, the library is a one-time content
   snapshot. The picker lists library entries the document lacks, marked
   `lib`; citing one copies **that one entry's raw BibTeX** into the
   document's embedded bib (`mergeEntryIntoBib`), creating the
   bibliography if needed — documents stay self-contained and carry
   exactly their cited subset. Forgetting the library leaves every
   document whole. Not done: linking picker entries to local PDFs when
   keys match filenames.

2. ~~Citation styles — minimal TS port, oracle-verified~~ — done
   2026-09-11 (`src/citation-styles.ts`). Settings → Citations offers
   IEEE (numeric) and APA (author–year); the style rides on the
   `#bibliography(... style:)` line and imports back (an unported style
   falls back to IEEE). The APA formatter reproduces what hayagriva
   printed for the probed cases — `(Knuth & Plass, 1981)`, `et al.` from
   three, corporate names whole, particles dropped, editors as fallback,
   `n.d.`, `a`/`b` suffixes — and the References compile now also
   renders every citation on a marked line; a compiled string that
   differs from the formatter's is logged and painted in its place
   (`__citationOracle` in dev). Chicago author-date joined the same day
   after a wider probe (thirty-one entries, both styles): no comma,
   "and", editors by full name comma-joined, a standing-in title in
   curly quotes for short works. The original plan follows for the
   record.
   The line-breaker pattern, not a CSL engine: hand-write per-style
   formatters in TS and offer ONLY ported styles in a document-settings
   dropdown. IEEE numeric is the existing first-use counter in
   `citations.ts`; author-year is ~150–250 lines (BibTeX name parsing —
   `von` parts, "Last, First" vs "First Last" —, et-al threshold,
   multi-cite separators, a/b year-suffix disambiguation over the cited
   set). Decided AGAINST porting hayagriva/CSL interpretation (it's a
   style-XML interpreter — huge parity surface, a project not a feature)
   and AGAINST citeproc-js (a *different* CSL interpreter; would
   disagree with hayagriva in exactly the edge cases that matter).
   - Wiring: `"ieee"` is currently emitted by the document serializer and
     compiled bibliography preview. Style becomes a document setting,
     emitted as `style: "…"` on `#bibliography` and parsed back on import
     (round-trip).
   - Painting unchanged: decoration sets `data-cite-num`, CSS `::after`
     paints it, and the typesetting adapter prices the painted text for the
     line breaker — only the *source of the string* changes, from the TS
     counter to the TS formatter.
   - Verify: `compileInk`'s hidden-citation compile of the References
     block doubles as the oracle — read the inline citation strings
     back from the SVG text layer, diff against the TS formatter,
     per-citation fallback to the oracle's text on mismatch + log
     (the `__comparePort` discipline). Formatter bugs become invisible
     corrections that also tell us where the port drifts.
   - 1–2 days full (mostly formatter + tests; oracle plumbing is nearly
     free). Half-day minimal version: dropdown wired to PDF + References
     block only, quick TS author-year for the inline marks.

## Next push (drafted 2026-09-10)

The documents being written in Plass today are Markdown course notes, so
the push is ordered by what those files hit, not by feature size:

1. **Markdown fidelity to the finish**, in this order:
   a. ~~Smart quotes~~ — done (Dogfood, above).
   b. ~~Hard-wrapped paragraphs~~ — decided 2026-09-11 (Taylor): the
      one-time reflow is fine as is; no re-wrap on save.
   c. ~~Headings 4–6, bracket escaping, inline HTML, image titles~~ —
      done.
   d. Exit for the whole item: `scripts/md-corpus.ts` reports the
      course-notes folder byte-identical except for the decided
      normalizations, and `MD_FILE=… npx playwright test
      tests/md-comments.spec.ts` passes on a sample through the live editor.
2. ~~The one rule for the source view~~ — done 2026-09-11: islands (raw
   Typst, raw Markdown) are kept verbatim, shown as code blocks in the
   page, printed as the same code blocks, never run. The island compile
   pipeline is gone.
3. **Tables as daily tools** — item 3 above (rule weights, insets,
   span-aware ops, rich-cell editing), since "clunky to edit" was the
   stated reason tables went unused.
4. **Citations** — the worked plan below; a design session on library-bib
   storage before code.

Also small and ready: SOURCE-VIEW step 4 (writing niceties). Housekeeping
before the push: merge the nine Dependabot bumps that touch npm and GitHub
Actions (each one commit, cleanly based on `main`, gated by `npm run build`
and the browser suite); leave the four ICU 1.5 → 2.x sidecar bumps alone
until the sidecar's version-pinned identity is re-verified against them.

Deferred on purpose: PAGE-PORT Phase 6, multiple columns, offline PWA.

## Needs its own design session

- **Multiple columns** — `#set page(columns: 2)`. The big one, flagged
  honestly: this reshapes the whole oracle pipeline. The line-break
  oracle needs the per-column measure; the page oracle needs per-column
  line extraction (tsel geometry per column region); the editor's
  continuous-flow-with-spacers model needs a two-column rendering
  strategy (CSS columns fight the decoration/pagination model — likely
  needs oracle-driven column-break spacers analogous to page breaks).
  Design session first; don't start it as a side quest.

## Standing backlog

- **Source view, step 4** — steps 0–3b shipped (SOURCE-VIEW.md). Left:
  the writing niceties — focus mode, typewriter scrolling, ⌘B/⌘I wrapping
  markup, mode memory per format, optionally `.md` opening in source.
- **Incremental pagination activation for 50+ page documents.** The suffix
  planner and full-versus-suffix comparator exist, and the 40–50-page browser
  fixture requires a late-edit candidate to visit less than 25% of the full
  top-level units while preserving selection, undo, spellcheck, and caret/
  scroll position within 2 px. It remains development shadow telemetry: the
  full result is always installed. Promotion requires a production-mode
  exact-source fixture proving mapped page-marker and painted-spacer
  provenance with zero corrections.
- Table/figure float placement (`placement: auto` — drift to page top).
- **Offline launch for the installed PWA.** There is no service worker, so
  the installed app is a standalone window that fetches plass.tayweid.io on
  every launch and cannot open without a network — an odd gap for an editor
  whose documents already live in IndexedDB and whose privacy claim is that
  nothing leaves the machine. Precaching the shell is complicated by the
  28 MB Typst compiler WASM (plus the renderer and sidecar), so the useful
  version is probably a shell-plus-sidecar cache that opens documents and
  types immediately, with compiled-oracle features degrading until the
  compiler is available. Pages serves everything `max-age=600`, so a worker
  also decides how an update reaches an already-open app.
- Custom paper dimensions; inside/outside (two-sided) margins; footnote
  per-page vs continuous numbering and separator options.
- ~~Environment check for text metrics~~ — done 2026-09-11
  (`src/environment-check.ts`). CI's Linux Chromium hinted the bundled
  fonts and rounded every advance to a whole pixel (225px vs 212.6px for
  26 letters), so the port's exact breaks overflowed on every page. The
  test runner launches with hinting off; a writer's browser is probed at
  startup — one prose run in the document's font and size, browser width
  against the port's shaped width — and a disagreement beyond 0.4% turns
  the exact path off for the session (legacy breaker, oracles suspended)
  with a notice. `__environment()` / `__environmentSimulate(ratio)` in dev.
- ~~Compiled line-break verification skips hard-break and dash paragraphs~~
  — checked 2026-09-11: dash paragraphs verify and agree with the port
  (the compare hook lists nothing for them). Hard-break paragraphs did
  fail: the matcher recorded a compiled break AT the hard break (the hard
  token is consumed at the start of the next line's walk, so the guard
  looked at the wrong token), the partition refused the paragraph, and
  the port stood in unverified. Fixed in `matchParagraph`; a paragraph
  with two hard breaks now verifies like any other.
- ~~Fallback paginator moves list items whole~~ — checked 2026-09-11:
  already done. `container()` in `typeset-plugin.ts` breaks inside a list
  item's paragraphs with the bullet as the owner of the first block, and
  tests/list-pagination.spec.ts covers a long bullet breaking inside itself
  and a marker never stranded above the break.

## Not on this roadmap

The formal-release gate — replacing the precompiled Typst binaries with an
audited build or recording independent risk decisions per RustSec finding,
plus the remaining one-time items in [`RELEASING.md`](./RELEASING.md) — is
tracked there, not here. It gates a *tagged release*, not daily use of the
deployed preview.
