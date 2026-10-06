// Typst math ink: formulas rendered by the same compiler that makes the PDF.
//
// KaTeX renders instantly while typing (the optimistic echo); this module
// compiles each formula through the in-app Typst (as the native Typst math
// the PDF prints — math-convert.ts — with the same bundled NewCM Math
// fonts) and hands the node view the exact ink the PDF will show, plus its
// baseline geometry so inline math sits on the text baseline. Results are
// cached by (source, display, size, macros); node views re-render and the
// typesetter re-runs when ink arrives, so line justification uses
// Typst-exact atom widths.

import type { Node as PMNode } from 'prosemirror-model';
import { parseMathMacros, type DocSettings } from './settings';
import { expandMacrosWith } from './typ-serializer';
import { wrapAligned } from './math-src';
import { compilerCircuitEpoch, onCompilerCircuitReset } from './compiler-circuit';
import { convertMath, displayEquation, ensureMathConverter, inlineEquation, MathConvertError } from './math-convert';
import { mathPrelude } from './typst-math-prelude';

export interface MathInk {
  svg: string;
  /** CSS px, at the document's current size. */
  widthPx: number;
  heightPx: number;
  /** Ink below the text baseline (px) — inline vertical-align offset. */
  descentPx: number;
}

type Listener = () => void;

/** Where a formula's ink stands. `failed`: Typst rejected the formula
 * itself — terminal until its source changes. `deferred`: the compiler
 * could not run it (a timeout, the paused circuit, a full queue, a crash)
 * — nothing is known about the formula, and it is asked for again once the
 * compiler may run again. Both leave the formula at its KaTeX width, which
 * is not Typst's; the node view marks it (see MathView). */
export type InkStatus = 'ready' | 'pending' | 'failed' | 'deferred' | 'absent';

interface QueueItem {
  key: string;
  src: string;
  display: boolean;
  sizePt: number;
  macros: string;
  bold: boolean;
}

interface Deferred {
  deferred: true;
  /** The circuit epoch the attempt ran in; a later epoch may retry. */
  epoch: number;
  reason: string;
  /** The compiler could not be loaded: any later successful compile shows
   * it can be now, and the formula is asked for again at once. */
  unavailable: QueueItem | null;
}

const cache = new Map<string, MathInk | 'pending' | 'failed' | Deferred>();
let deferredCount = 0;
/** Deadlines a formula's own compile ran out of. A formula that exhausts
 * the compiler twice is treated as Typst's verdict on it (failed), so it
 * does not burn a 20 s compile on every later edit. */
const ownTimeouts = new Map<string, number>();
const MAX_OWN_TIMEOUTS = 2;
const listeners = new Set<Listener>();
let queue: QueueItem[] = [];
let timer = 0;
let inflight = false;

/** `bold`: the inline formula sits inside a strong span, and the export
 * prints it inside `*…*`. The ink compiles in that same context so the
 * editor's advance equals the print whatever the compiler does with it:
 * the pinned Typst leaves math under `strong` unchanged, newer releases
 * embolden and widen it (~15% for `2x`). `emph`/`strike` never change
 * math ink and need no key of their own. */
export function inkKey(src: string, display: boolean, s: DocSettings, bold = false): string {
  return `${display ? 'D' : bold ? 'B' : 'I'}|${s.sizePt}|${s.mathMacros}|${src}`;
}

/** Inline math inside a strong span compiles as bold ink. */
export function isBoldMath(node: PMNode): boolean {
  return node.type.name === 'math_inline' && node.marks.some((m) => m.type.name === 'strong');
}

/** The ink key of a math node as it sits in the document (bold included):
 * every reader of an atom's width must use this, or a bold formula misses
 * its own ink. */
export function inkKeyFor(node: PMNode, s: DocSettings): string {
  return inkKey(node.attrs.src as string, node.type.name === 'math_display', s, isBoldMath(node));
}

function isDeferred(v: unknown): v is Deferred {
  return typeof v === 'object' && v !== null && 'deferred' in v;
}

function isInk(v: unknown): v is MathInk {
  return typeof v === 'object' && v !== null && 'svg' in v;
}

/** Cached Typst ink for a formula, if it has arrived. */
export function getInk(key: string): MathInk | undefined {
  const v = cache.get(key);
  return isInk(v) ? v : undefined;
}

export function inkStatus(key: string): InkStatus {
  const v = cache.get(key);
  if (v === undefined) return 'absent';
  if (v === 'pending' || v === 'failed') return v;
  return isDeferred(v) ? 'deferred' : 'ready';
}

