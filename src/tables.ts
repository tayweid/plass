// Tables: prosemirror-tables provides the editing state machine (cell
// selection, Tab navigation, row/column surgery); we provide insertion,
// toolbar wiring, and the Typst round trip (in typ-serializer/typ-parser).

import type { Command } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import { isInTable, selectedRect } from 'prosemirror-tables';
import { schema } from './schema';

export const TABLE_STYLES = ['booktabs', 'grid', 'plain'] as const;
export type TableStyle = (typeof TABLE_STYLES)[number];

/** Cycle the enclosing table through the style presets. */
export const cycleTableStyle: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.table) {
      if (dispatch) {
        const node = $from.node(d);
        const next =
          TABLE_STYLES[(TABLE_STYLES.indexOf(node.attrs.style as TableStyle) + 1) % TABLE_STYLES.length];
        dispatch(state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, style: next }));
      }
      return true;
    }
  }
  return false;
};

/** Locate the enclosing table: [pos, node] or null. */
function enclosingTable(state: Parameters<Command>[0]): [number, ReturnType<typeof state.doc.nodeAt>] | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.table) return [$from.before(d), $from.node(d)];
  }
  return null;
}

/**
 * Full-control escape hatch: edit raw Typst #table arguments for the
 * enclosing table. Anything Typst accepts — stroke functions, fill striping,
 * inset, fractional column widths — is stored on the table and emitted
 * verbatim on export/PDF; presets are suppressed while custom args exist.
 */
export function editTableOptions(view: import('prosemirror-view').EditorView) {
  const found = enclosingTable(view.state);
  if (!found) return;
  const [pos, node] = found;
  if (!node) return;

  const overlay = document.createElement('div');
  overlay.className = 'bib-editor-overlay';
  overlay.innerHTML = `
    <div class="bib-editor" role="dialog" aria-label="Table options">
      <div class="bib-editor-head"><span>Table options — raw Typst #table arguments</span></div>
      <textarea class="bib-editor-text table-opts-text" spellcheck="false" rows="8"
        placeholder="columns: (2fr, 1fr, 1fr),
inset: 6pt,
fill: (x, y) => if calc.odd(y) { luma(245) },
stroke: (x, y) => if y == 0 { (bottom: 0.7pt) }"></textarea>
      <div class="bib-editor-foot">
        <span class="bib-editor-hint">Emitted verbatim into #table(…), replacing the style preset. With custom args the editor shows a Typst-compiled preview of the table whenever the caret is outside it — click the preview to edit. Leave empty to return to presets. <kbd>⌘Enter</kbd> save</span>
        <span class="bib-editor-actions">
          <button type="button" class="bib-cancel">Cancel</button>
          <button type="button" class="bib-save">Save</button>
        </span>
      </div>
    </div>`;
  const panel = overlay.querySelector('.bib-editor') as HTMLElement;
  const text = overlay.querySelector('.bib-editor-text') as HTMLTextAreaElement;
  text.value = node.attrs.params as string;

  const close = () => {
    overlay.remove();
    view.focus();
  };
  const save = () => {
    const params = text.value.trim();
    let tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, params });
    if (params) {
      // Step out of the table so the compiled preview shows immediately.
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + node.nodeSize), 1));
    }
    view.dispatch(tr.scrollIntoView());
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
  setTimeout(() => text.focus(), 0);
}

/** Set text alignment for every cell of the selected column(s). */
export function alignColumn(align: 'left' | 'center' | 'right' | null): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (dispatch) {
      const rect = selectedRect(state);
      const seen = new Set<number>();
      let tr = state.tr;
      for (let col = rect.left; col < rect.right; col++) {
        for (let row = 0; row < rect.map.height; row++) {
          const cellPos = rect.map.map[row * rect.map.width + col];
          if (seen.has(cellPos)) continue;
          seen.add(cellPos);
          const cell = rect.table.nodeAt(cellPos);
          if (cell) tr = tr.setNodeMarkup(rect.tableStart + cellPos, undefined, { ...cell.attrs, align });
        }
      }
      dispatch(tr);
    }
    return true;
  };
}

/** Insert a rows×cols table (first row is a header) and enter the first cell. */
export function insertTable(rows = 3, cols = 3): Command {
  return (state, dispatch) => {
    const { table, table_row, table_cell, table_header } = schema.nodes;
    if (!state.selection.$from.parent.isTextblock) return false;
    // No nested tables in v1.
    for (let d = state.selection.$from.depth; d > 0; d--) {
      if (state.selection.$from.node(d).type === table) return false;
    }
    if (dispatch) {
      const makeRow = (type: typeof table_cell) =>
        table_row.create(
          null,
          Array.from({ length: cols }, () => type.createAndFill()!),
        );
      const rowNodes = [makeRow(table_header)];
      for (let r = 1; r < rows; r++) rowNodes.push(makeRow(table_cell));
      const node = table.create(null, rowNodes);
      let tr = state.tr.replaceSelectionWith(node);
      // Caret into the first cell.
      let cellPos = -1;
      tr.doc.descendants((n, pos) => {
        if (cellPos < 0 && n.type === table_header) cellPos = pos + 1;
        return cellPos < 0;
      });
      if (cellPos >= 0) tr = tr.setSelection(TextSelection.create(tr.doc, cellPos + 1));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}
