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
  /** Row boundaries (1-based: above row n) carrying a midrule, with its
   * weight ('light' 0.05em | 'heavy' 0.08em | 'none' = suppress a preset
   * rule at this boundary). */
  hlines: Map<number, 'light' | 'heavy' | 'none'>;
  /** The header boundary's entry is the booktabs preset (not user-set):
   * emit nothing for it unless the user changes it. */
  implicitHeaderRule: boolean;
  caption: string;
  label: string;
  /** Per-column widths ('auto' | '1fr' | '2cm' | …). */
  widths: string[];
  /** Fill preset ('none' | 'header' | 'zebra' | 'both' | 'custom'). */
  fill: string;
  /** Table text size ('' = document size, else e.g. '0.85em'). */
  fontSize: string;
  /** Column boundaries (1..cols-1) carrying a vertical rule. */
  vlines: Set<number>;
  /** Cell inset preset ('' = Typst default, else a canonical length). */
  inset: string;
}

const HLINE_RE = /table\.hline\(\s*y\s*:\s*(\d+)(?:[^)]*?stroke\s*:\s*(none|[\d.]+em))?[^)]*\)\s*,?/g;
const VLINE_RE = /table\.vline\(\s*x\s*:\s*(\d+)[^)]*\)\s*,?/g;
const COLUMNS_RE = /columns\s*:\s*\(([^)]*)\)\s*,?/;
// Density presets: Typst's table default inset is 5pt.
const INSETS: Record<string, string> = { compact: '3pt', roomy: '8pt' };
const INSET_RE = /(^|[\s,(])inset\s*:\s*(3pt|8pt)\s*,?/;

// Canonical fill presets (recognized on read, emitted on write).
const FILLS: Record<string, string> = {
  header: 'fill: (x, y) => if y == 0 { luma(240) }',
  zebra: 'fill: (x, y) => if calc.odd(y) { luma(248) }',
  both: 'fill: (x, y) => if y == 0 { luma(240) } else if calc.odd(y) { luma(248) }',
};

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
  const hlines = new Map<number, 'light' | 'heavy' | 'none'>();
  const vlines = new Set<number>();
  let inset = '';
  const raw = (table.attrs.params as string) || '';
  let widths: string[] = [];
  const params = raw
    .replace(HLINE_RE, (_, y, stroke) => {
      hlines.set(
        +y,
        stroke === 'none' ? 'none' : parseFloat(stroke ?? '0.05') >= 0.07 ? 'heavy' : 'light',
      );
      return '';
    })
    .replace(VLINE_RE, (_, x) => {
      vlines.add(+x);
      return '';
    })
    .replace(COLUMNS_RE, (_, tuple: string) => {
      widths = tuple.split(',').map((w) => w.trim()).filter(Boolean);
      return '';
    })
    .replace(INSET_RE, (_, pre: string, val: string) => {
      inset = val;
      return pre;
    })
    .replace(/,\s*,/g, ',')
    .replace(/^\s*,\s*/, '')
    .replace(/[,\s]+$/, '')
    .trim();
  const colCount = Math.max(...rows.map((r) => r.reduce((n, c) => n + c.colspan, 0)));
  while (widths.length < colCount) widths.push('auto');
  widths = widths.slice(0, colCount);
  let fill = 'none';
  let cleaned = params;
  // Most specific first — 'header' is a prefix of 'both'.
  for (const mode of ['both', 'header', 'zebra']) {
    const pattern = FILLS[mode];
    if (cleaned.includes(pattern)) {
      fill = mode;
      cleaned = cleaned.replace(pattern, '').replace(/,\s*,/g, ',').replace(/^\s*,\s*/, '').replace(/[,\s]+$/, '').trim();
      break;
    }
  }
  if (fill === 'none' && /(^|[\s,(])fill\s*:/.test(cleaned)) fill = 'custom';
  // Booktabs draws a preset midrule under the header row: surface it in
  // the model so boundary clicks can change or suppress it.
  const style0 = (table.attrs.style as string) || 'booktabs';
  const hasHeader0 = rows[0]?.some((c) => c.header) ?? false;
  let implicitHeaderRule = false;
  if (style0 === 'booktabs' && hasHeader0 && !hlines.has(1)) {
    hlines.set(1, 'light');
    implicitHeaderRule = true;
  }
  return {
    rows,
    style: style0,
    params: cleaned,
    hlines,
    caption: (table.attrs.caption as string) || '',
    label: (table.attrs.label as string) || '',
    widths,
    fill,
    fontSize: (table.attrs.fontSize as string) || '',
    vlines,
    inset,
    implicitHeaderRule,
  };
}

function composeParams(model: GridModel): string {
  const parts: string[] = [];
  if (model.widths.some((w) => w !== 'auto')) parts.push(`columns: (${model.widths.join(', ')})`);
  if (FILLS[model.fill]) parts.push(FILLS[model.fill]);
  if (model.inset) parts.push(`inset: ${model.inset}`);
  if (model.params) parts.push(model.params);
  for (const [y, w] of [...model.hlines.entries()].sort((a, b) => a[0] - b[0])) {
    if (y === 1 && model.implicitHeaderRule && w === 'light') continue; // the preset itself
    parts.push(`table.hline(y: ${y}, stroke: ${w === 'none' ? 'none' : w === 'heavy' ? '0.08em' : '0.05em'})`);
  }
  for (const x of [...model.vlines].sort((a, b) => a - b)) parts.push(`table.vline(x: ${x}, stroke: 0.05em)`);
  return parts.join(',\n');
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
    {
      style: model.style,
      params: composeParams(model),
      caption: model.caption,
      label: model.label,
      fontSize: model.fontSize,
    },
    rows,
  );
}

