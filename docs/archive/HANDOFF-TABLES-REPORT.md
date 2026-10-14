# Native tables port report

Date: 2026-08-29  
Branch: `codex/native-tables-port`  
Base: `main` at `df52679`

## Outcome

Amendment 1 resolved the four preflight blockers. The native editable table
port is complete: tables are ProseMirror table trees edited in place, the
modal/compiled-preview/split-rendering path is gone, Typst table serialization
is lossless for the certified cell subset, and crossing tables settle on the
existing atomic fallback without reviving retained exact markers.

No new Markdown representation or continuous-pagination mode was introduced.
The untracked repository-root `AGENTS.md` was preserved and is not part of the
commit.

## Ported implementation

### Native editing and controls

- Replaced `src/table-editor.ts` with the archive implementation byte-for-byte.
  It provides `tableEditing()`/`structuredTablePlugin()` integration, direct
  rich-cell editing, rectangular `CellSelection`, row/column/header/merge/split
  commands, alignment and style controls, caption/label details, caption
  decorations, and the floating `NativeTableControls` toolbar.
- The archive `filterTransaction` guard remains intact. Unsupported new table
  content is rejected before it enters the document and a visible
  `.native-table-notice` explains that the edit was not applied. Undo/redo is
  exempt so historical unsupported content can be restored exactly.
- Lifted `src/transaction-impact.ts` and
  `src/transaction-impact.test.ts` byte-for-byte. `controlsRevision` and the
  numbering plugin map ordinary cell/caption typing instead of rebuilding
  derived structure.
- Lifted the archive `src/equations.ts` integration byte-for-byte. Plain tables
  do not consume table numbers; caption/label presence and table topology still
  invalidate numbering/reference structure when required.
- `src/editing.ts` now inserts `insertStructuredTable` and chains native
  `goToNextCell` before the existing list Tab/Shift-Tab commands.
- `src/toolbar.ts` inserts native tables and avoids redundant block-format DOM
  updates when the current block kind has not changed.
- `src/main.ts` installs `structuredTablePlugin()` and `tableEditing()` last,
  removes the table preview node view, and exposes a development-only
  `window.__nativeTableProofGeometry()` hook. That hook uses the running app's
  compiler/sanitizer instances so Playwright never imports a second `/src/...`
  module graph inside `page.evaluate`.

The existing table schema already matched the archive's required native attrs
(`style`, `params`, `caption`, `label`, `fontSize`, cell `align`, colspan,
rowspan, and colwidth), so `src/schema.ts` required no change.

### Preview and split deletion

- Deleted `src/table-preview.ts`, `src/table-rules.ts`, and the split machinery
  in `src/table-split.ts`.
- Moved only the still-shared `fragmentSource` helper to
  `src/fragment-source.ts`; `src/raw-preview.ts` now imports it there.
- Removed the split-ready listener/cache lifecycle, `TableEffect`,
  `tableExtras`, staged split effects, split requests, and `tableCase()` from
  `src/typeset-plugin.ts`. Tables now reach the existing default atomic
  fallback branch.
- Removed only the `TableSplitPendingViews` import and test block from
  `src/layout/oracle-coordinator.test.ts`, exactly as Amendment 1 permits.
- Removed the obsolete table scan metric/assertion from
  `tests/layout.spec.ts`; it measured the deleted `tableExtras` scan.
- Preserved the existing table skip in PageParity shadow telemetry and left
  `src/layout/pagination-suffix.ts` byte-unchanged.

### Exact-map rejection and fallback

`paginateForced` now rejects an exact page start whose unit is `table` and
whose line is greater than zero. Before returning the existing `null` path it:

1. stages an empty page-marker set,
2. resets the retained page count, and
3. clears the retained exact basis.

The successful exact result is therefore not eligible for the held-marker
recovery path. Local fallback then treats the table as one atomic block. An
oversized table follows the existing oversize rule and overflows; there is no
new continuous surface.

The added browser regression first installs a fitting four-row table and waits
for an `exact[...]` publication. In the same app instance, retaining that exact
basis, it replaces the document with a 45-row crossing table, observes a real
PageOracle answer with a mid-table start, then requires
`pagPath === 'fallback'`. It also requires a 600 ms quiet interval with byte-identical
pagination count/log entry, table rectangle, and page-gap keys/heights, plus no
page errors or captured warning/error console messages.

### CSS and vertical parity

- Ported the archive native table toolbar, caption, selection, booktabs/grid/
  plain, intrinsic-width, font-size, and print rules.
- Native tables use centered intrinsic width, inherited line height and weight,
  5 pt inline inset, and the archive empty-cell 5 pt block-inset restoration.
  No layout-height adjustment is implemented with a paint-only substitute.
- Removed legacy modal-card, compiled-preview, cell-hit, split-render, and
  orphan preview SVG styles.

## Typst compatibility and losslessness

The archive's certified table-cell subset was adapted to current main's
`code_block({ params: 'typst-raw' })` raw-island architecture rather than
importing the reverted archive-wide embed architecture.

