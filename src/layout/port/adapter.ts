// Phase-2 adapter (PORT.md): ProseMirror paragraph → port input → the
// oracle's ForcedBreak contract. The port's break decisions feed
// layoutBlock(opts.forced) exactly like Typst-oracle results do, so the
// entire downstream pipeline (decorations, spacers, pagination) is
// untouched.
//
// Units: the editor measures in CSS px, the port in pt (1px = 0.75pt).
// Offsets: the port works in UTF-8 bytes of the assembled paragraph text;
// this module owns the byte ↔ PM-offset mapping.

import type { Node as PMNode } from 'prosemirror-model';
import type { ForcedBreak } from '../paragraph';
import { ByteText, utf8Len } from './bytes';
import { defaultConfig, prepare, type InputSegment } from './prepare';
import { linebreak } from './linebreak';

const PT_PER_PX = 0.75;

/** Last bail reason (DEV diagnostics — read via window.__portWhy). */
export let lastBail = '';
if (typeof window !== 'undefined') {
  (window as unknown as { __portWhy: () => string }).__portWhy = () => lastBail;
}

export interface PortBreakOptions {
  /** Document font size in pt. */
  sizePt: number;
  /** Editor hyphenation setting (undefined = Typst auto → justify). */
  hyphenate?: boolean;
  /** Painted prefix width in px consumed at the start of line 1
   * (caption "Figure N: ", footnote marker). */
  firstLineIndentPx?: number;
  /** Content em scale (0.85 for footnote bodies / captions). */
  scale?: number;
  /** Typst-true atom width in pt (sidecar-shaped markers/citations);
   * null → fall back to the DOM px measurement. */
  atomWidthPt?: (offset: number, child: PMNode) => number | null;
  /** Painted prefix modeled as REAL TEXT ('Figure N: ' for captions — its
   * trailing space justifies with the line, unlike a fixed indent). */
  prefixText?: string;
}

/** One piece of the paragraph with its PM anchor. */
interface Piece {
  seg: InputSegment;
  /** PM offset of the piece's start (text: first char; atom: the node). */
  pmBase: number;
  /** For text pieces: byte→JS-index mapping of the piece's own (collapsed)
   * text. */
  bt: ByteText | null;
  /** Collapsed JS index → original JS index (space runs collapse to their
   * first space, mirroring Typst markup whitespace collapsing). */
  origIdx: Uint32Array | null;
}

function styleKeyFor(marks: Set<string>): string {
  if (marks.has('code')) return 'mono';
  if (marks.has('strong') && marks.has('em')) return 'bolditalic';
  if (marks.has('strong')) return 'bold';
  if (marks.has('em')) return 'italic';
  return 'regular';
}

/**
 * Run the ported Typst line breaker on a paragraph block and return the
 * oracle-shaped break list, or null when the block contains content the
 * adapter can't map (caller falls back to the JS KP path).
 */
