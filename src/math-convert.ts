// LaTeX → native Typst math, by mitex's own converter run locally.
//
// Formulas are authored as LaTeX. What Plass compiles (PDF, the audit,
// math ink) and what Export → Typst writes is plain Typst math: each
// formula converted once by mitex 0.2.7's `mitex.wasm` (Apache-2.0,
// vendored byte for byte in src/mitex/ with its license; the registry
// tarball it came from is preview/mitex-0.2.7.tar.gz, sha256 0159e214…).
// The wasm is loaded from the app's own files — the bundled asset in the
// browser, the file under node — and never from a package registry. Its
// output names a few handles (`frac`, `mitexsqrt`, `aligned`, …) that the
// print header defines (typst-math-prelude.ts).
//
// The wasm speaks the Typst plugin protocol (wasm-minimal-protocol): the
// host calls `convert_math(len1, len2)`; the plugin asks for its argument
// bytes through `typst_env.wasm_minimal_protocol_write_args_to_buffer` and
// hands back its result through `…_send_result_to_host`; 0 is success, 1
// an error whose result is the message. The spec argument is empty: the
// converter's built-in LaTeX spec, the one `#mi`/`#mitex` used.
//
// `ensureMathConverter()` loads it once; `convertMath` is synchronous after
// that and cached per source, so a print-mode `docToTyp` stays synchronous.

/** SHA-256 of src/mitex/mitex.wasm: the `mitex.wasm` inside the registry's
 * preview/mitex-0.2.7.tar.gz (sha256 0159e214845e49cbdc332d9d572da112dae5ad
 * 248072e0a7680d38c8307c2e15). Checked on every load. */
export const MITEX_WASM_SHA256 = 'f30000cbc2b18a6cdc72c3ce539d3ac443faa9109b4e0272cd274b37c6c1cff7';

/** A formula the converter refuses, or whose Typst form could not stay
 * inside its equation. Typst would have rejected it too: it fails visibly. */
export class MathConvertError extends Error {
  constructor(
    readonly latex: string,
    readonly reason: string,
  ) {
    super(`Cannot convert the formula ${JSON.stringify(latex.trim().slice(0, 80))}: ${reason}`);
    this.name = 'MathConvertError';
  }
}

interface Plugin {
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
}

let plugin: Plugin | null = null;
let loading: Promise<void> | null = null;
/** The protocol's two buffers for the call in progress. */
let callArgs: Uint8Array[] = [];
let callResult: Uint8Array | null = null;
const cache = new Map<string, string | MathConvertError>();
const CACHE_LIMIT = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function memory(): WebAssembly.Memory {
  return plugin!.instance.exports.memory as WebAssembly.Memory;
}

const imports: WebAssembly.Imports = {
  typst_env: {
    wasm_minimal_protocol_write_args_to_buffer(ptr: number) {
      const bytes = new Uint8Array(memory().buffer);
      let offset = ptr;
      for (const arg of callArgs) {
        bytes.set(arg, offset);
        offset += arg.length;
      }
    },
    wasm_minimal_protocol_send_result_to_host(ptr: number, len: number) {
      callResult = new Uint8Array(memory().buffer, ptr, len).slice();
    },
  },
};

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The vendored wasm's bytes: the Vite asset in the app, the file under node. */
async function wasmBytes(): Promise<ArrayBuffer> {
  if (import.meta.env) {
    const { default: url } = await import('./mitex/mitex.wasm?url');
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error(`the math converter returned HTTP ${response.status}`);
    return response.arrayBuffer();
  }
  // Node (unit tests, scripts): no bundler, no fetch of a file URL.
  const fsModule = 'node:fs/promises';
  const { readFile } = (await import(/* @vite-ignore */ fsModule)) as typeof import('node:fs/promises');
  const data = await readFile(new URL('./mitex/mitex.wasm', import.meta.url));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Load the converter once. Resolves when `convertMath` may be called;
 * rejects (and may be retried) when the wasm cannot be loaded or fails its
 * integrity check. */
export function ensureMathConverter(): Promise<void> {
  if (plugin) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      const bytes = await wasmBytes();
      const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
      if (digest !== MITEX_WASM_SHA256) throw new Error('the math converter failed its integrity check');
      const { module, instance } = await WebAssembly.instantiate(bytes, imports);
      plugin = { module, instance };
    })().catch((error: unknown) => {
      loading = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
  }
  return loading;
}

