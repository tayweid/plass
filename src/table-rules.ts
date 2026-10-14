// Row rules: the horizontal rule under a table row, a verified preset per
// row — light (the booktabs midrule weight), heavy (its top and bottom
// rule weight), none, or '' for whatever the table's style preset draws
// there. Exported as Typst's own `table.hline(y: N, stroke: …)` at the row's
// lower boundary, where the preset's rule at that boundary yields to it;
// imported back from exactly that form. Paint only, in the page and in
// the print: a stroke charges the layout nothing.

export type RowRule = '' | 'light' | 'heavy' | 'none';

export const ROW_RULE_STROKE: Record<Exclude<RowRule, ''>, string> = { light: '0.05em', heavy: '0.08em', none: 'none' };

export const ROW_RULE_CYCLE: RowRule[] = ['', 'light', 'heavy', 'none'];

export function rowRuleFromStroke(stroke: string): Exclude<RowRule, ''> | null {
  for (const [rule, value] of Object.entries(ROW_RULE_STROKE)) {
    if (value === stroke.trim()) return rule as Exclude<RowRule, ''>;
  }
  return null;
}

/** A serialized row rule at the boundary below row `index` (0-based). */
export function rowRuleArg(index: number, rule: Exclude<RowRule, ''>): string {
  return `table.hline(y: ${index + 1}, stroke: ${ROW_RULE_STROKE[rule]})`;
}

const ROW_RULE_RE = /^table\.hline\(\s*y\s*:\s*(\d+)\s*,\s*stroke\s*:\s*([\w.]+)\s*\)$/;

/** The row index and rule a serialized argument denotes, if it is one. */
export function parseRowRuleArg(arg: string): { index: number; rule: Exclude<RowRule, ''> } | null {
  const m = ROW_RULE_RE.exec(arg.trim());
  if (!m) return null;
  const rule = rowRuleFromStroke(m[2]);
  if (!rule) return null;
  return { index: parseInt(m[1], 10) - 1, rule };
}
