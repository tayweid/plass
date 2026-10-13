// The block pill: the controls of the table or grid the caret is in, a
// small dark column of rail tiles in the page's left margin, level with
// the block (design: scratchpad spec §4; Taylor's decisions 3–6).
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
// (compact: 8 px, 34 px wide, for a 46–60 px margin; under 46 px one ⋯
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
import { CellSelection, addRowBefore, deleteTable, isInTable, mergeCells, selectedRect, setCellAttr, splitCell, toggleHeaderRow } from 'prosemirror-tables';
import { schema } from './schema';
import { icon } from './toolbar';
import { placeFlyout } from './flyout';
import { onPaperScale, paperScale } from './paper-scale';
import { pickAndInsertFigure } from './figures';
import { normalizeTableColumns } from './table-geometry';
import {
  addBodyRowAfter,
  addColumnAfter,
  addColumnBefore,
  alignSelectedTableCells,
  deleteSelectedColumns,
  deleteSelectedRows,
  resetTableColumnWidths,
  selectTableLine,
  selectedCellsAttr,
  selectedColumnWidth,
  selectedRowIsHeader,
  selectedTableRows,
  setRowRule,
  setSelectedColumnWidth,
  tableControlsRevision,
} from './table-editor';
import {
  deleteGridColumnAt,
  deleteGridRowAt,
  gridCaretPlace,
  insertGridColumnAt,
  insertGridRowAt,
  unwrapGrid,
} from './grid-editor';
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

const gridKey = (node: PMNode) => `${(node.attrs.columns as number[]).join(',')}/${node.attrs.gutter}/${node.childCount}`;

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

// ---------------------------------------------------------------------------
// Flyouts

interface OpenFlyout {
  id: FlyoutId;
  el: HTMLElement;
  tile: HTMLButtonElement;
  sync: () => void;
  parent?: FlyoutId;
  side: 'end' | 'start';
}

/** What builds a flyout's content: its syncs keep the checked states and
 *  values current while it is open. */