/** Whether `convertMath` can run now. */
export function mathConverterReady(): boolean {
  return plugin !== null;
}

/** One protocol call. A trap leaves the instance's memory in an unknown
 * state, so it is replaced from the compiled module before the next call. */
function call(latex: string): { ok: boolean; text: string } {
  callArgs = [encoder.encode(latex), new Uint8Array(0)];
  callResult = null;
  try {
    const convert = plugin!.instance.exports.convert_math as (a: number, b: number) => number;
    const code = convert(callArgs[0].length, callArgs[1].length);
    const text = callResult ? decoder.decode(callResult) : '';
    return { ok: code === 0 && callResult !== null, text };
  } catch (error) {
    const { module } = plugin!;
    try {
      plugin = { module, instance: new WebAssembly.Instance(module, imports) };
    } catch {
      plugin = null;
      loading = null;
    }
    return { ok: false, text: `the converter failed (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    callArgs = [];
    callResult = null;
  }
}

/**
 * Why a converted formula could not be printed as a native equation, or
 * null. The old form evaluated mitex's output in a string, so nothing could
 * leave it; inlined, the output must close everything it opens: dollars in
 * pairs (an equation nested in `\text`), content brackets balanced, and no
 * raw backtick, comment or unterminated string that would run on into the
 * document after it.
 */
function leakReason(typ: string): string | null {
  let dollars = 0;
  let depth = 0;
  for (let i = 0; i < typ.length; i++) {
    const c = typ[i];
    if (c === '\\') {
      // A final backslash would escape the equation's closing dollar.
      if (i + 1 >= typ.length) return 'its Typst form ends in an escape';
      i++;
      continue;
    }
    if (c === '`') return 'a backtick has no Typst math form';
    if (c === '/' && (typ[i + 1] === '/' || typ[i + 1] === '*')) return 'its Typst form would open a comment';
    if (c === '"') {
      let j = i + 1;
      while (j < typ.length && typ[j] !== '"') j += typ[j] === '\\' ? 2 : 1;
      if (j >= typ.length) return 'its Typst form leaves a string open';
      i = j;
      continue;
    }
    if (c === '$') dollars++;
    if (c === '[') depth++;
    if (c === ']' && --depth < 0) return 'its Typst form closes a bracket it did not open';
  }
  if (dollars % 2) return 'its Typst form leaves an equation open';
  if (depth) return 'its Typst form leaves a bracket open';
  return null;
}

/** `\set{…}` converts to a call of `set`, which is a Typst keyword: no
 * `#let` can define it. The prelude defines it as `mitexset`. (Text-mode
 * output escapes its parentheses, so a call is always math.) */
function renameKeywordHandles(typ: string): string {
  return typ.replace(/(?<![\p{L}\p{Nd}\\])set(?=\()/gu, 'mitexset');
}

/**
 * The native Typst math (an equation body, no `$`) for a LaTeX source.
 * Synchronous; call `ensureMathConverter()` first. Throws MathConvertError
 * for a formula the converter rejects, and a plain Error when the converter
 * is not loaded.
 */
export function convertMath(latex: string): string {
  const hit = cache.get(latex);
  if (hit !== undefined) {
    if (hit instanceof MathConvertError) throw hit;
    return hit;
  }
  if (!plugin) throw new Error('The math converter is not loaded (await ensureMathConverter() first)');
  const { ok, text } = call(latex);
  let value: string | MathConvertError;
  if (!ok) value = new MathConvertError(latex, text.replace(/^error:\s*/, '') || 'the converter gave no reason');
  else {
    const leak = leakReason(text);
    value = leak ? new MathConvertError(latex, leak) : renameKeywordHandles(text);
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(latex, value);
  if (value instanceof MathConvertError) throw value;
  return value;
}

/** An inline equation in markup: `$…$`. Leading space would make Typst
 * read `$ … $` as a display equation, so it goes (math ignores it). */
export function inlineEquation(typ: string): string {
  return '$' + typ.trimStart() + '$';
}

/** A display equation: `$ … $`, the space at each end being what makes it
 * a block. A body of nothing but whitespace is one space to Typst, which
 * then reads an inline equation; `#none` keeps it an empty block — the
 * zero-height equation `#mitex` printed for an empty formula. */
export function displayEquation(typ: string): string {
  if (!typ.trim()) return '$ #none $';
  return '$' + (/^\s/.test(typ) ? '' : ' ') + typ + (/\s$/.test(typ) ? '' : ' ') + '$';
}
