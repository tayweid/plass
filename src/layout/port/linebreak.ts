// Mirror of crates/typst-layout/src/inline/linebreak.rs and the metrics
// half of line.rs (typst 951788cc). Function names, constants, arithmetic,
// and evaluation order follow the Rust exactly; see PORT.md for the porting
// rules (powi → explicit multiplication, byte offsets everywhere, ties keep
// the later predecessor).

import { primitives } from '../primitives';
import { ByteText, charCount, utf8Len } from './bytes';
import { Glyphs, ShapedText, isCjScript, isCjkPunctuation } from './shaping';
import type { Item, Preparation } from './prepare';

type Cost = number;

// Cost parameters (linebreak.rs).
const DEFAULT_HYPH_COST: Cost = 135.0;
const DEFAULT_RUNT_COST: Cost = 100.0;

// Other parameters.
const MIN_RATIO = -1.0;
const MIN_APPROX_RATIO = -0.5;
const BOUND_EPS = 1e-3;

// Abs epsilon (typst-library layout/abs.rs AbsUnit::EPS, raw = pt).
const ABS_EPS = 1e-4;

/** Abs::fits — `self + EPS >= other`. */
function fits(self_: number, other: number): boolean {
  return self_ + ABS_EPS >= other;
}

/** Abs::approx_eq. */
function approxEq(a: number, b: number): boolean {
  return a === b || Math.abs(a - b) < ABS_EPS;
}

// Zero width space.
const ZWS = '\u200B';
const OBJ_REPLACE = '\uFFFC';
const LINE_SEPARATOR = '\u2028';
const SHY = '\u00AD';
const HYPHEN = '-';
const EN_DASH = '\u2013';
const EM_DASH = '\u2014';

/** A line break opportunity (Breakpoint). */
export type Breakpoint =
  | { kind: 'normal' }
  | { kind: 'mandatory' }
  | { kind: 'hyphen'; l: number; r: number };

const NORMAL: Breakpoint = { kind: 'normal' };
const MANDATORY: Breakpoint = { kind: 'mandatory' };

function isHyphen(b: Breakpoint): boolean {
  return b.kind === 'hyphen';
}

/** How to trim the end of a line (Trim). */
interface Trim {
  layout: number;
  shaping: number;
}

/** Breakpoint::trim — trim a line before this breakpoint. `start` is the
 * line's byte start, `line` its full text. */
function breakpointTrim(bp: Breakpoint, start: number, line: string): Trim {
  switch (bp.kind) {
    case 'normal': {
      const trimmed = trimEndMatches(line, (c) => /\p{White_Space}/u.test(c) || c === ZWS);
      return { layout: start + utf8Len(trimmed), shaping: start + utf8Len(line) };
    }
    case 'mandatory': {
      const prim = primitives()!;
      const lb = prim.lb;
      const trimmed = trimEndMatches(line, (c) => {
        const cls = prim.lbClasses(c)[0];
        return (
          cls === lb.mandatoryBreak ||
          cls === lb.carriageReturn ||
          cls === lb.lineFeed ||
          cls === lb.nextLine
        );
      });
      const t = start + utf8Len(trimmed);
      return { layout: t, shaping: t };
    }
    case 'hyphen': {
      const t = start + utf8Len(line);
      return { layout: t, shaping: t };
    }
  }
}

function trimEndMatches(s: string, f: (c: string) => boolean): string {
  let end = s.length;
  while (end > 0) {
    const lo = end >= 2 && /[\uDC00-\uDFFF]/.test(s[end - 1]) ? end - 2 : end - 1;
    const c = String.fromCodePoint(s.codePointAt(lo)!);
    if (!f(c)) break;
    end = lo;
  }
  return s.slice(0, end);
}

/** A dash at the end of a line (Dash). */
export type Dash = 'soft' | 'hard' | 'other';

/** Mirror of Line (metrics-relevant fields). */
export class Line {
  items: LineItem[];
  width: number;
  justify: boolean;
  dash: Dash | null;
  /** End byte offset of the line range (set by line()). */
  endByte = 0;
  /** The breakpoint that ended this line (set by line()). */
  bp: Breakpoint = { kind: 'mandatory' };
  // Lazy metric memos. A Line's items are never mutated after line()
  // returns, so the first computed value is the value; memoizing lets a
  // line served from the incremental cache skip the per-glyph sums.
  private justMemo: number | null = null;
  private stretchMemo: number | null = null;
  private shrinkMemo: number | null = null;

  constructor(items: LineItem[], width: number, justify: boolean, dash: Dash | null) {
    this.items = items;
    this.width = width;
    this.justify = justify;
    this.dash = dash;
  }

  static empty(): Line {
    return new Line([], 0, false, null);
  }

