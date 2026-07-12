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
  page: 'letter' | 'a4' | 'legal' | 'b5';
  landscape: boolean;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  hyphenate: boolean;
  /** Classic academic paragraphs: first-line indent, no inter-paragraph gap. */
  parIndent: boolean;
  numberEquations: boolean;
  numberSections: boolean;
  pageNumShow: boolean;
  pageNumFormat: '1' | '— 1 —' | 'i' | '1 / 1';
  pageNumAlign: 'left' | 'center' | 'right';
  pageNumStart: number;
  /** Running header text ('' = none). Use {page} for the page number. */
  headerText: string;
  headerAlign: 'left' | 'center' | 'right';
  /** Show the header on page 1 (off = academic convention). */
  headerFirstPage: boolean;
  /** One definition per line: \name = expansion (KaTeX macros). */
  mathMacros: string;
}

export const DEFAULT_SETTINGS: DocSettings = {
  font: 'New Computer Modern',
  sizePt: 12.5,
  lineHeight: 1.5,
  page: 'letter',
  landscape: false,
  marginTop: 1.25,
  marginRight: 1.25,
  marginBottom: 1.25,
  marginLeft: 1.25,
  hyphenate: true,
  parIndent: false,
  numberEquations: true,
  numberSections: false,
  pageNumShow: true,
  pageNumFormat: '1',
  pageNumAlign: 'center',
  pageNumStart: 1,
  headerText: '',
  headerAlign: 'right',
  headerFirstPage: false,
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
const PAPER: Record<DocSettings['page'], { w: number; h: number }> = {
  letter: { w: 816, h: 1056 },
  a4: { w: 794, h: 1123 },
  legal: { w: 816, h: 1344 },
  b5: { w: 665, h: 945 },
};

/** Effective page size in px (orientation applied). */
export function pageSize(s: Pick<DocSettings, 'page' | 'landscape'>): { w: number; h: number } {
  const p = PAPER[s.page] ?? PAPER.letter;
  return s.landscape ? { w: p.h, h: p.w } : p;
}

/** Visual gap between painted pages, px. */
export const PAGE_GAP = 28;

/** Merge stored settings over defaults (migrating legacy fields). */
export function normalizeSettings(raw: Partial<DocSettings> | null | undefined): DocSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  // Legacy uniform margin (pre per-side margins).
  const legacy = (raw as { marginIn?: number } | null | undefined)?.marginIn;
  if (legacy !== undefined && (raw as Partial<DocSettings>)?.marginTop === undefined) {
    merged.marginTop = merged.marginRight = merged.marginBottom = merged.marginLeft = legacy;
  }
  return merged;
}

export function getSettings(state: EditorState): DocSettings {
  return normalizeSettings(state.doc.attrs.settings as Partial<DocSettings> | null);
}

/** Push the document settings into the page as CSS variables + @page rule. */
export function applySettings(state: EditorState) {
  const s = getSettings(state);
  const root = document.documentElement.style;
  root.setProperty('--doc-font', `"${s.font}", Georgia, serif`);
  root.setProperty('--doc-size', `${s.sizePt}pt`);
  root.setProperty('--doc-line', String(s.lineHeight));
  root.setProperty('--par-margin', s.parIndent ? '0em' : '0.9em');
  root.setProperty('--par-indent', s.parIndent ? '1.5em' : '0em');
  const size = pageSize(s);
  root.setProperty('--page-w', `${size.w}px`);
  root.setProperty('--page-h', `${size.h}px`);
  root.setProperty('--page-margin', `${s.marginTop * 96}px`);
  root.setProperty('--page-margin-top', `${s.marginTop * 96}px`);
  root.setProperty('--page-margin-right', `${s.marginRight * 96}px`);
  root.setProperty('--page-margin-bottom', `${s.marginBottom * 96}px`);
  root.setProperty('--page-margin-left', `${s.marginLeft * 96}px`);

  let styleEl = document.getElementById('page-style') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'page-style';
    document.head.appendChild(styleEl);
  }
  const cssSize = { letter: 'letter', a4: 'A4', legal: 'legal', b5: 'B5' }[s.page] ?? 'letter';
  styleEl.textContent = `@page { size: ${cssSize}${s.landscape ? ' landscape' : ''}; margin: ${s.marginTop}in ${s.marginRight}in ${s.marginBottom}in ${s.marginLeft}in; }`;
}

