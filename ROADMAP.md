# Roadmap

Working list for upcoming sessions. Ordering within sections is a
suggestion (value ÷ effort for academic writing); parity notes flag where
a feature touches the oracle machinery.

## Tables (the styling list)

1. ~~**Caption + label**~~ — done: caption/label fields in the card;
   exports `#figure(table(...), caption: […]) <label>`; "Table N" numbers
   via a counter preset in fragments; `@tab:` works in the picker and
   paints "Table N"; round-trips byte-identically.
2. ~~**Column widths**~~ — done: per-column selects above the grid
   (auto/1fr/2fr/3fr/custom length); emits `columns: (…)`; round-trips.
3. ~~**Decimal alignment**~~ — done: ".0" per-column align mode in the
   card; exports split the column into a right/left pair joined at the
   point (zero inner inset, headers span, non-numerics span); a
   `// typeset:decimal-columns` directive fuses on import; round-trips.
4. ~~**Fills**~~ — done: fill dropdown (none / header / zebra / both) as
   canonical `fill:` functions in params; hand-written fills show as
   "Custom fill" and are preserved. (Per-selection cell fills still open.)
5. ~~**Table font size**~~ — done: size select (100–75%) wrapping the
   table in `text(size: …)`; captioned tables carry `kind: table` so
   numbering survives the wrapper; round-trips.
6. ~~**Vertical rules**~~ — done: click a column boundary in the width
   row; `table.vline(x: n)` via params; remaps across decimal-split
   columns; round-trips.
7. **Rule weights** — light/heavy midrule choice (booktabs toprule vs
   midrule); maybe a click-cycle on an active rule.
8. **Cell insets** — density presets (compact / normal / roomy) →
   `inset:`.
9. **Merges + shape ops together** — column/row insert/delete that
   understands spans (occupancy grid) instead of disabling while merges
   exist.
10. **Rich cells in the card** — editing math/references inside cells
    (currently preserved but read-only-ish). Possibly a per-cell "edit as
    math" affordance.
11. **Long tables** — `table.header` repetition across page breaks; the
    editor's table block is currently atomic in pagination, and the page
    oracle rejects mid-table splits — both need extending.

## Page setup

1. ~~**Manual page break**~~ — done: ⌘Enter / ⋯ menu; zero-height block
   with a floating chip; exports `#pagebreak()`; both engines break
   identically.
2. ~~**Margins UI**~~ — done: per-side T/R/B/L inputs in Settings;
   uniform margins export as `margin: Xin` (back-compat), asymmetric as
   the dict form; legacy `marginIn` migrates. (Inside/outside two-sided
   still open.)
3. ~~**Paper sizes**~~ — done: letter/A4/legal/B5 (custom dimensions still
   open).
4. ~~**Orientation**~~ — done: landscape via `flipped: true`.
5. **Multiple columns** — `#set page(columns: 2)`. The big one, flagged
   honestly: this reshapes the whole oracle pipeline. The line-break
   oracle needs the per-column measure; the page oracle needs per-column
   line extraction (tsel geometry per column region); the editor's
   continuous-flow-with-spacers model needs a two-column rendering
   strategy (CSS columns fight the decoration/pagination model — likely
   needs oracle-driven column-break spacers analogous to page breaks).
   Design session first; don't start it as a side quest.
6. **Running headers/footers** — custom header/footer content (short
   title, author, section name via `context`), page number placement in
   the header, different first page. Settings UI + emission + the painted
   page chrome mirroring it.
7. ~~**Title block / front matter**~~ — done: Title bar button inserts
   doc_title/doc_authors/doc_date/abstract nodes (typed in-flow, Enter
   advances); exports centered Typst forms + padded abstract; raster
   parity ≤2px; round-trips.
8. **Keep-together controls** — "keep heading with next block",
   "avoid break inside block" toggles; the page oracle honors whatever
   Typst does, so this is mostly emission (`block(breakable: false)`) +
   an editor affordance.
9. ~~**Footnote + caption line-break parity**~~ — done: the line oracle
   now covers figure captions (compiled in a real #figure with the exact
   "Figure N:" prefix) and footnote bodies (compiled in a real #footnote
   entry context); painted prefixes are stripped at match time and
   modeled as first-line indent boxes; 0.85em content measures via a
   width scale. Breaks verified identical to the full-document compile.
   Still open: per-page vs continuous numbering, separator options.
10. **Section-scoped numbering** — roman front matter → arabic body
    (counter update exists; needs a "restart numbering here" block).
11. **Draft niceties** — line spacing presets (1.5/double for review),
    DRAFT watermark/background, line numbers in the margin.

## Paragraph-level typography (adjacent, same machinery)

