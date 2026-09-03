# Roadmap

The next milestone is not a feature: **write a real document in Plass** — a
problem set or lecture note with math, figures, and citations — and let the
frictions found there reorder everything below. The ordering here is a
pre-dogfood guess (value ÷ effort for academic writing); parity notes flag
where a feature touches the oracle machinery. Completed work lives in git
history and [`docs/archive/IMPROVEMENT_PLAN.md`](./docs/archive/IMPROVEMENT_PLAN.md).

## Session queue

1. **Dogfood.** Write the document. Frictions harvested there become the new
   top of this file and outrank everything queued below.
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
3. **Table styling remainder:**
   - *Rule weights* — light/heavy midrule choice (booktabs toprule vs
     midrule); maybe a click-cycle on an active rule.
   - *Cell insets* — density presets (compact / normal / roomy) → `inset:`.
   - *Merges + shape ops together* — column/row insert/delete that
     understands spans (occupancy grid) instead of disabling while merges
     exist.
   - *Rich cells* — tables are now native editable trees (no modal card);
     math/references inside cells serialize losslessly but the in-cell
     editing affordances (e.g. "edit as math") are still to be built.
   - Per-selection cell fills (the fill presets ship; individual cells are
     still open). Complex-table stress testing. Mid-table page breaks
     ship (PAGE-PORT Phase 7): a table breaks between rows with the
     header repeated, as Typst lays it; a rowspan across the break, a
     tall cell split by Typst, or a captioned (figure) table still places
     the table whole.
4. **Citations** (see the worked plan below — the largest planned feature).
5. **Paragraph typography odds and ends** — hyphenation language selection,
   per-document justification toggle, heading font pairing (sans headings
   over serif body).

## Citations (worked plan)

1. **Library bib — external location, merge-on-cite.** A persistent
   app-level "library" bibliography pointing at a user-selected external
   `.bib`. The @-picker searches doc bib ∪ library; citing a
   library-only key copies **that one entry** into the document's
   embedded bib — documents stay self-contained and carry exactly their
   cited subset. (Rejected alternative: importing the whole library into
   each document — works today via Document → Bib → Import .bib, but
   embeds a stale snapshot per paper.) Storage: persist the file handle in
   IndexedDB like recents (or reuse the project-folder machinery) and re-read
   it on change like referenced figures. When a library's citation keys map
   to local PDF filenames, picker/reference entries could optionally link to
   those files. This pairs naturally with item 2 in the same code area.

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

- Raw-Typst-island compiled previews (same pattern as tables/math/bib).
- **Source view toggle** — a toolbar button switching between the WYSIWYG
  view and the document's plain-text source (its on-disk format: .typ or
  .md, which `file-manager`'s text method already produces). Both directions
  exist: `docToTyp` is computed per edit as the oracle signature, and the
  return trip is the file-open parser (unknown Typst survives as raw
  islands, so an editable source view doubles as the escape hatch for Typst
  the editor has no UI for). New work: the toggle + a mono `<textarea>`
  (no CodeMirror in v1), one `replaceWith` on return (a single undo step),
  a toggle-and-back identity test. Punt cursor/scroll mapping and live
  two-view sync. Known cost to accept: the serializer re-normalizes
  hand-formatting of untouched regions after a source-side edit.
  Editable version ~1 day; read-only half that.
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
- **Compiled line-break verification skips hard-break and dash paragraphs.**
  The compiled oracle's forced breaks fail to partition blocks containing
  `hard_break` nodes or en/em dashes (`layoutAuthoritative` returns null) and
  the port stands in — correct output, but those paragraphs never get
  compiled verification. Surfaced when the sanitizer regression was fixed
  (the text layer was stripped 2026-08-16 → 2026-08-19, blinding every
  oracle); likely an offset mapping issue in `typst-oracle.ts` matching.
- **Fallback paginator moves list items whole.** `container()` in
  `typeset-plugin.ts` breaks lists between children only; while the page
  oracle is pending (or failed) a long bullet crossing a page boundary
  leaves a gap, and a bullet taller than one page gets no break at all.
  Teach it the same line-boundary splitting `paragraph()` does.

## Not on this roadmap

The formal-release gate — replacing the precompiled Typst binaries with an
audited build or recording independent risk decisions per RustSec finding,
plus the remaining one-time items in [`RELEASING.md`](./RELEASING.md) — is
tracked there, not here. It gates a *tagged release*, not daily use of the
deployed preview.
