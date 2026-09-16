# Plass

WYSIWYG editor with publication-quality typesetting. Named for Michael F.
Plass (Knuth–Plass line breaking); pronounced like "class".

## Commands

- `npm run dev` — dev server on 5199 (hardcoded in `vite.config.ts`, strictPort)
- `npm test` — node test suites (knuth-plass, typ-parser, md round-trip)
- `npm run build` — production build with host-independent relative paths (CI runs this);
  deploy = push `main`: `.github/workflows/deploy.yml` builds and
  publishes to plass.tayweid.io via GitHub Pages.
- PWA: `public/manifest.webmanifest` registers Plass as a file handler
  for .typ/.md (installed app = macOS default-app candidate; Finder
  launches arrive via `launchQueue` in `main.ts`, folderless — the
  toast offers `attachFolder`). `launch_handler: focus-existing` routes a
  launch to an existing Plass window instead of a blank new one; a window
  that already shows the launched file does nothing but come forward. No
  JS can focus another independent window (tested 2026-09-11: neither
  `window.focus()` on a message nor `window.open('', name)` with a click
  reaches a window this one did not open), so with several windows the
  launch lands in the last-focused one and says where the file is.
  Manifest edits need an app uninstall/reinstall in Chrome to propagate to
  the OS.

## Architecture (one renderer)

- **One renderer** (decided 2026-09-11). The page is laid out by the
  TypeScript port of Typst's breaker (version-pinned ICU/hyphenation/
  shaping via the Rust/WASM sidecar) and the local paginator (footnote
  reservations, widow/orphan rules, sticky headings, table rows). Nothing
  compiles while editing: Typst is the printer (PDF export) and the
  measuring stick, never a second opinion installed over the page. The
  oracle classes and the compiled-authority plumbing were removed
  2026-09-11; what remains of that code is the matcher the audit uses
  (`typst-oracle.ts`, `page-oracle.ts`).
- **The port audit is how exactness is measured.** `npm run audit`
  (tests/port-audit.spec.ts, `__audit()` in the plugin) compiles a document
  once and reports every block whose port breaks differ from Typst's and
  the first page start that differs; `AUDIT=<file-or-folder>` runs it on
  your own documents. It never runs in the edit loop and never blocks a
  deploy (CI runs it as a non-blocking step). What it finds are port bugs,
  fixed one at a time; the open list is in ROADMAP.md. Why: the
  whole-document compile used to be re-analyzed on the main thread after
  every pause (550–750 ms on a 33-page file — the typing lag), and its
  answers silently corrected the local paginator, hiding its bugs.
- A suffix-only paginator exists as development shadow telemetry (compared,
  never installed) — planned to become the live incremental path.
- Unsupported content (uncertified fonts, unrepresentable paragraphs) falls
  back to the legacy JS Knuth–Plass path and does not carry the exact-break
  guarantee. So does an uncertified *browser*: at startup
  `src/environment-check.ts` measures one prose run against the port's
  shaped width, and a disagreement beyond 0.4% (a browser hinting the
  bundled fonts) turns the exact path off for the session with a notice.
- The 2026-08-27 "single Typst publication" rebuild was reverted (fe94326);
  it lives on `codex/archive-proof-architecture`. Native editable tables were
  ported from it (merged 2026-09-02); executable Typst code cells still are
  to be.
- **Doctrine: document text must equal printed text.** Typst collapses
  space runs, reads `~` as nbsp, converts `--`/`---`/whitespace-`-`digit
  to en/em/minus, prints every unescaped `'`/`"` as a smart quote
  (`src/smart-quotes.ts` mirrors its quoter; a straight quote in the
  document exports escaped), and a footnote marker swallows the space
  before it (`HElem::hole()` in its show rule). Chrome writes a space
  typed against an inline atom as a lone nbsp (the editor's
  `white-space: normal` would collapse a plain trailing space); the
  normalizer recognizes that artifact by how it arrives (a typing
  transaction inserting exactly one nbsp, tracked in plugin state) and
  turns it into a space once a character follows it. An nbsp that came
  from a `~` in the file, or was pasted, is glue and stays. The importers and the
  edit-time normalizer (`src/collapse-spaces.ts`) keep the document in
  printed form. Any new Typst text shorthand must be handled the same way or the
  browser presentation and the compiled snapshot fight (visible as jitter).
