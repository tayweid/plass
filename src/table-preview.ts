// True WYSIWYG for custom-styled tables: when a table carries raw Typst
// arguments (the Opts escape hatch), the DOM cannot reproduce its styling —
// so we compile *just that table* with the in-app Typst compiler and show
// the compiled SVG in place. The editable DOM table is the editing mode:
// click the preview (or move the caret in) and it flips to the DOM form;
// leave, and the freshly compiled preview returns. Same page, same fonts,
// same engine as the PDF — pixel truth instead of approximation.

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { docToTyp } from './typ-serializer';
import { scheduleTypeset } from './typeset-plugin';

/** Preview only when the DOM look would lie (custom params present). */
function wantsPreview(node: PMNode): boolean {
  if (!(node.attrs.params as string)?.trim()) return false;
  // Citations/references need document context the fragment lacks.
  let ok = true;
  node.descendants((n) => {
    if (n.type.name === 'citation' || n.type.name === 'eq_ref' || n.type.name === 'footnote') ok = false;
    return ok;
  });
  return ok;
}

/** Fragment source: the document header (fonts, mitex) + a content-hugging page. */
function fragmentSource(view: EditorView, node: PMNode, widthPx: number): string {
  const doc = schema.nodes.doc.create({ settings: view.state.doc.attrs.settings, bib: null }, [node]);
  const src = docToTyp(doc);
  return src.replace(/#set page\([^)]*\)/, `#set page(width: ${(widthPx * 0.75).toFixed(2)}pt, height: auto, margin: 0pt)`);
}

export class TablePreviewView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private tableEl: HTMLTableElement;
  private previewEl: HTMLElement;
  private lastSrc = '';
  private timer = 0;
  private destroyed = false;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'ts-table-wrap';
    this.tableEl = document.createElement('table');
    this.contentDOM = document.createElement('tbody');
    this.tableEl.appendChild(this.contentDOM);
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'ts-table-preview';
    this.previewEl.contentEditable = 'false';
    this.previewEl.setAttribute('aria-hidden', 'true');
    this.previewEl.title = 'Typst-compiled preview — click to edit';
    this.previewEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos !== undefined) {
        // Enter the first cell; the editing decoration hides the preview.
        this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(pos + 1), 1)));
        this.view.focus();
      }
    });
    this.dom.append(this.tableEl, this.previewEl);
    this.sync();
  }

  private sync() {
    this.tableEl.className = `ts-table-${this.node.attrs.style}`;
    this.tableEl.setAttribute('data-style', this.node.attrs.style as string);
    if (!wantsPreview(this.node)) {
      this.dom.classList.remove('has-preview');
      this.previewEl.replaceChildren();
      this.lastSrc = '';
      return;
    }
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.compile(), 250);
  }

  private async compile() {
    if (this.destroyed) return;
    const measure = this.dom.clientWidth || 576;
    const src = fragmentSource(this.view, this.node, measure);
    if (src === this.lastSrc) return;
    this.lastSrc = src;
    const { compileSvg } = await import('./pdf');
    const svg = await compileSvg(src);
    if (this.destroyed || src !== this.lastSrc) return; // superseded
    if (!svg) {
      this.dom.classList.remove('has-preview');
      return;
    }
    this.previewEl.innerHTML = svg;
    const el = this.previewEl.querySelector('svg');
    if (el) {
      const w = parseFloat(el.getAttribute('width') ?? '0');
      if (w > 0) el.style.width = `${(w * 4) / 3}px`;
      el.style.height = 'auto';
      el.style.maxWidth = '100%';
    }
    this.dom.classList.add('has-preview');
    scheduleTypeset(this.view);
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.table) return false;
    const changed = node !== this.node;
    this.node = node;
    if (changed) this.sync();
    return true;
  }

  ignoreMutation(m: ViewMutationRecord) {
    if (m.type === 'attributes') return true;
    return !this.contentDOM.contains(m.target);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
  }
}

/** Marks the table containing the caret so CSS shows the editable form. */
export const tableEditingMark = new PluginKey<DecorationSet>('tableEditingMark');

export function tablePreviewPlugin() {
  const build = (state: import('prosemirror-state').EditorState) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === schema.nodes.table) {
        const pos = $from.before(d);
        return DecorationSet.create(state.doc, [
          Decoration.node(pos, pos + $from.node(d).nodeSize, { 'data-editing': 'true' }),
        ]);
      }
    }
    return DecorationSet.empty;
  };
  return new Plugin({
    key: tableEditingMark,
    state: {
      init: (_, state) => build(state),
      apply: (_tr, _val, _old, newState) => build(newState),
    },
    props: {
      decorations(state) {
        return tableEditingMark.getState(state);
      },
    },
  });
}
