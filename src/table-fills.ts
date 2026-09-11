// Cell fill presets: a verified palette, not a free colour. Each preset is
// one Typst colour expression the exporter writes as `table.cell(fill: …)`
// and the importer reads back; the editor paints the same colour behind
// the cell (style.css `td[data-fill]`). A fill is paint only: nothing in
// the layout moves. Any other fill expression on a cell makes the table a
// raw island rather than a native table that has quietly lost its colour.

export type CellFill = '' | 'gray' | 'yellow' | 'blue';

export const CELL_FILL_TYPST: Record<Exclude<CellFill, ''>, string> = {
  gray: 'luma(240)',
  yellow: 'rgb("#fff3b0")',
  blue: 'rgb("#e6f0ff")',
};

// The page paints the same colours in style.css (`td[data-fill]`):
// gray #f0f0f0 (= luma(240)), yellow #fff3b0, blue #e6f0ff.

export const CELL_FILL_CYCLE: CellFill[] = ['', 'gray', 'yellow', 'blue'];

export function cellFillFromTypst(expr: string): Exclude<CellFill, ''> | null {
  const wanted = expr.trim().replace(/\s+/g, '');
  for (const [fill, value] of Object.entries(CELL_FILL_TYPST)) {
    if (value.replace(/\s+/g, '') === wanted) return fill as Exclude<CellFill, ''>;
  }
  return null;
}
