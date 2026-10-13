# Diagrams: a CeTZ rail (plan)

Plan, 2026-10-13. Not approved; nothing built. Taylor's decisions come
first, then the phases.

## What it is

A diagram block. You write CeTZ drawing code, the page shows the picture
Typst draws from it, and the PDF prints that same picture. CeTZ is Typst's
drawing package, modeled on TikZ; cetz-plot adds axes and function plots.
Data plots stay in Python. This is for sketched diagrams: supply and
demand, budget lines, game trees, timelines, labeled arrows.

Why it fits the rails:

- **Typst draws the picture on the page.** Math already works this way:
  each formula is compiled to SVG in the background worker
  (`src/math-ink.ts`). The page and the PDF show the same Typst output, so
  the drawing is exact by construction.
- **To the page layout, a diagram is one unbreakable box of known height**,
  like an image. Nothing breaks into lines and nothing flows around it. The
  paginator already handles that case (`atomic()`, `typeset-plugin.ts:3247`).
- **The audit only has to check size and spacing:** the box's height and
  the gaps above and below it.

## Doctrine changes (need Taylor's yes)

1. **Code the writer types runs, but only inside a diagram block and only
   as a drawing.** Islands still never run. "Hand-written layout code"
   stays off: diagram code cannot reach the page, the text or another
   block (see Containment).
2. **The compiler resolves exactly three packages, pinned by hash:** cetz
   0.5.2, its helper oxifmt 1.0.0, and cetz-plot 0.1.4. Every other import
   is still refused, and nothing is fetched from the network. This changes
   `SECURITY.md` ("The compiler resolves no Typst package"),
   `src/security.test.ts:147-154`, and `tests/security.spec.ts:232-283`.
3. **Block chrome (the left-margin pill) extends to diagrams.**

## Decisions for Taylor (with recommendations)

1. **Markdown form.** Store a diagram as a fence tagged `cetz` that holds
   only the drawing commands; Plass adds the import and canvas lines.
   Other Markdown tools show the fence as a code listing, so nothing is
   lost there. Recommend: yes.
2. **Size.** Draw each diagram at its natural size: 1 unit = 1 cm,
   adjustable per diagram. No "60% width" scaling, because scaling would
   also shrink the labels below the document's text size. When a drawing
   is wider than the text column, the margin says so. Recommend: yes.
3. **A broken diagram at PDF time.** One Typst error stops the whole PDF,
   so export refuses and names the diagram and its page. On the page, the
   last good picture stays, marked out of date, with the error beside it.
   Recommend: yes.
4. **LaTeX export.** First, write a visible placeholder and a warning.
   Later, write each picture as a PDF file beside the `.tex`. Recommend:
   placeholder first.

## Containment

The writer's code is never pasted into the Typst source as text. It is
passed as a string and evaluated as code, with only CeTZ's drawing
functions in scope. Roughly:

`cetz.canvas(length: …, eval(source, mode: "code", scope: draw))`

Pasted text could close the canvas early and start page-level code; a
string cannot. Imports inside it still meet the three-package allowlist,
and the worker has no files beyond the snippet and no network. Math is
held the same way (`src/security.test.ts:163-185`). Phase 0 proves that
`eval` works with CeTZ's and cetz-plot's functions in scope.

## Phases

Each phase leaves the editor usable and ends with its proof passing. One
at a time.

### Phase 0: prove it in the browser (small)

- **Vendor the three package tarballs.**
  - Size: about 297 KB as shipped, about 1 MB unpacked. That includes CeTZ's
    343 KB WebAssembly helper (`cetz_core.wasm`), which Typst runs inside
    its own interpreter.
  - Store them under `public/typst-packages/`, SHA-256 pinned like
    `mitex.wasm` (`src/math-convert.ts:23-26`).
