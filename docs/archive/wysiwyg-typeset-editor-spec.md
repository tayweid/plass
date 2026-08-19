# Typeset: A True WYSIWYG Editor with Publication-Quality Typesetting

**Project specification — v0.1 draft**
**Status: pre-implementation design document**
**License target: open source (Apache 2.0 or MIT), professional product ambitions**

---

## 1. Motivation

### 1.1 The gap

There are two families of document tools, and neither gives writers what they actually want:

**Markup-and-compile tools** (LaTeX, Typst, Quarto in source mode) produce beautiful output — Knuth-Plass paragraph optimization, intelligent float placement, proper page-aware layout, microtypography. But the writing experience is a two-pane workflow: source on the left, preview on the right, a cognitive context-switch on every glance. The author is always looking at a *representation* of the document, never the document itself.

**WYSIWYG tools** (Typora, Notion, Word, Google Docs) let the author work directly in the rendered document — the editing surface *is* the output surface. This is a genuinely better writing experience for most prose. But the layout quality tops out at what a browser (or Word's layout engine) can do: greedy first-fit line breaking, no global paragraph optimization, no serious float placement, weak justified text.

The market gap: **a tool where the editing surface is the output surface, and the output is typeset to TeX-level quality.** Nobody has built it. LyX tried the "structured WYSIWYM over LaTeX" approach and got stuck in the impedance mismatch between an interactive editing model and LaTeX's macro-expansion compilation model. Modern attempts (Typst's web app, Quarto visual mode, Overleaf) all retreat to the two-pane compromise.

### 1.2 Why now

Three things changed recently that make this buildable where it wasn't before:

1. **Typst exists and is fast.** Typst is an open-source (Apache 2.0) typesetting engine written in Rust that implements the full stack of serious typography — Knuth-Plass line breaking, justification with per-glyph stretch/shrink, hyphenation, float placement, page layout — with *incremental compilation in single-digit milliseconds*. It compiles to WASM and runs in the browser today. The `typst.ts` project (Myriad-Dreamin) already packages the compiler and an SVG renderer as npm modules loadable from a CDN.

2. **The layout output is inspectable.** Typst's layout engine produces a **frame tree**: a hierarchy of positioned frames containing text runs, glyphs, shapes, and images, each at exact (x, y) coordinates with source-span mappings. This is the input to all of Typst's export formats. It is exactly the data a rendering layer needs: not a rasterized picture, but structured layout *decisions*.

3. **Mature embeddable editor infrastructure.** ProseMirror provides a battle-tested rich-text editing state model (document model, transactions, selection, undo history, collaborative editing primitives) that is explicitly designed to allow custom view/rendering layers. CodeMirror 6 provides embeddable code editing. KaTeX provides instant math rendering as a fallback/preview path.

### 1.3 The core insight: CSS as the render target

The previous section of our discussion identified the key architectural idea, which distinguishes this project from both the "canvas editor" approach (Google Docs) and the "fast preview pane" approach (Typst web app):

> **Every layout decision a TeX-class engine makes can be expressed in CSS.** Line break positions, per-line word spacing, hyphenation points, glyph positions, float placement — all of it maps to DOM structure plus CSS properties (`word-spacing`, absolute positioning, soft hyphens, `letter-spacing`, `hanging-punctuation`, transforms).

This means we do **not** need to reimplement text editing on a canvas (the Google Docs path, a multi-year engineering effort to rebuild selection, IME, accessibility, spell-check from scratch). Instead:

- The **DOM remains the editing surface.** Native selection, cursor, IME composition, copy-paste, screen readers, browser spell-check all keep working, because the text genuinely lives in the DOM.
- **Typst is demoted from renderer to layout oracle.** It never paints anything. It receives the document, computes the layout, and we read the frame tree back and *impose* its decisions onto the DOM via generated CSS.
- The browser becomes a **dumb rasterizer following instructions** rather than a layout engine making its own (worse) decisions.

We call this architecture **oracle layout**. It threads the needle between the two dead ends:

| Approach | Editing quality | Typeset quality | Effort |
|---|---|---|---|
| Pure DOM (Typora) | native, excellent | browser-grade | low |
| Canvas + custom engine (Google Docs) | reimplemented, huge effort | whatever you build | very high |
| Two-pane compile (Overleaf, Typst app) | source editing only | excellent | medium |
| **Oracle layout (this project)** | **native, excellent** | **Typst-grade** | **medium** |

### 1.4 Who this is for (market)

