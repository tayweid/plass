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

## Report

Finish by writing `HANDOFF-TABLES-REPORT.md` at the repo root (committed on
your branch): what was ported, every adaptation made at the seams, schema/
serialization compat notes, test results verbatim, and anything you had to
leave undone. If you get blocked, write the report describing the blocker
and stop — a precise partial report is a success; an improvised redesign is
a failure.