let openPanel: HTMLElement | null = null;
/** Closer for the CURRENTLY open panel — the toggle's close branch must
 * not call this invocation's own (TDZ) closePanel. */
let closeOpen: (() => void) | null = null;

export function toggleSettingsPanel(view: EditorView, anchor: HTMLElement) {
  if (openPanel) {
    closeOpen?.();
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
  {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Title · Name · {page}';
    input.value = s.headerText;
    input.addEventListener('change', () => patch({ headerText: input.value }));
    row('Header', input);
  }
  row('Header align', select([['left', 'Left'], ['center', 'Center'], ['right', 'Right']] as Array<[string, string]>, s.headerAlign, (v) => patch({ headerAlign: v as DocSettings['headerAlign'] })));
  {
    // The marker is a document position, but its placement is structural:
    // right after the leading front-matter blocks. The setting manages it.
    const FRONT = new Set(['doc_title', 'doc_authors', 'doc_date', 'abstract']);
    const hasMarker = () => {
      let found = false;
      view.state.doc.forEach((n) => {
        if (n.type.name === 'numbering_restart') found = true;
      });
      return found;
    };
    row(
      'Front matter',
      select(
        [
          ['same', 'Numbered with body'],
          ['roman', 'Roman · body restarts at 1'],
        ] as Array<[string, string]>,
        hasMarker() ? 'roman' : 'same',
        (v) => {
          const doc = view.state.doc;
          if (v === 'roman') {
            if (hasMarker()) return;
            let pos = 0;
            for (let i = 0; i < doc.childCount; i++) {
              const child = doc.child(i);
              if (i === 0 || FRONT.has(child.type.name)) pos += child.nodeSize;
              else break;
            }
            view.dispatch(view.state.tr.insert(pos, view.state.schema.nodes.numbering_restart.create()));
          } else {
            let tr = view.state.tr;
            const cuts: Array<[number, number]> = [];
            doc.forEach((n, offset) => {
              if (n.type.name === 'numbering_restart') cuts.push([offset, offset + n.nodeSize]);
            });
            for (const [a, b] of cuts.reverse()) tr = tr.delete(a, b);
            if (cuts.length) view.dispatch(tr);
          }
        },
      ),
    );
  }
  row('Paragraphs', select([['block', 'Block (spaced)'], ['indent', 'Indented (classic)']] as Array<[string, string]>, s.parIndent ? 'indent' : 'block', (v) => patch({ parIndent: v === 'indent' })));
  row('Line spacing', select([1.3, 1.4, 1.5, 1.65, 1.8].map((n) => [n, String(n)] as [number, string]), s.lineHeight, (v) => patch({ lineHeight: +v })));
  row('Paper', select([['letter', 'US Letter'], ['a4', 'A4'], ['legal', 'US Legal'], ['b5', 'B5']] as Array<[string, string]>, s.page, (v) => patch({ page: v as DocSettings['page'] })));
  row('Orientation', select([['portrait', 'Portrait'], ['landscape', 'Landscape']] as Array<[string, string]>, s.landscape ? 'landscape' : 'portrait', (v) => patch({ landscape: v === 'landscape' })));
  {
    const cluster = document.createElement('span');
    cluster.className = 'settings-margins';
    for (const [key, label] of [
      ['marginTop', 'T'],
      ['marginRight', 'R'],
      ['marginBottom', 'B'],
      ['marginLeft', 'L'],
    ] as Array<[keyof DocSettings & string, string]>) {
      const wrap = document.createElement('label');
      wrap.className = 'settings-margin-field';
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.05';
      input.min = '0.2';
      input.max = '3';
      input.value = String(s[key]);
      input.addEventListener('change', () => {
        const v = Math.min(3, Math.max(0.2, parseFloat(input.value) || 1));
        input.value = String(v);
        patch({ [key]: v } as Partial<DocSettings>);
      });
      wrap.append(label, input);
      cluster.appendChild(wrap);
    }
    row('Margins (in)', cluster);
  }
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
  panel.style.top = `${rect.bottom + 8 + window.scrollY}px`;
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
    closeOpen = null;
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
  closeOpen = closePanel;
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
