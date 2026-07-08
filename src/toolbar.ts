// Chrome, Typora-style: a slim quiet bar — filename plus a single row of
// icon buttons whose labels fade in on hover. Everything lives on the bar
// (no overflow menu): file actions, inserts, document tools, exports. The
// only dropdown is Recents, which is inherently a dynamic list.

import { TextSelection } from 'prosemirror-state';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { insertMath } from './math';
import { insertFootnote } from './footnotes';
import { pickAndInsertFigure } from './figures';
import { insertTableWithEditor } from './table-editor';
import { editBibliography } from './citations';
import { toggleSettingsPanel } from './settings';
import type { TypesetStats } from './typeset-plugin';
import type { FileManager } from './file-manager';

export interface Toolbar {
  update: (state: EditorState) => void;
  stats: (s: TypesetStats) => void;
  setFile: (name: string, dirty: boolean) => void;
}

const insertFigureCmd: Command = (state, dispatch, view) => {
  if (!state.selection.$from.parent.isTextblock) return false;
  if (dispatch && view) pickAndInsertFigure(view);
  return true;
};

// Feather-style inline icons (stroke = currentColor).
const ICONS: Record<string, string> = {
  new: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/>',
  open: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  project: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><circle cx="12" cy="14" r="2.4"/><line x1="12" y1="9.5" x2="12" y2="11.6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  saveas: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="7 3 7 8 15 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="21"/>',
  pagebreak: '<polyline points="8 3 8 8 16 8 16 3"/><line x1="3" y1="12" x2="7" y2="12"/><line x1="10" y1="12" x2="14" y2="12"/><line x1="17" y1="12" x2="21" y2="12"/><polyline points="8 21 8 16 16 16 16 21"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  filedown: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 12 18 15 15"/><line x1="12" y1="11" x2="12" y2="18"/>',
};

function icon(name: string): string {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export function buildToolbar(container: HTMLElement, view: EditorView, fm: FileManager): Toolbar {
  const fileLabel = document.createElement('span');
  fileLabel.className = 'tb-file';
  fileLabel.textContent = 'Untitled';
  fileLabel.title = 'Click to rename';
  fileLabel.addEventListener('click', () => {
    const input = document.createElement('input');
    input.className = 'tb-file-input';
    input.value = fm.name;
    input.spellcheck = false;
    fileLabel.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      input.replaceWith(fileLabel);
      const name = input.value.trim();
      if (commit && name) void fm.rename(name);
      view.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  });

  container.append(fileLabel);
  const titleDiv = document.createElement('span');
  titleDiv.className = 'tb-div';
  container.appendChild(titleDiv);

  /** Icon button whose text label fades in on hover. */
  const barBtn = (glyph: string, label: string, title: string, run: () => void) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tb-btn';
    el.title = title;
    el.innerHTML = `${glyph}<span class="lbl">${label}</span>`;
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', () => run());
    container.appendChild(el);
    return el;
  };
  const barDivider = () => {
    const d = document.createElement('span');
    d.className = 'tb-div';
    container.appendChild(d);
  };
  const runCmd = (c: Command) => () => {
    c(view.state, view.dispatch, view);
    view.focus();
  };

  // ---------- file ----------
  barBtn(icon('new'), 'New', 'New document', () => {
    if (confirm('Replace the current document with an empty one?')) fm.newDoc();
  });
  barBtn(icon('open'), 'Open', 'Open… (⌘O)', () => void fm.open());
  barBtn(icon('project'), 'Project', 'Open a project folder — figures live as files inside it', () => void fm.openFolder());
  const recentBtn = barBtn(icon('clock'), 'Recent', 'Recent files', () => toggleRecents());
  barBtn(icon('save'), 'Save', 'Save (⌘S)', () => void fm.save());
  barBtn(icon('saveas'), 'Save As', 'Save As… (⇧⌘S)', () => void fm.saveAs());
  barDivider();
  // ---------- insert ----------
  barBtn('<span class="ico tico">T</span>', 'Title', 'Title block — title, authors, date, abstract', () => {
    const { state, dispatch } = view;
    const existing = state.doc.firstChild;
    if (existing && ['doc_title', 'doc_authors', 'doc_date', 'abstract'].includes(existing.type.name)) {
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1)).scrollIntoView());
      view.focus();
      return;
    }
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const nodes = [
      schema.nodes.doc_title.create(null, [schema.text('Title')]),
      schema.nodes.doc_authors.create(null, [schema.text('Author Name')]),
      schema.nodes.doc_date.create(null, [schema.text(today)]),
      schema.nodes.abstract.create(null, [
        schema.nodes.paragraph.create(null, [schema.text('Abstract text.')]),
      ]),
    ];
    let tr = state.tr.insert(0, nodes);
    tr = tr.setSelection(TextSelection.create(tr.doc, 1, 1 + 'Title'.length));
    dispatch(tr.scrollIntoView());
    view.focus();
  });
  barBtn(icon('image'), 'Figure', 'Insert figure (⌘⌥I) — or paste/drop an image', runCmd(insertFigureCmd));
  barBtn(icon('table'), 'Table', 'Insert table (⌘⌥T)', () => insertTableWithEditor(view));
  barBtn('<span class="ico tico">Σ</span>', 'Math', 'Inline math (⌘M) — or type $x^2$; ⌘⇧M for display', runCmd(insertMath(false)));
  barBtn('<span class="ico tico">†</span>', 'Note', 'Footnote (⌘⌥F) — or type ^[', runCmd(insertFootnote));
  barBtn(icon('pagebreak'), 'Break', 'Page break (⌘⏎)', () => {
    const { state, dispatch } = view;
    const { $from } = state.selection;
    const pos = $from.after($from.depth > 0 ? 1 : 0);
    dispatch(state.tr.insert(pos, schema.nodes.page_break.create()).scrollIntoView());
    view.focus();
  });
  barDivider();
  // ---------- document ----------
  barBtn(icon('book'), 'Bib', 'Edit bibliography', () => editBibliography(view, (m) => fm.notify(m)));
  const settingsBtn = barBtn(icon('sliders'), 'Settings', 'Document settings', () => toggleSettingsPanel(view, settingsBtn));
  barBtn('<span class="ico tico">?</span>', 'Help', 'Markdown & shortcuts', () => showHelp(fm));
  barDivider();
  // ---------- export ----------
  barBtn(icon('download'), 'PDF', 'Export PDF via Typst', () => {
    const name = fm.name === 'Untitled' ? 'document' : fm.name;
    void import('./pdf').then(({ exportPdf }) => exportPdf(fm.currentDoc(), name, (m) => fm.notify(m)));
  });
  barBtn(icon('filedown'), '.typ', 'Download a .typ copy', () => fm.exportCopy());

  // ---------- recents dropdown ----------
  let recentsMenu: HTMLElement | null = null;
  const closeRecents = () => {
    recentsMenu?.remove();
    recentsMenu = null;
    document.removeEventListener('mousedown', onDocDown, true);
  };
  const onDocDown = (e: MouseEvent) => {
    if (recentsMenu && !recentsMenu.contains(e.target as Node) && !recentBtn.contains(e.target as Node)) {
      closeRecents();
    }
  };
  function toggleRecents() {
    if (recentsMenu) {
      closeRecents();
      return;
    }
    recentsMenu = document.createElement('div');
    recentsMenu.className = 'file-menu recents-menu';
    const rect = recentBtn.getBoundingClientRect();
    recentsMenu.style.top = `${rect.bottom + 6 + window.scrollY}px`;
    recentsMenu.style.left = `${Math.max(8, rect.left - 40) + window.scrollX}px`;
    document.body.appendChild(recentsMenu);
    document.addEventListener('mousedown', onDocDown, true);
    void fm.recents().then((entries) => {
      if (!recentsMenu) return;
      if (!entries.length) {
        recentsMenu.innerHTML = '<div class="file-menu-hint" style="padding:6px 10px">No recent files yet.</div>';
        return;
      }
      for (const entry of entries.slice(0, 8)) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'file-menu-item';
        el.innerHTML = `<span>${entry.name.replace(/</g, '&lt;')}</span>`;
        el.addEventListener('click', () => {
          closeRecents();
          void fm.openRecent(entry);
        });
        recentsMenu.appendChild(el);
      }
    });
  }

  return {
    update() {},
    stats() {},
    setFile(name, dirty) {
      fileLabel.textContent = name + (dirty ? ' •' : '');
      fileLabel.title = dirty ? `${name} — unsaved changes` : name;
    },
  };
}

