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
  numberSections: boolean;
  pageNumShow: boolean;
  pageNumFormat: '1' | '— 1 —' | 'i' | '1 / 1';
  pageNumAlign: 'left' | 'center' | 'right';
  pageNumStart: number;
  /** One definition per line: \name = expansion (KaTeX macros). */
  mathMacros: string;
}

export const DEFAULT_SETTINGS: DocSettings = {
  font: 'New Computer Modern',
  sizePt: 12.5,
  lineHeight: 1.5,
  page: 'letter',
  marginIn: 1.25,
  hyphenate: true,
  numberEquations: true,
  numberSections: false,
  pageNumShow: true,
  pageNumFormat: '1',
  pageNumAlign: 'center',
  pageNumStart: 1,
  mathMacros: '',
};

export const FONTS = ['New Computer Modern', 'STIX Two Text', 'Charter', 'Palatino', 'Georgia', 'Times New Roman'];

/** Parse the macros text into a KaTeX macros object. */
export function parseMathMacros(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of src.split('\n')) {
    const m = /^\s*(\\[a-zA-Z]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const ROMAN: Array<[number, string]> = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

export function toRoman(n: number): string {
  let out = '';
  for (const [v, s] of ROMAN) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out || '0';
}

/** Render a page number per the document's format setting. */
export function formatPageNumber(s: DocSettings, page: number, total: number): string {
  const n = page + s.pageNumStart - 1;
  switch (s.pageNumFormat) {
    case '— 1 —':
      return `— ${n} —`;
    case 'i':
      return toRoman(n);
    case '1 / 1':
      return `${n} / ${total + s.pageNumStart - 1}`;
    default:
      return String(n);
  }
}

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
  row('Number sections', checkbox(s.numberSections, (v) => patch({ numberSections: v })));
  row('Page numbers', checkbox(s.pageNumShow, (v) => patch({ pageNumShow: v })));
  row(
    'Number format',
    select(
      [['1', '1, 2, 3'], ['— 1 —', '— 1 —'], ['i', 'i, ii, iii'], ['1 / 1', '1 / N']] as Array<[string, string]>,
      s.pageNumFormat,
      (v) => patch({ pageNumFormat: v as DocSettings['pageNumFormat'] }),
    ),
  );
  row(
    'Number position',
    select(
      [['left', 'Bottom left'], ['center', 'Bottom center'], ['right', 'Bottom right']] as Array<[string, string]>,
      s.pageNumAlign,
      (v) => patch({ pageNumAlign: v as DocSettings['pageNumAlign'] }),
    ),
  );
  row('First page number', select([1, 2, 3, 4, 5, 10, 100].map((n) => [n, String(n)] as [number, string]), s.pageNumStart, (v) => patch({ pageNumStart: +v })));

  const macrosBtn = document.createElement('button');
  macrosBtn.type = 'button';
  macrosBtn.className = 'settings-macros-btn';
  macrosBtn.textContent = 'Math macros…';
  macrosBtn.addEventListener('click', () => {
    closePanel();
    editMathMacros(view);
  });
  panel.appendChild(macrosBtn);

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

/** Modal editor for document-level math macros (KaTeX + expanded on export). */
export function editMathMacros(view: EditorView) {
  const s = getSettings(view.state);
  const overlay = document.createElement('div');
  overlay.className = 'bib-editor-overlay';
  overlay.innerHTML = `
    <div class="bib-editor" role="dialog" aria-label="Math macros">
      <div class="bib-editor-head"><span>Math macros</span><span class="bib-editor-count"></span></div>
      <textarea class="bib-editor-text macros-text" spellcheck="false" rows="8"
        placeholder="\\E = \\mathbb{E}
\\Var = \\operatorname{Var}
\\R = \\mathbb{R}"></textarea>
      <div class="bib-editor-foot">
        <span class="bib-editor-hint">One per line: \\name = expansion. Available in every formula; expanded to plain LaTeX on export so files compile anywhere. <kbd>⌘Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
        <span class="bib-editor-actions">
          <button type="button" class="bib-cancel">Cancel</button>
          <button type="button" class="bib-save">Save</button>
        </span>
      </div>
    </div>`;
  const panel = overlay.querySelector('.bib-editor') as HTMLElement;
  const text = overlay.querySelector('.macros-text') as HTMLTextAreaElement;
  const count = overlay.querySelector('.bib-editor-count') as HTMLElement;
  text.value = s.mathMacros;
  const updateCount = () => {
    const n = Object.keys(parseMathMacros(text.value)).length;
    count.textContent = `${n} macro${n === 1 ? '' : 's'}`;
  };
  updateCount();
  text.addEventListener('input', updateCount);

  const close = () => {
    overlay.remove();
    view.focus();
  };
  const save = () => {
    const cur = getSettings(view.state);
    view.dispatch(view.state.tr.setDocAttribute('settings', { ...cur, mathMacros: text.value.trim() }));
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