- **Academics** writing papers, lecture notes, problem sets. Today they suffer LaTeX or settle for Word. (Immediate dogfooding target: economics lecture materials with math and embedded figures.)
- **Technical writers and educators** producing handouts, documentation, textbooks.
- **Students** — the "I need my thesis to look right but I don't want to learn LaTeX" market is enormous.
- **Anyone producing typeset PDFs** — resumes, reports, books, newsletters.

The wedge is academia (where output-quality standards are highest and current-tool pain is worst), expanding outward. Open-source core builds trust and adoption in academia; a hosted version with collaboration, cloud storage, and templates is the eventual commercial layer (the Overleaf/Typst-app playbook, but with a categorically better editor).

---

## 2. Product definition (v1 scope)

### 2.1 One-sentence description

A web app where you write in a clean Typora-style WYSIWYG surface, and what you see is — at all times, live — the actual Typst-typeset document, editable in place.

### 2.2 v1 feature set (deliberately minimal)

**In scope:**

1. Single-document editing, client-side only. No accounts, no server, no collaboration. A static site.
2. Document model covering: paragraphs, headings (3 levels), bold/italic/monospace inline styles, inline and display math, bulleted/numbered lists, block quotes, images, code blocks, footnotes.
3. Typeset rendering via Typst oracle: justified text with Knuth-Plass breaks, hyphenation, real page boundaries (US Letter / A4), page margins, running page numbers.
4. Math: inline and display, entered as Typst math syntax in a small popover editor, rendered typeset in place.
5. File I/O: open/save `.typ` files (Typst markup is the on-disk format), export PDF (via Typst's PDF export in the same WASM module), import a pragmatic subset of Markdown.
6. Keyboard-first formatting (Cmd+B etc.), minimal floating toolbar.

**Explicitly out of scope for v1** (documented so we don't creep):

- Executable code cells (the Python-notebook dimension — this is v2; see §8)
- Collaboration / multiplayer
- Typst scripting surface (`#let`, `#show` rules) beyond a raw-source escape hatch
- Citations/bibliography (v1.5 — Typst's `bibliography()` makes this easy to add later)
- Tables (early v1.x; layout is fine, editing UX is the work)
- Mobile editing
- Custom fonts beyond a curated bundled set

### 2.3 The bar for "feels right"

- Keystroke-to-glyph latency under 16 ms for the optimistic echo; correct typeset layout applied within 50 ms (imperceptible as a "correction" in the common case).
- Native text selection, double-click word select, triple-click paragraph select, standard clipboard behavior.
- IME composition works (this falls out of keeping text in the DOM, but must be tested, not assumed).
- Screen reader announces the document as a document (again: falls out of DOM-native text, must be verified).
- No layout "pop" during ordinary typing within a paragraph.

---

## 3. Architecture

### 3.1 System overview

```
┌─────────────────────────────────────────────────────────┐
│                       Browser                           │
│                                                         │
│  ┌───────────────┐   transactions   ┌────────────────┐  │
│  │  ProseMirror  │ ───────────────▶ │  Doc model     │  │
│  │  editing      │                  │  (PM doc =     │  │
│  │  surface      │ ◀─────────────── │  source of     │  │
│  │  (the DOM)    │    DOM updates   │  truth)        │  │
│  └──────┬────────┘                  └───────┬────────┘  │
│         │                                   │           │
│         │ optimistic                        │ serialize │
│         │ echo (CSS                         ▼           │
│         │ approx.)                  ┌────────────────┐  │
│         │                          │  PM ⇄ Typst     │  │
│         │                          │  mapper         │  │
│         │                          └───────┬────────┘  │
│         │                                  │ .typ src   │
│         │                                  ▼            │
│         │                          ┌────────────────┐   │
│         │                          │  Typst WASM    │   │
│         │                          │  (web worker)  │   │
│         │                          │  incremental   │   │
│         │                          │  compile       │   │
│         │                          └───────┬────────┘   │
│         │                                  │ frame tree │
│         │                                  ▼            │
│         │                          ┌────────────────┐   │
│         │      layout CSS          │  Layout        │   │
│         └◀─────────────────────────│  translator    │   │
│                                    │  (frames→CSS)  │   │
│                                    └────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

Five components. Everything runs client-side.

### 3.2 Component 1: Document model (ProseMirror)

**Role:** single source of truth for document *content and intent*. ProseMirror's schema defines our node types (paragraph, heading, math_inline, math_display, list, blockquote, image, code_block, footnote) and marks (strong, em, code). All edits flow through PM transactions, giving us undo/redo, input rules (`**bold**` → bold as you type, `$` → math popover), and later, CRDT-based collaboration via the existing PM ecosystem (yjs bindings) essentially for free.

**Key decision:** the PM document is authoritative, not the `.typ` source text. The `.typ` file is a *serialization*. This avoids LyX's fate: we never parse arbitrary hand-edited source into an editing model as the primary loop (we do it once, on file open). Round-trip fidelity is required only for documents our own serializer produced, plus a well-defined importable subset of hand-written Typst.

**Escape hatch:** a document-level "raw Typst block" node type whose content we pass through verbatim and whose rendered output we display as a non-editable (click-to-edit-source) island. This is how users access the full power of Typst scripting without us building WYSIWYG UI for all of it. Same pattern Notion uses for embeds.

### 3.3 Component 2: PM ⇄ Typst mapper

**Role:** deterministic bidirectional mapping between the PM document and Typst markup, with **position mapping** as a first-class output.

- **Serialize:** PM doc → `.typ` string. Straightforward tree walk. Critically, the serializer emits a **position table**: for every PM node and text offset, the corresponding byte range in the generated `.typ` source. Because we control the serializer, this table is exact — no parsing heuristics.
- **Parse (file open + raw-block ingestion):** Typst source → PM doc, via Typst's own parser (exposed through the WASM module; Typst's syntax crate produces a full CST with spans). Constructs we don't model become raw blocks rather than being dropped.

The position table composes with Typst's own source spans (every item in the frame tree carries the span of the source that produced it) to give the full chain:

```
PM position ⇄ .typ byte offset ⇄ frame-tree item ⇄ (x, y) on page
```

This chain is what makes click-to-cursor, cursor-drawing, and selection rectangles work in typeset space. Typst maintains this span infrastructure for its own IDE tooling (tinymist, click-to-source in the web app), so we are consuming a supported capability, not reverse-engineering.

### 3.4 Component 3: Typst compiler (WASM, in a Web Worker)

**Role:** the layout oracle. Runs off the main thread; receives `.typ` source (or incremental edits), returns a serialized frame tree.

- **Packaging:** start from `typst.ts` (`@myriaddreamin/typst-ts-web-compiler`), which already handles WASM packaging, a virtual filesystem, and font loading. We will need a custom build or fork that exposes the **frame tree as structured data (JSON/flatbuffer)** rather than only SVG/canvas/PDF outputs. Typst's `Frame` type is the common input to all exporters, so this is an additional exporter (~small Rust patch), not surgery on the engine. This is the single most important technical task in the project and the first thing to prototype (§6, milestone 0).
- **Incrementality:** Typst's comemo-based incremental compilation gives millisecond recompiles for local edits. We feed it the full serialized source each time (Typst's incremental parser diffs internally); if profiling shows serialization itself becoming the bottleneck on huge documents, we shard serialization per top-level block.
- **Fonts:** bundle a curated set (e.g., New Computer Modern, Libertinus, a good sans, a good mono) loaded into both the WASM VFS *and* the page as `@font-face` from the *same binary data* — this is what guarantees browser text measurement matches oracle assumptions (§4.3).

### 3.5 Component 4: Layout translator (frame tree → CSS)

**Role:** the heart of the oracle-layout idea. Reads the frame tree and imposes Typst's decisions on the DOM.

For each paragraph, the frame tree tells us (via the inline layout structures): the chosen break points, per-line justification adjustments (how much each line's spaces stretched or shrank), hyphenation insertions, and each line's y-position. The translator:

1. Walks the frame tree, using spans + the position table to match frame items to PM DOM nodes.
2. Emits, per line: a line-wrapper span (or CSS on existing text nodes) with `word-spacing: <exact px>` (and `letter-spacing` where Typst used inter-glyph justification), an inserted `&shy;`/forced break at the chosen break point, and vertical position.
3. Emits per-block: page assignment, float positions (absolutely positioned figure containers), margins, page-break spacers, running headers/footers/page numbers as generated chrome.
4. Applies all of this as a single batched DOM/CSSOM update (one style element with generated rules keyed by stable node IDs, plus minimal structural spans for line wrapping) inside `requestAnimationFrame`.

**Fidelity tiers.** We do not attempt pixel-exact glyph positioning in v1 (absolute-positioning every word is possible — the JS Knuth-Plass polyfills do it — but it's heavy and fights the native selection we're trying to preserve). Tiered approach:

- **Tier A (v1 default, editing view):** Typst's break points + per-line word-spacing + hyphens + page geometry, applied to naturally-flowing DOM text. This captures ~95% of the visual difference (break choice dominates perceived quality) while keeping text fully native.
- **Tier B (print-preview toggle & final check):** per-word positioned rendering directly from frame coordinates — pixel-identical to the PDF. Read-only mode.
- **Export:** the PDF comes from Typst itself, so the artifact is always perfect regardless of tier.

### 3.6 Component 5: Optimistic echo & scheduling

**Role:** hide oracle latency; never block a keystroke.

- On every transaction, PM updates the DOM immediately with browser-native layout *inside the paragraph being edited* (the paragraph temporarily "goes native"). This is the optimistic echo — 0 added latency.
- The serializer + oracle round-trip runs concurrently (debounced to animation frames, coalescing rapid keystrokes). When the frame tree returns, the translator re-imposes typeset layout. For intra-paragraph edits, Typst's breaks usually match or differ by one line-end word — the correction is visually subtle; distant paragraphs almost never change, so no global reflow "pop."
- **Stale-response discipline:** every compile request carries the PM doc version; responses for superseded versions are dropped. Only the latest layout is ever applied.
- Scroll-viewport prioritization: translate frames for visible pages first; offscreen pages lazily.

### 3.7 Cursor, selection, and hit-testing details

Because text stays in the DOM, the browser handles the cursor and selection *within* text runs natively. The places we intervene:

- **Across oracle-inserted structure** (line wrappers, hyphens, page breaks): inserted nodes are marked (`contenteditable=false`, `aria-hidden`, `user-select:none` where appropriate) so selection and copy skip them; copy handler serializes from the PM doc, not the DOM, so clipboard content is always clean.
- **Math nodes:** atomic in PM (cursor treats them as single units); click opens a popover with a CodeMirror-lite Typst-math input; live KaTeX preview in the popover for instant feedback; committed node is re-rendered by the oracle (as inline SVG from the same frame data) so display always matches final output.
- **Page boundaries:** pages are separate stacked containers; a paragraph split across pages is rendered as two visual fragments of one PM node (the translator handles fragment bookkeeping; PM position mapping makes cursor motion across the split seamless).

---

## 4. Hard problems, named and confronted

Design honesty section. These are the places the project can die; each gets a mitigation and a validation milestone.

### 4.1 Measurement agreement (the circularity problem)

The oracle computes layout using its own text shaping (rustybuzz). The browser renders with its shaping (HarfBuzz etc.). If widths disagree, Typst's chosen breaks could overflow or underfill lines in the DOM.

**Mitigation:** identical font binaries on both sides; `font-kerning`, `font-feature-settings`, `font-variant` pinned to match Typst's shaping settings; word-spacing imposed per line makes small disagreements absorb into justification rather than break-point changes; a startup **calibration pass** (render a shaping torture-test string, compare measured vs. oracle widths, warn/adjust if divergence exceeds threshold). Residual sub-pixel disagreement is invisible inside a justified line.
**Validation:** Milestone 0 includes a width-agreement test across the bundled fonts on Chrome/Firefox/Safari, Win/macOS/Linux. **If cross-engine disagreement proves large and unfixable, Tier B (positioned rendering) becomes the default and the architecture survives** — that's the fallback of record.

### 4.2 Frame-tree exporter

Everything depends on getting structured layout data out of Typst-WASM. Known-good facts: `Frame` is a public concept in typst-layout, all exporters consume it, spans are attached. Unknown: granularity of per-line justification data readily exposed (we need per-line adjustment, which lives in the inline layout's `Line` structures — may require exporting from a stage slightly earlier than final frames, or recovering per-line spacing from glyph positions in the final frame, which is always possible since glyph x-positions are explicit).

**Mitigation:** worst case, we recover everything from raw glyph positions (they're all in the frame tree); that path cannot be blocked, only less convenient.
**Validation:** Milestone 0.

### 4.3 The two-layout flicker

If optimistic echo and oracle layout disagree visibly, typing feels jittery.

**Mitigation:** the echo paragraph inherits its *current* oracle-assigned per-line spacing while going native (so it starts from the typeset state, not browser-default); corrections are applied without animation within one frame; a "settle" debounce (~120 ms after last keystroke) for applying *break-point* changes while spacing-only changes apply immediately. Tunable; this is a polish loop, not an unknown.
**Validation:** Milestone 2 has an explicit "typing feel" acceptance test (type a 500-word paragraph continuously; count visible reflow pops; target zero beyond the line being typed).

### 4.4 Selection/copy/a11y across generated structure

**Mitigation:** clipboard always serialized from PM doc; generated nodes aria-hidden and non-editable; screen-reader pass with NVDA/VoiceOver in Milestone 3. The precedent that this works: mpetroff's precalculated-line-breaks experiment used exactly this hidden-span technique with `aria-hidden` and `user-select:none` for screen-reader/copy safety.

### 4.5 Performance envelope

Budget for a 30-page document: compile < 10 ms incremental (Typst's own numbers), frame-tree serialization + translation < 10 ms for visible pages, DOM patch < 5 ms. Long documents rely on viewport prioritization and per-page DOM recycling.
**Validation:** Milestone 2 perf harness with 5/30/150-page corpora.

---

## 5. Technology choices (settled)

| Concern | Choice | Rationale |
|---|---|---|
| Layout oracle | Typst via typst.ts fork | Only fast open TeX-class engine with WASM + spans |
| Editing state | ProseMirror | Custom-view-friendly, mature, collab-ready ecosystem |
| Math input preview | KaTeX (popover only) | Instant feedback; final render is always Typst's |
| Code blocks | CodeMirror 6 embedded NodeView | Standard practice in PM apps |
| App shell | Vite + TypeScript, no heavy framework; Preact/Svelte only for chrome (toolbar/dialogs) if wanted | Editor core must own its DOM; frameworks fight that |
| Worker comms | Comlink or hand-rolled postMessage protocol with transferables | Keep frame-tree transfer zero-copy where possible |
| On-disk format | `.typ` (Typst markup) | Human-readable, git-friendly, ecosystem-compatible, free PDF path |
| Distribution | Static site (client-only) + later Tauri desktop wrapper | Zero infra cost; local files via File System Access API |

---

## 6. Milestones

**Milestone 0 — Oracle viability spike (the go/no-go).**
Fork typst.ts; add frame-tree JSON export; compile a fixed 3-paragraph document; in a bare HTML page, apply extracted breaks + word-spacing to DOM text; verify visual agreement with Typst's own SVG render; run cross-browser width-agreement tests. *No editor. Proves or kills the architecture.* Deliverable: a demo page + a written verdict on Tier A viability per browser.

**Milestone 1 — Static round-trip.**
PM schema for the v1 node set; serializer with position table; Typst-parse-to-PM import; oracle in a worker; translator renders a multi-page document with pages, margins, page numbers. Editing limited to plain typing in one paragraph. Deliverable: open a `.typ` file, see it typeset, type into it, watch it re-typeset.

**Milestone 2 — It feels like an editor.**
Optimistic echo + scheduling + stale-response discipline; full keyboard formatting, input rules, undo; lists, quotes, headings; typing-feel and perf acceptance tests pass. Deliverable: dogfood-able for real prose.

**Milestone 3 — The full v1 surface.**
Math popover flow; images + figure floats; footnotes; code blocks; raw-Typst escape-hatch blocks; PDF export; Markdown import; copy/paste correctness; a11y pass; Tier B print preview. Deliverable: public alpha, write a real lecture note end-to-end.

**Milestone 4 — Public open-source launch.**
Docs, template gallery (article/letter/notes), demo video (the pitch demo: type into a justified paragraph and watch TeX-quality breaks follow your cursor), landing page, GitHub launch.

Sequencing rationale: M0 front-loads the only true unknown. Everything after M0 is known-hard, not unknown-hard.

---

## 7. Open questions (tracked, not blocking)

1. Exact wire format for the frame tree (JSON first; flatbuffers if profiling demands).
2. Whether per-line data comes from `Line` structures or is recovered from glyph positions (M0 answers this).
3. Hyphen rendering: real `&shy;` vs. translator-inserted visible hyphen glyph (interacts with copy handling; M1).
4. How much of Typst `set`-rule styling (fonts, sizes, margins) to surface as document-settings UI in v1 vs. raw block only.
5. Name. (Working title "Typeset" is descriptive but likely ungoogleable/conflicted.)

---

## 8. Beyond v1 (the roadmap that justifies "professional project")

- **v2 — computational documents:** executable Python cells (Pyodide in a second worker), outputs (figures, tables) flowing into the typeset layout as first-class figures. This merges the notebook and the paper — the original two-sided motivation for this project — and is a genuine differentiator vs. both Overleaf and Jupyter/Marimo.
- **v2.x — citations & Zotero,** tables UI, tracked changes.
- **v3 — collaboration** (yjs), hosted service (storage, sharing, templates) as the sustainability model over the open core.

---

## 9. Summary of the argument

Typst already solved typesetting speed and quality and gave the result away under Apache 2.0, exposed as structured, source-mapped layout data compiled to WASM. Browsers already solved text *editing* — selection, IME, accessibility — but only for text that lives in the DOM. Every layout decision Typst makes is expressible as CSS on DOM text. Therefore the first true WYSIWYG typesetting editor is not a research project; it is a translation layer between two mature systems, plus product polish. Milestone 0 is small, sharply defined, and decisively tests the one real risk.
