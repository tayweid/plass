// The block pill: the controls of the table or grid the caret is in, a
// small dark column of rail tiles in the page's left margin, level with
// the block. The design and its rules: docs/BLOCK-CHROME.md ("spec §n"
// below names a section of the approved design spec it records).
//
// Layer. One #block-chrome inside #scroll, after #paper, in the panel's
// scroll-content coordinates: it scrolls with the page natively, is
// clipped by the panel, and is outside the paper's transform, so a tile is
// 32 px at every paper scale. A .block-track spans the block (its top to
// its bottom) and the pill inside it is `position: sticky`: it starts
// level with the block's first line, rides down a tall block as the panel
// scrolls, and stops at the block's bottom. There is no scroll handler.
//
// Place. In the margin, its right edge 14 px left of the text column
// (compact: 8 px, or further to clear a grid's selection outline, 34
// px wide, for a 46–60 px margin; under 46 px one ⋯
// tile at the paper's edge); a narrow centred block pulls it in to hug the
// block's left edge, and then its captions and flyouts open to the left,
// into the empty margin (decision 3). A table in a grid cell owns the pill
// (the innermost block does) and adds one Grid tile for its grid.
//
// The hot path. The pill is placed when the selection enters a block, when
// a block's structure changes (a row, a column, an attribute), after a
// pagination pass, and on a resize — never for a keystroke: typing in a
// cell reads no geometry and writes no style here. The first keystroke
// after the pill appears dims it (a class), and moving to another cell, a
// hover, focus or an open flyout restores it.
//
// Menus and panels are the rail's dark glass (.tb-menu, .tb-menu-extras),
// placed by flyout.ts beside the pill, and run the tables' own commands
// (table-editor.ts, prosemirror-tables) and the grids' caret commands
// (grid-editor.ts). Every tile and item swallows mousedown, so the editor
// keeps its selection.

import './block-chrome.css';
import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey, type Command, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { redo, undo } from 'prosemirror-history';
import { CellSelection, deleteTable, isInTable, mergeCells, selectedRect, setCellAttr, splitCell, toggleHeaderRow } from 'prosemirror-tables';
import { schema } from './schema';
import { icon } from './toolbar';
import { placeFlyout } from './flyout';
import { notify } from './notify';
import { onPaperScale, paperScale } from './paper-scale';
import { pickAndInsertFigure } from './figures';
import { cellSelectionFor, restoreCell, setPillFocuser } from './block-keys';
import { normalizeTableColumns, tableInsetPt } from './table-geometry';
import {
  alignSelectedTableCells,
  deleteSelectedColumns,
  deleteSelectedRows,
  focusTable,
  insertTableColumn,
  insertTableRow,
  normalizeTableLabel,
  resetTableColumnWidths,
  selectTableLine,
  selectedCellsAttr,
  selectedColumnWidth,
  selectedRowIsHeader,
  selectedTableRows,
  setRowRule,
  setSelectedColumnWidth,
  setTableAttrsAt,
  setTableStyle,
  tableControlsRevision,
} from './table-editor';
import {
  DEFAULT_GRID_GUTTER_EM,
  deleteGridColumnAt,
  deleteGridRowAt,
  gridCaretPlace,
  gridCellAttr,
  gridContext,
  gridSelectionSpansCells,
  insertGridColumnAt,
  insertGridRowAt,
  mergeGridCells,
  setGridColumns,
  setGridCellAttr,
  setGridGutter,
  splitGridCell,
  unwrapGrid,
} from './grid-editor';
import { canonicalShares, displayColumnShares, parseColumnShares, sameSplit, splitPresets } from './grid-split';
import type { RowRule } from './table-rules';

// ---------------------------------------------------------------------------
// The block under the selection (model only: this runs for every keystroke)

type Kind = 'table' | 'grid';

interface BlockContext {
  kind: Kind;
  /** The innermost table or grid: it owns the pill. */
  pos: number;
  node: PMNode;
  /** The outermost one, whose left edge a hugging pill keeps clear of. */
  outerPos: number;
  /** A table inside a grid cell: the pill adds the grid's tile. */
  parentGrid: { pos: number; node: PMNode } | null;
}

const isBlock = (node: PMNode) => node.type.spec.tableRole === 'table' || node.type === schema.nodes.grid;

function blockContext(state: EditorState): BlockContext | null {
  const selection = state.selection;
  const found: Array<{ pos: number; node: PMNode }> = [];
  // A table or grid node-selected (Escape from a cell, a click on its edge).
  if (selection instanceof NodeSelection && isBlock(selection.node)) found.push({ pos: selection.from, node: selection.node });
  const $pos = selection instanceof CellSelection ? selection.$anchorCell : selection.$from;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (isBlock(node)) found.push({ pos: $pos.before(depth), node });
  }
  if (!found.length) return null;
  const inner = found[0];
  const kind: Kind = inner.node.type === schema.nodes.grid ? 'grid' : 'table';
  const parent = kind === 'table' ? found.slice(1).find((f) => f.node.type === schema.nodes.grid) ?? null : null;
  return { kind, pos: inner.pos, node: inner.node, outerPos: found[found.length - 1].pos, parentGrid: parent };
}

/** Which cell the caret is in, at the granularity that changes what the
 *  tiles show (the Align glyph, the readout, the dim). */
function caretSignature(state: EditorState): string {
  const selection = state.selection;
  if (selection instanceof CellSelection) return `c${selection.$anchorCell.pos}:${selection.$headCell.pos}`;
  if (selection instanceof NodeSelection) return `n${selection.from}`;
  const $head = selection.$head;
  for (let depth = $head.depth; depth > 0; depth--) {
    const role = $head.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell' || $head.node(depth).type === schema.nodes.grid_cell) return `t${$head.before(depth)}`;
  }
  return 'x';
}

/** A table whose width follows its text (any `auto` column; no widths at
 *  all is every column auto): typing in it can widen a centred table to
 *  the left, under a pill hugging its old edge. */
function mayWiden(node: PMNode): boolean {
  if (node.type.spec.tableRole !== 'table') return false;
  const tracks = normalizeTableColumns(node.attrs.columnWidths);
  return !tracks || tracks.includes('auto');
}

const gridKey = (node: PMNode) => {
  // The cells' alignments too: the Align tile shows the caret cell's.
  let cells = '';
  node.forEach((row) => row.forEach((cell) => { cells += `${(cell.attrs.align as string | null)?.[0] ?? '-'}${(cell.attrs.valign as string | null)?.[0] ?? '-'}`; }));
  return `${(node.attrs.columns as number[]).join(',')}/${node.attrs.gutter}/${node.childCount}/${cells}`;
};

/** Changes only when the block's structure or attributes do: never for a
 *  character typed in a cell (table-editor.ts's revision ignores text). */
function structureKey(state: EditorState, ctx: BlockContext): string {
  const own = ctx.kind === 'grid' ? gridKey(ctx.node) : `r${tableControlsRevision(state)}`;
  return `${ctx.kind}@${ctx.pos}:${own}${ctx.parentGrid ? `|g${ctx.parentGrid.pos}:${gridKey(ctx.parentGrid.node)}` : ''}`;
}

// ---------------------------------------------------------------------------
// Tiles

type Layout = 'table' | 'grid' | 'nested' | 'collapsed';
type Mode = 'full' | 'compact' | 'collapsed';
type FlyoutId = 'rows' | 'cols' | 'align' | 'cell' | 'table' | 'grid' | 'gridparent' | 'gridrows' | 'gridcols' | 'gridlayout' | 'more';

interface TileSpec {
  id: string;
  glyph: string;
  caption: string;
  kbd?: string;
  flyout?: FlyoutId;
  action?: () => void;
  popup?: 'menu' | 'dialog';
}

const ALIGN_NAME: Record<string, string> = { left: 'Left', center: 'Center', right: 'Right', decimal: 'Decimal' };

