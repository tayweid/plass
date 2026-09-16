# Editorial comments and warm appearance: handoff for Fable

Date: 2026-09-16. Investigated against local commit `d6e5dc5`.

## Status and user intent

Update 2026-09-16: feature 1 (editorial comments) and the first increment of
feature 2 (the Warm paper screen palette) are implemented in two local
commits; see AGENTS.md ("Editorial comments", "Editor appearance") for the
shipped design. The typography investigation (TeX Gyre Pagella
certification) has not been started. The text below is the original plan.

This is an implementation plan, not a record of shipped features. The user
approved the comment concept and requested this handoff instead of proceeding
with implementation in the current task. Neither feature has been implemented.

The user wants:

1. Editable comments visible in page view and plain/source view, preserved in
   the working file, and absent from rendered export. A comment extends the
   displayed sheet by exactly its own height without changing printed layout.
2. An optional settings choice resembling the mockup's warm paper, charcoal
   text, and bookish typography.

The user explicitly approved comments as the **one exception** to the rule
that the editor shows only printed content, provided their appearance makes
that distinction clear. This does not authorize other hidden or off-rails
content, a second renderer, or browser-only substitution of document fonts.

Read `AGENTS.md` before starting. Complete and validate local work, then make
focused local commits. **Never push to GitHub or publish repository changes
through another route. The user performs all pushes.**

## Visual reference

An interactive mockup exists locally at:

`/Users/taylorjweidman/.codex/visualizations/2026/09/16/01a0aa78-a6f1-7f32-8d47-bd003b53dedb/plass-comments.html`

That path is machine-specific. The descriptions below are sufficient if the
file is unavailable. The mockup's controls and source syntax are illustrative,
not an implemented product API.

The preferred comment treatment is a full-sheet-width, warm-gray strip with
fine dashed top/bottom borders. Align its editable text with the document's
prose column. A small sans-serif header says **Comment** and **Not printed**,
with an undoable delete action. Keep the paper edges continuous through the
strip. Alternate inset/margin-rule treatments in the mockup are explorations,
not required v1 settings.

The mockup uses Iowan Old Style, then Palatino, then Georgia as its serif
fallback stack. The actual face on a given machine has not been verified.
Its warm appearance also comes from the palette; see feature 2.

## Feature 1: nonprinting editorial comments

### Required behavior and initial scope

- Plain-text comment blocks between top-level document blocks. No comments
  inside paragraphs, lists, grids, tables, or footnotes in v1.
- Preserve comment text on save/reopen and across page/source transitions.
  Saving editable `.typ`/`.md` source must retain the note; rendered PDF and
  semantic `.tex` export must omit it.
- Comments have zero height and no semantic effect in print layout. Adding,
  resizing, editing, or deleting one must preserve all printed line breaks,
  page starts, page count, heading behavior, indentation, and footnote layout.
- Display height is additive: if a note's entire measured box is 10 mm tall,
  that sheet becomes 10 mm taller. The following content, footer, and later
  sheets move down by the corresponding cumulative amount. The print page
  size remains unchanged.
- Large comments may make a displayed sheet much taller; they do not create
  additional printed pages. Multiple comments contribute their summed height.
- Keep existing raw-island behavior unchanged. Ordinary Markdown HTML comments
  currently become printed code islands; ordinary Typst `//` comments are
  generally discarded on import. Recognize a distinct tagged form for the
  new feature rather than silently changing those meanings.

### Document model and serialization

Add an `editor_comment` node in `src/schema.ts`:

- `content: 'text*'`, `marks: ''`, `code: true`, defining/isolating.
- Do not put it in the `block` group. Change only the document's content
  expression to `(block | editor_comment)+` so nested block containers do
  not begin accepting comments accidentally.
- DOM convention: `.editor-comment[data-editor-comment]` containing an
  `.editor-comment-text` content element. Parse only that element, with full
  whitespace preservation; labels/buttons must never enter stored text.

Suggested readable, safely framed `.typ` representation:

```typst
// plass:comment
// | Could this open with the library scene?
// | Give the reader a place to stand first.
// /plass:comment
```

Prefix every payload line with `// | ` so a payload containing framing tokens
cannot terminate the note. Preserve empty lines, indentation, trailing spaces,
and delimiter text. Recognize the frame before ordinary comment skipping,
including at the beginning of the file. Decide malformed/unterminated-frame
handling explicitly: preserve content visibly rather than discarding it.

Suggested Markdown representation is a tagged HTML comment:

```markdown
<!-- plass:comment
Could this open with the library scene?
-->
```

Use a reversible escaping convention for ampersands and hyphen sequences so
arbitrary payload text cannot close the HTML comment or execute as markup.
Test literal escape strings as well as delimiters. A shared small format
helper can keep the two serializers and parsers consistent.

Relevant files:

- `src/typ-parser.ts`, `src/typ-serializer.ts`
- `src/md-parser.ts`, `src/md-serializer.ts`
- `src/tex-serializer.ts`
- `src/source-view.ts`, `src/source-typst-mode.ts`
- `src/collapse-spaces.ts`

