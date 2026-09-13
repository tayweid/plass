// The grid rail: a block of rows × columns whose cells hold any block
// content, laid out as Typst's `#grid(columns: (…fr), gutter: …)`. Column
// widths are fraction shares (CSS `fr` and Typst `fr` divide the measure
// left after the gutters the same way), rows are atomic (`grid.cell(
// breakable: false)` on export; the paginator moves a row whole), and the
// grid breaks between rows. A cell's box is normalized to the paragraph's
// frame slack (see GridCellView) so cells of different content align at
// their frame tops as Typst aligns them, and a row's frame is the tallest
// cell's — which lets the paginator treat a row exactly like a paragraph
// block. Markdown carries a grid as a ```typst fence holding the same
// call (md-parser recognizes it).

import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import { schema } from './schema';
import { getSettings } from './settings';
import { blockFrameSlackEm } from './typ-serializer';

export const DEFAULT_GRID_GUTTER_EM = 1;

/** "2 : 1", "2 1", "2,1", "60/40" → [2, 1] / [60, 40]; null when unusable. */
export function parseColumnShares(text: string): number[] | null {
  const parts = text
    .split(/[\s:,/]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => Number(p.replace(/fr$/i, '')));
  if (!parts.length || parts.length > 12 || parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return parts.map((n) => Math.round(n * 1000) / 1000);
}

export const formatColumnShares = (columns: number[]): string => columns.map((c) => String(c)).join(' : ');

/** The nearest grid around the selection, with its position. */
export function gridContext(state: EditorState): { pos: number; node: PMNode; depth: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === schema.nodes.grid) return { pos: $from.before(d), node, depth: d };
  }
  return null;
}

const emptyCell = () => schema.nodes.grid_cell.create(null, schema.nodes.paragraph.create());

/** A fresh rows × columns grid of empty paragraphs. */
export function makeGrid(columns: number[], rows = 1, gutter = DEFAULT_GRID_GUTTER_EM): PMNode {
  const row = () => schema.nodes.grid_row.create(null, columns.map(() => emptyCell()));
  return schema.nodes.grid.create({ columns, gutter }, Array.from({ length: rows }, row));
}

/** Insert a one-row, two-column grid after the current block; the caret
 *  lands in the first cell. */
export function insertGrid(view: EditorView, columns: number[] = [1, 1]): void {
  const { $from } = view.state.selection;
  // Never inside a table cell or another grid cell: after the top-level block.
  const insertPos = $from.depth > 0 ? $from.after(1) : view.state.selection.to;
  const tr = view.state.tr.insert(insertPos, makeGrid(columns));
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 3)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Rebuild the grid at `pos` from a cell matrix (rows of cells), keeping
 *  the caret's cell where it survives. */
function replaceGrid(state: EditorState, pos: number, attrs: Record<string, unknown>, rows: PMNode[][]): Transaction {
  const old = state.doc.nodeAt(pos)!;
  const node = schema.nodes.grid.create(attrs, rows.map((cells) => schema.nodes.grid_row.create(null, cells)));
  const tr = state.tr.replaceWith(pos, pos + old.nodeSize, node);
  const target = Math.min(state.selection.from, pos + node.nodeSize - 2);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(pos + 3, target))));
  return tr;
}

const cellMatrix = (grid: PMNode): PMNode[][] => {
  const rows: PMNode[][] = [];
  grid.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((cell) => cells.push(cell));
    rows.push(cells);
  });
  return rows;
};

/** Set the column shares; a different count adds empty cells on the right
 *  or drops the rightmost columns (their content is lost — the bar says so). */
export function setGridColumns(view: EditorView, columns: number[]): boolean {
  const ctx = gridContext(view.state);
  if (!ctx) return false;
  const rows = cellMatrix(ctx.node).map((cells) => {
    const out = cells.slice(0, columns.length);
    while (out.length < columns.length) out.push(emptyCell());
    return out;
  });
  view.dispatch(replaceGrid(view.state, ctx.pos, { ...ctx.node.attrs, columns }, rows));
  view.focus();
  return true;
}

export function setGridGutter(view: EditorView, gutter: number): boolean {
  const ctx = gridContext(view.state);
  if (!ctx) return false;
  view.dispatch(view.state.tr.setNodeMarkup(ctx.pos, undefined, { ...ctx.node.attrs, gutter }));
  view.focus();
  return true;
}

export function addGridColumn(view: EditorView): boolean {
  const ctx = gridContext(view.state);
  if (!ctx) return false;
  return setGridColumns(view, [...(ctx.node.attrs.columns as number[]), 1]);
}

export function removeGridColumn(view: EditorView): boolean {
  const ctx = gridContext(view.state);
  if (!ctx || (ctx.node.attrs.columns as number[]).length < 2) return false;
  return setGridColumns(view, (ctx.node.attrs.columns as number[]).slice(0, -1));
}

