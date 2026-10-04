# Pandoc Markdown as the on-disk source: the plan

Date: 2026-10-04, revision 3 (Taylor approved the proposed answers on
2026-10-04: 1–10 as proposed, 7 amended to make native-Typst math a
required final step, 11 pending). Rewritten to match
`docs/MARKDOWN-SOURCE-BRIEF.md` (the governing decision; where this file
and the brief disagree, the brief wins, and the three places this plan
asks to depart from it are marked **departure**). Reviewed against the
working tree at `b8148de` with seven subsystem maps of `src/`, `tests/`,
`scripts/`, `app/` and the docs, then put through a six-lens adversarial
review whose 51 confirmed findings are folded in below. Probes ran on
pandoc 3.4 (Quarto's binary at `/Applications/quarto/bin/tools/aarch64/
pandoc`), typst 0.15.1 (Homebrew), typst 0.14.2 (the in-app compiler's
version, as the official release binary), markdown-it 15.0.2 (the reader
Plass uses) and Plass's own `mdToDoc`/`docToTyp`. Every pandoc, markdown-it
and mitex claim below was run, not asserted.

Status: a plan. Nothing in it is implemented. Phase 2 implements it with
worktree-isolated subagents, one per step, each adversarially reviewed
before merge, with the merge gate below green after every merge. Commit
locally only; never push; no attribution lines in commits.

Repo state to repair first (a review agent ran a merge simulation in the
real checkout): `main` carries one stray commit `140086c` that appends a
nonexistent `src/md-divs.test.ts` to the `npm test` chain (so `npm test`
is red at HEAD), and four empty branches exist. Taylor runs
`git reset --hard b8148de` (the two untracked docs survive) and
`git branch -D step-md-divs step-md-frontmatter step-md-skeleton
step-md-tables`. Nothing was pushed; identity and config are intact.

## The decision, restated

Pandoc Markdown is the on-disk source of truth. The document model
(`schema.ts`), the Typst serializer (`typ-serializer.ts`, which does not
change what it emits apart from the mitex pin and one deleted
Markdown-only helper), the compiler worker, the paginator and the port
audit do not change. The pipeline is

    .md on disk -> mdToDoc -> doc model -> docToTyp -> Plass compiler -> PDF

The `.typ` is an export (Export → Typst). **Departure, bounded:** until
step 12 has converted the course corpus, an opened `.typ` still autosaves
as `.typ` (the brief says the `.typ` is "never the file anyone edits");
step 13 ends that and is a required step sequenced after step 12. The
`.typ` reader stays as an importer throughout.

The three principles hold as written in the brief: pandoc is the
language and Typst the renderer; pandoc is a content referee
(`pandoc -t json` against `mdToDoc`), never a renderer, and there is no
Lua filter; content parity and visual parity are two different things
and only the first changes here.

## What this rewrite changes from the first review

- No Lua filter and no pandoc PDF compile. The referee is the JSON
  skeleton comparison only. Bare pandoc cannot compile a document with
  `@eq:x` references, so a PDF smoke would fail on most real files.
- No raw-Typst fallback for tables. Everything a pipe table cannot say is
  an attribute on a `::: {.table …}` div, including cell fills, spans,
  row rules and decimal columns. The one thing dropped is the `params`
  attr (verbatim `#table` arguments only the `.typ` importer produces):
  a `.md` save warns and drops it.
- The exported-`.typ` math question is answered with evidence (below).
  The brief's premise that mitex's converter output is native Typst is
  only half true.
- Fences follow pandoc's spelling: ```` ```{=typst} ```` is the hatch,
  ```` ```typst ```` is a code listing, ```` ```{=bibtex} ```` is the
  bibliography, ```` ```bibtex ```` is a code listing. No transitional
  reading. The ground is pandoc's semantics plus the facts on disk: the
  course folder (466 `.md`) holds no ```` ```typst ```` fence, and the
  only three such fences under `~/Projects` hold `#pagebreak()` or a
  `#text` block, which Plass already reopens as islands today (the
  brief's "no back-compatibility" sentence is scoped to `.typ`, so this
  is argued on its own grounds, not borrowed from it).
- Blank lines are always written around `:::` and around comments. The
  reader accepts an opener with no blank line before it but warns on
  open (pandoc reads that opener as text); the referee reports it as a
  divergence, not an accepted one, since the first save heals it.
- The abstract moves to YAML `abstract:` and is parsed as Markdown on
  both sides; title/author/date go through the same inline path as body
  text; a roman front-matter restart gets a YAML key; the bibliography
  fence is written where the bibliography node sits.
- Nested and inline comments are never printed: they are hoisted to the
  nearest top-level position on read (below).

## Verified facts this plan rests on

Pandoc 3.4, default `markdown` reader (extensions `fenced_divs`,
`raw_attribute`, `tex_math_dollars`, `footnotes`, `pipe_tables`,
`strikeout`, `yaml_metadata_block`, `implicit_figures`, `link_attributes`,
`citations`, `smart`, `header_attributes`, `bracketed_spans`,
`native_divs`, `subscript`, `superscript` are on):

- `::: solution`, `::: {.solution}`, `::: center`, `::: {.keep}`,
  `::: {.columns gutter=1em cols=2}` with nested `::: {.column width=60%}`
  (quoted or bare values), and `::: {#tbl:t .table caption="Cap"
  density=compact}` wrapping a pipe table all parse as `Div` with id,
  classes and key–values intact; the table inside is a `Table` with
  per-column alignment from the delimiter row. A multi-line attribute
  block (continued until the closing `}`) is accepted. An OPENER with no
  blank line directly after a paragraph line is paragraph text; closers
  and dense nesting parse fine.
- `$$ … $$ {#eq:x}` parses as `DisplayMath` followed by a literal
  `Str "{#eq:x}"` in the same `Para`; `{.unnumbered}` and
  `{#eq:x .unnumbered}` likewise (two `Str`s); a label on the line after
  the closing `$$` lands in the same `Para` after a `SoftBreak`. Inline
  math may span a soft line break (`$a +\nb$` is `Math "a +\nb"`).
- `# H {#sec:x}` → `Header` id. Pandoc makes a `Figure` only for a lone
  image with NON-EMPTY alt: `![Cap](f.svg){#fig:f width=60%}` → `Figure`
  with id and an `Image` carrying `width`; `![](f.svg)`,
  `![](f.svg){#fig:g width=60%}` and `![](data:image/svg+xml;base64,…)`
  → `Para [Image]` with id and width on the image; an image with text
  around it is an inline `Image`.
- `\newpage` and `\pagebreak` alone → `RawBlock tex`;
  ```` ```{=typst} ```` → `RawBlock typst`; `` `…`{=typst} `` →
  `RawInline typst`; ```` ```{=bibtex} ```` → `RawBlock bibtex`
  (anywhere in the body); ```` ```typst ```` and ```` ```bibtex ```` →
  `CodeBlock`.
- `<!-- … -->` → `RawBlock html` at top level and inside a div, list
  item or blockquote; `RawInline html` inside a paragraph, a table cell
  or a footnote; `--` and `&` inside are kept verbatim, entities are not
  decoded; `<!-- a --&gt; b -->` is one comment. A comment on the line
  directly after paragraph text is an inline raw to pandoc but a block
  to markdown-it. A plain `<div>…</div>` is a `Div` (`native_divs`); a
  non-div HTML element is `RawBlock` + `Plain` + `RawBlock`.
- `[@key]` → `Cite` with `NormalCitation`; bare `@key` or `@eq:x` →
  `Cite` with `AuthorInText`; `[@a; @b]` → one `Cite` holding two
  citations; `[see @c, p. 3]` → prefix "see", suffix ", p. 3";
  `[-@c]` → `SuppressAuthor`; `[@a][@b]` is read as a reference link, so
  adjacent citations must be written as one group.
- `$|x|$` inside a pipe-table cell is math `|x|` (an unescaped pipe
  inside math does not split the cell); `` `a|b` `` in a cell is
  `Code "a|b"` to pandoc but markdown-it (GFM) splits the cell on that
  pipe; `` `c\|d` `` is `Code "c\\|d"` to pandoc and `c|d` to markdown-it.
  A headerless pipe table is written with a blank header row
  (`|   |   |`), which pandoc reads as an empty `TableHead`; markdown-it
  reads it as a header of empty cells.
- `H~2~O` → `Subscript`, `x^2^` → `Superscript`, bare `@plass` → a
  citation; `H\~2\~O`, `x\^2\^`, `\@plass` → plain text, and markdown-it
  reads those escapes back as the bare characters.
- YAML: `plass:` nested maps → `MetaMap`; flow maps → `MetaMap`; `author:`
  list → `MetaList`; `abstract: |` → `MetaBlocks` PARSED AS MARKDOWN
  (math, emphasis, citations inside); `title:` → `MetaInlines` likewise.
- With `smart` on, pandoc reads `'90s` as `’90s` and re-reads a written
  `‘90s` as `’90s`, keeps `-3` straight, keeps an escaped `\"` straight,
  reads `5'11"` as `5’11”`, and keeps the space before `[^1]`. Plass
  holds Typst's forms: `−3` (U+2212), `“hi”` even for `\"`, `‘90s`,
  `5′11″` and no space before a footnote marker. With `-f markdown-smart`
  every one of these comes back from pandoc as plain `Str`.
- `~~x~~` → `Strikeout`; `{++ x ++}` → text; `\_\_\_` → `Str "___"`;
  `: Caption {#tbl:x}` after a pipe table is caption text with a literal
  `{#tbl:x}` in 3.4.

markdown-it 15.0.2 (Plass's reader, `{html: true}` + footnotes): the
default `validateLink` rejects every `data:` URL except
`data:image/(gif|png|jpeg|webp)`, so an SVG data-URL image is DROPPED by
`mdToDoc` today (the demo's own figure does not survive a `.md` trip).
Inline math is matched per source line (`md-parser.ts:172-185`), so
`$a +\nb$` is prose today and the next save escapes the dollars.

mitex and Typst versions:

- The in-app compiler is typst.ts 0.7.0 = **typst 0.14.2**
  (`vendor/typst/Cargo.toml`, `sidecar/Cargo.toml`). Taylor's CLI is
  0.15.1.
- mitex **0.2.5** (the pin in `src/typst-config.ts`) warns on 0.14.2
  (`kai` deprecated) and **fails** on 0.15.1 (`unknown variable: kai`,
  `specs/latex/standard.typ:1045`) — the brief's gap, reproduced.
- mitex **0.2.7** (registry, April 2026; 0.2.6 was the `kai` fix)
  compiles cleanly on 0.14.2 and on 0.15.1. On 0.14.2, with math-ink's
  exact wrapper, every renamed symbol in the 0.2.5→0.2.7 spec diff
  (about 25, `\partial` included) and thirty ordinary course formulas
  render byte-identical SVGs with identical `measure().width`. Known
  0.2.7 differences: `\colorbox` gains an inset (+6 pt advance),
  `\KaTeX` changes width, and `\smash`, `\mathscr`, `\nleqq` and other
  negated relations compile where 0.2.5 errored. None of those appear in
  the demo, the fixtures or the 942-file course corpus (which uses
  `\partial` and nothing else that moved). Tarball
  `https://packages.typst.org/preview/mitex-0.2.7.tar.gz`, 111,899
  bytes, sha256
  `0159e214845e49cbdc332d9d572da112dae5ad248072e0a7680d38c8307c2e15`.
- Typst 0.15 itself changed math layout (underbrace/overbrace, the
  calligraphic alphabet, op spacing, binom, cancel): a Plass export with
  `\mathcal{L}` or `\underbrace` lays out differently on 0.15.1 than on
  the in-app 0.14.2, with or without mitex. The export is exact for
  0.14.2 and compiles on 0.15.x.
- mitex's converter output is **not self-contained Typst**: `mimath`
  evaluates it with `scope: mitex-scope`, and the output names scope
  entries (`mitexsqrt`, `mitexmathbf`, `mitexunderbrace`, `#textmath[…]`,
  `operatorname`, `aligned`, `pmatrix`, a `frac` handle). `standard.typ`
  has 95 handle/symbol definitions that need a prelude and ~440 pure
  aliases. The WASM converter runs from Node with a 15-line host shim,
  and its output for 30 formulas compiled natively on 0.15.1 with an
  8-definition prelude.
- A `.typ` holding `image("data:…")` does not compile on any CLI ("File
  name too long"); with the image written to `figures/` and
  `--ignore-system-fonts --font-path public/fonts` the demo export
  compiles with no diagnostics on 0.14.2 and 0.15.1 (every family the
  serializer can emit, New Computer Modern and DejaVu Sans Mono, is in
  the CLI's bundle; adding the in-app `fontFallback` tuple would only add
  an "unknown font family: stix two text" warning on the CLI).

Codebase facts that shape the steps (file:line as of `b8148de`; later
steps cite by heading where line numbers will have drifted):

- `md-parser.ts` (529 lines) extracts math before markdown-it, reads
  only `title|authors?|date` scalars from YAML (69-93, straight quotes
  and YAML escapes untouched), hoists every lone image into a block
  `figure` (294-297, 345-351), never reads heading labels, figure
  labels/widths, `numbered`, blockquote `kind`, paragraph `align`/`keep`
  or any setting, reads ```` ```typst ```` as a grid via `parseGridCall`
  or an island (362-369), makes every untagged HTML block an `md-raw`
  island at any depth (428-448; `parseBlocks` recurses), reads only
  `[@key]` and colon-bearing bare `@a:b` (228), and does not read
  `::: ` divs at all. `md-serializer.ts` (317 lines) writes page breaks,
  restarts and grids as ```` ```typst ```` fences (255-263), escapes
  every `|` in a cell including inside math (176), leaves single `~`,
  `^` and `@` unescaped (52-66), writes title/author/date as
  `textContent` (36-38, so inline math in a title is dropped), joins
  quoted paragraphs with `\n>\n` and then prefixes every line (220, 225,
  producing a `> >` line that reads back as a nested empty quote),
  appends the bibtex fence at the end regardless of node position
  (313-314), and carries twelve `warn(` sites, six of them saying "save
  as .typ to keep …" (47, 138, 166, 197, 217, 248; 197 is the `align`
  warning; `keep` is dropped silently).
- `schema.ts`: `editor_comment` is admitted only by `doc` (364-378,
  521-533); `math_display {src, label, numbered: true|false|null}`
  (99-123); `figure {src, label, name, title, widthPct}` (125-164);
  inline `image {src, alt, title, widthPct}` (438-456), produced today
  only by the `.typ` reader for a bare `#image(...)`; `heading {level,
  label}` (457-470); `paragraph {keep, align}` (393-419; `keep` toggled
  by ⌘⌥K in `editing.ts:275`, `align` by the Extras › Alignment group
  in `toolbar.ts:616-680`, both round-trip in `.typ` via
  `typ-parser.ts:395-397, 553-568`); `blockquote {kind}` (420-437);
  `grid {columns: number[], gutter}` over `grid_row > grid_cell`
  (311-362; shares are stored verbatim, `grid-editor.ts:25-33` accepts
  `60/40` → `[60, 40]`); `table {style, params, caption, label,
  fontSize, density, columnWidths, insetPt}`, `table_row {rule}`, cells
  `{colspan, rowspan, align incl. 'decimal', valign, fill}` (248-278,
  380-392, 471-520); `code_block {params, tight}` (534-561);
  `abstract` is `paragraph+` (91-97); `doc {settings, bib, frontmatter}`.
- `settings.ts`: `DocSettings` (14-64), `normalizeSettings` clamps
  silently (198-256), `PaperName` incl. `half-letter`/`custom`
  (162-188); the roman front-matter restart is a `numbering_restart`
  NODE the panel inserts after block 0 plus any following
  title/author/date/abstract blocks (466-492).
- `file-manager.ts`: `fileFormat` defaults to `'.typ'` (111) and
  `newDoc` resets it (436); `serialize` picks the writer by file NAME
  and toasts each distinct warning on EVERY call (310-326), and is
  called by every autosave flush (1.2 s after any change, 255),
  `adoptFolder` (601), `downloadCopy` (871), `exportCopy` (890) and
  `attachRestoredSession` (905); `adoptFolder('open')` loads the NEWEST
  `.typ|.md` in the folder with no preference by extension (559-572);
  `exportCopy` saves instead of exporting when the open file is
  `${name}.typ` and otherwise writes `docToTyp(doc)` with no options
  through `serialize` (884-894); `attachRestoredSession` reports a
  conflict whenever a re-serialization differs byte for byte from the
  disk text (905-916), which every tab reload of a hand-written file
  hits; `pdf.ts` compiles with `{resolveImage, fontFallback, islands:
  'print'}` (248, 298-302); `migrateEmbeddedFigures` (`figures.ts:191`)
  is dead code (its `onProjectKept` wiring was removed in 578fd6e), so
  a data: figure in a folder is a normal state; `dataUrlToBytes`
  (`pdf.ts:33`) and `projectImagePath` (`figures.ts:903`) are the
  existing decoders/namers, unexported.
- `source-view.ts:494-506` discards parsed settings for every `.md`
  round trip and keeps `bib` only when JSON-equal; `preambleEnd`
  (`source-view.ts:171-172`) folds only a `.typ` preamble;
  `source-editor.ts:283-335` is the Markdown highlighter extension where
  a `:::` block node is added; `SOURCE-VIEW.md:111-112` records
  "Markdown front matter is left alone".
- `typeset-plugin.ts:1460-1483`: comment heights are a top-level
  `doc.forEach` keyed at the note's end; `block-layout.ts:134`,
  `page-oracle.ts:177`, `port-audit.ts:82`, `collapse-spaces.ts:204`
  special-case `editor_comment` by name at the top level.
- `typ-parser.ts` is imported by `main.ts` (`migrateLegacyTableGeometry`)
  and `md-parser.ts` (`parseGridCall`, which is also used in-file at
  771, so knip keeps it under `ignoreExportsUsedInFile`);
  `blockToTypStandalone` (`typ-serializer.ts:918-933`) has no in-file
  use and its only caller is the md grid fence, so it must be deleted,
  not un-exported (`check:unused` flags an unused local, knip flags an
  unused export). `npm run build` fails on unused exports, unused locals
  (src only) and import cycles.
- `npm test` is a hand-maintained `&&` chain in `package.json:37` (31
  suites; the on-disk `src/**/*.test.ts` set is exactly those plus the
  four `test:layout` suites). Playwright runs every `tests/*.spec.ts`
  but the audit; `deploy.yml` gates on `npm test`, `test:layout` and
  `test:browser`, with only the audit `continue-on-error`.
- Tests that assert the CURRENT lossy dialect: `md-round.test.ts`
  (120-127 page-break island, 222-251 and 297-305 comment islands,
  263-272 inline HTML, 328-340 grid fence, 342-354 image/table
  warnings), `editor-comments.test.ts:85-91`, `table-integrity.test.ts:
  177-211` (three "degradation" asserts), `tests/md-comments.spec.ts:
  47-60` (islands and byte identity), `tests/editor-comments.spec.ts:
  357-374` (the tagged frame written). Tests pinning the `.typ` default:
  `tests/persistence.spec.ts:54, 335, 345` (358 asserts
  `exportCopy()`'s download name, which stays `Plass.typ`),
  `tests/source-view.spec.ts` (demo is Typst: 96-104, 139, 521-546,
  557-572; title literal at 231, 487; 548-555 asserts a `.md` with YAML
  has no fold), `tests/export-beside.spec.ts:28, 57, 86` (tile title),
  `index.html:12`, `app/plass.json` (`defaultDocument: "Untitled.typ"`),
  `app/smoke.mjs` (`smoke.typ`). About a dozen layout specs load `.typ`
  fixtures through `__fm.loadHandle` and keep working while the reader
  exists; five specs assert SAVE semantics on a `.typ` handle (rewind,
  persistence two-window/rename/launch, source-view autosave and fold,
  fallback). `tests/port-audit.spec.ts:320` writes the `comments.md`
  fixture's page break as a ```` ```typst ```` fence, which has always
  reopened as an island (the `.md` twin never exercised the seam).
- `CLAUDE.md` is git-ignored and stale (2026-09-30); `AGENTS.md` is the
  committed instruction file and the one subagents in a worktree see.
  Doc edits go to `AGENTS.md`; Taylor refreshes `CLAUDE.md` locally.
- Course corpus (`~/Projects/econ-0100`, `~/Projects/ECON_0100`; 942
  files): 873 HTML comments, all at column 0; no `:::`; no citations or
  bibliographies; no abstracts; 38 `*_sols.typ` use bare `#image("data:…")`
  inside grid cells (never `#figure`); 3 comments contain `&`, none `--`.
- Baseline at `b8148de` is green: `npm test` (31 suites),
  `check:unused`, `check:exports`, `check:cycles`.

## Decision: the exported `.typ` and mitex

Decision: **pin mitex 0.2.7** (step 0) in the app and the export. It
closes the gap the brief names — the exported `.typ` compiles on a fresh
machine with a current typst — and the in-app A/B shows no rendering
change for any formula the documents use. Native-Typst translation
(Taylor: "I'd like it all to be basic Typst, unless that's a whole
research project") is a focused step, not a research project, and is the
required last code step of this plan (step 15, wave 4, appendix A); the
pin stays so the export compiles from day one and the in-app math path
changes only once the per-formula identity proof passes.

**Departure, named:** the pin is a change to the in-app math package
(`typst-config.ts`, `math-ink.ts`, the `docToTyp` header), which the
brief's "compiler … exactly as they are" reads against. A split pin
(0.2.5 in the app, 0.2.7 in the export) would make the export a file
Plass never compiled and need two entries in the package policy and the
security docs; 0.2.5 is dead on typst ≥ 0.15 and the in-app typst.ts
will follow. The honest proof is the per-formula A/B in step 0, not the
audit (after the bump both sides of the audit use 0.2.7, so its agreement
proves self-consistency, not "no page changes").

**Departure, named:** the registry pin is neither of the brief's two
options. A `.typ` cannot inline a WASM plugin, so "vendor" would mean a
sidecar `mitex/` folder; the pin to a registry version the typst CLI
fetches itself is the standard Typst way. Its two failure modes — no
network on first compile, and a future typst release breaking 0.2.7 the
way 0.15 broke 0.2.5 — are accepted until appendix A, and the second is
caught by the compile check in step 9 at the moment the pin is bumped.

Why not translate now, given the brief prefers it "if tractable": mitex
does not emit native Typst; it emits Typst that evaluates inside
`mitex-scope`, so "emit its output" means shipping a Plass-owned prelude
of ~95 definitions in every export and compile. And an export whose math
source differs from the compiled source stops being "the source Plass
compiles" unless the native form is proven layout-identical per formula
— the same proof appendix A requires — so translating at export time
alone buys nothing until that proof exists. Note that native translation
would NOT close the 0.14/0.15 layout difference: native `cal` and
`underbrace` moved in 0.15 exactly as the mitex forms did; only the
version pin addresses that.

**Typst version for the export (answers Q6):** the export is exact for
**typst 0.14.2**, the in-app compiler's version, and compiles on current
0.15.x. One constant beside the package policy in `typst-config.ts`
(`TYPST_EXACT_VERSION = '0.14.2'`, bumped with typst.ts upgrades) is
printed in the export's header comment (`// Exported from Plass — exact
on typst 0.14.2`) and quoted in `docs/MARKDOWN-FORMAT.md` and the README.
A self-skipping node test (step 9) compiles the exported demo with
`typst` from `$TYPST` or `PATH` when it is 0.14.x or 0.15.x; CI installs
the pinned 0.14.2 release binary (sha256-checked) for it, non-blocking.

Export mode: `exportCopy` builds its text with `docToTyp(doc, {islands:
'print', resolveImage})` directly, not through `serialize`, so the
exported `.typ` is the source Plass compiles (islands printed as code,
editorial comments absent) minus the in-app `fontFallback` tuple, which
on the CLI only adds a warning. Embedded images are written to
`figures/` beside the export with the path emitted (step 9); with no
folder the data URL stays and the toast says the export needs a folder to
compile elsewhere. The `exportCopy` branch that turns Export → Typst into
a save of an open `.typ` goes now (a toast says to export Markdown
first), so the only `.typ` the Export menu ever writes is the parity
file. An export is for compiling and reading; reopening it in Plass
reads its islands as plain listings (documented in MARKDOWN-FORMAT.md).

## The format

Normative for the implementer, `docs/MARKDOWN-FORMAT.md` (step 5) and
the referee. Quarto's names where Quarto has one, pandoc's where pandoc
has one; Plass meaning only in class names and under `plass:`.

### Front matter

```yaml
---
title: "Vignette B3 | Solutions"
author: "Taylor J. Weidman"     # a YAML list is read too and written back joined with ", "
date: 2026-10-04
abstract: |
  Parsed as Markdown on both sides: $\beta$, *emphasis*, [@key] all work.

  Paragraphs are separated by a blank line.
papersize: us-letter            # us-letter | a4 | us-legal | iso-b5 | a5; omitted for half-letter/custom
margin: {top: 1in, right: 1in, bottom: 1in, left: 1in}   # written as the dict; a scalar is read
fontsize: 12.5pt
mainfont: New Computer Modern   # the stored preference; rendering still resolves to a certified font
section-numbering: "1.1"        # present = numberSections
bibliography: references.bib    # read once from a sidecar (below); never written
linestretch: 1.5                # pandoc's name for line height
indent: true                    # pandoc's name for first-line paragraph indent
bibliographystyle: ieee         # Quarto/pandoc's Typst-template name; ieee | apa | chicago-author-date
plass:                          # only non-default values are written
  page: half-letter             # or {width: 5.5in, height: 8.5in}
  landscape: true
  hyphenate: false
  number-equations: false
  page-numbers: {show: true, format: "1", align: center, place: bottom, start: 1, front-matter: roman}
  header: {text: "{section}", align: right, first-page: false}
  footer: {text: "Econ 0100 · {page}", align: center, first-page: true}
  footnotes: {numbering: "1", separator: rule}
  math-macros: |
    \R = \mathbb{R}
---
```

Rules:

- title, author, date and abstract are written whenever the nodes exist,
  through the same inline/block writer as body text (a title with `$x$`
  or `*em*` keeps it); they are read through the same inline/block
  reader as body text (math pre-pass, markdown-it, `printedForm`,
  `smartenInline`), so a hand-written `Taylor's -- draft` imports as
  `Taylor’s – draft` exactly as it would in the body. Scalars are
  written in the YAML form that needs no backslash escaping (plain when
  safe, else single-quoted with `''` doubling); `\"` escapes in a
  double-quoted scalar are decoded on read. Values holding `{section}`
  or `{page}` must be quoted in YAML (pitfall in MARKDOWN-FORMAT.md).
- Every other known key only when its value is not the default;
  `margin` in the dict form; units `in`/`mm`/`cm`/`pt` read, `in` and
  `pt` written.
- Unknown keys and `#` comments are carried verbatim in order
  (`doc.attrs.frontmatter`, as today) and written back after the known
  keys. Out-of-range values are clamped by `normalizeSettings` AND
  reported as import warnings, shown by the open toast as warnings, not
  as "raw blocks".
- `page-numbers.front-matter: roman` is the `numbering_restart` node.
  The reader inserts it where the settings panel does (after block 0
  plus any following title/author/date/abstract blocks); the writer
  emits the key when the node exists anywhere. A node elsewhere moves to
  that position on the next open (documented); the reader warns when
  the key is present but the document has no front-matter block.
- `bibliography:` is a one-way import. `mdToDoc` stays synchronous and
  returns the path in `MdImport.bibliography`; the FileManager's open
  paths and `attachFolder` then read the sidecar through `readAsset`
  (4 MiB limit) and dispatch `setDocAttribute('bib', …)`; a Finder/PWA
  launch without a folder gets the existing "grant folder" toast for it.
  The writer never writes the key or a sidecar: it always embeds the
  `{=bibtex}` fence at the bibliography node and drops the key, with a
  one-time toast. (A persistent sidecar for a BibDesk workflow is a
  separate later step: it needs a provenance attr, read-only semantics
  and a watcher.)

### Blocks and inlines

| Node | Form | Notes |
|---|---|---|
| `blockquote{kind:'solution'}` | `::: solution` … `:::` | also read `::: {.solution}`; blank line before and after |
| `grid` | `::: {.columns gutter=1em cols=2}` holding every cell row-major as `::: {.column width=60%}` | **departure**: one div per GRID, never per row, never merged (below); `cols=N` always written; equal shares write no `width` |
| `paragraph{align}` / `paragraph{keep}` | `::: center`, `::: right`, `::: {.keep}` (classes combine: `::: {.keep .center}`) around exactly one paragraph | the rail for the two features the brief's list omits; any other content inside → the unknown-div island |
| `blockquote` | `> …` | quoted paragraphs are separated by a bare `>` line (today's `> >` bug fixed) |
| `editor_comment` | `<!-- … -->` at top level | every HTML comment; written verbatim except `-->` → `--&gt;` (decoded on read); the tagged `<!-- plass:comment` frame is still read with its old decoding, never written |
| nested or inline comment | hoisted (below) | kept, unprinted, moved to the nearest top-level boundary on first save |
| `math_display` | `$$` … `$$ {#eq:x}` | `{.unnumbered}` → `numbered:false`, `{.numbered}` → `numbered:true`, combined `{#eq:x .unnumbered}`; the attribute block on the closing line or the next line |
| `math_inline` | `$…$` | pandoc's rules; may span one soft line break (reader fixed) |
| `heading` | `# Title {#sec:x}` | `{-}` is read as `.unnumbered` and ignored |
| `figure` | `![caption](src){#fig:x width=60%}` alone; a labeled figure with an empty caption is `![](src){#fig:x}` (pandoc keeps the id on the image) | a lone image with an id is a figure; `width` as a percent only; a non-percent width warns and drops; `title` as `"title"` |
| `paragraph > image` | `![](src){width=60%}` alone, empty alt | pandoc's `Para [Image]`; the course's bare `#image("data:…")` form, un-numbered, no label |
| `image` (inline) | `![alt](src "title"){width=40%}` inside text | |
| `table` | pipe table, optionally inside `::: {.table …}` | grammar below; a `: Caption` line after a table is read as its caption too |
| `page_break` | `\newpage` alone in a paragraph | also read `\pagebreak` |
| `numbering_restart` | YAML `plass.page-numbers.front-matter: roman` | see above |
| `code_block{params:'typst-raw'}` | ```` ```{=typst} ```` | the only block escape hatch; ```` ```typst ```` is a code listing |
| `typst_inline` | `` `…`{=typst} `` | inline HTML that is not a comment stays `typst_inline{lang:'html'}` (an inline island, titled "Inline HTML — kept, shown as code, never run") |
| `code_block{params:'md-raw'}` | an HTML block that is not a comment, or an unknown div, verbatim (the source slice from the opener's line to the closer's) | printed as code, margin tag "markdown · printed as code" |
| `citation` | `[@key]`; adjacent citations as one group `[@a; @b]` | pandoc's group grammar is read (below) |
| `eq_ref` | `@eq:x`, `@fig:x`, `@sec:x`, `@tbl:x`, bracketed or bare | pandoc-crossref's rule: a key with one of those prefixes is a reference; any other `@key`, bare or bracketed, is a citation |
| `bibliography` | ```` ```{=bibtex} ```` at the node's position | or `bibliography:` in YAML (read once) |
| `footnote` | `[^n]` + definition, or `^[inline]` | as today |
| `horizontal_rule` | `---` | |
| nbsp | U+00A0 written literally | pandoc's `\ ` is read as nbsp |
| lists, marks, `~~x~~`, `{++ ++}`, `\_\_\_`, hard breaks | standard | as today; `3.` start numbers already round-trip |

Grid shares: the model's shares are canonical — every share divided by
the smallest and rounded to 3 decimals — applied at every entry point
(`parseColumnShares`, `parseGridCall`, the `.md` reader), so `60/40`
is `[1.5, 1]` and `(2fr, 2fr)` is `[1, 1]`; ratio-equivalent lists are
SVG-identical on both compilers (verified), while `(33.333fr, 66.667fr)`
is NOT the same Typst as `(1fr, 2fr)` (it is not), so percentages are
never stored as shares. The writer omits `width` when every share is 1
and otherwise writes `share/sum` as a percent to 3 decimals; the reader
accepts `N%`, a bare number or `Nfr` and canonicalizes, so `33.333%`/
`66.667%` recovers `[1, 2]`. Gutter: `em` native; `pt`/`in`/`mm`/`cm`
converted at the document font size.

Grid rows (**departure**): the brief says "one `.columns` div per grid
row". Two adjacent one-row grids with equal shares and gutter are
indistinguishable in that form from one two-row grid, and the two are
different Typst (one `#grid` applies its gutter between rows; two grids
are separated by paragraph spacing — a 3 pt difference at 12 pt, on both
compilers) and different pages (the editor's `.ts-grid-row + .ts-grid-row`
margin). Merging on read would silently rewrite a shape the editor
produces in one click and break the step-6 equality test; not merging
would make every multi-row grid two grids. So a grid is exactly one
`::: {.columns …}` div holding all its cells row-major, with `cols=N`
always written (the row length is otherwise unrecoverable when equal
shares write no `width`). Pandoc preserves the attribute; Quarto would
render the cells in one row, which is irrelevant since pandoc is not a
renderer. Taylor's call (open question 11); the alternative is the brief's per-row
form with a continuation class on later rows (`::: {.columns .continued}`),
which needs no attribute and lets Quarto render rows, at the cost of a
referee merge rule; the course corpus has 12 two-row grids and 2 adjacent
equal pairs, so both rules are exercised by real files.

Citations: a bracket group `[…]` containing `@` is read by pandoc's
grammar — items split on `;`, each with optional prefix text, optional
`-`, `@key`, optional suffix text. Every key becomes a `citation` node
(or an `eq_ref` when its prefix is a label namespace); prefix, suffix and
the `-` are kept as plain text beside it (never dropped) with one import
warning per file ("citation prefix/suffix kept as text; Plass cites the
key only"). The writer writes a run of adjacent citation nodes as one
group. A bare `@key` with no namespace prefix is a citation (today it is
silently plain text and prints `@key` literally); a missing key paints
"[?] — not found in bibliography" on the page, visible. A real
supplement rail (`[1, p. 3]`) needs a schema attr and is a later step.

Table div grammar (every attribute optional; the div is written only
when at least one is set; a table with none is a bare pipe table; the
writer emits the opener on one line, the reader accepts an attribute
block continued over lines until the closing `}`):

```
::: {#tbl:x .table caption="Results" style=grid density=compact inset=9pt columns="auto 1fr 2fr" font-size=0.85em decimal="2" rules="1:light 3:none" fills="r0:gray-dark r3c1:yellow" valign="r1c2:middle" spans="r2c0:2x1" aligns="r2c1:center"}
| Name | Score | Note |
|:-----|------:|-----:|
| a    | 12.5  | x    |
| b    | 3.25  | y    |
| c    |       |      |
:::
```

- `caption`, `#id` (the label), `style` (`booktabs` default | `grid` |
  `plain`), `density` (`compact` | `roomy`), `inset` (points),
  `columns` (space-separated `auto` | `Nfr` | `Npt`), `font-size`
  (`0.9em` … `0.75em`) map one-to-one onto the table attrs.
- Column alignment comes from the delimiter row (pandoc `AlignDefault`
  and `AlignLeft` are the same to Plass); `decimal` lists the 0-based
  column indexes whose `---:` means `align:'decimal'` (a `decimal`
  column without `---:` warns on import); `aligns` carries the rare
  per-cell override.
- Header: the first pipe row is the header row (`table_header` cells).
  A table whose first Plass row is not a header is written with a BLANK
  header row (`|   |   |`, pandoc's documented headerless form) and all
  Plass rows as body lines; the reader drops a header row whose cells are
  all empty. A genuine header row of empty cells, and header cells
  below the first row, are written as body cells with a warning.
- Positions are 0-based written-grid coordinates: `rN` counts Plass
  rows (the synthetic blank header line is not a row), `cM` counts
  columns including covered cells; `fills`, `valign`, `aligns` and
  `spans` name the spanning cell's origin. `rules="N:light|heavy|none"`
  is `table_row.rule` of row N; `fills="rN:fill"` fills a whole row,
  `rNcM:fill` one cell; `valign="middle"` for the table or `rNcM:…`;
  `spans="rNcM:CxR"` (colspan × rowspan; the covered cells are written
  empty and skipped on read).
- Cells are one paragraph; a multi-paragraph cell is written joined by a
  space with a warning. `|` is escaped in plain text only, never inside
  `$…$` or backticks (pandoc's rule); the reader sentinelizes code spans
  in the pre-pass so markdown-it's GFM splitter never sees a pipe inside
  backticks (today `` `a|b` `` in a cell destroys the row).
- Dropped with a warning: `params`, footnotes, images and inline HTML in
  cells (the `.typ` exporter refuses those).

Nested and inline comments (hoisting): a `<!-- … -->` that is not a
top-level block — inside a solution, a column, a list item, a
blockquote, a table cell, a footnote, or inline in a paragraph — becomes
a top-level `editor_comment` placed at the nearest top-level boundary
(before the enclosing top-level block when it precedes all printed
content in that block, otherwise after it), order kept, with one import
warning per file naming the count ("N comment(s) moved out of nested
blocks"). The inline case removes the atom and lets the space normalizer
close the gap. The hoist runs over the tokens of ANY div before its
class decides what it becomes, and whole-line comments are lifted out of
an HTML-element island's line range, so a comment inside an unknown div
or a `<div>` block is unprinted too. A markdown-it `html_block` holding a comment plus trailing
text is split into the comment and a paragraph, as pandoc reads it. The
writer writes the comment at its hoisted position, so the file is
canonical after the first save. This keeps every comment unprinted (the
brief) with no schema, paginator, audit, normalizer or TeX change, and no
hidden content (the doctrine's one exception stays the one exception).
The documented limitation is the position move; step 14 keeps a comment
in place.

Escaping in prose: the writer escapes `@` before a word character,
`~` and `^` whenever another of the same follows on the line with no
whitespace between (pandoc's sub/superscript rule), `^` before `[`
(the inline-footnote opener), plus today's set. Readers decode all of
them to the bare character.

Normalizations applied at import and by the edit-time normalizer (not
by the writer, which writes what the document holds): straight quotes →
curly by Typst's quoter, `--`/`---`/`...` → glyphs, a whitespace-`-`-digit
→ U+2212, `5'11"` → primes, the space before a footnote marker dropped,
hard-wrapped paragraphs → one line. Of these, only paired quotes, dashes
and the ellipsis coincide with pandoc's `smart`; the minus sign, primes,
the apostrophe-before-digit case and the swallowed footnote space are
Typst's choices, which the referee folds (step 4). Also on first save:
`_em_` → `*em*`, list markers and indents, a blank line around every
`:::` and comment, YAML in the order above, `author` as one string,
`-->` inside a comment → `--&gt;`, nested comments hoisted. A
hand-written file is rewritten in these ways on its first Plass save and
never again.

## Proposed answers to the brief's open questions

1. **Solution class:** `::: solution`. Plain, readable, what the course
   files will say; Quarto's `callout-note` would render a box nobody
   asked for in Quarto and nothing in pandoc. (`::: {.solution}` reads
   the same.)
2. **Nested comments:** unprinted by hoisting (above). Step 14 (schema
   extension so a comment stays in place inside a solution block) is
   optional; the hoist makes it a precision improvement, not a
   correctness one. A comment in a table cell today makes the whole PDF
   export fail (the cell exporter throws on inline HTML); hoisting
   removes that too.
3. **Bibliography:** write the `{=bibtex}` fence (self-contained files);
   read the fence and `bibliography:` as a one-way import when a folder
   is attached. Only `{=bibtex}`, not ```` ```bibtex ````.
4. **Figures:** both forms supported; nothing automatic. The data-URL
   hint moves out of the serializer into the FileManager, fires once per
   file, and names the per-image action ("Save SVG to project" on the
   figure), not a folder the user just chose.
5. **Default format:** flips to `.md` in this plan (step 8).
6. **Typst CLI version:** 0.14.2 is the version the export is exact for
   (above); 0.15.x compiles it.
7. **Exported math:** pin mitex 0.2.7 now (step 0); native translation
   as the required step 15 after the Markdown work lands (appendix A).
   In plain terms: mitex is a plugin the export currently depends on to
   turn LaTeX into Typst math at compile time; step 15 writes the
   translated Typst math into the file instead, plus a short list of
   helper definitions at the top, so nothing is downloaded.

New questions this review found (answers proposed; Taylor overrides):

8. **Paragraph `align` and `keep`:** given the rail `::: center` /
   `::: right` / `::: {.keep}` (a few lines each side; pandoc parses
   them). Both are UI-reachable and round-trip in `.typ` today, so
   dropping them would be a chosen regression against "every current
   document feature survives".
9. **Opening a `.typ`:** stays a normal open until step 13 (required
   after step 12). "Open project folder…" prefers a `.md` over a `.typ`
   with the same stem (any `.md` over any `.typ` once `.md` is the
   default), newest within the winning extension, so the folder-open
   never lands on an export beside its source.
10. **The `{=typst}` hatch in the export:** printed as a code block
    (`islands: 'print'`), the same as the page and the PDF.
11. **Grid rows:** one div per grid with `cols=N` (the departure above),
    or a continuation class per row. The plan assumes the former.
12. **Repo repair:** done 2026-10-04.

## Steps

Merge gate, for every step, run by the merger on the MERGED main after
every merge: `npm test && npm run test:layout && npm run check:unused &&
npm run check:exports && npm run check:cycles && npx tsc --noEmit`, then
every Playwright spec the step's own file list names (`npx playwright
test tests/<spec>… --project=chromium`), and `npm run audit` after steps
0, 6, 7 and 10. The full `npm run test:browser` runs when a wave closes
and before Taylor pushes; `app/smoke.mjs` is verified by the deploy's app
job (or `npm run app:build && npm run app:smoke` locally). Each step's
reviewer receives the step's file list (any file outside it is a
finding), its acceptance list and this command list.

Prerequisites (a step branches from main once these have merged):
6 ← {1, 3}; 7 ← {2, 6}; 8 ← {7, 9}; 9 ← {0}; 10 ← {4, 6, 7};
11 ← everything else; 13 ← {12}. Waves below are the schedule that
satisfies them with no two in-flight steps editing one file; package.json
is edited only by the pre-step and by step 10 (one new script key).

### Pre-step (one commit on main before any worktree is cut)

**Glob test runner.** `scripts/run-unit-tests.ts` (about 15 lines): walk
`src` recursively, keep `*.test.ts`, drop the four `test:layout` suites
(`src/layout/port/{port-smoke,shape-cache,incremental-linebreak}.test.ts`,
`src/layout/font-certification.test.ts`), sort, run each with
`spawnSync('npx', ['tsx', file], {stdio: 'inherit'})`, stop at the first
non-zero status (today's `&&` semantics); `"test": "node --import tsx
scripts/run-unit-tests.ts"`. It reproduces today's 31 suites exactly
(verified against the on-disk set), is a knip entry (`scripts/*.ts`), and
means a new suite registers by existing, so no step edits the chain.

### Wave 1 (parallel; new modules and one export surface)

**Step 0 — mitex 0.2.7.** Files: `src/typst-config.ts` (version, url,
sha256 above; add `TYPST_EXACT_VERSION`), `src/typ-serializer.ts:1004`
(and the header comment at line 955 gains the exact-version note, which
changes line 1 of every `.typ` Plass writes — the one emitted-output
change besides the pin; `tests/source-view.spec.ts:535,585` loosen their
regexes to `/^\/\/ Exported from Plass[^\n]*\n#set page/`),
`src/math-ink.ts:245`, `src/security.test.ts:152`,
`tests/security.spec.ts:253-257` (the request-list literal),
`src/typ-parser.test.ts:357` and `src/source-typst-mode.test.ts:96`
(fixture literals), `README.md` ("One-click PDF export" and "Export"
bullets), `SECURITY.md`, `PRIVACY.md`. `typ-parser.ts:120` matches the
import by prefix and needs no change. Acceptance: (a) the A/B script —
extract every `#mi(`…`)` / `#mitex(`…`)` source from the exported `.typ`
of the demo, the test fixtures and the course folder, compile each with
the typst 0.14.2 release binary under both import lines using
`math-ink.ts`'s exact wrapper, assert identical SVG bytes and identical
`measure().width`, and list in the commit message any formula that
differs or that newly compiles (none expected); (b) `npm run audit` on
the math and table fixtures (mismatch 0, unmeasured 0), which proves the
port still agrees with Typst under the new pin, not that pages are
unchanged; (c) `npx playwright test tests/source-view.spec.ts tests/security.spec.ts
tests/atom-spacing.spec.ts tests/bold-math.spec.ts
tests/math-ink-recovery.spec.ts tests/native-tables.spec.ts`; (d) a
math-only fixture (no image; `\mathcal`, `\underbrace`, `\binom`,
`\operatorname`) exported and compiled with the 0.14.2 binary and with
0.15.1 (`--ignore-system-fonts --font-path public/fonts`), exit 0 and no
diagnostics on both — the demo itself cannot compile on any CLI until
step 9 extracts its data: image.

**Step 1 — Fenced divs and attribute blocks.** New `src/md-attrs.ts`:
parse and write pandoc attribute blocks `{#id .class key=val key="val"}`
and the bare-class form, shared by divs, headings, images and display
math; `{-}` reads as `.unnumbered`. New `src/md-divs.ts`: a markdown-it
block rule for `:::` openers (three or more colons, a bare class or an
attribute block, which may continue over following lines to its closing
`}`) and closers (three or more colons alone), nesting by depth, emitting
`div_open`/`div_close` tokens with the parsed attrs and source line maps,
tolerant of a missing blank line before the opener (and recording it so
the reader can warn), skipping fences and HTML blocks the way the math
pre-pass does, registered as
`md.block.ruler.before('table', 'div', rule, {alt: ['paragraph',
'reference', 'blockquote', 'list']})` (markdown-it-container's
registration) so a `:::` line terminates a paragraph, a pipe table, a
blockquote and a list item's lazy continuation, as pandoc's closers do
(verified: without the alt chains a closer right after a table row is
swallowed as a row). No integration into `md-parser.ts` yet. Tests
(`src/md-divs.test.ts`): nested divs, an opener with no leading blank
line (flagged), quoted and bare values, a multi-line opener, an id, an
unknown class, `:::` inside a code fence, an unclosed div (text, nothing
lost).

**Step 2 — Front matter.** New `src/md-frontmatter.ts`: a YAML subset
reader/writer with no dependency (plain, single- and double-quoted
scalars with their escapes, two-level block maps, flow maps, block
scalars `|`, lists, comments), returning an ordered list of top-level
entries where known keys are interpreted and unknown ones kept verbatim.
`readFrontmatter(text) → {titleMd, authorsMd, dateMd, abstractMd,
settings: Partial<DocSettings>, bibliography?: string, frontMatterRestart:
boolean, extra: string, warnings}` — the four text fields are raw
Markdown for step 7 to parse, never plain text — and `writeFrontmatter`
the inverse, emitting only non-default values in the fixed order above,
`margin` as a dict, scalars in the no-escape form. Units `in`/`mm`/
`cm`/`pt` read, `in` and `pt` written. Tests (`src/md-frontmatter.test.ts`):
every `DocSettings` field round-trips; defaults write nothing;
half-letter writes no `papersize`; a scalar `margin`; an `author` list
joined with ", "; a double-quoted scalar with `\"` decodes and re-encodes
byte-identically; a scalar holding `\beta` survives; `{section}` quoted;
unknown keys and `#` comments survive in order; out-of-range values warn;
a block scalar with blank lines.

**Step 3 — Table attributes.** New `src/md-tables.ts`: the `.table` div
grammar above, both directions, as pure functions over table nodes
(`tableDivAttrs(node) → attrs | null`, `applyTableDivAttrs(node, attrs)`),
the blank-header-row rule, plus `escapeCellProse` (pipes in plain text
only, never in `$…$` or backticks). Tests (`src/md-tables.test.ts`): each
attribute; fills/spans/rules with 0-based positions and covered cells; a
table with nothing set yields no div; a headerless table writes the blank
header row and reads back headerless; decimal columns and the missing
`---:` warning; `` `a|b` `` and `$|x|$` in a cell; the warning cases.

**Step 4 — Skeleton and fixtures.** New `src/md-skeleton.ts`: reduce a
PM doc and a pandoc JSON AST to the same ordered list of records
`{kind, text?, math?: string[], label?, src?, cols?, rows?, head?,
aligns?, printed, mode?, classes?}` (kinds: `title`, `author`, `date`,
`abstract`, `heading-N`, `paragraph`, `math`, `solution`, `columns`,
`column`, `quote`, `table`, `figure`, `image`, `list`, `item`, `code`,
`raw-typst`, `pagebreak`, `comment`, `bibliography`, `footnote`, `hr`,
`island`). Rules the review settled: pandoc runs with `-f markdown-smart`,
and the reducer applies Plass's own `printedForm`, `smartenText` (with
the same `before` stand-ins `beforeAfterNode` uses) and the
footnote-space rule to pandoc's flattened paragraph text, so both sides
are the same functions over the same text; inline math is a sentinel
with sources collected whitespace-normalized; a pandoc `Cite` yields one
sentinel per citation (reference when the id has a namespace prefix,
citation otherwise, in either mode) with prefix/suffix inlines emitted as
text; `Subscript`/`Superscript` flatten to their content; a nested
`RawBlock`/`RawInline html` comment is hoisted to its enclosing
top-level block's boundary exactly as the reader does, its payload taken
by stripping `<!--`/`-->`, trimming and decoding `--&gt;`; a `Div` with
no rail class, a non-comment `RawBlock html` (swallowed through its
closing tag) and a `<div>` `Div` reduce to one `island` record with no
text and children not descended; `Para [Image]` ↔ `paragraph > image`,
`Figure` ↔ `figure`; `abstract` (MetaBlocks) and title/author/date
(MetaInlines) are reduced like body paragraphs; `AlignDefault` =
`AlignLeft`; tables carry `rows` and `head` counts; the `columns` record
carries `cols`. New `tests/fixtures/md/`: one file per row of the
vocabulary table (including `paragraph > image` with a data-URL SVG, a
captioned labeled figure, `::: center`/`::: {.keep}`, a headerless
table, a cell with `` `a|b` ``, every citation form, a `--` comment, a
comment after a paragraph line), `normalizations.md` (`Costs -3`,
`\"hi\"`, `'90s`, `5'11"`, `claim [^1]`, a written `‘90s`, the WRITTEN
forms `H\~2\~O`, `x\^2\^`, `\@plass`, `note\^[x]` — the raw `H~2~O`/`x^2^`
are a Plass-only convergence case in step 6, and a hand-written one is a
REPORTED referee divergence with an import warning, checked by one
negative assertion), `wrapped-math.md` (inline math over
a line break in a paragraph, a quote and a list item), `nested-comments.md`
(a comment in a solution, a column, a list item, a quote, a cell, inline),
`grids.md` (`[2,2]`, `[60,40]`, `[1,2]`, `[1.5,1]`, a 3×2 grid, two
adjacent equal grids), `unknown.md` (an unknown div with a nested `:::`,
the styled empty `<div>` from `md-comments.spec.ts:29`, an `<aside>`),
and `guide.md`, a course-style solutions file long enough to paginate
(YAML with `plass:` keys and an author with an apostrophe, a solution
block holding a two-column grid with a data-URL image, labeled and
unnumbered equations, a table with math and a `.table` div, comments at
top level and nested, a page break, a `{=typst}` block, a `{=bibtex}`
fence, footnotes, a strike and a `{++ ++}` mark). The reducer is unit
tested on hand-built ASTs (`src/md-skeleton.test.ts`); the pandoc run is
step 10.

**Step 5 — `docs/MARKDOWN-FORMAT.md`.** The one-page reference for a
person or a model writing a Plass `.md` by hand: the front matter, the
table above, the pitfalls (a blank line before every `:::` and before a
comment that should be unprinted everywhere, `\$` for a literal dollar,
the attribute block after the closing `$$`, ```` ```{=typst} ```` not
```` ```typst ````, `{=bibtex}` not ```` ```bibtex ````, a citation key
whose prefix is `eq:`/`fig:`/`sec:`/`tbl:` is a reference, `~x~`/`^x^`
and bare `@word` mean sub/superscript and a citation to pandoc, a figure
needs a caption to be numbered, a comment inside a block moves out of it
on first save, `{section}` quoted in YAML, non-percent widths dropped,
unknown attributes on a known div dropped with a warning, the export is
exact on typst 0.14.2), and what Plass rewrites on first save. Step 11
reconciles it against what landed.

**Step 9 — The export surface** (wave 1; branches after step 0 merges).
`exportCopy` builds its text with `docToTyp(doc, {islands: 'print',
resolveImage})` directly (not through `serialize`, so an open source view
does not short-circuit it); in a folder, each `data:` image is decoded
with `pdf.ts`'s `dataUrlToBytes` (exported) and written collision-safe
through `figures.ts`'s `projectImagePath` (exported) under `figures/`
with the path emitted; without a folder the data URL stays and the toast
says so. The "save when the open file is `${name}.typ`" branch becomes a
toast ("X.typ is the open document — Export → Markdown, then export
Typst from the .md"). New `exportMdCopy()` and an "Export → Markdown
(.md)" item beside the `.typ` one (`toolbar.ts:982-983`); the Export tile
title becomes "Export — PDF, .md, .typ, .tex" and every selector on it
moves with it (`tests/export-beside.spec.ts:28,57,86`,
`tests/source-view.spec.ts:231,487`). New `src/typ-export-compile.test.ts`:
finds typst at `$TYPST` or on `PATH`; absent → prints
`typ-export: skipped (typst not found)` and exits 0; present but neither
0.14.x nor 0.15.x → prints the version and skips; otherwise builds the
export with the same `docToTyp(demoDoc(), {islands: 'print', resolveImage})`
call and a test-local `resolveImage` that base64-decodes each data: URL
itself and writes `figures/image-N.ext` under a temp dir (`pdf.ts` and
`figures.ts` do not load under node: a `?worker` import and a `.css`
import; `exportCopy` in the browser uses `figures.ts`'s unsanitized
`dataUrlBytes`, exported, not `pdf.ts`'s DOMPurify path), runs `typst compile --diagnostic-format short
--ignore-system-fonts --font-path public/fonts`, requires exit 0 and no
`warning:`/`error:` lines. Files: `src/file-manager.ts` (`exportCopy`,
`exportMdCopy`), `src/pdf.ts`, `src/figures.ts`, `src/toolbar.ts:328,
982-983`, `tests/export-beside.spec.ts` (the exported `.typ` holds no
`plass:comment` and holds `image("figures/…")`; the `.md` export; new
tests drive `__fm.exportCopy()` rather than the tile title),
`tests/source-view.spec.ts:231,487`, `README.md` ("Export" bullet: the
CLI promise holds for an export written into a folder). Step 0 and this
step share no files.

### Wave 2 (sequential; `md-parser.ts`, `md-serializer.ts`, their tests)

**Step 6 — The body** (after 1 and 3). Integrate steps 1 and 3 (step 4
is consumed by step 10). Reader: `div_open` with class `solution` →
`blockquote{kind:'solution'}`; `columns` → one grid, cells row-major by
`cols`, shares canonicalized; `table` → the inner pipe table with the
div's attrs; `center`/`right`/`keep` holding one paragraph → the
paragraph's attrs; any other class, a `<div>`, or an HTML element → an
`md-raw` island holding the ORIGINAL source lines for that token range
(the pre-pass records, for every line it pushes, the original line it
starts at, so sentinels and the wrapped-math join never leak into an
island; a nested `:::` stays inside it); an opener with no
leading blank line → an import warning. Every top-level `html_block`
that is exactly one `<!-- … -->` → `editor_comment` (decoding `--&gt;`;
the tagged frame still decoded the old way); a block holding a comment
plus trailing text is split; nested and inline comments are hoisted
(above). `\newpage`/`\pagebreak` alone → `page_break`. ```` ```{=typst} ````
→ `typst-raw`; ```` ```{=bibtex} ```` → the bibliography at that position.
Heading `{#sec:x}` (`{-}` ignored); figure/image per pandoc's alt rule
with `{#fig:x width=N%}` (the attribute block arrives as the text token
after the image; read it like the `{=typst}` suffix at `md-parser.ts:
258-266`); display-math attributes on the closing line or the next line;
a `: Caption` line after a table (markdown-it absorbs it as a body row;
step 3's `takeCaptionLine` pops a trailing row whose first cell matches
`/^(:|Table:)\s+/` with the other cells empty, and an adjacent matching
paragraph before or after the table is consumed too). Citations by pandoc's group grammar and the
namespace rule. The math pre-pass buffers a paragraph's lines before the
inline regex so `$a +\nb$` is one formula (body may hold one newline,
never a blank line; a leading `> ` on the continuation line stripped);
code spans are sentinelized in the pre-pass (restored in `textWithRefs`,
with the `{=typst}` suffix logic moved there). `validateLink` on the
markdown-it instance admits `data:image/svg+xml;…` so SVG data-URL
images survive (today they are dropped). `\ ` reads as nbsp. Writer: the
forms in the table; blank lines around divs and comments; the escape set
above; pipes in plain text only; the bibtex fence at the node; quoted
paragraphs separated by a bare `>`; the abstract lead's stray leading
space trimmed on read. Delete `blockToTypStandalone`
(`typ-serializer.ts:918-933`, doc comment included; nothing it uses is
orphaned) with its import at `md-serializer.ts:19`; drop the
```` ```typst ```` grid recognition and the `parseGridCall` import
(`parseGridCall` stays exported; it is used in-file). Delete the
warnings that are now representable (image size ×2, cell shading/valign,
solution, alignment, merged cells, settings is step 7) and reword any
retained message that says "save as .typ". Files: `src/md-parser.ts`,
`src/md-serializer.ts`, `src/typ-serializer.ts` (the deletion),
`src/editor-comments-format.ts` (plain-comment write/read; the tagged
decode kept for reading), `src/grid-editor.ts:25-33` and
`src/typ-parser.ts:1046-1052` (share canonicalization). Tests: rewrite
`md-round.test.ts` case by case (120-127, 222-251, 263-272, 297-305,
328-340, 342-354) and add cases for every form above including the
grids `[2,2]`, `[60,40]`, `[1,2]`, `[1.5,1]`, two adjacent equal grids,
`Math $a +\nb$` → one `math_inline`, `H~2~O`/`x^2^`/`follow @plass`/
`note^[x]` converging, the SVG data-URL figure, the citation forms, the
abstract-quote path; `editor-comments.test.ts:37-49, 85-91`;
`table-integrity.test.ts:177-211` (invert the three degradation checks;
88-102 keeps its exact-JSON assertion, comment fixed); the cross-format
check: for the demo doc and the typ-parser fixtures lifted into a shared
`src/typ-fixtures.ts` (one import added to `typ-parser.test.ts`),
compare the body (after the `#import` line) of
`docToTyp(mdToDoc(docToMd(doc)).doc, {islands:'print'})` with
`docToTyp(stripUnrepresentable(doc), {islands:'print'})`, where
`stripUnrepresentable` clears table `params` and, until step 7, resets
settings to the defaults — asserting the Markdown trip changes nothing
the compiler sees EXCEPT the listed drops (sections 11, 13d, 19c-custom,
19d-custom and the 852 loop are the `params` cases; 13c is representable
via `decimal`; no fixture carries paragraph align/keep; the grid fixture
at 955 passes because a bare `#image` is `paragraph > image`). Browser
specs in this step's gate: `tests/md-comments.spec.ts` (top-level
comments are `editor_comment` strips; the `<div>` stays an island; byte
identity holds since `--` is untouched), `tests/editor-comments.spec.ts:
357-374` (the bare form, retitled). Convergence (`md1 === md2`) stays.

**Step 7 — Front matter and settings** (after 2 and 6). Integrate step
2. Reader: YAML → `doc.attrs.settings` through `normalizeSettings` with
warnings; title/author/date through the inline reader and abstract
through the block reader (math pre-pass included); `front-matter: roman`
→ the `numbering_restart` node at the panel's position; `bibliography:`
→ `MdImport.bibliography`. FileManager: in `putInPlace`, `loadHandle`,
`completeRestore` and `attachFolder`, when the last import carried a
path and `dir` is set, `readAsset` the sidecar and dispatch the bib
through a new `setBib` hook; `main.ts` `needsFolder` also fires for it.
Writer: the front matter from settings and nodes (inline/block writer,
no-escape scalars); never `bibliography:`; the one-time embed toast.
`source-view.ts:494-506`: treat `.md` like `.typ` (keep the editor's
settings only when the parsed ones normalize equal). The open toast
reports settings warnings as warnings ("N setting(s) adjusted"), not as
raw blocks. Files: `src/md-parser.ts`, `src/md-serializer.ts`,
`src/file-manager.ts` (the sidecar read, the `setBib` hook, toast
wording), `src/main.ts` (`needsFolder`, the hook), `src/source-view.ts`.
Tests: the front-matter integration cases in `md-round.test.ts` (a title
with `$x$` and `*em*`, `Taylor's -- draft`/`O'Brien` importing as
`Taylor’s – draft`/`O’Brien`, an abstract with math, a citation and two
paragraphs, all converging); the cross-format check lifted to the full
output (settings included) for sections 3, 3b, 12, 13 and the chrome
fixture; `reload-in-place.test.ts` and `security.test.ts:95-112` stay
green; a sidecar test (fixture with `bibliography:` and no folder →
warning, no bib; attach folder → bib loaded; save → fence present, key
gone). Browser specs in the gate: `tests/source-view.spec.ts`,
`tests/persistence.spec.ts:743-755`.

### Wave 3 (after wave 2; steps 8 and 10 in parallel — they share no files — then 11)

**Step 10 — The referee** (after 4, 6, 7). `src/md-parity.test.ts`
(registered by existing): finds pandoc on `PATH`, at `$PANDOC`, or at
Quarto's two arch paths; if none, prints `md-parity: skipped (pandoc not
found)` and exits 0; `PANDOC_REQUIRED=1` turns the skip into a failure;
checks `pandoc-api-version` major 1.23 and skips with a notice otherwise;
for every `tests/fixtures/md/*.md`, runs `pandoc -f markdown-smart -t
json`, reduces both sides with `md-skeleton.ts`, and fails on the first
non-accepted divergence with both skeletons printed around it. The
accepted list is short and each entry says why the format cannot heal it:
a comment on the line directly after paragraph text (block to
markdown-it, inline to pandoc); pandoc's citation mode (author-in-text
versus bracketed; Plass has no author-in-text form). `scripts/
pandoc-parity.ts` runs the same comparison on a file or folder, for the
course corpus. `package.json`: `"test:parity": "PANDOC_REQUIRED=1 node
--import tsx src/md-parity.test.ts"`. `deploy.yml`: just before
`npm test`, install `pandoc-3.4-1-amd64.deb` from the pandoc 3.4 release
with its sha256 checked, `continue-on-error: true` on the INSTALL step
only, so the ordinary `npm test` run gates on the referee and a flaky
download degrades to the visible skip notice; add the pinned typst
0.14.2 release tarball the same way for step 9's compile test. The
separate "forced" step from the first draft is gone (it would have been a
duplicate). `tests/port-audit.spec.ts`: built-in fixtures gain `guide.md`
read via `new URL('./fixtures/md/guide.md', import.meta.url)`, and the
`comments.md` entry's page break becomes `\newpage` (recorded as a gained
test, not a regression: the `.md` twin has always held an island there).
`scripts/md-corpus.ts` gains the Kinds `fenced div`, `comment` and
`front matter`.

**Step 11 — Docs** (after everything else). `AGENTS.md` ("Formats"
rewritten; the Editorial comments bullet's "plain HTML comments keep
their old meanings" reversed, the hoist rule added; the Tolerated tier
sentence; Commands line 9), `README.md` (every `.typ`-native statement,
found by grepping for `.typ`, `mitex`, `typst compile`, "Typst on rails"
rather than by the line numbers the first draft listed; one new
"Formats" bullet pointing at `docs/MARKDOWN-FORMAT.md`), `ROADMAP.md`
item 2 (the exit criterion now includes the referee on the course
folder), `CONTRIBUTING.md` and `RELEASING.md` ("Typst round-trip" →
"Markdown round-trip and Typst export"; `npm run test:parity` in the
local sequence), `SOURCE-VIEW.md` decision 2 ("an unsaved document shows
Typst" → Markdown; "Markdown front matter is left alone" stays) — this
step alone owns prose docs — and a reconciliation of
`docs/MARKDOWN-FORMAT.md` against what steps 6, 7, 8 and 10 landed. Taylor
refreshes the git-ignored `CLAUDE.md` from `AGENTS.md` afterwards (or
replaces it with a pointer so the two cannot drift).

**Step 8 — `.md` is the default; UI** (after 7 and 9 have merged; shares
no file with step 10). Files also include `src/style.css` (the md-raw
margin tag) and `src/source-view.ts:136` (the "kept as source" toast). `file-manager.ts`: `fileFormat`
default and `newDoc` → `'.md'`; `adoptFolder('open')` ranks `.md` over
`.typ` (newest within the winning extension); `attachRestoredSession`
decides the conflict on `serialize(parse(diskText))` with a no-op warner
(disk baseline stays the raw text), so a never-edited hand-written file
reconnects clean instead of reporting "changed outside Plass"; `serialize`
keeps a `lastWarned` set per handle and toasts only new messages (cleared
on handle change), ending the per-flush re-toast; `rename` passes `dir`
to its two `last`/recents writes; the data-URL hint moves here (once per
file, per-image wording). `index.html:12` (`Plass.md`), `app/plass.json`
(`defaultDocument: "Untitled.md"`), `app/smoke.mjs` (`smoke.md` with a
Markdown body; title check unchanged), `settings.ts:641` hint, open and
reload toasts for `.md` files ("N block(s) kept as source"; settings
warnings worded as warnings), island chrome (`inline-raw.ts` title by
`lang`; the `md-raw` margin tag "markdown · printed as code"),
`source-editor.ts:283-335`: a `:::` line node styled
`processingInstruction` (dimmed like other markup) — no YAML fold
(`SOURCE-VIEW.md:111-112` stands, `source-view.spec.ts:548-555` stays).
Demo prose at `demo-doc.ts:136,191-196` no longer promises a
mitex-wrapped `.typ` (the `typ-parser.test.ts` byte-identical round trip
must stay green). Specs: `tests/persistence.spec.ts` (`Plass.md` at 54,
335, 345; 358 stays `Plass.typ`; a hand-written `.md` with straight
quotes, `--` and a wrapped paragraph reloads with no conflict and
unchanged disk bytes; a folder holding `X.md` and a newer `X.typ` opens
`X.md`), `tests/source-view.spec.ts` (the demo shows Markdown: `# Plass`,
Mod-b wraps `**…**`, mode memory keyed `.md`, `:104`/`:139` in Markdown
forms; the `.typ` fold tests at 521-546 and 557-572 re-seeded with
`Paper.typ` through `openSeeded` as 574 does), `tests/md-comments.spec.ts`
(the `MD_FILE` run on a course note), `tests/pwa.spec.ts` if its fixture
name matters. `SOURCE-VIEW.md` is step 11's.

### After the merge

**Step 12 — Course conversion** (outside the repo, Taylor's). Open each
`*_sols.typ`, Export → Markdown, open the `.md`, run
`scripts/pandoc-parity.ts` and `scripts/md-corpus.ts` on the folder,
archive the `.typ` per the course rules; move `render-sols-figures` to
`figures/*.svg` when the folder is attached.

**Step 13 — `.typ` import-only** (required, after step 12; ends the
bounded departure). `loadHandle` on a `.typ` parses with `typToDoc`,
sets `fileFormat` `'.md'`, `name` = stem, keeps `dir`, leaves `handle`
null and marks dirty; `save()` adopts the known `dir` through
`adoptFolder('save')` when `dir` is set and `handle` is not; recents and
the one-window guard are not registered for the `.typ`; the folder-open
rule from step 8 keeps an opened `.typ` from being the export beside its
own source. The five save-semantic `.typ` specs (rewind, the two-window/
rename/launch persistence tests, source-view autosave and fold, fallback)
move to `.md` fixtures with YAML headers; the pure layout specs keep
their `.typ` fixtures.

### Wave 4 (after 11)

**Step 15 — Native-Typst math export** (required; design in appendix A).
Translate each formula with mitex's own WASM converter driven from JS,
emit `$ … # Pandoc Markdown as the on-disk source: the plan

Date: 2026-10-04, revision 3 (Taylor approved the proposed answers on
2026-10-04: 1–10 as proposed, 7 amended to make native-Typst math a
required final step, 11 pending). Rewritten to match
`docs/MARKDOWN-SOURCE-BRIEF.md` (the governing decision; where this file
and the brief disagree, the brief wins, and the three places this plan
asks to depart from it are marked **departure**). Reviewed against the
working tree at `b8148de` with seven subsystem maps of `src/`, `tests/`,
`scripts/`, `app/` and the docs, then put through a six-lens adversarial
review whose 51 confirmed findings are folded in below. Probes ran on
pandoc 3.4 (Quarto's binary at `/Applications/quarto/bin/tools/aarch64/
pandoc`), typst 0.15.1 (Homebrew), typst 0.14.2 (the in-app compiler's
version, as the official release binary), markdown-it 15.0.2 (the reader
Plass uses) and Plass's own `mdToDoc`/`docToTyp`. Every pandoc, markdown-it
and mitex claim below was run, not asserted.

Status: a plan. Nothing in it is implemented. Phase 2 implements it with
worktree-isolated subagents, one per step, each adversarially reviewed
before merge, with the merge gate below green after every merge. Commit
locally only; never push; no attribution lines in commits.

Repo state to repair first (a review agent ran a merge simulation in the
real checkout): `main` carries one stray commit `140086c` that appends a
nonexistent `src/md-divs.test.ts` to the `npm test` chain (so `npm test`
is red at HEAD), and four empty branches exist. Taylor runs
`git reset --hard b8148de` (the two untracked docs survive) and
`git branch -D step-md-divs step-md-frontmatter step-md-skeleton
step-md-tables`. Nothing was pushed; identity and config are intact.

## The decision, restated

Pandoc Markdown is the on-disk source of truth. The document model
(`schema.ts`), the Typst serializer (`typ-serializer.ts`, which does not
change what it emits apart from the mitex pin and one deleted
Markdown-only helper), the compiler worker, the paginator and the port
audit do not change. The pipeline is

    .md on disk -> mdToDoc -> doc model -> docToTyp -> Plass compiler -> PDF

The `.typ` is an export (Export → Typst). **Departure, bounded:** until
step 12 has converted the course corpus, an opened `.typ` still autosaves
as `.typ` (the brief says the `.typ` is "never the file anyone edits");
step 13 ends that and is a required step sequenced after step 12. The
`.typ` reader stays as an importer throughout.

The three principles hold as written in the brief: pandoc is the
language and Typst the renderer; pandoc is a content referee
(`pandoc -t json` against `mdToDoc`), never a renderer, and there is no
Lua filter; content parity and visual parity are two different things
and only the first changes here.

## What this rewrite changes from the first review

- No Lua filter and no pandoc PDF compile. The referee is the JSON
  skeleton comparison only. Bare pandoc cannot compile a document with
  `@eq:x` references, so a PDF smoke would fail on most real files.
- No raw-Typst fallback for tables. Everything a pipe table cannot say is
  an attribute on a `::: {.table …}` div, including cell fills, spans,
  row rules and decimal columns. The one thing dropped is the `params`
  attr (verbatim `#table` arguments only the `.typ` importer produces):
  a `.md` save warns and drops it.
- The exported-`.typ` math question is answered with evidence (below).
  The brief's premise that mitex's converter output is native Typst is
  only half true.
- Fences follow pandoc's spelling: ```` ```{=typst} ```` is the hatch,
  ```` ```typst ```` is a code listing, ```` ```{=bibtex} ```` is the
  bibliography, ```` ```bibtex ```` is a code listing. No transitional
  reading. The ground is pandoc's semantics plus the facts on disk: the
  course folder (466 `.md`) holds no ```` ```typst ```` fence, and the
  only three such fences under `~/Projects` hold `#pagebreak()` or a
  `#text` block, which Plass already reopens as islands today (the
  brief's "no back-compatibility" sentence is scoped to `.typ`, so this
  is argued on its own grounds, not borrowed from it).
- Blank lines are always written around `:::` and around comments. The
  reader accepts an opener with no blank line before it but warns on
  open (pandoc reads that opener as text); the referee reports it as a
  divergence, not an accepted one, since the first save heals it.
- The abstract moves to YAML `abstract:` and is parsed as Markdown on
  both sides; title/author/date go through the same inline path as body
  text; a roman front-matter restart gets a YAML key; the bibliography
  fence is written where the bibliography node sits.
- Nested and inline comments are never printed: they are hoisted to the
  nearest top-level position on read (below).

## Verified facts this plan rests on

Pandoc 3.4, default `markdown` reader (extensions `fenced_divs`,
`raw_attribute`, `tex_math_dollars`, `footnotes`, `pipe_tables`,
`strikeout`, `yaml_metadata_block`, `implicit_figures`, `link_attributes`,
`citations`, `smart`, `header_attributes`, `bracketed_spans`,
`native_divs`, `subscript`, `superscript` are on):

- `::: solution`, `::: {.solution}`, `::: center`, `::: {.keep}`,
  `::: {.columns gutter=1em cols=2}` with nested `::: {.column width=60%}`
  (quoted or bare values), and `::: {#tbl:t .table caption="Cap"
  density=compact}` wrapping a pipe table all parse as `Div` with id,
  classes and key–values intact; the table inside is a `Table` with
  per-column alignment from the delimiter row. A multi-line attribute
  block (continued until the closing `}`) is accepted. An OPENER with no
  blank line directly after a paragraph line is paragraph text; closers
  and dense nesting parse fine.
- `$$ … $$ {#eq:x}` parses as `DisplayMath` followed by a literal
  `Str "{#eq:x}"` in the same `Para`; `{.unnumbered}` and
  `{#eq:x .unnumbered}` likewise (two `Str`s); a label on the line after
  the closing `$$` lands in the same `Para` after a `SoftBreak`. Inline
  math may span a soft line break (`$a +\nb$` is `Math "a +\nb"`).
- `# H {#sec:x}` → `Header` id. Pandoc makes a `Figure` only for a lone
  image with NON-EMPTY alt: `![Cap](f.svg){#fig:f width=60%}` → `Figure`
  with id and an `Image` carrying `width`; `![](f.svg)`,
  `![](f.svg){#fig:g width=60%}` and `![](data:image/svg+xml;base64,…)`
  → `Para [Image]` with id and width on the image; an image with text
  around it is an inline `Image`.
- `\newpage` and `\pagebreak` alone → `RawBlock tex`;
  ```` ```{=typst} ```` → `RawBlock typst`; `` `…`{=typst} `` →
  `RawInline typst`; ```` ```{=bibtex} ```` → `RawBlock bibtex`
  (anywhere in the body); ```` ```typst ```` and ```` ```bibtex ```` →
  `CodeBlock`.
- `<!-- … -->` → `RawBlock html` at top level and inside a div, list
  item or blockquote; `RawInline html` inside a paragraph, a table cell
  or a footnote; `--` and `&` inside are kept verbatim, entities are not
  decoded; `<!-- a --&gt; b -->` is one comment. A comment on the line
  directly after paragraph text is an inline raw to pandoc but a block
  to markdown-it. A plain `<div>…</div>` is a `Div` (`native_divs`); a
  non-div HTML element is `RawBlock` + `Plain` + `RawBlock`.
- `[@key]` → `Cite` with `NormalCitation`; bare `@key` or `@eq:x` →
  `Cite` with `AuthorInText`; `[@a; @b]` → one `Cite` holding two
  citations; `[see @c, p. 3]` → prefix "see", suffix ", p. 3";
  `[-@c]` → `SuppressAuthor`; `[@a][@b]` is read as a reference link, so
  adjacent citations must be written as one group.
- `$|x|$` inside a pipe-table cell is math `|x|` (an unescaped pipe
  inside math does not split the cell); `` `a|b` `` in a cell is
  `Code "a|b"` to pandoc but markdown-it (GFM) splits the cell on that
  pipe; `` `c\|d` `` is `Code "c\\|d"` to pandoc and `c|d` to markdown-it.
  A headerless pipe table is written with a blank header row
  (`|   |   |`), which pandoc reads as an empty `TableHead`; markdown-it
  reads it as a header of empty cells.
- `H~2~O` → `Subscript`, `x^2^` → `Superscript`, bare `@plass` → a
  citation; `H\~2\~O`, `x\^2\^`, `\@plass` → plain text, and markdown-it
  reads those escapes back as the bare characters.
- YAML: `plass:` nested maps → `MetaMap`; flow maps → `MetaMap`; `author:`
  list → `MetaList`; `abstract: |` → `MetaBlocks` PARSED AS MARKDOWN
  (math, emphasis, citations inside); `title:` → `MetaInlines` likewise.
- With `smart` on, pandoc reads `'90s` as `’90s` and re-reads a written
  `‘90s` as `’90s`, keeps `-3` straight, keeps an escaped `\"` straight,
  reads `5'11"` as `5’11”`, and keeps the space before `[^1]`. Plass
  holds Typst's forms: `−3` (U+2212), `“hi”` even for `\"`, `‘90s`,
  `5′11″` and no space before a footnote marker. With `-f markdown-smart`
  every one of these comes back from pandoc as plain `Str`.
- `~~x~~` → `Strikeout`; `{++ x ++}` → text; `\_\_\_` → `Str "___"`;
  `: Caption {#tbl:x}` after a pipe table is caption text with a literal
  `{#tbl:x}` in 3.4.

markdown-it 15.0.2 (Plass's reader, `{html: true}` + footnotes): the
default `validateLink` rejects every `data:` URL except
`data:image/(gif|png|jpeg|webp)`, so an SVG data-URL image is DROPPED by
`mdToDoc` today (the demo's own figure does not survive a `.md` trip).
Inline math is matched per source line (`md-parser.ts:172-185`), so
`$a +\nb$` is prose today and the next save escapes the dollars.

mitex and Typst versions:

- The in-app compiler is typst.ts 0.7.0 = **typst 0.14.2**
  (`vendor/typst/Cargo.toml`, `sidecar/Cargo.toml`). Taylor's CLI is
  0.15.1.
- mitex **0.2.5** (the pin in `src/typst-config.ts`) warns on 0.14.2
  (`kai` deprecated) and **fails** on 0.15.1 (`unknown variable: kai`,
  `specs/latex/standard.typ:1045`) — the brief's gap, reproduced.
- mitex **0.2.7** (registry, April 2026; 0.2.6 was the `kai` fix)
  compiles cleanly on 0.14.2 and on 0.15.1. On 0.14.2, with math-ink's
  exact wrapper, every renamed symbol in the 0.2.5→0.2.7 spec diff
  (about 25, `\partial` included) and thirty ordinary course formulas
  render byte-identical SVGs with identical `measure().width`. Known
  0.2.7 differences: `\colorbox` gains an inset (+6 pt advance),
  `\KaTeX` changes width, and `\smash`, `\mathscr`, `\nleqq` and other
  negated relations compile where 0.2.5 errored. None of those appear in
  the demo, the fixtures or the 942-file course corpus (which uses
  `\partial` and nothing else that moved). Tarball
  `https://packages.typst.org/preview/mitex-0.2.7.tar.gz`, 111,899
  bytes, sha256
  `0159e214845e49cbdc332d9d572da112dae5ad248072e0a7680d38c8307c2e15`.
- Typst 0.15 itself changed math layout (underbrace/overbrace, the
  calligraphic alphabet, op spacing, binom, cancel): a Plass export with
  `\mathcal{L}` or `\underbrace` lays out differently on 0.15.1 than on
  the in-app 0.14.2, with or without mitex. The export is exact for
  0.14.2 and compiles on 0.15.x.
- mitex's converter output is **not self-contained Typst**: `mimath`
  evaluates it with `scope: mitex-scope`, and the output names scope
  entries (`mitexsqrt`, `mitexmathbf`, `mitexunderbrace`, `#textmath[…]`,
  `operatorname`, `aligned`, `pmatrix`, a `frac` handle). `standard.typ`
  has 95 handle/symbol definitions that need a prelude and ~440 pure
  aliases. The WASM converter runs from Node with a 15-line host shim,
  and its output for 30 formulas compiled natively on 0.15.1 with an
  8-definition prelude.
- A `.typ` holding `image("data:…")` does not compile on any CLI ("File
  name too long"); with the image written to `figures/` and
  `--ignore-system-fonts --font-path public/fonts` the demo export
  compiles with no diagnostics on 0.14.2 and 0.15.1 (every family the
  serializer can emit, New Computer Modern and DejaVu Sans Mono, is in
  the CLI's bundle; adding the in-app `fontFallback` tuple would only add
  an "unknown font family: stix two text" warning on the CLI).

Codebase facts that shape the steps (file:line as of `b8148de`; later
steps cite by heading where line numbers will have drifted):

- `md-parser.ts` (529 lines) extracts math before markdown-it, reads
  only `title|authors?|date` scalars from YAML (69-93, straight quotes
  and YAML escapes untouched), hoists every lone image into a block
  `figure` (294-297, 345-351), never reads heading labels, figure
  labels/widths, `numbered`, blockquote `kind`, paragraph `align`/`keep`
  or any setting, reads ```` ```typst ```` as a grid via `parseGridCall`
  or an island (362-369), makes every untagged HTML block an `md-raw`
  island at any depth (428-448; `parseBlocks` recurses), reads only
  `[@key]` and colon-bearing bare `@a:b` (228), and does not read
  `::: ` divs at all. `md-serializer.ts` (317 lines) writes page breaks,
  restarts and grids as ```` ```typst ```` fences (255-263), escapes
  every `|` in a cell including inside math (176), leaves single `~`,
  `^` and `@` unescaped (52-66), writes title/author/date as
  `textContent` (36-38, so inline math in a title is dropped), joins
  quoted paragraphs with `\n>\n` and then prefixes every line (220, 225,
  producing a `> >` line that reads back as a nested empty quote),
  appends the bibtex fence at the end regardless of node position
  (313-314), and carries twelve `warn(` sites, six of them saying "save
  as .typ to keep …" (47, 138, 166, 197, 217, 248; 197 is the `align`
  warning; `keep` is dropped silently).
- `schema.ts`: `editor_comment` is admitted only by `doc` (364-378,
  521-533); `math_display {src, label, numbered: true|false|null}`
  (99-123); `figure {src, label, name, title, widthPct}` (125-164);
  inline `image {src, alt, title, widthPct}` (438-456), produced today
  only by the `.typ` reader for a bare `#image(...)`; `heading {level,
  label}` (457-470); `paragraph {keep, align}` (393-419; `keep` toggled
  by ⌘⌥K in `editing.ts:275`, `align` by the Extras › Alignment group
  in `toolbar.ts:616-680`, both round-trip in `.typ` via
  `typ-parser.ts:395-397, 553-568`); `blockquote {kind}` (420-437);
  `grid {columns: number[], gutter}` over `grid_row > grid_cell`
  (311-362; shares are stored verbatim, `grid-editor.ts:25-33` accepts
  `60/40` → `[60, 40]`); `table {style, params, caption, label,
  fontSize, density, columnWidths, insetPt}`, `table_row {rule}`, cells
  `{colspan, rowspan, align incl. 'decimal', valign, fill}` (248-278,
  380-392, 471-520); `code_block {params, tight}` (534-561);
  `abstract` is `paragraph+` (91-97); `doc {settings, bib, frontmatter}`.
- `settings.ts`: `DocSettings` (14-64), `normalizeSettings` clamps
  silently (198-256), `PaperName` incl. `half-letter`/`custom`
  (162-188); the roman front-matter restart is a `numbering_restart`
  NODE the panel inserts after block 0 plus any following
  title/author/date/abstract blocks (466-492).
- `file-manager.ts`: `fileFormat` defaults to `'.typ'` (111) and
  `newDoc` resets it (436); `serialize` picks the writer by file NAME
  and toasts each distinct warning on EVERY call (310-326), and is
  called by every autosave flush (1.2 s after any change, 255),
  `adoptFolder` (601), `downloadCopy` (871), `exportCopy` (890) and
  `attachRestoredSession` (905); `adoptFolder('open')` loads the NEWEST
  `.typ|.md` in the folder with no preference by extension (559-572);
  `exportCopy` saves instead of exporting when the open file is
  `${name}.typ` and otherwise writes `docToTyp(doc)` with no options
  through `serialize` (884-894); `attachRestoredSession` reports a
  conflict whenever a re-serialization differs byte for byte from the
  disk text (905-916), which every tab reload of a hand-written file
  hits; `pdf.ts` compiles with `{resolveImage, fontFallback, islands:
  'print'}` (248, 298-302); `migrateEmbeddedFigures` (`figures.ts:191`)
  is dead code (its `onProjectKept` wiring was removed in 578fd6e), so
  a data: figure in a folder is a normal state; `dataUrlToBytes`
  (`pdf.ts:33`) and `projectImagePath` (`figures.ts:903`) are the
  existing decoders/namers, unexported.
- `source-view.ts:494-506` discards parsed settings for every `.md`
  round trip and keeps `bib` only when JSON-equal; `preambleEnd`
  (`source-view.ts:171-172`) folds only a `.typ` preamble;
  `source-editor.ts:283-335` is the Markdown highlighter extension where
  a `:::` block node is added; `SOURCE-VIEW.md:111-112` records
  "Markdown front matter is left alone".
- `typeset-plugin.ts:1460-1483`: comment heights are a top-level
  `doc.forEach` keyed at the note's end; `block-layout.ts:134`,
  `page-oracle.ts:177`, `port-audit.ts:82`, `collapse-spaces.ts:204`
  special-case `editor_comment` by name at the top level.
- `typ-parser.ts` is imported by `main.ts` (`migrateLegacyTableGeometry`)
  and `md-parser.ts` (`parseGridCall`, which is also used in-file at
  771, so knip keeps it under `ignoreExportsUsedInFile`);
  `blockToTypStandalone` (`typ-serializer.ts:918-933`) has no in-file
  use and its only caller is the md grid fence, so it must be deleted,
  not un-exported (`check:unused` flags an unused local, knip flags an
  unused export). `npm run build` fails on unused exports, unused locals
  (src only) and import cycles.
- `npm test` is a hand-maintained `&&` chain in `package.json:37` (31
  suites; the on-disk `src/**/*.test.ts` set is exactly those plus the
  four `test:layout` suites). Playwright runs every `tests/*.spec.ts`
  but the audit; `deploy.yml` gates on `npm test`, `test:layout` and
  `test:browser`, with only the audit `continue-on-error`.
- Tests that assert the CURRENT lossy dialect: `md-round.test.ts`
  (120-127 page-break island, 222-251 and 297-305 comment islands,
  263-272 inline HTML, 328-340 grid fence, 342-354 image/table
  warnings), `editor-comments.test.ts:85-91`, `table-integrity.test.ts:
  177-211` (three "degradation" asserts), `tests/md-comments.spec.ts:
  47-60` (islands and byte identity), `tests/editor-comments.spec.ts:
  357-374` (the tagged frame written). Tests pinning the `.typ` default:
  `tests/persistence.spec.ts:54, 335, 345` (358 asserts
  `exportCopy()`'s download name, which stays `Plass.typ`),
  `tests/source-view.spec.ts` (demo is Typst: 96-104, 139, 521-546,
  557-572; title literal at 231, 487; 548-555 asserts a `.md` with YAML
  has no fold), `tests/export-beside.spec.ts:28, 57, 86` (tile title),
  `index.html:12`, `app/plass.json` (`defaultDocument: "Untitled.typ"`),
  `app/smoke.mjs` (`smoke.typ`). About a dozen layout specs load `.typ`
  fixtures through `__fm.loadHandle` and keep working while the reader
  exists; five specs assert SAVE semantics on a `.typ` handle (rewind,
  persistence two-window/rename/launch, source-view autosave and fold,
  fallback). `tests/port-audit.spec.ts:320` writes the `comments.md`
  fixture's page break as a ```` ```typst ```` fence, which has always
  reopened as an island (the `.md` twin never exercised the seam).
- `CLAUDE.md` is git-ignored and stale (2026-09-30); `AGENTS.md` is the
  committed instruction file and the one subagents in a worktree see.
  Doc edits go to `AGENTS.md`; Taylor refreshes `CLAUDE.md` locally.
- Course corpus (`~/Projects/econ-0100`, `~/Projects/ECON_0100`; 942
  files): 873 HTML comments, all at column 0; no `:::`; no citations or
  bibliographies; no abstracts; 38 `*_sols.typ` use bare `#image("data:…")`
  inside grid cells (never `#figure`); 3 comments contain `&`, none `--`.
- Baseline at `b8148de` is green: `npm test` (31 suites),
  `check:unused`, `check:exports`, `check:cycles`.

## Decision: the exported `.typ` and mitex

Decision: **pin mitex 0.2.7** (step 0) in the app and the export. It
closes the gap the brief names — the exported `.typ` compiles on a fresh
machine with a current typst — and the in-app A/B shows no rendering
change for any formula the documents use. Native-Typst translation
(Taylor: "I'd like it all to be basic Typst, unless that's a whole
research project") is a focused step, not a research project, and is the
required last code step of this plan (step 15, wave 4, appendix A); the
pin stays so the export compiles from day one and the in-app math path
changes only once the per-formula identity proof passes.

**Departure, named:** the pin is a change to the in-app math package
(`typst-config.ts`, `math-ink.ts`, the `docToTyp` header), which the
brief's "compiler … exactly as they are" reads against. A split pin
(0.2.5 in the app, 0.2.7 in the export) would make the export a file
Plass never compiled and need two entries in the package policy and the
security docs; 0.2.5 is dead on typst ≥ 0.15 and the in-app typst.ts
will follow. The honest proof is the per-formula A/B in step 0, not the
audit (after the bump both sides of the audit use 0.2.7, so its agreement
proves self-consistency, not "no page changes").

**Departure, named:** the registry pin is neither of the brief's two
options. A `.typ` cannot inline a WASM plugin, so "vendor" would mean a
sidecar `mitex/` folder; the pin to a registry version the typst CLI
fetches itself is the standard Typst way. Its two failure modes — no
network on first compile, and a future typst release breaking 0.2.7 the
way 0.15 broke 0.2.5 — are accepted until appendix A, and the second is
caught by the compile check in step 9 at the moment the pin is bumped.

Why not translate now, given the brief prefers it "if tractable": mitex
does not emit native Typst; it emits Typst that evaluates inside
`mitex-scope`, so "emit its output" means shipping a Plass-owned prelude
of ~95 definitions in every export and compile. And an export whose math
source differs from the compiled source stops being "the source Plass
compiles" unless the native form is proven layout-identical per formula
— the same proof appendix A requires — so translating at export time
alone buys nothing until that proof exists. Note that native translation
would NOT close the 0.14/0.15 layout difference: native `cal` and
`underbrace` moved in 0.15 exactly as the mitex forms did; only the
version pin addresses that.

**Typst version for the export (answers Q6):** the export is exact for
**typst 0.14.2**, the in-app compiler's version, and compiles on current
0.15.x. One constant beside the package policy in `typst-config.ts`
(`TYPST_EXACT_VERSION = '0.14.2'`, bumped with typst.ts upgrades) is
printed in the export's header comment (`// Exported from Plass — exact
on typst 0.14.2`) and quoted in `docs/MARKDOWN-FORMAT.md` and the README.
A self-skipping node test (step 9) compiles the exported demo with
`typst` from `$TYPST` or `PATH` when it is 0.14.x or 0.15.x; CI installs
the pinned 0.14.2 release binary (sha256-checked) for it, non-blocking.

Export mode: `exportCopy` builds its text with `docToTyp(doc, {islands:
'print', resolveImage})` directly, not through `serialize`, so the
exported `.typ` is the source Plass compiles (islands printed as code,
editorial comments absent) minus the in-app `fontFallback` tuple, which
on the CLI only adds a warning. Embedded images are written to
`figures/` beside the export with the path emitted (step 9); with no
folder the data URL stays and the toast says the export needs a folder to
compile elsewhere. The `exportCopy` branch that turns Export → Typst into
a save of an open `.typ` goes now (a toast says to export Markdown
first), so the only `.typ` the Export menu ever writes is the parity
file. An export is for compiling and reading; reopening it in Plass
reads its islands as plain listings (documented in MARKDOWN-FORMAT.md).

## The format

Normative for the implementer, `docs/MARKDOWN-FORMAT.md` (step 5) and
the referee. Quarto's names where Quarto has one, pandoc's where pandoc
has one; Plass meaning only in class names and under `plass:`.

### Front matter

```yaml
---
title: "Vignette B3 | Solutions"
author: "Taylor J. Weidman"     # a YAML list is read too and written back joined with ", "
date: 2026-10-04
abstract: |
  Parsed as Markdown on both sides: $\beta$, *emphasis*, [@key] all work.

  Paragraphs are separated by a blank line.
papersize: us-letter            # us-letter | a4 | us-legal | iso-b5 | a5; omitted for half-letter/custom
margin: {top: 1in, right: 1in, bottom: 1in, left: 1in}   # written as the dict; a scalar is read
fontsize: 12.5pt
mainfont: New Computer Modern   # the stored preference; rendering still resolves to a certified font
section-numbering: "1.1"        # present = numberSections
bibliography: references.bib    # read once from a sidecar (below); never written
linestretch: 1.5                # pandoc's name for line height
indent: true                    # pandoc's name for first-line paragraph indent
bibliographystyle: ieee         # Quarto/pandoc's Typst-template name; ieee | apa | chicago-author-date
plass:                          # only non-default values are written
  page: half-letter             # or {width: 5.5in, height: 8.5in}
  landscape: true
  hyphenate: false
  number-equations: false
  page-numbers: {show: true, format: "1", align: center, place: bottom, start: 1, front-matter: roman}
  header: {text: "{section}", align: right, first-page: false}
  footer: {text: "Econ 0100 · {page}", align: center, first-page: true}
  footnotes: {numbering: "1", separator: rule}
  math-macros: |
    \R = \mathbb{R}
---
```

Rules:

- title, author, date and abstract are written whenever the nodes exist,
  through the same inline/block writer as body text (a title with `$x$`
  or `*em*` keeps it); they are read through the same inline/block
  reader as body text (math pre-pass, markdown-it, `printedForm`,
  `smartenInline`), so a hand-written `Taylor's -- draft` imports as
  `Taylor’s – draft` exactly as it would in the body. Scalars are
  written in the YAML form that needs no backslash escaping (plain when
  safe, else single-quoted with `''` doubling); `\"` escapes in a
  double-quoted scalar are decoded on read. Values holding `{section}`
  or `{page}` must be quoted in YAML (pitfall in MARKDOWN-FORMAT.md).
- Every other known key only when its value is not the default;
  `margin` in the dict form; units `in`/`mm`/`cm`/`pt` read, `in` and
  `pt` written.
- Unknown keys and `#` comments are carried verbatim in order
  (`doc.attrs.frontmatter`, as today) and written back after the known
  keys. Out-of-range values are clamped by `normalizeSettings` AND
  reported as import warnings, shown by the open toast as warnings, not
  as "raw blocks".
- `page-numbers.front-matter: roman` is the `numbering_restart` node.
  The reader inserts it where the settings panel does (after block 0
  plus any following title/author/date/abstract blocks); the writer
  emits the key when the node exists anywhere. A node elsewhere moves to
  that position on the next open (documented); the reader warns when
  the key is present but the document has no front-matter block.
- `bibliography:` is a one-way import. `mdToDoc` stays synchronous and
  returns the path in `MdImport.bibliography`; the FileManager's open
  paths and `attachFolder` then read the sidecar through `readAsset`
  (4 MiB limit) and dispatch `setDocAttribute('bib', …)`; a Finder/PWA
  launch without a folder gets the existing "grant folder" toast for it.
  The writer never writes the key or a sidecar: it always embeds the
  `{=bibtex}` fence at the bibliography node and drops the key, with a
  one-time toast. (A persistent sidecar for a BibDesk workflow is a
  separate later step: it needs a provenance attr, read-only semantics
  and a watcher.)

### Blocks and inlines

| Node | Form | Notes |
|---|---|---|
| `blockquote{kind:'solution'}` | `::: solution` … `:::` | also read `::: {.solution}`; blank line before and after |
| `grid` | `::: {.columns gutter=1em cols=2}` holding every cell row-major as `::: {.column width=60%}` | **departure**: one div per GRID, never per row, never merged (below); `cols=N` always written; equal shares write no `width` |
| `paragraph{align}` / `paragraph{keep}` | `::: center`, `::: right`, `::: {.keep}` (classes combine: `::: {.keep .center}`) around exactly one paragraph | the rail for the two features the brief's list omits; any other content inside → the unknown-div island |
| `blockquote` | `> …` | quoted paragraphs are separated by a bare `>` line (today's `> >` bug fixed) |
| `editor_comment` | `<!-- … -->` at top level | every HTML comment; written verbatim except `-->` → `--&gt;` (decoded on read); the tagged `<!-- plass:comment` frame is still read with its old decoding, never written |
| nested or inline comment | hoisted (below) | kept, unprinted, moved to the nearest top-level boundary on first save |
| `math_display` | `$$` … `$$ {#eq:x}` | `{.unnumbered}` → `numbered:false`, `{.numbered}` → `numbered:true`, combined `{#eq:x .unnumbered}`; the attribute block on the closing line or the next line |
| `math_inline` | `$…$` | pandoc's rules; may span one soft line break (reader fixed) |
| `heading` | `# Title {#sec:x}` | `{-}` is read as `.unnumbered` and ignored |
| `figure` | `![caption](src){#fig:x width=60%}` alone; a labeled figure with an empty caption is `![](src){#fig:x}` (pandoc keeps the id on the image) | a lone image with an id is a figure; `width` as a percent only; a non-percent width warns and drops; `title` as `"title"` |
| `paragraph > image` | `![](src){width=60%}` alone, empty alt | pandoc's `Para [Image]`; the course's bare `#image("data:…")` form, un-numbered, no label |
| `image` (inline) | `![alt](src "title"){width=40%}` inside text | |
| `table` | pipe table, optionally inside `::: {.table …}` | grammar below; a `: Caption` line after a table is read as its caption too |
| `page_break` | `\newpage` alone in a paragraph | also read `\pagebreak` |
| `numbering_restart` | YAML `plass.page-numbers.front-matter: roman` | see above |
| `code_block{params:'typst-raw'}` | ```` ```{=typst} ```` | the only block escape hatch; ```` ```typst ```` is a code listing |
| `typst_inline` | `` `…`{=typst} `` | inline HTML that is not a comment stays `typst_inline{lang:'html'}` (an inline island, titled "Inline HTML — kept, shown as code, never run") |
| `code_block{params:'md-raw'}` | an HTML block that is not a comment, or an unknown div, verbatim (the source slice from the opener's line to the closer's) | printed as code, margin tag "markdown · printed as code" |
| `citation` | `[@key]`; adjacent citations as one group `[@a; @b]` | pandoc's group grammar is read (below) |
| `eq_ref` | `@eq:x`, `@fig:x`, `@sec:x`, `@tbl:x`, bracketed or bare | pandoc-crossref's rule: a key with one of those prefixes is a reference; any other `@key`, bare or bracketed, is a citation |
| `bibliography` | ```` ```{=bibtex} ```` at the node's position | or `bibliography:` in YAML (read once) |
| `footnote` | `[^n]` + definition, or `^[inline]` | as today |
| `horizontal_rule` | `---` | |
| nbsp | U+00A0 written literally | pandoc's `\ ` is read as nbsp |
| lists, marks, `~~x~~`, `{++ ++}`, `\_\_\_`, hard breaks | standard | as today; `3.` start numbers already round-trip |

Grid shares: the model's shares are canonical — every share divided by
the smallest and rounded to 3 decimals — applied at every entry point
(`parseColumnShares`, `parseGridCall`, the `.md` reader), so `60/40`
is `[1.5, 1]` and `(2fr, 2fr)` is `[1, 1]`; ratio-equivalent lists are
SVG-identical on both compilers (verified), while `(33.333fr, 66.667fr)`
is NOT the same Typst as `(1fr, 2fr)` (it is not), so percentages are
never stored as shares. The writer omits `width` when every share is 1
and otherwise writes `share/sum` as a percent to 3 decimals; the reader
accepts `N%`, a bare number or `Nfr` and canonicalizes, so `33.333%`/
`66.667%` recovers `[1, 2]`. Gutter: `em` native; `pt`/`in`/`mm`/`cm`
converted at the document font size.

Grid rows (**departure**): the brief says "one `.columns` div per grid
row". Two adjacent one-row grids with equal shares and gutter are
indistinguishable in that form from one two-row grid, and the two are
different Typst (one `#grid` applies its gutter between rows; two grids
are separated by paragraph spacing — a 3 pt difference at 12 pt, on both
compilers) and different pages (the editor's `.ts-grid-row + .ts-grid-row`
margin). Merging on read would silently rewrite a shape the editor
produces in one click and break the step-6 equality test; not merging
would make every multi-row grid two grids. So a grid is exactly one
`::: {.columns …}` div holding all its cells row-major, with `cols=N`
always written (the row length is otherwise unrecoverable when equal
shares write no `width`). Pandoc preserves the attribute; Quarto would
render the cells in one row, which is irrelevant since pandoc is not a
renderer. Taylor's call (open question 11); the alternative is the brief's per-row
form with a continuation class on later rows (`::: {.columns .continued}`),
which needs no attribute and lets Quarto render rows, at the cost of a
referee merge rule; the course corpus has 12 two-row grids and 2 adjacent
equal pairs, so both rules are exercised by real files.

Citations: a bracket group `[…]` containing `@` is read by pandoc's
grammar — items split on `;`, each with optional prefix text, optional
`-`, `@key`, optional suffix text. Every key becomes a `citation` node
(or an `eq_ref` when its prefix is a label namespace); prefix, suffix and
the `-` are kept as plain text beside it (never dropped) with one import
warning per file ("citation prefix/suffix kept as text; Plass cites the
key only"). The writer writes a run of adjacent citation nodes as one
group. A bare `@key` with no namespace prefix is a citation (today it is
silently plain text and prints `@key` literally); a missing key paints
"[?] — not found in bibliography" on the page, visible. A real
supplement rail (`[1, p. 3]`) needs a schema attr and is a later step.

Table div grammar (every attribute optional; the div is written only
when at least one is set; a table with none is a bare pipe table; the
writer emits the opener on one line, the reader accepts an attribute
block continued over lines until the closing `}`):

```
::: {#tbl:x .table caption="Results" style=grid density=compact inset=9pt columns="auto 1fr 2fr" font-size=0.85em decimal="2" rules="1:light 3:none" fills="r0:gray-dark r3c1:yellow" valign="r1c2:middle" spans="r2c0:2x1" aligns="r2c1:center"}
| Name | Score | Note |
|:-----|------:|-----:|
| a    | 12.5  | x    |
| b    | 3.25  | y    |
| c    |       |      |
:::
```

- `caption`, `#id` (the label), `style` (`booktabs` default | `grid` |
  `plain`), `density` (`compact` | `roomy`), `inset` (points),
  `columns` (space-separated `auto` | `Nfr` | `Npt`), `font-size`
  (`0.9em` … `0.75em`) map one-to-one onto the table attrs.
- Column alignment comes from the delimiter row (pandoc `AlignDefault`
  and `AlignLeft` are the same to Plass); `decimal` lists the 0-based
  column indexes whose `---:` means `align:'decimal'` (a `decimal`
  column without `---:` warns on import); `aligns` carries the rare
  per-cell override.
- Header: the first pipe row is the header row (`table_header` cells).
  A table whose first Plass row is not a header is written with a BLANK
  header row (`|   |   |`, pandoc's documented headerless form) and all
  Plass rows as body lines; the reader drops a header row whose cells are
  all empty. A genuine header row of empty cells, and header cells
  below the first row, are written as body cells with a warning.
- Positions are 0-based written-grid coordinates: `rN` counts Plass
  rows (the synthetic blank header line is not a row), `cM` counts
  columns including covered cells; `fills`, `valign`, `aligns` and
  `spans` name the spanning cell's origin. `rules="N:light|heavy|none"`
  is `table_row.rule` of row N; `fills="rN:fill"` fills a whole row,
  `rNcM:fill` one cell; `valign="middle"` for the table or `rNcM:…`;
  `spans="rNcM:CxR"` (colspan × rowspan; the covered cells are written
  empty and skipped on read).
- Cells are one paragraph; a multi-paragraph cell is written joined by a
  space with a warning. `|` is escaped in plain text only, never inside
  `$…$` or backticks (pandoc's rule); the reader sentinelizes code spans
  in the pre-pass so markdown-it's GFM splitter never sees a pipe inside
  backticks (today `` `a|b` `` in a cell destroys the row).
- Dropped with a warning: `params`, footnotes, images and inline HTML in
  cells (the `.typ` exporter refuses those).

Nested and inline comments (hoisting): a `<!-- … -->` that is not a
top-level block — inside a solution, a column, a list item, a
blockquote, a table cell, a footnote, or inline in a paragraph — becomes
a top-level `editor_comment` placed at the nearest top-level boundary
(before the enclosing top-level block when it precedes all printed
content in that block, otherwise after it), order kept, with one import
warning per file naming the count ("N comment(s) moved out of nested
blocks"). The inline case removes the atom and lets the space normalizer
close the gap. The hoist runs over the tokens of ANY div before its
class decides what it becomes, and whole-line comments are lifted out of
an HTML-element island's line range, so a comment inside an unknown div
or a `<div>` block is unprinted too. A markdown-it `html_block` holding a comment plus trailing
text is split into the comment and a paragraph, as pandoc reads it. The
writer writes the comment at its hoisted position, so the file is
canonical after the first save. This keeps every comment unprinted (the
brief) with no schema, paginator, audit, normalizer or TeX change, and no
hidden content (the doctrine's one exception stays the one exception).
The documented limitation is the position move; step 14 keeps a comment
in place.

Escaping in prose: the writer escapes `@` before a word character,
`~` and `^` whenever another of the same follows on the line with no
whitespace between (pandoc's sub/superscript rule), `^` before `[`
(the inline-footnote opener), plus today's set. Readers decode all of
them to the bare character.

Normalizations applied at import and by the edit-time normalizer (not
by the writer, which writes what the document holds): straight quotes →
curly by Typst's quoter, `--`/`---`/`...` → glyphs, a whitespace-`-`-digit
→ U+2212, `5'11"` → primes, the space before a footnote marker dropped,
hard-wrapped paragraphs → one line. Of these, only paired quotes, dashes
and the ellipsis coincide with pandoc's `smart`; the minus sign, primes,
the apostrophe-before-digit case and the swallowed footnote space are
Typst's choices, which the referee folds (step 4). Also on first save:
`_em_` → `*em*`, list markers and indents, a blank line around every
`:::` and comment, YAML in the order above, `author` as one string,
`-->` inside a comment → `--&gt;`, nested comments hoisted. A
hand-written file is rewritten in these ways on its first Plass save and
never again.

## Proposed answers to the brief's open questions

1. **Solution class:** `::: solution`. Plain, readable, what the course
   files will say; Quarto's `callout-note` would render a box nobody
   asked for in Quarto and nothing in pandoc. (`::: {.solution}` reads
   the same.)
2. **Nested comments:** unprinted by hoisting (above). Step 14 (schema
   extension so a comment stays in place inside a solution block) is
   optional; the hoist makes it a precision improvement, not a
   correctness one. A comment in a table cell today makes the whole PDF
   export fail (the cell exporter throws on inline HTML); hoisting
   removes that too.
3. **Bibliography:** write the `{=bibtex}` fence (self-contained files);
   read the fence and `bibliography:` as a one-way import when a folder
   is attached. Only `{=bibtex}`, not ```` ```bibtex ````.
4. **Figures:** both forms supported; nothing automatic. The data-URL
   hint moves out of the serializer into the FileManager, fires once per
   file, and names the per-image action ("Save SVG to project" on the
   figure), not a folder the user just chose.
5. **Default format:** flips to `.md` in this plan (step 8).
6. **Typst CLI version:** 0.14.2 is the version the export is exact for
   (above); 0.15.x compiles it.
7. **Exported math:** pin mitex 0.2.7 now (step 0); native translation
   as the required step 15 after the Markdown work lands (appendix A).
   In plain terms: mitex is a plugin the export currently depends on to
   turn LaTeX into Typst math at compile time; step 15 writes the
   translated Typst math into the file instead, plus a short list of
   helper definitions at the top, so nothing is downloaded.

New questions this review found (answers proposed; Taylor overrides):

8. **Paragraph `align` and `keep`:** given the rail `::: center` /
   `::: right` / `::: {.keep}` (a few lines each side; pandoc parses
   them). Both are UI-reachable and round-trip in `.typ` today, so
   dropping them would be a chosen regression against "every current
   document feature survives".
9. **Opening a `.typ`:** stays a normal open until step 13 (required
   after step 12). "Open project folder…" prefers a `.md` over a `.typ`
   with the same stem (any `.md` over any `.typ` once `.md` is the
   default), newest within the winning extension, so the folder-open
   never lands on an export beside its source.
10. **The `{=typst}` hatch in the export:** printed as a code block
    (`islands: 'print'`), the same as the page and the PDF.
11. **Grid rows:** one div per grid with `cols=N` (the departure above),
    or a continuation class per row. The plan assumes the former.
12. **Repo repair:** the two git commands at the top, before any step.

## Steps

Merge gate, for every step, run by the merger on the MERGED main after
every merge: `npm test && npm run test:layout && npm run check:unused &&
npm run check:exports && npm run check:cycles && npx tsc --noEmit`, then
every Playwright spec the step's own file list names (`npx playwright
test tests/<spec>… --project=chromium`), and `npm run audit` after steps
0, 6, 7 and 10. The full `npm run test:browser` runs when a wave closes
and before Taylor pushes; `app/smoke.mjs` is verified by the deploy's app
job (or `npm run app:build && npm run app:smoke` locally). Each step's
reviewer receives the step's file list (any file outside it is a
finding), its acceptance list and this command list.

Prerequisites (a step branches from main once these have merged):
6 ← {1, 3}; 7 ← {2, 6}; 8 ← {7, 9}; 9 ← {0}; 10 ← {4, 6, 7};
11 ← everything else; 13 ← {12}. Waves below are the schedule that
satisfies them with no two in-flight steps editing one file; package.json
is edited only by the pre-step and by step 10 (one new script key).

### Pre-step (one commit on main before any worktree is cut)

**Glob test runner.** `scripts/run-unit-tests.ts` (about 15 lines): walk
`src` recursively, keep `*.test.ts`, drop the four `test:layout` suites
(`src/layout/port/{port-smoke,shape-cache,incremental-linebreak}.test.ts`,
`src/layout/font-certification.test.ts`), sort, run each with
`spawnSync('npx', ['tsx', file], {stdio: 'inherit'})`, stop at the first
non-zero status (today's `&&` semantics); `"test": "node --import tsx
scripts/run-unit-tests.ts"`. It reproduces today's 31 suites exactly
(verified against the on-disk set), is a knip entry (`scripts/*.ts`), and
means a new suite registers by existing, so no step edits the chain.

### Wave 1 (parallel; new modules and one export surface)

**Step 0 — mitex 0.2.7.** Files: `src/typst-config.ts` (version, url,
sha256 above; add `TYPST_EXACT_VERSION`), `src/typ-serializer.ts:1004`
(and the header comment at line 955 gains the exact-version note, which
changes line 1 of every `.typ` Plass writes — the one emitted-output
change besides the pin; `tests/source-view.spec.ts:535,585` loosen their
regexes to `/^\/\/ Exported from Plass[^\n]*\n#set page/`),
`src/math-ink.ts:245`, `src/security.test.ts:152`,
`tests/security.spec.ts:253-257` (the request-list literal),
`src/typ-parser.test.ts:357` and `src/source-typst-mode.test.ts:96`
(fixture literals), `README.md` ("One-click PDF export" and "Export"
bullets), `SECURITY.md`, `PRIVACY.md`. `typ-parser.ts:120` matches the
import by prefix and needs no change. Acceptance: (a) the A/B script —
extract every `#mi(`…`)` / `#mitex(`…`)` source from the exported `.typ`
of the demo, the test fixtures and the course folder, compile each with
the typst 0.14.2 release binary under both import lines using
`math-ink.ts`'s exact wrapper, assert identical SVG bytes and identical
`measure().width`, and list in the commit message any formula that
differs or that newly compiles (none expected); (b) `npm run audit` on
the math and table fixtures (mismatch 0, unmeasured 0), which proves the
port still agrees with Typst under the new pin, not that pages are
unchanged; (c) `npx playwright test tests/source-view.spec.ts tests/security.spec.ts
tests/atom-spacing.spec.ts tests/bold-math.spec.ts
tests/math-ink-recovery.spec.ts tests/native-tables.spec.ts`; (d) a
math-only fixture (no image; `\mathcal`, `\underbrace`, `\binom`,
`\operatorname`) exported and compiled with the 0.14.2 binary and with
0.15.1 (`--ignore-system-fonts --font-path public/fonts`), exit 0 and no
diagnostics on both — the demo itself cannot compile on any CLI until
step 9 extracts its data: image.

**Step 1 — Fenced divs and attribute blocks.** New `src/md-attrs.ts`:
parse and write pandoc attribute blocks `{#id .class key=val key="val"}`
and the bare-class form, shared by divs, headings, images and display
math; `{-}` reads as `.unnumbered`. New `src/md-divs.ts`: a markdown-it
block rule for `:::` openers (three or more colons, a bare class or an
attribute block, which may continue over following lines to its closing
`}`) and closers (three or more colons alone), nesting by depth, emitting
`div_open`/`div_close` tokens with the parsed attrs and source line maps,
tolerant of a missing blank line before the opener (and recording it so
the reader can warn), skipping fences and HTML blocks the way the math
pre-pass does, registered as
`md.block.ruler.before('table', 'div', rule, {alt: ['paragraph',
'reference', 'blockquote', 'list']})` (markdown-it-container's
registration) so a `:::` line terminates a paragraph, a pipe table, a
blockquote and a list item's lazy continuation, as pandoc's closers do
(verified: without the alt chains a closer right after a table row is
swallowed as a row). No integration into `md-parser.ts` yet. Tests
(`src/md-divs.test.ts`): nested divs, an opener with no leading blank
line (flagged), quoted and bare values, a multi-line opener, an id, an
unknown class, `:::` inside a code fence, an unclosed div (text, nothing
lost).

**Step 2 — Front matter.** New `src/md-frontmatter.ts`: a YAML subset
reader/writer with no dependency (plain, single- and double-quoted
scalars with their escapes, two-level block maps, flow maps, block
scalars `|`, lists, comments), returning an ordered list of top-level
entries where known keys are interpreted and unknown ones kept verbatim.
`readFrontmatter(text) → {titleMd, authorsMd, dateMd, abstractMd,
settings: Partial<DocSettings>, bibliography?: string, frontMatterRestart:
boolean, extra: string, warnings}` — the four text fields are raw
Markdown for step 7 to parse, never plain text — and `writeFrontmatter`
the inverse, emitting only non-default values in the fixed order above,
`margin` as a dict, scalars in the no-escape form. Units `in`/`mm`/
`cm`/`pt` read, `in` and `pt` written. Tests (`src/md-frontmatter.test.ts`):
every `DocSettings` field round-trips; defaults write nothing;
half-letter writes no `papersize`; a scalar `margin`; an `author` list
joined with ", "; a double-quoted scalar with `\"` decodes and re-encodes
byte-identically; a scalar holding `\beta` survives; `{section}` quoted;
unknown keys and `#` comments survive in order; out-of-range values warn;
a block scalar with blank lines.

**Step 3 — Table attributes.** New `src/md-tables.ts`: the `.table` div
grammar above, both directions, as pure functions over table nodes
(`tableDivAttrs(node) → attrs | null`, `applyTableDivAttrs(node, attrs)`),
the blank-header-row rule, plus `escapeCellProse` (pipes in plain text
only, never in `$…$` or backticks). Tests (`src/md-tables.test.ts`): each
attribute; fills/spans/rules with 0-based positions and covered cells; a
table with nothing set yields no div; a headerless table writes the blank
header row and reads back headerless; decimal columns and the missing
`---:` warning; `` `a|b` `` and `$|x|$` in a cell; the warning cases.

**Step 4 — Skeleton and fixtures.** New `src/md-skeleton.ts`: reduce a
PM doc and a pandoc JSON AST to the same ordered list of records
`{kind, text?, math?: string[], label?, src?, cols?, rows?, head?,
aligns?, printed, mode?, classes?}` (kinds: `title`, `author`, `date`,
`abstract`, `heading-N`, `paragraph`, `math`, `solution`, `columns`,
`column`, `quote`, `table`, `figure`, `image`, `list`, `item`, `code`,
`raw-typst`, `pagebreak`, `comment`, `bibliography`, `footnote`, `hr`,
`island`). Rules the review settled: pandoc runs with `-f markdown-smart`,
and the reducer applies Plass's own `printedForm`, `smartenText` (with
the same `before` stand-ins `beforeAfterNode` uses) and the
footnote-space rule to pandoc's flattened paragraph text, so both sides
are the same functions over the same text; inline math is a sentinel
with sources collected whitespace-normalized; a pandoc `Cite` yields one
sentinel per citation (reference when the id has a namespace prefix,
citation otherwise, in either mode) with prefix/suffix inlines emitted as
text; `Subscript`/`Superscript` flatten to their content; a nested
`RawBlock`/`RawInline html` comment is hoisted to its enclosing
top-level block's boundary exactly as the reader does, its payload taken
by stripping `<!--`/`-->`, trimming and decoding `--&gt;`; a `Div` with
no rail class, a non-comment `RawBlock html` (swallowed through its
closing tag) and a `<div>` `Div` reduce to one `island` record with no
text and children not descended; `Para [Image]` ↔ `paragraph > image`,
`Figure` ↔ `figure`; `abstract` (MetaBlocks) and title/author/date
(MetaInlines) are reduced like body paragraphs; `AlignDefault` =
`AlignLeft`; tables carry `rows` and `head` counts; the `columns` record
carries `cols`. New `tests/fixtures/md/`: one file per row of the
vocabulary table (including `paragraph > image` with a data-URL SVG, a
captioned labeled figure, `::: center`/`::: {.keep}`, a headerless
table, a cell with `` `a|b` ``, every citation form, a `--` comment, a
comment after a paragraph line), `normalizations.md` (`Costs -3`,
`\"hi\"`, `'90s`, `5'11"`, `claim [^1]`, a written `‘90s`, the WRITTEN
forms `H\~2\~O`, `x\^2\^`, `\@plass`, `note\^[x]` — the raw `H~2~O`/`x^2^`
are a Plass-only convergence case in step 6, and a hand-written one is a
REPORTED referee divergence with an import warning, checked by one
negative assertion), `wrapped-math.md` (inline math over
a line break in a paragraph, a quote and a list item), `nested-comments.md`
(a comment in a solution, a column, a list item, a quote, a cell, inline),
`grids.md` (`[2,2]`, `[60,40]`, `[1,2]`, `[1.5,1]`, a 3×2 grid, two
adjacent equal grids), `unknown.md` (an unknown div with a nested `:::`,
the styled empty `<div>` from `md-comments.spec.ts:29`, an `<aside>`),
and `guide.md`, a course-style solutions file long enough to paginate
(YAML with `plass:` keys and an author with an apostrophe, a solution
block holding a two-column grid with a data-URL image, labeled and
unnumbered equations, a table with math and a `.table` div, comments at
top level and nested, a page break, a `{=typst}` block, a `{=bibtex}`
fence, footnotes, a strike and a `{++ ++}` mark). The reducer is unit
tested on hand-built ASTs (`src/md-skeleton.test.ts`); the pandoc run is
step 10.

**Step 5 — `docs/MARKDOWN-FORMAT.md`.** The one-page reference for a
person or a model writing a Plass `.md` by hand: the front matter, the
table above, the pitfalls (a blank line before every `:::` and before a
comment that should be unprinted everywhere, `\$` for a literal dollar,
the attribute block after the closing `$$`, ```` ```{=typst} ```` not
```` ```typst ````, `{=bibtex}` not ```` ```bibtex ````, a citation key
whose prefix is `eq:`/`fig:`/`sec:`/`tbl:` is a reference, `~x~`/`^x^`
and bare `@word` mean sub/superscript and a citation to pandoc, a figure
needs a caption to be numbered, a comment inside a block moves out of it
on first save, `{section}` quoted in YAML, non-percent widths dropped,
unknown attributes on a known div dropped with a warning, the export is
exact on typst 0.14.2), and what Plass rewrites on first save. Step 11
reconciles it against what landed.

**Step 9 — The export surface** (wave 1; branches after step 0 merges).
`exportCopy` builds its text with `docToTyp(doc, {islands: 'print',
resolveImage})` directly (not through `serialize`, so an open source view
does not short-circuit it); in a folder, each `data:` image is decoded
with `pdf.ts`'s `dataUrlToBytes` (exported) and written collision-safe
through `figures.ts`'s `projectImagePath` (exported) under `figures/`
with the path emitted; without a folder the data URL stays and the toast
says so. The "save when the open file is `${name}.typ`" branch becomes a
toast ("X.typ is the open document — Export → Markdown, then export
Typst from the .md"). New `exportMdCopy()` and an "Export → Markdown
(.md)" item beside the `.typ` one (`toolbar.ts:982-983`); the Export tile
title becomes "Export — PDF, .md, .typ, .tex" and every selector on it
moves with it (`tests/export-beside.spec.ts:28,57,86`,
`tests/source-view.spec.ts:231,487`). New `src/typ-export-compile.test.ts`:
finds typst at `$TYPST` or on `PATH`; absent → prints
`typ-export: skipped (typst not found)` and exits 0; present but neither
0.14.x nor 0.15.x → prints the version and skips; otherwise builds the
export with the same `docToTyp(demoDoc(), {islands: 'print', resolveImage})`
call and a test-local `resolveImage` that base64-decodes each data: URL
itself and writes `figures/image-N.ext` under a temp dir (`pdf.ts` and
`figures.ts` do not load under node: a `?worker` import and a `.css`
import; `exportCopy` in the browser uses `figures.ts`'s unsanitized
`dataUrlBytes`, exported, not `pdf.ts`'s DOMPurify path), runs `typst compile --diagnostic-format short
--ignore-system-fonts --font-path public/fonts`, requires exit 0 and no
`warning:`/`error:` lines. Files: `src/file-manager.ts` (`exportCopy`,
`exportMdCopy`), `src/pdf.ts`, `src/figures.ts`, `src/toolbar.ts:328,
982-983`, `tests/export-beside.spec.ts` (the exported `.typ` holds no
`plass:comment` and holds `image("figures/…")`; the `.md` export; new
tests drive `__fm.exportCopy()` rather than the tile title),
`tests/source-view.spec.ts:231,487`, `README.md` ("Export" bullet: the
CLI promise holds for an export written into a folder). Step 0 and this
step share no files.

### Wave 2 (sequential; `md-parser.ts`, `md-serializer.ts`, their tests)

**Step 6 — The body** (after 1 and 3). Integrate steps 1 and 3 (step 4
is consumed by step 10). Reader: `div_open` with class `solution` →
`blockquote{kind:'solution'}`; `columns` → one grid, cells row-major by
`cols`, shares canonicalized; `table` → the inner pipe table with the
div's attrs; `center`/`right`/`keep` holding one paragraph → the
paragraph's attrs; any other class, a `<div>`, or an HTML element → an
`md-raw` island holding the ORIGINAL source lines for that token range
(the pre-pass records, for every line it pushes, the original line it
starts at, so sentinels and the wrapped-math join never leak into an
island; a nested `:::` stays inside it); an opener with no
leading blank line → an import warning. Every top-level `html_block`
that is exactly one `<!-- … -->` → `editor_comment` (decoding `--&gt;`;
the tagged frame still decoded the old way); a block holding a comment
plus trailing text is split; nested and inline comments are hoisted
(above). `\newpage`/`\pagebreak` alone → `page_break`. ```` ```{=typst} ````
→ `typst-raw`; ```` ```{=bibtex} ```` → the bibliography at that position.
Heading `{#sec:x}` (`{-}` ignored); figure/image per pandoc's alt rule
with `{#fig:x width=N%}` (the attribute block arrives as the text token
after the image; read it like the `{=typst}` suffix at `md-parser.ts:
258-266`); display-math attributes on the closing line or the next line;
a `: Caption` line after a table (markdown-it absorbs it as a body row;
step 3's `takeCaptionLine` pops a trailing row whose first cell matches
`/^(:|Table:)\s+/` with the other cells empty, and an adjacent matching
paragraph before or after the table is consumed too). Citations by pandoc's group grammar and the
namespace rule. The math pre-pass buffers a paragraph's lines before the
inline regex so `$a +\nb$` is one formula (body may hold one newline,
never a blank line; a leading `> ` on the continuation line stripped);
code spans are sentinelized in the pre-pass (restored in `textWithRefs`,
with the `{=typst}` suffix logic moved there). `validateLink` on the
markdown-it instance admits `data:image/svg+xml;…` so SVG data-URL
images survive (today they are dropped). `\ ` reads as nbsp. Writer: the
forms in the table; blank lines around divs and comments; the escape set
above; pipes in plain text only; the bibtex fence at the node; quoted
paragraphs separated by a bare `>`; the abstract lead's stray leading
space trimmed on read. Delete `blockToTypStandalone`
(`typ-serializer.ts:918-933`, doc comment included; nothing it uses is
orphaned) with its import at `md-serializer.ts:19`; drop the
```` ```typst ```` grid recognition and the `parseGridCall` import
(`parseGridCall` stays exported; it is used in-file). Delete the
warnings that are now representable (image size ×2, cell shading/valign,
solution, alignment, merged cells, settings is step 7) and reword any
retained message that says "save as .typ". Files: `src/md-parser.ts`,
`src/md-serializer.ts`, `src/typ-serializer.ts` (the deletion),
`src/editor-comments-format.ts` (plain-comment write/read; the tagged
decode kept for reading), `src/grid-editor.ts:25-33` and
`src/typ-parser.ts:1046-1052` (share canonicalization). Tests: rewrite
`md-round.test.ts` case by case (120-127, 222-251, 263-272, 297-305,
328-340, 342-354) and add cases for every form above including the
grids `[2,2]`, `[60,40]`, `[1,2]`, `[1.5,1]`, two adjacent equal grids,
`Math $a +\nb$` → one `math_inline`, `H~2~O`/`x^2^`/`follow @plass`/
`note^[x]` converging, the SVG data-URL figure, the citation forms, the
abstract-quote path; `editor-comments.test.ts:37-49, 85-91`;
`table-integrity.test.ts:177-211` (invert the three degradation checks;
88-102 keeps its exact-JSON assertion, comment fixed); the cross-format
check: for the demo doc and the typ-parser fixtures lifted into a shared
`src/typ-fixtures.ts` (one import added to `typ-parser.test.ts`),
compare the body (after the `#import` line) of
`docToTyp(mdToDoc(docToMd(doc)).doc, {islands:'print'})` with
`docToTyp(stripUnrepresentable(doc), {islands:'print'})`, where
`stripUnrepresentable` clears table `params` and, until step 7, resets
settings to the defaults — asserting the Markdown trip changes nothing
the compiler sees EXCEPT the listed drops (sections 11, 13d, 19c-custom,
19d-custom and the 852 loop are the `params` cases; 13c is representable
via `decimal`; no fixture carries paragraph align/keep; the grid fixture
at 955 passes because a bare `#image` is `paragraph > image`). Browser
specs in this step's gate: `tests/md-comments.spec.ts` (top-level
comments are `editor_comment` strips; the `<div>` stays an island; byte
identity holds since `--` is untouched), `tests/editor-comments.spec.ts:
357-374` (the bare form, retitled). Convergence (`md1 === md2`) stays.

**Step 7 — Front matter and settings** (after 2 and 6). Integrate step
2. Reader: YAML → `doc.attrs.settings` through `normalizeSettings` with
warnings; title/author/date through the inline reader and abstract
through the block reader (math pre-pass included); `front-matter: roman`
→ the `numbering_restart` node at the panel's position; `bibliography:`
→ `MdImport.bibliography`. FileManager: in `putInPlace`, `loadHandle`,
`completeRestore` and `attachFolder`, when the last import carried a
path and `dir` is set, `readAsset` the sidecar and dispatch the bib
through a new `setBib` hook; `main.ts` `needsFolder` also fires for it.
Writer: the front matter from settings and nodes (inline/block writer,
no-escape scalars); never `bibliography:`; the one-time embed toast.
`source-view.ts:494-506`: treat `.md` like `.typ` (keep the editor's
settings only when the parsed ones normalize equal). The open toast
reports settings warnings as warnings ("N setting(s) adjusted"), not as
raw blocks. Files: `src/md-parser.ts`, `src/md-serializer.ts`,
`src/file-manager.ts` (the sidecar read, the `setBib` hook, toast
wording), `src/main.ts` (`needsFolder`, the hook), `src/source-view.ts`.
Tests: the front-matter integration cases in `md-round.test.ts` (a title
with `$x$` and `*em*`, `Taylor's -- draft`/`O'Brien` importing as
`Taylor’s – draft`/`O’Brien`, an abstract with math, a citation and two
paragraphs, all converging); the cross-format check lifted to the full
output (settings included) for sections 3, 3b, 12, 13 and the chrome
fixture; `reload-in-place.test.ts` and `security.test.ts:95-112` stay
green; a sidecar test (fixture with `bibliography:` and no folder →
warning, no bib; attach folder → bib loaded; save → fence present, key
gone). Browser specs in the gate: `tests/source-view.spec.ts`,
`tests/persistence.spec.ts:743-755`.

### Wave 3 (after wave 2; steps 8 and 10 in parallel — they share no files — then 11)

**Step 10 — The referee** (after 4, 6, 7). `src/md-parity.test.ts`
(registered by existing): finds pandoc on `PATH`, at `$PANDOC`, or at
Quarto's two arch paths; if none, prints `md-parity: skipped (pandoc not
found)` and exits 0; `PANDOC_REQUIRED=1` turns the skip into a failure;
checks `pandoc-api-version` major 1.23 and skips with a notice otherwise;
for every `tests/fixtures/md/*.md`, runs `pandoc -f markdown-smart -t
json`, reduces both sides with `md-skeleton.ts`, and fails on the first
non-accepted divergence with both skeletons printed around it. The
accepted list is short and each entry says why the format cannot heal it:
a comment on the line directly after paragraph text (block to
markdown-it, inline to pandoc); pandoc's citation mode (author-in-text
versus bracketed; Plass has no author-in-text form). `scripts/
pandoc-parity.ts` runs the same comparison on a file or folder, for the
course corpus. `package.json`: `"test:parity": "PANDOC_REQUIRED=1 node
--import tsx src/md-parity.test.ts"`. `deploy.yml`: just before
`npm test`, install `pandoc-3.4-1-amd64.deb` from the pandoc 3.4 release
with its sha256 checked, `continue-on-error: true` on the INSTALL step
only, so the ordinary `npm test` run gates on the referee and a flaky
download degrades to the visible skip notice; add the pinned typst
0.14.2 release tarball the same way for step 9's compile test. The
separate "forced" step from the first draft is gone (it would have been a
duplicate). `tests/port-audit.spec.ts`: built-in fixtures gain `guide.md`
read via `new URL('./fixtures/md/guide.md', import.meta.url)`, and the
`comments.md` entry's page break becomes `\newpage` (recorded as a gained
test, not a regression: the `.md` twin has always held an island there).
`scripts/md-corpus.ts` gains the Kinds `fenced div`, `comment` and
`front matter`.

**Step 11 — Docs** (after everything else). `AGENTS.md` ("Formats"
rewritten; the Editorial comments bullet's "plain HTML comments keep
their old meanings" reversed, the hoist rule added; the Tolerated tier
sentence; Commands line 9), `README.md` (every `.typ`-native statement,
found by grepping for `.typ`, `mitex`, `typst compile`, "Typst on rails"
rather than by the line numbers the first draft listed; one new
"Formats" bullet pointing at `docs/MARKDOWN-FORMAT.md`), `ROADMAP.md`
item 2 (the exit criterion now includes the referee on the course
folder), `CONTRIBUTING.md` and `RELEASING.md` ("Typst round-trip" →
"Markdown round-trip and Typst export"; `npm run test:parity` in the
local sequence), `SOURCE-VIEW.md` decision 2 ("an unsaved document shows
Typst" → Markdown; "Markdown front matter is left alone" stays) — this
step alone owns prose docs — and a reconciliation of
`docs/MARKDOWN-FORMAT.md` against what steps 6, 7, 8 and 10 landed. Taylor
refreshes the git-ignored `CLAUDE.md` from `AGENTS.md` afterwards (or
replaces it with a pointer so the two cannot drift).

**Step 8 — `.md` is the default; UI** (after 7 and 9 have merged; shares
no file with step 10). Files also include `src/style.css` (the md-raw
margin tag) and `src/source-view.ts:136` (the "kept as source" toast). `file-manager.ts`: `fileFormat`
default and `newDoc` → `'.md'`; `adoptFolder('open')` ranks `.md` over
`.typ` (newest within the winning extension); `attachRestoredSession`
decides the conflict on `serialize(parse(diskText))` with a no-op warner
(disk baseline stays the raw text), so a never-edited hand-written file
reconnects clean instead of reporting "changed outside Plass"; `serialize`
keeps a `lastWarned` set per handle and toasts only new messages (cleared
on handle change), ending the per-flush re-toast; `rename` passes `dir`
to its two `last`/recents writes; the data-URL hint moves here (once per
file, per-image wording). `index.html:12` (`Plass.md`), `app/plass.json`
(`defaultDocument: "Untitled.md"`), `app/smoke.mjs` (`smoke.md` with a
Markdown body; title check unchanged), `settings.ts:641` hint, open and
reload toasts for `.md` files ("N block(s) kept as source"; settings
warnings worded as warnings), island chrome (`inline-raw.ts` title by
`lang`; the `md-raw` margin tag "markdown · printed as code"),
`source-editor.ts:283-335`: a `:::` line node styled
`processingInstruction` (dimmed like other markup) — no YAML fold
(`SOURCE-VIEW.md:111-112` stands, `source-view.spec.ts:548-555` stays).
Demo prose at `demo-doc.ts:136,191-196` no longer promises a
mitex-wrapped `.typ` (the `typ-parser.test.ts` byte-identical round trip
must stay green). Specs: `tests/persistence.spec.ts` (`Plass.md` at 54,
335, 345; 358 stays `Plass.typ`; a hand-written `.md` with straight
quotes, `--` and a wrapped paragraph reloads with no conflict and
unchanged disk bytes; a folder holding `X.md` and a newer `X.typ` opens
`X.md`), `tests/source-view.spec.ts` (the demo shows Markdown: `# Plass`,
Mod-b wraps `**…**`, mode memory keyed `.md`, `:104`/`:139` in Markdown
forms; the `.typ` fold tests at 521-546 and 557-572 re-seeded with
`Paper.typ` through `openSeeded` as 574 does), `tests/md-comments.spec.ts`
(the `MD_FILE` run on a course note), `tests/pwa.spec.ts` if its fixture
name matters. `SOURCE-VIEW.md` is step 11's.

### After the merge

**Step 12 — Course conversion** (outside the repo, Taylor's). Open each
`*_sols.typ`, Export → Markdown, open the `.md`, run
`scripts/pandoc-parity.ts` and `scripts/md-corpus.ts` on the folder,
archive the `.typ` per the course rules; move `render-sols-figures` to
`figures/*.svg` when the folder is attached.

**Step 13 — `.typ` import-only** (required, after step 12; ends the
bounded departure). `loadHandle` on a `.typ` parses with `typToDoc`,
sets `fileFormat` `'.md'`, `name` = stem, keeps `dir`, leaves `handle`
null and marks dirty; `save()` adopts the known `dir` through
`adoptFolder('save')` when `dir` is set and `handle` is not; recents and
the one-window guard are not registered for the `.typ`; the folder-open
rule from step 8 keeps an opened `.typ` from being the export beside its
own source. The five save-semantic `.typ` specs (rewind, the two-window/
rename/launch persistence tests, source-view autosave and fold, fallback)
move to `.md` fixtures with YAML headers; the pure layout specs keep
their `.typ` fixtures.

 with a Plass-owned prelude of only the helper definitions the
document uses, switch `math-ink.ts` to the same form, prove SVG and
measured-width identity for every formula in the demo, the fixtures and
the course folder before the in-app switch, then remove the registry
fetch and the package policy and update `security.test.ts`,
`tests/security.spec.ts`, SECURITY.md, PRIVACY.md and the README. The
`.typ` importer keeps reading `#mi(`…`)` for legacy files.

### Optional, later, each its own session

**Step 14 — Comments in place:** `editor_comment` inside `blockquote`,
`grid_cell`, `list_item`; the paginator's comment heights inside nested
blocks; `page-oracle.ts:177`, `port-audit.ts:82`, `block-layout.ts:134`,
`collapse-spaces.ts:204`; the TeX export. Replaces the hoist with
in-place notes.

**Step 16 — Citation supplements** (`[see @c, p. 3]` as `#cite(<c>,
supplement: [p. 3])`: a schema attr, the painter in `citations.ts`, the
TeX export) and a persistent sidecar bibliography.

**Step 17 — Unresolved references:** `inlineToTyp` emits an `eq_ref`/
`citation` whose target is in none of the document's labels or bib keys
as escaped text, so a dangling `@eq:missing` fails neither the export nor
the compile and the page's "(?)" matches the print.

## Test strategy

- **Unit (`npm test`, the glob runner).** New suites `md-divs`,
  `md-frontmatter`, `md-tables`, `md-skeleton`, `md-parity`
  (self-skipping), `typ-export-compile` (self-skipping);
  `md-round.test.ts` rewritten per form with convergence kept and the
  cross-format check added (modulo the declared drops, executable, not
  prose); `editor-comments.test.ts` and `table-integrity.test.ts` updated
  as named; `typ-parser.test.ts` changed only by the mitex literal and
  the one fixtures import (the Typst serializer does not change what it
  emits, so its byte-identical round trips stay).
- **Content parity (`md-parity.test.ts`, `npm run test:parity`).**
  `pandoc -f markdown-smart -t json` versus `mdToDoc`, both reduced to
  the same skeleton: block kinds and order, printed text after Plass's
  own normalizers on both sides, display and inline math sources
  (whitespace-normalized), labels and reference targets, which text is a
  comment (hoisted alike), image sources, table shape (rows, head,
  columns, alignment), citations one per key, footnote text, abstract and
  metadata as paragraphs. Skipped with a notice when pandoc is absent;
  gates `npm test` wherever pandoc is present (Taylor's Mac through
  Quarto's binary; CI through the pinned install); never a PDF.
- **Export compiles (`typ-export-compile.test.ts`).** The exported demo
  compiles with no diagnostics on typst 0.14.x/0.15.x when a CLI is
  present; CI installs 0.14.2. This is the automated guard for the
  brief's "known gap" and the moment a future pin bump learns of a
  typst break.
- **Browser (`npm run test:browser`).** The specs each step names,
  in that step's gate; `MD_FILE=… npx playwright test
  tests/md-comments.spec.ts` on a converted solutions guide: comments as
  strips, divs, math, the table div and the data-URL figure survive the
  live editor and the save byte for byte after one Plass save.
- **Exactness (`npm run audit`).** After steps 0, 6, 7 and 10, on the
  `.md` fixtures including `guide.md`: pages agree, mismatch 0, chrome 0,
  unmeasured 0 — the Markdown forms land on the rails the audit already
  certifies. For step 0 the audit proves agreement under the new pin;
  the A/B script proves nothing moved.
- **Corpus (`scripts/md-corpus.ts`, `scripts/pandoc-parity.ts`).** The
  course folder reports only the decided normalizations and no
  non-accepted referee divergence.
- **Build gates.** Every new module's exports are used by src, a test or
  a script (knip), no unused locals, no cycles (`md-parser` must not
  import `typ-parser` once `parseGridCall` goes; `md-skeleton` imports
  the schema, `collapse-spaces` and `smart-quotes` only).

## Known limitations after this plan

- A nested or inline comment keeps its text but moves to the nearest
  top-level boundary on first save (step 14 keeps it in place).
- Pipe tables: one paragraph per cell; header cells only in the first
  row; `params` dropped with a warning.
- pandoc itself numbers only captioned figures; Plass keeps a labeled
  figure with an empty caption as a figure (MARKDOWN-FORMAT.md note).
- Citation prefixes, suffixes and suppressed authors are kept as prose,
  not as citation attributes (step 16).
- Multi-paragraph footnotes still flatten (ROADMAP item).
- `figure.name` (the extraction file name) is not stored; the exporter
  derives it from the path or numbers the image.
- A hand-written `.md` is normalized on its first save (listed above).
- The roman front-matter restart is canonical in position.
- The export is exact on typst 0.14.2 and compiles on 0.15.x, where
  Typst's own math layout changes (underbrace, calligraphic letters)
  move some formulas.
- Until step 13, an opened `.typ` still autosaves as `.typ`.

## Open questions for Taylor

The proposed answers above stand unless overruled: 1 (`solution`),
2 (hoist now, in-place later), 3 (fence written, sidecar read once),
4 (no automatic extraction), 5 (flip now), 6 (0.14.2 exact, 0.15.x
compiles), 7 (pin 0.2.7 with the two named departures, translate later),
8 (`center`/`right`/`keep` divs), 9 (`.typ` opens as today until step 13,
which is required), 10 (hatch printed as code in the export), 11 (one
`.columns` div per grid with `cols=N`, a departure from the brief's
"one div per row"), 12 (the two git commands first). Two sentences of
the brief are only partly true and could be amended: "Plass's save
normalizations … are the same choices pandoc `smart` makes" (true for
quotes, dashes and the ellipsis only) and "One `.columns` div per grid
row".

## Appendix A — native-Typst math export, when wanted

Design, with the evidence from this review:

- Translator: mitex's own `mitex.wasm` (already pinned and fetched by
  the worker; 280 KB) driven from JS through the typst plugin protocol
  (`typst_env.wasm_minimal_protocol_write_args_to_buffer` /
  `_send_result_to_host`; export `convert_math(len1, len2)`), in the
  compiler worker or on the main thread at export time. Verified from
  Node in 15 lines.
- Prelude: a Plass-owned `src/typst-math-prelude.ts` holding the `#let`
  definitions mitex's output needs (`mitexsqrt`, `mitexmathbf`,
  `mitexunderbrace`, `textmath`, `operatorname`, `aligned`, `pmatrix`
  and matrix handles, `frac`, the colour and phantom handles — the 95
  entries of `specs/latex/standard.typ` with a handle or a symbol),
  derived from mitex (Apache-2.0; notice via `generate:notices`), emitted
  into the parity header only for the names a document uses.
- Emit: `#mi(\`x\`)` → `$ … $`, `#mitex(\`…\`)` → `$ … $` display with
  the label, table cells likewise; `expandMacros` and `wrapAligned` run
  before conversion as now.
- Proof before trusting a page: for every formula in the demo, the
  fixtures and the corpus, compile `mi(\`x\`)` and the prelude form in
  the worker and compare the SVG and the measured width (`math-ink.ts`
  uses the width as a block-layout cache key). Then the audit on the
  math fixtures.
- Removes: the registry fetch, `TYPST_PACKAGE_POLICY`, `loadPinnedPackage`,
  the SECURITY/PRIVACY statements about a fetched package. The `.typ`
  reader's four mitex read sites go with step 13. It does not remove the
  0.14/0.15 layout difference; only the version pin addresses that.
