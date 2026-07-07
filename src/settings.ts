// Document settings: the WYSIWYG face of a Typst preamble.
//
// Settings are document attributes (undoable, autosaved, exported), applied
// to the live view as CSS variables. The typeset plugin re-measures when they
// change, and the .typ exporter turns them into #set rules.

import type { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

export interface DocSettings {
  font: string;
  sizePt: number;
  lineHeight: number;
  page: 'letter' | 'a4';
  marginIn: number;
  hyphenate: boolean;
  numberEquations: boolean;
}

export const DEFAULT_SETTINGS: DocSettings = {
  font: 'STIX Two Text',
  sizePt: 12.5,
  lineHeight: 1.5,
  page: 'letter',
  marginIn: 1.25,
  hyphenate: true,
  numberEquations: true,
};

export const FONTS = ['STIX Two Text', 'Charter', 'Palatino', 'Georgia', 'Times New Roman'];

/** Page geometry in CSS px (96/in). Shared by CSS vars, the paginator, and chrome. */
export const PAGE_SIZES: Record<DocSettings['page'], { w: number; h: number }> = {
  letter: { w: 816, h: 1056 },
  a4: { w: 794, h: 1123 },
};

/** Visual gap between painted pages, px. */
export const PAGE_GAP = 28;

export function getSettings(state: EditorState): DocSettings {
  return { ...DEFAULT_SETTINGS, ...((state.doc.attrs.settings as Partial<DocSettings>) ?? {}) };
}

/** Push the document settings into the page as CSS variables + @page rule. */
export function applySettings(state: EditorState) {
  const s = getSettings(state);
  const root = document.documentElement.style;
  root.setProperty('--doc-font', `"${s.font}", Georgia, serif`);
  root.setProperty('--doc-size', `${s.sizePt}pt`);
  root.setProperty('--doc-line', String(s.lineHeight));
  const size = PAGE_SIZES[s.page];
  root.setProperty('--page-w', `${size.w}px`);
  root.setProperty('--page-h', `${size.h}px`);
  root.setProperty('--page-margin', `${s.marginIn * 96}px`);

  let styleEl = document.getElementById('page-style') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'page-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `@page { size: ${s.page === 'a4' ? 'A4' : 'letter'}; margin: ${s.marginIn}in; }`;
}

let openPanel: HTMLElement | null = null;

export function toggleSettingsPanel(view: EditorView, anchor: HTMLElement) {
  if (openPanel) {
    closePanel();
    return;
  }
  const s = getSettings(view.state);

  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  openPanel = panel;

  const patch = (p: Partial<DocSettings>) => {
    const cur = getSettings(view.state);
    view.dispatch(view.state.tr.setDocAttribute('settings', { ...cur, ...p }));
  };

  const row = (label: string, control: HTMLElement) => {
    const r = document.createElement('label');
    r.className = 'settings-row';
    const span = document.createElement('span');
    span.textContent = label;
    r.append(span, control);
    panel.appendChild(r);
  };

  const select = <T extends string | number>(
    options: Array<[T, string]>,
    value: T,
    onChange: (v: string) => void,
  ) => {
    const sel = document.createElement('select');
    for (const [v, text] of options) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = text;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  };

  const checkbox = (value: boolean, onChange: (v: boolean) => void) => {
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = value;
    c.addEventListener('change', () => onChange(c.checked));
    return c;
  };

  row('Font', select(FONTS.map((f) => [f, f]), s.font, (v) => patch({ font: v })));
  row('Size', select([10, 11, 12, 12.5, 13, 14].map((n) => [n, `${n} pt`] as [number, string]), s.sizePt, (v) => patch({ sizePt: +v })));
  row('Line spacing', select([1.3, 1.4, 1.5, 1.65, 1.8].map((n) => [n, String(n)] as [number, string]), s.lineHeight, (v) => patch({ lineHeight: +v })));
  row('Paper', select([['letter', 'US Letter'], ['a4', 'A4']] as Array<[string, string]>, s.page, (v) => patch({ page: v as DocSettings['page'] })));
  row('Margin', select([0.75, 1, 1.25, 1.5].map((n) => [n, `${n} in`] as [number, string]), s.marginIn, (v) => patch({ marginIn: +v })));
  row('Hyphenation', checkbox(s.hyphenate, (v) => patch({ hyphenate: v })));
  row('Number equations', checkbox(s.numberEquations, (v) => patch({ numberEquations: v })));

  const hint = document.createElement('div');
  hint.className = 'settings-hint';
  hint.textContent = 'Applied live and to the .typ export. Undo works.';
  panel.appendChild(hint);

  document.body.appendChild(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.top = `${rect.bottom + 6 + window.scrollY}px`;
  panel.style.left = `${Math.max(8, rect.right - panel.offsetWidth) + window.scrollX}px`;

  const onDown = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) closePanel();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePanel();
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);

  function closePanel() {
    panel.remove();
    openPanel = null;
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
}
