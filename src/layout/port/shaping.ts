// Mirror of crates/typst-layout/src/inline/shaping.rs (typst 951788cc),
// restricted to the editor's reality: LTR text, lang "en", default text
// styles (tracking 0, spacing 100%, kerning/ligature defaults → empty
// feature list), single body font per run. Structure and math follow the
// Rust line-for-line; CJK-specific paths are ported where they affect
// metrics and no-op on Latin text.
//
// Units: Em values are raw f64 em (Rust Em), Abs values are raw f64 pt
// (Rust Abs). Glyph advances are `units / upem`, the same f64 division as
// Font::to_em.

import { primitives } from '../primitives';
import { ByteText, utf8Len } from './bytes';

export const SHY = '\u00AD';
export const HYPHEN = '-';

/** Adjustability of a glyph: [left, right] stretch/shrink in Em. */
export interface Adjustability {
  stretchability: [number, number];
  shrinkability: [number, number];
}

const defaultAdjustability = (): Adjustability => ({
  stretchability: [0, 0],
  shrinkability: [0, 0],
});

/** Mirror of ShapedGlyph (fields the metrics read). */
export interface ShapedGlyph {
  fontKey: string;
  glyphId: number;
  /** Advance in Em. */
  xAdvance: number;
  xOffset: number;
  /** Font size in pt (Abs). */
  size: number;
  adjustability: Adjustability;
  /** Byte range in the full paragraph text. */
  rangeStart: number;
  rangeEnd: number;
  safeToBreak: boolean;
  /** First char of the cluster. */
  c: string;
  isJustifiable: boolean;
}

/** Mirror of Glyphs: a slice with a kept (untrimmed) subrange. */
export class Glyphs {
  inner: ShapedGlyph[];
  keptStart: number;
  keptEnd: number;

  constructor(glyphs: ShapedGlyph[]) {
    this.inner = glyphs;
    this.keptStart = 0;
    this.keptEnd = glyphs.length;
  }

  /** The kept glyphs (the deref view). */
  get list(): ShapedGlyph[] {
    return this.inner.slice(this.keptStart, this.keptEnd);
  }

  get length(): number {
    return this.keptEnd - this.keptStart;
  }

  at(i: number): ShapedGlyph {
    return this.inner[this.keptStart + i];
  }

  first(): ShapedGlyph | undefined {
    return this.length > 0 ? this.inner[this.keptStart] : undefined;
  }

  last(): ShapedGlyph | undefined {
    return this.length > 0 ? this.inner[this.keptEnd - 1] : undefined;
  }

  /** Mirror of Glyphs::trim — hide matching glyphs at both edges. */
  trim(f: (g: ShapedGlyph) => boolean): void {
    let start = this.keptStart;
    let end = this.keptEnd;
    while (start < end && f(this.inner[start])) start++;
    while (end > start && f(this.inner[end - 1])) end--;
    this.keptStart = start;
    this.keptEnd = end;
  }

  isFullyEmpty(): boolean {
    return this.inner.length === 0;
  }
}

/** Mirror of ShapedText (metrics-relevant fields). */
export class ShapedText {
  base: number;
  text: string;
  /** Byte length of `text`. */
  textLen: number;
  lang: string;
  styleKey: string;
  glyphs: Glyphs;

  constructor(base: number, text: string, lang: string, styleKey: string, glyphs: Glyphs) {
    this.base = base;
    this.text = text;
    this.textLen = utf8Len(text);
    this.lang = lang;
    this.styleKey = styleKey;
    this.glyphs = glyphs;
  }

  /** Σ x_advance.at(size) over kept glyphs. */
  width(): number {
    let w = 0;
    for (let i = 0; i < this.glyphs.length; i++) {
      const g = this.glyphs.at(i);
      w += g.xAdvance * g.size;
    }
    return w;
  }

  justifiables(): number {
    let n = 0;
    for (let i = 0; i < this.glyphs.length; i++) if (this.glyphs.at(i).isJustifiable) n++;
    return n;
  }

  cjkJustifiableAtLast(): boolean {
    const g = this.glyphs.last();
    return g ? isCjScript(g.c) || isCjkPunctuation(g) : false;
  }

  stretchability(): number {
    let s = 0;
    for (let i = 0; i < this.glyphs.length; i++) {
      const g = this.glyphs.at(i);
      s += (g.adjustability.stretchability[0] + g.adjustability.stretchability[1]) * g.size;
    }
    return s;
  }