- **Worker registry.** Replace `fetchPackageBy(accessModel, () =>
  undefined)` (`src/typst-compiler.worker.ts:161-172`) with a registry that
  answers only those three name@version pairs, from bytes loaded in
  advance.
  - The hook is synchronous, so the worker fetches the tarballs before the
    first diagram task: same origin, `redirect: 'error'`, size-bounded.
  - The fetch is lazy, so a document with no diagram downloads nothing.
- **Prove containment** (above).
- **Measure in Chrome and in Plass.app:** the first compile, an edit to a
  small diagram, and an edit to a large one.
  - Already measured in Node with the app's own compiler binary:
    | Case | Time |
    |---|---|
    | First compile | about 160 ms |
    | Edit to a small diagram | 6–7 ms |
    | Edit to a 200-element diagram | about 1.1 s |
  - Not yet run in a browser tab.
- **Licenses.** cetz and cetz-plot are LGPL-3.0-or-later.
  - Ship the tarballs unmodified as separate files. That keeps them
    replaceable, which the LGPL asks for.
  - Include the LGPL and GPL texts, plus a pointer to the `cetz-core` Rust
    source at the v0.5.2 tag.
  - Add a notices generator to `npm run verify:licenses`.
  - This is a research reading, not legal advice.
- **Exit:** a development-only call compiles a sample diagram and a plot
  in the browser, and the security tests pass with the new allowlist:
  - cetz resolves;
  - any other package or version is refused;
  - no request leaves the origin;
  - islands still never compile.

### Phase 1: the diagram block (the rail itself)

- **Schema.** A `diagram` node: block, atom, attributes `source` (the
  drawing commands) and `unit` (default 1 cm).
  - Add it to `ELIGIBLE_BLOCK_TYPES` (`src/layout/pagination-suffix.ts:96-118`).
  - Add it to every switch that handles `figure` (Appendix).
- **Formats.**
  - `.md`: a ```` ```cetz ```` fence reads and writes as a diagram
    (`md-parser.ts:2282-2299`, `md-serializer.ts:650-659`). Add an entry to
    `docs/MARKDOWN-FORMAT.md`.
  - `.typ`: file mode writes readable Typst that compiles anywhere:
    `#import "@preview/cetz:0.5.2"` in the header and
    `#align(center, cetz.canvas({ import cetz.draw: * … }))` in the body.
    - Today any import other than mitex ends the parser's header pass
      (`typ-parser.ts:120,262`). The header must accept the two imports.
    - The parser must recognize that exact wrapper. Anything else stays an
      island.
- **Drawing on the page:** `src/diagram-ink.ts`, modeled on `math-ink.ts`.
  - Compile a standalone snippet: a page sized to its content, then
    `parityRules` and `textSetLine`, then the contained canvas. The two
    rule calls give labels the document's font and size, as
    `citations.ts:83-86` does.
  - Cache by source, unit, font, size and package versions. An edit
    elsewhere never recompiles a diagram.
  - Mount the SVG through `sanitizedTypstSvg`.
  - Set the box height from the SVG viewBox in fractional px, never from
    the rounded width/height attributes. The paginator's DOM read then
    equals Typst's height.
- **Typing.**
  - Compile after a pause of about 150 ms. Only the newest source per
    diagram stays queued.
  - Diagram tasks get their own short deadline, about 5 s. A timeout marks
    that diagram "too slow to draw" without opening the circuit that math
    depends on (`src/compiler-circuit.ts`).
  - Diagrams and math share one worker. A slow diagram (about 1 s) delays
    math by the same amount, which is acceptable at first. Add a second
    worker if it bites.
- **Print.** `docToTyp` adds the package import to the preamble next to
  the math prelude (`typ-serializer.ts:1029`), and prints the same
  contained canvas the page compiled.
- **States the writer can see:**
  - Drawing: on first load, a placeholder box.
  - Drawn.
  - Error: the last good picture stays, marked out of date, with the error
    in the margin.
  - Too wide: a note in the margin.
