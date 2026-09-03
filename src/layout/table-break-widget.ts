// PAGE-PORT.md Phase 7: the presentation of a page break INSIDE a native
// table. The document keeps one table node; the break is a widget row
// (`<tr>`) inserted between two real rows by a ProseMirror decoration, so
// the table's own column grid carries it. Its cells hold, top to bottom:
// an exact-height gap that pushes the following rows onto the next painted
// page, and a non-editable copy of the repeating header row (what Typst's
// `layout_active_headers` lays at the top of every continuation region).
// Rules (the table's closing rule at the page bottom, its top rule and the
// header rule on the new page) are painted by CSS pseudo-elements only —
// nothing here changes layout heights beyond the gap and the header copy.

import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { tableRowModel } from './table-rows';

export interface TableBreakSpec {
  /** Position before the row that starts the next page. */
  pos: number;
  /** Total height the widget row must add to the flow (px). */
  height: number;
  /** Of that, the repeated header's height (px); the gap is the rest. */
  hdr: number;
  /** Widget key, mirrored to `data-ts-gap-key` so the paginator can read
   * the painted height back. */
  key: string;
}

/** Resolve the table that owns a row-boundary position. Null when the
 * position no longer sits between rows of a table (a decoration mapped
 * through an edit that restructured the table). */
function ownerTable(view: EditorView, pos: number): { node: PMNode; pos: number } | null {
  try {
    const $pos = view.state.doc.resolve(pos);
    if ($pos.parent.type.name !== 'table') return null;
    return { node: $pos.parent, pos: $pos.before() };
  } catch {
    return null;
  }
}

function columnCount(table: PMNode): number {
  let columns = 0;
  table.firstChild?.forEach((cell) => {
    columns += (cell.attrs.colspan as number) ?? 1;
  });
  return Math.max(1, columns);
}

/** A plain gap when the table cannot be resolved: still an exact-height
 * block that keeps the page invariant (the settled pass corrects it). */
function plainGap(spec: TableBreakSpec): HTMLElement {
  const gap = document.createElement('div');
  gap.className = 'ts-pagegap';
  gap.style.height = `${spec.height.toFixed(2)}px`;
  gap.dataset.tsGapKey = spec.key;
  gap.setAttribute('aria-hidden', 'true');
  gap.contentEditable = 'false';
  return gap;
}

/** Build the widget row for a break before row `spec.pos`. */
export function tableBreakWidget(view: EditorView, spec: TableBreakSpec): HTMLElement {
  const owner = ownerTable(view, spec.pos);
  if (!owner) return plainGap(spec);
  const model = tableRowModel(owner.node);
  const tr = document.createElement('tr');
  tr.className = 'ts-pagegap ts-table-break';
  tr.dataset.tsGapKey = spec.key;
  tr.setAttribute('aria-hidden', 'true');
  tr.contentEditable = 'false';
  const gapHeight = Math.max(0, spec.height - spec.hdr);
  const headerRow = model.repeatRow !== null && spec.hdr > 0 ? owner.node.child(model.repeatRow) : null;
  const headerRowDom = headerRow ? view.nodeDOM(owner.pos + model.rowOffsets[model.repeatRow!]) : null;
  const headerCells = headerRow && headerRowDom instanceof HTMLElement
    ? [...headerRowDom.children].filter((el) => el instanceof HTMLTableCellElement)
    : [];
  const withHeader = headerRow !== null && headerCells.length === headerRow.childCount;
  if (withHeader) tr.classList.add('ts-table-break-header');
  if (withHeader && model.headerRun === 1) tr.classList.add('ts-table-break-midrule');

  const makeCell = (colspan: number, headerCell: HTMLTableCellElement | null) => {
    const td = document.createElement('td');
    td.className = 'ts-table-break-cell';
    if (colspan > 1) td.colSpan = colspan;
    const gap = document.createElement('div');
    gap.className = 'ts-table-gap';
    gap.style.height = `${gapHeight.toFixed(2)}px`;
    td.appendChild(gap);
    if (withHeader) {
      const hdr = document.createElement('div');
      hdr.className = 'ts-table-hdr';
      // The copy is sized to the measured real header row, so the widget's
      // total height is exactly `spec.height` whatever the copied content
      // wraps to.
      hdr.style.height = `${spec.hdr.toFixed(2)}px`;
      if (headerCell) {
        const align = headerCell.style.textAlign;
        if (align) hdr.style.textAlign = align;
        for (const child of headerCell.childNodes) {
          const copy = child.cloneNode(true);
          if (copy instanceof HTMLElement) {
            copy.removeAttribute('id');
            copy.removeAttribute('contenteditable');
          }
          hdr.appendChild(copy);
        }
      }
      td.appendChild(hdr);
    }
    return td;
  };

  if (withHeader) {
    headerRow!.forEach((cell, _offset, index) => {
      tr.appendChild(makeCell((cell.attrs.colspan as number) ?? 1, headerCells[index] as HTMLTableCellElement));
    });
  } else {
    tr.appendChild(makeCell(columnCount(owner.node), null));
  }
  return tr;
}