/** Set an attribute only when it changes (no mutation for a same value). */
function setAttr(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setText(element: Element, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

const MARGIN_FULL = 60;
/** Quiet time after a keystroke before a stepped-back pill hugs again. */
const TYPING_PAUSE = 450;
const MARGIN_COMPACT = 46;
/** Screen px between the pill and a grid's selection outline, which
 *  reaches 0.45em + 2 px past its box (style.css: round its washes), so
 *  with a large font or scale the compact pill, 8 px from the text, would
 *  touch it. A table's outline is in screen px (4 + 2) and fits inside
 *  both gaps as they are. The pill keeps this place whether or not the
 *  block is selected, so Escape never moves it. */
const OUTLINE_CLEAR = 4;
const GRID_OUTLINE_OFFSET_EM = 0.45;
/** Quiet time after a keystroke in Caption or Label before it is written. */
const CAPTION_PAUSE = 250;

/** The grid gutter presets (em). */
const GUTTER_PRESETS: ReadonlyArray<readonly [string, string]> = [['0', 'None'], ['0.5', 'Tight'], ['1', 'Normal'], ['1.5', 'Wide']];

/** Table style thumbnails: white paper tiles with each style's rules. */
const CELLS = (rows: number[]) => `<g fill="#c4c4c4">${rows.map((y) => `<rect x="2" y="${y}" width="14" height="2.6" rx="1"/><rect x="24" y="${y}" width="14" height="2.6" rx="1"/>`).join('')}</g>`;
const TABLE_STYLE_THUMBS: ReadonlyArray<readonly ['booktabs' | 'grid' | 'plain', string, string]> = [
  ['booktabs', 'Booktabs', `<svg viewBox="0 0 40 22" aria-hidden="true"><line x1="0" y1=".8" x2="40" y2=".8" stroke="#1a1a1a" stroke-width="1.4"/><line x1="0" y1="7.5" x2="40" y2="7.5" stroke="#1a1a1a" stroke-width=".7"/>${CELLS([10.5, 15.5])}<line x1="0" y1="21.2" x2="40" y2="21.2" stroke="#1a1a1a" stroke-width="1.4"/></svg>`],
  ['grid', 'Grid', `<svg viewBox="0 0 40 22" aria-hidden="true"><rect x=".4" y=".4" width="39.2" height="21.2" fill="none" stroke="#1a1a1a" stroke-width=".7"/><line x1="0" y1="7.5" x2="40" y2="7.5" stroke="#1a1a1a" stroke-width=".7"/><line x1="0" y1="14.6" x2="40" y2="14.6" stroke="#1a1a1a" stroke-width=".7"/><line x1="20" y1="0" x2="20" y2="22" stroke="#1a1a1a" stroke-width=".7"/><g fill="#c4c4c4"><rect x="3" y="9.8" width="12" height="2.6" rx="1"/><rect x="23" y="9.8" width="12" height="2.6" rx="1"/><rect x="3" y="16.9" width="12" height="2.6" rx="1"/><rect x="23" y="16.9" width="12" height="2.6" rx="1"/></g></svg>`],
  ['plain', 'Plain', `<svg viewBox="0 0 40 22" aria-hidden="true">${CELLS([2.6, 9.7, 16.8])}</svg>`],
];

// ---------------------------------------------------------------------------
// Flyouts

interface OpenFlyout {
  id: FlyoutId;
  el: HTMLElement;
  tile: HTMLButtonElement;
  sync: () => void;
  cleanup: () => void;
  parent?: FlyoutId;
  side: 'end' | 'start';
}

/** What builds a flyout's content: its syncs keep the checked states and
 *  values current while it is open. */
interface Builder {
  el: HTMLElement;
  syncs: Array<() => void>;
  /** Run when the flyout closes (a pending caption write). */
  cleanups: Array<() => void>;
}

let current: BlockChrome | null = null;

/** A pagination pass finished (main.ts renderPages): the block's top may
 *  have moved with a page start. Placed in the next frame, written only if
 *  it moved. */
export function blockChromePagesChanged(): void {
  current?.schedule();
}

/** The source view opened or closed: no pill while the text is the truth
 *  (style.css hides the layer), and no flyout left open over it. */
export function blockChromeSourceMode(active: boolean): void {
  if (active) current?.closeFlyout();
}

class BlockChrome {
  private readonly scroll: HTMLElement;
  private readonly paper: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly track: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly position: HTMLElement;
  private readonly hint: HTMLElement;
  private ctx: BlockContext | null = null;
  private layout: Layout | null = null;
  private mode: Mode = 'full';
  private hug = false;
  private structure = '';
  private signature = '';
  private frame = 0;
  private placed = false;
  /** When the text of a hugged, widening block last changed, and the
   *  timer that re-places the pill once that typing pauses. */
  private typedAt = 0;
  private settle = 0;
  /** In a typing run: the pill sits at its margin place (.is-typing) and
   *  waits for a real pause; every keystroke of the run pushes it back. */
  private stepped = false;
  private tiles = new Map<string, HTMLButtonElement>();
  private flyout: OpenFlyout | null = null;
  private refly = 0;
  /** A click on a table's caption: open Table settings with Caption
   *  focused once the pill is placed beside that table. */
  private pendingCaption = false;
  private readonly unlisten: Array<() => void> = [];
  private cellCache: { from: EditorState; state: EditorState } | null = null;

  constructor(private readonly view: EditorView) {
    this.scroll = document.getElementById('scroll') ?? document.body;
    this.paper = document.getElementById('paper') ?? this.scroll;
    this.layer = document.createElement('div');
    this.layer.id = 'block-chrome';
    this.track = document.createElement('div');
    this.track.className = 'block-track';
    this.track.hidden = true;
    this.pill = document.createElement('div');
    this.pill.className = 'block-pill';
    this.pill.setAttribute('role', 'toolbar');
    this.pill.setAttribute('aria-orientation', 'vertical');
    this.position = document.createElement('span');
    this.position.className = 'bc-position bc-hidden';
    this.position.setAttribute('aria-live', 'polite');
    this.hint = document.createElement('span');
    this.hint.className = 'bc-hint bc-hidden';
    this.hint.setAttribute('aria-live', 'polite');
    this.track.append(this.pill);
    this.layer.append(this.track);
    this.scroll.append(this.layer);

    // The pill's background and padding are not the paper: a press there
    // keeps the editor's selection and places no caret (paper-caret.ts).
    this.pill.addEventListener('mousedown', (e) => e.preventDefault());
    this.pill.addEventListener('keydown', (e) => this.pillKey(e));
    this.pill.addEventListener('click', (e) => {
      const tile = (e.target as Element).closest<HTMLButtonElement>('.tb-btn');
      if (tile && !tile.disabled) this.press(tile, e.detail === 0);
    });

    document.addEventListener('mousedown', this.outside, true);
    document.addEventListener('keydown', this.escape, true);
    window.addEventListener('resize', this.resize);
    this.scroll.addEventListener('scroll', this.scrolled, { passive: true });
    this.unlisten.push(onPaperScale(() => this.schedule()));
    current = this;
    setPillFocuser(() => this.focusPill());
    this.update(view, null);
  }

  // -- state ---------------------------------------------------------------

  update(view: EditorView, prev: EditorState | null): void {
    const state = view.state;
    if (prev && prev.doc === state.doc && prev.selection.eq(state.selection)) return;
    const ctx = blockContext(state);
    if (!ctx) {
      if (this.ctx) this.hide();
      return;
    }
    const entered = !this.ctx || this.ctx.pos !== ctx.pos || this.ctx.kind !== ctx.kind;
    const parentChanged = !!this.ctx && (this.ctx.parentGrid?.pos ?? -1) !== (ctx.parentGrid?.pos ?? -1);
    this.ctx = ctx;
    const structure = structureKey(state, ctx);
    const signature = caretSignature(state);
    const structural = structure !== this.structure;
    const moved = signature !== this.signature;
    this.structure = structure;
    this.signature = signature;

    if (entered || parentChanged) {
      this.closeFlyout();
      this.endRun();
      this.pill.classList.remove('is-dim');
      // Hidden until placed beside its new block (it fades in there).
      this.track.hidden = true;
      this.build();
      this.syncTiles();
      this.placed = false;
      this.schedule();
      return;
    }
    if (structural) {
      this.syncTiles();
      this.schedule();
    } else if (moved) {
      this.syncTiles();
    }
    const typed = !!prev && prev.doc !== state.doc && !structural;
    if (moved) this.pill.classList.remove('is-dim');
    else if (typed && !this.pill.classList.contains('is-dim')) this.pill.classList.add('is-dim');
    // Every keystroke of a run counts, not just the one that stepped back:
    // the pill hugs again only after a real pause.
    if (typed && (this.hug || this.stepped) && mayWiden(ctx.node)) this.typing();
    if (this.flyout) this.flyout.sync();
  }

  /** Text typed in a hugged table whose columns follow their text: the
   *  table may spread left under the pill before the next placement (they
   *  wait for typing to pause), so the pill steps back to its margin place,
   *  where no text is, until typing pauses and it is placed again. Classes
   *  only (the margin left was written by the last measure); a timestamp
   *  per keystroke, one timer per typing run. */
  private typing(): void {
    this.typedAt = performance.now();
    if (!this.stepped) {
      this.stepped = true;
      // A placement already asked for would end the run: it waits too.
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.track.classList.add('is-typing');
      this.pill.classList.remove('is-hug');
      this.hug = false;
      this.closeFlyout();
    }
    if (!this.settle) this.settle = window.setTimeout(this.typingPaused, TYPING_PAUSE);
  }

  private typingPaused = (): void => {
    const wait = this.typedAt + TYPING_PAUSE - performance.now();
    if (wait > 1) {
      this.settle = window.setTimeout(this.typingPaused, wait);
      return;
    }
    this.settle = 0;
    this.stepped = false;
    this.schedule();
  };

  /** Forget a typing run (a new block, or none). */
  private endRun(): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = 0;
    this.stepped = false;
    this.hug = false;
    this.track.classList.remove('is-typing');
  }

  private hide(): void {
    this.ctx = null;
    this.pendingCaption = false;
    this.endRun();
    this.structure = '';
    this.signature = '';
    this.closeFlyout();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.track.hidden = true;
    this.placed = false;
    this.pill.classList.remove('is-dim');
    setText(this.position, '');
    setText(this.hint, '');
  }

  /** Placement in the next frame. Not during a typing run: the pill is in
   *  its margin place, and the pause that ends the run places it (so a
   *  pass or resize mid-run reads no geometry and moves nothing). */
  schedule = (): void => {
    if (!this.ctx || this.frame || this.stepped) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.measure();
    });
  };

  // -- the tiles -------------------------------------------------------------

  private tileSpecs(layout: Layout): Array<TileSpec | '|'> {
    const rows: TileSpec = { id: 'rows', glyph: icon('rowsmenu'), caption: 'Rows', flyout: 'rows', popup: 'menu' };
    const cols: TileSpec = { id: 'cols', glyph: icon('colsmenu'), caption: 'Columns', flyout: 'cols', popup: 'menu' };
    // The two commonest edits, one click each: a row under the caret's,
    // a column right of it. The menus keep the rest.
    const grid = this.ctx?.kind === 'grid';
    const addRow: TileSpec = {
      id: 'addrow', glyph: icon('rows'), caption: 'Add row below', kbd: '⌘⏎',
      action: () => this.add(grid ? () => this.atCell(() => insertGridRowAt(this.view, 'below')) : () => this.run(insertTableRow('below'))),
    };
    const addCol: TileSpec = {
      id: 'addcol', glyph: icon('cols'), caption: 'Add column right',
      action: () => this.add(grid ? () => this.atCell(() => insertGridColumnAt(this.view, 'right')) : () => this.run(insertTableColumn('right'))),
    };
    if (layout === 'collapsed') {
      const kind = this.ctx?.kind === 'grid' ? 'Grid' : 'Table';
      return [{ id: 'more', glyph: '<span class="ico tico">⋯</span>', caption: `${kind} controls`, flyout: 'more', popup: 'menu' }];
    }
    if (layout === 'grid') {
      return [
        addRow,
        addCol,
        { ...rows, flyout: 'gridrows' },
        { ...cols, flyout: 'gridcols' },
        { id: 'align', glyph: icon('alignleft'), caption: 'Align · Left', flyout: 'align', popup: 'dialog' },
        { id: 'image', glyph: icon('image'), caption: 'Image in cell', action: () => this.insertImage() },
        '|',
        { id: 'grid', glyph: icon('grid'), caption: 'Grid layout', flyout: 'gridlayout', popup: 'dialog' },
      ];
    }
    const table: Array<TileSpec | '|'> = [
      addRow,
      addCol,
      rows,
      cols,
      { id: 'align', glyph: icon('alignleft'), caption: 'Align · Left', flyout: 'align', popup: 'dialog' },
      { id: 'cell', glyph: icon('cell'), caption: 'Cell fill and rules', flyout: 'cell', popup: 'dialog' },
      '|',
      { id: 'table', glyph: icon('table'), caption: 'Table settings', flyout: 'table', popup: 'dialog' },
    ];
    if (layout === 'nested') table.push('|', { id: 'gridparent', glyph: icon('grid'), caption: 'Grid…', flyout: 'gridparent', popup: 'menu' });
    return table;
  }

  private layoutFor(ctx: BlockContext): Layout {
    if (this.mode === 'collapsed') return 'collapsed';
    return ctx.kind === 'grid' ? 'grid' : ctx.parentGrid ? 'nested' : 'table';
  }

  /** (Re)build the tiles for the block's kind and the margin's mode. */
  private build(): void {
    if (!this.ctx) return;
    const layout = this.layoutFor(this.ctx);
    const kind = this.ctx.kind === 'grid' ? 'grid' : 'table';
    setAttr(this.pill, 'aria-label', kind === 'grid' ? 'Grid controls' : 'Table controls');
    // The hidden readouts keep the old bars' class names (spec §6).
    setAttr(this.position, 'class', `bc-position ${kind}-toolbar-position bc-hidden`);
    setAttr(this.hint, 'class', `bc-hint ${kind}-toolbar-hint bc-hidden`);
    if (layout === this.layout && this.pill.childElementCount) {
      // Collapsed is one layout for both kinds: the ⋯ tile names the kind.
      const more = this.tiles.get('more');
      if (more) {
        const caption = `${this.ctx.kind === 'grid' ? 'Grid' : 'Table'} controls`;
        setAttr(more, 'aria-label', caption);
        setText(more.querySelector('.lbl')!, caption);
      }
      return;
    }
    this.layout = layout;
    this.tiles.clear();
    const parts: Node[] = [];
    let first = true;
    for (const spec of this.tileSpecs(layout)) {
      if (spec === '|') {
        const rule = document.createElement('div');
        rule.className = 'tb-rule';
        rule.setAttribute('role', 'separator');
        parts.push(rule);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tb-btn';
      button.dataset.tile = spec.id;
      button.tabIndex = first ? 0 : -1;
      first = false;
      button.setAttribute('aria-label', spec.caption);
      if (spec.popup) {
        button.setAttribute('aria-haspopup', spec.popup);
        button.setAttribute('aria-expanded', 'false');
      }
      button.innerHTML = `${spec.glyph}<span class="lbl">${spec.caption}${spec.kbd ? `<kbd>${spec.kbd}</kbd>` : ''}</span>`;
      if (spec.flyout) button.dataset.flyout = spec.flyout;
      if (spec.action) button.addEventListener('click', spec.action);
      this.tiles.set(spec.id, button);
      parts.push(button);
    }
    parts.push(this.position, this.hint);
    this.pill.replaceChildren(...parts);
    this.pill.classList.toggle('is-collapsed', layout === 'collapsed');
  }

  /** What the tiles say about the caret's cell: the Align glyph and
   *  caption, the disabled tiles, the hidden readouts. Model reads and
   *  attribute writes only; runs when the caret changes cell or the
   *  structure changes, not per keystroke. */
  private syncTiles(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const state = this.cellState();
    const inTable = isInTable(state);
    const place = gridCaretPlace(state);
    const align = this.tiles.get('align');
    if (align) {
      const value = ctx.kind === 'grid' ? gridCellAttr(state, 'align') : selectedCellsAttr(state, 'align');
      const known = value && value !== 'mixed' && value !== 'decimal' ? value : 'left';
      const name = value === 'mixed' ? 'Mixed' : value === 'decimal' ? 'Decimal' : ALIGN_NAME[known] ?? 'Left';
      const glyph = `align${known}`;
      if (align.dataset.glyph !== glyph) {
        align.dataset.glyph = glyph;
        align.querySelector('svg')?.remove();
        align.insertAdjacentHTML('afterbegin', icon(glyph));
      }
      setAttr(align, 'aria-label', `Align · ${name}`);
      setText(align.querySelector('.lbl')!, `Align · ${name}`);
    }
    for (const id of ['addrow', 'addcol', 'rows', 'cols', 'align', 'cell']) {
      const tile = this.tiles.get(id);
      if (!tile) continue;
      // A grid holds twelve columns at most (the Columns menu's limit).
      const full = id === 'addcol' && ctx.kind === 'grid' && (place?.columns ?? 0) >= 12;
      const disabled = (ctx.kind === 'table' ? !inTable : !place) || full;
      if (tile.disabled !== disabled) tile.disabled = disabled;
    }
    const image = this.tiles.get('image');
    if (image) {
      const disabled = !place;
      if (image.disabled !== disabled) image.disabled = disabled;
    }
    // The readout for assistive tech (spec §6), and the image hint.
    let readout = '';
    if (ctx.kind === 'grid' && place) {
      const columns = place.span > 1 ? `Columns ${place.column + 1}–${place.column + place.span}` : `Column ${place.column + 1}`;
      readout = `Row ${place.row + 1} of ${place.rows} · ${columns} of ${place.columns}`;
    }
    else if (ctx.kind === 'table' && inTable) {
      try {
        const rect = selectedRect(state);
        readout = `Row ${rect.top + 1} of ${rect.map.height} · Column ${rect.left + 1} of ${rect.map.width}`;
      } catch {
        readout = '';
      }
    }
    setText(this.position, readout);
    const imageSelected = state.selection instanceof NodeSelection && state.selection.node.type === schema.nodes.image && !!place;
    setText(this.hint, imageSelected ? 'Image selected · → then Enter adds text below · Tab / Shift-Tab move between cells' : '');
  }

  // -- placement (never on the typing path) ---------------------------------

  private blockElement(pos: number): HTMLElement | null {
    const dom = this.view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return null;
    if (dom.matches('table, .ts-grid')) return dom;
    return dom.querySelector<HTMLElement>('table, .ts-grid');
  }

  /** The block's first line: a block that opens a page carries the page
   *  gap as its first row, which belongs to the page before. */
  private blockTop(el: HTMLElement): number {
    const rows = el.tagName === 'TABLE' ? el.querySelector(':scope > tbody')?.children : el.children;
    if (rows && rows[0]?.classList.contains('ts-pagegap')) {
      for (const row of rows) if (!row.classList.contains('ts-pagegap')) return row.getBoundingClientRect().top;
    }
    return el.getBoundingClientRect().top;
  }

  /** A table's on-page caption and its text's box (not the element's: that
   *  is the column's width). Read only where the pill is placed. */
  private captionText(outer: HTMLElement): { el: HTMLElement; rect: DOMRect } | null {
    const captionId = outer.getAttribute('aria-describedby');
    const el = captionId ? document.getElementById(captionId) : null;
    if (!el?.classList.contains('native-table-caption')) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    return rect.height > 0 ? { el, rect } : null;
  }

  private measure(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const block = this.blockElement(ctx.pos);
    const outer = ctx.outerPos === ctx.pos ? block : this.blockElement(ctx.outerPos);
    if (!block || !block.isConnected || !outer) {
      this.track.hidden = true;
      return;
    }
    const s = paperScale() || 1;
    const panel = this.scroll.getBoundingClientRect();
    const editor = this.view.dom.getBoundingClientRect();
    const textLeft = editor.left + (parseFloat(getComputedStyle(this.view.dom).paddingLeft) || 0) * s;
    const paperLeft = this.paper.getBoundingClientRect().left;
    const margin = textLeft - paperLeft;
    const mode: Mode = margin >= MARGIN_FULL ? 'full' : margin >= MARGIN_COMPACT ? 'compact' : 'collapsed';
    if (mode !== this.mode) {
      this.mode = mode;
      this.closeFlyout();
      this.build();
      this.syncTiles();
    }
    const width = mode === 'full' ? 40 : mode === 'compact' ? 34 : 28;
    const base = mode === 'full' ? 14 : 8;
    // A grid's selection outline, past its left edge.
    const blockLeft = block.getBoundingClientRect().left;
    const reach = ctx.kind === 'grid' ? GRID_OUTLINE_OFFSET_EM * (parseFloat(getComputedStyle(block).fontSize) || 16) * s + 2 + OUTLINE_CLEAR : 0;
    const gapFrom = (x: number) => Math.max(base, reach - (blockLeft - x));
    const rest = mode === 'collapsed' ? paperLeft + 4 : Math.max(paperLeft + 2, textLeft - gapFrom(textLeft) - width);
    const top = this.blockTop(block);
    const bottom = block.getBoundingClientRect().bottom;
    const toScroll = (y: number) => y - panel.top + this.scroll.scrollTop;
    const contentBottom = toScroll(this.paper.getBoundingClientRect().bottom);
    // Shown before it is read (the same frame: nothing paints between).
    if (this.track.hidden) this.track.hidden = false;
    const pillHeight = this.pill.offsetHeight;
    // Decision 3: hug a narrow centred block, never further left than the
    // margin place, and never over text: the block's caption counts where
    // the pill reaches down beside it, and a pill longer than the block
    // and its caption (it would hang beside the prose below) stays in the
    // margin, where nothing is.
    const outerRect = outer.getBoundingClientRect();
    let edge = outerRect.left;
    let extent = outerRect.bottom;
    const caption = this.captionText(outer);
    if (caption) {
      const r = caption.rect;
      // Its line box starts above its ink by about a fifth of an em: a
      // pill ending in that band ends above the caption's letters.
      const air = (parseFloat(getComputedStyle(caption.el).fontSize) || 13) * s * 0.2;
      if (r.top + air < top + pillHeight) edge = Math.min(edge, r.left);
      extent = Math.max(extent, r.bottom);
    }
    // Collapsed, the ⋯ tile keeps to the paper's edge (spec §4.1): its
    // menu then covers only the block's left part.
    const fits = mode !== 'collapsed' && top + pillHeight <= extent + 2;
    const left = fits ? Math.max(rest, edge - gapFrom(edge) - width) : rest;
    const hug = left > rest + 1;
    const trackTop = toScroll(top);
    const height = Math.max(pillHeight, Math.min(bottom - top, contentBottom - trackTop));
    // Measured only outside a typing run (schedule), so the run is over.
    this.track.classList.remove('is-typing');
    this.pill.classList.toggle('is-compact', mode !== 'full');
    this.pill.classList.toggle('is-hug', hug);
    this.hug = hug;
    const style = this.track.style;
    const want = { left: `${(left - panel.left).toFixed(2)}px`, top: `${trackTop.toFixed(2)}px`, width: `${width}px`, height: `${height.toFixed(2)}px` };
    for (const [key, value] of Object.entries(want) as Array<[keyof typeof want, string]>) {
      // Written only when moved by more than half a px.
      const now = parseFloat(style[key]);
      if (!style[key] || !(Math.abs(now - parseFloat(value)) <= 0.5)) style[key] = value;
    }
    // The margin place, which a typing run steps back to (.is-typing).
    const restLeft = `${(rest - panel.left).toFixed(2)}px`;
    if (style.getPropertyValue('--bc-rest-left') !== restLeft) style.setProperty('--bc-rest-left', restLeft);
    this.placed = true;
    if (this.flyout) this.placeOpen();
    if (this.pendingCaption) this.openPendingCaption();
  }

  /** The on-page caption was clicked (spec §5.1): the caret goes into the
   *  table's first cell if it is elsewhere, and Table settings opens beside
   *  the pill with Caption focused. */
  openCaption(caption: HTMLElement): void {
    if (!caption.id) return;
    const owner = document.querySelector<HTMLElement>(`[aria-describedby="${CSS.escape(caption.id)}"]`);
    const table = owner?.matches('table') ? owner : owner?.querySelector<HTMLElement>('table') ?? null;
    const pos = this.tablePos(table);
    if (pos === null) return;
    this.pendingCaption = true;
    if (this.ctx?.kind === 'table' && this.ctx.pos === pos) {
      if (this.placed && !this.frame && !this.track.hidden) this.openPendingCaption();
      else this.schedule();
      return;
    }
    focusTable(this.view, pos);
  }

  private openPendingCaption(): void {
    this.pendingCaption = false;
    if (this.ctx?.kind !== 'table') return;
    const tile = this.tiles.get('table') ?? this.tiles.get('more');
    if (!tile) return;
    if (this.flyout?.id !== 'table') this.openFlyout('table', tile, false, tile.dataset.tile === 'more' ? 'more' : undefined);
    const field = this.flyout?.el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Caption"]');
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }

  private resize = () => {
    this.closeFlyout();
    this.schedule();
  };

  private scrolled = () => {
    if (!this.flyout || this.refly) return;
    this.refly = requestAnimationFrame(() => {
      this.refly = 0;
      if (this.flyout) this.placeOpen();
    });
  };

  // -- keyboard in the pill ------------------------------------------------

  private pillKey(e: KeyboardEvent): void {
    const tiles = [...this.tiles.values()].filter((t) => !t.disabled);
    const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const go = (i: number) => {
      for (const t of this.tiles.values()) t.tabIndex = -1;
      tiles[i].tabIndex = 0;
      tiles[i].focus();
    };
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      go((at + (e.key === 'ArrowDown' ? 1 : -1) + tiles.length) % tiles.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      go(e.key === 'Home' ? 0 : tiles.length - 1);
    } else if (e.key === 'ArrowRight' || (this.hug && e.key === 'ArrowLeft')) {
      if (!tiles[at].dataset.flyout) return;
      e.preventDefault();
      this.press(tiles[at], true);
    } else if (e.key === 'Escape' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      this.view.focus();
    }
  }

  // -- tiles open their flyouts --------------------------------------------

  private press(tile: HTMLButtonElement, keyboard: boolean): void {
    const id = tile.dataset.flyout as FlyoutId | undefined;
    if (!id) return;
    if (this.flyout?.tile === tile && !this.flyout.parent) {
      this.closeFlyout(keyboard);
      return;
    }
    this.openFlyout(id, tile, keyboard);
  }

  openFlyout(id: FlyoutId, tile: HTMLButtonElement, focus: boolean, parent?: FlyoutId): void {
    this.closeFlyout();
    const built = this.content(id, parent);
    if (!built) return;
    const { el } = built;
    el.classList.add('bc-flyout');
    el.id = `bc-flyout-${id}`;
    el.setAttribute('aria-label', el.getAttribute('aria-label') ?? tile.getAttribute('aria-label') ?? '');
    // Its background is not the paper either; its fields take focus.
    el.addEventListener('mousedown', (e) => {
      if (!(e.target as Element).closest('input, textarea')) e.preventDefault();
    });
    el.addEventListener('keydown', (e) => this.flyoutKey(e));
    document.body.append(el);
    const sync = () => built.syncs.forEach((f) => f());
    sync();
    const cleanup = () => built.cleanups.forEach((f) => f());
    this.flyout = { id, el, tile, sync, cleanup, parent, side: 'end' };
    tile.setAttribute('aria-expanded', 'true');
    tile.setAttribute('aria-controls', el.id);
    this.pill.classList.add('is-open');
    this.pill.classList.remove('is-dim');
    this.placeOpen();
    if (focus) this.focusables()[0]?.focus();
  }

  private placeOpen(): void {
    const open = this.flyout;
    if (!open) return;
    // A hugging pill's flyout opens into the margin; a centred caption wider
    // than its table reaches into that margin, and the flyout keeps clear
    // of its text where there is room (the caption the writer just clicked).
    const outer = this.hug && this.ctx ? this.blockElement(this.ctx.outerPos) : null;
    const avoid = outer ? this.captionText(outer)?.rect : undefined;
    open.side = placeFlyout(open.el, open.tile, { side: this.hug ? 'start' : 'end', avoid });
    open.el.classList.toggle('bc-start', open.side === 'start');
  }

  closeFlyout(restoreFocus = false): void {
    const open = this.flyout;
    if (!open) return;
    this.flyout = null;
    open.cleanup();
    open.el.remove();
    open.tile.setAttribute('aria-expanded', 'false');
    open.tile.removeAttribute('aria-controls');
    this.pill.classList.remove('is-open');
    if (restoreFocus && open.tile.isConnected) open.tile.focus({ preventScroll: true });
  }

  private outside = (e: MouseEvent) => {
    const open = this.flyout;
    if (!open) return;
    const target = e.target as Node;
    if (open.el.contains(target) || open.tile.contains(target)) return;
    this.closeFlyout();
  };

  /** Escape with a flyout open and the focus elsewhere (a mouse opened it,
   *  so the caret kept the focus): the flyout closes, the caret stays. */
  private escape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.flyout || this.flyout.el.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    this.closeFlyout();
  };

  private focusables(): HTMLElement[] {
    const open = this.flyout;
    if (!open) return [];
    return [...open.el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [role^="menuitem"]:not([aria-disabled="true"])')]
      .filter((el) => !el.closest('[hidden]'));
  }

  /** A panel's Tab order: every control, a choice group (a radiogroup of
   *  thumbnails or segments) counted once at its checked choice (its first
   *  when none is). */
  private tabStops(): HTMLElement[] {
    const stops: HTMLElement[] = [];
    const groups = new Set<Element>();
    for (const el of this.focusables()) {
      const group = el.closest('[role="radiogroup"]');
      if (!group) {
        stops.push(el);
        continue;
      }
      if (groups.has(group)) continue;
      groups.add(group);
      const choices = [...group.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      stops.push(choices.find((c) => c.getAttribute('aria-checked') === 'true') ?? el);
    }
    return stops;
  }

  private flyoutKey(e: KeyboardEvent): void {
    const open = this.flyout;
    if (!open) return;
    const target = e.target as HTMLElement;
    const field = target.matches('input, textarea');
    if (e.key === 'Escape') {
      if (field) return; // the field reverts and hands the caret back itself
      e.preventDefault();
      e.stopPropagation();
      if (open.parent) this.openFlyout(open.parent, open.tile, true);
      else this.closeFlyout(true);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      // A settings panel is a dialog (spec §6): Tab and Shift-Tab walk its
      // controls, fields included, one stop per choice group; past the last
      // the page gets the caret, before the first the tile gets the focus.
      if (open.el.classList.contains('block-panel')) {
        const stops = this.tabStops();
        const here = stops.findIndex((el) => el === target || (el.closest('[role="radiogroup"]')?.contains(target) ?? false));
        const next = here < 0 ? 0 : here + (e.shiftKey ? -1 : 1);
        if (next >= 0 && next < stops.length) {
          stops[next].focus();
          return;
        }
        if (next < 0) {
          this.closeFlyout(true);
          return;
        }
      }
      this.closeFlyout();
      this.view.focus();
      return;
    }
    if (field) return;
    const items = this.focusables().filter((el) => !el.matches('input, textarea'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    const panel = open.el.classList.contains('tb-menu-extras') || open.el.classList.contains('block-panel');
    const sideways = panel && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
    const back = this.hug ? 'ArrowRight' : 'ArrowLeft';
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || sideways) {
      e.preventDefault();
      const previous = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (previous ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === back) {
      e.preventDefault();
      if (open.parent) this.openFlyout(open.parent, open.tile, true);
      else this.closeFlyout(true);
    } else if (e.key === (this.hug ? 'ArrowLeft' : 'ArrowRight') && target.getAttribute('aria-haspopup')) {
      e.preventDefault();
      target.click();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== ' ') {
      const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
      const match = ordered.find((el) => (el.textContent ?? '').trim().toLowerCase().startsWith(e.key.toLowerCase()));
      if (match) {
        e.preventDefault();
        match.focus();
      }
    }
  }

  // -- running commands -----------------------------------------------------

  /** Run a command on the editor, then hand it the focus (every pointer
   *  commit does: nothing stays focused in a flyout that clicks closed). */
  private run(command: Command, focus = true): boolean {
    // A block selected (Escape from a cell): a command that needs a cell
    // runs at the cell it was selected from; one that takes the block as it
    // is (a style, an undo) keeps it selected, and so does one that could
    // not run at the cell either.
    if (!command(this.view.state) && cellSelectionFor(this.view.state) && command(this.cellState())) restoreCell(this.view);
    const done = command(this.view.state, this.view.dispatch, this.view);
    if (focus) this.view.focus();
    return done;
  }

  /** A grid command at the caret's cell (the remembered one while the
   *  block is selected). */
  private atCell(action: () => unknown): void {
    restoreCell(this.view);
    action();
  }

  /** The state the tiles and menus read: the editor's, or, while a table
   *  or grid is selected as a block, the same with the remembered cell's
   *  selection, so they show and enable what a command will act on. */
  private cellState(): EditorState {
    const state = this.view.state;
    if (this.cellCache?.from === state) return this.cellCache.state;
    const cell = cellSelectionFor(state);
    const out = cell ? state.apply(state.tr.setSelection(cell)) : state;
    this.cellCache = { from: state, state: out };
    return out;
  }

  private add(action: () => unknown): void {
    this.closeFlyout();
    action();
  }

  private insertImage(): void {
    this.closeFlyout();
    restoreCell(this.view);
    pickAndInsertFigure(this.view, 'inline');
  }

  /** Tab on a selected block (block-keys.ts): the focus to the pill's
   *  first tile it can take, placing the pill first if it is not yet. */
  focusPill(): boolean {
    if (!this.ctx) return false;
    if (this.track.hidden || !this.placed) {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.measure();
    }
    if (this.track.hidden) return false;
    const tiles = [...this.tiles.values()].filter((t) => !t.disabled);
    if (!tiles.length) return false;
    for (const t of this.tiles.values()) t.tabIndex = -1;
    tiles[0].tabIndex = 0;
    this.pill.classList.remove('is-dim');
    tiles[0].focus({ preventScroll: true });
    return true;
  }

  // -- flyout content -------------------------------------------------------

  private content(id: FlyoutId, parent?: FlyoutId): Builder | null {
    const b = (cls: string, role: 'menu' | 'dialog', label: string): Builder => {
      const el = document.createElement('div');
      el.className = cls;
      el.setAttribute('role', role);
      el.setAttribute('aria-label', label);
      return { el, syncs: [], cleanups: [] };
    };
    const ctx = this.ctx;
    if (!ctx) return null;
    switch (id) {
      case 'rows': return this.rowsMenu(b('tb-menu bc-menu', 'menu', 'Rows'), parent);
      case 'cols': return this.colsMenu(b('tb-menu bc-menu bc-colsmenu', 'menu', 'Columns'), parent);
      case 'align': return this.alignPanel(b('tb-menu tb-menu-extras bc-panel bc-alignpanel', 'dialog', 'Align'), parent);
      case 'cell': return this.cellPanel(b('tb-menu tb-menu-extras bc-panel bc-cellpanel', 'dialog', 'Cell fill and rules'), parent);
      case 'table': return this.tableSettings(b('tb-menu block-panel bc-tablesettings', 'dialog', 'Table settings'), parent);
      case 'grid':
      case 'gridlayout': return this.gridLayout(b('tb-menu block-panel bc-gridlayout', 'dialog', 'Grid layout'), parent);
      case 'gridrows': return this.gridRowsMenu(b('tb-menu bc-menu', 'menu', ctx.kind === 'grid' ? 'Rows' : 'Grid rows'), parent);
      case 'gridcols': return this.gridColsMenu(b('tb-menu bc-menu', 'menu', ctx.kind === 'grid' ? 'Columns' : 'Grid columns'), parent);
      case 'gridparent': return this.gridParentMenu(b('tb-menu bc-menu bc-gridmenu', 'menu', 'Grid'));
      case 'more': return this.moreMenu(b('tb-menu bc-menu', 'menu', ctx.kind === 'grid' ? 'Grid controls' : 'Table controls'));
    }
  }

  /** A menu row. `close`: the menu closes before the command runs (the
   *  editor gets the focus); otherwise it stays open and re-syncs. */
  private item(
    builder: Builder,
    label: string,
    action: () => void,
    options: { name?: string; checked?: () => boolean; enabled?: () => boolean; visible?: () => boolean; text?: () => string; sub?: string; submenu?: boolean; dialog?: boolean; keepOpen?: boolean; kbd?: string } = {},
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tb-menu-item';
    button.tabIndex = -1;
    button.setAttribute('role', options.checked ? 'menuitemcheckbox' : 'menuitem');
    if (options.name) button.setAttribute('aria-label', options.name);
    const text = document.createElement('span');
    text.className = 'tb-menu-label';
    text.textContent = label;
    button.append(text);
    if (options.sub) {
      const sub = document.createElement('span');
      sub.className = 'mi-sub';
      sub.textContent = options.sub;
      text.append(sub);
    }
    if (options.submenu || options.kbd) {
      const chev = document.createElement('span');
      chev.className = options.submenu ? 'mi-chev' : 'mi-kbd';
      chev.setAttribute('aria-hidden', 'true');
      chev.textContent = options.kbd ?? '›';
      button.append(chev);
      if (options.submenu) button.setAttribute('aria-haspopup', 'menu');
    }
    if (options.dialog) button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      if (options.keepOpen || options.submenu || options.dialog) action();
      else {
        this.closeFlyout();
        action();
      }
    });
    builder.syncs.push(() => {
      if (options.checked) setAttr(button, 'aria-checked', String(options.checked()));
      const disabled = !!options.enabled && !options.enabled();
      if (button.disabled !== disabled) button.disabled = disabled;
      if (options.visible) {
        const hidden = !options.visible();
        if (button.hidden !== hidden) button.hidden = hidden;
      }
      if (options.text) setText(text, options.text());
    });
    builder.el.append(button);
    return button;
  }

  private divider(builder: Builder, visible?: () => boolean): void {
    const div = document.createElement('div');
    div.className = 'tb-menu-divider';
    div.setAttribute('role', 'separator');
    builder.el.append(div);
    if (visible) builder.syncs.push(() => { div.hidden = !visible(); });
  }

  private heading(builder: Builder, label: string): void {
    const div = document.createElement('div');
    div.className = 'tb-menu-heading';
    div.setAttribute('role', 'presentation');
    div.textContent = label;
    builder.el.append(div);
  }

  /** A child menu opened from a parent's row (the collapsed ⋯ tile, the
   *  nested table's Grid tile) leads with the way back. */
  private back(builder: Builder, parent: FlyoutId | undefined, label: string): void {
    if (!parent) return;
    this.item(builder, `‹ ${label}`, () => this.reopen(parent), { keepOpen: true });
    this.divider(builder);
  }

  private reopen(id: FlyoutId, parent?: FlyoutId): void {
    const tile = this.flyout?.tile;
    if (tile) this.openFlyout(id, tile, false, parent);
  }

  private rowsMenu(builder: Builder, parent?: FlyoutId): Builder {
    const state = () => this.cellState();
    this.back(builder, parent, parent === 'more' ? 'Table controls' : 'Grid');
    this.item(builder, 'Add row above', () => this.run(insertTableRow('above')), { name: 'Add row above', enabled: () => insertTableRow('above')(state()), kbd: '⇧⌘⏎' });
    this.item(builder, 'Add row below', () => this.run(insertTableRow('below')), { name: 'Add row below', enabled: () => insertTableRow('below')(state()), kbd: '⌘⏎' });
    this.item(builder, 'Select row', () => this.run(selectTableLine('row')), { enabled: () => selectTableLine('row')(state()) });
    this.divider(builder);
    this.item(builder, 'Header row', () => this.run(toggleHeaderRow), {
      name: 'Toggle selected row as header', checked: () => selectedRowIsHeader(state()), enabled: () => toggleHeaderRow(state()),
    });
    this.divider(builder);
    this.item(builder, 'Delete row', () => this.run(deleteSelectedRows), {
      name: 'Delete selected row', enabled: () => deleteSelectedRows(state()),
      text: () => (selectedTableRows(state()) === 1 ? 'Delete row (deletes the table)' : 'Delete row'),
    });
    return builder;
  }

  private colsMenu(builder: Builder, parent?: FlyoutId): Builder {
    const state = () => this.cellState();
    this.back(builder, parent, parent === 'more' ? 'Table controls' : 'Grid');
    this.item(builder, 'Add column left', () => this.run(insertTableColumn('left')), { name: 'Add column before', enabled: () => insertTableColumn('left')(state()) });
    this.item(builder, 'Add column right', () => this.run(insertTableColumn('right')), { name: 'Add column after', enabled: () => insertTableColumn('right')(state()) });
    this.item(builder, 'Select column', () => this.run(selectTableLine('col')), { enabled: () => selectTableLine('col')(state()) });
    this.divider(builder);
    this.heading(builder, 'Width');
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Selected column sizing');
    builder.el.append(group);
    const width = () => selectedColumnWidth(state());
    const modeOf = (w: string) => (w === 'auto' || w === 'mixed' ? w : w.endsWith('fr') ? 'fr' : 'pt');
    const radio = (mode: 'auto' | 'fr' | 'pt' | 'mixed', label: string, field?: { unit: string; name: string; fallback: number; min: number; max: number }) => {
      const row = document.createElement('div');
      row.className = 'tb-menu-item mi-radio';
      row.tabIndex = -1;
      row.setAttribute('role', 'menuitemradio');
      row.dataset.value = mode;
      const text = document.createElement('span');
      text.className = 'tb-menu-label';
      text.textContent = label;
      row.append(text);
      let sub: HTMLElement | null = null;
      if (mode === 'fr') {
        sub = document.createElement('span');
        sub.className = 'mi-sub';
        sub.textContent = 'Fills the text width';
        text.append(sub);
      }
      let input: HTMLInputElement | null = null;
      if (field) {
        const wrap = document.createElement('span');
        wrap.className = 'pfield';
        input = document.createElement('input');
        input.type = 'number';
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = 'any';
        input.setAttribute('aria-label', field.name);
        const unit = document.createElement('span');
        unit.className = 'unit';
        unit.textContent = field.unit;
        wrap.append(input, unit);
        row.append(wrap);
        const value = () => {
          const w = width();
          return w && modeOf(w.width) === mode ? Number.parseFloat(w.width) : field.fallback;
        };
        // What the field showed after its last commit or revert: the blur
        // a click on another row causes applies nothing stale (as bindField).
        let shown = '';
        const revert = () => { input!.value = shown = String(value()); };
        const commit = () => {
          const n = input!.valueAsNumber;
          if (!input!.validity.valid || !Number.isFinite(n) || (mode === 'fr' && n <= 0) || n < 0) {
            revert();
            return;
          }
          if (this.run(setSelectedColumnWidth(`${n}${mode}`), false)) shown = input!.value;
          else revert();
        };
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('change', () => { if (input!.value !== shown) commit(); });
        input.addEventListener('keydown', (e) => {
          const mod = e.metaKey || e.ctrlKey;
          const key = e.key.toLowerCase();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            revert();
            this.closeFlyout();
            this.view.focus();
          } else if (mod && (key === 'z' || key === 'y')) {
            // ⌘Z / ⇧⌘Z / ⌃Y: the document's history, not the field's.
            e.preventDefault();
            this.run(key === 'y' || e.shiftKey ? redo : undo, false);
            revert();
          }
        });
        builder.syncs.push(() => {
          if (document.activeElement !== input) revert();
        });
      }
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        if (mode === 'mixed') return;
        const n = input?.valueAsNumber;
        const amount = input && Number.isFinite(n) && n! > 0 ? n : field?.fallback;
        this.run(setSelectedColumnWidth(mode === 'auto' ? 'auto' : `${amount}${mode}`));
      });
      row.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === row) {
          e.preventDefault();
          row.click();
        }
      });
      builder.syncs.push(() => {
        const w = width();
        const checked = !!w && modeOf(w.width) === mode;
        setAttr(row, 'aria-checked', String(checked));
        row.classList.toggle('is-unchecked', !checked);
        if (mode === 'mixed') row.hidden = !(w && w.width === 'mixed');
        if (mode === 'mixed') setAttr(row, 'aria-disabled', 'true');
        if (sub) sub.hidden = !!w?.anyShare;
      });
      group.append(row);
    };
    radio('auto', 'Fit to content');
    radio('fr', 'Share of the rest', { unit: 'parts', name: 'Column share weight', fallback: 1, min: 0, max: 1440 });
    radio('pt', 'Fixed', { unit: 'pt', name: 'Column width in points', fallback: 72, min: 0, max: 1440 });
    radio('mixed', 'Mixed widths');
    this.item(builder, 'Reset all columns to automatic', () => this.run(resetTableColumnWidths), {
      visible: () => !!selectedColumnWidth(state())?.custom, keepOpen: true,
    });
    this.divider(builder);
    this.item(builder, 'Delete column', () => this.run(deleteSelectedColumns), { name: 'Delete selected column', enabled: () => deleteSelectedColumns(state()) });
    return builder;
  }

  /** A glyph in a panel with its caption beside the panel (as the rail's
   *  Extras glyphs): shown on hover and keyboard focus. */
  private caption(builder: Builder, button: HTMLElement, label: string): void {
    const cap = document.createElement('span');
    cap.className = 'bc-cap';
    cap.textContent = label;
    cap.setAttribute('aria-hidden', 'true');
    button.append(cap);
    const show = () => {
      const panel = builder.el.getBoundingClientRect();
      const glyph = button.getBoundingClientRect();
      const width = cap.offsetWidth;
      const originX = panel.left + builder.el.clientLeft;
      const originY = panel.top + builder.el.clientTop;
      const start = builder.el.classList.contains('bc-start');
      let x: number;
      let y = glyph.top + glyph.height / 2 - originY;
      let transform = 'translateY(-50%)';
      if (!start && panel.right + 8 + width <= window.innerWidth - 8) x = panel.right + 8 - originX;
      else if (start && panel.left - 8 - width >= 8) x = panel.left - 8 - width - originX;
      else {
        x = Math.max(8 + width / 2, Math.min(glyph.left + glyph.width / 2, window.innerWidth - 8 - width / 2)) - originX;
        y = glyph.top - 6 - originY;
        transform = 'translate(-50%, -100%)';
      }
      cap.style.left = `${x}px`;
      cap.style.top = `${y}px`;
      cap.style.transform = transform;
      button.classList.add('bc-cap-on');
    };
    const hide = () => button.classList.remove('bc-cap-on');
    button.addEventListener('mouseenter', show);
    button.addEventListener('focus', () => { if (button.matches(':focus-visible')) show(); });
    button.addEventListener('mouseleave', hide);
    button.addEventListener('blur', hide);
  }

  private section(builder: Builder, heading: string, label: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'tb-extra-section';
    const head = document.createElement('span');
    head.className = 'tb-extra-heading';
    head.textContent = heading;
    const row = document.createElement('div');
    row.className = 'tb-extra-row';
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', label);
    section.append(head, row);
    builder.el.append(section);
    return row;
  }

  /** A soft note after a radio row ("Mixed", why it is off). */
  private note(builder: Builder, row: HTMLElement, text: () => string): void {
    const note = document.createElement('span');
    note.className = 'bc-note';
    row.append(note);
    builder.syncs.push(() => {
      const t = text();
      setText(note, t);
      note.hidden = !t;
    });
  }

  private alignPanel(builder: Builder, parent?: FlyoutId): Builder {
    const state = () => this.cellState();
    // One panel for both kinds: a table's selected cells, or a grid's
    // caret cell (grid.cell(align:)); each axis as radios.
    const grid = this.ctx?.kind === 'grid';
    const who = grid ? 'this cell' : 'selected cells';
    const value = (name: 'align' | 'valign') => (grid ? gridCellAttr(state(), name) : selectedCellsAttr(state(), name));
    const enabled = () => (grid ? !!gridCaretPlace(state()) : isInTable(state()));
    const radio = (name: string, glyph: string, label: string, pick: () => unknown) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tb-btn';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', `Align ${who} ${name}`);
      button.dataset.value = name;
      button.innerHTML = icon(glyph);
      this.caption(builder, button, label);
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => pick());
      return button;
    };
    this.back(builder, parent, grid ? 'Grid controls' : 'Table controls');
    const across = this.section(builder, 'Across', `${grid ? "This cell's" : 'Selected cells'} horizontal alignment`);
    for (const v of ['left', 'center', 'right'] as const) {
      const button = radio(v, `align${v}`, ALIGN_NAME[v], () => this.run(grid ? setGridCellAttr('align', v) : alignSelectedTableCells(v)));
      builder.syncs.push(() => {
        setAttr(button, 'aria-checked', String(value('align') === v));
        const disabled = !enabled();
        if (button.disabled !== disabled) button.disabled = disabled;
      });
      across.append(button);
    }
    if (!grid) {
      // A decimal-aligned column: none of L/C/R, and a chip saying so (shown
      // only then; display only).
      const decimal = document.createElement('button');
      decimal.type = 'button';
      decimal.className = 'tb-btn bc-decimal';
      decimal.disabled = true;
      decimal.setAttribute('role', 'radio');
      decimal.setAttribute('aria-checked', 'true');
      decimal.setAttribute('aria-label', 'Decimal aligned');
      decimal.dataset.value = 'decimal';
      decimal.innerHTML = '<span class="ico tico">.00</span>';
      across.append(decimal);
      builder.syncs.push(() => { decimal.hidden = value('align') !== 'decimal'; });
      this.note(builder, across, () => (value('align') === 'mixed' ? 'Mixed' : ''));
    }
    const down = this.section(builder, 'Down', `${grid ? "This cell's" : 'Selected cells'} vertical alignment`);
    for (const [v, glyph, name] of [['top', 'valigntop', 'Top'], ['middle', 'valignmid', 'Middle'], ['bottom', 'valignbot', 'Bottom']] as const) {
      const button = radio(v, glyph, name, () => this.run(grid ? setGridCellAttr('valign', v) : setCellAttr('valign', v)));
      builder.syncs.push(() => {
        setAttr(button, 'aria-checked', String(value('valign') === v));
        const disabled = !enabled();
        if (button.disabled !== disabled) button.disabled = disabled;
      });
      down.append(button);
    }
    this.note(builder, down, () => (selectedCellsAttr(state(), 'valign') === 'mixed' ? 'Mixed' : ''));
    this.divider(builder);
    this.item(builder, 'Select column', () => this.run(selectTableLine('col')), { keepOpen: true, enabled: () => selectTableLine('col')(state()) });
    return builder;
  }

  private cellPanel(builder: Builder, parent?: FlyoutId): Builder {
    const state = () => this.cellState();
    this.back(builder, parent, 'Table controls');
    const fills = this.section(builder, 'Fill', 'Selected cells fill');
    fills.classList.add('swatches');
    for (const [value, name, color] of [['', 'None', ''], ['gray', 'Light gray', 'rgb(240, 240, 240)'], ['gray-dark', 'Gray', 'rgb(220, 220, 220)'], ['yellow', 'Yellow', '#fff3b0'], ['blue', 'Blue', '#e6f0ff']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = value ? 'swatch' : 'swatch none';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', name);
      button.dataset.value = value;
      if (color) button.style.background = color;
      this.caption(builder, button, name);
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => this.run(setCellAttr('fill', value)));
      builder.syncs.push(() => {
        setAttr(button, 'aria-checked', String(selectedCellsAttr(state(), 'fill') === value));
        const disabled = !isInTable(state());
        if (button.disabled !== disabled) button.disabled = disabled;
      });
      fills.append(button);
    }
    this.note(builder, fills, () => (selectedCellsAttr(state(), 'fill') === 'mixed' ? 'Mixed' : ''));
    const rules = this.section(builder, 'Rule', 'Rule under the selected rows');
    rules.classList.add('bc-rules');
    const ruleOf = (): RowRule | null => {
      if (!isInTable(state())) return null;
      try {
        const rect = selectedRect(state());
        return (rect.table.child(rect.top).attrs.rule as RowRule) || '';
      } catch {
        return null;
      }
    };
    for (const [value, name, line] of [['', 'Style default', '<i class="dashed"></i>'], ['light', 'Light', '<i style="height:1px"></i>'], ['heavy', 'Heavy', '<i style="height:2.4px"></i>'], ['none', 'None', '']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ruletile';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', name);
      button.dataset.value = value;
      button.innerHTML = line;
      this.caption(builder, button, name);
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => this.run(setRowRule(value)));
      builder.syncs.push(() => {
        setAttr(button, 'aria-checked', String(ruleOf() === value));
        const disabled = !setRowRule(value)(state());
        if (button.disabled !== disabled) button.disabled = disabled;
      });
      rules.append(button);
    }
    this.note(builder, rules, () => {
      try {
        return isInTable(state()) && selectedRect(state()).table.attrs.style === 'grid' ? 'Grid style rules every cell' : '';
      } catch {
        return '';
      }
    });
    this.divider(builder);
    this.item(builder, 'Merge cells', () => this.run(mergeCells), {
      name: 'Merge selected cells', keepOpen: true, enabled: () => mergeCells(state()),
    });
    const how = document.createElement('div');
    how.className = 'tb-menu-hint bc-howto';
    how.textContent = 'Drag or ⇧-click across cells first';
    builder.el.append(how);
    builder.syncs.push(() => { how.hidden = mergeCells(state()); });
    this.item(builder, 'Split cell', () => this.run(splitCell), {
      name: 'Split merged cell', keepOpen: true, visible: () => splitCell(state()),
    });
    return builder;
  }

  // -- settings panels (spec §5): Table settings, Grid layout ----------------
  //
  // One geometry for both (.block-panel: 284 wide, a 60 px label column,
  // every heading at the flyout's shared inset). Presets first, a Custom
  // field one step deeper; a checked visual choice wears the blue ring, a
  // checked text choice a fill. Pointer commits hand the editor the focus;
  // a field keeps it while the writer types (Enter applies, Escape reverts
  // and returns to the page, ⌘Z / ⇧⌘Z / ⌃Y are the document's history).

  /** A section: its heading in the label column, its controls beside it.
   *  `top`: the heading sits level with the first control's text (the
   *  section is taller than one row); `thumbs`: level with a thumbnail row. */
  private panelSection(builder: Builder, heading: string, options: { top?: boolean; thumbs?: boolean; column?: boolean } = {}): HTMLElement {
    const section = document.createElement('div');
    section.className = `bp-sec${options.top || options.thumbs ? ' top' : ''}${options.thumbs ? ' thumbsec' : ''}`;
    const head = document.createElement('span');
    head.className = 'bp-head';
    head.textContent = heading;
    const value = document.createElement('div');
    if (options.column) value.className = 'bp-col';
    section.append(head, value);
    builder.el.append(section);
    return value;
  }

  /** Text choices in a segmented track (checked: the fill). */
  private segmented(
    builder: Builder,
    parent: HTMLElement,
    label: string,
    options: ReadonlyArray<readonly [string, string]>,
    checked: () => string | null,
    pick: (value: string) => void,
    disabled: () => boolean = () => false,
  ): HTMLElement {
    const track = document.createElement('div');
    track.className = 'seg';
    track.setAttribute('role', 'radiogroup');
    track.setAttribute('aria-label', label);
    for (const [value, text] of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.setAttribute('role', 'radio');
      button.dataset.value = value;
      button.textContent = text;
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => {
        pick(value);
        this.view.focus();
      });
      builder.syncs.push(() => {
        setAttr(button, 'aria-checked', String(checked() === value));
        const off = disabled();
        if (button.disabled !== off) button.disabled = off;
      });
      track.append(button);
    }
    parent.append(track);
    return track;
  }

  /** A thumbnail choice (checked: the blue ring on its frame). */
  private thumb(value: string, label: string, art: string, caption: string, paper = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = 'thumb';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', label);
    button.dataset.value = value;
    button.innerHTML = `<span class="tframe${paper ? ' paper' : ''}">${art}</span><span class="thumb-cap">${caption}</span>`;
    button.addEventListener('mousedown', (e) => e.preventDefault());
    return button;
  }

  /** A small pill field with a leading word and a trailing unit. The field
   *  shows `value()` when it is the one in force (then `.checked`, a fill)
   *  and otherwise the value in force as a dim placeholder. */
  private pillField(
    builder: Builder,
    parent: HTMLElement,
    options: {
      name: string;
      lead: string;
      unit?: string;
      wide?: boolean;
      number?: { min: number; max: number; step: string };
      value: () => string;
      placeholder?: () => string;
      checked?: () => boolean;
      disabled?: () => boolean;
      commit: (text: string) => boolean;
    },
  ): HTMLInputElement {
    const wrap = document.createElement('label');
    wrap.className = `pfield${options.wide ? ' wide' : ''}`;
    const lead = document.createElement('span');
    lead.className = 'lead';
    lead.textContent = options.lead;
    const input = document.createElement('input');
    input.type = options.number ? 'number' : 'text';
    if (options.number) {
      input.min = String(options.number.min);
      input.max = String(options.number.max);
      input.step = options.number.step;
      input.inputMode = 'decimal';
    }
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', options.name);
    wrap.append(lead, input);
    if (options.unit) {
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = options.unit;
      wrap.append(unit);
    }
    parent.append(wrap);
    this.bindField(builder, input, {
      revert: () => {
        input.value = options.value();
        if (options.placeholder) input.placeholder = options.placeholder();
      },
      commit: () => options.commit(input.value.trim()),
    });
    builder.syncs.push(() => {
      const on = !!options.checked?.();
      wrap.classList.toggle('checked', on);
      const off = !!options.disabled?.();
      if (input.disabled !== off) input.disabled = off;
      wrap.classList.toggle('is-disabled', off);
    });
    return input;
  }

  /** Field keys and syncing: Enter applies and keeps the focus; Escape
   *  reverts and hands the page the caret; ⌘Z / ⇧⌘Z / ⌃Y go to the
   *  document's history; a change (blur) applies; an open panel's sync
   *  leaves a field alone while it has the focus. */
  private bindField(
    builder: Builder,
    input: HTMLInputElement | HTMLTextAreaElement,
    options: { revert: () => void; commit: () => boolean; flush?: () => void; enterCommits?: boolean },
  ): void {
    // What the field showed after its last commit or revert: a `change`
    // (blur) with nothing new typed since applies nothing (a preset clicked
    // after an Enter must not be undone by the field's stale value).
    let shown = input.value;
    const revert = () => {
      options.revert();
      shown = input.value;
    };
    const apply = () => {
      if (input.value === shown) return;
      if (options.commit()) shown = input.value;
      else revert();
    };
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', apply);
    // A preset picked while the field had the focus changed the model under
    // it (the sync skips a focused field): show the model once it leaves.
    input.addEventListener('blur', () => { if (input.value === shown) revert(); });
    input.addEventListener('keydown', (e) => {
      const event = e as KeyboardEvent;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        apply();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        // A pending caption or label write is kept (it was typed); a
        // number field drops what is not applied.
        options.flush?.();
        revert();
        this.closeFlyout();
        this.view.focus();
      } else if (mod && (key === 'z' || key === 'y') && !event.altKey) {
        event.preventDefault();
        options.flush?.();
        this.run(key === 'y' || event.shiftKey ? redo : undo, false);
        revert();
      }
    });
    builder.syncs.push(() => {
      if (document.activeElement !== input) revert();
    });
  }

  /** The table the panel edits, found again from its element (its position
   *  moves with edits above it; the TableView keeps the element). */
  private tablePos(table: HTMLElement | null): number | null {
    if (!table?.isConnected) return null;
    const cell = table.querySelector('td, th');
    if (!cell) return null;
    try {
      const $p = this.view.state.doc.resolve(this.view.posAtDOM(cell, 0));
      for (let depth = $p.depth; depth > 0; depth--) {
        if ($p.node(depth).type.spec.tableRole === 'table') return $p.before(depth);
      }
    } catch {
      return null;
    }
    return null;
  }

  private tableSettings(builder: Builder, parent?: FlyoutId): Builder {
    this.back(builder, parent, 'Table controls');
    const tableEl = this.ctx ? this.blockElement(this.ctx.pos) : null;
    const pos = () => this.tablePos(tableEl) ?? (this.ctx?.kind === 'table' ? this.ctx.pos : null);
    const attrs = (): Record<string, unknown> => {
      const at = pos();
      const node = at === null ? null : this.view.state.doc.nodeAt(at);
      return node?.type.spec.tableRole === 'table' ? node.attrs : {};
    };
    const write = (values: Record<string, unknown>, separate = false) => {
      const at = pos();
      return at !== null && setTableAttrsAt(this.view, at, values, separate);
    };
    const params = () => String(attrs().params ?? '').trim();
    const insetLocked = () => /(?:^|,)\s*inset\s*:/.test(params());

    // STYLE: three paper thumbnails drawing each style's rules.
    const style = this.panelSection(builder, 'Style', { thumbs: true });
    style.className = 'thumbs';
    style.setAttribute('role', 'radiogroup');
    style.setAttribute('aria-label', 'Table rule style');
    for (const [value, name, art] of TABLE_STYLE_THUMBS) {
      const button = this.thumb(value, name, art, name, true);
      button.addEventListener('click', () => this.run(setTableStyle(value)));
      builder.syncs.push(() => setAttr(button, 'aria-checked', String((attrs().style || 'booktabs') === value)));
      style.append(button);
    }

    // TEXT SIZE: 100 … 75 %.
    const size = this.panelSection(builder, 'Text size');
    size.className = 'seg-unit';
    this.segmented(builder, size, 'Table text size', [['', '100'], ['0.9em', '90'], ['0.85em', '85'], ['0.8em', '80'], ['0.75em', '75']],
      () => String(attrs().fontSize ?? ''), (value) => write({ fontSize: value }));
    const percent = document.createElement('span');
    percent.className = 'unit';
    percent.textContent = '%';
    size.append(percent);

    // PADDING: the three densities, and a Custom pt field (the inset in
    // force, dim, until one is typed).
    const padding = this.panelSection(builder, 'Padding', { top: true, column: true });
    const custom = () => typeof attrs().insetPt === 'number';
    this.segmented(builder, padding, 'Table cell density', [['compact', 'Compact'], ['', 'Normal'], ['roomy', 'Roomy']],
      () => (custom() || insetLocked() ? null : String(attrs().density ?? '')),
      (value) => write({ density: value, insetPt: null }), insetLocked);
    this.pillField(builder, padding, {
      name: 'Cell padding in points',
      lead: 'Custom',
      unit: 'pt',
      number: { min: 0, max: 72, step: 'any' },
      value: () => (custom() ? String(attrs().insetPt) : ''),
      placeholder: () => String(tableInsetPt(attrs())),
      checked: () => custom() && !insetLocked(),
      disabled: insetLocked,
      commit: (text) => {
        if (!text) return !custom() || write({ insetPt: null }, true);
        const n = Number(text);
        if (Number.isFinite(n) && n >= 0 && n <= 72) write({ insetPt: n }, true);
        return false; // revert: the field shows the inset in force
      },
    });
    const locked = document.createElement('span');
    locked.className = 'bp-note';
    locked.textContent = 'Set by custom styling in the file';
    padding.append(locked);
    builder.syncs.push(() => { locked.hidden = !insetLocked(); });

    // COLUMNS: what the widths are; the way back to automatic.
    const columns = this.panelSection(builder, 'Columns', { column: true });
    columns.classList.add('bp-cols');
    const state = document.createElement('span');
    state.className = 'v';
    const how = document.createElement('span');
    how.className = 'bp-note';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.tabIndex = -1;
    reset.className = 'bp-link';
    reset.textContent = 'Reset to automatic';
    reset.addEventListener('mousedown', (e) => e.preventDefault());
    reset.addEventListener('click', () => this.run(resetTableColumnWidths));
    columns.append(state, how, reset);
    builder.syncs.push(() => {
      const widths = attrs().columnWidths;
      const set = Array.isArray(widths) && widths.length > 0;
      setText(state, set ? 'Custom widths' : 'Automatic widths');
      setText(how, set ? 'Set per column in Columns ›' : 'Set a column’s width in Columns ›');
      reset.hidden = !set;
    });

    // CAPTION and LABEL: written after a pause in the typing (or on Enter,
    // blur, the panel closing), never per keystroke, and with no scroll.
    const caption = document.createElement('textarea');
    caption.className = 'tfield';
    caption.rows = 1;
    caption.spellcheck = true;
    caption.placeholder = 'Optional table caption';
    caption.setAttribute('aria-label', 'Caption');
    this.panelSection(builder, 'Caption', { top: true }).append(caption);
    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'tfield mono';
    label.spellcheck = false;
    label.autocomplete = 'off';
    label.maxLength = 128;
    label.placeholder = 'tbl:results';
    label.setAttribute('aria-label', 'Label');
    this.panelSection(builder, 'Label').append(label);
    const grow = () => {
      caption.style.height = 'auto';
      caption.style.height = `${caption.scrollHeight + 2}px`;
    };
    for (const [field, name] of [[caption, 'caption'], [label, 'label']] as const) {
      let timer = 0;
      const value = () => (name === 'label' ? normalizeTableLabel(field.value) : field.value.replace(/[\r\n]+/g, ' '));
      const flush = () => {
        if (timer) clearTimeout(timer);
        timer = 0;
        const at = pos();
        if (at === null) return;
        const next = value();
        if (String(attrs()[name] ?? '') !== next) setTableAttrsAt(this.view, at, { [name]: next });
      };
      const revert = () => {
        if (timer) return; // a write is pending: the field is ahead of the model
        const now = String(attrs()[name] ?? '');
        if (field.value !== now) {
          field.value = now;
          if (field === caption) grow();
        }
      };
      this.bindField(builder, field, { revert, commit: () => (flush(), true), flush });
      field.addEventListener('input', () => {
        if (name === 'label') {
          const normalized = normalizeTableLabel(field.value);
          if (normalized !== field.value) field.value = normalized;
        } else grow();
        if (timer) clearTimeout(timer);
        timer = window.setTimeout(flush, CAPTION_PAUSE);
      });
      field.addEventListener('blur', flush);
      // Closing the panel (a click on the page, a tile, the selection
      // leaving) writes what was typed, after the view's update is done.
      builder.cleanups.push(() => {
        if (timer) queueMicrotask(flush);
      });
    }
    // Sized once it is in the panel (a caption may wrap to two lines).
    builder.syncs.push(() => { if (caption.isConnected && !caption.style.height) grow(); });

    // The file's own styling Plass does not show (params): kept, said once.
    const advanced = document.createElement('div');
    advanced.className = 'native-table-advanced bp-advanced';
    advanced.textContent = 'Custom table styling is kept in the file and the PDF, but not shown here.';
    builder.el.append(advanced);
    builder.syncs.push(() => { advanced.hidden = !params(); });

    const foot = document.createElement('div');
    foot.className = 'bp-foot';
    const del = document.createElement('button');
    del.type = 'button';
    del.tabIndex = -1;
    del.className = 'bp-danger';
    del.setAttribute('aria-label', 'Delete table');
    del.innerHTML = `${icon('trash')}Delete table`;
    del.addEventListener('mousedown', (e) => e.preventDefault());
    del.addEventListener('click', () => {
      this.closeFlyout();
      this.run(deleteTable);
    });
    foot.append(del);
    builder.el.append(foot);
    return builder;
  }

  private gridLayout(builder: Builder, parent?: FlyoutId): Builder {
    this.back(builder, parent, parent === 'gridparent' ? 'Grid' : 'Grid controls');
    const grid = () => gridContext(this.view.state)?.node ?? null;
    const shares = () => (grid()?.attrs.columns as number[] | undefined) ?? [];

    // SPLIT: the presets for the current column count (never a different
    // count, nor does the field take one), the current split as its own
    // tile when it is none of them, and a Custom field showing it the way
    // it was likely written.
    const split = this.panelSection(builder, 'Split', { top: true, column: true });
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs split';
    thumbs.setAttribute('role', 'radiogroup');
    thumbs.setAttribute('aria-label', 'Column split');
    split.append(thumbs);
    let drawn = '';
    builder.syncs.push(() => {
      const now = shares();
      const presets = splitPresets(now.length);
      const offPreset = now.length > 0 && !presets.some((p) => sameSplit(p, now));
      const key = `${now.join(',')}`;
      if (key !== drawn) {
        drawn = key;
        const tiles = presets.map((p) => {
          const caption = now.length >= 4 ? 'Equal' : p.join(':');
          return this.splitThumb(p, caption);
        });
        if (offPreset) {
          const compact = displayColumnShares(now, true);
          tiles.push(this.splitThumb(now, compact.length <= 9 ? compact : 'Current'));
        }
        thumbs.replaceChildren(...tiles);
      }
      for (const tile of thumbs.querySelectorAll<HTMLButtonElement>('.thumb')) {
        setAttr(tile, 'aria-checked', String(sameSplit(JSON.parse(tile.dataset.shares ?? '[]') as number[], now)));
      }
    });
    this.pillField(builder, split, {
      name: 'Custom split',
      lead: 'Custom',
      wide: true,
      value: () => displayColumnShares(shares()),
      commit: (text) => {
        const next = parseColumnShares(text);
        if (!next) return false;
        const now = shares();
        // A split never changes the column count (a dropped column would
        // take its text with it): Columns adds and deletes them.
        if (next.length !== now.length) {
          notify(`Not applied: the split needs ${now.length} shares, one per column`);
          return false;
        }
        if (next.some((v, i) => v !== now[i])) setGridColumns(this.view, next, false);
        return false; // revert: the field shows the split as it reads (`2 : 1`, `46% : 54%`)
      },
    });

    // GUTTER: four presets and a Custom em field (checked when the gutter
    // is none of them).
    const gutterValue = () => Number(grid()?.attrs.gutter ?? DEFAULT_GRID_GUTTER_EM);
    const presetGutter = () => GUTTER_PRESETS.find(([value]) => Math.abs(Number(value) - gutterValue()) < 1e-6)?.[0] ?? null;
    const gutter = this.panelSection(builder, 'Gutter', { top: true, column: true });
    this.segmented(builder, gutter, 'Space between cells', GUTTER_PRESETS, presetGutter, (value) => setGridGutter(this.view, Number(value), false));
    this.pillField(builder, gutter, {
      name: 'Gutter in em',
      lead: 'Custom',
      unit: 'em',
      number: { min: 0, max: 10, step: '0.01' },
      value: () => (presetGutter() === null ? String(gutterValue()) : ''),
      placeholder: () => String(gutterValue()),
      checked: () => presetGutter() === null,
      commit: (text) => {
        if (!text) return false;
        const n = Number(text);
        if (!Number.isFinite(n) || n < 0 || n > 10) return false;
        setGridGutter(this.view, Math.round(n * 100) / 100, false);
        return false; // revert: the field shows the model's value (or the preset's dim one)
      },
    });

    const foot = document.createElement('div');
    foot.className = 'bp-foot';
    const unwrap = document.createElement('button');
    unwrap.type = 'button';
    unwrap.tabIndex = -1;
    unwrap.className = 'bp-item';
    unwrap.setAttribute('aria-label', 'Unwrap grid');
    unwrap.innerHTML = 'Unwrap grid<span class="bp-sub">Keeps its contents, in reading order</span>';
    unwrap.addEventListener('mousedown', (e) => e.preventDefault());
    unwrap.addEventListener('click', () => {
      this.closeFlyout();
      unwrapGrid(this.view);
    });
    foot.append(unwrap);
    builder.el.append(foot);
    return builder;
  }

  /** A split thumbnail: rounded bars as wide as their shares. */
  private splitThumb(shares: number[], caption: string): HTMLButtonElement {
    const gap = 2.5;
    const total = shares.reduce((a, b) => a + b, 0);
    let x = 0;
    const bars = shares.map((v) => {
      const w = ((48 - gap * (shares.length - 1)) * v) / total;
      const bar = `<rect x="${x.toFixed(2)}" y="7" width="${w.toFixed(2)}" height="14" rx="${Math.min(2.5, w / 2).toFixed(2)}" fill="currentColor" opacity=".7"/>`;
      x += w + gap;
      return bar;
    }).join('');
    const name = displayColumnShares(shares);
    const button = this.thumb(name, `Split ${name}`, `<svg viewBox="0 0 48 28" aria-hidden="true">${bars}</svg>`, caption);
    button.dataset.shares = JSON.stringify(shares);
    button.addEventListener('click', () => {
      const now = (gridContext(this.view.state)?.node.attrs.columns as number[] | undefined) ?? [];
      if (!sameSplit(shares, now)) setGridColumns(this.view, canonicalShares(shares));
      else this.view.focus();
    });
    return button;
  }

  private gridRowsMenu(builder: Builder, parent?: FlyoutId): Builder {
    const place = () => gridCaretPlace(this.cellState());
    this.back(builder, parent, parent === 'gridparent' ? 'Grid' : 'Grid controls');
    this.item(builder, 'Add row above', () => this.atCell(() => insertGridRowAt(this.view, 'above')), { name: 'Add row above', enabled: () => !!place(), kbd: '⇧⌘⏎' });
    this.item(builder, 'Add row below', () => this.atCell(() => insertGridRowAt(this.view, 'below')), { name: 'Add row below', enabled: () => !!place(), kbd: '⌘⏎' });
    this.divider(builder);
    this.item(builder, 'Delete row', () => this.atCell(() => deleteGridRowAt(this.view)), { name: 'Delete selected row', enabled: () => (place()?.rows ?? 0) > 1 });
    return builder;
  }

  private gridColsMenu(builder: Builder, parent?: FlyoutId): Builder {
    const place = () => gridCaretPlace(this.cellState());
    this.back(builder, parent, parent === 'gridparent' ? 'Grid' : 'Grid controls');
    this.item(builder, 'Add column left', () => this.atCell(() => insertGridColumnAt(this.view, 'left')), { name: 'Add column before', enabled: () => (place()?.columns ?? 12) < 12 });
    this.item(builder, 'Add column right', () => this.atCell(() => insertGridColumnAt(this.view, 'right')), { name: 'Add column after', enabled: () => (place()?.columns ?? 12) < 12 });
    this.divider(builder);
    this.item(builder, 'Delete column', () => this.atCell(() => deleteGridColumnAt(this.view)), { name: 'Delete selected column', enabled: () => (place()?.columns ?? 0) > 1 });
    // Merging across (grid.cell(colspan:)): the cells a selection spans in
    // one row, or the caret's cell and the next; never down.
    this.divider(builder);
    const spans = () => gridSelectionSpansCells(this.cellState());
    this.item(builder, 'Merge cells', () => this.run(mergeGridCells), {
      name: 'Merge selected cells', keepOpen: true, visible: spans, enabled: () => mergeGridCells(this.cellState()),
    });
    this.item(builder, 'Merge with cell right', () => this.run(mergeGridCells), {
      name: 'Merge with the cell to the right', keepOpen: true, visible: () => !spans(), enabled: () => mergeGridCells(this.cellState()),
    });
    this.item(builder, 'Split cell', () => this.run(splitGridCell), {
      name: 'Split merged cell', keepOpen: true, visible: () => splitGridCell(this.cellState()),
    });
    return builder;
  }

  /** The nested table's Grid tile: its grid's rows, columns and layout. */
  private gridParentMenu(builder: Builder): Builder {
    this.item(builder, 'Grid rows', () => this.reopen('gridrows', 'gridparent'), { submenu: true });
    this.item(builder, 'Grid columns', () => this.reopen('gridcols', 'gridparent'), { submenu: true });
    this.divider(builder);
    this.item(builder, 'Grid layout…', () => this.reopen('gridlayout', 'gridparent'), { dialog: true });
    return builder;
  }

  /** The collapsed pill's ⋯: every tile as a row. */
  private moreMenu(builder: Builder): Builder {
    const ctx = this.ctx!;
    if (ctx.kind === 'grid') {
      const place = () => gridCaretPlace(this.cellState());
      this.item(builder, 'Add row below', () => this.atCell(() => insertGridRowAt(this.view, 'below')), { enabled: () => !!place(), kbd: '⌘⏎' });
      this.item(builder, 'Add column right', () => this.atCell(() => insertGridColumnAt(this.view, 'right')), { enabled: () => (place()?.columns ?? 12) < 12 });
      this.divider(builder);
      this.item(builder, 'Rows', () => this.reopen('gridrows', 'more'), { submenu: true });
      this.item(builder, 'Columns', () => this.reopen('gridcols', 'more'), { submenu: true });
      this.item(builder, 'Align…', () => this.reopen('align', 'more'), { dialog: true });
      this.item(builder, 'Image in cell', () => this.insertImage(), { enabled: () => !!gridCaretPlace(this.cellState()) });
      this.divider(builder);
      this.item(builder, 'Grid layout…', () => this.reopen('gridlayout', 'more'), { dialog: true });
      return builder;
    }
    const state = () => this.cellState();
    this.item(builder, 'Add row below', () => this.run(insertTableRow('below')), { enabled: () => insertTableRow('below')(state()), kbd: '⌘⏎' });
    this.item(builder, 'Add column right', () => this.run(insertTableColumn('right')), { enabled: () => insertTableColumn('right')(state()) });
    this.divider(builder);
    this.item(builder, 'Rows', () => this.reopen('rows', 'more'), { submenu: true });
    this.item(builder, 'Columns', () => this.reopen('cols', 'more'), { submenu: true });
    this.item(builder, 'Align…', () => this.reopen('align', 'more'), { dialog: true });
    this.item(builder, 'Cell…', () => this.reopen('cell', 'more'), { dialog: true });
    this.divider(builder);
    this.item(builder, 'Table settings…', () => this.reopen('table', 'more'), { dialog: true });
    if (ctx.parentGrid) this.item(builder, 'Grid', () => this.reopen('gridparent', 'more'), { submenu: true });
    return builder;
  }

  destroy(): void {
    this.closeFlyout();
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.refly) cancelAnimationFrame(this.refly);
    if (this.settle) clearTimeout(this.settle);
    document.removeEventListener('mousedown', this.outside, true);
    document.removeEventListener('keydown', this.escape, true);
    window.removeEventListener('resize', this.resize);
    this.scroll.removeEventListener('scroll', this.scrolled);
    for (const off of this.unlisten) off();
    this.layer.remove();
    if (current === this) {
      current = null;
      setPillFocuser(null);
    }
  }
}

const blockChromeKey = new PluginKey('block-chrome');

const captionOf = (event: Event): HTMLElement | null => {
  const target = event.target;
  return target instanceof Element ? target.closest<HTMLElement>('.native-table-caption') : null;
};

/** The pill's plugin: a view (it holds no state of its own), and the
 *  on-page table caption as the way into Table settings. */
export function blockChromePlugin(): Plugin {
  return new Plugin({
    key: blockChromeKey,
    props: {
      handleDOMEvents: {
        // The caption is not text: a press there places no caret.
        mousedown: (_view, event) => {
          if (event.button !== 0 || !captionOf(event)) return false;
          event.preventDefault();
          return true;
        },
        click: (_view, event) => {
          const caption = captionOf(event);
          if (!caption || event.button !== 0) return false;
          event.preventDefault();
          current?.openCaption(caption);
          return true;
        },
      },
    },
    view: (view) => {
      const chrome = new BlockChrome(view);
      return {
        update: (next, prev) => chrome.update(next, prev),
        destroy: () => chrome.destroy(),
      };
    },
  });
}
