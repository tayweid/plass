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

type Kind = 'box' | 'space' | 'hyphen' | 'end' | 'nodebreak';

interface SItem {
  kp: Item;
  from: number; // offsets relative to the block's content start
  to: number;
  kind: Kind;
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
}

/** Compute typeset line layouts for one paragraph node. */
export function layoutBlock(
  block: PMNode,
  measure: number,
  measurer: Measurer,
  atomWidth: (offset: number, child: PMNode) => number,
  opts: LayoutOptions = {},
): LineLayout[] {
  const items: SItem[] = [];

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
      const hyphenW = measurer.hyphenWidth(font);
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
        const w = widths[i];
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
            items.push({
              kp: { type: 'penalty', width: hyphenW, penalty: HYPHEN_PENALTY, flagged: true },
              from: offset + seg.start,
              to: offset + seg.start,
              kind: 'hyphen',
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
  const baseSpace = measurer.spaceWidth(baseFont);

  const lines = breakLines(
    items.map((i) => i.kp),
    measure,
  );

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
    const hyphen = brk.kind === 'hyphen';
    if (hyphen && brk.kp.type === 'penalty') natural += brk.kp.width;

    // Justify lines that break at a space or hyphen; segment-final lines
    // (paragraph end, hard break) stay ragged, as in TeX.
    let spacing = 0;
    if ((brk.kind === 'space' || hyphen) && spaces > 0) {
      spacing = (measure - FIT_EPS - natural) / spaces;
      spacing = Math.max(-0.45 * baseSpace, Math.min(spacing, 3 * baseSpace));
    }

    out.push({
      from: items[line.start].from,
      to: items[e].to,
      spacing,
      breakPos: brk.kind === 'space' ? brk.to : hyphen ? brk.from : null,
      hyphen,
    });
  }
  return out;
}
