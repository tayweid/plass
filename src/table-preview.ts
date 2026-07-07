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

/** Fragment source: the document header (fonts, mitex) + a content-hugging
 * page. Cell bodies are link-wrapped (see TypExportOptions.cellLinks) so the
 * compiled SVG exposes per-cell hit geometry. */
function fragmentSource(view: EditorView, node: PMNode, widthPx: number): string {
  const doc = schema.nodes.doc.create({ settings: view.state.doc.attrs.settings, bib: null }, [node]);
  const src = docToTyp(doc, { cellLinks: true });
  return src.replace(
    /#set page\([^)]*\)/,
    `#set page(width: ${(widthPx * 0.75).toFixed(2)}pt, height: auto, margin: 0pt)`,
  );
}

/** Cell at (rowIndex, cellIndex-within-row): [absPos, cell] or null. */
function cellAt(tablePos: number, table: PMNode, r: number, c: number): [number, PMNode] | null {
  if (r >= table.childCount) return null;
  const row = table.child(r);
  if (c >= row.childCount) return null;
  let rowOff = 0;
  for (let i = 0; i < r; i++) rowOff += table.child(i).nodeSize;
  let cellOff = 0;
  for (let i = 0; i < c; i++) cellOff += row.child(i).nodeSize;
  return [tablePos + 1 + rowOff + 1 + cellOff, row.child(c)];
}

/** Popover-editable: exactly one paragraph of plain (unmarked) text. */
function isPlainCell(cell: PMNode): boolean {
  if (cell.childCount !== 1 || cell.child(0).type !== schema.nodes.paragraph) return false;
  let plain = true;
  cell.child(0).forEach((n) => {
    if (!n.isText || n.marks.length) plain = false;
  });
  return plain;
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
    this.previewEl.title = 'Click a cell to edit it in place · double-click for the structural editor';
    this.previewEl.addEventListener('mousedown', (e) => {
      // Cells handle their own clicks; the background is inert on single click.
      e.preventDefault();
    });
    this.previewEl.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos !== undefined) {
        // Explicit request for the DOM form (structural surgery, rich content).
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
    this.buildHitOverlay();
    scheduleTypeset(this.view);
  }

  /** Transparent per-cell hit regions over the compiled SVG. */
  private buildHitOverlay() {
    for (const old of this.previewEl.querySelectorAll('.ts-cell-hit')) old.remove();
    const base = this.previewEl.getBoundingClientRect();
    for (const a of this.previewEl.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? '';
      const m = /^cell:\/\/(\d+)-(\d+)$/.exec(href);
      if (!m) continue;
      const r = a.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const hit = document.createElement('div');
      hit.className = 'ts-cell-hit';
      hit.dataset.rc = `${m[1]}-${m[2]}`;
      hit.style.left = `${r.left - base.left - 3}px`;
      hit.style.top = `${r.top - base.top - 2}px`;
      hit.style.width = `${r.width + 6}px`;
      hit.style.height = `${r.height + 4}px`;
      hit.title = 'Click to edit this cell';
      const rr = parseInt(m[1], 10);
      const cc = parseInt(m[2], 10);
      hit.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openCellEditor(rr, cc);
      });
      this.previewEl.appendChild(hit);
    }
  }

  /** Floating editor for one cell, anchored to its compiled position. */
  private openCellEditor(r: number, c: number) {
    const pos = this.getPos();
    if (pos === undefined) return;
    const table = this.view.state.doc.nodeAt(pos);
    if (!table) return;
    const found = cellAt(pos, table, r, c);
    if (!found) return;
    const [cellPos, cell] = found;

    // Rich cells (math, marks, refs) need the full editor.
    if (!isPlainCell(cell)) {
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(cellPos + 1), 1)));
      this.view.focus();
      return;
    }

    const hit = this.previewEl.querySelector<HTMLElement>(`.ts-cell-hit[data-rc="${r}-${c}"]`);
    const anchor = (hit ?? this.previewEl).getBoundingClientRect();

    // Park the (invisible) selection in this cell so the toolbar's table
    // commands are live; suppress keeps the DOM form hidden meanwhile.
    this.view.dispatch(
      this.view.state.tr
        .setSelection(TextSelection.near(this.view.state.doc.resolve(cellPos + 1), 1))
        .setMeta(tableEditingMark, 'suppress-on'),
    );

    document.querySelector('.ts-cell-editor')?.remove();
    const input = document.createElement('input');
    input.className = 'ts-cell-editor';
    input.spellcheck = false;
    input.value = cell.textContent;
    input.style.left = `${anchor.left + window.scrollX - 2}px`;
    input.style.top = `${anchor.top + window.scrollY - 3}px`;
    input.style.width = `${Math.max(anchor.width + 36, 110)}px`;
    document.body.appendChild(input);

    let closed = false;
    const finish = (mode: 'exit' | 'chain' | 'blur') => {
      if (closed) return;
      closed = true;
      input.remove();
      const state = this.view.state;
      if (mode === 'exit') {
        const t = state.doc.nodeAt(pos);
        const after = t ? pos + t.nodeSize : pos;
        this.view.dispatch(
          state.tr
            .setSelection(TextSelection.near(state.doc.resolve(after), 1))
            .setMeta(tableEditingMark, 'suppress-off'),
        );
      } else if (mode === 'blur') {
        // Selection stays in the cell: the DOM form takes over (structural op).
        this.view.dispatch(state.tr.setMeta(tableEditingMark, 'suppress-off'));
      }
    };
    const commit = (): boolean => {
      if (closed) return false;
      const table2 = this.view.state.doc.nodeAt(pos);
      const found2 = table2 && cellAt(pos, table2, r, c);
      if (!found2) return false;
      const [cp, cn] = found2;
      const text = input.value;
      if (text !== cn.textContent) {
        const para = schema.nodes.paragraph.create(null, text ? [schema.text(text)] : []);
        this.view.dispatch(this.view.state.tr.replaceWith(cp + 1, cp + cn.nodeSize - 1, para));
      }
      return true;
    };

    const step = (back: boolean): [number, number] | null => {
      const t = this.view.state.doc.nodeAt(pos);
      if (!t) return null;
      let [nr, nc] = [r, c + (back ? -1 : 1)];
      while (nr >= 0 && nr < t.childCount) {
        const rowLen = t.child(nr).childCount;
        if (nc >= 0 && nc < rowLen) return [nr, nc];
        if (back) {
          nr--;
          nc = nr >= 0 ? t.child(nr).childCount - 1 : 0;
        } else {
          nr++;
          nc = 0;
        }
      }
      return null;
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        finish('exit');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish('exit');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const next = step(e.shiftKey);
        commit();
        finish('chain');
        // Reopen on the neighbor using current geometry (it shifts only
        // slightly; the overlay refreshes after the recompile).
        if (next) setTimeout(() => this.openCellEditor(next[0], next[1]), 30);
        else finish('exit');
      }
    });
    input.addEventListener('blur', () => {
      // Toolbar table commands blur the input: commit and hand over to the
      // DOM form so the structural operation lands visibly.
      commit();
      finish('blur');
    });
    input.focus();
    input.select();
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

