// Bridge to the Rust sidecar (sidecar/): the three data sources of the
// Typst line-break port that cannot be reimplemented in JS — UAX #14
// segmentation, hypher hyphenation, and rustybuzz shaping — vendored at the
// same crate versions and fed the same ICU blob and font bytes as the
// compiler WASM. See PORT.md.
//
// Everything is synchronous after `loadPrimitives()` resolves; results are
// memoized (paragraph texts and word vocabulary saturate quickly while
// typing).

import init, { Shaper, hyphenate, lb_classes, lb_constants, segment, word_bounds } from '../../sidecar/pkg/typeset_sidecar';
import { COMMON_FONT_FILES, COMMON_PORT_KEYS, FONT_CATALOG, FONT_STYLES } from '../font-registry';

/** LineBreak property constants, read from icu_properties itself. */
export interface LbConstants {
  mandatoryBreak: number;
  carriageReturn: number;
  lineFeed: number;
  nextLine: number;
  space: number;
  combiningMark: number;
  glue: number;
  wordJoiner: number;
  zwj: number;
}

export interface FontSpec {
  /** URL of the font binary (same file the Typst compiler shapes with). */
  url: string;
  /** Face index within the file. */
  index?: number;
  /** Namespaced selector key from the central font registry. */
  key: string;
}

/** The body + mono faces the editor typesets with (OTF originals — the
 * compiler shapes with these same bytes, NOT the woff2 conversions). */
const ASSET_BASE = import.meta.env?.BASE_URL ?? '/';

export const EDITOR_FONTS: FontSpec[] = [
  // BASE_URL-relative so the app also works deployed under a subpath. Only
  // exact families are registered; uncertified stored settings resolve to
  // the default before reaching this layer.
  ...FONT_CATALOG.filter((font) => font.exact).flatMap((font) =>
    FONT_STYLES.map((style) => ({
      url: `${ASSET_BASE}fonts/${font.compilerFiles[style]}`,
      key: font.portKeys[style],
    })),
  ),
  { url: `${ASSET_BASE}fonts/${COMMON_FONT_FILES.mono}`, key: COMMON_PORT_KEYS.mono },
];

export interface ShapedGlyphRaw {
  glyphId: number;
  /** UTF-8 byte offset of the glyph's cluster within the shaped text. */
  cluster: number;
  /** Advance in font units (divide by upem for em — same f64 division as
   * Typst's Font::to_em). */
  xAdvance: number;
  xOffset: number;
  safeToBreak: boolean;
}

// --- segment-stitched shaping (keystroke fast path) ---------------------
//
// The full-run shape cache is keyed by the entire run text, so typing
// inside a paragraph misses it on every keystroke and re-shapes the whole
// run in WASM. For the certified faces we instead split an eligible run
// into chunks after each U+0020 space run, shape/cache each chunk
// independently, and stitch the results (cluster offsets rebased). A
// keystroke then re-shapes only the edited word.
//
// Safety argument: stitching is bit-identical to full-run shaping only if
// no shaping interaction (kerning, ligatures, contextual lookups, cluster
// merging) crosses a chunk boundary. That property is not true of
// arbitrary fonts or scripts, so it is CERTIFIED, not assumed:
// `src/layout/port/shape-cache.test.ts` sweeps every ordered character
// pair of SEGMENT_SAFE_CHARS across a space, plus randomized longer
// strings and a real-text corpus, for every registered editor face, and
// asserts the stitched glyph stream (id, cluster, advance, offset,
// safe-to-break flag) is bit-identical to one whole-run rustybuzz call.
// Runs containing any character outside the certified set — notably
// U+00AD SOFT HYPHEN, whose default-ignorable cluster merging differs at
// a chunk start, plus newlines/tabs, combining marks, and every
// uncertified script — fail eligibility and fall back to full-run
// shaping. So do RTL runs, non-'en' languages, and non-empty feature
// lists, which the certification did not cover.

/** Every character certified for segment-stitched shaping: printable
 * ASCII, Latin-1 minus U+00AD SOFT HYPHEN, and the common typographic
 * punctuation the editor emits. The differential gate sweeps exactly this
 * string — extend it only together with that test. */
export const SEGMENT_SAFE_CHARS: string = (() => {
  let s = '';
  for (let c = 0x20; c <= 0x7e; c++) s += String.fromCharCode(c);
  for (let c = 0xa0; c <= 0xff; c++) if (c !== 0xad) s += String.fromCharCode(c);
  // Hyphens/dashes U+2010–U+2014, quotes, ellipsis, primes, single guillemets.
  s += '‐‑‒–—‘’“”…′″‹›';
  return s;
})();

const SEGMENT_SAFE = new Set<number>();
for (let i = 0; i < SEGMENT_SAFE_CHARS.length; i++) SEGMENT_SAFE.add(SEGMENT_SAFE_CHARS.charCodeAt(i));

/** True when every char of `text` is in the certified stitching charset.
 * (All certified chars are single BMP code units, so any surrogate is
 * automatically ineligible.) */
export function segmentShapingEligible(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!SEGMENT_SAFE.has(text.charCodeAt(i))) return false;
  }
  return true;
}

