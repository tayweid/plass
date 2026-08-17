# Plass

WYSIWYG editor with publication-quality typesetting. Named for Michael F.
Plass (Knuth–Plass line breaking); pronounced like "class".

## Commands

- `npm run dev -- --port 5199` — dev server (tests assume 5199)
- `npm test` — node test suites (knuth-plass, typ-parser, md round-trip)
- `npm run build` — production build with host-independent relative paths (CI runs this);
  deploy = push `main`: `.github/workflows/deploy.yml` builds and
  publishes to plass.tayweid.io via GitHub Pages.
- PWA: `public/manifest.webmanifest` registers Plass as a file handler
  for .typ/.md (installed app = macOS default-app candidate; Finder
  launches arrive via `launchQueue` in `main.ts`, folderless — the
  toast offers `attachFolder`). Manifest edits need an app
  uninstall/reinstall in Chrome to propagate to the OS.

## Architecture (oracle layout)

- The Typst compiler (WASM, `src/pdf.ts`) is the truth. A TS port of
  Typst's line breaker (`src/layout/port/` + Rust sidecar in `sidecar/`)
  computes identical breaks live while typing; the compiled oracle
  verifies. A page oracle (`src/layout/page-oracle.ts`) supplies page
  breaks; between answers, mapped "page marks" hold geometry steady.
- **Doctrine: document text must equal printed text.** Typst collapses
  space runs, reads `~` as nbsp, converts `--`/`---`/whitespace-`-`digit
  to en/em/minus. The importer and the edit-time normalizer
  (`collapseSpaces` in `src/editing.ts`) keep the document in printed
  form. Any new Typst text shorthand must be handled the same way or the
  live breaker and the oracle fight (visible as typing jitter).
- Vertical parity: editor block heights must match Typst's. CSS changes
  must not alter layout heights — paint-only shifts use `transform`;
  math atom advance = ink width exactly (see `makeAtomWidth`).
- Tables split across pages Typst-natively. `table-split.ts` runs a paged
  mini-compile of the table (same width, page content height, and a #v
  offset standing in for content above it) — under identical constraints
  Typst picks the same split rows, repeated `table.header`s and all. The
  node view shows the compile's pages as CSS crops of one SVG; the page
  oracle represents mid-table page starts (unit 'table'), and the forced
  paginator fails the result if the fragment count disagrees. NOTE: the
  .typst-page groups' rects are INK extents, not page areas — page
  boundaries come from i × page-height (the SVG stacks pages gaplessly).

## Testing gotchas

- Playwright tests: dynamic `import('/src/x.ts')` in `page.evaluate`
  creates a SECOND module instance with unwired state — false failures.
  Drive the app's own instances: `window.view`, `__fm`, `__oracle`,
  `__pageOracle`, `__pagLog`, `__comparePort`, `__portStats`.
- Internal storage keys keep the old "typeset" names on purpose
  (`typeset-doc-v1`, IDB `typeset-files`, session keys) — renaming
  orphans users' sessions and recents.

## Formats

- `.typ` is the native serialization (`typ-serializer`/`typ-parser`;
  unknown Typst survives as raw islands — never destroy content).
- `.md` open/edit/save (`md-parser`/`md-serializer`, markdown-it):
  pure markdown, no app metadata in frontmatter (standard
  title/author/date only; settings are .typ territory). ```typst fences
  are raw islands; ```bibtex is the embedded bibliography.
- `.tex` export is semantic (journals reformat); `.pdf` via Typst.

## Working style

- Discuss material architecture or product-scope changes before implementation.
- When a bug is reported: reproduce it in a scripted browser first,
  diagnose, then fix. Verify fixes the same way.
- Keep the editor usable between focused commits; development tabs reload on
  watched-file changes.
- A push to `main` deploys only after the complete verification workflow passes.
