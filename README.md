# Plass

> Named for Michael F. Plass, co-author of the Knuth–Plass line-breaking
> algorithm that inspired the editor. Plass now mirrors Typst's modern
> paragraph breaker for its certified live path and retains classic
> Knuth–Plass as a conservative fallback and reference.

**A true WYSIWYG editor with publication-quality typesetting.** You write in a
clean, Typora-style surface while local layout and an in-browser Typst compiler
coordinate the line and page decisions. The editing surface *is* the output
surface: native browser text with publication layout imposed as
presentation-only decorations.

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

**The certified line-breaking path mirrors Typst.** On each edit, Plass first
reuses already-compiled break offsets when they are available; otherwise it
runs a TypeScript mirror of Typst's breaker against version-pinned ICU,
hyphenation, shaping, and font primitives from a small Rust/WASM sidecar. A
direct translator imposes those authoritative offsets on the DOM without
running syllabification or break search a second time. The background Typst
compile remains the verifier and authority, and an identical result is a
no-op rather than a second visual correction.

That exact contract is deliberately narrow: New Computer Modern is currently
the only selectable body family, with all four faces registered across the
browser, sidecar, and compiler. It covers the mapped body, caption, footnote,
and inline constructs exercised by the differential suite. If the sidecar is
unavailable or a paragraph cannot be represented safely, Plass fails over to
the legacy JavaScript Knuth–Plass path; unsupported content therefore does not
carry the exact-break guarantee. Historical font preferences remain stored,
but the editor and export both resolve uncertified names to New Computer
Modern instead of claiming machine-dependent fidelity.

The editor and exported Typst document share page, type, and vertical-spacing
settings. When a whole-document compile can be mapped safely, its page starts
drive the live page spacers; mapped starts may be held briefly through an edit
burst while a fresh answer is pending. Repeated failures, invalid geometry,
or unsupported structures fall back to the complete local paginator, which
handles footnote reservations and widow/orphan rules. This is a scoped,
fail-closed agreement rather than a claim that every arbitrary Typst document
or every browser raster detail is identical.

## Typst on rails

Plass is not a Typst editor. It is a writing surface whose documents happen to
be plain Typst files, and it deliberately supports a fixed set of things
rather than the whole language. That is what makes the fidelity contract
above possible: the editor can only show live, exactly, what it can mirror,
and arbitrary Typst can lay out in ways no browser surface can follow.
Everything Plass supports therefore falls into one of three tiers, and the
tier is always visible to the writer.

- **On rails.** Headings, paragraphs, lists, math, figures, footnotes,
  tables, citations, and the document settings the toolbar exposes. These
  are edited directly in the page, laid out live by the local mirror, and
  verified by the compiler. What you see is what prints.
- **Tolerated.** Typst that arrives in a file and that Plass does not
  model is preserved verbatim as a raw island: a clearly marked source
  block that is never rendered live, never altered, and passed straight
  through to the PDF. It can be read, moved, or deleted, and it carries no
  layout guarantee. This is how files survive round trips through other
  tools; it is not an authoring path.
- **Off.** Multi-column layout, floats, custom show and set rules, and
  hand-written layout code are declined on purpose. They are not queued
  features; adding one means adding a rail, with its local mirror and its
  oracle verification, one at a time.

Two consequences follow. Styling is offered as presets the layout engine
has been verified on, not as free parameters. And the source view, when it
arrives, is a second editor for the same rails, not a way around them: a
plain-text surface in the spirit of iA Writer for simpler files, editing
the same headings, lists, math, and notes as text. It does not admit
constructs the page view cannot show. A document that needs more than the
rails can always be finished in Typst itself, because the file is Typst.

## What works today

- **Oracle layout** (spec §1.3): the document lives in the DOM — native
  selection, cursor, IME, spell-check, screen readers — while a layout oracle
  imposes Typst-selected break offsets, hyphens, and per-line justification.
  The fast local port and the compiled Typst verifier share pinned shaping and
  font inputs within the supported contract.
- **Real pages**: content flows across painted page boxes (US Letter/A4 from
  document settings) with margins, inter-page gaps, and page numbers.
  Paragraphs split across page boundaries at oracle-chosen line breaks while
  remaining single editable nodes; lists and blockquotes break between
  children. Widow/orphan control: a paragraph never leaves fewer than two
  lines at the bottom of the page where it starts (it moves whole instead)
  and never strands its last line alone at the top of a page (the break
  retreats one line). Pagination is live — type on page 1 and watch page 3
  reflow.
  Mechanism: the document stays one continuous editable flow; page boxes are
  painted behind it and exact-height spacer widgets push content past each
  boundary (inside a paragraph, a block-in-inline spacer replaces the line's
  `<br>`, so it forces the break and adds precisely the gap height). Print
  CSS zeroes the spacers — line breaks survive, gaps vanish — and `@page`
  takes over for the printed artifact. Whole-document Typst page starts are
  used when they compile and map safely; otherwise the full local paginator is
  authoritative. A suffix-only paginator is currently development shadow
  telemetry: it is compared with the full result, but never installed.
