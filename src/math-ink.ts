// Typst math ink: formulas rendered by the same compiler that makes the PDF.
//
// KaTeX renders instantly while typing (the optimistic echo); this module
// compiles each formula through the in-app Typst (via mitex, with the same
// bundled NewCM Math fonts) and hands the node view the exact ink the PDF
// will show, plus its baseline geometry so inline math sits on the text
// baseline. Results are cached by (source, display, size, macros); node
// views re-render and the typesetter re-runs when ink arrives, so line
// justification uses Typst-exact atom widths.

import { parseMathMacros, type DocSettings } from './settings';
import { expandMacrosWith } from './typ-serializer';
import { wrapAligned } from './math-src';

export interface MathInk {
  svg: string;
  /** CSS px, at the document's current size. */
  widthPx: number;
  heightPx: number;
  /** Ink below the text baseline (px) — inline vertical-align offset. */
  descentPx: number;
}

type Listener = () => void;

const cache = new Map<string, MathInk | 'pending' | 'failed'>();
const listeners = new Set<Listener>();
let queue: Array<{ key: string; src: string; display: boolean; sizePt: number; macros: string }> = [];
let timer = 0;
let inflight = false;

export function inkKey(src: string, display: boolean, s: DocSettings): string {
  return `${display ? 'D' : 'I'}|${s.sizePt}|${s.mathMacros}|${src}`;
}

/** Cached Typst ink for a formula, if it has arrived. */
export function getInk(key: string): MathInk | undefined {
  const v = cache.get(key);
  return v && v !== 'pending' && v !== 'failed' ? v : undefined;
}

/** Schedule a compile for this formula (deduped; notifies on arrival). */
export function requestInk(key: string, src: string, display: boolean, s: DocSettings) {
  if (cache.has(key)) return;
  cache.set(key, 'pending');
  queue.push({ key, src, display, sizePt: s.sizePt, macros: s.mathMacros });
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
  if (v === 'failed') cache.delete(key);
}

async function flush() {
  if (inflight) return;
  if (!queue.length) return;
  inflight = true;
  const batch = queue;
  queue = [];
  try {
    const { compileSvg, typstQuery } = await import('./pdf');
    for (const item of batch) {
      const ink = await compileOne(item, compileSvg, typstQuery);
      cache.set(item.key, ink ?? 'failed');
    }
    if (cache.size > 2000) {
      const keys = [...cache.keys()];
      for (let i = 0; i < keys.length / 2; i++) cache.delete(keys[i]);
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

async function compileOne(
  item: { src: string; display: boolean; sizePt: number; macros: string },
  compileSvg: (s: string) => Promise<string | null>,
  typstQuery: <T>(s: string, sel: string) => Promise<T[] | null>,
): Promise<MathInk | null> {
  const latex = expandMacrosWith(item.display ? wrapAligned(item.src) : item.src, parseMathMacros(item.macros));
  if (!latex.trim()) return null;
  // Display equations hug the page tightly with no instrumentation (a
  // trailing probe would start a phantom paragraph below the ink). Inline
  // math needs the baseline probe; #box() anchors it in the flow.
  const src =
    `#set page(width: auto, height: auto, margin: 0pt)\n` +
    `#set text(size: ${item.sizePt}pt)\n` +
    '#import "@preview/mitex:0.2.5": mi, mitex\n\n' +
    (item.display
      ? `#mitex(\`\n${latex}\n\`)\n`
      : `#mi(\`${latex}\`)#context metadata(here().position());#box()\n`);

  const svg = await compileSvg(src);
  if (!svg) return null;
  const pos = item.display
    ? null
    : await typstQuery<{ func: string; value: { x: string; y: string } }>(src, 'metadata');
  const baselinePt = pos?.[0]?.value ? parseFloat(pos[0].value.y) : NaN;

  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg) ?? [];
  const wAttr = /width="([\d.]+)"/.exec(svg);
  const hAttr = /height="([\d.]+)"/.exec(svg);
  const wPt = wAttr ? parseFloat(wAttr[1]) : m[1] ? parseFloat(m[1]) : NaN;
  const hPt = hAttr ? parseFloat(hAttr[1]) : m[2] ? parseFloat(m[2]) : NaN;
  if (!(wPt > 0) || !(hPt > 0)) return null;

  const PX = 4 / 3;
  const descentPx = Number.isFinite(baselinePt) ? Math.max(0, (hPt - baselinePt) * PX) : 0;
  return { svg, widthPx: wPt * PX, heightPx: hPt * PX, descentPx };
}