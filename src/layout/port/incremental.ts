// Incremental line-break search for the ported Typst breaker.
//
// Why not resume the DP itself: Typst's optimized search is two passes.
// The approximate pass produces a paragraph-global exact-cost upper bound
// (from a whole-paragraph retrace), and the bounded pass's pruning, its
// per-breakpoint lower-bound skips, and its `active`-window advancement
// all compare against that bound and against float-accumulated totals.
// After any edit the bound and the totals change, so cached DP states —
// prefix tables as much as reconverged suffixes — can steer pruning and
// equal-total tie-breaks differently at knife edges. Splicing them back in
// cannot be proven bit-identical to a from-scratch run.
//
// What is provably reusable is line construction. line(p, start, end, bp,
// pred) is a pure function of the text, the shaped items it slices, the
// breakpoint kind, and the config (pred only feeds hyphen repetition for
// a handful of languages, none of them 'en', and the CJ boundary paths
// that mutate shared glyphs are excluded by eligibility). So each run
// re-executes BOTH passes of the exact DP — identical costs, identical
// pruning, identical tie-breaks, identical result by construction — but
// serves Line objects from the previous run wherever a byte-range lies
// entirely inside a region whose text AND shaped glyph values are verified
// equal (offset-mapped) between the runs. Line construction is what made
// the search O(paragraph) per candidate; the remaining DP arithmetic is a
// few float ops per candidate.
//
// Fail-open: any doubt — config change, non-'en' lang, CJ-capable glyphs,
// oversized text, unmatched cache, byte ranges outside the verified
// window, breakpoint mismatch — builds the line (or the whole run) from
// scratch. A from-scratch run through this module is the same linebreak()
// the differ and tests call.

import {
  cjMutationCount,
  linebreak,
  type Breakpoint,
  type Line,
  type LinebreakSession,
} from './linebreak';
import type { Item, Preparation } from './prepare';
import { isCjScript, isCjkPunctuation, type ShapedGlyph, type ShapedText } from './shaping';

const MAX_ENTRIES = 4;
const MAX_LINES_PER_ENTRY = 50000;
/** Memory bound across all cached runs: cached Lines mostly share glyph
 * slices with their run's Preparation, so the retained size is a small
 * multiple of the cached paragraphs' shaped text. */
const MAX_LINES_TOTAL = 80000;
/** Byte offsets must pack into the numeric line key. */
const MAX_TEXT_BYTES = 1 << 20;

interface CachedLine {
  bp: Breakpoint;
  line: Line;
}

interface RunEntry {
  configSig: string;
  prep: Preparation;
  map: Map<number, CachedLine>;
}

/** The verified reuse window between the cached run and the current one.
 * A line [start, end) may be served when end <= prefixEnd (identity
 * offsets) or start >= suffixStart (old offsets = new - delta). */
interface ReuseWindow {
  prefixEnd: number;
  suffixStart: number;
  delta: number;
}

const entries: RunEntry[] = [];
let enabled = true;

export interface IncrementalStats {
  /** Runs routed through this module. */
  runs: number;
  /** Runs that were eligible and had a matched previous run to serve from. */
  cachedRuns: number;
  /** Runs that were ineligible or unmatched (plain from-scratch). */
  uncachedRuns: number;
  /** Lines built by line() inside cache-active runs. */
  linesBuilt: number;
  /** Lines served from the previous run's cache. */
  linesServed: number;
  /** Runs discarded because the CJ-mutation tripwire fired (guard gap). */
  taints: number;
}

const stats: IncrementalStats = {
  runs: 0,
  cachedRuns: 0,
  uncachedRuns: 0,
  linesBuilt: 0,
  linesServed: 0,
  taints: 0,
};

export function incrementalLinebreakStats(reset = false): IncrementalStats {
  const out = { ...stats };
  if (reset) {
    stats.runs = 0;
    stats.cachedRuns = 0;
    stats.uncachedRuns = 0;
    stats.linesBuilt = 0;
    stats.linesServed = 0;
    stats.taints = 0;
  }
  return out;
}

