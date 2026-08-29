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
import { NodeSelection, Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView, NodeView } from 'prosemirror-view';
import { schema } from './schema';
import { fragmentSource } from './table-split';
import { scheduleTypeset } from './typeset-plugin';
import { mountTypstSvg } from './safe-svg';

/** Which island holds the caret — the ONLY thing that decides source vs
 *  render. Focus can't tell us: the caret moves between blocks without
 *  ever leaving the editor's contenteditable root, so focus events never
 *  fire. A selection-driven node decoration tracks it exactly, through
 *  clicks, arrow keys, undo, and programmatic selection alike. */
export function rawIslandPlugin(): Plugin {
  const isRaw = (n: PMNode) => n.type === schema.nodes.code_block && n.attrs.params === 'typst-raw';
  return new Plugin({
    props: {
      decorations(state) {
        const sel = state.selection;
        if (sel instanceof NodeSelection && isRaw(sel.node)) {
          return DecorationSet.create(state.doc, [
            Decoration.node(sel.from, sel.from + sel.node.nodeSize, { class: 'ts-raw-editing' }),
          ]);
        }
        const { $from } = sel;
        for (let d = $from.depth; d > 0; d--) {
          if (isRaw($from.node(d))) {
            return DecorationSet.create(state.doc, [
              Decoration.node($from.before(d), $from.after(d), { class: 'ts-raw-editing' }),
            ]);
          }
        }
        return DecorationSet.empty;
      },
    },
  });
}

export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private renderEl: HTMLElement | null = null;
  private pre: HTMLElement;
  private timer = 0;
  private lastSrc = '';
  private destroyed = false;
  private generation = 0;

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

    // Click the render → caret into the source. The plugin's decoration
    // does the rest (and puts the render back when the caret leaves).
    this.renderEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos === undefined) return;
      const end = pos + this.node.nodeSize - 1;
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)));
      this.view.focus();
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
    this.failCount = 0;
    const generation = ++this.generation;
    this.timer = window.setTimeout(() => void this.compile(generation), 60);
  }

  private failCount = 0;

  private async compile(generation: number) {
    if (this.destroyed || generation !== this.generation || !this.renderEl) return;
    try {
      const width = this.view.dom.clientWidth || 576;
      const src = fragmentSource(this.view, this.node, width);
      if (src === this.lastSrc) return;
      const { compileSvg } = await import('./pdf');
      if (this.destroyed || generation !== this.generation || !this.renderEl) return;
      const svg = await compileSvg(src);
      if (this.destroyed || generation !== this.generation || !this.renderEl) return;
      if (!svg) {
        // Transient (compiler still warming) and permanent (bad Typst)
        // failures are indistinguishable here: retry a few times, then
        // rest as a source chip until the island is edited again.
        if (++this.failCount < 4) {
          this.timer = window.setTimeout(() => void this.compile(generation), 1200);
        }
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
    const svgEl = mountTypstSvg(this.renderEl, svg);
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
    this.generation++;
    clearTimeout(this.timer);
  }
}
