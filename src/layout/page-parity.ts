// PAGE-PORT.md Phase 0: parity telemetry. Pure diff + heuristic
// classification between a local (fallback) page-start prediction and
// Typst's exact page-start answer for the same document revision. This
// module makes no DOM reads and has no side effects — it only compares two
// already-captured lists of page-start descriptors and looks at document
// nodes to guess which rule domain a disagreement falls under.
//
// Nothing here changes pagination behavior: it is read by DEV-only
// instrumentation in typeset-plugin.ts and never consulted by the
// production paginate()/paginateForced() paths.

import type { Node as PMNode } from 'prosemirror-model';

/** One page-start descriptor, in the oracle's own vocabulary: `pos` is a
 * top-level block position, `line` is a 0-based index into that block's
 * cached line layout (only meaningful when `unit === 'line'`), and `unit`
 * names the kind of boundary (`paragraph`, `line`, `h1`/`h2`/`h3`, `table`,
 * or `block` for anything else). Entry `i` describes the start of page
 * `i + 2` (page 1 has no start marker). */
export interface PageStartEntry {
  pos: number;
  line: number;
  unit: string;
}

export const PARITY_CAUSES = [
  'spacing',
  'widow-orphan',
  'sticky',
  'footnote',
  'page-top-adjust',
  'breakable-block',
  'oversize',
  'height-mismatch',
  'unknown',
] as const;

export type ParityCause = (typeof PARITY_CAUSES)[number];

export interface PageStartDiff {
  /** 1-based physical page number of the first page whose start disagrees. */
  firstDiffPage: number;
  localStart: PageStartEntry | null;
  exactStart: PageStartEntry | null;
  cause: ParityCause;
}

export interface ClassifyContext {
  /** The document both entry lists were computed against. */
  doc: PMNode;
  /** Content-area height in px, when known — enables the `oversize` bucket. */
  contentHeightPx?: number;
  /** Measured height (px) of the top-level block at `pos`, when cheaply
   * available — enables `oversize`/`height-mismatch`. Returns null when
   * unknown; the classifier degrades gracefully. */
  blockHeightPx?: (pos: number) => number | null;
}

const BREAKABLE_BLOCK_TYPES = new Set(['code_block', 'math_display', 'figure']);

function sameEntry(a: PageStartEntry | undefined, b: PageStartEntry | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.pos === b.pos && a.line === b.line && a.unit === b.unit;
}

function topLevelNodeAt(doc: PMNode, pos: number): PMNode | null {
  if (pos < 0 || pos > doc.content.size) return null;
  try {
    return doc.nodeAt(pos);
  } catch {
    return null;
  }
}

/** The top-level node immediately preceding `pos` (null at the document
 * start or when `pos` doesn't land on a top-level boundary). Used to detect
 * a heading that a sticky-run boundary left just above the break. */
function topLevelNodeBefore(doc: PMNode, pos: number): PMNode | null {
  let prev: PMNode | null = null;
  let found: PMNode | null = null;
  doc.forEach((node, offset) => {
    if (found) return;
    if (offset >= pos) {
      found = prev;
      return;
    }
    prev = node;
  });
  return found ?? prev;
}

function hasFootnoteInRange(doc: PMNode, from: number, to: number): boolean {
  if (to <= from) return false;
  let hit = false;
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node) => {
    if (hit) return false;
    if (node.type.name === 'footnote') {
      hit = true;
      return false;
    }
    return true;
  });
  return hit;
}

/** Depth-0 child index of the top-level block starting at `pos`, or null
 * when `pos` doesn't land on a top-level boundary. */
function topLevelIndexAt(doc: PMNode, pos: number): number | null {
  let index: number | null = null;
  let i = 0;
  doc.forEach((_node, offset) => {
    if (offset === pos) index = i;
    i++;
  });
  return index;
}

/** Classify the first diverging boundary between a local prediction and
 * Typst's exact answer. Returns null when the two lists agree in full.
 * Simple ordered rules, evaluated in the order PAGE-PORT.md Phase 0 lists
 * the buckets in — precision matters less than a stable ranking of which
 * rule domain to investigate next. */
export function diffPageStarts(
  local: readonly PageStartEntry[],
  exact: readonly PageStartEntry[],
  ctx: ClassifyContext,
): PageStartDiff | null {
  const n = Math.max(local.length, exact.length);
  let i = 0;
  while (i < n && sameEntry(local[i], exact[i])) i++;
  if (i >= n) return null;

  const la = local[i] ?? null;
  const ex = exact[i] ?? null;
  const prevAgreed = i > 0 && sameEntry(local[i - 1], exact[i - 1]);
  const cause = classify(la, ex, i, prevAgreed, ctx);
  return { firstDiffPage: i + 2, localStart: la, exactStart: ex, cause };
}