/**
 * Marks the table containing the caret so CSS reveals the editable DOM form —
 * unless the floating cell editor owns the selection ("suppressed"), in which
 * case the compiled preview stays the only visible representation while the
 * toolbar's table commands remain live against the hidden selection.
 */
interface MarkState {
  decos: DecorationSet;
  suppress: number | null; // table pos whose DOM reveal is suppressed
}

export const tableEditingMark = new PluginKey<MarkState>('tableEditingMark');

function enclosingTablePos(state: import('prosemirror-state').EditorState): [number, PMNode] | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.table) return [$from.before(d), $from.node(d)];
  }
  return null;
}

export function tablePreviewPlugin() {
  const compute = (state: import('prosemirror-state').EditorState, suppress: number | null): MarkState => {
    const found = enclosingTablePos(state);
    if (!found) return { decos: DecorationSet.empty, suppress: null };
    const [pos, node] = found;
    if (suppress === pos) return { decos: DecorationSet.empty, suppress };
    return {
      decos: DecorationSet.create(state.doc, [
        Decoration.node(pos, pos + node.nodeSize, { 'data-editing': 'true' }),
      ]),
      suppress: null,
    };
  };
  return new Plugin<MarkState>({
    key: tableEditingMark,
    state: {
      init: (_, state) => compute(state, null),
      apply(tr, val, _old, newState) {
        let suppress = val.suppress === null ? null : tr.mapping.map(val.suppress);
        const meta = tr.getMeta(tableEditingMark) as 'suppress-on' | 'suppress-off' | undefined;
        if (meta === 'suppress-off') suppress = null;
        if (meta === 'suppress-on') {
          const found = enclosingTablePos(newState);
          suppress = found ? found[0] : null;
        }
        return compute(newState, suppress);
      },
    },
    props: {
      decorations(state) {
        return tableEditingMark.getState(state)?.decos;
      },
    },
  });
}
