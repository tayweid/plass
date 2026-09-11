// Inline raw Typst: `#h(1fr)`, `#box(width: 2in, line(length: 100%))`, or
// any other Typst expression mid-sentence, from a .typ file or typed in the
// source view. An island: the node stores the source, the file keeps it
// verbatim, and the page shows it as inline code — which is also how it
// prints (`#raw(...)` in the compile). It never runs: Plass renders only
// its rails, and page and print show the same thing.

import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { schema } from './schema';

export class TypstInlineView implements NodeView {
  dom: HTMLElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('span');
    this.dom.className = 'ts-inline-raw';
    this.dom.contentEditable = 'false';
    this.dom.title = 'Raw Typst — kept in the file, shown as code, never run. Click to edit.';
    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos === undefined) return;
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
      this.view.focus();
      openInlineRawEditor(this.view, pos);
    });
    this.render();
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.typst_inline) return false;
    this.node = node;
    this.render();
    return true;
  }

  private render() {
    this.dom.textContent = this.node.attrs.src as string;
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }
}

/** The edit card: the source, nothing else — there is no preview to show,
 *  because the island prints as this very text. */
export function openInlineRawEditor(view: EditorView, pos: number) {
  document.querySelector('.inline-raw-editor')?.remove();
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type !== schema.nodes.typst_inline) return;

  const panel = document.createElement('div');
  panel.className = 'math-editor inline-raw-editor';
  panel.innerHTML = `
    <textarea class="math-editor-input" rows="2" spellcheck="false"
      placeholder="#h(1fr)  ·  #box(width: 2in, line(length: 100%))"></textarea>
    <div class="math-editor-hint">Raw Typst — kept, shown as code, never run · <kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel · <kbd>⌫</kbd> on empty removes</div>`;
  const input = panel.querySelector('.math-editor-input') as HTMLTextAreaElement;
  input.value = node.attrs.src as string;

  const coords = view.coordsAtPos(pos);
  panel.style.left = `${Math.max(8, Math.min(coords.left - 40, window.innerWidth - 400))}px`;
  panel.style.top = `${coords.bottom + 8 + window.scrollY}px`;
  document.body.appendChild(panel);

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
