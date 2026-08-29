// Paragraph layout: ProseMirror textblock -> KP items -> line layouts.
//
// This is the "PM -> oracle" half of the translation layer. Every box/glue
// carries the document offset range it came from, so the oracle's break
// decisions map straight back to decoration positions (the position-table
// idea from spec §3.3, exact by construction because we build the items
// ourselves).

import type { Node as PMNode } from 'prosemirror-model';
import { breakLines, INF, type Item } from './knuth-plass';
import { syllabify } from './hyphenate';
import { Measurer } from './measure';

const BIG_STRETCH = 1e6;
const HYPHEN_PENALTY = 45;
/** Justify to slightly under the measure so rounding never overflows a line —
 *  an overflow browser-rewraps the line and makes an orphan word. ONE value on
 *  every path (live KP, forced translator, direct forced translator): when the
 *  settled oracle confirms the live breaks, the spacing math must agree
 *  bit-for-bit or the no-op settle repaints the paragraph (justification
 *  shimmer). The value is the old forced epsilon; the extra px under the
 *  measure is invisible and protects the live path harder too. */
const FIT_EPS = 1.5;
/** Scaled contexts (footnote bodies) accumulate extra sub-pixel width-model
 *  error the canvas can't see; aim further under the measure there — ~0.3px of
 *  extra shrink per space, invisible, never an orphan. */
const SCALED_FIT_EXTRA = 4.5;

/** Under-measure epsilon for a given content scale. Shared by every layout
 *  path so identical inputs give identical targets. */
export function fitEps(scale: number): number {
  return FIT_EPS + (scale !== 1 ? SCALED_FIT_EXTRA : 0);
}

/**
 * Word-spacing (extra px per space) for one laid-out line. This is the ONLY
 * spacing formula: every path — live KP fallback, forced translator, direct
 * forced translator — must emit bit-identical values for identical breaks and
 * inputs, so that oracle agreement is a repaint no-op.
 *
 * `justified` = the line breaks at a space or a hyphen; segment-final lines
 * (paragraph end, hard break) stay ragged, as in TeX.
 */
export function lineWordSpacing(
  justified: boolean,
  spaces: number,
  natural: number,
  measure: number,
  eps: number,
  baseSpace: number,
): number {
  if (justified && spaces > 0) {
    // A laid-out line must never overflow into a browser re-wrap (the
    // typesetter fit this content), so shrink far beyond nominal if needed.
    const spacing = (measure - eps - natural) / spaces;
    return Math.max(-0.9 * baseSpace, Math.min(spacing, 3 * baseSpace));
  }
  if (spaces > 0 && natural > measure - eps) {
    // Ragged line the browser would wrap (its metrics run a hair wider than
    // the canvas's): shrink it to fit.
    return Math.max(-0.45 * baseSpace, (measure - eps - natural) / spaces);
  }
  return 0;
}
/** A flexible (fr) atom absorbs the slack EXACTLY, leaving a line with no
 *  give at all; the DOM's own text measurement differs from the canvas by a
 *  fraction, which would wrap the line. Give the fill a couple of px back. */
const FILL_SLACK = 2;

type Kind = 'box' | 'space' | 'hyphen' | 'end' | 'nodebreak';

interface SItem {
  kp: Item;
  from: number; // offsets relative to the block's content start
  to: number;
  kind: Kind;
  /** Break after an existing '-': no hyphen glyph needs to be injected. */
  glyphless?: boolean;
  /** A flexible (fr) inline atom: zero natural width, takes the slack. */
  fill?: boolean;
}

