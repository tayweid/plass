// Pure encode/decode helpers for table-editor's rule boundaries: style
// presets, override maps, and per-cell run encoding — no DOM, no model
// mutation beyond the map/spans passed in.

import type { CellModel, RuleSpan, Rule } from './table-editor';

// A boundary's effective rule = the explicit override, else the style
// preset's own rule ('heavy' booktabs top/bottom, 'light' booktabs header
// midrule, 'light' everywhere for grid). Clicking cycles the effective
// state; landing back on the preset value clears the override, so
// untouched tables keep emitting byte-identically.
export const presetH = (style: string, rows: CellModel[][], y: number): Rule | undefined => {
  if (style === 'grid') return 'light';
  if (style === 'booktabs') {
    if (y === 0 || y === rows.length) return 'heavy';
    if (y === 1 && rows[0]?.some((c) => c.header)) return 'light';
  }
  return undefined;
};
export const presetV = (style: string): Rule | undefined => (style === 'grid' ? 'light' : undefined);
export const effective = (map: Map<number, Rule>, i: number, preset: Rule | undefined): Rule | undefined =>
  map.get(i) ?? preset;
export const cycleRule = (map: Map<number, Rule>, i: number, preset: Rule | undefined) => {
  const eff = effective(map, i, preset);
  const next: Rule | undefined =
    !eff || eff === 'none' ? 'light' : eff === 'light' ? 'heavy' : preset ? 'none' : undefined;
  if (next === undefined || next === preset) map.delete(i);
  else map.set(i, next);
};
export const ruleTitle = (eff: Rule | undefined): string =>
  !eff || eff === 'none' ? 'Add a rule here' : eff === 'light' ? 'Make this rule heavy' : 'Remove this rule';
// Per-cell editing decodes a boundary into one visual weight per grid
// cell (undefined = no line), applies the click, and re-encodes the
// minimal representation: nothing when it matches the style preset, a
// full-boundary rule when uniform, spans over the runs that differ
// otherwise. The canonical re-encode keeps hand-drawn cell patterns and
// whole-line rules from accumulating overlapping spans.
export const cellsOf = (
  i: number,
  preset: Rule | undefined,
  map: Map<number, Rule>,
  spans: RuleSpan[],
  n: number,
): Array<Rule | undefined> => {
  const baseRaw = map.get(i) ?? preset;
  const base = baseRaw === 'none' ? undefined : baseRaw;
  const arr = new Array<Rule | undefined>(n).fill(base);
  for (const sp of spans) {
    if (sp.i !== i) continue;
    for (let c = sp.a; c < Math.min(sp.b, n); c++) arr[c] = sp.w === 'none' ? undefined : sp.w;
  }
  return arr;
};
export const encodeCells = (
  i: number,
  preset: Rule | undefined,
  map: Map<number, Rule>,
  spans: RuleSpan[],
  arr: Array<Rule | undefined>,
) => {
  for (let k = spans.length - 1; k >= 0; k--) if (spans[k].i === i) spans.splice(k, 1);
  map.delete(i);
  if (arr.every((v) => v === arr[0])) {
    const v = arr[0];
    if (v === preset) return; // exactly the preset — nothing to say
    if (v) map.set(i, v);
    else if (preset) map.set(i, 'none'); // suppress the preset everywhere
    return;
  }
  let c = 0;
  while (c < arr.length) {
    const v = arr[c];
    let d = c;
    while (d < arr.length && arr[d] === v) d++;
    if (v !== preset && (v || preset)) spans.push({ i, a: c, b: d, w: v ?? 'none' });
    c = d;
  }
};