/** Why a deferred formula has no ink (the compiler's message), if it is deferred. */
export function inkDeferredReason(key: string): string | null {
  const v = cache.get(key);
  return isDeferred(v) ? v.reason : null;
}

/** Schedule a compile for this formula (deduped; notifies on arrival). */
export function requestInk(key: string, src: string, display: boolean, s: DocSettings, bold = false) {
  const v = cache.get(key);
  // A deferred formula waits for a compiler lifecycle its failure did not
  // poison (the circuit's rule: background work never reopens it alone).
  if (isDeferred(v) && v.epoch < compilerCircuitEpoch()) setEntry(key, undefined);
  else if (v !== undefined) return;
  setEntry(key, 'pending');
  queue.push({ key, src, display, sizePt: s.sizePt, macros: s.mathMacros, bold: bold && !display });
  clearTimeout(timer);
  timer = window.setTimeout(() => void flush(), 120);
}

/** Re-render hook for node views (called once per completed batch). */
export function onInk(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Editing a formula produces dead pending/failed entries; let them retry. */
export function forgetInk(key: string) {
  const v = cache.get(key);
  if (v === 'failed' || isDeferred(v)) setEntry(key, undefined);
}

/** Every cache write goes through here so the deferred count stays true. */
function setEntry(key: string, v: MathInk | 'pending' | 'failed' | Deferred | undefined) {
  if (isDeferred(cache.get(key))) deferredCount--;
  if (v === undefined) cache.delete(key);
  else {
    cache.set(key, v);
    if (isDeferred(v)) deferredCount++;
  }
}

// A new compiler lifecycle (an edit, a reopen, an explicit export) lets
// deferred formulas try again: the node views re-render, find their entry
// from an older epoch, and re-request it. Nothing to do when none waits —
// this runs on every keystroke.
onCompilerCircuitReset(() => {
  if (deferredCount === 0) return;
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    for (const fn of listeners) fn();
  }, 120);
});
let retryTimer = 0;

async function flush() {
  if (inflight) return;
  if (!queue.length) return;
  inflight = true;
  const batch = queue;
  queue = [];
  try {
    const { runCompilerTask, CompilerWorkerError } = await import('./typst-worker-client');
    const { COMPILER_DEADLINES } = await import('./typst-worker-protocol');
    const run = <T extends string | unknown[] | null>(task: Parameters<typeof runCompilerTask>[0]) =>
      runCompilerTask<T>(task, { timeoutMs: COMPILER_DEADLINES.previewMs });
    // The converter loads once; a load that fails says nothing about any
    // formula, so the batch is deferred (below) and asked for again later.
    const converter = await ensureMathConverter().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    let compiled = false;
    for (const item of batch) {
      const epoch = compilerCircuitEpoch();
      try {
        if (converter) throw converter;
        const ink = await compileOne(item, run);
        setEntry(item.key, ink ?? 'failed');
        compiled = true;
      } catch (error) {
        // Only a verdict on the formula itself is terminal. A compiler that
        // could not run (timeout, paused circuit, full queue, crash) says
        // nothing about it: the formula is deferred, not failed.
        const code = error instanceof CompilerWorkerError ? error.code : 'crash';
        const timeouts = code === 'timeout' ? (ownTimeouts.get(item.key) ?? 0) + 1 : 0;
        if (timeouts) ownTimeouts.set(item.key, timeouts);
        const terminal = code === 'compile' || code === 'invalid' || code === 'output-limit' || timeouts >= MAX_OWN_TIMEOUTS;
        if (!terminal) console.warn('math ink deferred', error);
        setEntry(
          item.key,
          terminal
            ? 'failed'
            : {
                deferred: true,
                epoch,
                reason: error instanceof Error ? error.message : String(error),
                unavailable: code === 'unavailable' ? item : null,
              },
        );
      }
    }
    // The compiler ran: formulas that were refused only because it could
    // not be loaded need no edit to try again.
    if (compiled && deferredCount > 0) {
      for (const [key, v] of cache) {
        if (!isDeferred(v) || !v.unavailable) continue;
        setEntry(key, 'pending');
        queue.push(v.unavailable);
      }
    }
    if (cache.size > 2000) {
      const keys = [...cache.keys()];
      for (let i = 0; i < keys.length / 2; i++) setEntry(keys[i], undefined);
    }
  } finally {
    inflight = false;
    if (queue.length) {
      clearTimeout(timer);
      timer = window.setTimeout(() => void flush(), 30);
    }
  }
  for (const fn of listeners) fn();
}

