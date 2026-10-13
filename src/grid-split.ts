// A grid's column split, as the writer reads and types it (block pill,
// Grid layout panel). The model keeps canonical shares (each divided by
// the smallest, 3 decimals: ratio-equivalent shares lay out identically);
// the panel shows them the way they were most likely written.

/** "2 : 1", "2 1", "2,1", "60/40", "2fr 1fr", "46% : 54%" → canonical
 *  shares ([2, 1], [1.5, 1], [1, 1.174]); null when unusable (no value, a
 *  zero or negative one, more than 12). */
export function parseColumnShares(text: string): number[] | null {
  const parts = text
    .split(/[\s:,/]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => Number(p.replace(/(?:fr|%)$/i, '')));
  if (!parts.length || parts.length > 12 || parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  const min = Math.min(...parts);
  return parts.map((n) => Math.round((n / min) * 1000) / 1000);
}

export const formatColumnShares = (columns: number[]): string => columns.map((c) => String(c)).join(' : ');

/** The smallest whole-number ratio the shares are (k·share within 0.01 of
 *  an integer ≤ 12 for some k in 1…6), or null. */
export function splitRatio(columns: number[]): number[] | null {
  if (!columns.length) return null;
  for (let k = 1; k <= 6; k++) {
    const ints = columns.map((c) => k * c);
    if (ints.every((v) => Math.abs(v - Math.round(v)) <= 0.01 && Math.round(v) >= 1 && Math.round(v) <= 12)) return ints.map((v) => Math.round(v));
  }
  return null;
}

const percent = (n: number) => String(Math.round(n * 10) / 10);

/** The display rule (spec §5.2): a small whole ratio as `1 : 4 : 1 : 4 : 1`,
 *  anything else as percents rounded to 0.1 (`46% : 54%` for 1 : 1.174).
 *  `compact` drops the spaces and the percent signs (a ratio of percents
 *  is the same split), for a thumbnail's caption. */
export function displayColumnShares(columns: number[], compact = false): string {
  const ratio = splitRatio(columns);
  const total = columns.reduce((a, b) => a + b, 0) || 1;
  const parts = ratio ? ratio.map(String) : columns.map((c) => `${percent((c / total) * 100)}${compact ? '' : '%'}`);
  return parts.join(compact ? ':' : ' : ');
}

/** The split presets for a column count; presets never change the count. */
export function splitPresets(count: number): number[][] {
  if (count === 2) return [[1, 1], [2, 1], [1, 2], [3, 2], [2, 3]];
  if (count === 3) return [[1, 1, 1], [1, 2, 1], [2, 1, 1], [1, 1, 2]];
  return [Array(Math.max(1, count)).fill(1)];
}

/** Whether two splits lay out the same (ratio-equal within 1%). */
export function sameSplit(a: number[], b: number[]): boolean {
  if (a.length !== b.length || !a.length) return false;
  return a.every((v, i) => Math.abs(v / a[0] - b[i] / b[0]) < 0.01);
}

/** Canonical form of a preset (what parseColumnShares would store). */
export const canonicalShares = (shares: number[]): number[] => {
  const min = Math.min(...shares);
  return shares.map((n) => Math.round((n / min) * 1000) / 1000);
};