- Vertical parity: editor block heights must match Typst's. CSS changes
  must not alter layout heights — paint-only shifts use `transform` or
  `box-shadow`; math atom advance = the Typst-exact compiled atom width
  (measured in Typst; atom widths are part of the block layout cache key).
  The paginator fits Typst FRAMES, not browser boxes: a frame runs from
  the cap top (`pageTopAdjustEm` below the box top) to the last baseline
  (`pageBottomInsetEm` above the box bottom), footnote entries included
  (`footnoteFrameInsetsEm`); fit tolerance is 0.1 px. Block spacing that
  Typst drops at a page top must live in the PREVIOUS block's margin-bottom
  or be dropped by `blockTopAdjustPx` (tables: `tableMarginsEm`; a list or
  quote at a page top lands by its first text block's cap top). Line k of
  a paragraph is at the paragraph's top plus k line-heights (never the
  caret box: Chrome rounds its height, and Typst's line pitch is exact).
  Block measures are fractional (`getBoundingClientRect`, never
  `clientWidth`): a 5.5in page less 0.6in margins is 412.8px.
- Headings are port-laid like paragraphs (bold base face, level scale,
  justified and hyphenated as Typst does); numbered headings are the
  exception (browser-laid, audit reads their breaks from the DOM).
- Lists mirror Typst's grid: body indent = the marker's shaped width +
  0.5em (enums: the widest label), published by the plugin as
  `--list-indent-N`/`--enum-indent-N` (`publishGeometryVars`,
  `list-indent.ts` sets `data-digits` on every `<ol>`); markers are
  painted out of flow. Never hard-code a list indent in CSS. Item pitch
  is the list's `tight` attr: tight = leading + 0.25em (`listSpacingEm`,
  the document's `#set list(spacing:)`), loose (blank lines between items
  in either format) = paragraph spacing, exported as a set/restore pair
  around the list; a paragraph followed by another block inside an item
  is at paragraph spacing.
  Code blocks (islands included) mirror Typst's raw block through
  `codeBlockMetricsEm` (`font-registry.ts`): DejaVu Sans Mono at 0.8em,
  line pitch = leading + raw top edge, padding/margin derived from the
  body font's metrics, published as `--code-line/--code-pad/--code-mb`.
- Tables are native editable trees (`table-editor.ts`), laid out locally
  and broken between rows with the header repeated (PAGE-PORT Phase 7);
  a compiled page start inside a table is matched row by row. Column
  sizing (`auto`, fractional shares, points) and uniform point padding
  are shared document attributes, exposed in Layout, serialized to Typst,
  and mirrored by `table-view.ts` / `table-geometry.ts`. They are the
  user-approved numeric exception to preset-only styling (2026-09-15).
- Grids (`grid-editor.ts`, 2026-09-11): `grid > grid_row > grid_cell`,
  any blocks in a cell, `columns` = fraction shares, `gutter` em; Typst
  `#grid` with `#set grid.cell(breakable: false)` in the parity header.
  Rows are atomic and the grid breaks between rows (`grid()` in the
  paginator → `atomic` per row). `GridCellView` normalizes every cell's
  box to the paragraph's frame slack (`blockFrameSlackEm`) with measured
  margins, so a row lands and fits like a paragraph (`blockTopAdjustPx`,
  `bottomInsetFor`; a later row's gutter is taken back at a page top like
  a table's margin). The audit matches a row cell by cell (`inner` units
  in page-oracle). Markdown: a ```typst fence the importer recognizes
  (`parseGridCall`). Off the rail (auto/fixed columns, spans, fills,
  differing gutters) → island.

## Product principle: Typst on rails

Plass supports a fixed set of constructs, not the Typst language. Three
tiers, always visible to the writer, never silent:

- **On rails** — headings, paragraphs, lists, math, figures, footnotes,
  tables, citations, toolbar settings. Edited directly, laid out live by the
  local mirror, measured against Typst by the port audit. Exact by contract.
- **Tolerated** — an island: unknown Typst in a `.typ` file (or typed in
  the source view), an HTML block or `<!-- comment -->` in a `.md` file.
  Kept verbatim in its file, never run. The page shows it as a code block
  tagged in the margin, and Plass's compile (PDF, the audit) prints the
  same code block (`docToTyp` with `islands: 'print'`), so page and print
  agree and nothing is hidden. `code_block` with `params` `typst-raw` or
  `md-raw`; `typst_inline` for inline Typst. Preservation, not an
  authoring path — there is no island rendering to extend.
- **Off** — multi-column, floats, custom show/set rules, hand-written layout
  code. Declined on purpose. A new capability is a new rail: local mirror +
  an audit fixture, one at a time (PAGE-PORT's phase discipline,
  generalized).

- **Editorial comments** (2026-09-16) — the one approved exception to "the
  page shows only printed content": an `editor_comment` node between
  top-level blocks (never nested; `(block | editor_comment)+` on the doc),
  plain text, shown as a full-sheet-width warm strip labeled "Comment ·
  Not printed" (`editor-comments.ts`/`.css`), kept in the working file
  (`.typ`: a `// plass:comment` … `// | line` … `// /plass:comment` frame;
  `.md`: a `<!-- plass:comment` … `-->` HTML comment with `&`/`--` escaped
  — `editor-comments-format.ts`), and absent from every rendered export
  (`docToTyp` with `islands: 'print'` returns nothing for it, TeX likewise).
  Zero printed height: the paginator subtracts each note's painted height
  when it recovers print geometry (`commentHeights` in the snapshot, keyed
  at the note's END position) and skips notes in its block walk, so no
  line break or page start moves; the displayed sheet holding a note grows
  by exactly the note's height (`layout/page-geometry.ts`: `PageInfo.pages`
  is per-sheet `top`/`height`, never `k * (pageH + gap)`; `printPageAt`
  maps a position to its PRINT page). A note follows the printed block
  before it; after an explicit page break it opens the new page. The
  audit skips notes (`buildUnits`, `canonicalStart`). Plain `//` remarks
  and plain HTML comments keep their old meanings (dropped; md-raw island).
  This authorizes no other hidden content, second renderer, or font
  substitution.

