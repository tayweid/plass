import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import { TableMap } from 'prosemirror-tables';
import { COMMON_PORT_KEYS, effectiveFont } from './font-registry';
import { getSettings } from './settings';
import { scheduleTypeset } from './typeset-plugin';
import { loadPrimitives, primitives } from './layout/primitives';
import { shapedWidthPt } from './layout/port/adapter';
import { allocateTableColumns, normalizeTableColumns, tableInsetPt } from './table-geometry';

/** Native table tree, with Typst's explicit column allocation. Measurements
 * run after the text paint; the editor and paginator use this one table. */
export class TableView implements NodeView {
  dom = document.createElement('table');
  contentDOM = document.createElement('tbody');
  private columns = document.createElement('colgroup');
  private frame = 0;
  private dead = false;
  private parent: HTMLElement | null = null;
  private observer = new ResizeObserver(() => this.schedule());
  private atoms = new Map<HTMLElement, number>();
  private observedNode: PMNode | null = null;
  private atomObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const previous = this.atoms.get(element);
      if (previous === undefined) continue;
      const width = this.atomAdvance(element);
      this.atoms.set(element, width);
      if (Math.abs(previous - width) > 0.01) changed = true;
    }
    if (changed) this.invalidate();
  });
  private measuredNode: PMNode | null = null;
  private measuredKey = '';

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom.append(this.columns, this.contentDOM);
    this.attributes();
    this.schedule();
    void loadPrimitives().then(() => this.schedule(), () => {});
    // Atom ink and late fonts can change without a document transaction.
    // Observe their own advances, not the cell boxes our allocation resizes.
    void document.fonts.ready.then(this.invalidate);
    document.fonts.addEventListener('loadingdone', this.invalidate);
    this.dom.addEventListener('load', this.invalidate, true);
  }

  private attributes() {
    const a = this.node.attrs;
    this.dom.classList.remove('ts-table-grid', 'ts-table-booktabs', 'ts-table-plain');
    this.dom.classList.add(`ts-table-${a.style}`);
    for (const [key, value] of Object.entries({ style: a.style, params: a.params, caption: a.caption, label: a.label, fontSize: a.fontSize, density: a.density })) {
      this.dom.dataset[key] = String(value ?? '');
    }
    if (a.insetPt !== null) this.dom.dataset.insetPt = String(tableInsetPt(a));
    else delete this.dom.dataset.insetPt;
    this.dom.style.setProperty('--cell-inset', `${tableInsetPt(a)}pt`);
    const tracks = normalizeTableColumns(a.columnWidths);
    this.dom.classList.toggle('ts-table-sized', !!tracks);
    if (tracks) this.dom.dataset.columnWidths = JSON.stringify(tracks);
    else {
      delete this.dom.dataset.columnWidths;
      this.columns.replaceChildren();
      this.dom.style.removeProperty('width');
    }
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    if (this.node === node) return true;
    this.node = node;
    this.attributes();
    this.schedule();
    return true;
  }

  private schedule() {
    if (this.dead || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure(); });
  }

  private invalidate = () => {
    this.measuredNode = null;
    this.schedule();
  };

  private atomAdvance(element: HTMLElement): number {
    const style = getComputedStyle(element);
    // Math's hover padding has matching negative margins. Measure its flow
    // advance rather than charging those paint-only pixels to the column.
    return element.getBoundingClientRect().width + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
  }

  private observeAtoms(pos: number, enabled: boolean) {
    const current = new Set<HTMLElement>();
    if (enabled) this.node.descendants((node, offset) => {
      if (!['math_inline', 'eq_ref', 'citation'].includes(node.type.name)) return true;
      const element = this.view.nodeDOM(pos + 1 + offset);
      if (element instanceof HTMLElement) {
        current.add(element);
        if (!this.atoms.has(element)) {
          this.atoms.set(element, this.atomAdvance(element));
          this.atomObserver.observe(element);
        }
      }
      return false;
    });
    for (const element of this.atoms.keys()) {
      if (current.has(element)) continue;
      this.atomObserver.unobserve(element);
      this.atoms.delete(element);
    }
  }

  private measure() {
    if (this.dead || !this.dom.isConnected) return;
    const parent = this.dom.parentElement;
    if (!parent) return;
    if (parent !== this.parent) {
      this.observer.disconnect();
      this.observer.observe(parent);
      this.parent = parent;
    }
    const tracks = normalizeTableColumns(this.node.attrs.columnWidths);
    const pos = this.getPos();
    if (pos === undefined) return;
    if (this.observedNode !== this.node) {
      this.observeAtoms(pos, !!tracks?.includes('auto'));
      this.observedNode = this.node;
    }
    if (!tracks || !primitives()) return;
    const s = getSettings(this.view.state);
    const cs = getComputedStyle(parent);
    const available = parent.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const fontSize = parseFloat(getComputedStyle(this.dom).fontSize) * 0.75;
    const key = `${available}:${fontSize}:${s.font}`;
    if (this.measuredNode === this.node && this.measuredKey === key) return;
    if (!(available > 0)) return;
    const map = TableMap.get(this.node);
    // A malformed persisted tuple is visible as unsupported; don't silently
    // assign widths to the wrong columns while a structural edit repairs it.
    if (tracks.length !== map.width) return;
    this.measuredNode = this.node;
    this.measuredKey = key;
    const inset = tableInsetPt(this.node.attrs) / 0.75;
    const fixed = tracks.reduce((sum, c) => sum + (c.endsWith('pt') ? parseFloat(c) / 0.75 : 0), 0);
    const availableAuto = Math.max(0, available - fixed);
    const intrinsic = tracks.map(() => 0);
    const fractions = tracks.flatMap((c, i) => c.endsWith('fr') ? [i] : []);
    const font = effectiveFont(s.font);
    const textWidth = (cell: PMNode, cellPos: number) => {
      let max = 0;
      cell.forEach((p, pOff) => {
        let line = 0;
        p.forEach((child, off) => {
          if (child.type.name === 'hard_break') { max = Math.max(max, line); line = 0; return; }
          if (child.isText) {
            const strong = child.marks.some((m) => m.type.name === 'strong');
            const em = child.marks.some((m) => m.type.name === 'em');
            const code = child.marks.some((m) => m.type.name === 'code');
            const face = code ? COMMON_PORT_KEYS.mono : font.portKeys[strong ? em ? 'bolditalic' : 'bold' : em ? 'italic' : 'regular'];
            line += (shapedWidthPt(child.text!, face, fontSize * (code ? 0.8 : 1)) ?? 0) / 0.75;
          } else {
            const el = this.view.nodeDOM(cellPos + 1 + pOff + 1 + off);
            if (el instanceof HTMLElement) {
              const image = child.type.name === 'image' ? el.querySelector('img') : null;
              // Legacy image cells are still unsupported for export, but a
              // loaded image must not stay squeezed to a cached zero width.
              if (image?.naturalWidth) {
                const contentWidth = Math.max(0, availableAuto - 2 * inset);
                line += typeof child.attrs.widthPct === 'number'
                  ? contentWidth * child.attrs.widthPct / 100
                  : Math.min(contentWidth, image.naturalWidth);
              } else line += this.atomAdvance(el);
            }
          }
        });
        max = Math.max(max, line);
      });
      return Math.min(availableAuto, max + 2 * inset);
    };
    // measure_auto_columns: a spanning cell contributes only to its last
    // auto track, excluding a cell that spans every fractional track.
    tracks.forEach((track, x) => {
      if (track !== 'auto') return;
      const seen = new Set<number>();
      for (let y = 0; y < map.height; y++) {
        const offset = map.map[y * map.width + x];
        if (seen.has(offset)) continue;
        seen.add(offset);
        const cell = this.node.nodeAt(offset)!;
        const rect = map.findCell(offset);
        const auto = tracks.flatMap((c, i) => c === 'auto' && i >= rect.left && i < rect.right ? [i] : []);
        if (auto.at(-1) !== x) continue;
        if (rect.right - rect.left > 1 && fractions.length && fractions.every((i) => i >= rect.left && i < rect.right)) continue;
        let covered = 0;
        for (let k = rect.left; k < rect.right; k++) {
          if (tracks[k].endsWith('pt')) covered += parseFloat(tracks[k]) / 0.75;
          else if (k < x) covered += intrinsic[k];
        }
        intrinsic[x] = Math.max(intrinsic[x], textWidth(cell, pos + 1 + offset) - covered);
      }
    });
    const widths = allocateTableColumns(tracks, intrinsic, available);
    while (this.columns.childElementCount < widths.length) this.columns.appendChild(document.createElement('col'));
    while (this.columns.childElementCount > widths.length) this.columns.lastElementChild!.remove();
    widths.forEach((w, i) => (this.columns.children[i] as HTMLElement).style.width = `${w}px`);
    this.dom.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
    scheduleTypeset(this.view);
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    return mutation.type !== 'selection' && (mutation.target === this.dom || this.columns.contains(mutation.target));
  }

  destroy() {
    this.dead = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.atomObserver.disconnect();
    this.atoms.clear();
    document.fonts.removeEventListener('loadingdone', this.invalidate);
    this.dom.removeEventListener('load', this.invalidate, true);
  }
}
