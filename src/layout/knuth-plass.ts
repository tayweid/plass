// Knuth-Plass optimal line breaking — the layout oracle.
//
// This is the same algorithm TeX (and Typst) use for paragraph layout: instead
// of filling lines greedily left to right, it considers every feasible set of
// break points for the whole paragraph and picks the one minimizing total
// "demerits" (a global badness metric). The output is a set of break points
// plus, per line, an adjustment ratio describing how much the inter-word glue
// must stretch or shrink to justify the line.
//
// The paragraph is modeled the TeX way, as a sequence of items:
//   box     — unbreakable content (a word, a syllable, an inline atom)
//   glue    — stretchable/shrinkable space
//   penalty — an optional break point with a cost (hyphenation points,
//             forced breaks at -INF, prohibited breaks at +INF)

export const INF = 10000;

export type Box = { type: 'box'; width: number };
export type Glue = { type: 'glue'; width: number; stretch: number; shrink: number };
export type Penalty = { type: 'penalty'; width: number; penalty: number; flagged: boolean };
export type Item = Box | Glue | Penalty;

export interface Line {
  /** Index of the first item of the line. */
  start: number;
  /** Index of the item at which the line breaks (a glue or penalty). */
  end: number;
  /** Glue adjustment ratio chosen for this line (>0 stretch, <0 shrink). */
  ratio: number;
}

export interface KPOptions {
  tolerance?: number;
  linePenalty?: number;
  adjDemerits?: number;
  doubleHyphenDemerits?: number;
}

interface ANode {
  position: number; // item index of the break that starts this node's context (-1 = paragraph start)
  line: number;
  fitness: number;
  width: number; // running sums consumed up to the start of the next line
  stretch: number;
  shrink: number;
  demerits: number;
  ratio: number;
  previous: ANode | null;
}

/**
 * Break a paragraph into lines of width `lineWidth`.
 * The item list must end with a forced break (penalty -INF); build it with
 * the standard tail `penalty(INF), glue(0, big, 0), penalty(-INF)`.
 * Never fails: escalates tolerance, then permits overfull lines, then falls
 * back to greedy first-fit.
 */
export function breakLines(items: Item[], lineWidth: number, opts: KPOptions = {}): Line[] {
  if (!items.some((it) => it.type === 'box')) return [];
  const passes: Array<[number, boolean]> = [
    [opts.tolerance ?? 3, false],
    [6, false],
    [12, false],
    [30, false],
    [INF, true],
  ];
  for (const [tolerance, allowOverfull] of passes) {
    const lines = tryBreak(items, lineWidth, tolerance, allowOverfull, opts);
    if (lines) return lines;
  }
  return greedy(items, lineWidth);
}