/** A small cheat-sheet of the markdown syntax and shortcuts. */
function showHelp(fm: FileManager) {
  document.querySelector('.help-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'bib-editor-overlay help-overlay';
  overlay.innerHTML = `
    <div class="bib-editor help-panel" role="dialog" aria-label="Markdown and shortcuts">
      <div class="bib-editor-head"><span>Markdown &amp; shortcuts</span></div>
      <div class="help-grid">
        <code># ## ###</code><span>headings (⌘⌥1–3)</span>
        <code>**bold** *italic* \`code\`</code><span>inline styles (⌘B / ⌘I / ⌘\`)</span>
        <code>- item · 1. item</code><span>lists (Tab / ⇧Tab to nest)</span>
        <code>&gt; quote · \`\`\`</code><span>block quote · code block</span>
        <code>$x^2$ · $$</code><span>inline math · display equation (⌘M / ⌘⇧M)</span>
        <code>@</code><span>reference or cite — picker lists equations, figures, tables, sections, works</span>
        <code>^[note] · \\footnote{…}</code><span>footnotes (⌘⌥F); ] or Enter exits</span>
        <code>⌘⌥T · ⌘⌥I · ⌘⏎</code><span>insert table · insert figure · page break</span>
        <code>⌘O ⌘S ⇧⌘S</code><span>open · save · save as</span>
      </div>
      <div class="bib-editor-foot">
        <span class="bib-editor-hint"><kbd>Esc</kbd> to close</span>
        <span class="bib-editor-actions">
          <button type="button" class="help-demo">Open demo document</button>
          <button type="button" class="bib-save help-close">Done</button>
        </span>
      </div>
    </div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.help-close')!.addEventListener('click', close);
  overlay.querySelector('.help-demo')!.addEventListener('click', () => {
    if (confirm('Replace the current document with the demo? (Save yours first if it matters.)')) {
      close();
      void import('./demo-doc').then(({ demoDoc }) => fm.newDoc(demoDoc(), 'Demo'));
    }
  });
  overlay.addEventListener('mousedown', (e) => {
    if (!(e.target as HTMLElement).closest('.help-panel')) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  document.body.appendChild(overlay);
  (overlay.querySelector('.help-close') as HTMLElement).focus();
}