  /** A copy for serving from the incremental cache: same immutable items
   * and metric values, remapped end offset and breakpoint. */
  cloneAt(endByte: number, bp: Breakpoint): Line {
    const ln = new Line(this.items, this.width, this.justify, this.dash);
    ln.endByte = endByte;
    ln.bp = bp;
    ln.justMemo = this.justMemo;
    ln.stretchMemo = this.stretchMemo;
    ln.shrinkMemo = this.shrinkMemo;
    return ln;
  }

  justifiables(): number {
    if (this.justMemo !== null) return this.justMemo;
    let count = 0;
    for (const it of this.items) {
      if (it.kind === 'text') count += it.shaped.justifiables();
    }
    // CJK character at line end should not be adjusted.
    const trailing = this.trailingText();
    if (trailing?.cjkJustifiableAtLast()) count -= 1;
    this.justMemo = count;
    return count;
  }

  stretchability(): number {
    if (this.stretchMemo !== null) return this.stretchMemo;
    let s = 0;
    for (const it of this.items) if (it.kind === 'text') s += it.shaped.stretchability();
    this.stretchMemo = s;
    return s;
  }

  shrinkability(): number {
    if (this.shrinkMemo !== null) return this.shrinkMemo;
    let s = 0;
    for (const it of this.items) if (it.kind === 'text') s += it.shaped.shrinkability();
    this.shrinkMemo = s;
    return s;
  }

  hasNegativeWidthItems(): boolean {
    return this.items.some(
      (it) => (it.kind === 'absolute' || it.kind === 'frame') && it.width < 0,
    );
  }

  trailingText(): ShapedText | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === 'text') return it.shaped;
    }
    return null;
  }
}

/** Items of a line. Absolute/Frame carry their width in pt. */
export type LineItem =
  | { kind: 'text'; shaped: ShapedText }
  | { kind: 'absolute'; width: number; weak: boolean }
  | { kind: 'frame'; width: number }
  | { kind: 'skip' };

function itemNaturalWidth(it: LineItem): number {
  switch (it.kind) {
    case 'text':
      return it.shaped.width();
    case 'absolute':
    case 'frame':
      return it.width;
    case 'skip':
      return 0;
  }
}

/** Mirror of line(): create a line spanning the given byte range. */
export function line(
  p: Preparation,
  rangeStart: number,
  rangeEnd: number,
  breakpoint: Breakpoint,
  pred: Line | null,
): Line {
  const full = p.text.slice(rangeStart, rangeEnd);

  // Whether the line is justified.
  const justify =
    full.endsWith(LINE_SEPARATOR) || (p.config.justify && breakpoint.kind !== 'mandatory');

  // Process dashes.
  const dash: Dash | null =
    isHyphen(breakpoint) || full.endsWith(SHY)
      ? 'soft'
      : full.endsWith(HYPHEN)
        ? 'hard'
        : full.endsWith(EN_DASH) || full.endsWith(EM_DASH)
          ? 'other'
          : null;

  // Trim the line at the end, if necessary for this breakpoint.
  const trim = breakpointTrim(breakpoint, rangeStart, full);

  const items: LineItem[] = [];

  // Add a hyphen at the line start, if a previous dash should be repeated.
  if (pred && pred.dash === 'hard') {
    const base = pred.trailingText();
    if (base && shouldRepeatHyphen(base.lang, full)) {
      const hyphen = ShapedText.hyphen(base, trim.shaping, false);
      if (hyphen) items.push({ kind: 'text', shaped: hyphen });
    }
  }

  collectItems(items, p, rangeStart, rangeEnd, trim);

  // Add a hyphen at the line end, if we ended on a soft hyphen.
  if (dash === 'soft') {
    const base = trailingTextOf(items);
    if (base) {
      const hyphen = ShapedText.hyphen(base, trim.shaping, true);
      if (hyphen) items.push({ kind: 'text', shaped: hyphen });
    }
  }

  // Ensure that there is no weak spacing at the start and end of the line.
  trimWeakSpacing(items);

  // Deal with CJ characters at line boundaries.
  adjustCjAtLineBoundaries(p, rangeStart, trim.layout, items);

  // adjust_glyph_stretch_at_line_end: with default tracking limits (0, 0)
  // this returns immediately — ported as the same early exit.

  // Compute the line's width.
  let width = 0;
  for (const it of items) width += itemNaturalWidth(it);

  const ln = new Line(items, width, justify, dash);
  ln.endByte = rangeEnd;
  ln.bp = breakpoint;
  return ln;
}

function trailingTextOf(items: LineItem[]): ShapedText | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'text') return it.shaped;
  }
  return null;
}