function cloneModel(m: GridModel): GridModel {
  return {
    rows: m.rows.map((r) => r.map((c) => ({ ...c }))),
    style: m.style,
    params: m.params,
    hlines: new Map(m.hlines),
    caption: m.caption,
    label: m.label,
    widths: [...m.widths],
    fill: m.fill,
    fontSize: m.fontSize,
    vlines: new Set(m.vlines),
    inset: m.inset,
    implicitHeaderRule: m.implicitHeaderRule,
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
    fillSelect.value = model.fill;
    sizeSelect.value = model.fontSize;
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
        <button type="button" data-act="alignD" title="Align focused column on the decimal point">.0</button>
        <span class="table-card-sep"></span>
        <button type="button" data-act="style">Style</button>
        <select class="table-card-size" title="Table text size">
          <option value="">100%</option>
          <option value="0.9em">90%</option>
          <option value="0.85em">85%</option>
          <option value="0.8em">80%</option>
          <option value="0.75em">75%</option>
        </select>
        <select class="table-card-inset" title="Cell density">
          <option value="">Normal</option>
          <option value="3pt">Compact</option>
          <option value="8pt">Roomy</option>
        </select>
        <select class="table-card-fill" title="Row shading">
          <option value="none">No fill</option>
          <option value="header">Header fill</option>
          <option value="zebra">Zebra</option>
          <option value="both">Header + zebra</option>
        </select>
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
        <span class="bib-editor-hint">Click between rows for a rule (cycles light · heavy · none) · between column widths for a vertical rule · <kbd>⌘Z</kbd> undo · <kbd>⌘Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
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
  const sizeSelect = overlay.querySelector('.table-card-size') as HTMLSelectElement;
  if (model.fontSize && ![...sizeSelect.options].some((o) => o.value === model.fontSize)) {
    const opt = document.createElement('option');
    opt.value = model.fontSize;
    opt.textContent = model.fontSize;
    sizeSelect.appendChild(opt);
  }
  sizeSelect.value = model.fontSize;
  sizeSelect.addEventListener('change', () => {
    snapshot();
    model.fontSize = sizeSelect.value;
    refreshPanel();
    schedulePreview();
  });
  const fillSelect = overlay.querySelector('.table-card-fill') as HTMLSelectElement;
  if (model.fill === 'custom') {
    const opt = document.createElement('option');
    opt.value = 'custom';
    opt.textContent = 'Custom fill';
    fillSelect.appendChild(opt);
  }
  fillSelect.value = model.fill;
  fillSelect.addEventListener('change', () => {
    snapshot();
    model.fill = fillSelect.value;
    refreshPanel();
    schedulePreview();
  });
  const insetSelect = overlay.querySelector('.table-card-inset') as HTMLSelectElement;
  insetSelect.value = model.inset;
  insetSelect.addEventListener('change', () => {
    snapshot();
    model.inset = insetSelect.value;
    refreshPanel();
    schedulePreview();
  });
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
  const WIDTH_CHOICES = ['auto', '1fr', '2fr', '3fr'];
  const renderGrid = (focus?: { r: number; c: number }) => {
    styleLabel.textContent = model.style + (model.params ? ' + opts' : '');
    const t = document.createElement('table');
    const totalCols = cols();
    while (model.widths.length < totalCols) model.widths.push('auto');
    model.widths.length = totalCols;
    // Width chips: one select per column (auto / fractions / custom length).
    {
      const wtr = document.createElement('tr');
      wtr.className = 'tc-widths';
      for (let c = 0; c < totalCols; c++) {
        const td = document.createElement('td');
        td.className = 'tc-width-cell';
        if (c < totalCols - 1) {
          const vt = document.createElement('button');
          vt.type = 'button';
          vt.className = 'tc-vtoggle' + (model.vlines.has(c + 1) ? ' tc-vtoggle-on' : '');
          vt.title = model.vlines.has(c + 1) ? 'Remove column rule' : 'Add a vertical rule at this boundary';
          vt.addEventListener('click', (e) => {
            e.stopPropagation();
            snapshot();
            if (model.vlines.has(c + 1)) model.vlines.delete(c + 1);
            else model.vlines.add(c + 1);
            renderGrid({ r: lastFocus.r, c: lastFocus.c });
            refreshPanel();
            schedulePreview();
          });
          td.appendChild(vt);
        }
        const sel2 = document.createElement('select');
        sel2.title = 'Column width';
        const current = model.widths[c];
        const opts = [...WIDTH_CHOICES];
        if (!opts.includes(current)) opts.push(current);
        for (const w of opts) {
          const o = document.createElement('option');
          o.value = w;
          o.textContent = w;
          sel2.appendChild(o);
        }
        const custom = document.createElement('option');
        custom.value = '__custom__';
        custom.textContent = 'custom…';
        sel2.appendChild(custom);
        sel2.value = current;
        sel2.addEventListener('change', () => {
          let v = sel2.value;
          if (v === '__custom__') {
            const entered = prompt('Column width (e.g. 2cm, 1in, 80pt, 1.5fr)', current === 'auto' ? '2cm' : current);
            if (entered === null || !/^[\d.]+\s*(pt|mm|cm|in|em|fr|%)$/.test(entered.trim())) {
              sel2.value = current;
              return;
            }
            v = entered.trim();
          }
          snapshot();
          model.widths[c] = v;
          renderGrid({ r: lastFocus.r, c: lastFocus.c });
          refreshPanel();
          schedulePreview();
        });
        td.appendChild(sel2);
        wtr.appendChild(td);
      }
      t.appendChild(wtr);
    }
    model.rows.forEach((row, ri) => {
      if (ri > 0) {
        const btr = document.createElement('tr');
        const w0 = model.hlines.get(ri);
        const w = w0 === 'none' ? undefined : w0;
        btr.className = 'tc-boundary' + (w ? ' tc-boundary-on' : '') + (w === 'heavy' ? ' tc-boundary-heavy' : '');
        btr.title = !w ? 'Add midrule here' : w === 'light' ? 'Make midrule heavy' : 'Remove midrule';
        const btd = document.createElement('td');
        btd.colSpan = totalCols;
        btr.appendChild(btd);
        btr.addEventListener('click', () => {
          snapshot();
          // Cycle: off -> light -> heavy -> off. On the booktabs header
          // boundary, "off" is an explicit suppression of the preset rule.
          const cur = model.hlines.get(ri);
          const presetBoundary = ri === 1 && model.implicitHeaderRule !== undefined && model.style === 'booktabs' && model.rows[0]?.some((c) => c.header);
          if (!cur || cur === 'none') model.hlines.set(ri, 'light');
          else if (cur === 'light') model.hlines.set(ri, 'heavy');
          else if (presetBoundary) model.hlines.set(ri, 'none');
          else model.hlines.delete(ri);
          if (ri === 1) model.implicitHeaderRule = false;
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
        input.style.textAlign = cell.align === 'decimal' ? 'right' : (cell.align ?? (cell.header ? 'center' : 'left'));
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
      fillSelect.value = FILLS[model.fill] || model.fill === 'none' ? model.fill : 'custom';
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

  /** Occupancy grid: for each (row, grid-col), which cell covers it.
   *  origin marks the covering cell's top-left corner. */
  interface Occ {
    r: number;
    ci: number;
    g0: number;
    origin: boolean;
  }
  const occupancy = (): Array<Array<Occ | null>> => {
    const width = cols();
    const grid: Array<Array<Occ | null>> = model.rows.map(() => new Array<Occ | null>(width).fill(null));
    model.rows.forEach((row, r) => {
      let gc = 0;
      row.forEach((cell, ci) => {
        while (gc < width && grid[r][gc]) gc++;
        for (let dr = 0; dr < cell.rowspan; dr++) {
          for (let dc = 0; dc < cell.colspan; dc++) {
            if (grid[r + dr]) grid[r + dr][gc + dc] = { r, ci, g0: gc, origin: dr === 0 && dc === 0 };
          }
        }
        gc += cell.colspan;
      });
    });
    return grid;
  };
  /** Grid column of the focused cell's LEFT edge. */
  const gridColOf = (f: { r: number; c: number }): number => {
    const grid = occupancy();
    for (const cell of grid[f.r] ?? []) {
      if (cell && cell.r === f.r && cell.ci === f.c) return cell.g0;
    }
    return 0;
  };
  /** Insert a blank grid column at boundary G (cells spanning G widen). */
  const insertGridCol = (G: number) => {
    const grid = occupancy();
    const widened = new Set<string>();
    model.rows.forEach((row, r) => {
      const left = G > 0 ? grid[r][G - 1] : null;
      const right = G < grid[r].length ? grid[r][G] : null;
      if (left && right && left.r === right.r && left.ci === right.ci) {
        // One cell spans the boundary: widen it (once, at its origin row).
        const key = `${left.r}:${left.ci}`;
        if (!widened.has(key)) {
          widened.add(key);
          model.rows[left.r][left.ci].colspan++;
        }
        return;
      }
      if (right && right.r !== r) return; // covered by a rowspan from above
      // Insert a blank before the cell that starts at/after G.
      const at = right ? right.ci : row.length;
      row.splice(at, 0, blank(row[Math.min(at, row.length - 1)]?.header ?? false));
    });
    model.widths.splice(Math.min(G, model.widths.length), 0, 'auto');
    model.vlines = new Set([...model.vlines].map((x) => (x >= G ? x + 1 : x)));
  };
  /** Delete grid column G (cells spanning it shrink). */
  const deleteGridCol = (G: number) => {
    const grid = occupancy();
    const shrunk = new Set<string>();
    for (let r = model.rows.length - 1; r >= 0; r--) {
      const hit = grid[r][G];
      if (!hit || hit.r !== r) continue; // covered from above: owner handles it
      const cell = model.rows[hit.r][hit.ci];
      const key = `${hit.r}:${hit.ci}`;
      if (cell.colspan > 1) {
        if (!shrunk.has(key)) {
          shrunk.add(key);
          cell.colspan--;
        }
      } else {
        model.rows[hit.r].splice(hit.ci, 1);
      }
    }
    model.widths.splice(Math.min(G, model.widths.length - 1), 1);
    model.vlines = new Set([...model.vlines].filter((x) => x <= cols()).map((x) => (x > G ? x - 1 : x)));
  };
  /** Insert a blank row after row R (rowspans crossing the seam widen). */
  const insertRowAfter = (R: number) => {
    const grid = occupancy();
    const width = cols();
    const newRow: CellModel[] = [];
    const grown = new Set<string>();
    for (let g = 0; g < width; g++) {
      const above = grid[R][g];
      const below = R + 1 < grid.length ? grid[R + 1][g] : null;
      if (above && below && above.r === below.r && above.ci === below.ci) {
        // A rowspan crosses the seam: grow it instead of adding a cell.
        const key = `${above.r}:${above.ci}`;
        if (!grown.has(key)) {
          grown.add(key);
          model.rows[above.r][above.ci].rowspan++;
        }
        g = above.g0 + model.rows[above.r][above.ci].colspan - 1;
        continue;
      }
      newRow.push(blank(false));
    }
    model.rows.splice(R + 1, 0, newRow);
    model.hlines = new Map(
      [...model.hlines.entries()].map(([y, w]) => [y > R + 1 ? y + 1 : y, w] as [number, 'light' | 'heavy']),
    );
  };
  /** Delete row R (rowspans through it shrink; origins in it push their
   *  remainder down). */
  const deleteRow = (R: number) => {
    const grid = occupancy();
    const width = cols();
    // Cells ORIGINATING in row R with rowspan > 1 continue below: move the
    // remainder into row R+1 at the right position.
    const moves: Array<{ g0: number; cell: CellModel }> = [];
    const handled = new Set<string>();
    for (let g = 0; g < width; g++) {
      const hit = grid[R][g];
      if (!hit) continue;
      const key = `${hit.r}:${hit.ci}`;
      if (handled.has(key)) continue;
      handled.add(key);
      const cell = model.rows[hit.r][hit.ci];
      if (hit.r === R) {
        if (cell.rowspan > 1) moves.push({ g0: hit.g0, cell: { ...cell, rowspan: cell.rowspan - 1 } });
      } else {
        cell.rowspan--; // spans through R from above
      }
    }
    model.rows.splice(R, 1);
    if (moves.length && R < model.rows.length) {
      const target = model.rows[R];
      const tGrid = occupancy();
      for (const mv of moves.sort((a, b) => a.g0 - b.g0)) {
        // Insertion index: before the first origin cell at/after g0.
        let at = target.length;
        for (let g = mv.g0; g < width; g++) {
          const hit2 = tGrid[R]?.[g];
          if (hit2 && hit2.r === R) {
            at = hit2.ci;
            break;
          }
        }
        target.splice(at, 0, mv.cell);
      }
    }
    model.hlines = new Map(
      [...model.hlines.entries()]
        .filter(([y]) => y <= model.rows.length - 1)
        .map(([y, w]) => [y > R ? y - 1 : y, w] as [number, 'light' | 'heavy']),
    );
  };

  overlay.querySelectorAll<HTMLButtonElement>('.table-card-tools button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = focused();
      switch (btn.dataset.act) {
        case 'row+':
          snapshot();
          insertRowAfter(f.r);
          renderGrid({ r: f.r + 1, c: 0 });
          break;
        case 'row-':
          if (model.rows.length > 1) {
            snapshot();
            deleteRow(f.r);
            renderGrid({ r: Math.max(0, f.r - 1), c: 0 });
          }
          break;
        case 'col+': {
          snapshot();
          const cell = model.rows[f.r]?.[f.c];
          insertGridCol(gridColOf(f) + (cell?.colspan ?? 1));
          renderGrid({ r: f.r, c: f.c + 1 });
          break;
        }
        case 'col-':
          if (cols() > 1) {
            snapshot();
            deleteGridCol(gridColOf(f));
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
        case 'alignR':
        case 'alignD': {
          snapshot();
          const a =
            btn.dataset.act === 'alignL'
              ? 'left'
              : btn.dataset.act === 'alignC'
                ? 'center'
                : btn.dataset.act === 'alignR'
                  ? 'right'
                  : 'decimal';
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