function classify(
  la: PageStartEntry | null,
  ex: PageStartEntry | null,
  index: number,
  prevAgreed: boolean,
  ctx: ClassifyContext,
): ParityCause {
  const { doc } = ctx;
  const nodeAtLa = la ? topLevelNodeAtOrResolve(doc, la) : null;
  const nodeAtEx = ex ? topLevelNodeAtOrResolve(doc, ex) : null;

  // spacing (same anchor): both sides pick the same content position as the
  // page start but disagree about the unit/line accounting — a
  // block-vs-paragraph label mismatch, not a different content boundary.
  if (la && ex && la.pos === ex.pos && la.unit !== ex.unit) return 'spacing';

  // widow-orphan: same paragraph, line index off by one or two near the
  // paragraph's own start/end.
  if (la && ex && la.unit === 'line' && ex.unit === 'line' && la.pos === ex.pos) {
    const delta = Math.abs(la.line - ex.line);
    if (delta >= 1 && delta <= 2) return 'widow-orphan';
  }

  // sticky: a heading sits at (or just above) one side's boundary. Checked
  // before the adjacent-sibling spacing rule below, since a heading run
  // moving as a unit is exactly what produces an adjacent whole-block shift
  // and deserves the more specific bucket.
  const isHeading = (n: PMNode | null) => n?.type.name === 'heading';
  if (
    isHeading(nodeAtLa) ||
    isHeading(nodeAtEx) ||
    (la && isHeading(topLevelNodeBefore(doc, la.pos))) ||
    (ex && isHeading(topLevelNodeBefore(doc, ex.pos)))
  ) {
    return 'sticky';
  }

  // footnote: a footnote marker exists on the page(s) the boundary splits.
  const positions = [la?.pos, ex?.pos].filter((p): p is number => typeof p === 'number');
  if (positions.length) {
    const windowStart = 0; // scanning the whole prefix is cheap (doc-sized, once per disagreement)
    const windowEnd = Math.max(...positions);
    if (hasFootnoteInRange(doc, windowStart, windowEnd)) return 'footnote';
  }

  // breakable-block: the boundary sits at (or the containing block is) a
  // code block, display-math block, or figure — constructs the local
  // paginator always moves whole while Typst may split them. Checked before
  // the generic adjacent-shift spacing rule so these specific constructs
  // aren't swallowed by "the boundary moved one sibling over".
  const isBreakable = (n: PMNode | null) => !!n && BREAKABLE_BLOCK_TYPES.has(n.type.name);
  if (isBreakable(nodeAtLa) || isBreakable(nodeAtEx)) return 'breakable-block';

  // oversize: the block at the boundary is taller than the content area.
  // Checked before the generic adjacent-shift spacing rule below since it's
  // an actual measurement, not a positional guess, whenever one is available.
  if (ctx.contentHeightPx && ctx.blockHeightPx) {
    const hLa = la ? ctx.blockHeightPx(la.pos) : null;
    const hEx = ex ? ctx.blockHeightPx(ex.pos) : null;
    if ((hLa && hLa > ctx.contentHeightPx) || (hEx && hEx > ctx.contentHeightPx)) return 'oversize';
  }

  // page-top-adjust: the previous boundary agreed exactly (same block, same
  // line), so THIS disagreement cascades from top-of-page placement on the
  // page before it rather than from a rule difference at this boundary.
  // Checked before the generic adjacent-shift spacing rule below, which
  // would otherwise also match most page-top-adjust cases (consecutive
  // top-level siblings) without the more specific "prior page agreed" signal.
  if (index > 0 && prevAgreed) return 'page-top-adjust';

  // spacing (adjacent shift): both sides break at a block-level boundary
  // one top-level sibling apart — a whole-block migration most likely
  // driven by inter-block spacing collapse rather than a different rule.
  if (la && ex && la.unit !== 'line' && ex.unit !== 'line' && la.pos !== ex.pos) {
    const ia = topLevelIndexAt(doc, la.pos);
    const ib = topLevelIndexAt(doc, ex.pos);
    if (ia !== null && ib !== null && Math.abs(ia - ib) <= 1) return 'spacing';
  }

  // height-mismatch: same decision structure (matching unit/type) but a
  // measured height differs — only attempted when heights are cheaply
  // available; otherwise this bucket is left empty rather than guessed at.
  if (la && ex && la.unit === ex.unit && nodeAtLa?.type === nodeAtEx?.type && ctx.blockHeightPx) {
    const hLa = ctx.blockHeightPx(la.pos);
    const hEx = ctx.blockHeightPx(ex.pos);
    if (hLa != null && hEx != null && Math.abs(hLa - hEx) > 0.5) return 'height-mismatch';
  }

  return 'unknown';
}

/** `doc.nodeAt` only resolves a position that sits exactly at a top-level
 * boundary; a `line`-unit entry's `pos` always does (both sides), so this
 * is really just `doc.nodeAt` with defensive bounds — kept as a named
 * helper for readability at the call sites above. */
function topLevelNodeAtOrResolve(doc: PMNode, entry: PageStartEntry): PMNode | null {
  return topLevelNodeAt(doc, entry.pos);
}

export interface PageParitySkipped {
  tables: number;
  tooLarge: number;
}

export interface PageParityStats {
  predictions: number;
  agreements: number;
  disagreements: number;
  byCause: Record<ParityCause, number>;
  skipped: PageParitySkipped;
  last: {
    firstDiffPage: number;
    cause: ParityCause;
    localStart: PageStartEntry | null;
    exactStart: PageStartEntry | null;
  } | null;
}

export function emptyPageParityStats(): PageParityStats {
  const byCause = {} as Record<ParityCause, number>;
  for (const c of PARITY_CAUSES) byCause[c] = 0;
  return {
    predictions: 0,
    agreements: 0,
    disagreements: 0,
    byCause,
    skipped: { tables: 0, tooLarge: 0 },
    last: null,
  };
}

/** Fold one diff result into a stats object in place. */
export function recordParityDiff(stats: PageParityStats, diff: PageStartDiff | null): void {
  stats.predictions++;
  if (!diff) {
    stats.agreements++;
    return;
  }
  stats.disagreements++;
  stats.byCause[diff.cause]++;
  stats.last = {
    firstDiffPage: diff.firstDiffPage,
    cause: diff.cause,
    localStart: diff.localStart,
    exactStart: diff.exactStart,
  };
}