/** Mirror of collect_items + collect_range (LTR: single run, no reorder). */
function collectItems(
  items: LineItem[],
  p: Preparation,
  rangeStart: number,
  rangeEnd: number,
  trim: Trim,
): void {
  let fallback: LineItem | null = null;

  for (const [subStart, subEnd, item] of p.slice(rangeStart, rangeEnd)) {
    // All non-text items are just kept, they can't be split.
    if (item.kind !== 'text') {
      items.push(item);
      continue;
    }
    const shaped = item.shaped;

    // Intersection of the item, the subrange, and the line's trimming.
    const slicedStart = Math.max(rangeStart, subStart);
    const slicedEnd = Math.min(rangeEnd, subEnd, trim.shaping);

    // Whether the item is split by the line.
    const split = subStart < slicedStart || slicedEnd < subEnd;

    if (slicedStart >= slicedEnd) {
      // Keep as a fallback item to force non-zero line height.
      fallback = { kind: 'text', shaped: shaped.empty() };
      continue;
    }

    let entry: LineItem;
    if (split) {
      const reshaped = shaped.reshape(p.text, slicedStart, slicedEnd, p.shapeConfig(subStart));
      entry = { kind: 'text', shaped: reshaped };
    } else {
      // Fully contained: keep, but clone the glyph view since trimming
      // mutates the kept range.
      const st = new ShapedText(shaped.base, shaped.text, shaped.lang, shaped.styleKey, cloneGlyphs(shaped.glyphs));
      st.fallbackSize = shaped.fallbackSize;
      entry = { kind: 'text', shaped: st };
    }

    // Trim end-of-line whitespace glyphs.
    if (trim.layout < rangeEnd) {
      entry.shaped.glyphs.trim((g) => trim.layout < g.rangeEnd);
    }

    items.push(entry);
  }

  // Add fallback text to expand the line height, if necessary.
  if (!items.some((it) => it.kind === 'text') && fallback) {
    items.push(fallback);
  }
}

function cloneGlyphs(g: Glyphs): Glyphs {
  const c = new Glyphs(g.inner);
  c.keptStart = g.keptStart;
  c.keptEnd = g.keptEnd;
  return c;
}

/** Mirror of trim_weak_spacing. */
function trimWeakSpacing(items: LineItem[]): void {
  let prefix = 0;
  while (prefix < items.length) {
    const it = items[prefix];
    if (it.kind === 'absolute' && it.weak) prefix++;
    else break;
  }
  if (prefix > 0) items.splice(0, prefix);
  while (items.length) {
    const it = items[items.length - 1];
    if (it.kind === 'absolute' && it.weak) items.pop();
    else break;
  }
}

/** Mirror of adjust_cj_at_line_boundaries (metrics effect only for CJ
 * text; ported for structure, no-op on Latin lines). */
function adjustCjAtLineBoundaries(
  p: Preparation,
  rangeStart: number,
  trimLayout: number,
  items: LineItem[],
): void {
  const text = p.text.slice(rangeStart, Math.max(rangeStart, trimLayout));
  if (!text) return;
  const first = String.fromCodePoint(text.codePointAt(0)!);
  const lastIdx = text.length >= 2 && /[\uDC00-\uDFFF]/.test(text[text.length - 1]) ? text.length - 2 : text.length - 1;
  const last = String.fromCodePoint(text.codePointAt(lastIdx)!);

  if (BEGIN_PUNCT.includes(first) || (p.config.cjkLatinSpacing && isCjScript(first))) {
    adjustCjAtLineStart(p, items);
  }
  if (END_PUNCT.includes(last) || (p.config.cjkLatinSpacing && isCjScript(last))) {
    adjustCjAtLineEnd(p, items);
  }
}

const BEGIN_PUNCT = '“‘《〈（『「【〖〔［｛';
const END_PUNCT = '”’，．。、：；》〉）』」】〗〕］｝？！';

function leadingTextOf(items: LineItem[]): ShapedText | null {
  for (const it of items) if (it.kind === 'text') return it.shaped;
  return null;
}

// The CJ line-boundary adjustments mutate glyphs that line-construction
// items SHARE with the Preparation (Rust clones; the port aliases). That
// makes line() order-dependent once a mutating branch fires. The
// incremental cache's eligibility scan rejects any paragraph whose glyphs
// could enter these branches; this counter is the belt-and-suspenders
// runtime tripwire behind that scan (see incremental.ts).
let cjMutations = 0;

/** Number of CJ glyph mutations performed since module load. */
export function cjMutationCount(): number {
  return cjMutations;
}

function adjustCjAtLineStart(p: Preparation, items: LineItem[]): void {
  const shaped = leadingTextOf(items);
  const glyph = shaped?.glyphs.first();
  if (!shaped || !glyph) return;
  if (isCjkPunctuation(glyph) && glyph.adjustability.shrinkability[0] > 0 && !isCjScript(glyph.c)) {
    // is_cjk_right_aligned_punctuation → shrink_left by full left shrink.
    cjMutations++;
    const shrink = glyph.adjustability.shrinkability[0];
    glyph.xOffset -= shrink;
    glyph.xAdvance -= shrink;
    glyph.adjustability.shrinkability[0] -= shrink;
  } else if (p.config.cjkLatinSpacing && isCjScript(glyph.c) && glyph.xOffset > 0) {
    cjMutations++;
    const shrink = glyph.xOffset;
    glyph.xAdvance -= shrink;
    glyph.xOffset = 0;
    glyph.adjustability.shrinkability[0] = 0;
  }
}

