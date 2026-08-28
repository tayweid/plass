// Inline Typst is an escape hatch, not a second compiler world.
//
// Conservative fixed atoms are boxed and tagged only in the editor's shared
// whole-document SVG publication, then cropped from those exact pixels here.
// Canonical #h(1fr) is invisible and receives the line's compiled slack.
// Everything else stays byte-for-byte source and is shown as an explicit
// "Exact in Proof" chip; arbitrary code is never reinterpreted or guessed.

import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { schema } from './schema';
import type { DocSettings } from './settings';
import { textSetLine } from './typ-serializer';
import {
  documentPreviewManagerFor,
  type ManagedDocumentPreviewView,
  type TypstEmbedPreviewManager,
} from './raw-preview';
import type { TypstDocumentSvgPublication } from './typst-document-publication';
import { classifyTypstInline } from './typst-inline-regions';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PT_TO_PX = 4 / 3;

/** Does this source flex to fill the line? (Typst's `fr` unit.) */
export function isFlexible(src: string): boolean {
  return classifyTypstInline(src).kind === 'flexible';
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

/** Use the same normalized font decision as whole-document Proof/PDF. Stored
 * legacy or uncertified preferences never interpolate unsafe names. Retained
 * as a small public compatibility helper; product inline views no longer
 * compile fragments or consume this preamble. */
export function inlineRawPreamble(settings: DocSettings): string {
  return textSetLine(settings);
}

export class TypstInlineView implements NodeView, ManagedDocumentPreviewView {
  dom: HTMLElement;
  private destroyed = false;
  private unsubscribe: () => void;
  private manager: TypstEmbedPreviewManager;
  private renderedResult: TypstDocumentSvgPublication | null = null;
  private regionKey = '';

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
    this.manager = documentPreviewManagerFor(view);
    this.unsubscribe = onFillsChanged(() => this.renderLocalState());
    this.renderLocalState();
    this.manager.register(this);
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.typst_inline) return false;
    const changed = node.attrs.src !== this.node.attrs.src;
    this.node = node;
    if (changed) {
      this.renderedResult = null;
      this.regionKey = '';
      this.renderLocalState();
      this.manager.invalidate(this.view.state.doc);
    } else {
      this.renderLocalState();
    }
    return true;
  }

  needsDocumentPreview(): boolean {
    return classifyTypstInline(this.node.attrs.src as string).kind === 'fixed';
  }

  retainedDocumentPreview(): TypstDocumentSvgPublication | null {
    return this.renderedResult;
  }

  pending(): void {
    if (!this.needsDocumentPreview()) return;
    this.dom.dataset.previewState = 'pending';
    this.dom.title = this.renderedResult
      ? 'Updating from the exact whole-document Typst publication.'
      : 'Compiling in exact document context…';
  }

  private clearGeometry(): void {
    for (const property of ['display', 'position', 'width', 'height', 'line-height', 'vertical-align']) {
      this.dom.style.removeProperty(property);
    }
  }

  private sourceChip(state: 'pending' | 'unsupported' | 'error', detail: string): void {
    this.clearGeometry();
    this.dom.replaceChildren(document.createTextNode(this.node.attrs.src as string));
    this.dom.dataset.previewState = state;
    this.dom.title = detail;
  }

  private renderLocalState() {
    if (this.destroyed) return;
    const src = this.node.attrs.src as string;
    const classification = classifyTypstInline(src);
    this.dom.dataset.inlineKind = classification.kind;
    if (classification.kind === 'flexible') {
      const fill = getFill(this.node);
      this.dom.replaceChildren();
      this.dom.style.display = 'inline-block';
      this.dom.style.position = 'relative';
      this.dom.style.width = fill === undefined ? '0px' : `${fill}px`;
      this.dom.style.height = '0px';
      this.dom.style.lineHeight = '0';
      this.dom.style.verticalAlign = 'baseline';
      this.dom.dataset.previewState = fill === undefined ? 'pending' : 'ready';
      this.dom.title = '#h(1fr) uses the exact slack of its compiled line.';
      return;
    }
    if (classification.kind === 'unsupported') {
      this.renderedResult = null;
      this.regionKey = '';
      this.sourceChip(
        'unsupported',
        `${classification.reason}; source is preserved exactly and rendered in Proof/PDF.`,
      );
      return;
    }
    if (!this.renderedResult) {
      this.sourceChip('pending', 'Compiling in exact document context…');
    }
  }

  applyDocumentPreview(result: TypstDocumentSvgPublication, doc: PMNode): boolean {
    if (this.destroyed || !this.needsDocumentPreview()) return false;
    const pos = this.getPos();
    const index = pos === undefined ? null : this.manager.regionIndexAt(doc, pos, 'inline');
    const publication = this.manager.publicationFor(result);
    const region = index === null ? null : publication?.inlineRegions.get(index);
    const previewIndex = pos === undefined ? null : this.manager.regionIndexAt(doc, pos, 'preview');
    const baselineMeta = previewIndex === null ? null : publication?.previewRegions.get(previewIndex);
    if (!publication || !region || baselineMeta?.kind !== 'typst-inline') {
      this.compileError('The exact document did not expose a safe inline-atom region.');
      return false;
    }
    const pageTop = publication.pageY[baselineMeta.baseline.page - 1];
    if (pageTop === undefined) {
      this.compileError('The exact inline-atom baseline page was unavailable.');
      return false;
    }
    const baseline = pageTop + baselineMeta.baseline.y;
    const descent = Math.max(0, region.y + region.height - baseline);
    const key = [region.index, region.x, region.y, region.width, region.height,
      region.cropX, region.cropY, region.cropWidth, region.cropHeight, baseline].join(':');
    if (result === this.renderedResult && key === this.regionKey) {
      this.dom.dataset.previewState = 'ready';
      return false;
    }

    const previousWidth = Number.parseFloat(this.dom.style.width) || 0;
    const previousHeight = Number.parseFloat(this.dom.style.height) || 0;
    this.dom.replaceChildren();
    this.dom.style.display = 'inline-block';
    this.dom.style.position = 'relative';
    this.dom.style.width = `${region.width * PT_TO_PX}px`;
    this.dom.style.height = `${region.height * PT_TO_PX}px`;
    this.dom.style.lineHeight = '0';
    this.dom.style.verticalAlign = `${(-descent * PT_TO_PX).toFixed(3)}px`;

    if (region.cropWidth > 0 && region.cropHeight > 0) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `${region.cropX} ${region.cropY} ${region.cropWidth} ${region.cropHeight}`);
      svg.setAttribute('width', String(region.cropWidth));
      svg.setAttribute('height', String(region.cropHeight));
      svg.style.position = 'absolute';
      svg.style.pointerEvents = 'none';
      // Clip the shared whole-document image to this padded paint viewport.
      // The positioned SVG itself may overhang the atom; its image may not.
      svg.style.overflow = 'hidden';
      svg.style.left = `${(region.cropX - region.x) * PT_TO_PX}px`;
      svg.style.top = `${(region.cropY - region.y) * PT_TO_PX}px`;
      svg.style.width = `${region.cropWidth * PT_TO_PX}px`;
      svg.style.height = `${region.cropHeight * PT_TO_PX}px`;
      const image = document.createElementNS(SVG_NS, 'image');
      image.setAttribute('href', publication.objectUrl);
      image.setAttribute('x', String(publication.viewBox[0]));
      image.setAttribute('y', String(publication.viewBox[1]));
      image.setAttribute('width', String(publication.viewBox[2]));
      image.setAttribute('height', String(publication.viewBox[3]));
      image.setAttribute('preserveAspectRatio', 'none');
      image.setAttribute('data-exact-document-publication', '');
      svg.appendChild(image);
      this.dom.appendChild(svg);
    }
    this.renderedResult = result;
    this.regionKey = key;
    this.dom.dataset.previewState = 'ready';
    this.dom.title = 'Exact atom from the current whole-document Typst publication.';
    return Math.abs(previousWidth - region.width * PT_TO_PX) > 0.5 ||
      Math.abs(previousHeight - region.height * PT_TO_PX) > 0.5;
  }

  compileError(message: string): void {
    if (this.destroyed || !this.needsDocumentPreview()) return;
    if (this.renderedResult) {
      this.dom.dataset.previewState = 'error';
      this.dom.title = `Exact update failed; showing the last good atom. ${message}`;
    } else {
      this.sourceChip('error', `${message} Source remains exact in Proof/PDF.`);
    }
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
    this.manager.unregister(this);
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
    <div class="math-editor-preview inline-raw-preview" role="status"></div>
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
  let closed = false;
  const updatePreview = () => {
    if (closed) return;
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      if (closed) return;
      const src = input.value.trim();
      const classification = classifyTypstInline(src);
      preview.dataset.inlineKind = classification.kind;
      preview.textContent = classification.kind === 'fixed'
        ? 'Exact whole-document preview appears in the line after save.'
        : classification.kind === 'flexible'
          ? 'Flexible space uses the exact remaining width of its compiled line.'
          : `Source-only in the editor · Exact in Proof (${classification.reason}).`;
    }, 40);
  };
  updatePreview();
  input.addEventListener('input', updatePreview);

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(previewTimer);
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
