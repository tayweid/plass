// Authoritative paragraph translation: ProseMirror textblock + compiled
// Typst break offsets -> browser line layouts.
//
// Every measured token carries the document offset range it came from, so the
// oracle's decisions map straight back to decoration positions. This module
// deliberately contains no break search; the historical Knuth–Plass engine
// remains test/research code and is not in the production dependency graph.

import type { Node as PMNode } from 'prosemirror-model';
import { syllabify } from './hyphenate';
import { Measurer } from './measure';

/** Forced (oracle) lines must NEVER browser-rewrap — an overflow makes an
 *  orphan word. Scaled contexts (footnote bodies) accumulate extra sub-pixel
 *  error, so forced lines aim a bit further under the measure. */
const FORCED_EPS = 1.5;
/** A flexible (fr) atom absorbs the slack EXACTLY, leaving a line with no
 *  give at all; the DOM's own text measurement differs from the canvas by a
 *  fraction, which would wrap the line. Give the fill a couple of px back. */
const FILL_SLACK = 2;

type Kind = 'box' | 'space' | 'hyphen' | 'end' | 'nodebreak';

interface SItem {
  measured: { type: 'box' | 'space' | 'hyphen'; width: number };
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
}

export interface LayoutOptions {
  hyphenate?: boolean;
  /**
   * Authoritative break decisions from the Typst oracle. Lines are cut only
   * here; offsets must land on a space (word-end) or a mapped intra-word
   * boundary. A null result leaves the block browser-native.
   */
  forced: ForcedBreak[];
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
      // item in our stream (segmentation mismatch) — fail closed.
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
  opts: LayoutOptions,
): LineLayout[] | null {
  const items: SItem[] = [];
  const K = opts.scale ?? 1;

  // A painted prefix ("Figure N: ", footnote marker + indent) occupies the
  // start of line 1: model it as a zero-content box so line measurement and
  // per-line justification account for it.
  if (opts.firstLineIndent) {
    items.push({ measured: { type: 'box', width: opts.firstLineIndent }, from: 0, to: 0, kind: 'box' });
  }

  const pushEndOfSegment = (from: number, to: number, kind: Kind) => {
    // Spaces immediately before a break are discarded by CSS white-space
    // collapsing; drop them so the oracle agrees with the renderer.
    while (items.length && items[items.length - 1].kind === 'space') items.pop();
    items.push({ measured: { type: 'hyphen', width: 0 }, from, to, kind });
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
            measured: { type: 'space', width: w },
            from: offset + seg.start,
            to: offset + seg.end,
            kind: 'space',
          });
        } else {
          if (seg.hyphenBefore) {
            // A boundary after an existing '-' breaks without adding a glyph.
            const glyphless = /[-–—]/.test(text[seg.start - 1]);
            items.push({
              measured: { type: 'hyphen', width: glyphless ? 0 : hyphenW },
              from: offset + seg.start,
              to: offset + seg.start,
              kind: 'hyphen',
              glyphless,
            });
          }
          items.push({
            measured: { type: 'box', width: w },
            from: offset + seg.start,
            to: offset + seg.end,
            kind: 'box',
          });
        }
      });
    } else if (child.type.name === 'hard_break') {
      pushEndOfSegment(offset, offset + child.nodeSize, 'nodebreak');
    } else {
      // Inline atom (math, …): a single unbreakable box measured from its
      // DOM. A flexible (fr) atom contributes nothing to the natural width
      // — it absorbs whatever is left over once the line is chosen.
      const fill = opts.isFill?.(child) ?? false;
      items.push({
        measured: { type: 'box', width: fill ? 0 : atomWidth(offset, child) },
        from: offset,
        to: offset + child.nodeSize,
        kind: 'box',
        fill,
      });
    }
  });

  if (!items.some((i) => i.measured.type === 'box')) return [];
  pushEndOfSegment(block.content.size, block.content.size, 'end');

  const baseFont = measurer.fontFor([]);
  const baseSpace = measurer.spaceWidth(baseFont) * K;

  const lines = partitionAt(items, opts.forced);
  if (!lines) return null;

  const out: LineLayout[] = [];
  for (const line of lines) {
    const brk = items[line.end];
    let e = line.end - 1;
    while (e >= line.start && items[e].measured.type !== 'box') e--;
    if (e < line.start) continue;

    let natural = 0;
    let spaces = 0;
    const fillOffsets: number[] = [];
    for (let j = line.start; j <= e; j++) {
      const s = items[j].measured;
      if (items[j].fill) fillOffsets.push(items[j].from);
      if (s.type === 'box') natural += s.width;
      else if (s.type === 'space') {
        natural += s.width;
        spaces++;
      }
    }
    const hyphenKind = brk.kind === 'hyphen';
    const hyphenGlyph = hyphenKind && !brk.glyphless;
    if (hyphenKind) natural += brk.measured.width;

    // Justify lines that break at a space or hyphen; segment-final lines
    // (paragraph end, hard break) stay ragged, as in TeX.
    let spacing = 0;
    // Scaled contexts (footnote bodies) carry a couple px of width-model
    // error the canvas can't see; aim further under the measure there —
    // ~0.3px of extra shrink per space, invisible, never an orphan.
    const eps = FORCED_EPS + (K !== 1 ? 4.5 : 0);
    if ((brk.kind === 'space' || hyphenKind) && spaces > 0) {
      spacing = (measure - eps - natural) / spaces;
      // Forced (oracle) lines must never overflow into a browser re-wrap:
      // Typst fit this content, so shrink as far as needed.
      const minS = -0.9 * baseSpace;
      spacing = Math.max(minS, Math.min(spacing, 3 * baseSpace));
    } else if (spaces > 0 && natural > measure - eps) {
      // Oracle-forced ragged line that the browser would wrap (its metrics
      // run a hair wider than Typst's): shrink it to fit — Typst fit it.
      spacing = Math.max(-0.45 * baseSpace, (measure - eps - natural) / spaces);
    }

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
    });
  }
  return out;
}
