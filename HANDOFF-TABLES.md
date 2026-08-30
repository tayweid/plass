# Handoff: port native editable tables from the archive branch

This is a fenced, mechanical port. The target code already exists on branch
`codex/archive-proof-architecture` and was audited for coupling; your job is
to transplant it onto current `main`, adapt it at the named seams, verify,
and report. **Do not redesign anything.** If a step doesn't fit, stop and
write the report instead of improvising.

## Ground rules

- Create branch `codex/native-tables-port` from current `main`. All commits
  go there. Never commit to `main`, never push `main`, never force-push.
- Commit messages: imperative title + reasoning body. No attribution lines
  of any kind (no Co-Authored-By, no "generated with" footers).
- Doctrine (non-negotiable, from CLAUDE.md): document text equals printed
  text; editor block heights match Typst's (vertical parity — CSS changes
  must not alter layout heights); never destroy user content (reject
  unserializable edits with a visible toast, don't drop them).
- Scope fence: touch ONLY the files listed below, plus minimal wiring in
  `src/main.ts`, `src/schema.ts`, `src/typ-serializer.ts`/`src/typ-parser.ts`,
  `src/md-serializer.ts`/`src/md-parser.ts` (if table serialization moved),
  and `src/style.css`. Do NOT touch anything else in `src/layout/**`
  (flow-rules, pagination-suffix*, page-oracle, typst-oracle, port/) except
  the two specific paginator seams named below. Do not edit PAGE-PORT.md,
  PORT.md, or test files unrelated to tables.

## What to port (read each on the archive branch first: `git show codex/archive-proof-architecture:src/<file>`)

- `src/table-editor.ts` — full replacement: prosemirror-tables based
  in-document editing (`tableEditing()` + `structuredTablePlugin()`), the
  `NativeTableControls` floating toolbar, `dispatchTableAttrs` details
  panel (caption + label), `captionDecorations`, `alignSelectedTableCells`,
  `setTableStyle`, and the `filterTransaction` round-trip guard with
  `announceTableConstraint` toast (history transactions exempt via
  `isHistoryTransaction`).
- `src/transaction-impact.ts` + `src/transaction-impact.test.ts` — lifts
  verbatim (dependency-free); the toolbar's `controlsRevision` uses it so
  plain typing never rebuilds controls.
- `src/native-table.test.ts`, `src/table-integrity.test.ts`,
  `tests/native-tables.spec.ts` — port and wire into `npm test` /
  Playwright. Adapt imports; keep assertions.
- The archive `style.css` table block (~lines 1471–1541 there): the
  booktabs/grid/plain visual styles and the 5pt-inset height-parity work.
- The archive `typ-serializer.ts` `tableCellContentToTyp` (certified cell
  subset; throws on unsupported content) and whatever schema attrs the
  native table nodes need. **Back-compat is mandatory**: existing `.typ`
  and `.md` documents containing tables must still parse into the new
  native nodes (check the archive's parser side), and round-trip tests
  must prove serialize(parse(x)) stability.

## What to delete (after the port compiles)

- `src/table-preview.ts`, `src/table-rules.ts`, `src/table-split.ts`, and
  the modal-card editor in the current `src/table-editor.ts`.
- The paginator's table-split integration — TWO seams in
  `src/typeset-plugin.ts` only (line numbers have drifted; search):
  1. `tableCase()` inside `runFallbackPass` and its `tableExtras`/
     `TableEffect` plumbing: a table becomes a plain atomic unit (falls to
     the existing `default: atomic` dispatch). Remove the table-split
     request path entirely.
  2. The exact-page-map translation: port the archive's rule (archive
     `typeset-plugin.ts` ~1323–1326) — a compiled page start landing
     INSIDE a table declines that exact page map (document falls back to
     the labeled continuous surface). Page starts between blocks are
     unaffected.
- Leave `src/layout/pagination-suffix.ts`'s table ineligibility AS IS
  (tables stay excluded from suffix seeding for now) — note in the report
  that it could be relaxed once tables are plain atomic units.

## Verification gates (all required before you finish)

1. `npm test` (including the two ported node test files), `npx tsc
   --noEmit`, `npm run check:cycles`, `npm run check:unused`,
   `npm run check:exports`.
2. Full chromium Playwright: `npx playwright test --project=chromium` —
   green, including the ported `native-tables.spec.ts`. Existing
   pagination specs must pass unmodified.
3. Add one Playwright check: a document with a table that FITS a page
   keeps exact pagination (an `exact[` entry appears in
   `window.__pagLog()`), and a document whose table CROSSES a page
   boundary settles to continuous mode without error loops or console
   spam. (Drive `window.view` and app globals; never dynamic-import
   `/src/...` modules inside `page.evaluate` — it creates unwired second
   instances.)
4. Serializer round-trips: `.typ` and `.md` docs with tables (plain,
   styled, header row, captioned) survive open→save unchanged.

## Amendment 1 (responds to HANDOFF-TABLES-REPORT.md's four blockers)

All four blockers are accepted as spec defects in this brief. Resolutions:

1. **table-split deletion.** Do not delete wholesale. Move `fragmentSource`
   into a new tiny module `src/fragment-source.ts` (raw-preview.ts updates
   its one import line — that edit is now in scope), then delete the rest
   of `src/table-split.ts`. In `src/layout/oracle-coordinator.test.ts`,
   delete only the `TableSplitPendingViews` test block (it covers deleted
   machinery); that file is in scope for that deletion alone.
2. **Wiring fence widened.** `src/editing.ts` (insert-command swap +
   `goToNextCell` Tab/Shift-Tab wiring), `src/toolbar.ts`
   (`insertStructuredTable`), and `src/equations.ts` (the derived-structure
   integration the archive's transaction-impact assertions require) are in
   scope. `tests/previews.spec.ts`, `tests/security.spec.ts`, and the
   `tableScans === captures` assertion in `tests/layout.spec.ts` may be
   updated ONLY where they pin the deleted modal/preview/split machinery —
   replace with the native-equivalent assertion (e.g. security spec drives
   the native editing surface instead of `openTableEditor`), and justify
   each change in the report.
3. **No continuous mode — corrected behavior.** Current main has no labeled
   continuous surface; do not build one. Correct spec: an exact page map
   with a start inside a table is declined (return the existing null/fail
   path) AND the retained exact markers/basis are dropped for that
   revision so the held path cannot resurrect a mid-table split; pagination
   then proceeds on the existing local fallback with the table atomic. A
   table taller than the page content height overflows per the existing
   oversize rule. The verification gate becomes: the crossing-table
   document settles on the fallback path (`pagPath === 'fallback'`) with
   stable geometry, no error loops, no console spam.
4. **Markdown gate relaxed.** Canonical GFM tables must round-trip
   unchanged. Styled/captioned/merged/multi-paragraph tables follow the
   serializer's existing degradation (identical on both branches): the
   gate is "no worse than current main," demonstrated in the report with
   one example per degradation class. No new Markdown representation may
   be invented. The `.typ` round-trip gate stays as written (lossless).

Everything else in the original brief stands, including stop-and-report on
any further mismatch.

## Report

Finish by writing `HANDOFF-TABLES-REPORT.md` at the repo root (committed on
your branch): what was ported, every adaptation made at the seams, schema/
serialization compat notes, test results verbatim, and anything you had to
leave undone. If you get blocked, write the report describing the blocker
and stop — a precise partial report is a success; an improvised redesign is
a failure.