interface Builder {
  el: HTMLElement;
  syncs: Array<() => void>;
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
  private readonly unlisten: Array<() => void> = [];

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
    const rows: TileSpec = { id: 'rows', glyph: icon('rows'), caption: 'Rows', flyout: 'rows', popup: 'menu' };
    const cols: TileSpec = { id: 'cols', glyph: icon('cols'), caption: 'Columns', flyout: 'cols', popup: 'menu' };
    if (layout === 'collapsed') {
      const kind = this.ctx?.kind === 'grid' ? 'Grid' : 'Table';
      return [{ id: 'more', glyph: '<span class="ico tico">⋯</span>', caption: `${kind} controls`, flyout: 'more', popup: 'menu' }];
    }
    if (layout === 'grid') {
      return [
        { ...rows, flyout: 'gridrows' },
        { ...cols, flyout: 'gridcols' },
        { id: 'image', glyph: icon('image'), caption: 'Image in cell', action: () => this.insertImage() },
        '|',
        { id: 'grid', glyph: icon('grid'), caption: 'Grid layout', flyout: 'gridlayout', popup: 'dialog' },
      ];
    }
    const table: Array<TileSpec | '|'> = [
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
    const label = this.ctx.kind === 'grid' ? 'Grid block controls' : 'Table block controls';
    setAttr(this.pill, 'aria-label', label);
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
    const state = this.view.state;
    const inTable = isInTable(state);
    const place = gridCaretPlace(state);
    const align = this.tiles.get('align');
    if (align) {
      const value = selectedCellsAttr(state, 'align');
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
    for (const id of ['rows', 'cols', 'align', 'cell']) {
      const tile = this.tiles.get(id);
      if (!tile) continue;
      const disabled = ctx.kind === 'table' ? !inTable : !place;
      if (tile.disabled !== disabled) tile.disabled = disabled;
    }
    const image = this.tiles.get('image');
    if (image) {
      const disabled = !place;
      if (image.disabled !== disabled) image.disabled = disabled;
    }
    // The readout for assistive tech (spec §6), and the image hint.
    let readout = '';
    if (ctx.kind === 'grid' && place) readout = `Row ${place.row + 1} of ${place.rows} · Column ${place.column + 1} of ${place.columns}`;
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
    const gap = mode === 'full' ? 14 : 8;
    const rest = mode === 'collapsed' ? paperLeft + 4 : textLeft - gap - width;
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
    const captionId = outer.getAttribute('aria-describedby');
    const caption = captionId ? document.getElementById(captionId) : null;
    if (caption?.classList.contains('native-table-caption')) {
      // The caption's text, not its box: the box is the column's width.
      const range = document.createRange();
      range.selectNodeContents(caption);
      const r = range.getBoundingClientRect();
      if (r.height > 0) {
        // Its line box starts above its ink by about a fifth of an em: a
        // pill ending in that band ends above the caption's letters.
        const air = (parseFloat(getComputedStyle(caption).fontSize) || 13) * s * 0.2;
        if (r.top + air < top + pillHeight) edge = Math.min(edge, r.left);
        extent = Math.max(extent, r.bottom);
      }
    }
    // Collapsed, the ⋯ tile keeps to the paper's edge (spec §4.1): its
    // menu then covers only the block's left part.
    const fits = mode !== 'collapsed' && top + pillHeight <= extent + 2;
    const left = fits ? Math.max(rest, edge - gap - width) : rest;
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
    this.flyout = { id, el, tile, sync, parent, side: 'end' };
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
    open.side = placeFlyout(open.el, open.tile, { side: this.hug ? 'start' : 'end' });
    open.el.classList.toggle('bc-start', open.side === 'start');
  }

  closeFlyout(restoreFocus = false): void {
    const open = this.flyout;
    if (!open) return;
    this.flyout = null;
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
    const done = command(this.view.state, this.view.dispatch, this.view);
    if (focus) this.view.focus();
    return done;
  }

  private insertImage(): void {
    this.closeFlyout();
    pickAndInsertFigure(this.view, 'inline');
  }

  // -- flyout content -------------------------------------------------------

  private content(id: FlyoutId, parent?: FlyoutId): Builder | null {
    const b = (cls: string, role: 'menu' | 'dialog', label: string): Builder => {
      const el = document.createElement('div');
      el.className = cls;
      el.setAttribute('role', role);
      el.setAttribute('aria-label', label);
      return { el, syncs: [] };
    };
    const ctx = this.ctx;
    if (!ctx) return null;
    switch (id) {
      case 'rows': return this.rowsMenu(b('tb-menu bc-menu', 'menu', 'Rows'), parent);
      case 'cols': return this.colsMenu(b('tb-menu bc-menu bc-colsmenu', 'menu', 'Columns'), parent);
      case 'align': return this.alignPanel(b('tb-menu tb-menu-extras bc-panel bc-alignpanel', 'dialog', 'Align'), parent);
      case 'cell': return this.cellPanel(b('tb-menu tb-menu-extras bc-panel bc-cellpanel', 'dialog', 'Cell fill and rules'), parent);
      case 'table': return this.tableStub(b('tb-menu block-panel', 'dialog', 'Table settings'), parent);
      case 'grid':
      case 'gridlayout': return this.gridStub(b('tb-menu block-panel', 'dialog', 'Grid layout'), parent);
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
    const state = () => this.view.state;
    this.back(builder, parent, parent === 'more' ? 'Table controls' : 'Grid');
    this.item(builder, 'Add row above', () => this.run(addRowBefore), { name: 'Add row above', enabled: () => addRowBefore(state()) });
    this.item(builder, 'Add row below', () => this.run(addBodyRowAfter), { name: 'Add row below', enabled: () => addBodyRowAfter(state()) });
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
    const state = () => this.view.state;
    this.back(builder, parent, parent === 'more' ? 'Table controls' : 'Grid');
    this.item(builder, 'Add column left', () => this.run(addColumnBefore), { name: 'Add column before', enabled: () => addColumnBefore(state()) });
    this.item(builder, 'Add column right', () => this.run(addColumnAfter), { name: 'Add column after', enabled: () => addColumnAfter(state()) });
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
        const revert = () => { input!.value = String(value()); };
        const commit = () => {
          const n = input!.valueAsNumber;
          if (!input!.validity.valid || !Number.isFinite(n) || (mode === 'fr' && n <= 0) || n < 0) {
            revert();
            return;
          }
          if (!this.run(setSelectedColumnWidth(`${n}${mode}`), false)) revert();
        };
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('change', commit);
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
    const state = () => this.view.state;
    this.back(builder, parent, 'Table controls');
    const across = this.section(builder, 'Across', 'Selected cells horizontal alignment');
    for (const value of ['left', 'center', 'right'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tb-btn';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', `Align selected cells ${value}`);
      button.dataset.value = value;
      button.innerHTML = icon(`align${value}`);
      this.caption(builder, button, ALIGN_NAME[value]);
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => this.run(alignSelectedTableCells(value)));
      builder.syncs.push(() => {
        setAttr(button, 'aria-checked', String(selectedCellsAttr(state(), 'align') === value));
        const disabled = !isInTable(state());
        if (button.disabled !== disabled) button.disabled = disabled;
      });
      across.append(button);
    }
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
    builder.syncs.push(() => { decimal.hidden = selectedCellsAttr(state(), 'align') !== 'decimal'; });
    this.note(builder, across, () => (selectedCellsAttr(state(), 'align') === 'mixed' ? 'Mixed' : ''));
    const down = this.section(builder, 'Down', 'Selected cells vertical alignment');
    for (const [value, glyph, name] of [['top', 'valigntop', 'Top'], ['middle', 'valignmid', 'Middle'], ['bottom', 'valignbot', 'Bottom']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tb-btn';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', `Align selected cells ${value}`);
      button.dataset.value = value;
      button.innerHTML = icon(glyph);
      this.caption(builder, button, name);
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => this.run(setCellAttr('valign', value)));
      builder.syncs.push(() => {
        setAttr(button, 'aria-checked', String(selectedCellsAttr(state(), 'valign') === value));
        const disabled = !isInTable(state());
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
    const state = () => this.view.state;
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

  /** Table settings: the full panel is the next step (spec §5.1); until
   *  then the bar above the page holds style, size, padding, caption and
   *  label, and this says so. */
  private tableStub(builder: Builder, parent?: FlyoutId): Builder {
    this.back(builder, parent, 'Table controls');
    const note = document.createElement('div');
    note.className = 'bp-sec';
    note.innerHTML = '<span class="bp-head">Table</span><span class="bp-note">Style, text size, padding, caption and label are in the table bar above the page for now.</span>';
    builder.el.append(note);
    const foot = document.createElement('div');
    foot.className = 'bp-foot';
    const del = document.createElement('button');
    del.type = 'button';
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

  /** Grid layout: the split and gutter panel is the next step (spec §5.2). */
  private gridStub(builder: Builder, parent?: FlyoutId): Builder {
    this.back(builder, parent, parent === 'gridparent' ? 'Grid' : 'Grid controls');
    const note = document.createElement('div');
    note.className = 'bp-sec';
    note.innerHTML = '<span class="bp-head">Grid</span><span class="bp-note">The split and the gutter are in the grid bar above the page for now.</span>';
    builder.el.append(note);
    const foot = document.createElement('div');
    foot.className = 'bp-foot';
    const unwrap = document.createElement('button');
    unwrap.type = 'button';
    unwrap.className = 'bp-item';
    unwrap.innerHTML = 'Unwrap grid<span class="bp-sub">Remove the grid, keep its contents in reading order</span>';
    unwrap.addEventListener('mousedown', (e) => e.preventDefault());
    unwrap.addEventListener('click', () => {
      this.closeFlyout();
      unwrapGrid(this.view);
    });
    foot.append(unwrap);
    builder.el.append(foot);
    return builder;
  }

  private gridRowsMenu(builder: Builder, parent?: FlyoutId): Builder {
    const place = () => gridCaretPlace(this.view.state);
    this.back(builder, parent, parent === 'gridparent' ? 'Grid' : 'Grid controls');
    this.item(builder, 'Add row above', () => insertGridRowAt(this.view, 'above'), { name: 'Add row above', enabled: () => !!place() });
    this.item(builder, 'Add row below', () => insertGridRowAt(this.view, 'below'), { name: 'Add row below', enabled: () => !!place() });
    this.divider(builder);
    this.item(builder, 'Delete row', () => deleteGridRowAt(this.view), { name: 'Delete selected row', enabled: () => (place()?.rows ?? 0) > 1 });
    return builder;
  }

  private gridColsMenu(builder: Builder, parent?: FlyoutId): Builder {
    const place = () => gridCaretPlace(this.view.state);
    this.back(builder, parent, parent === 'gridparent' ? 'Grid' : 'Grid controls');
    this.item(builder, 'Add column left', () => insertGridColumnAt(this.view, 'left'), { name: 'Add column before', enabled: () => (place()?.columns ?? 12) < 12 });
    this.item(builder, 'Add column right', () => insertGridColumnAt(this.view, 'right'), { name: 'Add column after', enabled: () => (place()?.columns ?? 12) < 12 });
    this.divider(builder);
    this.item(builder, 'Delete column', () => deleteGridColumnAt(this.view), { name: 'Delete selected column', enabled: () => (place()?.columns ?? 0) > 1 });
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
      this.item(builder, 'Rows', () => this.reopen('gridrows', 'more'), { submenu: true });
      this.item(builder, 'Columns', () => this.reopen('gridcols', 'more'), { submenu: true });
      this.item(builder, 'Image in cell', () => this.insertImage(), { enabled: () => !!gridCaretPlace(this.view.state) });
      this.divider(builder);
      this.item(builder, 'Grid layout…', () => this.reopen('gridlayout', 'more'), { dialog: true });
      return builder;
    }
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
    if (current === this) current = null;
  }
}

const blockChromeKey = new PluginKey('block-chrome');

/** The pill's plugin: a view only (it holds no state of its own). */
export function blockChromePlugin(): Plugin {
  return new Plugin({
    key: blockChromeKey,
    view: (view) => {
      const chrome = new BlockChrome(view);
      return {
        update: (next, prev) => chrome.update(next, prev),
        destroy: () => chrome.destroy(),
      };
    },
  });
}
