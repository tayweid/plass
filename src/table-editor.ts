// The table editing card: tables follow the math-editor pattern. The
// document shows only the compiled (PDF-exact) table; clicking it opens
// this focused card — a plain cell grid, structural controls, a live
// compiled preview — and saving replaces the table node in one undoable
// step. No dual rendering in the document, no floating cell inputs.

import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { docToTyp } from './typ-serializer';
import { getSettings } from './settings';

interface CellModel {
  text: string;
  align: string | null;
  colspan: number;
  rowspan: number;
  header: boolean;
  /** Cell with non-plain content, preserved verbatim unless its text is edited. */
  rich: PMNode | null;
}

interface GridModel {
  rows: CellModel[][];
  style: string;
  params: string;
}

function readModel(table: PMNode): GridModel {
  const rows: CellModel[][] = [];
  table.forEach((row) => {
    const cells: CellModel[] = [];
    row.forEach((cell) => {
      const plain =
        cell.childCount === 1 &&
        cell.child(0).type.name === 'paragraph' &&
        !cell.child(0).content.content.some((n) => !n.isText || n.marks.length > 0);
      cells.push({
        text: cell.textContent,
        align: (cell.attrs.align as string | null) ?? null,
        colspan: (cell.attrs.colspan as number) ?? 1,
        rowspan: (cell.attrs.rowspan as number) ?? 1,
        header: cell.type.name === 'table_header',
        rich: plain ? null : cell,
      });
    });
    rows.push(cells);
  });
  return { rows, style: (table.attrs.style as string) || 'booktabs', params: (table.attrs.params as string) || '' };
}

function buildNode(model: GridModel): PMNode {
  const { table, table_row, table_cell, table_header, paragraph } = schema.nodes;
  const rows = model.rows.map((cells) =>
    table_row.create(
      null,
      cells.map((c) => {
        if (c.rich && c.rich.textContent === c.text) {
          // Untouched rich cell: keep it (only align may have changed).
          return c.rich.type.create({ ...c.rich.attrs, align: c.align }, c.rich.content);
        }
        const type = c.header ? table_header : table_cell;
        return type.create(
          { align: c.align, colspan: c.colspan, rowspan: c.rowspan },
          [paragraph.create(null, c.text ? [schema.text(c.text)] : [])],
        );
      }),
    ),
  );
  return table.create({ style: model.style, params: model.params }, rows);
}

const STYLES = ['booktabs', 'grid', 'plain'];

let cardOpen = false;

