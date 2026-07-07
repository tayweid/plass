// Figures: node view, insertion (toolbar / paste / drop), caption behavior.

import { Plugin, NodeSelection, TextSelection, type Command } from 'prosemirror-state';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { scheduleTypeset } from './typeset-plugin';

export class FigureView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private img: HTMLImageElement;
  private chip: HTMLButtonElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('figure');
    this.dom.className = 'ts-figure';

    this.img = document.createElement('img');
    this.img.src = node.attrs.src;
    this.img.alt = '';
    this.img.addEventListener('load', () => scheduleTypeset(this.view));
    // Click the image to select the whole figure.
    this.img.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos !== undefined) {
        this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
        this.view.focus();
      }
    });

    this.chip = document.createElement('button');
    this.chip.type = 'button';
    this.chip.className = 'fig-label-chip';
    this.chip.contentEditable = 'false';
    this.chip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.editLabel();
    });
    this.updateChip();

    this.contentDOM = document.createElement('figcaption');
    this.dom.append(this.img, this.chip, this.contentDOM);
  }

  private updateChip() {
    const label = this.node.attrs.label as string;
    this.chip.textContent = label ? `@${label}` : '+ label';
    this.chip.title = label
      ? `Reference this figure by typing @${label} — click to change`
      : 'Add a label so you can reference this figure with @label';
    this.chip.classList.toggle('empty', !label);
  }

  private editLabel() {
    const input = document.createElement('input');
    input.className = 'fig-label-input';
    input.value = this.node.attrs.label;
    input.placeholder = 'fig:label';
    input.spellcheck = false;
    this.chip.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      input.replaceWith(this.chip);
      if (commit) {
        const label = input.value.trim().replace(/[^a-zA-Z0-9:._-]/g, '-');
        const pos = this.getPos();
        if (pos !== undefined && label !== this.node.attrs.label) {
          this.view.dispatch(
            this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, label }),
          );
        }
      }
      this.view.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    if (node.attrs.src !== this.node.attrs.src) this.img.src = node.attrs.src;
    this.node = node;
    this.updateChip();
    return true;
  }

  selectNode() {
    this.dom.classList.add('figure-selected');
  }

  deselectNode() {
    this.dom.classList.remove('figure-selected');
  }

  stopEvent(e: Event) {
    // Events on the label chip/input are ours, not the editor's.
    return e.target instanceof HTMLElement && !!e.target.closest('.fig-label-chip, .fig-label-input');
  }

  ignoreMutation(m: ViewMutationRecord) {
    return !this.contentDOM.contains(m.target);
  }
}

/** Enter inside a caption exits to a fresh paragraph after the figure. */
export const exitFigure: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type !== schema.nodes.figure) return false;
  if (dispatch) {
    const after = $from.after();
    const tr = state.tr.insert(after, schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

export function insertFigureFromFile(view: EditorView, file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    const src = String(reader.result);
    const node = schema.nodes.figure.create({ src, name: file.name });
    let tr = view.state.tr.replaceSelectionWith(node);
    // Put the caret in the (empty) caption.
    let capPos = -1;
    tr.doc.descendants((n, p) => {
      if (capPos < 0 && n === node) capPos = p + 1;
      return capPos < 0;
    });
    if (capPos >= 0) tr = tr.setSelection(TextSelection.create(tr.doc, capPos));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  };
  reader.readAsDataURL(file);
}

export function pickAndInsertFigure(view: EditorView) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) insertFigureFromFile(view, file);
  });
  input.click();
}

/** Paste or drop image files to create figures. */
export function figuresPlugin() {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        for (const file of files) insertFigureFromFile(view, file);
        return true;
      },
      handleDrop(view, event) {
        const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (at) {
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
        }
        for (const file of files) insertFigureFromFile(view, file);
        return true;
      },
    },
  });
}
