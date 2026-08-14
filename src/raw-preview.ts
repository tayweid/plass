// Code blocks, two personalities. A plain code block (```python …) is just
// text and renders as the editable source it is. A raw-Typst island renders
// as its COMPILED self — the same fragment pipeline as tables — because the
// island's job is to be part of the document (a rule, a spacer, a custom
// block), not to look like source code. Click the render to edit the source
// in place; leaving the block compiles and swaps the render back in.
//
// Islands with no visual output (set/show rules, counter updates) keep the
// source-chip look: there is nothing to render, and hiding them entirely
// would make them uneditable.

import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { schema } from './schema';
import { fragmentSource } from './table-split';
import { scheduleTypeset } from './typeset-plugin';

export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private renderEl: HTMLElement | null = null;
  private pre: HTMLElement;
  private timer = 0;
  private lastSrc = '';
  private destroyed = false;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.pre = document.createElement('pre');
    this.contentDOM = document.createElement('code');
    this.pre.appendChild(this.contentDOM);

    if (!this.isRaw()) {
      this.dom = this.pre;
      return;
    }

    this.dom = document.createElement('div');
    this.dom.className = 'ts-raw';
    this.renderEl = document.createElement('div');
    this.renderEl.className = 'ts-raw-render';
    this.renderEl.contentEditable = 'false';
    this.dom.appendChild(this.renderEl);
    this.dom.appendChild(this.pre);

    // Click the render → caret into the source, source shown.
    this.renderEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos === undefined) return;
      this.dom.classList.add('ts-raw-editing');
      const end = pos + this.node.nodeSize - 1;
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)));
      this.view.focus();
      scheduleTypeset(this.view);
    });
    // Leaving the block → back to the compiled render.
    this.dom.addEventListener('focusout', (e) => {
      if (this.destroyed) return;
      const to = (e as FocusEvent).relatedTarget;
      if (to instanceof Node && this.dom.contains(to)) return;
      this.dom.classList.remove('ts-raw-editing');
      this.sync();
    });

    this.sync();
  }

  private isRaw(): boolean {
    return this.node.attrs.params === 'typst-raw';
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.code_block) return false;
    // Switching between raw and plain rebuilds the whole view.
    if ((node.attrs.params === 'typst-raw') !== this.isRaw()) return false;
    this.node = node;
    if (this.renderEl) this.sync();
    return true;
  }

  private sync() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.compile(), 60);
  }

  private failCount = 0;

  private async compile() {
    if (this.destroyed || !this.renderEl) return;
    try {
      const width = this.view.dom.clientWidth || 576;
      const src = fragmentSource(this.view, this.node, width);
      if (src === this.lastSrc) return;
      const { compileSvg } = await import('./pdf');
      const svg = await compileSvg(src);
      if (this.destroyed || !this.renderEl) return;
      if (!svg) {
        // Transient (compiler still warming) and permanent (bad Typst)
        // failures are indistinguishable here: retry a few times, then
        // rest as a source chip until the island is edited again.
        if (++this.failCount < 4) this.timer = window.setTimeout(() => void this.compile(), 1200);
        return;
      }
      this.failCount = 0;
      this.lastSrc = src;
      const visual = this.applySvg(svg);
      this.dom.classList.toggle('ts-raw-visual', visual);
      scheduleTypeset(this.view);
    } catch (e) {
      console.warn('raw island compile failed', e);
    }
  }

  /** Install the compiled fragment; false when it has no visible output
   *  (pure set/show/counter islands keep their source-chip look). Visible
   *  means it either paints ink (a hairline rule is sub-1pt tall but very
   *  much visible) or occupies height (#v spacers paint nothing). */
  private applySvg(svg: string | null): boolean {
    if (!svg || !this.renderEl) return false;
    this.renderEl.innerHTML = svg;
    const svgEl = this.renderEl.querySelector('svg');
    if (!svgEl) return false;
    const h = parseFloat(svgEl.getAttribute('height') ?? '0');
    const ink = !!svgEl.querySelector('path, use, image');
    if (!ink && h <= 3) {
      this.renderEl.replaceChildren();
      return false;
    }
    const w = parseFloat(svgEl.getAttribute('width') ?? '0');
    svgEl.style.width = `${(w * 4) / 3}px`;
    // A hairline's page can be sub-pixel tall (viewBox height 0) — a
    // degenerate projection the browser won't paint into. Pad the viewBox
    // a point either side so the stroke lands inside a real box.
    if (h < 1.5) {
      svgEl.setAttribute('viewBox', `0 -1 ${w} ${h + 2}`);
      svgEl.style.height = `${((h + 2) * 4) / 3}px`;
    } else {
      svgEl.style.height = `${(h * 4) / 3}px`;
    }
    svgEl.style.display = 'block';
    return true;
  }

  ignoreMutation(m: MutationRecord | { type: 'selection' }) {
    if (m.type === 'selection') return false;
    return !this.contentDOM.contains((m as MutationRecord).target);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
  }
}