function adjustCjAtLineEnd(p: Preparation, items: LineItem[]): void {
  const shaped = trailingTextOf(items);
  const glyph = shaped?.glyphs.last();
  if (!shaped || !glyph) return;
  if (isCjkPunctuation(glyph) && glyph.adjustability.shrinkability[1] > 0) {
    // is_cjk_left_aligned_punctuation → shrink_right by full right shrink.
    cjMutations++;
    const shrink = glyph.adjustability.shrinkability[1];
    glyph.xAdvance -= shrink;
    glyph.adjustability.shrinkability[1] -= shrink;
  } else if (p.config.cjkLatinSpacing && isCjScript(glyph.c) && glyph.xAdvance - glyph.xOffset > 1.0) {
    cjMutations++;
    const shrink = glyph.xAdvance - glyph.xOffset - 1.0;
    glyph.xAdvance -= shrink;
    glyph.adjustability.shrinkability[1] = 0;
  }
}

/** should_repeat_hyphen (line.rs). */
function shouldRepeatHyphen(lang: string, followingText: string): boolean {
  switch (lang) {
    case 'dsb':
    case 'cs':
    case 'hr':
    case 'pl':
    case 'pt':
    case 'sk':
      return true;
    case 'es': {
      if (!followingText.length) return false;
      const c = String.fromCodePoint(followingText.codePointAt(0)!);
      return !/\p{Uppercase}/u.test(c);
    }
    default:
      return false;
  }
}

/**
 * A cross-run cache session for the optimized passes (see incremental.ts).
 * `serve` may return a previously built Line ONLY when a from-scratch
 * line() call over the same range would produce identical values; `record`
 * captures every line this run built or served so the next run can reuse
 * it. Both passes run the full DP either way — the session only replaces
 * the pure line-construction step, so costs, pruning, the approximate
 * bound, and tie-breaks are bit-identical to an uncached run.
 */
export interface LinebreakSession {
  serve(start: number, end: number, breakpoint: Breakpoint): Line | null;
  record(start: number, end: number, breakpoint: Breakpoint, line: Line): void;
}

/** line() through the session cache (identical values either way). */
function buildLine(
  session: LinebreakSession | null,
  p: Preparation,
  start: number,
  end: number,
  breakpoint: Breakpoint,
  pred: Line | null,
): Line {
  if (session) {
    const served = session.serve(start, end, breakpoint);
    if (served) return served;
  }
  const ln = line(p, start, end, breakpoint, pred);
  session?.record(start, end, breakpoint, ln);
  return ln;
}

/** Breaks the text into lines (linebreak()). */
export function linebreak(p: Preparation, width: number, session?: LinebreakSession | null): Line[] {
  if (p.config.linebreaks === 'simple') return linebreakSimple(p, width);
  return linebreakOptimized(p, width, session ?? null);
}

/** linebreak_simple. */
function linebreakSimple(p: Preparation, width: number): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let last: { attempt: Line; end: number } | null = null;

  breakpoints(p, (end, breakpoint) => {
    let attempt = line(p, start, end, breakpoint, lines.length ? lines[lines.length - 1] : null);

    if (!fits(width, attempt.width) && last) {
      lines.push(last.attempt);
      start = last.end;
      last = null;
      attempt = line(p, start, end, breakpoint, lines.length ? lines[lines.length - 1] : null);
    }

    if (breakpoint.kind === 'mandatory' || !fits(width, attempt.width)) {
      lines.push(attempt);
      start = end;
      last = null;
    } else {
      last = { attempt, end };
    }
  });

  if (last) lines.push((last as { attempt: Line; end: number }).attempt);
  return lines;
}

/** linebreak_optimized: approximate pass for the bound, then exact. Both
 * passes consume the same materialized breakpoint sequence — breakpoints()
 * is deterministic, so this equals the previous generate-twice behavior. */
function linebreakOptimized(p: Preparation, width: number, session: LinebreakSession | null): Line[] {
  const metrics = computeCostMetrics(p);
  const bps: Array<[number, Breakpoint]> = [];
  breakpoints(p, (end, breakpoint) => bps.push([end, breakpoint]));
  const upperBound = linebreakOptimizedApproximate(p, width, metrics, bps, session);
  return linebreakOptimizedBounded(p, width, metrics, upperBound, bps, session);
}