interface InkItem {
  src: string;
  display: boolean;
  sizePt: number;
  macros: string;
  bold: boolean;
}

/**
 * The Typst source a formula's ink compiles from (see inkTypst). Display
 * math gets the LaTeX the export converts: the source, wrapped and
 * expanded, between two newlines. Null for an empty formula; throws
 * MathConvertError for one the converter rejects.
 */
function inkSource(item: InkItem): string | null {
  const latex = expandMacrosWith(item.display ? wrapAligned(item.src) : item.src, parseMathMacros(item.macros));
  if (!latex.trim()) return null;
  return inkTypst(item.display ? '\n' + latex + '\n' : latex, item.display, item.sizePt, item.bold);
}

/**
 * One formula's ink compile: the prelude its math names and the equation
 * as the print has it, on an auto-sized page at the document's size.
 * `latex` is exactly what the converter is given.
 */
export function inkTypst(latex: string, display: boolean, sizePt: number, bold: boolean): string {
  const typ = convertMath(latex);
  // Display equations hug the page tightly with no instrumentation (a
  // trailing probe would start a phantom paragraph below the ink). Inline
  // math needs the baseline probe; #box() anchors it in the flow.
  // One code-mode expression for both the ink and its measurement. (A
  // content block `strong[$…$]` would be markup, a different context from
  // the one measured.)
  const eq = display ? displayEquation(typ) : inlineEquation(typ);
  const expr = bold ? `strong(${eq})` : eq;
  return (
    `#set page(width: auto, height: auto, margin: 0pt)\n` +
    `#set text(size: ${sizePt}pt)\n` +
    mathPrelude([typ]) +
    '\n' +
    (display
      ? `${eq}\n`
      : `#(${expr})` +
        // The baseline, and the formula's exact advance: an auto-sized page
        // rounds to whole points (68.8pt came back as a 69pt page), and the
        // port needs the width Typst measures in the flow.
        `#context metadata((pos: here().position(), width: measure(${expr}).width));#box()\n`)
  );
}

/** Compile one formula. Resolves null when Typst (or the converter)
 * rejects the formula, or its ink is unusable; throws when the compiler
 * could not run it. */
async function compileOne(
  item: InkItem,
  run: <T extends string | unknown[] | null>(task: { kind: 'svg'; source: string } | { kind: 'query'; source: string; selector: string }) => Promise<T>,
): Promise<MathInk | null> {
  let src: string | null;
  try {
    src = inkSource(item);
  } catch (error) {
    if (error instanceof MathConvertError) return null;
    throw error;
  }
  if (!src) return null;

  const svg = await compileVerdict<string>(run({ kind: 'svg', source: src }));
  if (!svg) return null;
  const meta = item.display
    ? null
    : await compileVerdict<Array<{ func: string; value: { pos: { x: string; y: string }; width: string } }>>(
        run({ kind: 'query', source: src, selector: 'metadata' }),
      );
  const baselinePt = meta?.[0]?.value?.pos ? parseFloat(meta[0].value.pos.y) : NaN;
  const measuredPt = meta?.[0]?.value?.width ? parseFloat(meta[0].value.width) : NaN;

  // The viewBox carries the exact page size; the width/height attributes
  // are rounded (an auto-sized page came back as width="69" for 68.8pt),
  // and the port needs the exact advance Typst measures in the flow.
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg) ?? [];
  const wAttr = /width="([\d.]+)"/.exec(svg);
  const hAttr = /height="([\d.]+)"/.exec(svg);
  const wPt = Number.isFinite(measuredPt) && measuredPt > 0 ? measuredPt : m[1] ? parseFloat(m[1]) : wAttr ? parseFloat(wAttr[1]) : NaN;
  const hPt = m[2] ? parseFloat(m[2]) : hAttr ? parseFloat(hAttr[1]) : NaN;
  if (!(wPt > 0) || !(hPt > 0)) return null;

  const PX = 4 / 3;
  const descentPx = Number.isFinite(baselinePt) ? Math.max(0, (hPt - baselinePt) * PX) : 0;
  return { svg, widthPx: wPt * PX, heightPx: hPt * PX, descentPx };
}
/** A compile error is Typst's verdict on the formula (null); every other
 * failure means the compiler did not run, and propagates. */
async function compileVerdict<T>(p: Promise<unknown>): Promise<T | null> {
  const { CompilerWorkerError } = await import('./typst-worker-client');
  try {
    return (await p) as T;
  } catch (error) {
    if (error instanceof CompilerWorkerError && error.code === 'compile') return null;
    throw error;
  }
}
