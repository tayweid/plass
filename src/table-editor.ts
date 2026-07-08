// The table editing card: tables follow the math-editor pattern. The
// document shows only the compiled (PDF-exact) table; clicking it opens
// this focused card and saving replaces the node in one undoable step.
//
// The card is a small spreadsheet: a plain cell grid (Tab/arrows move,
// shift-click selects a range for merging), row-boundary strips toggle
// midrules (booktabs-style table.hline), and the Typst panel at the bottom
// always shows the full #table(...) arguments the current state produces —
// edits there parse back through the importer, so the GUI and the source
// stay two views of one thing. ⌘Z/⌘⇧Z operate on a card-local undo stack.

import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { docToTyp } from './typ-serializer';
import { parseTable } from './typ-parser';

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
  /** Custom #table params (midrules excluded — they live in `hlines`). */
  params: string;
  /** Row boundaries (1-based: above row n) carrying a midrule. */
  hlines: Set<number>;
  caption: string;
  label: string;
}

const HLINE_RE = /table\.hline\(\s*y\s*:\s*(\d+)[^)]*\)\s*,?/g;

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
  const hlines = new Set<number>();
  const raw = (table.attrs.params as string) || '';
  const params = raw
    .replace(HLINE_RE, (_, y) => {
      hlines.add(+y);
      return '';
    })
    .replace(/,\s*,/g, ',')
    .replace(/^\s*,\s*/, '')
    .replace(/[,\s]+$/, '')
    .trim();
  return {
    rows,
    style: (table.attrs.style as string) || 'booktabs',
    params,
    hlines,
    caption: (table.attrs.caption as string) || '',
    label: (table.attrs.label as string) || '',
  };
}

function composeParams(model: GridModel): string {
  const rules = [...model.hlines].sort((a, b) => a - b).map((y) => `table.hline(y: ${y}, stroke: 0.05em)`);
  return [model.params, ...rules].filter(Boolean).join(',\n');
}