  shrinkability(): number {
    let s = 0;
    for (let i = 0; i < this.glyphs.length; i++) {
      const g = this.glyphs.at(i);
      s += (g.adjustability.shrinkability[0] + g.adjustability.shrinkability[1]) * g.size;
    }
    return s;
  }

  /** Mirror of ShapedText::reshape: slice if safe-to-break, else reshape
   * the subrange from scratch. `full` is the paragraph ByteText. */
  reshape(full: ByteText, rangeStart: number, rangeEnd: number, config: ShapeConfig): ShapedText {
    const text = full.slice(rangeStart, rangeEnd);
    const sliced = this.sliceSafeToBreak(rangeStart, rangeEnd);
    if (sliced) {
      return new ShapedText(rangeStart, text, this.lang, this.styleKey, new Glyphs(sliced));
    }
    return shape(rangeStart, text, this.styleKey, config);
  }

  /** Mirror of ShapedText::empty. */
  empty(): ShapedText {
    return new ShapedText(this.base, '', this.lang, this.styleKey, new Glyphs([]));
  }

  /** Mirror of slice_safe_to_break (LTR only). */
  private sliceSafeToBreak(start: number, end: number): ShapedGlyph[] | null {
    const left = this.findSafeToBreak(start);
    if (left === null) return null;
    const right = this.findSafeToBreak(end);
    if (right === null) return null;
    // this.glyphs.list.slice(left, right) without materializing the full
    // kept-view copy first (left/right are kept-view indices ≤ length).
    const g = this.glyphs;
    return g.inner.slice(g.keptStart + left, g.keptStart + right);
  }

  /** Mirror of find_safe_to_break (LTR only). */
  private findSafeToBreak(textIndex: number): number | null {
    const glyphs = this.glyphs;
    const len = glyphs.length;
    if (textIndex === this.base) return 0;
    if (textIndex === this.base + this.textLen) return len;

    // Binary search for any glyph with range.start == textIndex.
    let lo = 0;
    let hi = len;
    let found = -1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const s = glyphs.at(mid).rangeStart;
      if (s === textIndex) {
        found = mid;
        break;
      } else if (s < textIndex) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    let idx: number;
    if (found >= 0) {
      idx = found;
    } else {
      // Break before '\n' special case (Err branch): insertion point is lo.
      const i = lo;
      const prev = i > 0 ? glyphs.at(i - 1) : undefined;
      const relative = textIndex - this.base;
      if (prev && prev.rangeEnd === textIndex && this.text.startsWith('\n', byteToJsIndex(this.text, relative))) {
        return i;
      }
      return null;
    }

    // Move to the start-most glyph with this text index.
    while (idx > 0 && glyphs.at(idx - 1).rangeStart === textIndex) idx--;

    return glyphs.at(idx).safeToBreak ? idx : null;
  }

  /** Mirror of ShapedText::hyphen — a shaped '-' in the run's font. */
  static hyphen(base: ShapedText, pos: number, soft: boolean): ShapedText | null {
    const prim = primitives();
    if (!prim) return null;
    const glyphId = prim.glyphIndex(base.styleKey, '-');
    if (glyphId === 0) return null;
    const advance = prim.glyphAdvance(base.styleKey, glyphId);
    const upem = prim.upem(base.styleKey);
    const xAdvance = advance / upem;
    const size = base.glyphs.first()?.size ?? base.fallbackSize;
    const [c, text] = soft ? [SHY, SHY] : [HYPHEN, HYPHEN];
    const g: ShapedGlyph = {
      fontKey: base.styleKey,
      glyphId,
      xAdvance,
      xOffset: 0,
      size,
      adjustability: defaultAdjustability(),
      rangeStart: pos,
      rangeEnd: pos + utf8Len(text),
      safeToBreak: true,
      c,
      isJustifiable: false,
    };
    return new ShapedText(pos, text, base.lang, base.styleKey, new Glyphs([g]));
  }

  /** Font size to use when the run has no glyphs (empty-run hyphen). */
  fallbackSize = 0;
}

/** What shape() needs to know about the paragraph's styling. */
export interface ShapeConfig {
  /** Font size in pt for this run (Abs). */
  fontSize: number;
  lang: string;
  /** justification-limits — Typst defaults unless overridden. */
  spacingLimits?: { min: number; max: number };
}

