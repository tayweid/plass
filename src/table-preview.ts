// Tables in the document are their compiled selves: the node view renders
// the table through the in-app Typst (same engine, fonts, and styling as
// the PDF — including #align(center, …)) and nothing else. Clicking opens
// the table editing card (table-editor.ts), following the math-editor
// pattern: the document shows the truth, editing happens in a focused UI.
//
// A table crossing a page boundary renders as stacked crops of the paged
// mini-compile's pages (table-split.ts) with the page gap between — the
// split row, repeated headers, and strokes are Typst's own. The paginator
// assigns {layout, gaps}; the view only displays them.

import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { schema } from './schema';
import { scheduleTypeset } from './typeset-plugin';
import { openTableEditor } from './table-editor';
import { fragmentSource, getSplit, onSplitsChanged, type TableSplitLayout } from './table-split';

export class TablePreviewView implements NodeView {
  dom: HTMLElement;
  private previewEl: HTMLElement;
  private timer = 0;
  private lastSrc = '';
  private destroyed = false;
  private unsubscribe: () => void;
  /** What the preview element currently shows. */
  private shown: { layout: TableSplitLayout | null; gapsKey: string } = { layout: null, gapsKey: '' };
  private autoSvg: string | null = null;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'ts-table-block';
    this.dom.contentEditable = 'false';
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'ts-table-render';
    this.previewEl.innerHTML = '<span class="ts-table-loading">table…</span>';
    this.dom.appendChild(this.previewEl);

    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos === undefined) return;
      const tr = this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos));
      this.view.dispatch(tr);
      openTableEditor(this.view, pos);
    });

    this.unsubscribe = onSplitsChanged(() => this.render());
    this.sync();
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.table) return false;
    this.node = node;
    this.sync();
    return true;
  }

  private sync() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.compile(), 30);
  }

  private async compile() {
    if (this.destroyed) return;
    try {
      const width = this.view.dom.clientWidth || 576;
      const src = fragmentSource(this.view, this.node, width);
      if (src === this.lastSrc) return;
      const { compileSvg } = await import('./pdf');
      const svg = await compileSvg(src);
      if (this.destroyed || !svg) return;
      this.lastSrc = src;
      this.autoSvg = svg;
      this.shown = { layout: null, gapsKey: '' };
      this.render(true);
      scheduleTypeset(this.view);
    } catch (e) {
      console.warn('table compile failed', e);
    }
  }

  /** Paint the current state: split fragments when assigned, else the
   *  continuous compile. Cheap when nothing changed. */
  private render(force = false) {
    if (this.destroyed || this.autoSvg === null) return;
    const a = getSplit(this.node);
    const gapsKey = a ? a.gapsPx.map((g) => Math.round(g)).join(',') : '';
    if (!force && this.shown.layout === (a?.layout ?? null) && this.shown.gapsKey === gapsKey) return;
    this.shown = { layout: a?.layout ?? null, gapsKey };

    if (!a || a.layout.fragments.length <= 1) {
      this.previewEl.innerHTML = this.autoSvg;
      const svgEl = this.previewEl.querySelector('svg');
      if (svgEl) {
        svgEl.style.width = `${(parseFloat(svgEl.getAttribute('width') ?? '0') * 4) / 3}px`;
        svgEl.style.height = 'auto';
      }
      return;
    }

    const frag = document.createDocumentFragment();
    a.layout.fragments.forEach((f, i) => {
      if (i > 0) {
        const gap = document.createElement('div');
        gap.className = 'ts-table-pagegap';
        gap.style.height = `${a.gapsPx[i - 1] ?? 0}px`;
        frag.appendChild(gap);
      }
      const winEl = document.createElement('div');
      winEl.className = 'ts-table-frag';
      winEl.style.cssText = `overflow:hidden;height:${f.heightPx}px;`;
      const inner = document.createElement('div');
      inner.style.marginTop = `${-f.cropTopPx}px`;
      inner.innerHTML = a.layout.svg;
      const svgEl = inner.querySelector('svg');
      if (svgEl) {
        svgEl.style.width = `${a.layout.svgWidthPx}px`;
        svgEl.style.height = 'auto';
        svgEl.style.display = 'block';
      }
      winEl.appendChild(inner);
      frag.appendChild(winEl);
    });
    this.previewEl.replaceChildren(frag);
  }

  selectNode() {
    this.dom.classList.add('ts-table-selected');
  }

  deselectNode() {
    this.dom.classList.remove('ts-table-selected');
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
    clearTimeout(this.timer);
  }
}