function buildNode(model: GridModel): PMNode {
  const { table, table_row, table_cell, table_header, paragraph } = schema.nodes;
  const rows = model.rows.map((cells) =>
    table_row.create(
      null,
      cells.map((c) => {
        if (c.rich && c.rich.textContent === c.text) {
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
  return table.create(
    { style: model.style, params: composeParams(model), caption: model.caption, label: model.label },
    rows,
  );
}

function cloneModel(m: GridModel): GridModel {
  return {
    rows: m.rows.map((r) => r.map((c) => ({ ...c }))),
    style: m.style,
    params: m.params,
    hlines: new Set(m.hlines),
    caption: m.caption,
    label: m.label,
  };
}

const STYLES = ['booktabs', 'grid', 'plain'];
const CELL_ROW_RE = /^\s*(table\.header\(|\[|table\.cell\()/;

let cardOpen = false;

/** Open the editing card for the table at `pos`. */
export function openTableEditor(view: EditorView, pos: number) {
  if (cardOpen) return;
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type !== schema.nodes.table) return;
  cardOpen = true;

  let model = readModel(node);
  let focusCol = 0;
  let lastFocus = { r: 0, c: 0 };
  let anchor: { r: number; c: number } | null = null;
  let sel: { r0: number; c0: number; r1: number; c1: number } | null = null;

  // ---------- card-local undo ----------
  const undoStack: GridModel[] = [];
  const redoStack: GridModel[] = [];
  let typingCell: string | null = null;
  const snapshot = () => {
    undoStack.push(cloneModel(model));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  };
  const restore = (m: GridModel) => {
    model = m;
    sel = null;
    typingCell = null;
    renderGrid();
    captionInput.value = model.caption;
    labelInput.value = model.label;
    refreshPanel();
    schedulePreview();
  };

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
        <button type="button" data-act="merge" title="Merge the selected cells (shift-click to select a range)">Merge</button>
        <button type="button" data-act="split" title="Split the focused merged cell">Split</button>
        <span class="table-card-sep"></span>
        <button type="button" data-act="header">Header row</button>
        <span class="table-card-sep"></span>
        <button type="button" data-act="alignL" title="Align focused column left">L</button>
        <button type="button" data-act="alignC" title="Align focused column center">C</button>
        <button type="button" data-act="alignR" title="Align focused column right">R</button>
        <span class="table-card-sep"></span>
        <button type="button" data-act="style">Style</button>
      </div>
      <div class="table-card-grid"></div>
      <div class="table-card-meta">
        <input class="table-card-caption" placeholder="Caption — makes this “Table N: …”, numbered and referenceable" spellcheck="false">
        <input class="table-card-label" placeholder="label (@tab:…)" spellcheck="false">
      </div>
      <div class="table-card-preview"><div class="table-card-preview-label">Result</div><div class="table-card-preview-body"></div></div>
      <details class="table-card-typst">
        <summary>Typst <span class="table-card-typst-hint">— the full arguments this table compiles with; edit to fine-tune</span></summary>
        <textarea class="table-card-typst-text" rows="7" spellcheck="false"></textarea>
      </details>
      <div class="bib-editor-foot">
        <span class="bib-editor-hint">Click boundary between rows for a midrule · <kbd>⌘Z</kbd> undo · <kbd>⌘Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
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
  const typstText = overlay.querySelector('.table-card-typst-text') as HTMLTextAreaElement;
  const captionInput = overlay.querySelector('.table-card-caption') as HTMLInputElement;
  const labelInput = overlay.querySelector('.table-card-label') as HTMLInputElement;
  captionInput.value = model.caption;
  labelInput.value = model.label;
  captionInput.addEventListener('input', () => {
    model.caption = captionInput.value;
    schedulePreview();
  });
  labelInput.addEventListener('input', () => {
    model.label = labelInput.value.trim().replace(/[^a-zA-Z0-9:._-]/g, '-');
    schedulePreview();
  });

  const cols = () => Math.max(...model.rows.map((r) => r.reduce((n, c) => n + c.colspan, 0)));
  const noSpans = () => model.rows.every((r) => r.every((c) => c.colspan === 1 && c.rowspan === 1));

  // ---------- grid ----------
  const renderGrid = (focus?: { r: number; c: number }) => {
    styleLabel.textContent = model.style + (model.params ? ' + opts' : '');
    const t = document.createElement('table');
    const totalCols = cols();
    model.rows.forEach((row, ri) => {
      if (ri > 0) {
        const btr = document.createElement('tr');
        btr.className = 'tc-boundary' + (model.hlines.has(ri) ? ' tc-boundary-on' : '');
        btr.title = model.hlines.has(ri) ? 'Remove midrule' : 'Add midrule here';
        const btd = document.createElement('td');
        btd.colSpan = totalCols;
        btr.appendChild(btd);
        btr.addEventListener('click', () => {
          snapshot();
          if (model.hlines.has(ri)) model.hlines.delete(ri);
          else model.hlines.add(ri);
          renderGrid();
          refreshPanel();
          schedulePreview();
        });
        t.appendChild(btr);
      }
      const tr = document.createElement('tr');
      row.forEach((cell, ci) => {
        const td = document.createElement(cell.header ? 'th' : 'td');
        if (cell.colspan > 1) td.colSpan = cell.colspan;
        if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
        if (sel && ri >= sel.r0 && ri <= sel.r1 && ci >= sel.c0 && ci <= sel.c1) td.classList.add('tc-sel');
        const input = document.createElement('input');
        input.value = cell.text;
        input.dataset.r = String(ri);
        input.dataset.c = String(ci);
        input.style.textAlign = cell.align ?? (cell.header ? 'center' : 'left');
        if (cell.rich) input.title = 'Contains rich content (math/references) — editing replaces it with plain text';
        input.addEventListener('beforeinput', () => {
          const key = `${ri}:${ci}`;
          if (typingCell !== key) {
            snapshot();
            typingCell = key;
          }
        });
        input.addEventListener('input', () => {
          cell.text = input.value;
          refreshPanel();
          schedulePreview();
        });
        input.addEventListener('focus', () => {
          focusCol = ci;
          lastFocus = { r: ri, c: ci };
        });
        input.addEventListener('mousedown', (e) => {
          if (e.shiftKey && anchor) {
            e.preventDefault();
            sel = {
              r0: Math.min(anchor.r, ri),
              c0: Math.min(anchor.c, ci),
              r1: Math.max(anchor.r, ri),
              c1: Math.max(anchor.c, ci),
            };
            renderGrid();
          } else {
            anchor = { r: ri, c: ci };
            if (sel) {
              sel = null;
              renderGrid({ r: ri, c: ci });
            }
          }
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
          else if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) move(1, 0);
          else if (e.key === 'ArrowLeft' && input.selectionStart === 0 && input.selectionEnd === 0) move(0, -1);
          else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) move(0, 1);
        });
        td.appendChild(input);
        tr.appendChild(td);
      });
      t.appendChild(tr);
    });
    gridEl.replaceChildren(t);
    const spanFree = noSpans();
    overlay.querySelectorAll<HTMLButtonElement>('[data-act="row+"],[data-act="row-"],[data-act="col+"],[data-act="col-"]').forEach((b) => {
      b.disabled = !spanFree;
      b.title = spanFree ? '' : 'Split merged cells before changing the table shape';
    });
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
  const emit = (): string => {
    const tempDoc = schema.nodes.doc.create(view.state.doc.attrs, [buildNode(model)]);
    const widthPx = view.dom.clientWidth || 576;
    let src = docToTyp(tempDoc).replace(
      /#set page\((.*)\)/,
      `#set page(width: ${(widthPx * 0.75).toFixed(2)}pt, height: auto, margin: 0pt)`,
    );
    if (model.caption || model.label) {
      let index = 0;
      let seen = 0;
      view.state.doc.descendants((n) => {
        if (n.type.name === 'table') {
          seen++;
          if (n === view.state.doc.nodeAt(pos)) index = seen;
          return false;
        }
        return true;
      });
      src = src.replace(
        '\n\n#figure(',
        `\n\n#counter(figure.where(kind: table)).update(${Math.max(0, index - 1)})\n#figure(`,
      );
    }
    return src;
  };
  const compilePreview = async () => {
    try {
      const src = emit();
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

  // ---------- the Typst panel (bidirectional) ----------
  const callBody = (): { args: string[]; rows: string[] } => {
    const emitted = emit();
    const open = emitted.indexOf('table(\n');
    const closeIdx = emitted.lastIndexOf('\n))');
    const body = emitted.slice(open + 'table(\n'.length, closeIdx);
    const lines = body.split('\n');
    return {
      args: lines.filter((l) => !CELL_ROW_RE.test(l)).map((l) => l.replace(/^  /, '')),
      rows: lines.filter((l) => CELL_ROW_RE.test(l)),
    };
  };
  const refreshPanel = () => {
    if (document.activeElement === typstText) return;
    typstText.value = callBody().args.join('\n');
    typstText.classList.remove('tc-typst-bad');
  };
  let panelTimer = 0;
  typstText.addEventListener('input', () => {
    clearTimeout(panelTimer);
    panelTimer = window.setTimeout(() => {
      const { rows } = callBody();
      const argsText = typstText.value
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => '  ' + l.replace(/,?\s*$/, ','))
        .join('\n');
      const src = `#table(\n${argsText}\n${rows.join('\n')}\n)`;
      const parsed = parseTable(src);
      if (!parsed) {
        typstText.classList.add('tc-typst-bad');
        return;
      }
      typstText.classList.remove('tc-typst-bad');
      snapshot();
      model = readModel(parsed);
      renderGrid();
      schedulePreview();
      styleLabel.textContent = model.style + (model.params ? ' + opts' : '');
    }, 500);
  });
  typstText.addEventListener('blur', () => refreshPanel());

  // ---------- structural actions ----------
  const focused = (): { r: number; c: number } => {
    const el = document.activeElement as HTMLInputElement | null;
    // Tool buttons steal focus before their click handlers run — fall back
    // to the last focused cell.
    if (el?.dataset.r !== undefined) return { r: +el.dataset.r, c: +(el.dataset.c ?? 0) };
    return lastFocus;
  };
  const blank = (header: boolean): CellModel => ({ text: '', align: null, colspan: 1, rowspan: 1, header, rich: null });

  overlay.querySelectorAll<HTMLButtonElement>('.table-card-tools button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = focused();
      switch (btn.dataset.act) {
        case 'row+':
          snapshot();
          model.rows.splice(f.r + 1, 0, model.rows[f.r].map(() => blank(false)));
          renderGrid({ r: f.r + 1, c: f.c });
          break;
        case 'row-':
          if (model.rows.length > 1) {
            snapshot();
            model.rows.splice(f.r, 1);
            model.hlines = new Set([...model.hlines].filter((y) => y <= model.rows.length - 1).map((y) => (y > f.r ? y - 1 : y)));
            renderGrid({ r: Math.max(0, f.r - 1), c: f.c });
          }
          break;
        case 'col+':
          snapshot();
          model.rows.forEach((row) => row.splice(Math.min(f.c + 1, row.length), 0, blank(row[Math.min(f.c, row.length - 1)].header)));
          renderGrid({ r: f.r, c: f.c + 1 });
          break;
        case 'col-':
          if (cols() > 1) {
            snapshot();
            model.rows.forEach((row) => row.length > 1 && row.splice(Math.min(f.c, row.length - 1), 1));
            renderGrid({ r: f.r, c: Math.max(0, f.c - 1) });
          }
          break;
        case 'merge': {
          if (!sel || (sel.r0 === sel.r1 && sel.c0 === sel.c1)) break;
          if (!noSpans()) break;
          const box = sel;
          snapshot();
          const texts: string[] = [];
          for (let r = box.r0; r <= box.r1; r++)
            for (let c = box.c0; c <= box.c1; c++) {
              const txt = model.rows[r][c].text.trim();
              if (txt) texts.push(txt);
            }
          const target = model.rows[box.r0][box.c0];
          target.text = texts.join(' ');
          target.colspan = box.c1 - box.c0 + 1;
          target.rowspan = box.r1 - box.r0 + 1;
          target.rich = null;
          for (let r = box.r0; r <= box.r1; r++) {
            const keep = r === box.r0 ? box.c0 : -1;
            model.rows[r] = model.rows[r].filter((_, c) => c < box.c0 || c > box.c1 || c === keep);
          }
          sel = null;
          renderGrid({ r: box.r0, c: box.c0 });
          break;
        }
        case 'split': {
          const cell = model.rows[f.r]?.[f.c];
          if (!cell || (cell.colspan === 1 && cell.rowspan === 1)) break;
          snapshot();
          const w = cell.colspan;
          const h = cell.rowspan;
          cell.colspan = 1;
          cell.rowspan = 1;
          for (let k = 1; k < w; k++) model.rows[f.r].splice(f.c + 1, 0, blank(cell.header));
          for (let r = f.r + 1; r < f.r + h && r < model.rows.length; r++) {
            for (let k = 0; k < w; k++) model.rows[r].splice(Math.min(f.c, model.rows[r].length), 0, blank(false));
          }
          renderGrid({ r: f.r, c: f.c });
          break;
        }
        case 'header': {
          snapshot();
          const on = !model.rows[0][0].header;
          model.rows[0].forEach((c) => (c.header = on));
          renderGrid({ r: 0, c: f.c });
          break;
        }
        case 'alignL':
        case 'alignC':
        case 'alignR': {
          snapshot();
          const a = btn.dataset.act === 'alignL' ? 'left' : btn.dataset.act === 'alignC' ? 'center' : 'right';
          model.rows.forEach((row) => {
            if (row[f.c]) row[f.c].align = a === 'left' ? null : a;
          });
          renderGrid({ r: f.r, c: f.c });
          break;
        }
        case 'style':
          snapshot();
          model.style = STYLES[(STYLES.indexOf(model.style) + 1) % STYLES.length];
          renderGrid({ r: f.r, c: f.c });
          break;
      }
      typingCell = null;
      refreshPanel();
      schedulePreview();
    });
  });

  // ---------- lifecycle ----------
  const close = () => {
    cardOpen = false;
    clearTimeout(previewTimer);
    clearTimeout(panelTimer);
    document.removeEventListener('keydown', onKey, true);
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
    // Only a genuine backdrop press closes — grid re-renders mid-dispatch
    // can detach the event target, which must not read as "outside".
    if (e.target === overlay) close();
  });
  // Document-level while the card is open: boundary clicks and tool buttons
  // leave nothing focused inside the overlay, and the browser's own ⌘Z
  // (Safari: "reopen closed tab") must never win.
  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && mod) {
      e.preventDefault();
      save();
    } else if (mod && e.key.toLowerCase() === 'z' && document.activeElement !== typstText) {
      // Card-local undo/redo (covers structural changes and typing alike).
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        if (redoStack.length) {
          undoStack.push(cloneModel(model));
          restore(redoStack.pop()!);
        }
      } else if (undoStack.length) {
        redoStack.push(cloneModel(model));
        restore(undoStack.pop()!);
      }
    }
  };
  document.addEventListener('keydown', onKey, true);

  document.body.appendChild(overlay);
  renderGrid({ r: model.rows[0]?.[0]?.header && model.rows.length > 1 ? 1 : 0, c: 0 });
  refreshPanel();
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