- **Fast**: the edit path discovers and rebuilds only changed body, caption,
  and footnote blocks, while unchanged block geometry stays cached. The direct
  forced-break translator avoids the legacy path's repeated DOM measurement,
  and pagination captures spacer/table geometry once per pass behind a
  prefix-sum index. Browser tests enforce one line-decoration dispatch for a
  normal edit and no redundant reinstall when the compiled verifier agrees.
  Live diagnostic timings remain available in development, but wall-clock
  values are not treated as portable performance promises.
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
  display math. Formulas display **Typst's own ink** — each is compiled by
  the in-app compiler (mitex + New Computer Modern Math) and shown from that
  compiled result, baseline-aligned to the text; KaTeX provides the immediate
  editing preview and the compiled ink replaces it when ready. Click-to-edit
  popover with live preview. The oracle justifies
  around inline math using the Typst-exact atom width.
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
  rule — and the paginator *reserves space* for bodies when deciding page
  breaks, so text never collides with the footnote area and a marker always
  shares a page with its note. Enter in a body returns to the marker;
  clicking a marker jumps to its body. Exports as Typst `#footnote[...]`
  (the PDF gets true Typst footnotes); in browser print, bodies degrade to
  inline notes.
- **Tables** (⊞ in the toolbar): header row, Tab/Shift-Tab cell navigation,
  and contextual controls that appear in the toolbar while inside a table —
  add/delete rows and columns, merge/split cells, toggle header,
  **per-column alignment (L/C/R — right-align for regression numbers)**, and
  a **Style cycle: booktabs (academic default: horizontal rules only) →
  grid → plain**. Cell selection by shift-click/drag. Breakable long tables
  use a paged Typst mini-compile and appear as cropped page fragments,
  including repeated `table.header` rows; content Typst keeps unbreakable is
  pushed whole. While a split compile is pending or cannot be verified, the
  existing split or atomic layout remains in place. Tables export as native
  Typst — booktabs becomes `stroke: none` + `table.hline()` rules, alignment
  becomes the `align: (…)` tuple with per-cell overrides, and merges become
  `table.cell(colspan/rowspan)` — all preserved through the round trip. (Cells
  keep browser layout — narrow measures justify badly.) For full Typst control,
  the **Opts** button
  stores raw `#table` arguments on the table (stroke/fill functions,
  `inset`, fractional column widths, …), emitted verbatim into the export
  and PDF — presets are suppressed while custom args exist. The document
  **always shows the compiled table** (the in-app Typst render — same
  fonts, engine, and centering as the PDF). Clicking it opens a focused
  **editing card**, following the math-editor pattern: a plain cell grid
  (Tab/arrows to move, header row bold, shift-click to select a range),
  structural controls (rows, columns, merge/split, header toggle,
  per-column alignment, style cycle), **clickable row boundaries** that
  toggle booktabs midrules, a card-local **⌘Z/⌘⇧Z undo stack**, and a live
  compiled result. The **Typst panel** at the bottom always shows the full
  `#table(...)` arguments the current state compiles with — editing it
  parses back through the importer, so GUI and source are two views of one
  thing; custom arguments are additive with the style preset (add
  `inset: 9pt` and booktabs stays). ⌘Enter saves as one undoable step; Esc
  cancels. Cells with rich content (math, references) are preserved unless
  their text is edited. Imported tables keep
  unknown named arguments the same way; forms we can't reconstruct
  faithfully (custom-positioned rules, vlines) fall back to raw-Typst
  islands rather than being simplified.
- **Citations & bibliography** (hover the References block → Edit, or
  Document → Bib → Import .bib): the BibTeX is editable in-app (live entry
  count, ⌘Enter to save, Download .bib to get it back out; saves are
  undoable) or loadable from a `.bib`
  file into the document — the BibTeX lives in a document attribute, so it
  autosaves, participates in undo, and is embedded in the `.typ` export
  (`#bibliography(bytes(...), style: "ieee")`), keeping files fully
  self-contained. Cite with the same `@` picker (searchable by key, author,
  or title); citations render as live "[n]" in first-use order — IEEE style,
  matching the PDF — and a generated References block lists cited works in
  order, renumbering as citations move. Typed `@key ` auto-converts when the
  key is in the bibliography; clicking a citation jumps to the references.
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
  unknown directives) is preserved verbatim as a raw-Typst island and
  re-exported unchanged — open + save never destroys what we don't model.
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
  `typst compile document.typ` also works from the CLI), plus Print/PDF of
  the typeset view itself.

## Architecture (how the needle gets threaded)

```
ProseMirror transaction → native DOM echo
          │
          └─ next microtask: discover changed body/caption/footnote blocks
                         │
                         ├─ cached compiled breaks, when available
                         ├─ local Typst mirror + Rust/WASM primitives
                         └─ legacy Knuth–Plass, only as fallback
                                      │
                                      ▼
                         direct forced-break translation
                         (src/layout/forced-layout.ts)
                                      │
                                      ▼
                         block-relative line decorations
                         (src/layout/line-decorations.ts)
                                      │
                                      ▼
                         browser paints the selected layout

250 ms quiet period → compiled Typst verification + complete pagination
                         ├─ exact mapped page starts, when available
                         ├─ temporarily held mapped starts
                         └─ full local fallback from one geometry snapshot
```

Current architecture notes:

1. **The fast certified path is a TypeScript mirror of Typst; Typst-WASM stays
   the verifier and authority.** The legacy Knuth–Plass implementation remains
   available for unsupported or degraded cases, not as the exactness claim.
2. **Pagination has explicit exact, held, and fallback states.** Exact starts
   come from the whole-document compiler; held starts stabilize a pending edit
   burst; the full local paginator fails closed when exact mapping is not
   available. The conservative suffix candidate runs only in development and
   the full result is always installed.
3. **Math is LaTeX/KaTeX, not Typst syntax** — friendlier to most academics;
   the `.typ` export bridges via mitex.

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