export function portBreaks(
  block: PMNode,
  measurePx: number,
  atomWidthPx: (offset: number, child: PMNode) => number,
  opts: PortBreakOptions,
): ForcedBreak[] | null {
  const K = opts.scale ?? 1;
  const baseSize = opts.sizePt * K;

  // --- assemble input segments with PM anchors ---
  const pieces: Piece[] = [];
  if (opts.prefixText) {
    // Unmapped text: breaks never legitimately land inside the prefix.
    pieces.push({
      seg: { kind: 'text', text: opts.prefixText, styleKey: 'regular', fontSize: baseSize },
      pmBase: -1,
      bt: null,
      origIdx: null,
    });
  }
  let bad = false;
  block.forEach((child, offset) => {
    if (bad) return;
    if (child.isText && child.text) {
      const marks = new Set(child.marks.map((m) => m.type.name));
      const styleKey = styleKeyFor(marks);
      const fontSize = styleKey === 'mono' ? 0.8 * baseSize : baseSize;
      // Collapse space runs to one space: Typst markup collapses them, so
      // the export, the oracle, and the PDF all see a single space.
      const raw = child.text;
      let collapsed = '';
      const orig: number[] = [];
      let prevSpace = false;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === ' ' && prevSpace) continue;
        prevSpace = ch === ' ';
        collapsed += ch;
        orig.push(i);
      }
      orig.push(raw.length);
      pieces.push({
        seg: { kind: 'text', text: collapsed, styleKey, fontSize },
        pmBase: offset,
        bt: new ByteText(collapsed),
        origIdx: collapsed.length === raw.length ? null : Uint32Array.from(orig),
      });
    } else if (child.type.name === 'hard_break') {
      // The serializer emits ' \\\n' → Typst sees space, linebreak, space.
      pieces.push({
        seg: { kind: 'text', text: ' \n ', styleKey: 'regular', fontSize: baseSize },
        pmBase: offset,
        bt: null,
        origIdx: null,
      });
    } else if (child.isInline) {
      const wPt = opts.atomWidthPt?.(offset, child) ?? null;
      const w = wPt !== null ? wPt : atomWidthPx(offset, child) * PT_PER_PX;
      if (!(w >= 0)) {
        bad = true;
        return;
      }
      pieces.push({
        seg: { kind: 'atom', width: w },
        pmBase: offset,
        bt: null,
        origIdx: null,
      });
    } else {
      bad = true;
    }
  });
  if (bad || pieces.length === 0) {
    lastBail = 'unmapped-child';
    return null;
  }

  const config = defaultConfig(baseSize);
  if (opts.hyphenate !== undefined) config.hyphenate = opts.hyphenate;
  if (opts.firstLineIndentPx) config.firstLineIndent = opts.firstLineIndentPx * PT_PER_PX;

  const p = prepare(
    pieces.map((pc) => pc.seg),
    config,
  );

  // --- byte → PM-offset map ---
  // prepare() reports each input segment's byte start; within a text piece
  // the piece-local ByteText converts byte → JS index → PM offset.
  const pmAt = (byte: number): number | null => {
    // Find the piece containing this byte (inputStarts is ascending).
    const starts = p.inputStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= byte) lo = mid;
      else hi = mid - 1;
    }
    const piece = pieces[lo];
    const rel = byte - starts[lo];
    if (piece.seg.kind === 'text' && piece.bt) {
      const js = piece.bt.js(rel);
      return piece.pmBase + (piece.origIdx ? piece.origIdx[js] : js);
    }
    // Hard-break artifact text (' \n ') or atom replacement char: breaks
    // never legitimately land inside these (mandatory breaks are skipped;
    // a space break walks back past real spaces only).
    return null;
  };

  // --- run the breaker ---
  const measurePt = measurePx * PT_PER_PX;
  const lines = linebreak(p, measurePt);
  if (!lines.length) return null;

  // --- lines → ForcedBreak[] ---
  const out: ForcedBreak[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const ln = lines[i];
    if (ln.bp.kind === 'mandatory') continue; // nodebreak items cut these
    if (ln.bp.kind === 'hyphen') {
      const at = pmAt(ln.endByte);
      if (at === null) {
        lastBail = 'hyphen-unmapped@' + ln.endByte;
        return null;
      }
      out.push({ at, hyphen: true });
      continue;
    }
    // Normal break: walk back over the space run to its first space byte
    // (ForcedBreak.at = the space's start offset, per the oracle contract).
    let b = ln.endByte;
    while (b > 0 && p.text.charAt(b - 1) === ' ') b--;
    if (b === ln.endByte) {
      // No space before the break: a compound '-' (or dash) opportunity —
      // the item stream models these as glyphless hyphen items at the
      // split offset.
      if (/[-–—]/.test(p.text.charBefore(b))) {
        const at = pmAt(b);
        if (at === null) {
          lastBail = 'compound-unmapped@' + b;
          return null;
        }
        out.push({ at, hyphen: true });
        continue;
      }
      lastBail = 'nonspace-break@' + b + ':' + JSON.stringify(p.text.slice(Math.max(0, b - 12), Math.min(p.text.len, b + 6)));
      return null; // unmodeled opportunity (e.g. em-dash split) → fallback
    }
    const at = pmAt(b);
    if (at === null) {
      lastBail = 'space-unmapped@' + b;
      return null;
    }
    out.push({ at, hyphen: false });
  }
  return out;
}
