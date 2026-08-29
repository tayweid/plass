// Inline raw Typst: `#h(1fr)`, `#box(width: 2in, line(length: 100%))`, or
// any other Typst expression, mid-sentence. The node stores the source; the
// view shows the compiled result, so the document reads as what it prints.
//
// Two width regimes:
//
//   FIXED — the fragment has an intrinsic size (a 2in box, a symbol, #h(1em)).
//   It compiles in an auto-width page and reports its own width, exactly like
//   inline math ink.
//
//   FLEXIBLE (fr) — `1fr` means "absorb the leftover space on this line", so
//   the width is a LAYOUT result, not a property of the fragment. The
//   breaker treats these atoms as zero-width (as Typst does), the line's
//   slack is handed back here by the typeset plugin, and the fragment
//   recompiles in a page of exactly that width — which is how a fill RULE
//   ends up the right length instead of collapsing to nothing.

import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { mountTypstSvg } from './safe-svg';
import { schema } from './schema';
import { getSettings } from './settings';

/** Does this source flex to fill the line? (Typst's `fr` unit.) */
export function isFlexible(src: string): boolean {
  return /\d*\.?\d+\s*fr\b/.test(src);
}

/** The layout layer's question: is this child an atom whose width the LINE
 *  decides rather than the fragment? Asked by atom measurement, the breaker,
 *  and the forced-layout fast path, so it lives in one place. */
export function isFlexibleAtom(child: PMNode): boolean {
  return child.type.name === 'typst_inline' && isFlexible(child.attrs.src as string);
}

// ---------- assigned fill widths (paginator → views) ----------

const fills = new WeakMap<PMNode, number>();
const listeners = new Set<() => void>();
let queued = false;

function notify() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    for (const cb of listeners) cb();
  });
}

export function onFillsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The line's slack, assigned to a flexible atom by the typeset plugin. */
export function applyFill(node: PMNode, widthPx: number) {
  const prev = fills.get(node);
  if (prev !== undefined && Math.abs(prev - widthPx) < 0.5) return;
  fills.set(node, widthPx);
  notify();
}

export function getFill(node: PMNode): number | undefined {
  return fills.get(node);
}

// ---------- compile cache ----------

const cache = new Map<string, string | 'pending' | 'failed'>();
const CACHE_MAX = 64;

function preamble(view: EditorView): string {
  const s = getSettings(view.state);
  return `#set text(size: ${s.sizePt}pt, font: "${s.font}", hyphenate: ${s.hyphenate})\n`;
}

/** Compile one inline fragment. `widthPt` null = auto (intrinsic) width. */
async function compile(view: EditorView, src: string, widthPt: number | null): Promise<string | null> {
  const { compileSvg } = await import('./pdf');
  const page = widthPt === null
    ? '#set page(width: auto, height: auto, margin: 0pt)'
    : `#set page(width: ${widthPt.toFixed(2)}pt, height: auto, margin: 0pt)`;
  return compileSvg(`${page}\n${preamble(view)}\n${src}\n`);
}

function cachedCompile(view: EditorView, src: string, widthPt: number | null, done: () => void): string | null {
  const key = `${widthPt === null ? 'auto' : widthPt.toFixed(1)}|${preamble(view)}|${src}`;
  const hit = cache.get(key);
  if (typeof hit === 'string' && hit !== 'pending' && hit !== 'failed') return hit;
  if (hit === 'pending' || hit === 'failed') return null;
  cache.set(key, 'pending');
  if (cache.size > CACHE_MAX) {
    for (const k of cache.keys()) {
      if (cache.size <= CACHE_MAX) break;
      if (cache.get(k) !== 'pending') cache.delete(k);
    }
  }
  void compile(view, src, widthPt)
    .then((svg) => {
      cache.set(key, svg ?? 'failed');
      if (svg) done();
    })
    .catch(() => cache.set(key, 'failed'));
  return null;
}