function tryBreak(
  items: Item[],
  lineWidth: number,
  tolerance: number,
  allowOverfull: boolean,
  opts: KPOptions,
): Line[] | null {
  const linePenalty = opts.linePenalty ?? 10;
  const adjDemerits = opts.adjDemerits ?? 10000;
  const dblDemerits = opts.doubleHyphenDemerits ?? 10000;

  const fitnessOf = (r: number) => (r < -0.5 ? 0 : r <= 0.5 ? 1 : r <= 1 ? 2 : 3);

  let active: ANode[] = [
    { position: -1, line: 0, fitness: 1, width: 0, stretch: 0, shrink: 0, demerits: 0, ratio: 0, previous: null },
  ];
  let sumWidth = 0;
  let sumStretch = 0;
  let sumShrink = 0;

  for (let b = 0; b < items.length; b++) {
    const it = items[b];
    const isCandidate =
      it.type === 'glue'
        ? b > 0 && items[b - 1].type === 'box'
        : it.type === 'penalty'
          ? it.penalty < INF
          : false;

    if (isCandidate) {
      const forced = it.type === 'penalty' && it.penalty <= -INF;
      const penaltyVal = it.type === 'penalty' ? it.penalty : 0;
      const flagged = it.type === 'penalty' && it.flagged;

      const best: Array<{ prev: ANode; ratio: number; demerits: number } | null> = [null, null, null, null];
      const survivors: ANode[] = [];

      for (const a of active) {
        const w = sumWidth - a.width + (it.type === 'penalty' ? it.width : 0);
        let r: number;
        if (w < lineWidth) {
          const st = sumStretch - a.stretch;
          r = st > 0 ? (lineWidth - w) / st : w === lineWidth ? 0 : 1e9;
        } else if (w > lineWidth) {
          const sh = sumShrink - a.shrink;
          r = sh > 0 ? (lineWidth - w) / sh : -1e9;
        } else {
          r = 0;
        }

        // A node too far back to reach this break (r < -1) can never form a
        // future line either; a forced break deactivates everything.
        if (!(r < -1 || forced)) survivors.push(a);

        let ok = r >= -1 && r <= tolerance;
        if (!ok && allowOverfull) ok = true;
        if (!ok) continue;

        const rc = Math.max(-1, Math.min(r, 10));
        const badness = 100 * Math.abs(rc) ** 3;
        let d: number;
        if (penaltyVal >= 0) d = (linePenalty + badness + penaltyVal) ** 2;
        else if (penaltyVal > -INF) d = (linePenalty + badness) ** 2 - penaltyVal ** 2;
        else d = (linePenalty + badness) ** 2;
        if (flagged && a.position >= 0) {
          const prevItem = items[a.position];
          if (prevItem.type === 'penalty' && prevItem.flagged) d += dblDemerits;
        }
        const cls = fitnessOf(rc);
        if (Math.abs(cls - a.fitness) > 1) d += adjDemerits;
        d += a.demerits;
        const cur = best[cls];
        if (!cur || d < cur.demerits) best[cls] = { prev: a, ratio: rc, demerits: d };
      }

      if (best.some(Boolean)) {
        // Sums at the start of the next line: skip discardables after the break.
        let aw = sumWidth;
        let ast = sumStretch;
        let ash = sumShrink;
        for (let j = b; j < items.length; j++) {
          const jt = items[j];
          if (jt.type === 'box') break;
          if (jt.type === 'glue') {
            aw += jt.width;
            ast += jt.stretch;
            ash += jt.shrink;
          } else if (jt.type === 'penalty' && jt.penalty <= -INF && j > b) {
            break;
          }
        }
        for (let cls = 0; cls < 4; cls++) {
          const c = best[cls];
          if (!c) continue;
          survivors.push({
            position: b,
            line: c.prev.line + 1,
            fitness: cls,
            width: aw,
            stretch: ast,
            shrink: ash,
            demerits: c.demerits,
            ratio: c.ratio,
            previous: c.prev,
          });
        }
      }

      active = survivors;
      if (active.length === 0) return null;
    }

    if (it.type === 'box') {
      sumWidth += it.width;
    } else if (it.type === 'glue') {
      sumWidth += it.width;
      sumStretch += it.stretch;
      sumShrink += it.shrink;
    }
  }

  let bestNode: ANode | null = null;
  for (const a of active) {
    if (a.position === items.length - 1 && (!bestNode || a.demerits < bestNode.demerits)) bestNode = a;
  }
  if (!bestNode) return null;

  const lines: Line[] = [];
  for (let n: ANode | null = bestNode; n && n.position >= 0; n = n.previous) {
    const prevPos = n.previous ? n.previous.position : -1;
    let start = prevPos + 1;
    while (start < n.position && items[start].type !== 'box') start++;
    lines.push({ start, end: n.position, ratio: n.ratio });
  }
  lines.reverse();
  return lines;
}

/** Last-resort first-fit breaking. Only reachable if every KP pass fails. */
function greedy(items: Item[], lineWidth: number): Line[] {
  const lines: Line[] = [];
  let start = -1;
  let width = 0;
  let lastBreak = -1;

  const flush = (end: number, ratio = 0) => {
    if (start >= 0 && end > start) lines.push({ start, end, ratio });
    start = -1;
    width = 0;
    lastBreak = -1;
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type === 'box') {
      if (start < 0) start = i;
      width += it.width;
      if (width > lineWidth && lastBreak > start) {
        const brk = lastBreak;
        lines.push({ start, end: brk, ratio: 0 });
        start = i;
        width = it.width;
        lastBreak = -1;
      }
    } else if (it.type === 'glue') {
      if (start >= 0 && items[i - 1]?.type === 'box') lastBreak = i;
      if (start >= 0) width += it.width;
    } else if (it.penalty <= -INF) {
      flush(i);
    }
  }
  flush(items.length - 1);
  return lines;
}