interface BoundedEntry {
  pred: number;
  total: Cost;
  line: Line;
  end: number;
}

/** linebreak_optimized_bounded. */
function linebreakOptimizedBounded(
  p: Preparation,
  width: number,
  metrics: CostMetrics,
  upperBound: Cost,
  bps: Array<[number, Breakpoint]>,
  session: LinebreakSession | null,
): Line[] {
  const table: BoundedEntry[] = [{ pred: 0, total: 0.0, line: Line.empty(), end: 0 }];
  let active = 0;
  let prevEnd = 0;

  for (const [end, breakpoint] of bps) {
    let best: BoundedEntry | null = null;
    let lineLowerBound: Cost | null = null;

    for (let predIndex = active; predIndex < table.length; predIndex++) {
      const pred = table[predIndex];
      const start = pred.end;
      const unbreakable = prevEnd === start;

      if (lineLowerBound !== null && pred.total + lineLowerBound > upperBound + BOUND_EPS) {
        continue;
      }

      const attempt = buildLine(session, p, start, end, breakpoint, pred.line);
      const [lineRatio, lineCost] = ratioAndCost(
        p,
        metrics,
        width,
        pred.line,
        attempt,
        breakpoint,
        unbreakable,
      );

      if (lineRatio < metrics.minRatio && active === predIndex) {
        active += 1;
      }

      const total = pred.total + lineCost;

      if (lineRatio > 0.0 && lineLowerBound === null && !attempt.hasNegativeWidthItems()) {
        lineLowerBound = lineCost;
      }

      if (total > upperBound + BOUND_EPS) {
        continue;
      }

      if (best === null || best.total >= total) {
        best = { pred: predIndex, total, line: attempt, end };
      }
    }

    if (breakpoint.kind === 'mandatory') {
      active = table.length;
    }

    if (best) table.push(best);
    prevEnd = end;
  }

  // Retrace the best path.
  const lines: Line[] = [];
  let idx = table.length - 1;

  // Should only happen if the bound was faulty: retry unbounded.
  if (table[idx].end !== p.text.len) {
    return linebreakOptimizedBounded(p, width, metrics, Infinity, bps, session);
  }

  while (idx !== 0) {
    const entry = table[idx];
    lines.push(entry.line);
    idx = entry.pred;
  }

  lines.reverse();
  return lines;
}

interface ApproxEntry {
  pred: number;
  total: Cost;
  end: number;
  unbreakable: boolean;
  breakpoint: Breakpoint;
}

/** linebreak_optimized_approximate. */
function linebreakOptimizedApproximate(
  p: Preparation,
  width: number,
  metrics: CostMetrics,
  bps: Array<[number, Breakpoint]>,
  session: LinebreakSession | null,
): Cost {
  const estimates = computeEstimates(p);

  // Per-breakpoint whitespace back-scan: wsBack[i] is the byte offset of
  // bps[i][0] scanned back over trailing White_Space chars. The original
  // per-candidate `start + text[start..end].trim_end().len()` equals
  // max(start, wsBack) — trimming stops at `start` only when the whole
  // candidate slice is whitespace, in which case wsBack < start.
  const wsBack = new Array<number>(bps.length);
  for (let i = 0; i < bps.length; i++) {
    let b = bps[i][0];
    while (b > 0) {
      const c = p.text.charBefore(b);
      if (!/\p{White_Space}/u.test(c)) break;
      b -= utf8Len(c);
    }
    wsBack[i] = b;
  }

  const table: ApproxEntry[] = [
    { pred: 0, total: 0.0, end: 0, unbreakable: false, breakpoint: MANDATORY },
  ];
  let active = 0;
  let prevEnd = 0;

  for (let bpIndex = 0; bpIndex < bps.length; bpIndex++) {
    const [end, breakpoint] = bps[bpIndex];
    let best: ApproxEntry | null = null;
    for (let predIndex = active; predIndex < table.length; predIndex++) {
      const pred = table[predIndex];
      const start = pred.end;
      const unbreakable = prevEnd === start;

      const justify = p.config.justify && breakpoint.kind !== 'mandatory';
      const consecutiveDash = isHyphen(pred.breakpoint) && isHyphen(breakpoint);

      // trimmed_end = start + text[start..end].trim_end().len()
      const trimmedEnd = Math.max(start, wsBack[bpIndex]);

      const lineRatio = rawRatio(
        p,
        width,
        estimates.widths.estimate(start, trimmedEnd) +
          (isHyphen(breakpoint) ? metrics.approxHyphenWidth : 0),
        estimates.stretchability.estimate(start, trimmedEnd),
        estimates.shrinkability.estimate(start, trimmedEnd),
        estimates.justifiables.estimate(start, trimmedEnd),
      );

      const lineCost = rawCost(metrics, breakpoint, lineRatio, justify, unbreakable, consecutiveDash, true);

      if (lineRatio < metrics.minRatio && active === predIndex) {
        active += 1;
      }

      const total = pred.total + lineCost;

      if (best === null || best.total >= total) {
        best = { pred: predIndex, total, end, unbreakable, breakpoint };
      }
    }

    if (breakpoint.kind === 'mandatory') {
      active = table.length;
    }

    if (best) table.push(best);
    prevEnd = end;
  }

  // Retrace the best path.
  const indices: number[] = [];
  let idx = table.length - 1;
  while (idx !== 0) {
    indices.push(idx);
    idx = table[idx].pred;
  }

  let pred = Line.empty();
  let start = 0;
  let exact = 0.0;

  for (let k = indices.length - 1; k >= 0; k--) {
    const entry = table[indices[k]];
    const attempt = buildLine(session, p, start, entry.end, entry.breakpoint, pred);
    const [ratio, lineCost] = ratioAndCost(
      p,
      metrics,
      width,
      pred,
      attempt,
      entry.breakpoint,
      entry.unbreakable,
    );

    if (ratio < metrics.minRatio) {
      return Infinity;
    }

    pred = attempt;
    start = entry.end;
    exact += lineCost;
  }

  return exact;
}