- **First-line indent mode** — TeX-style indented paragraphs (no gap,
  `\parindent`) vs the current block style: one setting, `#set par(
  first-line-indent: …, spacing: …)` + editor CSS + parity re-derivation.
  Classic academic look; worth doing early.
- Hyphenation language selection; justification toggle per document.
- Heading font pairing (sans headings over serif body).

## Citations

1. **Library bib — external location, merge-on-cite.** A persistent
   app-level "library" bibliography pointing at an external .bib
   (Taylor's master: `~/Projects/Literature/literature.bib`, ~400
   entries, keys = PDF filenames, `lastname_year` / `lastname_etal_year`
   convention). The @-picker searches doc bib ∪ library; citing a
   library-only key copies **that one entry** into the document's
   embedded bib — documents stay self-contained and carry exactly their
   cited subset. (Rejected alternative: importing the whole master into
   each document — works today via File → Import bibliography, but
   embeds a stale 400-entry snapshot per paper.) Storage: file handle
   persisted in IndexedDB like recents (or ride the project-folder
   machinery); re-read on change like referenced figures. Flourish once
   the folder is attached: since keys match PDF filenames in the
   Literature repo, the picker/references entries can deep-link to the
   paper's PDF. ~A day; pairs naturally with item 2 (same corner of the
   codebase).

2. **Citation styles — minimal TS port, oracle-verified.** The
   line-breaker pattern, not a CSL engine: hand-write per-style
   formatters in TS and offer ONLY ported styles in a document-settings
   dropdown. IEEE numeric is the existing first-use counter in
   `citations.ts`; author-year is ~150–250 lines (BibTeX name parsing —
   `von` parts, "Last, First" vs "First Last" —, et-al threshold,
   multi-cite separators, a/b year-suffix disambiguation over the cited
   set). Decided AGAINST porting hayagriva/CSL interpretation (it's a
   style-XML interpreter — huge parity surface, a project not a feature)
   and AGAINST citeproc-js (a *different* CSL interpreter; would
   disagree with hayagriva in exactly the edge cases that matter).
   - Wiring: `"ieee"` is currently hardcoded at `typ-serializer.ts:455`
     and `citations.ts:148` (+ typ-parser test). Style becomes a
     document setting, emitted as `style: "…"` on `#bibliography` and
     parsed back on import (round-trip).
   - Painting unchanged: decoration sets `data-cite-num`, CSS `::after`
     paints it, `typeset-plugin.ts` (~:707) prices the painted text for
     the line breaker — only the *source of the string* changes, from
     the TS counter to the TS formatter.
   - Verify: `compileInk`'s hidden-citation compile of the References
     block doubles as the oracle — read the inline citation strings
     back from the SVG text layer, diff against the TS formatter,
     per-citation fallback to the oracle's text on mismatch + log
     (the `__comparePort` discipline). Formatter bugs become invisible
     corrections that also tell us where the port drifts.
   - Taylor's house style (from the nbconvert/natbib template):
     bracketed green-italic author-year — [Sussel (2013); Kaplan et
     al. (2022)] — citecolor rgb(31,138,28). Export a `#show cite:`
     rule in the settings header + one line of editor CSS (`.ts-cite`
     currently paints `--accent`).
   - 1–2 days full (mostly formatter + tests; oracle plumbing is nearly
     free). Half-day minimal version: dropdown wired to PDF + References
     block only, quick TS author-year for the inline marks.

## Standing backlog

- Raw-Typst-island compiled previews (same pattern as tables/math/bib).
- Incremental pagination for 50+ page documents (performance).
- Table/figure float placement (`placement: auto` — drift to page top).
- ~~Image sidecar files~~ — done via project folders, now PROJECT-FIRST:
  a paper lives in a folder, period. First save asks one question (which
  folder); figures are files referenced by relative path, exports compile
  with the stock Typst CLI, referenced files poll for changes. The single
  .typ with embedded images is an EXPORT (Download .typ copy), not a
  working mode; Save As and the Project button no longer exist.
- ~~Editing-jitter polish~~ — done, the ownership model: the caret's
  block belongs to the user — per-keystroke it re-typesets with instant
  JS Knuth-Plass (hyphenation on) with all lines above the edit frozen;
  the settle and even fresh oracle answers reproduce its current breaks
  verbatim (zero motion); pagination holds the mapped page geometry.
  Corrections apply only when motion is expected: the caret leaves the
  block, or 4s idle. Measured over a 3-burst session with pauses: one
  above-caret shift (real growth), zero pause-time motion, zero
  half-lines, full convergence on release.
- Dogfooding: write a real problem set / lecture note; harvest frictions.