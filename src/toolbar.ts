// Chrome, Typora-style: a slim quiet bar (title + one ⋯ menu). Formatting
// happens through markdown input rules and keyboard shortcuts; the menu
// carries file/insert/document/export actions with their shortcuts, and
// table controls float beside the table only while the caret is inside one.

import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import {
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  mergeCells,
  splitCell,
  toggleHeaderRow,
} from 'prosemirror-tables';
import { schema } from './schema';
import { insertMath } from './math';
import { insertFootnote } from './footnotes';
import { pickAndInsertFigure } from './figures';
import { alignColumn, cycleTableStyle, editTableOptions, insertTable } from './tables';
import { editBibliography, importBibliography } from './citations';
import { toggleSettingsPanel } from './settings';
import { isTypesetEnabled, toggleTypeset, type TypesetStats } from './typeset-plugin';
import type { FileManager } from './file-manager';

export interface Toolbar {
  update: (state: EditorState) => void;
  stats: (s: TypesetStats) => void;
  setFile: (name: string, dirty: boolean) => void;
}

interface Btn {
  el: HTMLButtonElement;
  update: (state: EditorState) => void;
}

function button(label: string, title: string, run: Command, view: EditorView): Btn {
  const el = document.createElement('button');
  el.type = 'button';
  el.innerHTML = label;
  el.title = title;
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    run(view.state, view.dispatch, view);
    view.focus();
  });
  return {
    el,
    update(state) {
      el.disabled = !run(state, undefined, view);
    },
  };
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
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="21"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
};

