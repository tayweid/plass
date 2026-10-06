# Plass

WYSIWYG editor with publication-quality typesetting. Named for Michael F.
Plass (Knuth–Plass line breaking); pronounced like "class".

## Commands

- `npm run dev` — dev server on 5199 (hardcoded in `vite.config.ts`, strictPort)
- `npm test` — every `src/**/*.test.ts` suite, found by
  `scripts/run-unit-tests.ts` and run one at a time (a new suite registers
  by existing; the four layout-port suites are `npm run test:layout`)
- `npm run test:parity` — the pandoc content referee
  (`src/md-parity.test.ts`) on `tests/fixtures/md`; needs pandoc 3.4
  (`$PANDOC`, `pandoc` on PATH, or Quarto's). `npm test` runs the same
  suite but skips it when there is no pandoc; `test:parity` sets
  `PANDOC_REQUIRED=1`, which makes that a failure. CI installs pandoc 3.4.
  `node --import tsx scripts/pandoc-parity.ts <file-or-folder>` runs the
  comparison on the course corpus.
- `npm run build` — production build with host-independent relative paths (CI runs this);
  deploy = push `main`: `.github/workflows/deploy.yml` builds and
  publishes to plass.tayweid.io via GitHub Pages.
- Plass.app (Mac; `docs/CLAERBOUT-SHELL.md`): the vite build inside the
  Claerbout Electron shell, the shell Knuth ships on (`github.com/tayweid/
  claerbout`, one tag for every app; the deploy clones it at
  `CLAERBOUT_TAG`). `app/plass.json` configures it: no Python, the page
  from `dist/` under `plass://app/`, `openBy: "drop"`, `autosave: true`
  (the shell keeps a git record of every project a window is on, on a
  `claerbout-autosave` branch; the page tells it the window's file,
  `reportDocument` in `src/claerbout.ts`; `docs/CLAERBOUT-SHELL.md`,
  OPEN, and knuth's `docs/AUTOSAVE.md`). The window is
  Chromium, so files go through the File System Access API exactly as in
  a browser tab, and a handle stored in IndexedDB reopens after a relaunch
  because the shell's permission handler grants what the page holds. A
  Finder open arrives as `?open=<path>`; once the page sends `ready`, the
  shell drops the file on it and the page holds a real handle
  (`src/claerbout.ts`). Every Finder open lands in a new window (the
  shell cannot know which window holds which file); one for a file
  another Plass.app window already shows fronts that window and closes
  itself (`openLaunched` in `main.ts`: the holder asks the shell's
  `focus` request for itself over `open-files.ts`; under a shell older
  than 0.2.1, which answers null, the toast stays). Closing a window with
  unsaved work (⌘W, the red button, ⌘Q for each window in turn, an
  update's relaunch) asks, on shell 0.2.8: the page reports what closing
  would cost (`unsaved`, `unsavedReporter` in `src/claerbout.ts`) and
  answers the shell's `save {reason: 'close', choose}`; a file's pending
  edits are written quietly, a never-saved document gets the shell's Save
  / Don't Save / Cancel sheet with the first save's folder picker behind
  Save, a file changed outside Plass is never written over (no Save), and
  a blank never-saved sheet closes without asking. The page never
  registers `beforeunload` in the shell (Electron would refuse the close
  without a word); a browser tab gets Chrome's "Leave site?" instead
  (`docs/CLAERBOUT-SHELL.md`, OPEN). `npm run app` runs
  the shell from the checkout (needs `dist/` and the `claerbout` checkout
  beside this one, or `CLAERBOUT_SHELL`); `npm run app:build` packages
  and installs it (`--zip`, `--arch`, `--web` pass through to the shell's
  packager); `npm run app:smoke` drives the built app with Playwright
  `_electron` (open, typeset, ⌘S, a second open of the file fronts the
  window that has it); `npm run app:install-script` renders
  `public/install` from the shell's template. Log:
  `~/Library/Logs/Plass.log`. The window is any size, and it is the
  zoom: one panel under the bar and right of the rail is the paper, the
  bar and the rail being a dark frame that shows as one thin edge round
  it, its corners rounded only where they are a sheet's (the first
  page's top, the gaps, the last page's bottom; square where the paper
  runs on), with the shadow drawn round the paper in view (Zen's shape,
  the frame in `src/style.css`; the bar is
  Knuth's — File, the name pill with its save dot and folder, in
  Plass.app the History tile (the shell's History page laid over the
  panel in the same window, one toggle with File › History… and the
  shell's View › History…, pressed while it is up; the same tile and glyph
  as Knuth's), then Export —
  beside the traffic lights, the rail the tools, `docs/ZEN-DRAFT.md`). The pages fill the panel's width by scaling,
  never by re-flowing: they are laid out at their own width (816 CSS px
  for Letter) and drawn at the panel's by a transform on `#stack`
  (`src/paper-scale.ts`), so a wider window draws a larger page and the
  layout never runs for a resize or a zoom; a layout read of page
  geometry goes through `atPaperSize`, which takes the transform off for
  the read, and a pass runs through `paperPass`, which holds a followed
  caret still on the screen (the panel has no browser scroll anchoring);
  the shadow's box and corners are CSS variables the same file writes in
  the frame after a scroll, from the sheets the painter laid
  (`paperSheets`) and the panel's scroll offset, reading no page
  geometry.
  On shell 0.2.1 (`followZoom` in `app/plass.json`) a zoom
  step scales the window with it, which is just a wider window. While the
  paper runs past the panel in the page view (one sheet or many), the
  frame at the panel's right is a 20 px gutter (`--edge-right`, the one
  right-margin variable the panel, its shadow, the HUD and `--axis` read) holding the
  scroll rail (`src/scroll-rail.ts`): the paper's page breaks, headings,
  figures, tables and caret as marks placed from the settled pass, the
  visible span as a band, a hover label, click, drag, wheel and keys; the
  page is drawn about 1 % smaller while it is there, and a paper that
  fits the panel or the source view keeps the 8 px edge. The tests'
  window is 880 px wide (`playwright.config.ts`), where a paper with the
  gutter is drawn at 1:1. With a shell
  past v0.2.0, `app/plass.json`'s `titleBarStyle: "hiddenInset"` makes
  the bar the window's title bar beside the traffic lights; the page
  learns the lights' room from the Window Controls Overlay
  (`env(titlebar-area-x)`), nothing from the shell (`docs/
  CLAERBOUT-SHELL.md`, OPEN). The deploy's `app` job (macos-15) packages
  both processors from the verified `dist`, installs through the install
  line, smoke-tests, and publishes `app/Plass-<arch>.zip` and
  `app/Plass.app.zip` beside the site; if it fails, the site still deploys
  and keeps the live zips. The Swift/WKWebView shell it replaced was
  retired 2026-09-30 (git history has it).
- PWA: `public/manifest.webmanifest` registers Plass as a file handler
  for .typ/.md (installed app = macOS default-app candidate; Finder
  launches arrive via `launchQueue` in `main.ts`, folderless — the
  toast offers `attachFolder`). `launch_handler: focus-existing` routes a
  launch to an existing Plass window instead of a blank new one; a window
  that already shows the launched file does nothing but come forward. No
  JS can focus another independent window (tested 2026-09-11: neither
  `window.focus()` on a message nor `window.open('', name)` with a click
  reaches a window this one did not open), so with several windows the
  launch lands in the last-focused one and says where the file is. (In
  Plass.app the shell fronts a window on that window's own request, so
  there the window that has the file comes forward instead; above.)
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
- **Math is LaTeX in the document and native Typst in print**
  (2026-10-05). `src/math-convert.ts` converts each formula locally with
  mitex 0.2.7's own translator, bundled as `src/mitex/mitex.wasm` and
  digest-checked on load; `src/typst-math-prelude.ts` defines the handles
  the converted math names. The PDF, the audit's compile, math ink and
  Export → Typst all print `$…$`; the compiler resolves no package and
  fetches nothing. Only the legacy `.typ` save keeps `#mi`/`#mitex` and
  the mitex import, so those files reopen exactly. Typst stays 0.14.2. A
  formula the converter rejects fails by name (outlined on the page,
  refused by the export).
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
  A formula without that width (Typst rejected it: `failed`; the compiler
  could not run it — timeout, paused circuit: `deferred`, retried at the
  next circuit epoch; not loadable: retried after the next good compile) is outlined `.math-unmeasured` on the page and listed
  by the audit (`unmeasured`). Read widths through `inkKeyFor` (bold key).
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
  Enter on an empty item exits the list (`src/list-enter.ts`): the
  paragraph and whatever blocks follow it in the item leave the list one
  level up, cutting it in half, and a lifted sub-list of the second
  half's type joins it. Two adjacent lists reopen as ONE loose list in
  both formats, and a `.md` save drops an empty paragraph between them
  (an untouched gap reopens as one loose list; `.typ` keeps it as `~`).
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
  in page-oracle). Markdown: one `::: {.columns gutter=…}` div per row
  of `::: {.column width=…%}` cells, later rows marked `.continued`. A
  `.typ` `#grid` is read by `parseGridCall`; off the rail (auto/fixed
  columns, spans, fills, differing gutters) → island.

## Product principle: Typst on rails

Plass supports a fixed set of constructs, not the Typst language. Three
tiers, always visible to the writer, never silent:

- **On rails** — headings, paragraphs, lists, math, figures, footnotes,
  tables, citations, toolbar settings. Edited directly, laid out live by the
  local mirror, measured against Typst by the port audit. Exact by contract.
- **Tolerated** — an island: unknown Typst in a `.typ` file (or typed in
  the source view); in a `.md` file a ```` ```{=typst} ```` block or
  `` `…`{=typst} `` span, an HTML block, inline HTML, or a div whose class
  is not a rail. Kept verbatim in its file, never run. The page shows it
  as a code block tagged in the margin, and Plass's compile (PDF, the
  audit) prints the same code block (`docToTyp` with `islands: 'print'`),
  so page and print agree and nothing is hidden. `code_block` with
  `params` `typst-raw` or `md-raw`; `typst_inline` (`lang` `typst` or
  `html`) for an inline one. Preservation, not an authoring path — there
  is no island rendering to extend.
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
  `.md`: every HTML comment is one, written plainly with `-->` escaped as
  `--&gt;`, the old `<!-- plass:comment` frame still read —
  `editor-comments-format.ts`; a comment the `.md` reader finds inside a
  block (a div, list item, quote, cell or footnote, or mid-paragraph) is
  hoisted to the nearest top-level boundary, with one warning per file),
  and absent from every rendered export
  (`docToTyp` with `islands: 'print'` returns nothing for it, TeX likewise).
  Zero printed height: the paginator subtracts each note's painted height
  when it recovers print geometry (`commentHeights` in the snapshot, keyed
  at the note's END position) and skips notes in its block walk, so no
  line break or page start moves; the displayed sheet holding a note grows
  by exactly the note's height (`layout/page-geometry.ts`: `PageInfo.pages`
  is per-sheet `top`/`height`, never `k * (pageH + gap)`; `printPageAt`
  maps a position to its PRINT page). A note follows the printed block
  before it; after an explicit page break it opens the new page. The
  audit skips notes (`buildUnits`, `canonicalStart`). A plain `//` remark
  in a `.typ` keeps its old meaning (dropped).
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

## Formats

- `.md` is the source of truth and the default (a new document is
  Markdown; `docs/MARKDOWN-SOURCE-PLAN.md`). The format is Pandoc
  Markdown as `docs/MARKDOWN-FORMAT.md` specifies, read by `md-parser`
  (markdown-it, plus `md-divs`, `md-attrs`, `md-tables`) and written by
  `md-serializer`; pandoc is the content referee (`npm run test:parity`),
  never a renderer. YAML front matter carries the settings
  (`md-frontmatter`): pandoc's names where pandoc has one (`papersize`,
  `margin`, `fontsize` …), the rest under `plass:`; keys Plass does not
  read ride along in `doc.attrs.frontmatter`. Fenced divs carry the rails
  Markdown has no syntax for: `::: solution`; a grid as one `::: columns`
  div per row of `::: column` cells, later rows `.continued`; `::: center`,
  `::: right`, `::: keep` around one paragraph; `::: {.table …}` around a
  pipe table. Every HTML comment is an editorial comment (nested ones
  hoisted to top level on read). ```` ```{=typst} ```` and
  `` `…`{=typst} `` are the hatch: kept verbatim, printed as code, never
  run; any other div or an HTML block is carried the same way as an
  `md-raw` island, inline HTML as an inline one. ```` ```typst ```` and ```` ```bibtex ````
  are code listings. The bibliography is a ```` ```{=bibtex} ```` fence
  at its position; a `bibliography:` key is read once, when the folder is
  open, and the next save embeds it as the fence (until then the key is
  kept).
- `.typ` is an export (Export → Typst: the source Plass compiles, native
  math, no package, comments left out; for compiling, not reopening).
  Until the course corpus is converted (plan step 12), a legacy `.typ`
  still opens and autosaves as `.typ` (`typ-parser`/`typ-serializer`
  'file' mode; unknown Typst survives as raw islands — never destroy
  content); step 13 makes it import-only. A `.typ` save has no home for
  the Markdown front-matter carry.
- `.tex` export is semantic (journals reformat); `.pdf` via Typst.
  Editorial comments are in both editable files and in neither export.

## Working style

- Discuss material architecture or product-scope changes before implementation.
- When a bug is reported: reproduce it in a scripted browser first,
  diagnose, then fix. Verify fixes the same way.
- Keep the editor usable between focused commits; development tabs reload on
  watched-file changes.
- A push to `main` deploys only after the complete verification workflow passes.