Consequences: styling ships as verified presets, with the numeric exception
for table column widths and uniform cell padding above. The source view
(SOURCE-VIEW.md) is a second editor for the SAME rails
(plain-text, iA Writer spirit, for simpler files), not a way to author
off-rails Typst — Typst typed there is kept but never runs;
failures are visible (an island, a declined exact map), never silent. Evaluate roadmap
items against this before scope.

## Testing gotchas

- Playwright tests: dynamic `import('/src/x.ts')` in `page.evaluate`
  creates a SECOND module instance with unwired state — false failures.
  Drive the app's own instances: `window.view`, `__fm`, `__audit`,
  `__pagLog`. Wait for pagination with `settleLocal` (tests/settle.ts): the
  first pass after a load can run before the port and fonts are up.
- Paper: named sizes export as `paper:`; half letter and a custom size as
  `width:`/`height:` (`paperInches`). Footnote numbering (`1 a i *`) and
  the separator (`rule | full | none`) are settings: `footnoteLabel` paints
  and measures the marker, the reservation drops the rule's height.
- Page chrome (number, running header/footer with `{page}`/`{section}`)
  is painted by `renderPages` in main.ts and measured by the audit: Typst's
  margin lines (by position) against the painted `#pages .page-num`
  elements (`chromeMismatch`). A running text replaces the automatic
  number on its edge; `{section}` is the last level-1 heading on an
  EARLIER page (a heading opening the page is after the header's
  location in Typst).
- Typst's `...` prints as an ellipsis, like `--` prints as an en dash: the
  importers and the normalizer hold `…` (`printedForm` in
  `collapse-spaces.ts`).
- Internal storage keys keep the old "typeset" names on purpose
  (`typeset-doc-v1`, IDB `typeset-files`, session keys) — renaming
  orphans users' sessions and recents.
- Editor appearance (`src/appearance.ts`, 2026-09-16): Settings →
  Appearance, Standard / Warm paper. A device preference under
  `typeset-appearance`, painted as `:root[data-appearance]` before the
  editor mounts; `style.css` tokens only (`--sheet`, `--ink`, `--ink-soft`,
  which every document-ink rule now reads), restored to the publication
  palette under `@media print`. It dispatches no transaction, changes no
  width or metric, and exports nothing. Document fonts are not part of it:
  a warmer face is a certification job (`font-registry.ts`; TeX Gyre
  Pagella is the bundled candidate), never a browser-only substitution.

## Formats

- `.typ` is the native serialization (`typ-serializer`/`typ-parser`;
  unknown Typst survives as raw islands — never destroy content).
- `.md` open/edit/save (`md-parser`/`md-serializer`, markdown-it):
  pure markdown, no app metadata in frontmatter (standard
  title/author/date only; settings are .typ territory). ```typst fences
  are raw islands; ```bibtex is the embedded bibliography. Markdown the
  page cannot render is carried, never stripped: HTML blocks (editorial
  `<!-- comments -->`, `<div>`s) become `md-raw` islands — a code block
  in the page and the print, verbatim on save; frontmatter lines with no
  Plass field ride in `doc.attrs.frontmatter`. A `.typ` save writes the
  island as a plain raw block and has no home for the frontmatter.
- `.tex` export is semantic (journals reformat); `.pdf` via Typst.
  Editorial comments are in both editable files and in neither export.

## Working style

- Discuss material architecture or product-scope changes before implementation.
- When a bug is reported: reproduce it in a scripted browser first,
  diagnose, then fix. Verify fixes the same way.
- Keep the editor usable between focused commits; development tabs reload on
  watched-file changes.
- A push to `main` deploys only after the complete verification workflow passes.