/** ratio_and_cost. */
function ratioAndCost(
  p: Preparation,
  metrics: CostMetrics,
  availableWidth: number,
  pred: Line,
  attempt: Line,
  breakpoint: Breakpoint,
  unbreakable: boolean,
): [number, Cost] {
  const ratio = rawRatio(
    p,
    availableWidth,
    attempt.width,
    attempt.stretchability(),
    attempt.shrinkability(),
    attempt.justifiables(),
  );
  const cost = rawCost(
    metrics,
    breakpoint,
    ratio,
    attempt.justify,
    unbreakable,
    pred.dash !== null && attempt.dash !== null,
    false,
  );
  return [ratio, cost];
}

/** raw_ratio. */
function rawRatio(
  p: Preparation,
  availableWidth: number,
  lineWidth: number,
  stretchability: number,
  shrinkability: number,
  justifiables: number,
): number {
  let delta = availableWidth - lineWidth;

  // Avoid possible floating point errors in previous calculation.
  if (approxEq(delta, 0)) delta = 0;

  const adjustability = delta >= 0 ? stretchability : shrinkability;
  let ratio = delta / Math.max(adjustability, 0);

  if (Number.isNaN(ratio)) ratio = 0;

  if (ratio > 1.0) {
    const extraStretch = (delta - adjustability) / Math.max(justifiables, 1);
    ratio = 1.0 + extraStretch / (p.config.fontSize / 2.0);
  }

  // clamp(MIN_RATIO - 1, 10)
  return Math.min(Math.max(ratio, MIN_RATIO - 1.0), 10.0);
}

/** raw_cost. */
function rawCost(
  metrics: CostMetrics,
  breakpoint: Breakpoint,
  ratio: number,
  justify: boolean,
  unbreakable: boolean,
  consecutiveDash: boolean,
  approx: boolean,
): Cost {
  let badness: number;
  if (ratio < (approx ? metrics.minApproxRatio : metrics.minRatio)) {
    badness = 1_000_000.0;
  } else if (breakpoint.kind !== 'mandatory' || justify || ratio < 0.0) {
    const a = Math.abs(ratio);
    badness = 100.0 * (a * a * a);
  } else {
    badness = 0.0;
  }

  let penalty = 0.0;

  if (unbreakable && breakpoint.kind === 'mandatory') {
    penalty += metrics.runtCost;
  }

  if (breakpoint.kind === 'hyphen') {
    const LIMIT = 5;
    const steps = Math.max(0, LIMIT - breakpoint.l) + Math.max(0, LIMIT - breakpoint.r);
    const extra = 0.15 * steps;
    penalty += (1.0 + extra) * metrics.hyphCost;
  }

  if (consecutiveDash) {
    penalty += metrics.hyphCost;
  }

  const t = 1.0 + badness + penalty;
  return t * t;
}

