/* tslint:disable */
/* eslint-disable */

/**
 * A font store + shaper mirroring `shape_segment()`'s rustybuzz usage.
 */
export class Shaper {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Register a font (raw OTF/TTF bytes + face index). Returns the font id
     * to pass to `shape`, or -1 if the face fails to parse.
     */
    add_font(data: Uint8Array, index: number): number;
    /**
     * The x-advance in font units for a glyph id.
     */
    glyph_advance(font: number, glyph: number): number;
    /**
     * The glyph id for a single char (0 = not covered). Used by the TS
     * mirror of the coverage / tofu checks and `ShapedText::hyphen`.
     */
    glyph_index(font: number, c: number): number;
    constructor();
    /**
     * Shape `text` exactly as `shape_segment()` does: fill a UnicodeBuffer,
     * set language and direction, guess segment properties, remove default
     * ignorables, build a ShapePlan from the buffer's resolved properties,
     * and shape.
     *
     * `features` is a comma-separated list in HarfBuzz feature syntax
     * (empty for Typst's defaults). Returns a flat array of 5 values per
     * glyph: [glyph_id, cluster (byte offset), x_advance (units),
     * x_offset (units), unsafe_to_break (0|1)].
     */
    shape(font: number, text: string, rtl: boolean, lang: string, features: string): Int32Array;
    /**
     * The font's OS/2 superscript height (ySuperscriptYSize) in em, or 0
     * if the font provides no superscript metrics. Typst synthesizes
     * superscripts (footnote markers) at this scale when the font has no
     * working `sups` feature (FontMetrics::from_ttf → ScriptMetrics.height).
     */
    superscript_height(font: number): number;
    /**
     * Units per em for a registered font. The TS side computes
     * `x_advance_em = units / upem`, the same f64 division as
     * `Font::to_em`.
     */
    upem(font: number): number;
}

/**
 * Syllable boundaries for `word` per hypher, as cumulative UTF-8 byte
 * offsets (one entry per syllable, the last equals `word.len()`).
 * Mirrors the `hypher::hyphenate(word, lang)` loop in `hyphenations()`.
 * Empty result = unknown language (caller treats as no hyphenation).
 */
export function hyphenate(word: string, lang: string): Uint32Array;

/**
 * The ICU LineBreak property value for each codepoint of `text`, in order.
 * The TS port pairs this with the codepoints to evaluate the same
 * `lb.get(c)` matches as `breakpoints()`, `Breakpoint::trim`, and
 * `hyphenations()`.
 */
export function lb_classes(text: string): Uint8Array;

/**
 * The LineBreak property constants the algorithm compares against, exported
 * from the actual icu_properties values so the TS side never transcribes
 * them by hand. Order: MandatoryBreak, CarriageReturn, LineFeed, NextLine,
 * Space, CombiningMark, Glue, WordJoiner, ZWJ.
 */
export function lb_constants(): Uint8Array;

/**
 * UAX #14 line break opportunities for `text`, as UTF-8 byte offsets.
 * This is exactly `SEGMENTER.segment_str(text)` from `breakpoints()`,
 * including the leading offset-0 opportunity that the algorithm skips.
 */
export function segment(text: string, cj: boolean): Uint32Array;

/**
 * UAX #29 word boundaries (unicode-segmentation's `split_word_bounds`) as
 * cumulative UTF-8 byte offsets of segment ends. `breakpoints()` feeds each
 * segment between UAX #14 opportunities through this before hyphenating.
 */
export function word_bounds(text: string): Uint32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_shaper_free: (a: number, b: number) => void;
    readonly hyphenate: (a: number, b: number, c: number, d: number) => [number, number];
    readonly lb_classes: (a: number, b: number) => [number, number];
    readonly lb_constants: () => [number, number];
    readonly segment: (a: number, b: number, c: number) => [number, number];
    readonly shaper_add_font: (a: number, b: number, c: number, d: number) => number;
    readonly shaper_glyph_advance: (a: number, b: number, c: number) => number;
    readonly shaper_glyph_index: (a: number, b: number, c: number) => number;
    readonly shaper_new: () => number;
    readonly shaper_shape: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly shaper_superscript_height: (a: number, b: number) => number;
    readonly shaper_upem: (a: number, b: number) => number;
    readonly word_bounds: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