/** Test/AB hook: toggle the cache (true also re-arms after a tripwire). */
export function setIncrementalLinebreak(on: boolean): void {
  enabled = on;
  if (!on) entries.length = 0;
}

/** Test hook: drop all cached runs. */
export function clearIncrementalLinebreak(): void {
  entries.length = 0;
}

/**
 * linebreak() with cross-run line reuse. Returns null when the run must be
 * discarded (CJ tripwire fired after lines were served): the caller owns
 * re-preparing the paragraph — the shared glyphs were mutated — and
 * falling back to a plain linebreak().
 */
export function linebreakIncremental(p: Preparation, width: number): Line[] | null {
  stats.runs++;
  if (
    !enabled ||
    p.config.linebreaks !== 'optimized' ||
    p.config.lang !== 'en' ||
    p.text.len >= MAX_TEXT_BYTES ||
    !mutationSafe(p)
  ) {
    stats.uncachedRuns++;
    return linebreak(p, width);
  }

  const configSig = sigOf(p);
  const old = matchEntry(configSig, p.text.str);
  const win = old ? computeReuseWindow(old.prep, p) : null;
  if (old && win) stats.cachedRuns++;
  else stats.uncachedRuns++;

  const map = new Map<number, CachedLine>();
  let served = 0;

  const put = (start: number, end: number, bp: Breakpoint, line: Line) => {
    if (map.size >= MAX_LINES_PER_ENTRY) return;
    map.set(lineKey(start, end, bp), { bp, line });
  };

  const session: LinebreakSession = {
    serve(start, end, bp) {
      if (!old || !win) return null;
      let os: number;
      let oe: number;
      if (end <= win.prefixEnd) {
        os = start;
        oe = end;
      } else if (start >= win.suffixStart) {
        os = start - win.delta;
        oe = end - win.delta;
      } else {
        return null;
      }
      if (os < 0 || oe < os) return null;
      const hit = old.map.get(lineKey(os, oe, bp));
      if (!hit) return null;
      const hb = hit.bp;
      if (hb.kind !== bp.kind) return null;
      if (bp.kind === 'hyphen' && hb.kind === 'hyphen' && (bp.l !== hb.l || bp.r !== hb.r)) {
        return null;
      }
      // Prefix serves keep the identical end offset and breakpoint values;
      // the Line is immutable after construction, so the object itself can
      // flow into this run. Suffix serves remap the end offset via a copy.
      const ln = hit.line.endByte === end ? hit.line : hit.line.cloneAt(end, bp);
      put(start, end, bp, ln);
      served++;
      stats.linesServed++;
      return ln;
    },
    record(start, end, bp, line) {
      stats.linesBuilt++;
      put(start, end, bp, line);
    },
  };

  const mutationsBefore = cjMutationCount();
  const lines = linebreak(p, width, session);
  if (cjMutationCount() !== mutationsBefore) {
    // A CJ boundary adjustment mutated shared glyphs despite the
    // eligibility scan. Disable the whole mechanism (the scan has a gap)
    // and discard anything that depended on served lines.
    stats.taints++;
    enabled = false;
    entries.length = 0;
    return served > 0 ? null : lines;
  }

  if (old) {
    const idx = entries.indexOf(old);
    if (idx >= 0) entries.splice(idx, 1);
  }
  entries.push({ configSig, prep: p, map });
  while (entries.length > MAX_ENTRIES) entries.shift();
  let totalLines = 0;
  for (const e of entries) totalLines += e.map.size;
  while (entries.length > 1 && totalLines > MAX_LINES_TOTAL) {
    totalLines -= entries[0].map.size;
    entries.shift();
  }
  return lines;
}

const lineKey = (start: number, end: number, bp: Breakpoint): number =>
  (start * 0x100000 + end) * 4 + (bp.kind === 'normal' ? 0 : bp.kind === 'mandatory' ? 1 : 2);

