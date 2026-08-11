# Plass

> Named for Michael F. Plass, co-author of the Knuth–Plass line-breaking
> algorithm that runs live under every paragraph here.

**A true WYSIWYG editor with publication-quality typesetting.** You write in a
clean, Typora-style surface; what you see is — at all times, live — a document
typeset by the Knuth–Plass algorithm, the same optimizing paragraph breaker
TeX and Typst use. The editing surface *is* the output surface.

This is the MVP of the design in [`wysiwyg-typeset-editor-spec.md`](./wysiwyg-typeset-editor-spec.md)
(background discussion in [`typeset-editor-conversation.md`](./typeset-editor-conversation.md)).

## Run it

```sh
npm install
npm run dev      # → http://localhost:5173
npm test         # Knuth-Plass oracle unit tests
npm run build    # typecheck + production build (static site in dist/)
```

## Fidelity

**Line breaks are Typst's own.** The editor no longer trusts its JS
Knuth-Plass for the final answer: paragraphs are compiled in the background
by the in-app Typst (WASM) — the byte-exact fragment the PDF pipeline sees —
and the chosen breaks are read back from the compiled SVG's text-selection
layer (line-by-line text, matched to character offsets; hyphenation points
arrive textually). Those breaks are imposed on the DOM via the existing
decoration machinery, replacing the JS oracle's choices. The JS pass renders
instantly on each keystroke; the Typst pass converges ~100-200 ms later
(10-30 ms compiles, warm). Content the matcher can't align (e.g. Typst
breaking inside a raw span) falls back to the JS breaker per-paragraph.
Measured on the demo document: identical line count and break positions in
every paragraph, mean right-edge difference 0.76 px, no line above 3 px
(ink-edge measurement noise). Inline code spans render in the same DejaVu
Sans Mono at Typst's 0.8em ratio (same font file feeds the compiler), so
their widths agree exactly.

The editor and the Typst PDF also share one vertical geometry. The exported
header carries measured parity rules — `#set par(leading:, spacing:)`,
per-level heading `set text/block/par` rules, list/enum spacing, and
display-equation block spacing — derived from the editor's CSS model and
per-font metric constants (`FONT_PARITY` in `typ-serializer.ts`, calibrated
against live renders; baseline agreement measured at ≤0.04px across
paragraphs and headings for the bundled fonts). Known remaining deltas:
justification distributes sub-pixel differently (the editor underfills each
line by ≤0.5px to keep the browser from re-wrapping); figures/tables are raster-vs-vector comparisons; and page-break decisions
(footnote areas, widow rules) are still the editor's own — page-level parity
is the next milestone. The first page's top offset also differs slightly
(Typst suppresses leading block spacing at page top).

## What works today

- **Oracle layout** (spec §1.3): the document lives in the DOM — native
  selection, cursor, IME, spell-check, screen readers — while a layout oracle
  imposes TeX-quality decisions on it: optimal Knuth–Plass line breaks,
  per-line justification via exact `word-spacing`, and hyphenation from
  Liang's patterns (TeX's algorithm). Toggle **TeX layout** in the toolbar to
  compare with the browser's greedy wrapping.
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
  takes over for the printed artifact.
- **Fast**: full-document typeset + pagination in ~2–7 ms for a few pages;
  per-keystroke relayout touches only the edited paragraph (unchanged
  paragraphs are cached by node identity). Live timing in the status bar.
