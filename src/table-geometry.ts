import { TABLE_DENSITY_INSET_PT, type TableDensity } from './table-density';

/** The supported column tracks: content size, fractional share, or points. */
export function normalizeTableColumns(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 128) return null;
  const columns: string[] = [];
  for (const entry of value) {
    if (entry === 'auto') { columns.push(entry); continue; }
    if (typeof entry !== 'string') return null;
    const m = /^(\d+(?:\.\d+)?)(fr|pt)$/.exec(entry.trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n > 1440 || (m[2] === 'fr' ? n <= 0 : n < 0)) return null;
    columns.push(`${n}${m[2]}`);
  }
  return columns;
}

export function normalizeInsetPt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 72 ? value : null;
}

export function tableInsetPt(attrs: Record<string, unknown>): number {
  return normalizeInsetPt(attrs.insetPt) ?? TABLE_DENSITY_INSET_PT[attrs.density as TableDensity] ?? 5;
}

/** Typst 951788cc grid/layouter.rs measure_columns/grow_fractional_columns/
 * shrink_auto_columns. All lengths are CSS px; intrinsic widths include
 * cell insets and the last spanned auto column owns any colspan deficit. */
export function allocateTableColumns(columns: readonly string[], intrinsic: readonly number[], available: number): number[] {
  const widths = columns.map((c) => c.endsWith('pt') ? parseFloat(c) / 0.75 : 0);
  const fixed = widths.reduce((a, b) => a + b, 0);
  const remaining = available - fixed;
  if (remaining < 0) return widths;
  let auto = 0;
  let shares = 0;
  const autoIndices: number[] = [];
  columns.forEach((col, i) => {
    if (col === 'auto') {
      widths[i] = Math.max(0, Math.min(remaining, intrinsic[i] ?? 0));
      auto += widths[i];
      autoIndices.push(i);
    } else if (col.endsWith('fr')) shares += parseFloat(col);
  });
  if (auto <= remaining) {
    columns.forEach((col, i) => {
      if (col.endsWith('fr')) widths[i] = shares > 0 ? parseFloat(col) / shares * (remaining - auto) : 0;
    });
  } else {
    let pool = remaining;
    let pending = autoIndices;
    while (pending.length) {
      const fair = pool / pending.length;
      const small = pending.filter((i) => widths[i] <= fair);
      if (!small.length) { for (const i of pending) widths[i] = fair; break; }
      for (const i of small) pool -= widths[i];
      pending = pending.filter((i) => widths[i] > fair);
    }
  }
  return widths;
}