export interface LineLayout {
  /** Content range of the line, relative to block content start. */
  from: number;
  to: number;
  /** Extra px of word-spacing per space to justify the line (0 = ragged). */
  spacing: number;
  /** Offset at which to force the line break (null: node/paragraph end handles it). */
  breakPos: number | null;
  /** Whether the forced break needs a hyphen glyph. */
  hyphen: boolean;
  /** Offsets of flexible (fr) atoms on this line, and the width each takes:
   *  they absorb the line's slack instead of the spaces (Typst's rule), so
   *  such a line is never justified. */
  fills?: { offsets: number[]; width: number };
  /** The authoritative-equivalent break for this line: exactly the
   *  ForcedBreak a forced layout would need to reproduce it (`at` = the
   *  space/hyphen item's start offset; glyphless hyphen breaks count as
   *  hyphens). Absent on segment-final lines (paragraph end, hard break),
   *  which the oracle does not report — so collecting these fields over a
   *  KP-chosen layout yields its semantic break signature. */
  oracleBreak?: ForcedBreak;
}

export interface LayoutOptions {
  hyphenate?: boolean;
  /**
   * Authoritative break decisions from the Typst oracle. When present the
   * KP search is skipped and lines are cut exactly here; offsets must land
   * on a space (word-end) or a syllable boundary. Null result = mismatch,
   * caller falls back to the KP path.
   */
  forced?: ForcedBreak[];
  /** Width a painted prefix/indent consumes at the start of line 1. */
  firstLineIndent?: number;
  /** Multiply text-measurement widths (content rendered at a smaller em). */
  scale?: number;
  /** Inline atoms that flex to fill the line (raw Typst using `fr`). They
   *  contribute zero natural width, as in Typst, and take the slack. */
  isFill?: (child: PMNode) => boolean;
}

export interface ForcedBreak {
  /** Offset of the space (word end) or intra-word split point. */
  at: number;
  hyphen: boolean;
}

/** Partition the item list at oracle-chosen break offsets. */
function partitionAt(items: SItem[], forced: ForcedBreak[]): Array<{ start: number; end: number }> | null {
  const lines: Array<{ start: number; end: number }> = [];
  let start = 0;
  let j = 0;
  for (const f of forced) {
    let found = -1;
    for (; j < items.length; j++) {
      const it = items[j];
      // Hard breaks cut mandatorily; the oracle doesn't report them.
      if (it.kind === 'nodebreak' && it.from < f.at) {
        lines.push({ start, end: j });
        start = j + 1;
        continue;
      }
      if (f.hyphen ? it.kind === 'hyphen' && it.from === f.at : it.kind === 'space' && it.from === f.at) {
        found = j;
        break;
      }
      // Passing the target offset means the oracle's break has no matching
      // item in our stream (segmentation mismatch) — bail to the KP path.
      if (it.from > f.at && (it.kind === 'space' || it.kind === 'hyphen')) return null;
    }
    if (found < 0) return null;
    lines.push({ start, end: found });
    start = found + 1;
    j = found + 1;
  }
  lines.push({ start, end: items.length - 1 });
  return lines;
}

/**
 * Compute typeset line layouts for one paragraph node.
 * Returns null only when opts.forced doesn't match the item stream.
 */
