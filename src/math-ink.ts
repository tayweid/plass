// Typst math ink: formulas rendered by the same compiler that makes the PDF.
//
// KaTeX renders instantly while typing (the optimistic echo); this module
// compiles each formula through the in-app Typst (via mitex, with the same
// bundled NewCM Math fonts) and hands the node view the exact ink the PDF
// will show, plus its baseline geometry so inline math sits on the text
// baseline. Results are cached by (source, display, size, macros); node
// views re-render and the typesetter re-runs when ink arrives, so line
// justification uses Typst-exact atom widths.

import type { Node as PMNode } from 'prosemirror-model';
import { parseMathMacros, type DocSettings } from './settings';
import { expandMacrosWith } from './typ-serializer';
import { wrapAligned } from './math-src';
import { compilerCircuitEpoch, onCompilerCircuitReset } from './compiler-circuit';

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

interface Deferred {
  deferred: true;
  /** The circuit epoch the attempt ran in; a later epoch may retry. */
  epoch: number;
  reason: string;
}

const cache = new Map<string, MathInk | 'pending' | 'failed' | Deferred>();
let deferredCount = 0;
/** Deadlines a formula's own compile ran out of. A formula that exhausts
 * the compiler twice is treated as Typst's verdict on it (failed), so it
 * does not burn a 20 s compile on every later edit. */
const ownTimeouts = new Map<string, number>();
const MAX_OWN_TIMEOUTS = 2;
const listeners = new Set<Listener>();
let queue: Array<{ key: string; src: string; display: boolean; sizePt: number; macros: string; bold: boolean }> = [];
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
    for (const item of batch) {
      const epoch = compilerCircuitEpoch();
      try {
        const ink = await compileOne(item, run);
        setEntry(item.key, ink ?? 'failed');
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
          terminal ? 'failed' : { deferred: true, epoch, reason: error instanceof Error ? error.message : String(error) },
        );
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

/** Compile one formula. Resolves null when Typst rejects the formula (or
 * its ink is unusable); throws when the compiler could not run it. */
async function compileOne(
  item: { src: string; display: boolean; sizePt: number; macros: string; bold: boolean },
  run: <T extends string | unknown[] | null>(task: { kind: 'svg'; source: string } | { kind: 'query'; source: string; selector: string }) => Promise<T>,
): Promise<MathInk | null> {
  const latex = expandMacrosWith(item.display ? wrapAligned(item.src) : item.src, parseMathMacros(item.macros));
  if (!latex.trim()) return null;
  // Display equations hug the page tightly with no instrumentation (a
  // trailing probe would start a phantom paragraph below the ink). Inline
  // math needs the baseline probe; #box() anchors it in the flow.
  // One code-mode expression for both the ink and its measurement. (A
  // content block `strong[mi(...)]` would be markup: it measured the
  // literal text "mi(a)", 29pt for a 6.6pt formula.)
  const expr = item.bold ? `strong(mi(\`${latex}\`))` : `mi(\`${latex}\`)`;
  const src =
    `#set page(width: auto, height: auto, margin: 0pt)\n` +
    `#set text(size: ${item.sizePt}pt)\n` +
    '#import "@preview/mitex:0.2.5": mi, mitex\n\n' +
    (item.display
      ? `#mitex(\`\n${latex}\n\`)\n`
      : `#${expr}` +
        // The baseline, and the formula's exact advance: an auto-sized page
        // rounds to whole points (68.8pt came back as a 69pt page), and the
        // port needs the width Typst measures in the flow.
        `#context metadata((pos: here().position(), width: measure(${expr}).width));#box()\n`);

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
