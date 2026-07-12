/* @ts-self-types="./typeset_sidecar.d.ts" */

/**
 * A font store + shaper mirroring `shape_segment()`'s rustybuzz usage.
 */
export class Shaper {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ShaperFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_shaper_free(ptr, 0);
    }
    /**
     * Register a font (raw OTF/TTF bytes + face index). Returns the font id
     * to pass to `shape`, or -1 if the face fails to parse.
     * @param {Uint8Array} data
     * @param {number} index
     * @returns {number}
     */
    add_font(data, index) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.shaper_add_font(this.__wbg_ptr, ptr0, len0, index);
        return ret;
    }
    /**
     * The x-advance in font units for a glyph id.
     * @param {number} font
     * @param {number} glyph
     * @returns {number}
     */
    glyph_advance(font, glyph) {
        const ret = wasm.shaper_glyph_advance(this.__wbg_ptr, font, glyph);
        return ret;
    }
    /**
     * The glyph id for a single char (0 = not covered). Used by the TS
     * mirror of the coverage / tofu checks and `ShapedText::hyphen`.
     * @param {number} font
     * @param {number} c
     * @returns {number}
     */
    glyph_index(font, c) {
        const ret = wasm.shaper_glyph_index(this.__wbg_ptr, font, c);
        return ret >>> 0;
    }
    constructor() {
        const ret = wasm.shaper_new();
        this.__wbg_ptr = ret;
        ShaperFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
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
     * @param {number} font
     * @param {string} text
     * @param {boolean} rtl
     * @param {string} lang
     * @param {string} features
     * @returns {Int32Array}
     */
    shape(font, text, rtl, lang, features) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(lang, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(features, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.shaper_shape(this.__wbg_ptr, font, ptr0, len0, rtl, ptr1, len1, ptr2, len2);
        var v4 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v4;
    }
    /**
     * The font's OS/2 superscript height (ySuperscriptYSize) in em, or 0
     * if the font provides no superscript metrics. Typst synthesizes
     * superscripts (footnote markers) at this scale when the font has no
     * working `sups` feature (FontMetrics::from_ttf → ScriptMetrics.height).
     * @param {number} font
     * @returns {number}
     */
    superscript_height(font) {
        const ret = wasm.shaper_superscript_height(this.__wbg_ptr, font);
        return ret;
    }
    /**
     * Units per em for a registered font. The TS side computes
     * `x_advance_em = units / upem`, the same f64 division as
     * `Font::to_em`.
     * @param {number} font
     * @returns {number}
     */
    upem(font) {
        const ret = wasm.shaper_upem(this.__wbg_ptr, font);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Shaper.prototype[Symbol.dispose] = Shaper.prototype.free;

/**
 * Syllable boundaries for `word` per hypher, as cumulative UTF-8 byte
 * offsets (one entry per syllable, the last equals `word.len()`).
 * Mirrors the `hypher::hyphenate(word, lang)` loop in `hyphenations()`.
 * Empty result = unknown language (caller treats as no hyphenation).
 * @param {string} word
 * @param {string} lang
 * @returns {Uint32Array}
 */
export function hyphenate(word, lang) {
    const ptr0 = passStringToWasm0(word, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(lang, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.hyphenate(ptr0, len0, ptr1, len1);
    var v3 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * The ICU LineBreak property value for each codepoint of `text`, in order.
 * The TS port pairs this with the codepoints to evaluate the same
 * `lb.get(c)` matches as `breakpoints()`, `Breakpoint::trim`, and
 * `hyphenations()`.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function lb_classes(text) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.lb_classes(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The LineBreak property constants the algorithm compares against, exported
 * from the actual icu_properties values so the TS side never transcribes
 * them by hand. Order: MandatoryBreak, CarriageReturn, LineFeed, NextLine,
 * Space, CombiningMark, Glue, WordJoiner, ZWJ.
 * @returns {Uint8Array}
 */
export function lb_constants() {
    const ret = wasm.lb_constants();
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * UAX #14 line break opportunities for `text`, as UTF-8 byte offsets.
 * This is exactly `SEGMENTER.segment_str(text)` from `breakpoints()`,
 * including the leading offset-0 opportunity that the algorithm skips.
 * @param {string} text
 * @param {boolean} cj
 * @returns {Uint32Array}
 */
export function segment(text, cj) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.segment(ptr0, len0, cj);
    var v2 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * UAX #29 word boundaries (unicode-segmentation's `split_word_bounds`) as
 * cumulative UTF-8 byte offsets of segment ends. `breakpoints()` feeds each
 * segment between UAX #14 opportunities through this before hyphenating.
 * @param {string} text
 * @returns {Uint32Array}
 */
export function word_bounds(text) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.word_bounds(ptr0, len0);
    var v2 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./typeset_sidecar_bg.js": import0,
    };
}

const ShaperFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_shaper_free(ptr, 1));

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedInt32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('typeset_sidecar_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