`docToTyp` with `islands: 'print'` is the existing PDF/audit compile path.
Filter comments from that path **before joining blocks**, so omitted nodes
cannot leave extra paragraph separators or disturb first-line indentation.
Check that output equals serialization of the same document with comments
removed. Preserve source-position maps when omitting or retaining nodes.

Source mode already serializes on entry, parses on exit, and saves active
source verbatim. Parser/serializer support should therefore supply most of
the integration. Ensure recognition is scoped to top-level source and does
not reinterpret tagged text inside an existing code block/island.

Explicitly exempt `editor_comment` from printed-text normalization in
`collapse-spaces.ts`; setting `code: true` alone does not satisfy the current
implementation, which tests node names. Quotes, spaces, and punctuation in a
comment should remain exactly as authored. Exclude notes from printed-word
statistics and other derivations of publication content where applicable.

### Editing and presentation

Suggested new module `src/editor-comments.ts`:

- `EditorCommentView(node, view, getPos)` with a native ProseMirror
  `contentDOM`, plus a noneditable label/delete header.
- `insertEditorComment: Command`.
- `editorCommentKeymap(): Plugin`.

Integrate the NodeView and keymap in `src/main.ts`; register the keymap before
the general editing keymap, whose existing Mod-Enter inserts a page break.
Add Comment to the toolbar's Extras insertion controls in `src/toolbar.ts`.

Insertion must not alter printed prose by splitting a paragraph or replacing
a selection. Insert at a top-level boundary: before the block for a caret at
its start, otherwise after the final selected top-level block. Disable nested
insertion inside an existing note. Enter/Shift-Enter insert literal newlines;
Mod-Enter exits the note. If exiting must create a trailing paragraph, treat
that as an explicit document edit and test its export behavior separately.

Put presentation in `src/editor-comments.css`. The complete strip needs
zero vertical margins, border-box sizing, and no collapsed margins. Use the
existing `--page-margin-left/right` variables for full-width extension and
matching inset text, rather than hardcoded page measurements. Native editable
content avoids a textarea synchronization/resize loop. Ignore header-only
NodeView mutations, never content or selection mutations. Do not hide overflow
in a way that clips selection, page decorations, or editing affordances.

Browser printing must remove notes and their display-only space. Inspect the
existing source-mode print behavior before promising the same guarantee for
printing raw source; PDF export from source mode must always omit comments.

### Layout: separate print coordinates from displayed coordinates

This is the substantial part. Keep the existing line breaker and paginator.
Extend the existing mechanism for subtracting editor-inserted heights.

Current integration points:

- `src/layout/pagination-snapshot.ts`: `HeightIndex` and immutable height
  samples already translate painted coordinates back to natural geometry.
- `src/typeset-plugin.ts`: `capturePaginationSnapshot`, `runFallbackPass`,
  `applyTopAdjust`, `placeFootnotes`, and suffix-pagination basis management.
- `src/layout/typeset-state.ts`: `PageInfo` currently describes uniform pages.
- `src/main.ts`: `renderPages` assumes `k * (pageH + gap)` for every page.
- `src/layout/block-layout.ts`: `consecutiveParagraph` uses the previous
  sibling; CSS also currently relies on `p + p`.
- `src/layout/page-oracle.ts`: `buildUnits` must omit comments from audit units.

Recommended implementation sequence:

1. Capture each top-level note's actual `getBoundingClientRect().height`
   alongside existing spacer measurements. Build a separate cumulative note
   height index. Key samples so content after the note subtracts its full
   height, while the note's own top subtracts only preceding notes.
2. Recover print geometry by subtracting both page-gap heights and preceding
   comment heights from painted DOM coordinates. Skip comments entirely in
   the paginator's block walk, including sticky-heading and footnote ledgers.
3. Preserve neighborhood semantics across comments. `consecutiveParagraph`,
   its CSS equivalent, first-block top adjustment, and page-start normalization
   must see the surrounding printed blocks as adjacent. Merely skipping a
   node's height is insufficient.
4. After determining print page boundaries, produce per-page display
   geometry: page top, displayed height, and added comment height. Keep
   `pageH` as the unchanged print height. Use this shared geometry for sheet
   boxes, stack height, footnotes, folios, running headers/footers, and any
   conversion from a DOM position to its printed page number.
5. Replace fixed-stride screen calculations in `renderPages` and
   `placeFootnotes`. Do not replace the paginator's print-space page capacity
   with the larger displayed sheet height.
6. Check suffix/incremental paths and caches with comment insertion, deletion,
   and height-only edits. A safe initial fallback may run full local pagination
   for unsupported comment transitions; do not retain stale geometry or
   disable parity checks to get tests passing.

Define boundary affinity consistently. Recommended v1: a note follows the
preceding printed block; leading notes belong to page 1; notes after an
explicit page break belong to the new page. A note between a sticky heading
and its paragraph follows that heading when the pair moves. This policy is
an implementation recommendation, not a separately approved product decision.
Use actual paginator boundaries and document positions, not division of
already-stretched DOM coordinates by the original page height. Test page-gap
widget placement around adjacent notes and explicit page breaks.

### Verification and completion criteria

