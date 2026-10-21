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

/** The `stroke:` argument a bordered cell exports. */
export function borderStrokeArg(value: string): string {
  const sides = borderSides(value);
  if (!sides?.size) return '';
  if (sides.size === 4) return `stroke: ${CELL_BORDER_STROKE}`;
  return `stroke: (${BORDER_SIDES.filter((s) => sides.has(s)).map((s) => `${s}: ${CELL_BORDER_STROKE}`).join(', ')})`;
}

/** The border value a `stroke:` argument's expression denotes, if the
 *  exporter could have written it; null for any other stroke. */
export function borderFromStroke(expr: string): string | null {
  const e = expr.replace(/\s+/g, '');
  if (e === CELL_BORDER_STROKE) return 'all';
  const m = /^\((.*)\)$/.exec(e);
  if (!m) return null;
  const sides = new Set<BorderSide>();
  for (const part of m[1].split(',').filter(Boolean)) {
    const kv = /^(top|right|bottom|left):(.+)$/.exec(part);
    if (!kv || kv[2] !== CELL_BORDER_STROKE) return null;
    sides.add(kv[1] as BorderSide);
  }
  return sides.size ? borderValue(sides) : null;
}