/** breakpoints(): all possible break opportunities, in order. */
export function breakpoints(
  p: Preparation,
  f: (end: number, breakpoint: Breakpoint) => void,
): void {
  const prim = primitives()!;
  const text = p.text;

  if (text.len === 0) {
    f(0, MANDATORY);
    return;
  }

  const hyphenate = p.config.hyphenate !== false;
  const lb = prim.lb;
  const cj = p.config.lang === 'zh' || p.config.lang === 'ja';
  const classes = prim.lbClasses(text.str);
  const points = prim.segment(text.str, cj);

  let last = 0;
  let iterIdx = 0;

  outer: while (true) {
    // Special case for links. head.endsWith('://') / tail.startsWith('www.')
    // over full-text slices, done without allocating the O(n) head/tail
    // strings: both probes are pure-ASCII, so a short byte-range slice
    // matches exactly when the original predicate does.
    if (
      (last >= 3 && text.slice(last - 3, last) === '://') ||
      text.slice(last, Math.min(text.len, last + 4)) === 'www.'
    ) {
      const tail = text.slice(last, text.len);
      const link = linkPrefix(tail);
      linebreakLink(link, (i) => f(last + i, NORMAL));
      last += utf8Len(link);
      while (iterIdx < points.length && points[iterIdx] < last) iterIdx++;
    }

    if (iterIdx >= points.length) break;
    const point = points[iterIdx++];

    // Skip breakpoint if there is no char before it.
    const c = text.charBefore(point);
    if (c === '') continue;

    let breakpoint: Breakpoint;
    if (point === text.len) {
      breakpoint = MANDATORY;
    } else {
      const cls = classes[text.cp(point - 1)];
      if (
        cls === lb.mandatoryBreak ||
        cls === lb.carriageReturn ||
        cls === lb.lineFeed ||
        cls === lb.nextLine
      ) {
        breakpoint = MANDATORY;
      } else if (cls === lb.space) {
        breakpoint = NORMAL;
      } else if (
        cls === lb.combiningMark &&
        text.slice(point, text.len).startsWith(OBJ_REPLACE) &&
        last + utf8Len(c) === point
      ) {
        continue outer;
      } else {
        breakpoint = NORMAL;
      }
    }

    // Hyphenate between the last and current breakpoint.
    if (hyphenate && last < point) {
      const between = text.slice(last, point);
      const bounds = prim.wordBounds(between);
      let segStart = 0;
      for (let bi = 0; bi < bounds.length; bi++) {
        const segEnd = bounds[bi];
        const segment = sliceBytes(between, segStart, segEnd);
        if (segment.length && allAlphabetic(segment)) {
          hyphenations(p, last, segment, f);
        }
        last += segEnd - segStart;
        segStart = segEnd;
      }
    }

    f(point, breakpoint);
    last = point;
  }
}

/** Slice a JS string by UTF-8 byte offsets (local, small strings). */
function sliceBytes(s: string, start: number, end: number): string {
  const bt = new ByteText(s);
  return bt.slice(start, end);
}

function allAlphabetic(s: string): boolean {
  for (const c of s) if (!/\p{Alphabetic}/u.test(c)) return false;
  return true;
}

/** hyphenations(): breakpoints within a word. */
function hyphenations(
  p: Preparation,
  offset: number,
  word: string,
  f: (end: number, breakpoint: Breakpoint) => void,
): void {
  const prim = primitives()!;
  const lang = langAt(p, offset);
  if (!lang) return;

  const count = charCount(word);
  const wordLen = utf8Len(word);
  const end = offset + wordLen;
  const syllables = prim.hyphenate(word, lang);
  if (syllables.length === 0) return;

  const lb = prim.lb;
  let chars = 0;
  let prevEnd = 0;
  for (let i = 0; i < syllables.length; i++) {
    const sylEnd = syllables[i];
    const syllable = sliceBytes(word, prevEnd, sylEnd);
    offset += sylEnd - prevEnd;
    chars += charCount(syllable);
    prevEnd = sylEnd;

    // Don't hyphenate after the final syllable.
    if (offset === end) continue;

    // Filter out hyphenation opportunities where hyphenation was disabled.
    if (!hyphenateAt(p, offset)) continue;

    // Filter out forbidden hyphenation opportunities.
    const lastChar = syllable.length
      ? String.fromCodePoint(
          syllable.codePointAt(
            syllable.length >= 2 && /[\uDC00-\uDFFF]/.test(syllable[syllable.length - 1])
              ? syllable.length - 2
              : syllable.length - 1,
          )!,
        )
      : '';
    if (lastChar) {
      const cls = prim.lbClasses(lastChar)[0];
      if (cls === lb.glue || cls === lb.wordJoiner || cls === lb.zwj) continue;
    }

    const l = Math.min(chars, 255);
    const r = Math.min(count - chars, 255);
    f(offset, { kind: 'hyphen', l, r });
  }
}

/** hyphenate_at: whether hyphenation is enabled at the given offset. */
function hyphenateAt(p: Preparation, offset: number): boolean {
  if (p.config.hyphenate !== undefined) return p.config.hyphenate;
  const item = p.get(offset);
  // TextElem::hyphenate default is auto → justify.
  return item?.kind === 'text' ? p.config.justify : false;
}

/** lang_at: the text language at the given offset. */
function langAt(p: Preparation, _offset: number): string | null {
  return p.config.lang || null;
}

