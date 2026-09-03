# Source view: a second editor for the same rails

Goal: a toggle between the page view and an editable plain-text view of the
document in its own on-disk format (`.typ` or `.md`), in the spirit of iA
Writer — a quiet, wide-margined text column with the markup lightly styled,
for files that are simpler than a paginated paper. It is a second way to
write the same on-rails document, not a way around the rails (README, "Typst
on rails"): Typst the page view cannot show still arrives as a visible raw
island, and the source view promises nothing about how it prints.

Status: step 1 landed — toggle (title-pill button, `Mod-/`), lazy CodeMirror,
serialize-on-enter / single-transaction parse-on-exit, verbatim `getText`
saves, per-tab session restore. Steps 2–3 next.

## What already exists

- Both directions of the trip. `docToTyp` (`typ-serializer.ts:635`) is
  computed on every edit as the oracle signature; `typToDoc`
  (`typ-parser.ts:33`) is the file-open path. `docToMd`/`mdToDoc` are the
  Markdown pair. `FileManager.serialize` (`file-manager.ts:233`) already
  picks the serializer from the file name.
- Round-trip guarantees, tested: `.typ` is byte-identical after
  export→import→export and idempotent thereafter (`typ-parser.test.ts:30,39`);
  `.md` is *convergent* (parse→serialize→re-parse settles) but not
  byte-identical (`md-round.test.ts`).
- Raw islands: a `code_block` with `params: 'typst-raw'` (block) or a
  `typst_inline` node (inline), re-emitted verbatim by the serializer.
- Tokens for the look: `--mono`, `--serif`, `--sheet`, `--ink`,
  `--ink-soft`, `--accent` (`style.css:43-59`). DejaVu Sans Mono is
  registered across browser, sidecar, and compiler.
- Per-tab session persistence (`main.ts:28-31, 102-112`).

What does not exist: any view-mode state, a doc-position→text-offset map in
either serializer, or a code editor dependency.

## Design decisions

1. **One truth at a time.** In page mode the ProseMirror document is the
   truth; in source mode the text string is. Entering source serializes the
   document once; leaving parses the text once and installs it as ONE
   transaction (a single undo step, per the roadmap). No live two-view sync:
   syncing would need a position map in both directions on every keystroke,
   and iA-style use is "write here for a while", not "watch both".
2. **The text is the file's format.** A `.typ` document shows Typst markup,
   a `.md` document shows Markdown. An unsaved document shows Typst (the
   native format). No third "source dialect".
3. **Saving in source mode writes exactly the typed text.** `FileHooks`
   gains `getText?: () => string | null`; `serialize()` prefers it when it
   returns a string. Nothing the writer typed is re-normalized until they
   return to the page view — which then applies the printed-form doctrine
   (space collapse, dash glyphs, footnote glue) exactly as a file open does.
   The known cost from the roadmap stands: hand-formatting of untouched
   regions is re-normalized by the serializer after a source-side edit.
4. **CodeMirror 6 from the start, not a `<textarea>`.** The iA feel is
   syntax-aware: dimmed markup characters, bold heading lines, soft wrap at
   a measure, a real find/replace, stable undo. A textarea gives wrap and
   undo only and would be thrown away. Cost: `@codemirror/state`, `view`,
   `language`, `commands`, `search`, `lang-markdown` — on the order of
   150–200 KB minified, loaded lazily via dynamic `import()` on first
   toggle so page-mode users pay nothing. Typst highlighting: a small
   `StreamLanguage` covering only the rails (`=` headings, `-`/`+` items,
   `$…$`, `#name[`/`#name(`, `//` comments, raw fences, `@key`). Off-rails
   constructs render as plain text — the highlighter, like the editor, only
   knows the rails. (`codemirror-lang-typst` was evaluated in step 0 and
   rejected: it is not a Lezer grammar but a 1.2 MB WASM build of Typst's
   own parser, pulling in lint and autocomplete, and it knows all of Typst
   — the opposite of the rails.)
5. **Coarse caret mapping in v1, by top-level block.** Both serializers
   iterate top-level blocks; record each block's starting text offset in a
   side array (`docToTyp(doc, { offsets })`). Entering: caret block index →
   text offset. Leaving: caret text offset → block index → the block's doc
   position in the freshly parsed document (re-serialize the new doc to get
   its offsets). Scroll follows the caret. Exact inline mapping is
   deliberately out of scope.
6. **The page machinery sleeps in source mode.** The ProseMirror view stays
   mounted (so history and node views survive) but hidden, and the typeset
   plugin, page oracle, and parity shadow are suspended behind one flag; a
   full pass runs on return. Measuring a hidden editor would poison layout
   snapshots, and compiling a document nobody is looking at wastes the
   worker. Step 0 confirms the plugin's scheduler can be gated this way.
7. **Mode is per tab, remembered per format.** `sessionStorage` holds the
   current mode and, in source mode, the unparsed text (so a reload lands
   back in the source with nothing normalized); `localStorage` remembers
   the last mode used for `.md` and for `.typ` separately. Default is the
   page view for both. Whether `.md` should default to source is a product
   call to make after using it (see Open questions).
8. **Islands are announced, not hidden.** Returning from source with
   constructs the parser kept as raw islands shows one toast: "3 blocks kept
   as raw Typst". The page view already marks islands. No gutter warnings
   in the source view in v1.
9. **Export works from either mode.** `fm.currentDoc()` in source mode
   parses the current text on demand (PDF export, `.tex`, `.typ` copy). No
   second export path.

## Look

- A single sheet the width of the page column, text column at a fixed
  measure (~68ch), generous top padding, `--mono` at 15–16px, line-height
  ~1.6, `--ink` on `--sheet`. No page boxes, no page numbers.
- Markup dimmed to `--ink-soft`: heading markers, list markers, emphasis
  delimiters, `#`, brackets. Heading lines bold. Math and raw fences in a
  faint tint. Links and `@` references in `--accent`.
- Toolbar: the title pill and file/export pods stay; formatting buttons
  either disable or (v2) insert markup. Status line keeps the word count,
  drops the page count.
- Toggle: a toolbar button (glyph: `</>`) plus a shortcut. Proposed
  `Mod-Shift-M` ("markup"); `Mod-/` is the fallback if that collides.
- Print: source mode prints the text column as-is (one `@media print`
  rule); PDF export always goes through Typst.

## Steps

0. **Spike (½ day).** Add `offsets` to both serializers; add the suspend
   flag to the typeset plugin/oracle scheduler and prove a hidden editor
   leaves no snapshot residue. Decide the Typst highlighter (evaluate
   `codemirror-lang-typst` on the demo doc's own output).
1. **Toggle + round trip (1–2 days).** Mode state, toolbar button, shortcut,
   lazy CodeMirror mount with the Markdown mode, serialize on enter, parse
   and single `replaceWith` on exit, `getText` save hook, session
   persistence of mode and text. Tests: toggle-and-back identity
   (`doc.toJSON()` equal, one undo step restores), source edit round-trips
   into the page, autosave writes typed bytes, reload in source mode
   restores unparsed text, `.md` document shows Markdown.
2. **The look (1–2 days).** Sheet, measure, fonts, highlight theme for both
   languages, toolbar and status changes, print rule.
3. **Mapping and feedback (1 day).** Block-level caret and scroll mapping
   both ways; island toast; export from source mode.
4. **Writing niceties (1–2 days, optional, any order).** Focus mode (dim all
   but the current paragraph), typewriter scrolling, `Mod-b`/`Mod-i`
   wrapping markup in source, mode memory per format, a "simpler files"
   default for `.md` if wanted.

Total: about a week for 0–3.

## Tests

- Unit: serializer offsets equal the real block starts for the demo doc;
  `docToTyp`/`docToMd` unchanged when `offsets` is not requested.
- Playwright (driving `window.view` and `__fm`, never dynamic-importing app
  modules): the five in step 1; oracle and typeset passes do not run while
  in source mode; a source-typed off-rails `#let` returns as one raw island
  with the toast; PDF export from source mode produces a PDF.
- Round-trip: the demo doc and every fixture in `typ-parser.test.ts` toggle
  in and out unchanged.

## Risks and costs

- **Markdown normalization.** Because `.md` round-trips converge rather than
  preserve, a `.md` writer will see their formatting rewritten the first
  time they toggle out (list markers, emphasis style, wrapping). Mitigate by
  making `docToMd` idempotent on its own output (it already converges after
  one cycle) and by never re-serializing while the writer stays in source
  mode (decision 3).
- **Bundle size** from CodeMirror; contained by lazy loading.
- **Two undo histories.** ProseMirror's history and CodeMirror's are
  separate; toggling is a boundary. Accepted and documented.
- **Off-rails temptation.** The source view makes it easy to type Typst the
  page view cannot show. The island toast and the visible island are the
  answer; the source view must not grow rendering promises.

## Decisions taken (2026-09-02)

- `.md` documents do not default to source mode; the last mode used per
  format is remembered. Revisit after a week of use.
- Toggle shortcut: `Mod-Shift-M`.
- The Markdown round-trip rewrite (Risks, first item) is accepted for now
  and gets its own fix later; it does not block the source view.

## Open questions

- Font: `--mono` now; an iA-Duo-style duospaced face later is a font
  registration question (browser only — the source view is never compiled).
