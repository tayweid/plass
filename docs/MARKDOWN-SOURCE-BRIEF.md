# Markdown source: decisions and brief for the implementation session

Taylor Weidman, 2026-10-04. This is the governing brief. Where
`docs/MARKDOWN-SOURCE-PLAN.md` (a first review, same day) disagrees with it,
this file wins; the plan is to be rewritten to match.

## The decision

Pandoc Markdown becomes Plass's on-disk source of truth. Plass keeps its
document model, its Typst serializer and its Typst compiler exactly as they
are. The pipeline becomes

    .md on disk -> doc model -> Plass Typst serializer -> Plass compiler -> PDF

The `.typ` is an export, never the file anyone edits.

Why: the `.typ` Plass reads is not the `.typ` Plass writes (LaTeX between `$`
on import, `#mi(...)` on save; plain comments deleted; exact forms required
for grids, blocks, tables). A file written by hand or by an AI in that dialect
is not valid Typst until Plass has saved it, and the only referee is Plass's
own parser. Pandoc Markdown has an external spec, every editor and AI model
writes it, and `pandoc` can parse it with no Plass involved.

## The three principles

1. **Pandoc is the language; Typst is the renderer.** Plass renders a
   `::: solution` div as its red block, `::: columns` as its grid, a pipe table
   as its table, through the serializer it has today. No feature needs a raw
   Typst fence to render in Plass. Plass styles the document exactly like
   Typst, which is a thoroughly documented standard; that is the answer to
   "Plass styles it differently from pandoc."
2. **Pandoc is a content referee, not a renderer.** The parity test is
   `pandoc -t json` on the same file compared with Plass's parse: block kinds
   and order, printed text, math source strings, labels and reference
   targets, which text is a comment, image sources, table shape and
   alignment. It is NOT a pixel comparison and there is NO Lua filter that
   makes pandoc's PDF look like Plass's. A pandoc PDF compile is at most a
   smoke test that the file is well-formed outside Plass.
3. **Two parities, named separately.** *Content parity*: any reader or export
   agrees on what the document says; the Markdown source strengthens it.
   *Visual parity*: Plass's editor page is Plass's PDF page; that is the Typst
   pipeline and it does not change.

## Vocabulary (standard syntax; Plass-specific meaning kept to class names)

- YAML metadata block at the top of the file, inside the document, with
  pandoc's own variable names for the big knobs (`papersize`, `margin`,
  `fontsize`, `mainfont`, `bibliography`, `section-numbering`). Settings with
  no pandoc name go under one `plass:` key, which pandoc ignores.
- `::: solution` for the red solution block.
- `::: {.columns gutter=...}` containing `::: {.column width=...}` blocks for
  the grid. One `.columns` div per grid row. Quarto's names.
- Pipe tables. Table-level extras that pipe tables cannot express (fills,
  spans, caption, label, density) are attributes on a wrapping div,
  `::: {.table ...}`, which pandoc preserves and ignores. No raw Typst
  fallback for tables.
- `<!-- ... -->` is an editor comment: kept in the file, left out of the PDF.
  Every HTML comment, not only a tagged one.
- `$...$` inline math, `$$ ... $$ {#eq:name}` display math with label;
  `.unnumbered` for an unnumbered equation. `# Heading {#sec:name}` and
  `![caption](src){#fig:name width=...}` likewise.
- `![](data:image/svg+xml;base64,...)` stays supported for single-file
  documents; a path is preferred when a folder is attached.
- `\newpage` is the page break.
- `>` blockquote, `~~...~~` strike, `{++ ++}` as plain text, footnotes,
  `\_\_\_` blanks: standard forms, already lossless.
- ```` ```{=typst} ```` fenced raw block and `` `...`{=typst} `` inline raw are
  the only escape hatches, for content with no Markdown form. Pandoc's
  spelling, not ```` ```typst ````.
- ```` ```{=bibtex} ```` for an embedded bibliography (or a `bibliography:`
  path in the YAML).
- Unknown div classes become islands and are never destroyed.

## Constraints

- Every current document feature survives: page setup, solution blocks,
  grids, tables, inline and display LaTeX math with labels and numbering,
  data-URL images, kept-but-unprinted comments, page breaks, quotes, strike
  and proposal marks, raw Typst hatch, bibliography and citations.
- Back-compatibility with existing `.typ` documents is NOT required. The
  `.typ` reader may drop to import-only or be removed.
- The Typst compiler, incremental rendering and editor speed do not change.
- The `.md` must be writable by hand and by an AI with no Plass-specific
  knowledge beyond the class names above, and parseable by pandoc.

## Known gap to close: the exported `.typ`

The export depends on mitex for every math expression, and mitex 0.2.5
fails on typst 0.15. An export that does not compile on a fresh machine is
not a parity file. Decide one of: vendor a pinned mitex into the export so
the `.typ` is self-contained, or translate LaTeX to native Typst math at
export time (mitex performs that translation already; emit its output rather
than its call). The second removes the dependency entirely and is preferred
if it is tractable.

## Findings from the first review that stand

- Pandoc needs a blank line before every `:::`; the writer must always emit
  one (and after `:::`).
- `md-serializer.ts` escapes every `|` in a table cell including inside
  `$|x|$`, corrupting the math on re-read. Escape outside math only.
- Bib keys containing colons collide with `@eq:x` cross-references.
- Nested comments (inside divs or table cells) have no schema node;
  `editor_comment` is doc-level only. Decide whether to extend the schema or
  keep them as unprinted inline/block raw with a documented limitation.
- Page breaks are already lossy in Plass's `.md` writer; `\newpage` fixes it.
- Markdown-it has no fenced-div support; a tokenizer is new work.
- Plass's save normalizations (curly quotes, dashes, reflow) are the same
  choices pandoc `smart` makes, so the content comparison still agrees.

## What the first review got wrong (do not carry forward)

- A Lua filter that paints pandoc's output red, builds grids, and extracts
  media so pandoc's PDF matches Plass's. Not the goal; drop it.
- A `{=typst}` fence as the fallback for table attributes. Use div
  attributes.
- Treating pandoc's Typst *writer* failures (labels, `\newpage`, data URLs)
  as problems for this design. We don't use pandoc's writer.

## Open questions for Taylor (answer before or during implementation)

1. Name of the solution class: `solution`, or a Quarto callout class.
2. Nested comments: schema extension or documented limitation.
3. Bibliography: embedded `{=bibtex}` fence, sidecar `.bib`, or both.
4. Figures: when to prefer a file path over a data URL.
5. When the default new-document format flips to `.md`.
6. Which typst CLI version to pin for the parity smoke test.
7. Exported `.typ` math: vendored mitex or native-Typst translation.