export function addGridRow(view: EditorView): boolean {
  const ctx = gridContext(view.state);
  if (!ctx) return false;
  const columns = ctx.node.attrs.columns as number[];
  const rows = cellMatrix(ctx.node);
  rows.push(columns.map(() => emptyCell()));
  view.dispatch(replaceGrid(view.state, ctx.pos, ctx.node.attrs, rows));
  view.focus();
  return true;
}

export function removeGridRow(view: EditorView): boolean {
  const ctx = gridContext(view.state);
  if (!ctx || ctx.node.childCount < 2) return false;
  view.dispatch(replaceGrid(view.state, ctx.pos, ctx.node.attrs, cellMatrix(ctx.node).slice(0, -1)));
  view.focus();
  return true;
}

/** Replace the grid by its cells' blocks in reading order. */
export function unwrapGrid(view: EditorView): boolean {
  const ctx = gridContext(view.state);
  if (!ctx) return false;
  const blocks: PMNode[] = [];
  ctx.node.forEach((row) => row.forEach((cell) => cell.forEach((block) => blocks.push(block))));
  const tr = view.state.tr.replaceWith(ctx.pos, ctx.pos + ctx.node.nodeSize, Fragment.from(blocks));
  tr.setSelection(TextSelection.near(tr.doc.resolve(ctx.pos + 1)));
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Tab / Shift-Tab inside a grid: the next / previous cell in reading
 *  order; Tab from the last cell adds a row (like a table). */
export const tabInGrid = (dir: 1 | -1): Command => (state, dispatch, view) => {
  const ctx = gridContext(state);
  if (!ctx) return false;
  const cells: number[] = [];
  ctx.node.forEach((row, rowOff) => {
    row.forEach((_cell, cellOff) => cells.push(ctx.pos + 1 + rowOff + 1 + cellOff));
  });
  const here = state.selection.$from;
  let idx = -1;
  for (let d = here.depth; d > 0; d--) {
    if (here.node(d).type === schema.nodes.grid_cell && here.before(d) >= ctx.pos) {
      idx = cells.indexOf(here.before(d));
      break;
    }
  }
  if (idx < 0) return false;
  const target = idx + dir;
  if (target < 0) return true;
  if (target >= cells.length) {
    if (view && addGridRow(view)) {
      const next = gridContext(view.state);
      if (next) {
        const lastRow = next.node.child(next.node.childCount - 1);
        const rowPos = next.pos + next.node.nodeSize - 1 - lastRow.nodeSize;
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(rowPos + 2))));
      }
    }
    return true;
  }
  if (dispatch) {
    const cellPos = cells[target];
    const cell = state.doc.nodeAt(cellPos)!;
    const $to = dir > 0 ? state.doc.resolve(cellPos + 1) : state.doc.resolve(cellPos + cell.nodeSize - 1);
    dispatch(state.tr.setSelection(TextSelection.near($to, dir)).scrollIntoView());
  }
  return true;
};

// ---------------------------------------------------------------------------
// Cell frames

const LEAF_TAGS = new Set(['UL', 'OL', 'LI', 'BLOCKQUOTE']);

/** A cell's first / last leaf block: descend through list and quote
 *  containers, in the node and in its DOM. */
function leafOf(node: PMNode, el: Element | null, last: boolean): { node: PMNode; el: Element } | null {
  let n: PMNode | null = last ? node.lastChild : node.firstChild;
  let e: Element | null = last ? el?.lastElementChild ?? null : el?.firstElementChild ?? null;
  while (n && e && LEAF_TAGS.has(e.tagName) && n.childCount) {
    n = last ? n.lastChild : n.firstChild;
    e = last ? e.lastElementChild : e.firstElementChild;
  }
  return n && e ? { node: n, el: e } : null;
}

/**
 * A grid cell. Its box is normalized so that, whatever block starts or
 * ends it, the box begins one paragraph slack above the content's Typst
 * frame and ends one paragraph inset below it: a paragraph-first cell keeps
 * its own line box, a table-first cell drops the table's block margin, a
 * heading-first cell shifts by the heading's larger ascent. Then every
 * cell in a row shares frame top and the tallest frame sets the row (as
 * Typst's grid aligns cells), and the paginator can fit a row with the
 * paragraph's adjust and inset. The margins are re-measured whenever the
 * cell's content changes; reading two rects is the whole cost.
 */
export class GridCellView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private pending = false;

  constructor(node: PMNode, private view: EditorView) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'ts-grid-cell';
    this.contentDOM = this.dom;
    this.schedule();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.schedule();
    return true;
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    return m.type === 'attributes' && m.target === this.dom;
  }

  private schedule() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.fit();
    });
  }

  private fit() {
    if (!this.dom.isConnected) return;
    const s = getSettings(this.view.state);
    const F = parseFloat(getComputedStyle(this.view.dom).fontSize) || 16.67;
    const box = this.dom.getBoundingClientRect();
    const first = leafOf(this.node, this.contentDOM, false);
    const last = leafOf(this.node, this.contentDOM, true);
    if (!first || !last || box.height === 0) return;
    const ref = blockFrameSlackEm(schema.nodes.paragraph.create(), s);
    const above = blockFrameSlackEm(first.node, s).above;
    const below = blockFrameSlackEm(last.node, s).below;
    const extraAbove = first.el.getBoundingClientRect().top - box.top;
    const extraBelow = box.bottom - last.el.getBoundingClientRect().bottom;
    const marginTop = ref.above * F - (extraAbove + above * F);
    const marginBottom = ref.below * F - (extraBelow + below * F);
    const top = `${marginTop.toFixed(3)}px`;
    const bottom = `${marginBottom.toFixed(3)}px`;
    if (this.dom.style.marginTop !== top) this.dom.style.marginTop = top;
    if (this.dom.style.marginBottom !== bottom) this.dom.style.marginBottom = bottom;
  }
}