/** UTF-8 byte length for certified (BMP, non-surrogate) text. */
function utf8LenBmp(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
}

/** LRU bound of the per-chunk shape cache (typing vocabulary). */
const SEGMENT_CACHE_MAX = 20000;

class Primitives {
  private shaper: Shaper;
  private fontIds = new Map<string, number>();
  private upems = new Map<string, number>();
  readonly lb: LbConstants;

  private segCache = new Map<string, Uint32Array>();
  private lbCache = new Map<string, Uint8Array>();
  private hyphCache = new Map<string, Uint32Array>();
  private wbCache = new Map<string, Uint32Array>();
  private shapeCache = new Map<string, ShapedGlyphRaw[]>();
  /** Per-chunk cache for segment-stitched shaping (LRU, insertion order =
   * recency via delete/re-set on hit). */
  private segmentShapeCache = new Map<string, ShapedGlyphRaw[]>();
  /** Test hook: force the reference whole-run path (differential gate). */
  segmentShapingEnabled = true;

  constructor(shaper: Shaper, fontIds: Map<string, number>, upems: Map<string, number>) {
    this.shaper = shaper;
    this.fontIds = fontIds;
    this.upems = upems;
    const c = lb_constants();
    this.lb = {
      mandatoryBreak: c[0],
      carriageReturn: c[1],
      lineFeed: c[2],
      nextLine: c[3],
      space: c[4],
      combiningMark: c[5],
      glue: c[6],
      wordJoiner: c[7],
      zwj: c[8],
    };
  }

  /** UAX #14 break opportunities as UTF-8 byte offsets (includes offset 0). */
  segment(text: string, cj = false): Uint32Array {
    const key = (cj ? '' : '') + text;
    let r = this.segCache.get(key);
    if (!r) {
      r = segment(text, cj);
      this.bound(this.segCache).set(key, r);
    }
    return r;
  }

  /** ICU LineBreak class per codepoint of `text`, in codepoint order. */
  lbClasses(text: string): Uint8Array {
    let r = this.lbCache.get(text);
    if (!r) {
      r = lb_classes(text);
      this.bound(this.lbCache).set(text, r);
    }
    return r;
  }

  /** UAX #29 word-bound segment ends as cumulative UTF-8 byte offsets. */
  wordBounds(text: string): Uint32Array {
    let r = this.wbCache.get(text);
    if (!r) {
      r = word_bounds(text);
      this.bound(this.wbCache).set(text, r);
    }
    return r;
  }

  /** hypher syllable boundaries as cumulative UTF-8 byte offsets; empty =
   * unknown language. */
  hyphenate(word: string, lang: string): Uint32Array {
    const key = `${lang}:${word}`;
    let r = this.hyphCache.get(key);
    if (!r) {
      r = hyphenate(word, lang);
      this.bound(this.hyphCache).set(key, r);
    }
    return r;
  }

  /** Units per em of a registered face. */
  upem(fontKey: string): number {
    const u = this.upems.get(fontKey);
    if (u === undefined) throw new Error(`unknown font: ${fontKey}`);
    return u;
  }

  /** Glyph id for a codepoint (0 = uncovered). */
  glyphIndex(fontKey: string, c: string): number {
    const id = this.fontIds.get(fontKey);
    if (id === undefined) throw new Error(`unknown font: ${fontKey}`);
    return this.shaper.glyph_index(id, c.codePointAt(0)!);
  }

  /** OS/2 superscript height in em (0 = font provides none) — the scale
   * Typst synthesizes superscripts at (footnote markers). */
  superscriptHeight(fontKey: string): number {
    const id = this.fontIds.get(fontKey);
    if (id === undefined) throw new Error(`unknown font: ${fontKey}`);
    return this.shaper.superscript_height(id);
  }

  /** x-advance in font units for a glyph id. */
  glyphAdvance(fontKey: string, glyph: number): number {
    const id = this.fontIds.get(fontKey);
    if (id === undefined) throw new Error(`unknown font: ${fontKey}`);
    return this.shaper.glyph_advance(id, glyph);
  }

  /** Shape a run exactly as Typst's shape_segment does. Certified-charset
   * LTR/'en'/no-features runs go through the segment-stitched fast path,
   * which is differentially gated to be bit-identical to shapeFull. */
  shape(fontKey: string, text: string, opts?: { rtl?: boolean; lang?: string; features?: string }): ShapedGlyphRaw[] {
    const rtl = opts?.rtl ?? false;
    const lang = opts?.lang ?? 'en';
    const features = opts?.features ?? '';
    const key = `${fontKey}${rtl ? 1 : 0}${lang}${features}${text}`;
    let r = this.shapeCache.get(key);
    if (!r) {
      if (this.segmentShapingEnabled && !rtl && lang === 'en' && features === '' && segmentShapingEligible(text)) {
        r = this.shapeStitched(fontKey, text) ?? this.shapeFull(fontKey, text, rtl, lang, features);
      } else {
        r = this.shapeFull(fontKey, text, rtl, lang, features);
      }
      this.bound(this.shapeCache).set(key, r);
    }
    return r;
  }

