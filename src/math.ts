// Math nodes: Typst-rendered atoms with a popover source editor.
//
// Following spec §3.7: math nodes are atomic in the document; clicking one
// opens a small editor with a live KaTeX preview. Source syntax is LaTeX;
// the document surface crops Typst's own ink from the one shared exact
// document publication, with KaTeX only as the instant echo while it settles.

import katex from 'katex';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection, type Command } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { InputRule } from 'prosemirror-inputrules';
import { schema } from './schema';
import { wrapAligned } from './math-src';
import { getSettings, parseMathMacros } from './settings';
import {
  documentPreviewManagerFor,
  type ManagedDocumentPreviewView,
  type PreparedDocumentPublication,
  type PreparedInlineRegion,
  type TypstEmbedPreviewManager,
} from './raw-preview';
import type { TypstDocumentSvgPublication } from './typst-document-publication';

export { wrapAligned };

function renderInto(el: HTMLElement, src: string, displayMode: boolean, macros: Record<string, string> = {}) {
  if (displayMode) src = wrapAligned(src);
  if (!src.trim()) {
    el.innerHTML = `<span class="math-placeholder">${displayMode ? 'equation' : 'math'}</span>`;
    return;
  }
  try {
    // KaTeX mutates the macros object (\def support) — hand it a copy.
    katex.render(src, el, { displayMode, throwOnError: false, macros: { ...macros } });
  } catch {
    el.textContent = src;
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const PT_TO_PX = 4 / 3;

function publicationCrop(
  publication: PreparedDocumentPublication,
  x: number,
  y: number,
  width: number,
  height: number,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  const image = document.createElementNS(SVG_NS, 'image');
  image.setAttribute('href', publication.objectUrl);
  image.setAttribute('x', String(publication.viewBox[0]));
  image.setAttribute('y', String(publication.viewBox[1]));
  image.setAttribute('width', String(publication.viewBox[2]));
  image.setAttribute('height', String(publication.viewBox[3]));
  image.setAttribute('preserveAspectRatio', 'none');
  image.setAttribute('data-exact-document-publication', '');
  svg.appendChild(image);
  return svg;
}

export class MathView implements NodeView, ManagedDocumentPreviewView {
  dom: HTMLElement;
  private readonly display: boolean;
  private readonly manager: TypstEmbedPreviewManager;
  private renderedResult: TypstDocumentSvgPublication | null = null;
  private regionKey = '';
  private appliedSettingsKey = '';
  private destroyed = false;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    const display = node.type.name === 'math_display';
    this.display = display;
    this.dom = document.createElement(display ? 'div' : 'span');
    this.dom.className = display ? 'math-display' : 'math-inline';
    this.dom.setAttribute('data-math', node.attrs.src);
    this.manager = documentPreviewManagerFor(view);
    this.renderEcho();
    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = this.getPos();
      if (pos !== undefined) openMathEditor(this.view, pos);
    });
    // A brand-new empty node (from an input rule or toolbar button) wants its
    // editor immediately.
    if (!node.attrs.src && !mathEditorOpen) {
      requestAnimationFrame(() => {
        const pos = this.getPos();
        if (pos !== undefined && !mathEditorOpen) openMathEditor(this.view, pos);
      });
    }
    this.manager.register(this);
  }

  private settingsKey(): string {
    const settings = getSettings(this.view.state);
    return JSON.stringify([
      settings.font,
      settings.sizePt,
      settings.mathMacros,
      settings.numberEquations,
    ]);
  }

  /** KaTeX is intentionally immediate and disposable. It never becomes a
   * settled width/page authority; exact mode waits for the shared crop. */
  private renderEcho() {
    const src = this.node.attrs.src as string;
    const settings = getSettings(this.view.state);
    this.dom.classList.remove('math-ink', 'math-proof');
    this.dom.style.removeProperty('width');
    this.dom.style.removeProperty('height');
    this.dom.style.removeProperty('vertical-align');
    this.dom.style.removeProperty('--eqnum-center');
    if (!src.trim()) {
      renderInto(this.dom, src, this.display);
      this.dom.dataset.previewState = 'empty';
      return;
    }
    renderInto(this.dom, src, this.display, parseMathMacros(settings.mathMacros));
    this.dom.dataset.previewState = 'pending';
    this.dom.title = 'Updating from the exact whole-document Typst publication.';
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.src !== this.node.attrs.src;
    this.node = node;
    this.dom.setAttribute('data-math', node.attrs.src);
    if (changed) {
      this.renderedResult = null;
      this.regionKey = '';
      this.appliedSettingsKey = '';
      this.renderEcho();
      this.manager.invalidate(this.view.state.doc);
    }
    return true;
  }

  needsDocumentPreview(): boolean {
    return !!(this.node.attrs.src as string).trim();
  }

  retainedDocumentPreview(): TypstDocumentSvgPublication | null {
    return this.renderedResult;
  }

  pending(): void {
    if (!this.needsDocumentPreview()) return;
    if (this.appliedSettingsKey && this.appliedSettingsKey !== this.settingsKey()) {
      this.renderedResult = null;
      this.regionKey = '';
      this.renderEcho();
    }
    this.dom.dataset.previewState = 'pending';
  }

  private regionIndex(doc: PMNode): number | null {
    const pos = this.getPos();
    return pos === undefined ? null : this.manager.regionIndexAt(doc, pos, 'preview');
  }

  private applyInline(
    result: TypstDocumentSvgPublication,
    publication: PreparedDocumentPublication,
    index: number,
  ): boolean {
    const meta = publication.previewRegions.get(index);
    const region: PreparedInlineRegion | undefined = publication.mathInlineRegions.get(index);
    if (!meta || meta.kind !== 'math-inline' || !region) return false;
    const pageTop = publication.pageY[meta.baseline.page - 1];
    if (pageTop === undefined) return false;
    const baseline = pageTop + meta.baseline.y;
    const descent = Math.max(0, region.y + region.height - baseline);
    const key = [index, region.x, region.y, region.width, region.height,
      region.cropX, region.cropY, region.cropWidth, region.cropHeight, baseline].join(':');
    if (result === this.renderedResult && key === this.regionKey) return false;
    const previousWidth = this.dom.getBoundingClientRect().width;
    const previousHeight = this.dom.getBoundingClientRect().height;
    const crop = publicationCrop(
      publication,
      region.cropX,
      region.cropY,
      region.cropWidth,
      region.cropHeight,
    );
    crop.style.position = 'absolute';
    crop.style.pointerEvents = 'none';
    // The host may expose the padded paint crop beyond the atom's advance,
    // but this nested viewport must clip the embedded whole-document image.
    // `visible` here repaints every page once per inline formula.
    crop.style.overflow = 'hidden';
    crop.style.left = `${(region.cropX - region.x) * PT_TO_PX}px`;
    crop.style.top = `${(region.cropY - region.y) * PT_TO_PX}px`;
    crop.style.width = `${region.cropWidth * PT_TO_PX}px`;
    crop.style.height = `${region.cropHeight * PT_TO_PX}px`;
    this.dom.replaceChildren(crop);
    this.dom.classList.add('math-ink');
    this.dom.classList.remove('math-proof');
    this.dom.style.width = `${region.width * PT_TO_PX}px`;
    this.dom.style.height = `${region.height * PT_TO_PX}px`;
    this.dom.style.verticalAlign = `${(-descent * PT_TO_PX).toFixed(3)}px`;
    this.dom.dataset.previewState = 'ready';
    this.dom.title = 'Exact math from the current whole-document Typst publication.';
    this.renderedResult = result;
    this.regionKey = key;
    this.appliedSettingsKey = this.settingsKey();
    return Math.abs(previousWidth - region.width * PT_TO_PX) > 0.5 ||
      Math.abs(previousHeight - region.height * PT_TO_PX) > 0.5;
  }

  private applyDisplay(
    result: TypstDocumentSvgPublication,
    publication: PreparedDocumentPublication,
    index: number,
  ): boolean {
    const meta = publication.previewRegions.get(index);
    if (!meta || meta.kind !== 'math-display') return false;
    const startPageTop = publication.pageY[meta.start.page - 1];
    const endPageTop = publication.pageY[meta.end.page - 1];
    if (startPageTop === undefined || endPageTop === undefined) return false;
    const key = [index, meta.start.page, meta.start.x, meta.start.y,
      meta.end.page, meta.end.x, meta.end.y].join(':');
    if (result === this.renderedResult && key === this.regionKey) return false;
    const previousHeight = this.dom.getBoundingClientRect().height;
    if (meta.start.page !== meta.end.page) {
      this.renderEcho();
      this.dom.classList.add('math-proof');
      this.dom.dataset.previewState = 'proof';
      this.dom.title = 'This equation spans Typst pages; open Proof for exact output.';
      this.renderedResult = result;
      this.regionKey = key;
      this.appliedSettingsKey = this.settingsKey();
      return true;
    }
    const start = startPageTop + meta.start.y;
    const end = endPageTop + meta.end.y;
    const height = end - start;
    if (!(height > 0.05)) return false;
    const settings = getSettings(this.view.state);
    const cropX = meta.start.x;
    const right = publication.viewBox[0] + publication.viewBox[2] - settings.marginRight * 72;
    const width = right - cropX;
    if (!(width > 0.05)) return false;
    const crop = publicationCrop(publication, cropX, start, width, height);
    crop.style.display = 'block';
    crop.style.width = `${width * PT_TO_PX}px`;
    crop.style.height = `${height * PT_TO_PX}px`;
    this.dom.replaceChildren(crop);
    this.dom.classList.add('math-ink');
    this.dom.classList.remove('math-proof');
    this.dom.style.height = `${height * PT_TO_PX}px`;
    this.dom.dataset.previewState = 'ready';
    this.dom.title = 'Exact equation from the current whole-document Typst publication.';
    this.renderedResult = result;
    this.regionKey = key;
    this.appliedSettingsKey = this.settingsKey();
    return Math.abs(previousHeight - height * PT_TO_PX) > 0.5;
  }

  applyDocumentPreview(result: TypstDocumentSvgPublication, doc: PMNode): boolean {
    if (this.destroyed || !this.needsDocumentPreview()) return false;
    const index = this.regionIndex(doc);
    const publication = this.manager.publicationFor(result);
    if (index === null || !publication) {
      this.compileError('The exact document did not expose math preview geometry.');
      return false;
    }
    const applied = this.display
      ? this.applyDisplay(result, publication, index)
      : this.applyInline(result, publication, index);
    if (!applied && this.renderedResult !== result) {
      this.compileError('The exact document did not expose complete math preview geometry.');
    }
    return applied;
  }

  compileError(message: string): void {
    if (this.destroyed || !this.needsDocumentPreview()) return;
    if (!this.renderedResult) this.renderEcho();
    this.dom.dataset.previewState = 'error';
    this.dom.title = this.renderedResult
      ? `Exact update failed; showing the last good math. ${message}`
      : `${message} Source remains exact in Proof/PDF.`;
  }

  selectNode() {
    this.dom.classList.add('math-selected');
  }

  deselectNode() {
    this.dom.classList.remove('math-selected');
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.manager.unregister(this);
  }

  ignoreMutation() {
    return true;
  }
}

