# Roadmap

Working list for upcoming sessions. Ordering within sections is a
suggestion (value ÷ effort for academic writing); parity notes flag where
a feature touches the oracle machinery.

## Tables (the styling list)

1. **Caption + label** — tables become numbered floats: "Table 1: …" with
   `@tab:` references, exactly like figures. Export wraps in
   `#figure(table(...), caption: [...]) <label>`. Needs: schema attrs
   (caption content or attr, label), numbering-plugin extension, card
   fields (caption text + label), serializer/parser round-trip. Highest
   value: papers cite tables.
2. **Column widths** — `auto` / `1fr` / fixed lengths per column. UI: a
   width chip row above the grid in the card (click to cycle auto → 1fr →
   custom), or drag column borders. Emits `columns: (auto, 1fr, 2cm)`;
   parser already carries non-numeric columns specs via params.
3. **Decimal alignment** — align numbers on the decimal point (the econ
   signature). Typst has no native decimal tab; standard trick is
   splitting into two columns joined at the point, or padding via figure
   space. Design needed — possibly a per-column "decimal" align mode in
   the card that transforms on export.
4. **Fills** — header-row shading, zebra striping, per-selection fill.
   UI: a small fill control in the card tools (none / header / zebra /
   custom color for selection). Emits `fill:` function or per-cell
   `table.cell(fill: …)`.
5. **Table font size** — papers often set tables at 0.8–0.9em. A size
   control in the card; emits a wrapping `#[#set text(size: …) …]` or
   `text(size:)` param. Interacts with parity (fragment + export must
   agree — they share the serializer, so free).
6. **Vertical rules** — same interaction as midrules: click a *column*
   boundary in the grid. Emits `table.vline(x: n)`; parser treats
   x-rules like y-rules (params passthrough).
7. **Rule weights** — light/heavy midrule choice (booktabs toprule vs
   midrule); maybe a click-cycle on an active rule.
8. **Cell insets** — density presets (compact / normal / roomy) →
   `inset:`.
9. **Merges + shape ops together** — column/row insert/delete that
   understands spans (occupancy grid) instead of disabling while merges
   exist.
10. **Rich cells in the card** — editing math/references inside cells
    (currently preserved but read-only-ish). Possibly a per-cell "edit as
    math" affordance.
11. **Long tables** — `table.header` repetition across page breaks; the
    editor's table block is currently atomic in pagination, and the page
    oracle rejects mid-table splits — both need extending.

## Page setup

1. ~~**Manual page break**~~ — done: ⌘Enter / ⋯ menu; zero-height block
   with a floating chip; exports `#pagebreak()`; both engines break
   identically.
2. ~~**Margins UI**~~ — done: per-side T/R/B/L inputs in Settings;
   uniform margins export as `margin: Xin` (back-compat), asymmetric as
   the dict form; legacy `marginIn` migrates. (Inside/outside two-sided
   still open.)
3. ~~**Paper sizes**~~ — done: letter/A4/legal/B5 (custom dimensions still
   open).
4. ~~**Orientation**~~ — done: landscape via `flipped: true`.
5. **Multiple columns** — `#set page(columns: 2)`. The big one, flagged
   honestly: this reshapes the whole oracle pipeline. The line-break
   oracle needs the per-column measure; the page oracle needs per-column
   line extraction (tsel geometry per column region); the editor's
   continuous-flow-with-spacers model needs a two-column rendering
   strategy (CSS columns fight the decoration/pagination model — likely
   needs oracle-driven column-break spacers analogous to page breaks).
   Design session first; don't start it as a side quest.
6. **Running headers/footers** — custom header/footer content (short
   title, author, section name via `context`), page number placement in
   the header, different first page. Settings UI + emission + the painted
   page chrome mirroring it.
7. **Title block / front matter** — title, author(s), date, abstract as
   structured fields rendering the standard academic opening (and
   exporting as proper Typst). Big quality-of-life for papers/problem
   sets.
8. **Keep-together controls** — "keep heading with next block",
   "avoid break inside block" toggles; the page oracle honors whatever
   Typst does, so this is mostly emission (`block(breakable: false)`) +
   an editor affordance.
9. **Footnote options** — per-page vs continuous numbering, separator
   rule length/weight; footnote-body ink parity (bodies still browser-
   laid-out; same fragment treatment as bibliography would finish it).
10. **Section-scoped numbering** — roman front matter → arabic body
    (counter update exists; needs a "restart numbering here" block).
11. **Draft niceties** — line spacing presets (1.5/double for review),
    DRAFT watermark/background, line numbers in the margin.

## Paragraph-level typography (adjacent, same machinery)

- **First-line indent mode** — TeX-style indented paragraphs (no gap,
  `\parindent`) vs the current block style: one setting, `#set par(
  first-line-indent: …, spacing: …)` + editor CSS + parity re-derivation.
  Classic academic look; worth doing early.
- Hyphenation language selection; justification toggle per document.
- Heading font pairing (sans headings over serif body).

## Standing backlog

- Raw-Typst-island compiled previews (same pattern as tables/math/bib).
- Incremental pagination for 50+ page documents (performance).
- Table/figure float placement (`placement: auto` — drift to page top).
- Image sidecar files on save (CLI-compilable exports without data URLs).
- Editing-jitter polish: map stale page-oracle results through edits
  instead of falling back to local pagination while recompiling.
- Dogfooding: write a real problem set / lecture note; harvest frictions.