  /** Reference path: one uncached rustybuzz call over the whole run. */
  shapeFull(fontKey: string, text: string, rtl = false, lang = 'en', features = ''): ShapedGlyphRaw[] {
    const id = this.fontIds.get(fontKey);
    if (id === undefined) throw new Error(`unknown font: ${fontKey}`);
    const flat = this.shaper.shape(id, text, rtl, lang, features);
    const r: ShapedGlyphRaw[] = [];
    for (let i = 0; i < flat.length; i += 5) {
      r.push({
        glyphId: flat[i],
        cluster: flat[i + 1],
        xAdvance: flat[i + 2],
        xOffset: flat[i + 3],
        safeToBreak: flat[i + 4] === 0,
      });
    }
    return r;
  }

  /** Shape an eligible run chunk-by-chunk (split after each space run) and
   * stitch the cached per-chunk results. Returns null when the run has no
   * split point (the full path handles it in one call anyway). */
  private shapeStitched(fontKey: string, text: string): ShapedGlyphRaw[] | null {
    // Chunk boundaries: after a U+0020 whose successor is not a U+0020,
    // so each chunk is a word plus its trailing space run.
    const bounds: number[] = [];
    for (let i = 0; i + 1 < text.length; i++) {
      if (text.charCodeAt(i) === 0x20 && text.charCodeAt(i + 1) !== 0x20) bounds.push(i + 1);
    }
    if (bounds.length === 0) return null;
    bounds.push(text.length);
    const out: ShapedGlyphRaw[] = [];
    let start = 0;
    let base = 0;
    for (const end of bounds) {
      const chunk = text.slice(start, end);
      for (const g of this.shapeChunk(fontKey, chunk)) {
        out.push({
          glyphId: g.glyphId,
          cluster: g.cluster + base,
          xAdvance: g.xAdvance,
          xOffset: g.xOffset,
          safeToBreak: g.safeToBreak,
        });
      }
      base += utf8LenBmp(chunk);
      start = end;
    }
    return out;
  }

  /** LRU-cached single-chunk shaping. The key omits rtl/lang/features
   * because shapeStitched is gated to rtl=false, lang='en', features=''. */
  private shapeChunk(fontKey: string, chunk: string): ShapedGlyphRaw[] {
    const key = `${fontKey}${chunk}`;
    const cached = this.segmentShapeCache.get(key);
    if (cached) {
      this.segmentShapeCache.delete(key);
      this.segmentShapeCache.set(key, cached);
      return cached;
    }
    const r = this.shapeFull(fontKey, chunk);
    this.segmentShapeCache.set(key, r);
    if (this.segmentShapeCache.size > SEGMENT_CACHE_MAX) {
      const oldest = this.segmentShapeCache.keys().next().value;
      if (oldest !== undefined) this.segmentShapeCache.delete(oldest);
    }
    return r;
  }

  /** Test hook: reset shaping caches so the next shape() re-derives. */
  clearShapeCaches(): void {
    this.shapeCache.clear();
    this.segmentShapeCache.clear();
  }

  /** Crude cache bound: reset when huge (vocabulary/paragraph churn). */
  private bound<K, V>(m: Map<K, V>): Map<K, V> {
    if (m.size > 20000) m.clear();
    return m;
  }
}

let instance: Primitives | null = null;
let loading: Promise<Primitives> | null = null;

/** The loaded primitives, or null before loadPrimitives resolves. */
export function primitives(): Primitives | null {
  return instance;
}

/** Load the sidecar WASM (browser: vite ?url + fetch) and register the
 * editor fonts. Idempotent. */
export function loadPrimitives(fonts: FontSpec[] = EDITOR_FONTS): Promise<Primitives> {
  if (loading) return loading;
  loading = (async () => {
    const { default: wasmUrl } = await import('../../sidecar/pkg/typeset_sidecar_bg.wasm?url');
    await init({ module_or_path: wasmUrl });
    const withBytes = await Promise.all(
      fonts.map(async (f) => ({
        ...f,
        bytes: new Uint8Array(await (await fetch(f.url)).arrayBuffer()),
      })),
    );
    return registerFonts(withBytes);
  })();
  return loading;
}

/** Node-side loader for tests: raw wasm + font bytes, no fetch. */
export async function loadPrimitivesFromBytes(
  wasm: BufferSource,
  fonts: Array<{ key: string; bytes: Uint8Array; index?: number }>,
): Promise<Primitives> {
  if (loading) return loading;
  loading = (async () => {
    await init({ module_or_path: wasm });
    return registerFonts(fonts);
  })();
  return loading;
}

function registerFonts(fonts: Array<{ key: string; bytes: Uint8Array; index?: number }>): Primitives {
  const shaper = new Shaper();
  const fontIds = new Map<string, number>();
  const upems = new Map<string, number>();
  for (const f of fonts) {
    const id = shaper.add_font(f.bytes, f.index ?? 0);
    if (id < 0) throw new Error(`sidecar could not parse font ${f.key}`);
    fontIds.set(f.key, id);
    upems.set(f.key, shaper.upem(id));
  }
  instance = new Primitives(shaper, fontIds, upems);
  return instance;
}