function icon(name: string): string {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export function buildToolbar(container: HTMLElement, view: EditorView, fm: FileManager): Toolbar {
  let lastStats: TypesetStats | null = null;

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

  /** Icon button whose text label slides out on hover. */
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

  barBtn(icon('new'), 'New', 'New document', () => {
    if (confirm('Replace the current document with an empty one?')) fm.newDoc();
  });
  barBtn(icon('open'), 'Open', 'Open… (⌘O)', () => void fm.open());
  barBtn(icon('save'), 'Save', 'Save (⌘S)', () => void fm.save());
  barDivider();
  barBtn(icon('image'), 'Figure', 'Insert figure (⌘⌥I) — or paste/drop an image', runCmd(insertFigureCmd));
  barBtn(icon('table'), 'Table', 'Insert table (⌘⌥T)', runCmd(insertTable()));
  barBtn('<span class="ico tico">Σ</span>', 'Math', 'Inline math (⌘M) — or type $x^2$; ⌘⇧M for display', runCmd(insertMath(false)));
  barBtn('<span class="ico tico">†</span>', 'Note', 'Footnote (⌘⌥F) — or type ^[', runCmd(insertFootnote));
  barDivider();
  barBtn(icon('book'), 'Bib', 'Edit bibliography', () => editBibliography(view, (m) => fm.notify(m)));
  barBtn(icon('sliders'), 'Settings', 'Document settings', () => toggleSettingsPanel(view, menuBtn));
  const texBtn = barBtn('<span class="ico tico tex">TeX</span>', 'Layout', 'Toggle TeX typesetting', () => {
    toggleTypeset(view);
    view.focus();
  });
  barBtn('<span class="ico tico">?</span>', 'Help', 'Markdown & shortcuts', showHelp);
  barDivider();
  barBtn(icon('download'), 'PDF', 'Export PDF via Typst', () => {
    const name = fm.name === 'Untitled' ? 'document' : fm.name;
    void import('./pdf').then(({ exportPdf }) => exportPdf(fm.currentDoc(), name, (m) => fm.notify(m)));
  });

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'tb-menu-btn';
  menuBtn.setAttribute('aria-label', 'More');
  menuBtn.title = 'More…';
  menuBtn.textContent = '⋯';
  menuBtn.addEventListener('click', () => toggleMenu());
  container.append(menuBtn);

  // ---------- floating table controls ----------

  const pill = document.createElement('div');
  pill.className = 'table-pill';
  pill.hidden = true;
  const pillButtons: Btn[] = [];
  const addPill = (b: Btn) => {
    pillButtons.push(b);
    pill.appendChild(b.el);
  };
  addPill(button('+Col', 'Add column', addColumnAfter, view));
  addPill(button('−Col', 'Delete column', deleteColumn, view));
  addPill(button('+Row', 'Add row', addRowAfter, view));
  addPill(button('−Row', 'Delete row', deleteRow, view));
  addPill(button('⧉', 'Merge selected cells', mergeCells, view));
  addPill(button('⊟', 'Split cell', splitCell, view));
  addPill(button('Hdr', 'Toggle header row', toggleHeaderRow, view));
  addPill(button('L', 'Align column left', alignColumn('left'), view));
  addPill(button('C', 'Align column center', alignColumn('center'), view));
  addPill(button('R', 'Align column right', alignColumn('right'), view));
  addPill(button('Style', 'Cycle style: booktabs → grid → plain', cycleTableStyle, view));
  const optsBtn = document.createElement('button');
  optsBtn.type = 'button';
  optsBtn.textContent = 'Opts';
  optsBtn.title = 'Raw Typst #table arguments — full control';
  optsBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    editTableOptions(view);
  });
  pill.appendChild(optsBtn);
  addPill(button('✕⊞', 'Delete table', deleteTable, view));
  document.body.appendChild(pill);

  const positionPill = (state: EditorState) => {
    if (!isInTable(state)) {
      pill.hidden = true;
      return;
    }
    const { $from } = state.selection;
    let tablePos = -1;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === schema.nodes.table) {
        tablePos = $from.before(d);
        break;
      }
    }
    if (tablePos < 0) {
      pill.hidden = true;
      return;
    }
    const dom = view.nodeDOM(tablePos);
    if (!(dom instanceof HTMLElement)) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    for (const b of pillButtons) b.update(state);
    const rect = dom.getBoundingClientRect();
    const topbar = container.getBoundingClientRect().bottom;
    const above = rect.top - 40;
    pill.style.top = `${Math.max(topbar + 6, above)}px`;
    pill.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pill.offsetWidth - 8))}px`;
  };

  document.getElementById('scroll')?.addEventListener('scroll', () => {
    if (!pill.hidden) positionPill(view.state);
  });

  // ---------- the ⋯ menu ----------

  let menu: HTMLElement | null = null;

  const closeMenu = () => {
    menu?.remove();
    menu = null;
  };

  function toggleMenu() {
    if (menu) {
      closeMenu();
      return;
    }
    menu = document.createElement('div');
    menu.className = 'file-menu app-menu';

    const mac = /Mac/.test(navigator.platform);
    const mod = mac ? '⌘' : 'Ctrl+';

    const head = (text: string) => {
      const h = document.createElement('div');
      h.className = 'file-menu-head';
      h.textContent = text;
      menu!.appendChild(h);
    };
    const item = (label: string, hint: string, run: () => void, disabled = false) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'file-menu-item';
      el.disabled = disabled;
      el.innerHTML = `<span>${label}</span><span class="file-menu-hint">${hint}</span>`;
      el.addEventListener('click', () => {
        closeMenu();
        run();
      });
      menu!.appendChild(el);
    };
    const divider = () => {
      const d = document.createElement('div');
      d.className = 'file-menu-divider';
      menu!.appendChild(d);
    };
    const cmd = (c: Command) => () => {
      c(view.state, view.dispatch, view);
      view.focus();
    };

    head('File');
    item('Open demo document', '', () => {
      if (confirm('Replace the current document with the demo? (Save yours first if it matters.)')) {
        void import('./demo-doc').then(({ demoDoc }) => fm.newDoc(demoDoc(), 'Demo'));
      }
    });
    item('Save As…', mac ? '⇧⌘S' : 'Ctrl+Shift+S', () => void fm.saveAs(), !fm.supportsFS);
    const recentsHolder = document.createElement('div');
    menu.appendChild(recentsHolder);

    divider();
    head('More');
    item('Display math', `$$ · ${mod}⇧M`, cmd(insertMath(true)));
    item('Import bibliography (.bib)…', '', () => importBibliography(view, (m) => fm.notify(m)));
    item('Download copy (.typ)', '', () => fm.exportCopy());
    item('Print / PDF', `${mod}P`, () => window.print());

    if (lastStats) {
      const foot = document.createElement('div');
      foot.className = 'app-menu-foot';
      foot.textContent = `oracle ${lastStats.ms.toFixed(1)} ms · ${lastStats.paragraphs}¶ · ${lastStats.lines} lines`;
      menu.appendChild(foot);
    }

    document.body.appendChild(menu);
    const rect = menuBtn.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6 + window.scrollY}px`;
    menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth) + window.scrollX}px`;

    void fm.recents().then((entries) => {
      if (!menu || !entries.length) return;
      for (const entry of entries.slice(0, 4)) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'file-menu-item file-menu-recent';
        el.innerHTML = `<span>↪ ${entry.name.replace(/</g, '&lt;')}</span>`;
        el.addEventListener('click', () => {
          closeMenu();
          void fm.openRecent(entry);
        });
        recentsHolder.appendChild(el);
      }
    });

    const onDown = (e: MouseEvent) => {
      if (menu && !menu.contains(e.target as Node) && !menuBtn.contains(e.target as Node)) closeAll();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll();
    };
    const closeAll = () => {
      closeMenu();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }

  return {
    update(state) {
      positionPill(state);
      texBtn.classList.toggle('active', isTypesetEnabled(state));
    },
    stats(s) {
      lastStats = s;
    },
    setFile(name, dirty) {
      fileLabel.textContent = name + (dirty ? ' •' : '');
      fileLabel.title = dirty ? `${name} — unsaved changes` : name;
    },
  };
}

/** A small cheat-sheet of the markdown syntax and shortcuts. */
function showHelp() {
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
        <code>@</code><span>reference or cite — picker lists equations, figures, sections, works</span>
        <code>^[note] · \\footnote{…}</code><span>footnotes (⌘⌥F); ] or Enter exits</span>
        <code>⌘⌥T · ⌘⌥I</code><span>insert table · insert figure (or paste/drop an image)</span>
        <code>⌘O ⌘S ⇧⌘S</code><span>open · save · save as</span>
      </div>
      <div class="bib-editor-foot">
        <span class="bib-editor-hint">Everything lives in the ⋯ menu, too. <kbd>Esc</kbd> to close</span>
        <span class="bib-editor-actions"><button type="button" class="bib-save help-close">Done</button></span>
      </div>
    </div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.help-close')!.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => {
    if (!(e.target as HTMLElement).closest('.help-panel')) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  document.body.appendChild(overlay);
  (overlay.querySelector('.help-close') as HTMLElement).focus();
}