export class TypstInlineView implements NodeView {
  dom: HTMLElement;
  private destroyed = false;
  private unsubscribe: () => void;
  private shown = '';

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('span');
    this.dom.className = 'ts-inline-raw';
    this.dom.contentEditable = 'false';
    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos === undefined) return;
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
      this.view.focus();
      openInlineRawEditor(this.view, pos);
    });
    this.unsubscribe = onFillsChanged(() => this.render());
    this.render();
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.typst_inline) return false;
    this.node = node;
    this.render();
    return true;
  }

  private render() {
    if (this.destroyed) return;
    const src = this.node.attrs.src as string;
    const flexible = isFlexible(src);
    const fill = flexible ? getFill(this.node) : undefined;
    if (flexible) {
      // Layout owns the width; paint nothing until it is known.
      this.dom.style.display = 'inline-block';
      this.dom.style.width = fill === undefined ? '0px' : `${fill}px`;
      if (fill === undefined) {
        this.dom.replaceChildren();
        this.shown = '';
        return;
      }
    }
    const widthPt = flexible ? (fill as number) * 0.75 : null;
    const key = `${widthPt === null ? 'auto' : widthPt.toFixed(1)}|${src}`;
    const svg = cachedCompile(this.view, src, widthPt, () => this.render());
    if (!svg || key === this.shown) return;
    this.shown = key;
    const svgEl = mountTypstSvg(this.dom, svg);
    if (!svgEl) return;
    const w = parseFloat(svgEl.getAttribute('width') ?? '0');
    const h = parseFloat(svgEl.getAttribute('height') ?? '0');
    svgEl.style.width = `${(w * 4) / 3}px`;
    // Sub-pixel-tall fragments (a hairline rule) need a padded viewBox or
    // the browser has nothing to project into.
    if (h < 1.5) {
      svgEl.setAttribute('viewBox', `0 -1 ${w} ${h + 2}`);
      svgEl.style.height = `${((h + 2) * 4) / 3}px`;
    } else {
      svgEl.style.height = `${(h * 4) / 3}px`;
    }
    svgEl.style.display = 'inline-block';
    svgEl.style.verticalAlign = 'baseline';
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.unsubscribe();
  }
}

/** The edit card: same shape as the math editor — source in, preview above. */
export function openInlineRawEditor(view: EditorView, pos: number) {
  document.querySelector('.inline-raw-editor')?.remove();
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type !== schema.nodes.typst_inline) return;

  const panel = document.createElement('div');
  panel.className = 'math-editor inline-raw-editor';
  panel.innerHTML = `
    <div class="math-editor-preview inline-raw-preview"></div>
    <textarea class="math-editor-input" rows="2" spellcheck="false"
      placeholder="#h(1fr)  ·  #box(width: 2in, line(length: 100%))"></textarea>
    <div class="math-editor-hint">Raw Typst · <kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel · <kbd>⌫</kbd> on empty removes</div>`;
  const input = panel.querySelector('.math-editor-input') as HTMLTextAreaElement;
  const preview = panel.querySelector('.inline-raw-preview') as HTMLElement;
  input.value = node.attrs.src as string;

  const coords = view.coordsAtPos(pos);
  panel.style.left = `${Math.max(8, Math.min(coords.left - 40, window.innerWidth - 400))}px`;
  panel.style.top = `${coords.bottom + 8 + window.scrollY}px`;
  document.body.appendChild(panel);

  let previewTimer = 0;
  const updatePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      const src = input.value.trim();
      // Preview flexible fragments at a nominal width — on the page they
      // take the line's slack, which has no meaning inside the card.
      const svg = cachedCompile(view, src || '#h(0pt)', isFlexible(src) ? 180 : null, updatePreview);
      if (svg) mountTypstSvg(preview, svg);
    }, 120);
  };
  updatePreview();
  input.addEventListener('input', updatePreview);

  const close = () => {
    document.removeEventListener('mousedown', onDown, true);
    panel.remove();
    view.focus();
  };
  const commit = () => {
    const src = input.value.trim();
    const at = pos;
    const cur = view.state.doc.nodeAt(at);
    if (!cur || cur.type !== schema.nodes.typst_inline) return close();
    if (!src) {
      view.dispatch(view.state.tr.delete(at, at + cur.nodeSize));
      return close();
    }
    if (src !== cur.attrs.src) {
      view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { src }));
    }
    close();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Backspace' && !input.value) {
      e.preventDefault();
      const cur = view.state.doc.nodeAt(pos);
      if (cur) view.dispatch(view.state.tr.delete(pos, pos + cur.nodeSize));
      close();
    }
  });
  const onDown = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node)) commit();
  };
  document.addEventListener('mousedown', onDown, true);
  input.focus();
  input.select();
}

/** Insert an inline raw-Typst node at the cursor and open its editor. */
export function insertTypstInline(view: EditorView, src = '#h(1fr)') {
  const { state } = view;
  const node = schema.nodes.typst_inline.create({ src });
  const pos = state.selection.from;
  view.dispatch(state.tr.replaceSelectionWith(node, false));
  view.focus();
  openInlineRawEditor(view, pos);
}