export function layoutBlock(
  block: PMNode,
  measure: number,
  measurer: Measurer,
  atomWidth: (offset: number, child: PMNode) => number,
  opts: LayoutOptions = {},
): LineLayout[] | null {
  const items: SItem[] = [];
  const K = opts.scale ?? 1;

  // A painted prefix ("Figure N: ", footnote marker + indent) occupies the
  // start of line 1: model it as a zero-content box so both the KP search
  // and per-line justification account for it.
  if (opts.firstLineIndent) {
    items.push({ kp: { type: 'box', width: opts.firstLineIndent }, from: 0, to: 0, kind: 'box' });
  }

  const pushEndOfSegment = (from: number, to: number, kind: Kind) => {
    // Spaces immediately before a break are discarded by CSS white-space
    // collapsing; drop them so the oracle agrees with the renderer.
    while (items.length && items[items.length - 1].kind === 'space') items.pop();
    items.push({ kp: { type: 'penalty', width: 0, penalty: INF, flagged: false }, from, to: from, kind: 'end' });
    items.push({ kp: { type: 'glue', width: 0, stretch: BIG_STRETCH, shrink: 0 }, from, to: from, kind: 'end' });
    items.push({ kp: { type: 'penalty', width: 0, penalty: -INF, flagged: false }, from, to, kind });
  };

  // Phase 1 — plan every child without touching the measurement probe. Atom
  // DOM reads happen here, while layout is still clean, so they share one
  // forced reflow with any earlier geometry read instead of forcing their own
  // after a probe write.
  interface Seg {
    start: number;
    end: number;
    space: boolean;
    hyphenBefore: boolean;
  }
  type ChildPlan =
    | { kind: 'text'; offset: number; font: string; text: string; segs: Seg[]; widths: number[] }
    | { kind: 'nodebreak'; offset: number; size: number }
    | { kind: 'atom'; offset: number; size: number; width: number; fill: boolean; glueLeft: boolean };
  const plans: ChildPlan[] = [];
  block.forEach((child, offset) => {
    if (child.isText && child.text) {
      const text = child.text;
      // Split the run into contiguous segments (spaces, and syllables within
      // words); they are measured below as prefix differences over the full
      // string so cross-boundary kerning is captured.
      const segs: Seg[] = [];
      const re = /\s+|\S+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const token = m[0];
        if (/\s/.test(token[0])) {
          segs.push({ start: m.index, end: m.index + token.length, space: true, hyphenBefore: false });
        } else {
          const parts = opts.hyphenate === false ? [token] : syllabify(token);
          let off = m.index;
          parts.forEach((part, i) => {
            segs.push({ start: off, end: off + part.length, space: false, hyphenBefore: i > 0 });
            off += part.length;
          });
        }
      }
      plans.push({ kind: 'text', offset, font: measurer.fontFor(child.marks), text, segs, widths: [] });
    } else if (child.type.name === 'hard_break') {
      plans.push({ kind: 'nodebreak', offset, size: child.nodeSize });
    } else {
      // Inline atom (math, …): a single unbreakable box measured from its
      // DOM. A flexible (fr) atom contributes nothing to the natural width
      // — it absorbs whatever is left over once the line is chosen. A
      // footnote marker glues to whatever precedes it no matter what the
      // document holds: Typst drops a source space immediately ahead of the
      // superscript rather than rendering it (see ResolvedAtom.glueLeft in
      // the oracle's own token model — same Typst behavior, same fix here).
      const fill = opts.isFill?.(child) ?? false;
      plans.push({
        kind: 'atom',
        offset,
        size: child.nodeSize,
        width: fill ? 0 : atomWidth(offset, child),
        fill,
        glueLeft: child.type.name === 'footnote',
      });
    }
  });

  // Phase 2 — measure every text run in one batch (all probe writes, then
  // all Range reads: one forced layout for the whole block). The consecutive
  // prefix-difference intervals reproduce segmentWidths' values exactly.
  const textPlans = plans.filter(
    (plan): plan is Extract<ChildPlan, { kind: 'text' }> => plan.kind === 'text' && plan.segs.length > 0,
  );
  if (textPlans.length) {
    const widths = measurer.intervalWidthsBatch(
      textPlans.map((plan) => {
        let prev = 0;
        const intervals = plan.segs.map((seg) => {
          const interval = { start: prev, end: seg.end };
          prev = seg.end;
          return interval;
        });
        return { text: plan.text, intervals, key: plan.font };
      }),
    );
    textPlans.forEach((plan, index) => {
      plan.widths = widths[index];
    });
  }

  // Phase 3 — build the item stream exactly as before.
  for (const plan of plans) {
    if (plan.kind === 'text') {
      const { text, offset } = plan;
      const hyphenW = measurer.hyphenWidth(plan.font) * K;
      plan.segs.forEach((seg, i) => {
        const w = plan.widths[i] * K;
        if (seg.space) {
          // Leading spaces (paragraph start / after a hard break) collapse.
          const last = items[items.length - 1];
          if (!last || last.kind === 'nodebreak') return;
          items.push({
            kp: { type: 'glue', width: w, stretch: w / 2, shrink: w / 3 },
            from: offset + seg.start,
            to: offset + seg.end,
            kind: 'space',
          });
        } else {
          if (seg.hyphenBefore) {
            // A boundary after an existing '-' breaks without adding a glyph.
            const glyphless = /[-–—]/.test(text[seg.start - 1]);
            items.push({
              kp: { type: 'penalty', width: glyphless ? 0 : hyphenW, penalty: HYPHEN_PENALTY, flagged: true },
              from: offset + seg.start,
              to: offset + seg.start,
              kind: 'hyphen',
              glyphless,
            });
          }
          items.push({
            kp: { type: 'box', width: w },
            from: offset + seg.start,
            to: offset + seg.end,
            kind: 'box',
          });
        }
      });
    } else if (plan.kind === 'nodebreak') {
      pushEndOfSegment(plan.offset, plan.offset + plan.size, 'nodebreak');
    } else {
      // A glueLeft atom (footnote marker) glues to whatever precedes it —
      // Typst renders no gap there even when the document holds a real
      // space, so drop that space item rather than let the local layout
      // reserve width the settled oracle will never confirm.
      if (plan.glueLeft) {
        while (items.length && items[items.length - 1].kind === 'space') items.pop();
      }
      items.push({
        kp: { type: 'box', width: plan.width },
        from: plan.offset,
        to: plan.offset + plan.size,
        kind: 'box',
        fill: plan.fill,
      });
    }
  }

  if (!items.some((i) => i.kp.type === 'box')) return [];
  pushEndOfSegment(block.content.size, block.content.size, 'end');

  const baseFont = measurer.fontFor([]);
  const baseSpace = measurer.spaceWidth(baseFont) * K;

  let lines: Array<{ start: number; end: number }>;
  if (opts.forced) {
    const cut = partitionAt(items, opts.forced);
    if (!cut) return null;
    lines = cut;
  } else {
    lines = breakLines(
      items.map((i) => i.kp),
      measure,
    );
  }

  const out: LineLayout[] = [];
  for (const line of lines) {
    const brk = items[line.end];
    let e = line.end - 1;
    while (e >= line.start && items[e].kp.type !== 'box') e--;
    if (e < line.start) continue;

    let natural = 0;
    let spaces = 0;
    const fillOffsets: number[] = [];
    for (let j = line.start; j <= e; j++) {
      const s = items[j].kp;
      if (items[j].fill) fillOffsets.push(items[j].from);
      if (s.type === 'box') natural += s.width;
      else if (s.type === 'glue') {
        natural += s.width;
        spaces++;
      }
    }
    const hyphenKind = brk.kind === 'hyphen';
    const hyphenGlyph = hyphenKind && !brk.glyphless;
    if (hyphenKind && brk.kp.type === 'penalty') natural += brk.kp.width;

    // Justify lines that break at a space or hyphen; segment-final lines
    // (paragraph end, hard break) stay ragged, as in TeX. The formula is
    // deliberately path-independent (no opts.forced): identical breaks must
    // give identical spacing, or the settle pass repaints agreement.
    const eps = fitEps(K);
    let spacing = lineWordSpacing(
      brk.kind === 'space' || hyphenKind,
      spaces,
      natural,
      measure,
      eps,
      baseSpace,
    );

    // Flexible atoms take the leftover space, so the spaces keep their
    // natural width — a line with an fr on it is never justified. Underfill
    // by a hair: an fr consumes the slack exactly, and the DOM measures the
    // text around it a shade wider than the canvas does, which would tip
    // the browser into re-wrapping the line we just laid out.
    let fills: LineLayout['fills'];
    if (fillOffsets.length) {
      spacing = 0;
      const slack = measure - eps - FILL_SLACK - natural;
      fills = { offsets: fillOffsets, width: Math.max(0, slack / fillOffsets.length) };
    }

    out.push({
      from: items[line.start].from,
      to: items[e].to,
      spacing,
      breakPos: brk.kind === 'space' ? brk.to : hyphenKind ? brk.from : null,
      hyphen: hyphenGlyph,
      fills,
      oracleBreak:
        brk.kind === 'space' || hyphenKind ? { at: brk.from, hyphen: hyphenKind } : undefined,
    });
  }
  return out;
}
