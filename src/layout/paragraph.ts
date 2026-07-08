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
/** Justify to slightly under the measure so rounding never overflows a line. */
const FIT_EPS = 0.5;
/** Forced (oracle) lines must NEVER browser-rewrap — an overflow makes an
 *  orphan word. Scaled contexts (footnote bodies) accumulate extra sub-pixel
 *  error, so forced lines aim a bit further under the measure. */
const FORCED_EPS = 1.5;

type Kind = 'box' | 'space' | 'hyphen' | 'end' | 'nodebreak';

interface SItem {
  kp: Item;
  from: number; // offsets relative to the block's content start
  to: number;
  kind: Kind;
  /** Break after an existing '-': no hyphen glyph needs to be injected. */
  glyphless?: boolean;
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

  block.forEach((child, offset) => {
    if (child.isText && child.text) {
      const font = measurer.fontFor(child.marks);
      const hyphenW = measurer.hyphenWidth(font) * K;
      const text = child.text;

      // Split the run into contiguous segments (spaces, and syllables within
      // words), then measure them all at once as prefix differences over the
      // full string so cross-boundary kerning is captured.
      interface Seg {
        start: number;
        end: number;
        space: boolean;
        hyphenBefore: boolean;
      }
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
      const widths = measurer.segmentWidths(
        text,
        segs.map((s) => s.end),
        font,
      );

      segs.forEach((seg, i) => {
        const w = widths[i] * K;
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
            const glyphless = text[seg.start - 1] === '-';
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
    } else if (child.type.name === 'hard_break') {
      pushEndOfSegment(offset, offset + child.nodeSize, 'nodebreak');
    } else {
      // Inline atom (math, …): a single unbreakable box measured from its DOM.
      items.push({
        kp: { type: 'box', width: atomWidth(offset, child) },
        from: offset,
        to: offset + child.nodeSize,
        kind: 'box',
      });
    }
  });

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
    for (let j = line.start; j <= e; j++) {
      const s = items[j].kp;
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
    // (paragraph end, hard break) stay ragged, as in TeX.
    let spacing = 0;
    // Scaled contexts (footnote bodies) carry a couple px of width-model
    // error the canvas can't see; aim further under the measure there —
    // ~0.3px of extra shrink per space, invisible, never an orphan.
    const eps = (opts.forced ? FORCED_EPS : FIT_EPS) + (K !== 1 ? 4.5 : 0);
    if ((brk.kind === 'space' || hyphenKind) && spaces > 0) {
      spacing = (measure - eps - natural) / spaces;
      // Forced (oracle) lines must never overflow into a browser re-wrap:
      // Typst fit this content, so shrink as far as needed.
      const minS = opts.forced ? -0.9 * baseSpace : -0.45 * baseSpace;
      spacing = Math.max(minS, Math.min(spacing, 3 * baseSpace));
    } else if (opts.forced && spaces > 0 && natural > measure - eps) {
      // Oracle-forced ragged line that the browser would wrap (its metrics
      // run a hair wider than Typst's): shrink it to fit — Typst fit it.
      spacing = Math.max(-0.45 * baseSpace, (measure - eps - natural) / spaces);
    }

    out.push({
      from: items[line.start].from,
      to: items[e].to,
      spacing,
      breakPos: brk.kind === 'space' ? brk.to : hyphenKind ? brk.from : null,
      hyphen: hyphenGlyph,
    });
  }
  return out;
}