/** link_prefix (typst-syntax lexer.rs) — ASCII scanning. */
export function linkPrefix(text: string): string {
  const brackets: string[] = [];
  let i = 0;
  scan: while (i < text.length) {
    const ch = text[i];
    if (/[0-9a-zA-Z!#$%&*+,\-./:;=?@_~']/.test(ch)) {
      i++;
      continue;
    }
    switch (ch) {
      case '[':
        brackets.push('[');
        i++;
        continue;
      case '(':
        brackets.push('(');
        i++;
        continue;
      case ']':
        if (brackets.pop() === '[') {
          i++;
          continue;
        }
        break scan;
      case ')':
        if (brackets.pop() === '(') {
          i++;
          continue;
        }
        break scan;
      default:
        break scan;
    }
  }
  // Don't include trailing characters likely to be part of text.
  while (i > 0 && /[!,.:;?']/.test(text[i - 1])) i--;
  return text.slice(0, i);
}

/** linebreak_link: break opportunities within a link. */
function linebreakLink(link: string, f: (offset: number) => void): void {
  type Class = 'alpha' | 'digit' | 'open' | 'other';
  const classOf = (c: string): Class =>
    /\p{Alphabetic}/u.test(c)
      ? 'alpha'
      : /\p{Nd}|\p{Nl}|\p{No}/u.test(c)
        ? 'digit'
        : c === '(' || c === '['
          ? 'open'
          : 'other';

  let offset = 0;
  let prev: Class = 'other';
  let end = 0;

  for (const c of link) {
    const cls = classOf(c);
    if (
      end > 0 &&
      prev !== 'open' &&
      (cls === 'other' ? prev === 'other' : cls !== prev)
    ) {
      // piece = link[offset..end] (byte offsets; end = current char start).
      const pieceLen = end - offset;
      if (pieceLen < 16) {
        offset = end;
        f(offset);
      } else {
        const inner = byteSlice(link, offset, end);
        for (const pc of inner) {
          offset += utf8Len(pc);
          f(offset);
        }
      }
    }
    prev = cls;
    end += utf8Len(c);
  }
}

function byteSlice(s: string, start: number, end: number): string {
  return new ByteText(s).slice(start, end);
}

/** CostMetrics. */
interface CostMetrics {
  minRatio: number;
  minApproxRatio: number;
  approxHyphenWidth: number;
  hyphCost: Cost;
  runtCost: Cost;
}

function computeCostMetrics(p: Preparation): CostMetrics {
  return {
    minRatio: p.config.justify ? MIN_RATIO : 0.0,
    minApproxRatio: p.config.justify ? MIN_APPROX_RATIO : 0.0,
    // Em::new(0.33).at(font_size)
    approxHyphenWidth: 0.33 * p.config.fontSize,
    hyphCost: DEFAULT_HYPH_COST * p.config.costs.hyphenation,
    runtCost: DEFAULT_RUNT_COST * p.config.costs.runt,
  };
}

/** CumulativeVec. */
class CumulativeVec {
  total = 0;
  summed: number[] = [0];

  adjust(len: number): void {
    if (this.summed.length > len) this.summed.length = len;
    else while (this.summed.length < len) this.summed.push(this.total);
  }

  push(byteLen: number, metric: number): void {
    this.total = this.total + metric;
    for (let i = 0; i < byteLen; i++) this.summed.push(this.total);
  }

  estimate(start: number, end: number): number {
    return this.get(end) - this.get(start);
  }

  get(index: number): number {
    return index === 0 ? 0 : this.summed[index - 1];
  }
}

interface Estimates {
  widths: CumulativeVec;
  stretchability: CumulativeVec;
  shrinkability: CumulativeVec;
  justifiables: CumulativeVec;
}

/** Estimates::compute. */
function computeEstimates(p: Preparation): Estimates {
  const widths = new CumulativeVec();
  const stretchability = new CumulativeVec();
  const shrinkability = new CumulativeVec();
  const justifiables = new CumulativeVec();

  for (const [rangeStart, rangeEnd, item] of p.items) {
    void rangeStart;
    if (item.kind === 'text') {
      const glyphs = item.shaped.glyphs;
      for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs.at(i);
        const byteLen = g.rangeEnd - g.rangeStart;
        const stretch = g.adjustability.stretchability[0] + g.adjustability.stretchability[1];
        const shrink = g.adjustability.shrinkability[0] + g.adjustability.shrinkability[1];
        widths.push(byteLen, g.xAdvance * g.size);
        stretchability.push(byteLen, stretch * g.size);
        shrinkability.push(byteLen, shrink * g.size);
        justifiables.push(byteLen, g.isJustifiable ? 1 : 0);
      }
    } else {
      widths.push(rangeEnd - rangeStart, itemNaturalWidth(item));
    }
    widths.adjust(rangeEnd);
    stretchability.adjust(rangeEnd);
    shrinkability.adjust(rangeEnd);
    justifiables.adjust(rangeEnd);
  }

  return { widths, stretchability, shrinkability, justifiables };
}

