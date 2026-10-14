// Table density presets: Typst's cell `inset`, one value for the whole
// table. Typst's default is 5pt; the presets are verified rails, not a
// free parameter (Typst on rails). The editor's CSS mirrors the inset
// exactly (style.css `--cell-inset`), the exporter writes `inset: Npt`,
// and the importer reads a uniform `inset: Npt` back into the preset —
// any other inset form stays a custom parameter.

export type TableDensity = '' | 'compact' | 'roomy';

export const TABLE_DENSITY_INSET_PT: Record<TableDensity, number> = { compact: 3, '': 5, roomy: 8 };

export function densityFromInsetPt(pt: number): TableDensity | null {
  for (const [density, value] of Object.entries(TABLE_DENSITY_INSET_PT)) {
    if (Math.abs(value - pt) < 1e-6) return density as TableDensity;
  }
  return null;
}
