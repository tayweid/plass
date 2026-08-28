# Plass

> Named for Michael F. Plass, co-author of the Knuth–Plass line-breaking
> algorithm that inspired the editor. The production editor now takes settled
> line decisions directly from its in-browser Typst compiler; the earlier
> local breakers remain test and research references only.

**A WYSIWYG Typst editor with publication-quality typesetting.** You write in a
clean, Typora-style native surface; after input settles, one in-browser Typst
compile supplies the authoritative line and page decisions. The explicit
**Proof** view displays Typst's direct SVG at physical page scale from the same
prepared source, fonts, and assets used by PDF export.

**Why this exists.** Document tools split into two families. Markup-and-compile
tools (LaTeX, Typst, Overleaf) typeset beautifully but make you write in source
and glance at a preview — you are always looking at a representation of the
document, never the document. WYSIWYG editors (Typora, Word, Docs) let you work
in the document itself but top out at browser-grade layout: greedy line
breaking, no real pagination. Plass threads the needle by keeping the document
in the DOM — native selection, IME, accessibility — and demoting the
typesetting engine to a *layout oracle* whose decisions are imposed as
presentation-only decorations. The browser becomes a rasterizer following
instructions rather than a layout engine making its own, worse ones. The
original design argument is preserved in
[`docs/archive/wysiwyg-typeset-editor-spec.md`](./docs/archive/wysiwyg-typeset-editor-spec.md);
the fidelity contract and architecture below describe the current
implementation.

> **Public preview:** Try Plass at <https://plass.tayweid.io/>. Important work
> should still be backed up. The formal release gate remains open while the
> pinned upstream Typst compiler/renderer WebAssembly findings documented in
> [`SECURITY.md`](./SECURITY.md) are replaced or independently reviewed.

Plass is installable directly from the browser with no local engine. In Chrome
or Edge, use **Install Plass** in the toolbar; in Safari on macOS, choose
**File → Add to Dock**. Supporting systems can also register the installed app
for `.typ` and `.md` files. The same hosted frontend continues to receive new
versions when it is opened online.

## Run it

```sh
npm ci
npm run dev      # → http://localhost:5199
```

Before pushing, run the verification sequence in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) — that file is the one home for the
command list, so copies of it elsewhere can't drift.

## Fidelity

**Typst is the single settled line-breaking authority.** A document edit first
removes forced line presentation from every touched block, letting the browser
paint native editable DOM without waiting for compilation. After the quiet
period, one full-document Typst compile publishes an immutable layout snapshot
containing both mapped body-line breaks and page starts. The browser translator
only installs offsets from that snapshot; while it is pending, failed, or
unable to map a block safely, that block remains native instead of invoking a
second breaker. Figure captions and footnote bodies are matched inside that
same publication using compiler-reported physical regions; they never launch
synthetic paragraph-fragment compiles.

**The live result is one atomic visual publication.** `PageOracle` may finish
mapping the SVG before its exact crops have decoded, but mapped lines and pages
are not admitted until every geometry-carrying live view—math, references,
executable embeds, and supported inline Typst—has applied that same immutable
publication. While the barrier is pending, the editor keeps native wrapping
and its immediate semantic/KaTeX/source fallback (or a proven last-good crop)
instead of mixing fresh Typst breaks with stale atom dimensions.
The worker creates that publication by compiling one vector artifact, querying
its still-live compiler world, and rendering that same artifact to SVG; queries
and paint therefore cannot observe two different compiler snapshots.

That exact contract is deliberately narrow: New Computer Modern is currently
the only selectable body family, with all four faces registered in the browser
and compiler. Historical font preferences remain stored, but the editor and
export both resolve uncertified names to New Computer Modern instead of
claiming machine-dependent fidelity. The earlier TypeScript/Rust line-break
port remains as an opt-in differential test harness; its sidecar WASM is not
loaded or shipped by the production editor.

The editor and exported Typst document share page, type, and vertical-spacing
settings. When a whole-document compile can be mapped safely, its page starts
drive the live page spacers; mapped starts may be held briefly through an edit
burst while a fresh answer is pending. A failed compile, invalid geometry, or
unsupported page boundary removes all page spacers and folios and switches to
an explicitly labelled continuous editing surface. No browser-geometry
paginator guesses what Typst would do; exact Proof remains one click away.
This is a scoped, fail-closed agreement rather than a claim that every
arbitrary Typst document or browser raster detail is identical.