- **Pinned in this phase.**
  - The print form is a centered block.
  - The space above and below is calibrated against Typst the way
    `tableMarginsEm` is.
- **Proof.**
  - Audit fixtures: a diagram mid-page, one that does not fit and moves to
    the next page, one at a page top, and one with many labels.
  - Diagram units in the audit match by position, not by text. Today
    `page-oracle.ts:170` treats a figure as an opaque unit that consumes
    text lines up to the next paragraph's first two words, and a label
    could match those words.
  - A new check: each diagram's height on the page equals Typst's frame.
  - Round-trip tests for `.md` and `.typ`.

### Phase 2: editing it (the headache part)

- **Edit panel.** The block pill gets a diagram tile, "Edit drawing", that
  opens a panel beside the page, outside `#paper`, so it moves nothing.
  - The panel shows the code with line numbers.
  - Typst's error points at its line.
  - The page redraws as you type.
- **Starters,** so nobody begins from a blank canvas: supply and demand, a
  budget line with an indifference curve, a shaded area between curves, a
  function plot (cetz-plot), a game tree, a timeline, boxes and arrows.
  Each is a short, commented snippet meant to be edited.
- **Insert menu:** Diagram, then choose a starter.
- **Source view:** the fence shows as text, and editing it there redraws
  the picture too.
- **Proof:** a Playwright spec types in the panel and checks that the
  picture updates and no other block moves. It also checks an error and
  its fix.

### Phase 3: figures with captions

- **A figure can hold a drawing instead of an image file.** `figure` gains
  a `diagram` attribute that excludes `src`, so these carry over unchanged:
  - the caption;
  - the label;
  - "Figure N";
  - `@fig:` references;
  - the figure's page layout.
- **Formats.**
  - `.md`: a fenced div `::: {#fig:market}` holding the `cetz` fence and a
    caption paragraph. This is the same div syntax the columns rail uses.
  - `.typ`: `#figure(cetz.canvas(…), caption: […]) <fig:market>`.
- **Proof:** an audit fixture with a captioned diagram figure and a
  reference to it.

### Phase 4: authoring aids

- **Coordinates and grid.** Hovering the picture shows coordinates in
  diagram units, and a click copies the point into the code. A grid
  overlay can be toggled. All paint only.
- **LaTeX math in labels.** Plass math is LaTeX everywhere else, but CeTZ
  labels take Typst math: `$Q^*$` works in both, `\frac` does not. A
  `tex("…")` label helper, converted by mitex before compiling, would keep
  one math language. Decide when this phase starts.

## Parked

- Dragging points on the page to edit the numbers in the code.
- **fletcher** (arrow-and-node diagrams): it pins CeTZ 0.3.4, which means
  a second copy of CeTZ and a known bug when the two are mixed. Revisit
  when fletcher 0.6 targets CeTZ 0.5.
- Shared styles for every diagram in a document (a diagram preamble).
- Importing TikZ.
- Data plots, which stay in Python.

## Appendix

### Files that switch on `figure`

A new block type touches these too:

- `equations.ts:41,121,179`
- `ref-autocomplete.ts:71`
- `scroll-rail.ts:82,304`
- `tex-serializer.ts:264`
- `md-skeleton.ts:500,1053,1254`
- `pdf.ts:111`
- `file-manager.ts`
- `layout/page-parity.ts:59`
- `layout/pagination-suffix.ts:96`

### Package facts (checked 2026-10-13)

- **CeTZ 0.5.2 is the newest release.** It needs Typst 0.14.0, and Plass
  runs 0.14.2.
- **cetz-plot 0.1.4 imports exactly cetz 0.5.2,** so only one copy is
  loaded.
- **typst.ts 0.7.0 runs Typst WebAssembly plugins** through wasmi, verified
  in Node with Plass's own compiler binary. Not yet verified in a browser
  tab (Phase 0).
- **Cost grows with element count:** many named anchors is the slow case.