/** Open the editing card for the table at `pos` (or insert a new one). */
export function openTableEditor(view: EditorView, pos: number) {
  if (cardOpen) return;
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type !== schema.nodes.table) return;
  cardOpen = true;

  const model = readModel(node);
  let focusCol = 0;

  const overlay = document.createElement('div');
  overlay.className = 'bib-editor-overlay table-card-overlay';
  overlay.innerHTML = `
    <div class="bib-editor table-card" role="dialog" aria-label="Edit table">
      <div class="bib-editor-head"><span>Table</span><span class="table-card-style"></span></div>
      <div class="table-card-tools">
        <button type="button" data-act="row+">+ Row</button>
        <button type="button" data-act="row-">− Row</button>
        <button type="button" data-act="col+">+ Col</button>
        <button type="button" data-act="col-">− Col</button>
        <span class="table-card-sep"></span>
        <button type="button" data-act="header">Header row</button>
        <span class="table-card-sep"></span>
        <button type="button" data-act="alignL" title="Align focused column left">L</button>
        <button type="button" data-act="alignC" title="Align focused column center">C</button>
        <button type="button" data-act="alignR" title="Align focused column right">R</button>
        <span class="table-card-sep"></span>
        <button type="button" data-act="style">Style</button>
        <button type="button" data-act="opts" title="Raw Typst #table arguments">Opts…</button>
      </div>
      <div class="table-card-grid"></div>
      <div class="table-card-preview"><div class="table-card-preview-label">Result</div><div class="table-card-preview-body"></div></div>
      <div class="bib-editor-foot">
        <span class="bib-editor-hint"><kbd>Tab</kbd>/<kbd>↑↓</kbd> move · <kbd>⌘Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
        <span class="bib-editor-actions">
          <button type="button" class="bib-cancel">Cancel</button>
          <button type="button" class="bib-save">Save</button>
        </span>
      </div>
    </div>`;
  const panel = overlay.querySelector('.table-card') as HTMLElement;
  const gridEl = overlay.querySelector('.table-card-grid') as HTMLElement;
  const previewBody = overlay.querySelector('.table-card-preview-body') as HTMLElement;
  const styleLabel = overlay.querySelector('.table-card-style') as HTMLElement;

  const cols = () => Math.max(...model.rows.map((r) => r.reduce((n, c) => n + c.colspan, 0)));

  const renderGrid = (focus?: { r: number; c: number }) => {
    styleLabel.textContent = model.style + (model.params ? ' + opts' : '');
    const t = document.createElement('table');
    model.rows.forEach((row, ri) => {
      const tr = document.createElement('tr');
      row.forEach((cell, ci) => {
        const td = document.createElement(cell.header ? 'th' : 'td');
        if (cell.colspan > 1) td.colSpan = cell.colspan;
        if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
        const input = document.createElement('input');
        input.value = cell.text;
        input.dataset.r = String(ri);
        input.dataset.c = String(ci);
        input.style.textAlign = cell.align ?? (cell.header ? 'center' : 'left');
        if (cell.rich) input.title = 'Contains rich content (math/references) — editing replaces it with plain text';
        input.addEventListener('input', () => {
          cell.text = input.value;
          schedulePreview();
        });
        input.addEventListener('focus', () => {
          focusCol = ci;
        });
        input.addEventListener('keydown', (e) => {
          const move = (dr: number, dc: number) => {
            const target = gridEl.querySelector<HTMLInputElement>(`input[data-r="${ri + dr}"][data-c="${ci + dc}"]`);
            if (target) {
              e.preventDefault();
              target.focus();
              target.select();
            }
          };
          if (e.key === 'ArrowUp') move(-1, 0);
          else if (e.key === 'ArrowDown' || e.key === 'Enter') move(1, 0);
          else if (e.key === 'ArrowLeft' && input.selectionStart === 0 && input.selectionEnd === 0) move(0, -1);
          else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) move(0, 1);
        });
        td.appendChild(input);
        tr.appendChild(td);
      });
      t.appendChild(tr);
    });
    gridEl.replaceChildren(t);
    if (focus) {
      const target = gridEl.querySelector<HTMLInputElement>(`input[data-r="${focus.r}"][data-c="${focus.c}"]`);
      (target ?? gridEl.querySelector('input'))?.focus();
    }
  };

  // ---------- live compiled preview ----------
  let previewTimer = 0;
  let lastSrc = '';
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => void compilePreview(), 300);
  };
  const compilePreview = async () => {
    try {
      const tempDoc = schema.nodes.doc.create(view.state.doc.attrs, [buildNode(model)]);
      const widthPx = view.dom.clientWidth || 576;
      let src = docToTyp(tempDoc);
      src = src.replace(/#set page\([^)]*\)/, `#set page(width: ${(widthPx * 0.75).toFixed(2)}pt, height: auto, margin: 0pt)`);
      if (src === lastSrc) return;
      const { compileSvg } = await import('./pdf');
      const svg = await compileSvg(src);
      if (!svg || !cardOpen) return;
      lastSrc = src;
      previewBody.innerHTML = svg;
      const svgEl = previewBody.querySelector('svg');
      if (svgEl) {
        svgEl.style.width = `${(parseFloat(svgEl.getAttribute('width') ?? '0') * 4) / 3}px`;
        svgEl.style.height = 'auto';
      }
    } catch (e) {
      console.warn('table preview failed', e);
    }
  };

  // ---------- structural actions ----------
  const focused = (): { r: number; c: number } => {
    const el = document.activeElement as HTMLInputElement | null;
    return { r: +(el?.dataset.r ?? 0), c: +(el?.dataset.c ?? focusCol) };
  };
  const blank = (header: boolean): CellModel => ({ text: '', align: null, colspan: 1, rowspan: 1, header, rich: null });

  overlay.querySelectorAll<HTMLButtonElement>('.table-card-tools button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = focused();
      switch (btn.dataset.act) {
        case 'row+':
          model.rows.splice(f.r + 1, 0, model.rows[f.r].map(() => blank(false)));
          renderGrid({ r: f.r + 1, c: f.c });
          break;
        case 'row-':
          if (model.rows.length > 1) {
            model.rows.splice(f.r, 1);
            renderGrid({ r: Math.max(0, f.r - 1), c: f.c });
          }
          break;
        case 'col+':
          model.rows.forEach((row) => row.splice(f.c + 1, 0, blank(row[0]?.header && row === model.rows[0] ? row[f.c].header : row[Math.min(f.c, row.length - 1)].header)));
          renderGrid({ r: f.r, c: f.c + 1 });
          break;
        case 'col-':
          if (cols() > 1) {
            model.rows.forEach((row) => row.length > 1 && row.splice(Math.min(f.c, row.length - 1), 1));
            renderGrid({ r: f.r, c: Math.max(0, f.c - 1) });
          }
          break;
        case 'header': {
          const on = !model.rows[0][0].header;
          model.rows[0].forEach((c) => (c.header = on));
          renderGrid({ r: 0, c: f.c });
          break;
        }
        case 'alignL':
        case 'alignC':
        case 'alignR': {
          const a = btn.dataset.act === 'alignL' ? 'left' : btn.dataset.act === 'alignC' ? 'center' : 'right';
          model.rows.forEach((row) => {
            if (row[f.c]) row[f.c].align = a === 'left' ? null : a;
          });
          renderGrid({ r: f.r, c: f.c });
          break;
        }
        case 'style':
          model.style = STYLES[(STYLES.indexOf(model.style) + 1) % STYLES.length];
          renderGrid({ r: f.r, c: f.c });
          break;
        case 'opts': {
          const params = prompt(
            'Raw #table arguments (advanced) — e.g. stroke: none, inset: 6pt, fill: (x, y) => if y == 0 { luma(240) }',
            model.params,
          );
          if (params !== null) {
            model.params = params.trim();
            renderGrid({ r: f.r, c: f.c });
          }
          break;
        }
      }
      schedulePreview();
    });
  });

  // ---------- lifecycle ----------
  const close = () => {
    cardOpen = false;
    clearTimeout(previewTimer);
    overlay.remove();
    view.focus();
  };
  const save = () => {
    const current = view.state.doc.nodeAt(pos);
    if (current && current.type === schema.nodes.table) {
      const tr = view.state.tr.replaceWith(pos, pos + current.nodeSize, buildNode(model));
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1));
      view.dispatch(tr);
    }
    close();
  };
  overlay.querySelector('.bib-save')!.addEventListener('click', save);
  overlay.querySelector('.bib-cancel')!.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => {
    if (!panel.contains(e.target as Node)) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  });

  document.body.appendChild(overlay);
  renderGrid({ r: model.rows[0]?.[0]?.header && model.rows.length > 1 ? 1 : 0, c: 0 });
  void compilePreview();
}

/** Insert a fresh table and open its editor. */
export function insertTableWithEditor(view: EditorView) {
  const { table, table_row, table_cell, table_header, paragraph } = schema.nodes;
  const mk = (header: boolean, text = '') =>
    (header ? table_header : table_cell).create(null, [paragraph.create(null, text ? [schema.text(text)] : [])]);
  const node = table.create({ style: 'booktabs' }, [
    table_row.create(null, [mk(true, 'Column 1'), mk(true, 'Column 2'), mk(true, 'Column 3')]),
    table_row.create(null, [mk(false), mk(false), mk(false)]),
    table_row.create(null, [mk(false), mk(false), mk(false)]),
  ]);
  const { $from } = view.state.selection;
  const insertPos = $from.after($from.depth > 0 ? 1 : 0);
  const tr = view.state.tr.insert(insertPos, node);
  tr.setSelection(NodeSelection.create(tr.doc, insertPos));
  view.dispatch(tr);
  view.focus();
  requestAnimationFrame(() => openTableEditor(view, insertPos));
}