**Proof and PDF have one whole-document input boundary.** Proof is not a
browser recreation of the export: it is sanitized multi-page SVG from Typst
itself. Its presentation adds only outer page-gap transforms; every page-local
Typst coordinate remains unchanged. PDF export consumes the same serializer,
asset mapping, font fallback, and compiler worker path. Internal region markers
used to project the live editor are compile-only; `.typ`, Proof, and PDF all
receive the same uninstrumented prepared document. The browser gate rasterizes
the real Proof pages and the real downloaded PDF and compares their page count,
physical dimensions, ink coverage, and normalized paint divergence.

## What works today

- **Oracle layout** (spec §1.3): the document lives in the DOM — native
  selection, cursor, IME, spell-check, screen readers — while a layout oracle
  imposes Typst-selected break offsets, hyphens, and per-line justification.
  Unmatched and in-flight blocks stay browser-native; no local breaker is
  promoted to settled authority.
- **Real pages when exact, honest continuous editing otherwise**: content
  flows across painted page boxes (US Letter/A4 from document settings) with
  margins, inter-page gaps, headers, and page numbers only when the
  whole-document Typst snapshot maps every boundary safely. Paragraphs remain
  single editable nodes even when an exact boundary crosses one.
  Mechanism: the document stays one continuous editable flow; page boxes are
  painted behind it and exact-height spacer widgets push content past each
  boundary (inside a paragraph, a block-in-inline spacer replaces the line's
  `<br>`, so it forces the break and adds precisely the gap height). Print
  CSS zeroes the spacers — line breaks survive, gaps vanish — and `@page`
  takes over for the printed artifact. If Typst is pending without a proven
  basis, fails, or yields an unrepresentable boundary, the widgets and finite
  page claim disappear; the native document stays editable on a continuous
  sheet until a new exact snapshot succeeds.
- **Fast**: the keystroke path performs no line breaking or compiler work;
  changed blocks paint with native browser wrapping. Settled work is debounced,
  compiler jobs are latest-wins and priority-aware, and the direct forced-break
  translator avoids a second break search. Pagination captures spacer geometry
  once per pass behind a prefix-sum index. A publication builds one document
  position index and fans out to every registered preview in linear time; it
  does not walk the ProseMirror tree once per listener. Development telemetry
  reports queue depth, wait time, stale work, and decoration publications
  without installing production observers.
