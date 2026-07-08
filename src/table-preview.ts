// Tables in the document are their compiled selves: the node view renders
// the table through the in-app Typst (same engine, fonts, and styling as
// the PDF — including #align(center, …)) and nothing else. Clicking opens
// the table editing card (table-editor.ts), following the math-editor
// pattern: the document shows the truth, editing happens in a focused UI.

import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { schema } from './schema';
import { docToTyp } from './typ-serializer';
import { scheduleTypeset } from './typeset-plugin';
import { openTableEditor } from './table-editor';

function fragmentSource(view: EditorView, node: PMNode, widthPx: number): string {
  const doc = schema.nodes.doc.create({ settings: view.state.doc.attrs.settings, bib: null }, [node]);
  const src = docToTyp(doc);
  return src.replace(
    /#set page\([^)]*\)/,
    `#set page(width: ${(widthPx * 0.75).toFixed(2)}pt, height: auto, margin: 0pt)`,
  );
}

export class TablePreviewView implements NodeView {
  dom: HTMLElement;
  private previewEl: HTMLElement;
  private timer = 0;
  private lastSrc = '';
  private destroyed = false;

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
      this.previewEl.innerHTML = svg;
      const svgEl = this.previewEl.querySelector('svg');
      if (svgEl) {
        svgEl.style.width = `${(parseFloat(svgEl.getAttribute('width') ?? '0') * 4) / 3}px`;
        svgEl.style.height = 'auto';
      }
      scheduleTypeset(this.view);
    } catch (e) {
      console.warn('table compile failed', e);
    }
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
    clearTimeout(this.timer);
  }
}