// ---------------------------------------------------------------------------
// The grid bar: docked under the toolbar while the caret is in a grid.

const gridBarKey = new PluginKey('grid-bar');

class GridBar {
  private root: HTMLElement;
  private columnsInput: HTMLInputElement;
  private gutterInput: HTMLInputElement;
  private removeColumn: HTMLButtonElement;
  private removeRow: HTMLButtonElement;
  private signature = '';

  constructor(private view: EditorView) {
    this.root = document.createElement('div');
    this.root.className = 'native-table-toolbar grid-toolbar';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Grid controls');
    this.root.hidden = true;
    const main = document.createElement('div');
    main.className = 'native-table-toolbar-main';
    this.root.appendChild(main);
    const group = () => {
      const g = document.createElement('div');
      g.className = 'native-table-toolbar-group';
      main.appendChild(g);
      return g;
    };
    const button = (parent: HTMLElement, label: string, title: string, run: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', run);
      parent.appendChild(b);
      return b;
    };
    const field = (parent: HTMLElement, label: string, title: string, width: string) => {
      const wrap = document.createElement('label');
      wrap.className = 'grid-toolbar-field';
      wrap.title = title;
      const span = document.createElement('span');
      span.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.style.width = width;
      wrap.append(span, input);
      parent.appendChild(wrap);
      return input;
    };
    const g1 = group();
    const name = document.createElement('span');
    name.className = 'grid-toolbar-name';
    name.textContent = 'Grid';
    g1.appendChild(name);
    this.columnsInput = field(g1, 'Columns', 'Column shares, e.g. 2 : 1 or 1 : 1 : 1 (Typst fr units) — Enter applies', '72px');
    this.columnsInput.addEventListener('change', () => {
      const shares = parseColumnShares(this.columnsInput.value);
      if (shares) setGridColumns(this.view, shares);
      else this.columnsInput.value = formatColumnShares((gridContext(this.view.state)?.node.attrs.columns as number[]) ?? [1, 1]);
    });
    this.columnsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.columnsInput.blur();
      }
    });
    this.gutterInput = field(g1, 'Gutter (em)', 'Space between columns and rows, in em', '40px');
    this.gutterInput.addEventListener('change', () => {
      const v = parseFloat(this.gutterInput.value);
      if (Number.isFinite(v) && v >= 0 && v <= 10) setGridGutter(this.view, Math.round(v * 100) / 100);
      else this.gutterInput.value = String(gridContext(this.view.state)?.node.attrs.gutter ?? DEFAULT_GRID_GUTTER_EM);
    });
    this.gutterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.gutterInput.blur();
      }
    });
    const g2 = group();
    button(g2, '+ Column', 'Add a column on the right', () => addGridColumn(this.view));
    this.removeColumn = button(g2, '− Column', 'Remove the rightmost column (its content is dropped)', () => removeGridColumn(this.view));
    button(g2, '+ Row', 'Add a row at the bottom', () => addGridRow(this.view));
    this.removeRow = button(g2, '− Row', 'Remove the bottom row (its content is dropped)', () => removeGridRow(this.view));
    const g3 = group();
    button(g3, 'Unwrap', 'Replace the grid by its blocks, in reading order', () => unwrapGrid(this.view));
    document.body.appendChild(this.root);
    this.update(view);
  }

  update(view: EditorView): void {
    const ctx = gridContext(view.state);
    if (!ctx) {
      this.root.hidden = true;
      this.signature = '';
      return;
    }
    const columns = ctx.node.attrs.columns as number[];
    const gutter = ctx.node.attrs.gutter as number;
    const signature = `${ctx.pos}:${columns.join(',')}:${gutter}:${ctx.node.childCount}`;
    this.root.hidden = false;
    if (signature === this.signature) return;
    this.signature = signature;
    if (document.activeElement !== this.columnsInput) this.columnsInput.value = formatColumnShares(columns);
    if (document.activeElement !== this.gutterInput) this.gutterInput.value = String(gutter);
    this.removeColumn.disabled = columns.length < 2;
    this.removeRow.disabled = ctx.node.childCount < 2;
  }

  destroy(): void {
    this.root.remove();
  }
}

export function gridPlugin(): Plugin {
  return new Plugin({
    key: gridBarKey,
    view(view) {
      const bar = new GridBar(view);
      return { update: (v) => bar.update(v), destroy: () => bar.destroy() };
    },
  });
}