- Cells serialize one or more paragraphs containing text, strong/emphasis/
  strike/code marks, hard breaks, inline math, equation references, and valid
  citations. Empty paragraphs receive an inert private boundary that the parser
  removes again.
- Table-scoped escaping keeps literal `//`, tildes, backticks in code, raw-string
  inline math, unmatched visible parentheses, and caption text non-executable
  and round-trippable.
- Portable table/reference labels and bibliography-backed citations are
  validated. Unsupported blocks, inline nodes, marks, combined code marks, or
  multiline inline sources throw instead of flattening or dropping content.
- The parser uses balanced table/figure/cell extraction, understands the safe
  raw-string shapes, reconstructs multiple paragraphs, and fails closed on
  unrepresentable rowspan topology. A rejected hand-written table is retained
  verbatim as a raw Typst island.
- Legacy inline-math and existing generated table forms continue to import.

The Node suites prove idempotent `.typ` serialization for plain, styled,
header-row, captioned/labeled, decimal, custom-parameter, multi-paragraph, and
rich marked/inline-atom tables. Existing `.typ` parser tests remain green.

## Markdown compatibility demonstrations

`src/md-parser.ts` and `src/md-serializer.ts` are unchanged. No private syntax
was added. The new integrity test pins current-main behavior explicitly.

Canonical GFM is byte-stable:

```markdown
| Left | Right |
| --- | ---: |
| A | 1 |
```

The following non-representable cases are no worse than current main:

- **Styled:** a native `grid`, `fontSize: 0.85em` table with cells `H`/`V`
  saves as the plain GFM below and reopens with the existing defaults
  (`booktabs`, default size):

  ```markdown
  | H |
  | --- |
  | V |
  ```

- **Captioned/labeled:** the same GFM body is emitted, caption and label are
  omitted, and the existing warning is produced verbatim:
  `table styling/captions are not representable in Markdown — simplified to a plain table`.
- **Merged:** a two-column header cell `Wide` is flattened to
  `| Wide |  |`, followed by the two normal columns, and the existing warning
  is produced verbatim: `merged table cells flattened for Markdown`.
- **Multi-paragraph:** cell paragraphs `First` and `Second` serialize as the
  existing single GFM cell `First Second` and reopen as one paragraph.

Canonical GFM header cells still import as native `table_header` nodes.

## Test adaptations

- `src/native-table.test.ts` is byte-identical to the archive and is wired into
  `npm test` together with the adapted archive `src/table-integrity.test.ts`.
- `tests/native-tables.spec.ts` retains every archive assertion. Archive-only
  module imports were adapted to live app globals; the new exact/fallback test
  was added as described above.
- `tests/previews.spec.ts` now asserts that all 30 tables mount as native
  editable DOM with no legacy preview/loading queue.
- `tests/security.spec.ts` now drives the native surface: focusing a cell is
  compiler-epoch inert, while a real cell edit advances the epoch and resets
  the open timeout circuit. It also asserts the removed modal/preview DOM is
  absent.
- `tests/layout.spec.ts` lost only the deleted table-scan assertion.

## Verification results

All required gates were run on the completed tree. Command results are copied
verbatim below.

```text
$ npm test
all transaction impact tests passed
all oracle lifecycle tests passed
all table-integrity tests passed
all native-table tests passed
all typ-parser tests passed
all md round-trip tests passed
all security boundary tests passed
all font registry tests passed
exit 0
```

```text
$ npx tsc --noEmit
(no output)
exit 0
```

```text
$ npm run check:cycles
static import graph is acyclic (93 modules)
exit 0

$ npm run check:unused
unused-code check passed (one documented frozen-port exception)
exit 0

$ npm run check:exports
(no output)
exit 0
```

```text
$ npx playwright test tests/native-tables.spec.ts --project=chromium
6 passed (7.3s)
exit 0
```

```text
$ npx playwright test --project=chromium
67 passed (26.8s)
exit 0
```

```text
$ npm run build
sidecar source, provenance, and WASM verified (8be3dd182b4e653d596b8468bd0054caaa47d7b9d277bd0ded01ec065614aa2e)
unused-code check passed (one documented frozen-port exception)
static import graph is acyclic (93 modules)
✓ 114 modules transformed.
✓ built in 665ms
exit 0
```

```text
$ git diff --check
(no output)
exit 0

$ git diff --exit-code -- src/layout/pagination-suffix.ts
(no output)
exit 0
```

## Deliberately left unchanged / follow-up

- `src/layout/pagination-suffix.ts` still excludes tables from suffix seeding,
  as required. Now that tables are plain atomic units, that restriction and the
  matching PageParity telemetry skip could be relaxed together in a later,
  separately verified change.
- Markdown retains its existing pure-GFM degradation for styling, captions,
  merged cells, and multiple cell paragraphs; no new representation was
  invented.
- Nothing else from the amended brief is left undone.