Add focused model/format tests and scripted-browser regression coverage.

- Round trips: `.typ` and `.md`, leading/trailing/adjacent/empty/multiline
  notes, arbitrary delimiters and escaping, undo/redo, clipboard, source/page
  switches, save/reopen. Reject nested nodes without losing pasted content.
- Export: comment-bearing and comment-free documents produce the same
  printable Typst body and semantic TeX output. Compiled PDF/SVG contains no
  comment text. Compare text/layout rather than PDF bytes that may contain
  unrelated metadata.
- Geometry: capture printed block line breaks/page assignments before and
  after adding notes. They must match. Sheet growth equals measured note
  height within existing subpixel tolerance; repeat after typing/deleting,
  resizing the window, changing settings, and removing the note.
- Include classic paragraph indentation, leading notes, notes at page
  boundaries, sticky headings, explicit page breaks, tables/lists adjacent
  to notes, multiple notes, oversized notes, footnotes, running section
  headers, and page-number restarts.
- Include at least one strict port-audit fixture with comments. Teach the
  matcher to skip notes, never weaken the audit or silently print the note.

Use the app's wired `window.view`, `__fm`, `__audit`, and `settleLocal` from
`tests/settle.ts`. Dynamic imports of app modules from `page.evaluate` can
create unwired second instances and false failures. Run appropriate unit and
browser tests, `npm run build`, and the relevant audit fixtures. Update
`AGENTS.md`/README to describe the explicit editorial exception without
loosening raw-island preservation or other rails.

Commit the completed comment feature locally before starting appearance work.

## Feature 2: optional warm editor appearance

### First increment: a local screen palette

Add **Editor appearance: Standard / Warm paper** to the settings panel.
Keep Standard as the initial default. Persist the selection on this device;
it is an editor preference, not a document attribute, undo event, or exported
Typst setting. Suggested helper text: “Screen colors only. Saved on this
device.”

Suggested implementation:

- New `src/appearance.ts` validates/loads/stores the preset and sets a root
  data attribute. Use a new key such as `typeset-appearance`; do not rename
  existing storage keys. Handle unavailable storage gracefully.
- Initialize it in `src/main.ts` early enough to avoid a palette flash.
- Add the selector to `toggleSettingsPanel` in `src/settings.ts`, using the
  existing selector UI. Changing appearance must not dispatch a document
  transaction or mark the document dirty.
- Override color tokens in `src/style.css`; route hardcoded publication ink
  in `.ProseMirror`, `.page-num`, footnotes, and separators through those
  tokens as appropriate. Preserve all widths, metrics, margins, and spacing.
- Apply the warm paper/ink to both page and source views. Keep the existing
  graphite room and toolbar styling unless inspection shows a contrast issue.
- Restore original print colors in browser-print rules. Typst/PDF/TeX output
  is unaffected by this preference.

Mockup palette:

| Element | Warm color |
| --- | --- |
| Paper | `#fcfbf7` |
| Document ink | `#2c2b26` |
| Muted document ink | `#746f65` |
| Comment strip | `#eeeadf` |
| Comment border | `#cfc2a7` |
| Comment text | `#5a4d37` |

Settings are currently disabled in source mode by the toolbar. A minimal
first increment can select appearance in page view and carry it into source
view. If exposing it directly in source mode, separate local appearance from
document-only controls rather than enabling unsupported source-mode settings.

Verify switching and reload persistence, both views, readable comment labels,
unchanged geometry/page breaks, unchanged serialized document/dirty state,
and unchanged export. Make a separate local commit.

### Typography: investigate separately; do not silently substitute

Only **New Computer Modern** is currently both exact and selectable in
`src/font-registry.ts`. There is no already-certified warmer serif to enable
as a shortcut. STIX Two Text, Libertinus, and TeX Gyre Pagella are present in
the inventory but marked uncertified/nonselectable.

Iowan Old Style is not present in the bundled font/license inventory. Its
availability and redistribution rights require separate verification. A
browser-only Iowan/Palatino/Georgia stack would change line widths and break
the editor/Typst contract; the palette option must not do that.

The practical first font candidate is **TeX Gyre Pagella**: four OTF faces and
its license are already bundled, and the registry recognizes Palatino as an
alias. It is a candidate to certify, not a verified visual or metric match
for Iowan. Investigate:

1. The same known font faces in browser, Typst compiler, and WASM sidecar.
2. Explicit browser font registration and calibrated registry parity metrics.
3. Shaped-width/browser checks and fixtures covering paragraph/heading breaks,
   lists, raw blocks, math, footnotes, tables, and page geometry.
4. Enable `exact` and `selectable` only once those checks support the claim.

Relevant files include `src/font-registry.ts`, `public/fonts/README.md`,
`src/style.css`, `src/layout/font-certification.test.ts`, `tests/fonts.spec.ts`,
and `tests/port-audit.spec.ts`, plus sidecar/compiler font registration.

A newly certified document font belongs in the existing document font
setting and must affect native serialization and export. It legitimately
reflows the document. Keep that behavior distinct from the screen-only Warm
paper preset, and report certification findings before widening this work.
