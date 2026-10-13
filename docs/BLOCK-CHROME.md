# Block chrome: editing tables and grids

The controls and on-paper marks shown while the caret is in a table or a
grid. Designed and approved 2026-10-12 (Taylor: "all recommended"), built
2026-10-12/13 on `ui/tables-grids`. It replaced two docked bars of text
buttons over the page and the dashed cell outlines. Here: its rules.

## The one rule: paint only

Nothing here may move a line break, a block height or a page start.

- On the paper, chrome is pseudo-elements (`::before` / `::after`,
  absolutely positioned), `outline`, `box-shadow`, and custom properties.
  Never `border`, `padding`, `margin`, `font-*` or `line-height` on a
  laid-out box.
- Off the paper, the pill and its flyouts live outside `#paper` (in
  `#scroll`, or fixed to the window), so they cannot touch layout.
- No geometry on the typing path. A keystroke in a cell reads no rect and
  writes no style for chrome. The pill is placed when the selection
  enters a block, when a structure revision changes (a row, a column, an
  attribute), after a pagination pass (written only if it moved more than
  0.5 px), and on a resize or paper-scale change. The first keystroke
  dims the pill (a class).
- Strokes divide by `--ps` (the paper scale) so a 1 px ring stays 1 px on
  screen under `#stack`'s transform. It is written only on the edited
  grid's cells (the wash pass) and the edited `<table>` (TableEditingPaint).
  It is never written on `#editor`.
- Print hides it all.
- Proof: `npm run audit` (fixtures and an exam) shows no moved break or
  page start, and `tests/block-chrome.spec.ts` shows no block, cell box or
  cell margin moving when the caret enters any grid or table, at the
  default window and at 740 px.

## On the paper

- **Grid cells**: a rounded wash behind every cell of the grid being
  edited. The wash is as tall as the row's ink (every cell in a row ends
  level) with air around it, so descenders and answer boxes sit inside.
  The caret's cell gets an accent wash and a 1 px ring. The ink and air
  come from GridCellView's wash pass (`--cell-ink-*`, `--air-t/-b`).
- **Joined grids**: below a 0.6 em gutter (`ts-grid-joined`, read from
  the attribute) the washes tile into one surface. Hairlines sit at the
  gutter midlines, and only the grid's four outer corners are rounded.
- **Tables**: no wash, so fills read true. The caret's cell gets a 1 px
  ring on `::before`, inset to clear the style's rules
  (`ts-table-editing` / `ts-cell-active` decorations). A Plain table shows
  ghost edges while edited: inset shadows on cells only, right+bottom per
  cell, left on column 0 (`ts-cell-col0`), top on the first row, the header
  copy and the row after a break; the break row draws none. A row rule
  replaces only the ghost under its row.
- **Selection**: one 14% overlay for a cell selection, the native
  highlight hidden; a selected inline image rings itself, its cell not.
- **Placeholder** "Type, or add an image" ("Type…" if it does not fit):
  only in the caret's empty cell.

## Decisions (Taylor, 2026-10-12)

1. Inactive grid cells: wash only, no hairline. In tight rows (an ink gap
   under 2 × air + 3 px) the two rows' washes join at the gap's midline,
   with square corners and one hairline seam. The grid's outer edges get at
   least 0.3 em of air (0.45 em beside a heading).
2. An empty cell that is not the caret's has no wash, only a faint inset
   hairline (a spacer column reads as structure). There is one exception:
   in a joined grid it keeps the wash and dividers, so the surface has no
   hole.
3. The pill hugs a narrow centred block. Its right edge is
   `min(textLeft − gap, blockLeft − gap)`. Full-width blocks land at the
   margin place. When it hugs, captions and flyouts open to the left, into
   the empty margin, when they fit there.
4. Grid add and delete row or column act at the caret's row or column,
   as they do in tables.
5. The grid's Image tile inserts a plain inline image at 100% of the cell
   width (how exam answer boxes are written). Numbered figures still come
   from Insert.
6. No header-row marker.

## The pill

- **Layer**: one `#block-chrome` inside `#scroll`, after `#paper`. A
  `.block-track` spans the block, and the pill inside it is
  `position: sticky`. The pill rides down a tall block as the page scrolls
  and stops at the block's end. There is no scroll handler.
- **Place**: in the left margin beside the block, never over text. Full
  (margin ≥ 60 px): 40 px wide, 32 px tiles, 14 px from the text. Compact
  (46–60 px): 34 px, 28 px tiles, 8 px. Collapsed (< 46 px): one ⋯ tile
  opening the same items as a menu.
- **Tiles**: table: Rows · Columns · Align (its glyph shows the caret
  cell's value) · Cell │ Table settings; grid: Rows · Columns · Image │
  Grid layout. A table in a grid cell owns the pill and adds one Grid tile.
- **Names**: `role=toolbar` "Table controls" / "Grid controls"; menu
  items keep the commands' long names ("Add row below", "Merge selected
  cells", …), values ride as `data-value` (`booktabs`, `gray-dark`, `fr`).
  Tests select by role, name and `data-value`.
- **Readout**: a visually hidden, `aria-live` readout says `Row r of R ·
  Column c of C` (`.grid-toolbar-position` / `.table-toolbar-position`).
  A hidden image hint (`.grid-toolbar-hint`) speaks while an image in a
  cell is selected.
- **Menus and panels** use the rail's dark glass, placed by `flyout.ts`.
  Both panels are 284 px wide with a 60 px label column. They are presets
  first, with a number one step deeper: column widths and padding (pt),
  the grid split (Custom field, shown as a ratio or percent) and the
  gutter (em). Caption and Label are written after a 250 ms pause, never
  per keystroke and without scrolling. Clicking a table's on-page caption
  opens Table settings at Caption. Refusals go to the app toast
  (`notify.ts`).

## Where the code lives

| File | What |
|---|---|
| `src/block-chrome.ts`, `.css` | the layer, pill, placement, menus, panels |
| `src/grid-editor.ts` | GridCellView fit and wash pass, grid decorations, caret commands (`insertGridRowAt` …) |
| `src/table-editor.ts` | table commands, `ts-table-editing` / `ts-cell-active` / `ts-cell-col0`, `--ps` on the table |
| `src/style.css` | cell-chrome tokens (`--cell-wash`, `--cell-ring`, `--cell-line`, …) and the paper CSS |
| `src/grid-split.ts` | split parsing (ratios, `60/40`, percents) and the display rule |
| `src/flyout.ts`, `src/notify.ts`, `src/paper-scale.ts` | flyout placement, toasts, scale hook |
| `tests/block-chrome.spec.ts`, `cell-chrome.spec.ts` | layout stays put; paint vocabulary |
| `tests/block-pill.spec.ts`, `block-panels.spec.ts` | pill, menus, panels, hot path |

Still open: keyboard additions (Escape selects the block, ⌘⏎ / ⇧⌘⏎ add rows, ↑/↓ leave a grid, Tab into the pill); a dark-glass image bar.