// Limits::SPACING_DEFAULT (par.rs): min = Ratio(2.0/3.0), max = Ratio(1.5).
const SPACING_MIN_DEFAULT = 2.0 / 3.0;
const SPACING_MAX_DEFAULT = 1.5;

/** Mirror of shape(): shape a run, then track_and_space and
 * calculate_adjustability. `styleKey` selects the sidecar font. */
export function shape(base: number, text: string, styleKey: string, config: ShapeConfig): ShapedText {
  const prim = primitives();
  if (!prim) throw new Error('primitives not loaded');

  const glyphs: ShapedGlyph[] = [];
  // shape_segment guard: don't shape newlines, tabs, or default ignorables.
  if (text.length && !allSkippable(text)) {
    const raw = prim.shape(styleKey, text, { lang: config.lang });
    const bt = new ByteText(text);
    for (let i = 0; i < raw.length; i++) {
      const info = raw[i];
      // Tofu handling (glyph_id 0): Typst recurses into fallback fonts; the
      // editor's font covers its corpus, so we keep the notdef glyph as-is.
      // The differ flags any document where this matters.
      const cluster = info.cluster;
      // End of this glyph's text range: next differing cluster (LTR).
      let k = i;
      let end = base + bt.len;
      while (k + 1 < raw.length) {
        if (raw[k + 1].cluster !== info.cluster) {
          end = base + raw[k + 1].cluster;
          break;
        }
        k++;
      }
      const c = bt.charAt(cluster);
      const xAdvance = info.xAdvance / prim.upem(styleKey);
      glyphs.push({
        fontKey: styleKey,
        glyphId: info.glyphId,
        xAdvance,
        xOffset: info.xOffset / prim.upem(styleKey),
        size: config.fontSize,
        adjustability: defaultAdjustability(),
        rangeStart: base + cluster,
        rangeEnd: end,
        safeToBreak: info.safeToBreak,
        c,
        isJustifiable: isJustifiable(c, xAdvance, [0, 0]),
      });
    }
  }

  trackAndSpace(glyphs, styleKey);
  calculateAdjustability(glyphs, config);

  const st = new ShapedText(base, text, config.lang, styleKey, new Glyphs(glyphs));
  st.fallbackSize = config.fontSize;
  return st;
}

function allSkippable(text: string): boolean {
  for (const c of text) {
    if (c !== '\n' && c !== '\t' && !isDefaultIgnorable(c)) return false;
  }
  return true;
}

/** Unicode Default_Ignorable_Code_Point (typst_library::text::is_default_ignorable). */
export function isDefaultIgnorable(c: string): boolean {
  return /\p{Default_Ignorable_Code_Point}/u.test(c);
}

/** Mirror of track_and_space with default styles (tracking 0, spacing
 * 100%): only the NBSP width normalization has an effect. */
function trackAndSpace(glyphs: ShapedGlyph[], styleKey: string): void {
  const prim = primitives()!;
  for (const g of glyphs) {
    if (g.c === '\u00A0') {
      const space = prim.glyphIndex(styleKey, ' ');
      const nbsp = prim.glyphIndex(styleKey, '\u00A0');
      if (space !== 0 && nbsp !== 0) {
        const upem = prim.upem(styleKey);
        const delta = prim.glyphAdvance(styleKey, nbsp) / upem - prim.glyphAdvance(styleKey, space) / upem;
        g.xAdvance -= delta;
      }
    }
    // spacing 100% → x_advance = 1.0·x_advance + 0 (identity in IEEE 754);
    // tracking 0 → no addition.
  }
}

/** Mirror of calculate_adjustability (GB punct style for en; the CJK
 * consecutive-punctuation pass is ported and no-ops on Latin). */
function calculateAdjustability(glyphs: ShapedGlyph[], config: ShapeConfig): void {
  const limits = config.spacingLimits ?? { min: SPACING_MIN_DEFAULT, max: SPACING_MAX_DEFAULT };
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    const next = glyphs[i + 1];
    const stretchable = !next || g.rangeStart !== next.rangeStart;
    g.adjustability = baseAdjustability(g, limits, stretchable);
  }

  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    const next = glyphs[i + 1];
    if (!next) continue;
    const delta = g.xAdvance / 2.0;
    if (
      isCjkPunctuation(g) &&
      isCjkPunctuation(next) &&
      g.adjustability.shrinkability[1] + next.adjustability.shrinkability[0] >= delta
    ) {
      const leftDelta = Math.min(g.adjustability.shrinkability[1], delta);
      shrinkRight(g, leftDelta);
      shrinkLeft(next, delta - leftDelta);
    }
  }
}

