// Cell borders (Taylor, 2026-10-21): lines on chosen sides of chosen
// cells, so a game's payoff matrix, lines round the four payoffs and none
// round the names and labels, is a native table. A border adds lines; the
// table's style keeps its own (a `plain` table has none, so its borders
// are all the lines it has).
//
// One weight, the light rule's (0.05em, table-rules.ts): Typst's
// `table.cell(stroke: (top: 0.05em, …))`, the sides drawn and no others,
// so the sides a cell leaves out keep the table's stroke. Typst draws a
// cell's stroke on an edge it shares even when the neighbour names none,
// and where both name one the right (lower) cell's wins; with one weight
// that never shows. A `grid` table strokes every edge at 1pt, which wins
// on the edges whose priority cell is its own, so borders mean nothing
// there: the exporter writes none for a grid table, the page draws none,
// and the cell panel says why (the attribute is kept, for a style change
// back). Paint only, as every rule: nothing in the layout moves.

export type BorderSide = 'top' | 'right' | 'bottom' | 'left';

export const BORDER_SIDES: readonly BorderSide[] = ['top', 'right', 'bottom', 'left'];

/** The stroke of a border, the light rule's weight. */
export const CELL_BORDER_STROKE = '0.05em';

/** The sides a cell's `border` attribute names: '' none, 'all' every
 *  side, else sides in any order joined by spaces or `+`. Null when a
 *  word is not a side. */
export function borderSides(value: string): Set<BorderSide> | null {
  const words = value.trim().split(/[\s+]+/).filter(Boolean);
  const sides = new Set<BorderSide>();
  for (const word of words) {
    if (word === 'all') BORDER_SIDES.forEach((s) => sides.add(s));
    else if ((BORDER_SIDES as readonly string[]).includes(word)) sides.add(word as BorderSide);
    else return null;
  }
  return sides;
}

/** The attribute value for `sides`: '' for none, 'all' for four, else the
 *  sides in top-right-bottom-left order, joined by spaces. */
export function borderValue(sides: Iterable<BorderSide>): string {
  const set = new Set(sides);
  if (set.size === 4) return 'all';
  return BORDER_SIDES.filter((s) => set.has(s)).join(' ');
}

/** A cell attribute value made canonical; '' for anything unreadable. */
export function normalizeBorder(value: unknown): string {
  if (typeof value !== 'string') return '';
  const sides = borderSides(value);
  return sides ? borderValue(sides) : '';
}

/** The Markdown word for a border value: `all`, or sides joined by `+`. */
export const borderMd = (value: string) => value.split(' ').join('+');

/** The `stroke:` argument a bordered cell exports, in `color`. */
export function borderStrokeArg(value: string, color: string = ''): string {
  const sides = borderSides(value);
  if (!sides?.size) return '';
  const stroke = coloredStroke(CELL_BORDER_STROKE, color);
  if (sides.size === 4) return `stroke: ${stroke}`;
  return `stroke: (${BORDER_SIDES.filter((s) => sides.has(s)).map((s) => `${s}: ${stroke}`).join(', ')})`;
}

/** The border value and colour a `stroke:` argument's expression denotes,
 *  if the exporter could have written it (one colour for every side);
 *  null for any other stroke. */
export function borderFromStroke(expr: string): { border: string; color: LineColor } | null {
  const e = expr.trim();
  const whole = parseColoredStroke(e);
  if (whole) return whole.weight === CELL_BORDER_STROKE ? { border: 'all', color: whole.color } : null;
  const m = /^\(([\s\S]*)\)$/.exec(e);
  if (!m) return null;
  const sides = new Set<BorderSide>();
  let color: LineColor | null = null;
  for (const part of splitTop(m[1])) {
    const kv = /^\s*(top|right|bottom|left)\s*:([\s\S]+)$/.exec(part);
    const stroke = kv ? parseColoredStroke(kv[2]) : null;
    if (!kv || !stroke || stroke.weight !== CELL_BORDER_STROKE) return null;
    if (color !== null && stroke.color !== color) return null;
    color = stroke.color;
    sides.add(kv[1] as BorderSide);
  }
  return sides.size ? { border: borderValue(sides), color: color ?? '' } : null;
}

/** A dictionary's entries, split at its top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.filter((p) => p.trim());
}

// Line colours (Taylor, 2026-10-21): a preset palette, as the fills are.
// A table's colour is every line it draws (its style's strokes and rules,
// its row rules, and its borders); a cell's border colour is that cell's
// borders only, over the table's. '' is the ink. Red is the solution
// colour (typ-serializer.ts SOLUTION_COLOR, style.css --solution-red).

export type LineColor = '' | 'red' | 'blue' | 'gray';

export const LINE_COLOR_TYPST: Record<Exclude<LineColor, ''>, string> = {
  red: 'rgb("#c00000")',
  blue: 'rgb("#1f5fbf")',
  gray: 'luma(150)',
};

// The page paints the same colours (style.css `[data-line-color]`):
// red #c00000, blue #1f5fbf, gray #969696 (= luma(150)).

export const LINE_COLORS = Object.keys(LINE_COLOR_TYPST) as Array<Exclude<LineColor, ''>>;

export const normalizeLineColor = (value: unknown): LineColor =>
  typeof value === 'string' && (LINE_COLORS as string[]).includes(value) ? (value as LineColor) : '';

/** A stroke at `weight` in `color` ('' the ink, Typst's default black). */
export const coloredStroke = (weight: string, color: LineColor | string) =>
  color && color in LINE_COLOR_TYPST ? `${weight} + ${LINE_COLOR_TYPST[color as Exclude<LineColor, ''>]}` : weight;

/** The weight and colour of a stroke the exporter writes (`0.05em`,
 *  `0.05em + rgb("#c00000")`); null for any other. */
export function parseColoredStroke(expr: string): { weight: string; color: LineColor } | null {
  const e = expr.replace(/\s+/g, '');
  const m = /^([\d.]+(?:em|pt))(?:\+(.+))?$/.exec(e);
  if (!m) return null;
  if (!m[2]) return { weight: m[1], color: '' };
  for (const color of LINE_COLORS) if (LINE_COLOR_TYPST[color].replace(/\s+/g, '') === m[2]) return { weight: m[1], color };
  return null;
}