function sigOf(p: Preparation): string {
  const c = p.config;
  return [
    c.justify,
    c.linebreaks,
    c.fontSize,
    c.lang,
    c.hyphenate,
    c.costs.hyphenation,
    c.costs.runt,
    c.firstLineIndent,
    c.hangingIndent,
    c.fallback,
    c.cjkLatinSpacing,
  ].join('|');
}

/**
 * Only paragraphs where adjust_cj_at_line_boundaries cannot mutate glyphs
 * shared with the Preparation are cacheable: those mutations make line()
 * order-dependent across the whole run. Glyphs created fresh inside a
 * line (reshapes) are line-local and stay pure; the shared ones are
 * exactly the prepared items' glyphs scanned here. The branches require
 * either a CJ-script cluster char or a CJK-classified punctuation glyph
 * with nonzero shrink — both directly observable on the shaped glyphs.
 */
function mutationSafe(p: Preparation): boolean {
  for (const [, , item] of p.items) {
    if (item.kind !== 'text') continue;
    const glyphs = item.shaped.glyphs;
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs.at(i);
      const cp = g.c.codePointAt(0) ?? 0;
      // Every trigger char (CJ scripts, CJK punctuation incl. U+00B7) is
      // >= U+00B7; plain Latin prose short-circuits here.
      if (cp < 0xb7) continue;
      if (isCjScript(g.c)) return false;
      if (
        isCjkPunctuation(g) &&
        (g.adjustability.shrinkability[0] > 0 || g.adjustability.shrinkability[1] > 0)
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Pick the cached run with the longest common affix with `text`. */
function matchEntry(configSig: string, text: string): RunEntry | null {
  let best: RunEntry | null = null;
  let bestScore = -1;
  for (const entry of entries) {
    if (entry.configSig !== configSig) continue;
    const oldText = entry.prep.text.str;
    const max = Math.min(oldText.length, text.length);
    let p = 0;
    while (p < max && oldText.charCodeAt(p) === text.charCodeAt(p)) p++;
    let s = 0;
    while (
      s < max - p &&
      oldText.charCodeAt(oldText.length - 1 - s) === text.charCodeAt(text.length - 1 - s)
    ) {
      s++;
    }
    const score = p + s;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

// --- reuse-window verification ------------------------------------------
//
// The window is computed by direct value comparison, never by assuming
// shaping locality: a byte region is reusable only when the covering
// items agree in kind, style, font size, text, and every shaped glyph
// field (offset-shifted on the suffix side). Within the first/last
// diverging text item the window extends glyph-by-glyph, stopping
// strictly before the first diverging glyph so that find_safe_to_break's
// boundary lookups (glyph-at-offset, previous-glyph range equality, and
// the item-start/item-end shortcuts) resolve identically in both runs.

function computeReuseWindow(oldPrep: Preparation, newPrep: Preparation): ReuseWindow | null {
  const delta = newPrep.text.len - oldPrep.text.len;
  const oldItems = oldPrep.items;
  const newItems = newPrep.items;
  const shared = Math.min(oldItems.length, newItems.length);

  // Prefix: whole identical items, then a glyph-wise extension.
  let prefixEnd = 0;
  let i = 0;
  while (i < shared && identicalItem(oldPrep, newPrep, oldItems[i], newItems[i], 0)) {
    prefixEnd = newItems[i][1];
    i++;
  }
  if (i < shared) {
    const ext = prefixExtension(oldPrep, newPrep, oldItems[i], newItems[i]);
    if (ext > prefixEnd) prefixEnd = ext;
  }

  // Suffix: whole identical items from the tail, then a glyph-wise
  // extension into the diverging pair.
  let suffixStart = newPrep.text.len;
  let j = 1;
  while (
    j <= shared &&
    identicalItem(
      oldPrep,
      newPrep,
      oldItems[oldItems.length - j],
      newItems[newItems.length - j],
      delta,
    )
  ) {
    suffixStart = newItems[newItems.length - j][0];
    j++;
  }
  if (j <= shared) {
    const ext = suffixExtension(
      oldPrep,
      newPrep,
      oldItems[oldItems.length - j],
      newItems[newItems.length - j],
      delta,
    );
    if (ext < suffixStart) suffixStart = ext;
  }

  if (prefixEnd <= 0 && suffixStart >= newPrep.text.len) return null;
  return { prefixEnd, suffixStart, delta };
}

type PrepItem = [number, number, Item];

function identicalItem(
  oldPrep: Preparation,
  newPrep: Preparation,
  o: PrepItem,
  n: PrepItem,
  shift: number,
): boolean {
  const [os, oe, oi] = o;
  const [ns, ne, ni] = n;
  if (ns !== os + shift || ne !== oe + shift) return false;
  if (oi.kind !== ni.kind) return false;
  switch (oi.kind) {
    case 'absolute':
      return ni.kind === 'absolute' && oi.width === ni.width && oi.weak === ni.weak;
    case 'frame':
      return ni.kind === 'frame' && oi.width === ni.width;
    case 'skip':
      return true;
    case 'text': {
      if (ni.kind !== 'text') return false;
      const a = oi.shaped;
      const b = ni.shaped;
      if (!sameTextRun(oldPrep, newPrep, os, ns, a, b)) return false;
      if (a.text !== b.text) return false;
      const ga = a.glyphs;
      const gb = b.glyphs;
      if (ga.length !== gb.length) return false;
      for (let k = 0; k < ga.length; k++) {
        if (!glyphEq(ga.at(k), gb.at(k), shift)) return false;
      }
      return true;
    }
  }
}

function sameTextRun(
  oldPrep: Preparation,
  newPrep: Preparation,
  os: number,
  ns: number,
  a: ShapedText,
  b: ShapedText,
): boolean {
  return (
    a.styleKey === b.styleKey &&
    a.lang === b.lang &&
    a.fallbackSize === b.fallbackSize &&
    oldPrep.shapeConfig(os).fontSize === newPrep.shapeConfig(ns).fontSize
  );
}

function glyphEq(a: ShapedGlyph, b: ShapedGlyph, shift: number): boolean {
  return (
    a.glyphId === b.glyphId &&
    a.fontKey === b.fontKey &&
    a.xAdvance === b.xAdvance &&
    a.xOffset === b.xOffset &&
    a.size === b.size &&
    a.safeToBreak === b.safeToBreak &&
    a.c === b.c &&
    a.isJustifiable === b.isJustifiable &&
    b.rangeStart === a.rangeStart + shift &&
    b.rangeEnd === a.rangeEnd + shift &&
    a.adjustability.stretchability[0] === b.adjustability.stretchability[0] &&
    a.adjustability.stretchability[1] === b.adjustability.stretchability[1] &&
    a.adjustability.shrinkability[0] === b.adjustability.shrinkability[0] &&
    a.adjustability.shrinkability[1] === b.adjustability.shrinkability[1]
  );
}

/**
 * Largest byte offset E such that any line end e <= E resolves
 * identically inside the diverging item pair: strictly before both first
 * diverging glyphs (so offset->glyph lookups only touch verified glyphs
 * and never the diverging items' end-of-item shortcut) and within the
 * common text prefix. Returns 0 when the pair is not comparable.
 */
function prefixExtension(
  oldPrep: Preparation,
  newPrep: Preparation,
  o: PrepItem,
  n: PrepItem,
): number {
  const [os, , oi] = o;
  const [ns, , ni] = n;
  if (oi.kind !== 'text' || ni.kind !== 'text') return 0;
  if (os !== ns) return 0;
  const a = oi.shaped;
  const b = ni.shaped;
  if (!sameTextRun(oldPrep, newPrep, os, ns, a, b)) return 0;

  const ga = a.glyphs;
  const gb = b.glyphs;
  const max = Math.min(ga.length, gb.length);
  let m = 0;
  while (m < max && glyphEq(ga.at(m), gb.at(m), 0)) m++;
  const capO = m < ga.length ? ga.at(m).rangeStart : o[1];
  const capN = m < gb.length ? gb.at(m).rangeStart : n[1];

  // Common text prefix in bytes (absolute offset os + bytes).
  const ta = a.text;
  const tb = b.text;
  const tmax = Math.min(ta.length, tb.length);
  let bytes = 0;
  for (let k = 0; k < tmax; ) {
    const cp = ta.codePointAt(k)!;
    if (cp !== tb.codePointAt(k)) break;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    k += cp > 0xffff ? 2 : 1;
  }
  const textCap = os + bytes;

  return Math.min(capO - 1, capN - 1, textCap);
}

/**
 * Smallest byte offset S (new coordinates) such that any line start
 * s >= S resolves identically inside the diverging item pair: strictly
 * after both last diverging glyphs (equality allowed only when the two
 * diverging glyph ends coincide offset-shifted, so the previous-glyph
 * range-equality probe answers the same on both sides) and within the
 * common text suffix. Returns text.len when the pair is not comparable.
 */
function suffixExtension(
  oldPrep: Preparation,
  newPrep: Preparation,
  o: PrepItem,
  n: PrepItem,
  delta: number,
): number {
  const none = newPrep.text.len;
  const [os, oe, oi] = o;
  const [ns, ne, ni] = n;
  if (oi.kind !== 'text' || ni.kind !== 'text') return none;
  if (ne !== oe + delta) return none;
  const a = oi.shaped;
  const b = ni.shaped;
  if (!sameTextRun(oldPrep, newPrep, os, ns, a, b)) return none;

  const ga = a.glyphs;
  const gb = b.glyphs;
  const max = Math.min(ga.length, gb.length);
  let m = 0;
  while (m < max && glyphEq(ga.at(ga.length - 1 - m), gb.at(gb.length - 1 - m), delta)) m++;
  const oExhausted = m >= ga.length;
  const nExhausted = m >= gb.length;
  const capO = oExhausted ? os + delta : ga.at(ga.length - 1 - m).rangeEnd + delta;
  const capN = nExhausted ? ns : gb.at(gb.length - 1 - m).rangeEnd;
  const glyphCap = capO === capN && oExhausted === nExhausted ? capN : Math.max(capO, capN) + 1;

  // Common text suffix in bytes (absolute new offset ne - bytes).
  const ta = a.text;
  const tb = b.text;
  const tmax = Math.min(ta.length, tb.length);
  let units = 0;
  while (
    units < tmax &&
    ta.charCodeAt(ta.length - 1 - units) === tb.charCodeAt(tb.length - 1 - units)
  ) {
    units++;
  }
  // Don't start the suffix on an orphaned low surrogate.
  while (units > 0) {
    const u = tb.charCodeAt(tb.length - units);
    if (u >= 0xdc00 && u <= 0xdfff) units--;
    else break;
  }
  let bytes = 0;
  for (let k = tb.length - units; k < tb.length; ) {
    const cp = tb.codePointAt(k)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    k += cp > 0xffff ? 2 : 1;
  }
  const textCap = ne - bytes;

  return Math.max(glyphCap, textCap);
}

// DEV diagnostics.
if (typeof window !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (
    window as unknown as {
      __portIncrementalStats: (reset?: boolean) => IncrementalStats;
      __portIncremental: (on?: boolean) => boolean;
    }
  ).__portIncrementalStats = (reset = false) => incrementalLinebreakStats(reset);
  (
    window as unknown as { __portIncremental: (on?: boolean) => boolean }
  ).__portIncremental = (on?: boolean) => {
    if (on !== undefined) setIncrementalLinebreak(on);
    return enabled;
  };
}