/** Mirror of ShapedGlyph::base_adjustability with default tracking limits
 * (0, 0): only spaces and CJK punctuation have adjustability. */
function baseAdjustability(
  g: ShapedGlyph,
  limits: { min: number; max: number },
  _stretchable: boolean,
): Adjustability {
  const width = g.xAdvance;
  const limited = (v: number) => Math.min(v, width * 0.75);

  if (isSpace(g.c)) {
    // Tracking limits default to 0, so max/min are the spacing ratios alone.
    return {
      stretchability: [0, Math.max((limits.max - 1.0) * width, 0)],
      shrinkability: [0, limited((1.0 - limits.min) * width)],
    };
  } else if (isCjkLeftAlignedPunctuation(g)) {
    return { stretchability: [0, 0], shrinkability: [0, width / 2.0] };
  } else if (isCjkRightAlignedPunctuation(g)) {
    return { stretchability: [0, 0], shrinkability: [width / 2.0, 0] };
  } else if (isCjkCenterAlignedPunctuation(g.c)) {
    return { stretchability: [0, 0], shrinkability: [width / 4.0, width / 4.0] };
  }
  // `stretchable` glyph-level tracking limits are (0,0) by default → zero.
  return defaultAdjustability();
}

export function shrinkLeft(g: ShapedGlyph, amount: number): void {
  g.xOffset -= amount;
  g.xAdvance -= amount;
  g.adjustability.shrinkability[0] -= amount;
}

export function shrinkRight(g: ShapedGlyph, amount: number): void {
  g.xAdvance -= amount;
  g.adjustability.shrinkability[1] -= amount;
}

/** is_space (shaping.rs). */
export function isSpace(c: string): boolean {
  return c === ' ' || c === '\u00A0' || c === '\u3000';
}

/** is_cj_script via Unicode script properties (Hiragana | Katakana | Han,
 * or the prolonged sound mark). */
export function isCjScript(c: string): boolean {
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]|\u30FC/u.test(c);
}

export function isCjkPunctuation(g: ShapedGlyph): boolean {
  return (
    isCjkLeftAlignedPunctuation(g) ||
    isCjkRightAlignedPunctuation(g) ||
    isCjkCenterAlignedPunctuation(g.c)
  );
}

// GB style throughout (en text; style differences only affect zh-TW/HK/ja).
function isCjkLeftAlignedPunctuation(g: ShapedGlyph): boolean {
  const c = g.c;
  if ((c === '”' || c === '’') && g.xAdvance + g.adjustability.stretchability[1] === 1.0) {
    return true;
  }
  if ('，。．、：；'.includes(c)) return true;
  if ('？！'.includes(c)) return true;
  return '》）』」】〗〕〉］｝'.includes(c);
}

function isCjkRightAlignedPunctuation(g: ShapedGlyph): boolean {
  const c = g.c;
  if ((c === '“' || c === '‘') && g.xAdvance + g.adjustability.stretchability[0] === 1.0) {
    return true;
  }
  return '《（『「【〖〔〈［｛'.includes(c);
}

function isCjkCenterAlignedPunctuation(c: string): boolean {
  return c === '・' || c === '·';
}

/** is_justifiable (shaping.rs) — at shape time, stretchability is the
 * default (0,0), matching the Rust call site. */
function isJustifiable(c: string, xAdvance: number, stretchability: [number, number]): boolean {
  const probe: ShapedGlyph = {
    fontKey: '',
    glyphId: 0,
    xAdvance,
    xOffset: 0,
    size: 0,
    adjustability: { stretchability, shrinkability: [0, 0] },
    rangeStart: 0,
    rangeEnd: 0,
    safeToBreak: true,
    c,
    isJustifiable: false,
  };
  return (
    isSpace(c) ||
    isCjScript(c) ||
    isCjkLeftAlignedPunctuation(probe) ||
    isCjkRightAlignedPunctuation(probe) ||
    isCjkCenterAlignedPunctuation(c)
  );
}

/** Byte offset → JS index within a run-local string. Small helper for the
 * '\n' special case in find_safe_to_break. */
function byteToJsIndex(text: string, byteOffset: number): number {
  let b = 0;
  for (let i = 0; i < text.length; ) {
    if (b === byteOffset) return i;
    const cp = text.codePointAt(i)!;
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return text.length;
}