- **Editing**: ProseMirror core. Markdown-style input rules (`#` headings,
  `**bold**`, `*italic*`, `` `code` ``, `>` quotes, `-`/`1.` lists, ` ``` `
  code blocks), keyboard shortcuts, undo/redo, autosave to localStorage.
- **Typora-style chrome**: a slim quiet bar — filename on the left, and on
  the right a row of small monochrome icon buttons (File / Insert /
  Document / Export groups) whose **text labels slide out on hover**;
  formatting itself is markdown rules + shortcuts (cheat-sheet behind the ?
  button). Rare actions live in a small ⋯ overflow (demo, Save As, recents,
  import .bib, print). A faint corner HUD shows pages · words (hover for
  oracle timing), messages appear as transient toasts, and table controls
  float beside the table only while the caret is inside one. Insert
  shortcuts: ⌘⌥T table, ⌘⌥I figure, ⌘⌥F footnote, ⌘M/⌘⇧M math.
- **Math**: type `$e^{i\pi}+1=0$` for inline math, `$$` on an empty line for
  display math. Formulas display **Typst's own ink** — each is compiled by
  the in-app compiler (mitex + New Computer Modern Math) and shown as its
  exact PDF rendering, baseline-aligned to the text (measured 0.0 px); KaTeX
  renders instantly while you type and the compiled ink swaps in ~100 ms
  later. Click-to-edit popover with live preview. The oracle justifies
  around inline math using the Typst-exact atom width.
- **Figures**: insert from the toolbar, or paste/drop an image. Editable
  inline captions with a painted "Figure N:" prefix that renumbers live; a
  label chip on the figure (hover top-right) names it for `@label`
  references, which share the machinery with equation refs. Figures paginate
  atomically (never split across pages). Exports as Typst
  `#figure(image(...), caption: [...]) <label>`; image data (data: URLs) is
  exported verbatim so our own files round-trip losslessly — swap in a real
  image path when compiling with Typst.
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
  (the PDF gets true Typst footnotes); with the typeset toggle off or in
  browser print, bodies degrade to inline notes.
- **Tables** (⊞ in the toolbar): header row, Tab/Shift-Tab cell navigation,
  and contextual controls that appear in the toolbar while inside a table —
  add/delete rows and columns, merge/split cells, toggle header,
  **per-column alignment (L/C/R — right-align for regression numbers)**, and
  a **Style cycle: booktabs (academic default: horizontal rules only) →
  grid → plain**. Cell selection by shift-click/drag. Tables paginate
  atomically and export as native Typst — booktabs becomes `stroke: none` +
  `table.hline()` rules, alignment becomes the `align: (…)` tuple with
  per-cell overrides, merges become `table.cell(colspan/rowspan)` — all
  preserved through the round trip. (Cells keep browser layout — narrow
  measures justify badly.) For full Typst control, the **Opts** button
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
  File → Edit/Import bibliography): the BibTeX is editable in-app (live entry
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
  TeX face — is the default, shipped as webfonts rebuilt to TrueType so
  browsers accept them; the same family feeds the PDF), size, line spacing,
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
- **Real files** (File menu, ⌘O/⌘S/⇧⌘S): open and save `.typ` documents on
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
- **One-click PDF export (File → Export PDF)**: the document compiles with
  the real Typst engine, as WASM, in the browser — no CLI, no install. The
  compiler (~28 MB), bundled fonts (~4 MB: STIX Two Text, Libertinus Serif,
  New Computer Modern Math, DejaVu Sans Mono — all OFL, in `public/fonts/`),
  and the mitex package (fetched once from the Typst registry; needs network
  on first export) load lazily and are cached — first export ~2 s, warm
  exports ~0.1 s. Embedded images are decoded into the compiler's virtual
  filesystem and the markup rewritten to reference them, so figures compile
  properly. Equation refs export as `(#ref(<label>, supplement: none))` so
  the PDF shows "(1)" exactly like the editor.
- **Export**: `.typ` (Typst markup; math wrapped with mitex so it compiles —
  `typst compile document.typ` also works from the CLI), plus Print/PDF of
  the typeset view itself.

## Architecture (how the needle gets threaded)

```
keystroke → ProseMirror transaction → DOM updates immediately (optimistic echo)
                     │
                     ▼  (next animation frame, dirty paragraphs only)
        paragraph → boxes/glue/penalties  (src/layout/paragraph.ts)
                     │   widths measured in a hidden DOM probe with Range
                     │   rects — the measuring engine IS the rendering
                     │   engine, so shaping/kerning agree by construction
                     ▼
        Knuth–Plass line breaker          (src/layout/knuth-plass.ts)
                     │   optimal breaks + per-line adjustment ratios
                     ▼
        decorations                       (src/typeset-plugin.ts)
                     │   per-line word-spacing spans, <br> widgets at chosen
                     │   breaks, hyphen widgets at hyphenation points —
                     │   presentation-only, invisible to the document model,
                     │   the clipboard, and assistive tech
                     ▼
        the browser rasterizes the oracle's decisions
```

Design deviations from the spec, deliberate for the MVP:

1. **The oracle is Knuth–Plass in TypeScript, not Typst-WASM.** The spec's
   fallback path ("run Typst — or just Knuth-Plass in JS — as a layout
   oracle"). No Rust toolchain needed, and measuring with the browser's own
   metrics dissolves the measurement-agreement problem (§4.1) entirely. The
   oracle sits behind a narrow interface (`layoutBlock`), so a Typst-WASM
   frame-tree oracle can replace it without touching the editor.
2. **No pagination yet** — continuous sheet, ragged-bottom. Page geometry is
   the next big rock (spec §3.5 item 3).
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

## Next (spec milestones)

- **M2 polish**: settle-debounced break application while typing mid-line;
  letter-spacing-based justification for tight lines; incremental pagination
  (measure from the edited block forward — per-keystroke cost on a 13-page
  document is ~6–8 ms, dominated by the global pagination measure).
- **M3 surface**: float placement for figures (drift to page top/bottom);
  image sidecar files on save (directory handle) so CLI compiles work
  without swapping data URLs; raw-island compiled previews; Tier B
  whole-document preview (the fragment machinery generalizes).
- **Typst-WASM oracle** (M0 of the spec proper): swap `layoutBlock` for
  typst.ts frame-tree output; gets float placement + page breaking "for
  free". The compiler and renderer now ship in the app (PDF export +
  compiled table previews prove the compile→SVG→display loop end to end),
  so this is an experiment away rather than an integration away. The same
  fragment-preview mechanism should extend to raw-Typst islands and a
  whole-document Tier B preview next.
- **v2**: executable Python cells via Pyodide (the computational-document
  vision).