let mathEditorOpen = false;

export function openMathEditor(view: EditorView, pos: number) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || (node.type !== schema.nodes.math_inline && node.type !== schema.nodes.math_display)) return;
  if (mathEditorOpen) return;
  mathEditorOpen = true;

  const display = node.type.name === 'math_display';

  const panel = document.createElement('div');
  panel.className = 'math-editor';
  panel.innerHTML = `
    <div class="math-editor-preview" aria-hidden="true"></div>
    <textarea class="math-editor-input" rows="${display ? 3 : 1}"
      placeholder="${display ? '\\int_a^b f(x)\\,dx' : 'e^{i\\pi}+1=0'}" spellcheck="false"></textarea>
    ${display
      ? `<div class="math-editor-labelrow">
          <button type="button" class="math-editor-num" title="Toggle numbering for this equation"></button>
          <input class="math-editor-label" placeholder="label — reference in text with @label" spellcheck="false">
        </div>`
      : ''}
    <div class="math-editor-hint">LaTeX${display ? ' · <kbd>&amp;</kbd> aligns · <kbd>Enter</kbd> new line · <kbd>⌘Enter</kbd> save' : ' · <kbd>Enter</kbd> save'} · <kbd>Esc</kbd> cancel</div>`;
  const preview = panel.querySelector('.math-editor-preview') as HTMLElement;
  const input = panel.querySelector('.math-editor-input') as HTMLTextAreaElement;
  const labelInput = panel.querySelector('.math-editor-label') as HTMLInputElement | null;
  const numBtn = panel.querySelector('.math-editor-num') as HTMLButtonElement | null;
  input.value = node.attrs.src;
  if (labelInput) labelInput.value = node.attrs.label ?? '';
  // Binary toggle: numbered (default / attr null or true) vs unnumbered.
  let eqNumbered: boolean | null = node.attrs.numbered as boolean | null;
  // The number this equation gets while numbered: numbered equations
  // before it in the document, plus one (dense numbering).
  const eqNumber = (() => {
    if (!display) return 0;
    const docDefault = getSettings(view.state).numberEquations;
    let n = 0;
    view.state.doc.descendants((child, childPos) => {
      if (childPos >= pos || child.type.name !== 'math_display') return childPos < pos;
      if (((child.attrs.numbered as boolean | null) ?? docDefault) !== false) n++;
      return false;
    });
    return n + 1;
  })();
  const paintNum = () => {
    if (!numBtn) return;
    const on = eqNumbered !== false;
    numBtn.classList.toggle('math-editor-num-off', !on);
    numBtn.title = on ? 'Numbered — click to remove the number' : 'Unnumbered — click to number';
    preview.classList.toggle('math-editor-preview-numbered', on);
    if (on) preview.setAttribute('data-eqnum', `(${eqNumber})`);
    else preview.removeAttribute('data-eqnum');
  };
  numBtn?.addEventListener('click', () => {
    eqNumbered = eqNumbered === false ? null : false;
    paintNum();
  });

  const macros = parseMathMacros(getSettings(view.state).mathMacros);
  const updatePreview = () => renderInto(preview, input.value.trim() || '\\ldots', display, macros);
  updatePreview();
  paintNum();
  input.addEventListener('input', updatePreview);

  document.body.appendChild(panel);
  const target = view.nodeDOM(pos);
  const rect =
    target instanceof HTMLElement ? target.getBoundingClientRect() : view.coordsAtPos(pos);
  // Display equations: the editor spans the full block width.
  if (display && 'width' in rect && rect.width > 300) panel.style.width = `${rect.width}px`;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - panel.offsetWidth - 8);
  const top =
    rect.bottom + panel.offsetHeight + 16 > window.innerHeight
      ? rect.top - panel.offsetHeight - 8
      : rect.bottom + 8;
  panel.style.left = `${left + window.scrollX}px`;
  panel.style.top = `${top + window.scrollY}px`;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    mathEditorOpen = false;
    panel.remove();
    view.focus();
  };

  const commit = () => {
    if (closed) return;
    const src = input.value.trim();
    const label = (labelInput?.value ?? '').trim().replace(/[^a-zA-Z0-9:._-]/g, '-');
    const current = view.state.doc.nodeAt(pos);
    if (current && current.type === node.type) {
      let tr;
      if (src) {
        const attrs = display ? { src, label, numbered: eqNumbered } : { src };
        tr = view.state.tr.setNodeMarkup(pos, undefined, attrs);
        // Put the caret after the node so the user can keep typing.
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos + current.nodeSize), 1));
      } else {
        tr = view.state.tr.delete(pos, pos + current.nodeSize);
      }
      view.dispatch(tr);
    }
    close();
  };

  const cancel = () => {
    if (closed) return;
    const current = view.state.doc.nodeAt(pos);
    // Cancelling a never-filled node removes it.
    if (current && current.type === node.type && !current.attrs.src) {
      view.dispatch(view.state.tr.delete(pos, pos + current.nodeSize));
    }
    close();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Enter' && !e.shiftKey && !(display && e.target === input)) {
      // Display sources are multi-line: plain Enter inserts a line there;
      // everywhere else (inline math, the label field) it saves.
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };
  input.addEventListener('keydown', onKeydown);
  labelInput?.addEventListener('keydown', onKeydown);
  // Commit when focus truly leaves the panel (not when tabbing between fields).
  panel.addEventListener('focusout', (e) => {
    if (!panel.contains(e.relatedTarget as Node)) commit();
  });

  input.focus();
  input.select();
}

/** Toolbar/keymap command: wrap the selection (or insert) as math. */
export function insertMath(display: boolean): Command {
  return (state, dispatch) => {
    const type = display ? schema.nodes.math_display : schema.nodes.math_inline;
    const { from, to, empty } = state.selection;
    const src = empty ? '' : state.doc.textBetween(from, to, ' ');
    const node = type.create({ src });
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

/** `$...$` becomes inline math as you type the closing dollar. */
export const mathInlineRule = new InputRule(/\$([^$\s](?:[^$]*[^$\s])?)\$$/, (state, match, start, end) => {
  return state.tr.replaceWith(start, end, schema.nodes.math_inline.create({ src: match[1] }));
});

/** `$$` on an empty line becomes a display-math block. */
export const mathDisplayRule = new InputRule(/^\$\$$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== schema.nodes.paragraph) return null;
  if ($start.parent.content.size > end - start) return null;
  return state.tr.replaceRangeWith(
    $start.before(),
    $start.after(),
    schema.nodes.math_display.create({ src: '' }),
  );
});
