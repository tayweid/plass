# Native tables port report

Date: 2026-08-29  
Branch: `codex/native-tables-port`  
Base: current `main` at `df52679`

## Outcome

The port was not started because the handoff does not fit the current tree within its scope fence. Per the instruction, "If a step doesn't fit, stop and write the report instead of improvising," I stopped after the read-only preflight and scripted browser baseline. No source or test files were changed.

## What was ported

Nothing. The required branch was created from current `main`, and every named archive implementation/test plus the current integration seams was audited before editing.

The current app was also reproduced in a scripted browser before any change: choosing **Table** opens the existing modal dialog named **Edit table**, with the spreadsheet card and compiled preview. This confirms the pre-port behavior that the handoff intends to replace.

## Blocking scope conflicts

### 1. The required `src/table-split.ts` deletion breaks out-of-scope code

The handoff requires deleting `src/table-split.ts`, but current `main` still has these live imports:

```text
src/raw-preview.ts:17:import { fragmentSource } from './table-split';
src/layout/oracle-coordinator.test.ts:6:import { TableSplitPendingViews } from '../table-split';
```

`src/raw-preview.ts` calls `fragmentSource` for raw-Typst island rendering. `src/layout/oracle-coordinator.test.ts` constructs and tests `TableSplitPendingViews`. Neither file is in the permitted edit set, and the latter is explicitly inside `src/layout/**`, where the handoff allows only the two named `src/typeset-plugin.ts` seams. Deleting the file would therefore fail TypeScript compilation and the existing `npm test`; retaining or relocating its shared exports would violate the mandatory deletion or scope fence.

### 2. Required editor/test wiring lives outside the scope fence

The archive editor exports `insertStructuredTable`, but current callers outside the allowed set still depend on `insertTableWithEditor`:

```text
src/editing.ts:265:        void import('./table-editor').then(({ insertTableWithEditor }) => insertTableWithEditor(view));
src/toolbar.ts:14:import { insertTableWithEditor } from './table-editor';
```

The archive's native Tab/Shift-Tab behavior also requires `goToNextCell` wiring in `src/editing.ts`. In addition:

- The verbatim `src/transaction-impact.test.ts` assertions require the archive's derived-structure integration in `src/equations.ts`; current code rebuilds labels on ordinary table typing and counts uncaptioned tables. `src/equations.ts` is outside the fence.
- Existing `tests/previews.spec.ts` asserts the compiled table-preview DOM that the handoff deletes.
- Existing `tests/security.spec.ts` invokes the removed `openTableEditor` modal API.

Both Playwright files are outside the listed table test port, yet the required full Chromium run cannot pass unmodified after the deletion.

### 3. The requested crossing-table continuous mode is absent on current `main`

The archive's exact-map guard rejects a page start inside a table into a real labeled continuous surface. Current `main` instead defines:

```text
private pagPath: 'exact' | 'held' | 'fallback' = 'exact';
```

Its `PageInfo` and `src/main.ts` have no continuous mode/reason contract. A `null` result from current `paginateForced` enters local fallback pagination and can retain mapped exact page markers/basis; it does not publish the requested continuous surface. Implementing the verification gate would require broader state, publication, and UI changes outside the two authorized `src/typeset-plugin.ts` seams.

Current `tests/layout.spec.ts` also requires `tableScans === captures`. Removing table-split telemetry mechanically would fail that existing pagination spec, which the handoff says must pass unmodified.

### 4. The Markdown unchanged-round-trip gate is not implemented on either branch

The archive and current Markdown table parser/serializer are identical. Canonical GFM tables round-trip as native nodes, but Markdown cannot retain the requested styled/captioned cases under the repository's pure-Markdown policy:

- `grid` and `plain` reopen as the default `booktabs` style.
- `fontSize`, `caption`, `label`, and raw table `params` are not serialized.
- merged cells and multiple cell paragraphs are flattened.

The serializer warns for some unrepresentable metadata, but `open -> save unchanged` for styled and captioned Markdown is impossible without choosing a new representation. The archive contains no such representation, so satisfying this gate would be a product/format redesign forbidden by the handoff.

## Audited adaptations that would otherwise be needed

These were identified but not applied because of the blockers above:

- Replace `src/table-editor.ts` with the archive native editor and add the dependency-free `src/transaction-impact.ts`.
- Add `structuredTablePlugin()` and `tableEditing()` to `src/main.ts`; remove the table preview node view.
- Keep the already-compatible table schema attributes in `src/schema.ts` unchanged.
- Port the lossless `tableCellContentToTyp`/balanced-bracket serialization path, bibliography-aware citation validation, and parser's balanced table extraction/multi-paragraph/fail-closed rowspan logic without importing the archive's reverted `typst_embed` architecture.
- Replace the legacy preview/card CSS with the archive native toolbar, table, caption, selection, 5pt inset, and print rules.
- Remove table-split effects from `src/typeset-plugin.ts`, let tables use its existing atomic default, and reject exact page maps whose starts land inside a table while also abandoning retained exact markers.
- Leave `src/layout/pagination-suffix.ts` unchanged. Its table ineligibility could be relaxed later once tables are plain atomic units, as requested by the handoff.
- Port the three Node test files and `tests/native-tables.spec.ts`, adapting raw-island expectations to current `code_block({ params: 'typst-raw' })` and removing all dynamic `/src/...` imports from `page.evaluate`.

## Verification results

Required verification gates were not run because implementation stopped at the mandatory preflight blocker. Running them on an unmodified branch would not verify the requested port, while deleting `src/table-split.ts` as directed would produce known import failures in the two files quoted above.

Commands/actions completed:

```text
$ git switch -c codex/native-tables-port
Switched to a new branch 'codex/native-tables-port'
```

```text
Scripted browser baseline: PASS
Table toolbar action -> dialog "Edit table" (legacy modal-card editor present)
```

Not run due to the handoff's stop-on-mismatch rule:

```text
npm test
npx tsc --noEmit
npm run check:cycles
npm run check:unused
npm run check:exports
npx playwright test --project=chromium
```

## Files changed

- `HANDOFF-TABLES-REPORT.md` only.

The unrelated untracked `AGENTS.md` was preserved and not staged.