- **Editing**: ProseMirror core. Markdown-style input rules (`#` headings,
  `**bold**`, `*italic*`, `` `code` ``, `>` quotes, `-`/`1.` lists, ` ``` `
  code blocks), keyboard shortcuts, undo/redo, autosave to localStorage.
- **Typora-style chrome**: a slim quiet bar — filename on the left, and on
  the right a row of small monochrome icon groups whose text labels appear on
  hover. The title/File controls own document lifecycle and recents; the
  tools, Document, and Export controls own inserts, bibliography/settings,
  help, and downloads. Formatting itself is markdown rules + shortcuts
  (cheat-sheet behind the ? button), and the demo lives there too. A faint
  corner HUD shows pages · words (hover for oracle timing), while messages
  appear as transient toasts. Insert
  shortcuts: ⌘⌥T table, ⌘⌥I figure, ⌘⌥F footnote, ⌘M/⌘⇧M math.
- **Math**: type `$e^{i\pi}+1=0$` for inline math, `$$` on an empty line for
  display math. Formulas display **Typst's own ink** (mitex + New Computer
  Modern Math), cropped and baseline-aligned from the same whole-document
  publication as PageOracle; many formulas still require one document task,
  not one fragment job apiece. KaTeX is only the immediate editing echo while
  that atomic publication settles. A display equation whose exact region
  crosses a page remains editable with its KaTeX echo and points to Proof for
  exact output instead of painting an overlapping multi-page crop.
  Click-to-edit popover with live preview.
- **Figures**: insert from the toolbar, or paste/drop an image. Editable
  inline captions with a painted "Figure N:" prefix that renumbers live; a
  label chip on the figure (hover top-right) names it for `@label`
  references, which share the machinery with equation refs. Figures paginate
  atomically (never split across pages). Exports as Typst
  `#figure(image(...), caption: [...]) <label>`; image data (data: URLs) is
  exported verbatim so our own files round-trip losslessly — swap in a real
  image path when compiling with Typst. Project-relative images are watched
  by lightweight metadata polling every four seconds and on window focus, so
  regenerating a plot on disk refreshes the editor without reopening it.
- **Footnotes** (type `^[` Pandoc-style or `\footnote{` LaTeX-style — the
  matching `]`/`}` or Enter hops back out, with a bracket-balance check so
  literal "[1]" still types inside a note; also † in the toolbar or ⌘⌥F):
  real page-bottom footnotes. The
  superscript marker renumbers live; the body is ordinary editable rich text
  positioned at the foot of the page its marker lands on, above a separator
  rule whenever exact page geometry is active. In continuous mode bodies
  become visible inline notes, so a failed page map never hides editable
  content. Enter in a body returns to the marker;
  clicking a marker jumps to its body. Exports as Typst `#footnote[...]`
  (the PDF gets true Typst footnotes); in browser print, bodies degrade to
  inline notes.
- **Tables** (⊞ in the toolbar): header row, Tab/Shift-Tab cell navigation,
  rectangular selection/copy, and a compact contextual palette while the
  caret is in a table — add rows or columns before/after, delete them,
  merge/split cells, toggle a header row, align selected cells, choose
  booktabs/grid/plain rules, set text size, and edit caption or label. The
  table in the document is the one editable semantic ProseMirror tree — there
  is no compiled clone or modal string grid. Tables that fit are atomic for
  exact boundary translation; an unrepresentable split switches the entire
  editing surface to continuous mode rather than guessing.
  Native Typst export preserves rules, per-cell alignment, header rows,
  `table.cell(colspan/rowspan)`, rich marks, math, citations, and multiple cell
  paragraphs. Unknown named arguments remain attached for exact Proof/export;
  because arbitrary Typst functions cannot be reproduced safely by CSS, the
  native table shows the selected base style while that custom-argument badge
  is present. Forms we cannot reconstruct faithfully become explicit
  executable Typst embeds instead of being simplified.
- **Code and Typst embeds are separate concepts.** Ordinary language-labelled
  code is inert native source. Export uses an unlabelled Typst `raw` block so
  Proof paints the same plain code as the editor, with the language and options
  retained in a lossless inert comment for re-import. Executable Typst has its
  own `typst_embed` node:
  source remains directly editable and always visible beside a sanitized
  preview cropped from the same full-document publication that PageOracle
  consumes. Prior definitions, counters, show/set rules, fonts, and assets
  therefore have their real document context, without one fragment compile per
  embed. A failed revision retains the last good preview with an explicit
  error; stale completions cannot publish. Zero-output definitions keep zero
  flow height, and an embed spanning pages points to exact Proof instead of
  painting an overlapping crop. An embed that changes the surrounding Typst
  environment (`#set`, `#show`, state/counter updates, include/eval, explicit
  breaks, or out-of-flow placement) is an explicit Proof-only boundary: its
  source stays editable and executes exactly in Proof/PDF, while the mixed
  native live surface switches to labelled continuous mode rather than
  claiming geometry it cannot reproduce. Legacy `typst-raw` documents migrate
  losslessly; `.typ`, Markdown `typst-exec`, and LaTeX fallback comments
  preserve the source explicitly.
- **Inline Typst is conservative and lossless.** One balanced, fixed-size
  Typst expression is painted as an exact crop from the shared document
  publication. The canonical flexible atom `#h(1fr)` consumes the slack in
  the already-compiled line without starting another compiler job. Stateful,
  block/page-producing, malformed, multiple, or otherwise context-dependent
  source remains visible as an explicit source chip marked exact in Proof/PDF;
  it is never approximated or discarded. Export always writes the original
  Typst source verbatim.
- **Citations & bibliography** (hover the References block → Edit, or
  Document → Bib → Import .bib): the BibTeX is editable in-app (live entry
  count, ⌘Enter to save, Download .bib to get it back out; saves are
  undoable) or loadable from a `.bib`
  file into the document — the BibTeX lives in a document attribute, so it
  autosaves, participates in undo, and is embedded in the `.typ` export
  (`#bibliography(bytes(...), style: "ieee")`), keeping files fully
  self-contained. Cite with the same `@` picker (searchable by key, author,
  or title); citations render as live "[n]" in first-use order — IEEE style,
  matching the PDF — and the generated References block uses Typst's exact
  bibliography ink cropped from the shared whole-document publication, not an
  independently formatted or compiled fragment. It renumbers as citations
  move. A references list spanning multiple Typst pages stays as an explicit
  semantic fallback that directs the author to Proof rather than pretending
  one atomic crop can reproduce page flow. Typed `@key ` auto-converts when
  the key is in the bibliography; clicking a citation jumps to the references.
- **Numbered equations & references**: display equations are numbered
  automatically and renumber live as you add/reorder them. Give an equation a
  label in its popover, then type `@` in text to open the reference picker —
  it lists every labeled equation and figure with its current number,
  filters as you type, and inserts on Enter (an "unresolved" entry supports
  forward references, which show "(?)" until the label exists). References
  track numbers wherever targets move, and clicking one jumps there. Numbers
  are painted via decorations (never stored), so the document model stays
  clean. Exports as Typst `#set math.equation(numbering: "(1)")` +
  `<label>`/`@label`.
- **Document settings** (⚙ in the toolbar): font (New Computer Modern — the
  TeX face — is the sole certified public choice, with the same family and
  styles feeding live layout and PDF export), size, line spacing,
  paper (US Letter/A4), margins, hyphenation, equation numbering, **section
  numbering** ("1.2"-style painted on headings; headings then become
  `@sec:` targets in the picker, auto-labeled on first reference and
  exported as `= Title <label>` + `#set heading(numbering: "1.1")`), **page
  numbers** (show/hide, formats 1 / — 1 — / roman / 1-of-N, position,
  first-page number — mirrored in the painted chrome and exported as
  `#set page(numbering:, number-align:)` + `#counter(page).update()`), and
  **math macros** (define `\E = \mathbb{E}` once; live in every KaTeX
  render and expanded to plain LaTeX on export so files compile anywhere;
  persisted via a `// typeset:math-macros` header directive). Settings are
  document attributes — undoable, autosaved, applied live (the oracle
  re-measures and re-typesets), and exported as Typst `#set` rules. This is
  the WYSIWYG face of a preamble.
- **Real files** (File controls, ⌘O/⌘S): open and save `.typ` documents on
  disk via the File System Access API, with silent autosave to the open file,
  a dirty indicator, recent files (IndexedDB-persisted handles), and
  automatic reconnection to the last file when the browser still grants
  access. Safari/Firefox fall back to upload/download. Opening runs the
  importer (`typ-parser.ts`): full fidelity for our own output — the
  export→import→export round trip is byte-identical (tested) — plus a
  pragmatic subset of hand-written Typst (headings, marked-up paragraphs,
  lists, quotes, fenced code, mitex math, labels/references, and the
  settings header, which applies live). Anything else (`#let`, `#show`,
  unknown directives) is preserved verbatim as an executable Typst embed and
  re-exported unchanged — open + save never destroys what we don't model.
- **Exact Proof** (eye button): a deliberate read-only, keyboard-accessible
  view of the current revision rendered directly by Typst. Multi-page output
  is shown as separate paper sheets without changing Typst's page-local
  geometry; Escape returns to native editing.
- **One-click PDF export (Export flyout → PDF)**: the document compiles with
  the real Typst engine, as WASM, in a watchdog-protected Web Worker — no CLI,
  no install. The compiler (~28 MB) and bundled fonts in `public/fonts/` load
  lazily; those fonts retain the individual licenses documented in
  [`public/fonts/README.md`](./public/fonts/README.md). Math uses only the
  pinned mitex 0.2.5 archive: it is fetched from
  the Typst registry when first needed, size-bounded, and SHA-256 verified;
  imported documents cannot request arbitrary packages. Embedded images are
  decoded into the compiler's bounded virtual filesystem and the markup is
  rewritten to reference them, so figures compile properly. Equation refs
  export as `(#ref(<label>, supplement: none))` so the PDF shows "(1)"
  exactly like the editor.
- **Export**: `.typ` (Typst markup; math wrapped with mitex so it compiles —
  `typst compile document.typ` also works from the CLI), exact Typst PDF, and
  a semantic `.tex` copy for journal workflows.

## Architecture (how the needle gets threaded)

```
ProseMirror transaction → strip touched forced lines → native DOM paint

250 ms quiet period → shared document-publication broker
                         │  one PM document + asset epoch
                         ▼
              editor-instrumented full Typst SVG
                    ├─ PageOracle
                    │    └─ immutable LayoutSnapshot
                    │       ├─ body/caption/footnote breaks
                    │       └─ page starts ──────────────────┐
                    └─ shared physical crops
                         ├─ inline + display math
                         ├─ bibliography / References
                         ├─ typst_embed previews
                         └─ supported fixed inline Typst atoms ─┤
                                                               ▼
                      same-publication readiness barrier
                                                               │
                      forced lines + exact page spacers + crops

pending/fail/unmatched → native body DOM + continuous surface/source fallback

cross-page atomic crop → semantic/KaTeX/source fallback + exact Proof

Proof SVG ─┐
           ├─ uninstrumented prepared source + assets ─→ protected final lane
PDF export ┘
```

Current architecture notes:

1. **PageOracle is the sole product line-and-page authority.** It consumes the
   shared full-document Typst publication and maps body, caption, and footnote
   lines plus page starts into one immutable snapshot. The local port, classic
   Knuth–Plass implementation, and paragraph-fragment `TypstOracle` remain
   opt-in test/research references, not product fallback paths.
2. **Pagination has explicit exact, held, and continuous states.** Exact starts
   come from the whole-document compiler. Held starts have explicit exact
   provenance and survive only while a replacement is pending and geometry
   validation succeeds. Every other state removes page spacers, sheets, and
   folios and presents continuous native editing; there is no second page
   typesetter in the production graph.
3. **Editor previews share document context and publish atomically.** The
   broker deduplicates layout, math, bibliography, executable-embed, and
   supported inline-Typst demand for an immutable document revision. One
   consumer cannot cancel work another still needs, and exact line/page chrome
   waits until every geometry consumer has applied that same result. A
   multi-page atomic preview is an honest terminal Proof-only state, not a
   pending crop and not permission to invent browser pagination. Exact
   Proof/PDF work has a separate protected final lane. The worker compiles one
   vector, performs every region query against its live world, and renders that
   same vector. Publication application builds its position lookup once, so
   adding preview listeners remains O(document + listeners), not their product.
4. **Tables are one semantic tree.** Native ProseMirror rows and rich cells are
   the editable document and serialize directly to Typst; no compiled table
   clone or hidden string-grid model participates in editing.
5. **Math source is LaTeX/KaTeX, not Typst syntax** — friendlier to most
   academics; the `.typ` export bridges via mitex. KaTeX supplies disposable
   editing echo, while committed exact ink and geometry come from the shared
   whole-document publication rather than separate formula jobs.
6. **Executable escape hatches fail honestly.** Self-contained, in-flow Typst
   embeds may use a live crop. Code that can affect later native content or
   escape its flow interval remains lossless but makes the live page claim
   continuous and points to exact Proof/PDF.

## Found & fixed while building (measurement-agreement war stories)

- Canvas `measureText` ignores kern pairs against spaces (e.g. `f␣` in STIX
  Two Text, +0.84px) that DOM layout applies → lines overflowed by ~1px and
  the browser wrapped early. Fix: measure in a hidden DOM probe with Range
  rects instead of canvas.
- Inline `code` chip padding added layout width the text measurer can't see →
  neutralized with negative margins.
- Hyphen widget glyph (U+2010) must be the same glyph the measurer prices.
- Pagination geometry must be anchored to the page-stack origin, not the
  ProseMirror root — the editor sits inside the page-margin padding, and the
  one-margin offset let text run into the bottom margin.
- Blocks use bottom-margins only (top spacing via padding): collapsed margins
  would absorb part of an inserted page spacer's height.

## Project and release documentation

- [`SECURITY.md`](./SECURITY.md) describes the trust boundaries and reporting
  policy.
- [`PRIVACY.md`](./PRIVACY.md) explains local storage and the few possible
  network requests.
- [`SUPPORT.md`](./SUPPORT.md) sets support scope and issue expectations.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) contains the development and review
  workflow.
- [`PORT.md`](./PORT.md) records the Typst line-mirror rationale, certified
  scope, and implementation status.
- [`docs/archive/`](./docs/archive/) holds frozen history: the pre-Plass design
  spec and the completed layout-hardening session log.
- [`RELEASING.md`](./RELEASING.md) is the public-release checklist.
- [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) explains software and
  font license notices.
- [`ROADMAP.md`](./ROADMAP.md) tracks product work beyond release hardening.

## License

Plass is available under the [`MIT License`](./LICENSE). Bundled dependencies
and fonts retain the licenses recorded in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
