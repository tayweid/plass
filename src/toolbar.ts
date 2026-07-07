// Minimal formatting toolbar + file actions + the TeX-layout toggle.

import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { wrapInList } from 'prosemirror-schema-list';
import type { MarkType, NodeType } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { insertMath } from './math';
import { isTypesetEnabled, toggleTypeset, type TypesetStats } from './typeset-plugin';
import { toggleSettingsPanel } from './settings';
import { pickAndInsertFigure } from './figures';
import { insertFootnote } from './footnotes';
import { editBibliography, importBibliography } from './citations';
import { alignColumn, cycleTableStyle, editTableOptions, insertTable } from './tables';
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
import type { FileManager } from './file-manager';

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

function blockActive(state: EditorState, type: NodeType, attrs: Record<string, unknown> = {}): boolean {
  const { $from, to } = state.selection;
  return to <= $from.end() && $from.parent.hasMarkup(type, attrs);
}

interface Btn {
  el: HTMLButtonElement;
  update: (state: EditorState) => void;
}

function button(
  label: string,
  title: string,
  run: Command,
  view: EditorView,
  active?: (state: EditorState) => boolean,
): Btn {
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
      el.classList.toggle('active', active ? active(state) : false);
      el.disabled = !run(state, undefined, view);
    },
  };
}

export interface Toolbar {
  update: (state: EditorState) => void;
  stats: (s: TypesetStats) => void;
  setFile: (name: string, dirty: boolean) => void;
}

export function buildToolbar(container: HTMLElement, view: EditorView, fm: FileManager): Toolbar {
  const buttons: Btn[] = [];
  const group = (cls = '') => {
    const g = document.createElement('div');
    g.className = 'tb-group ' + cls;
    container.appendChild(g);
    return g;
  };

  const fmt = group();
  const add = (g: HTMLElement, b: Btn) => {
    buttons.push(b);
    g.appendChild(b.el);
  };

  add(fmt, button('<b>B</b>', 'Bold (⌘B)', toggleMark(schema.marks.strong), view, (s) => markActive(s, schema.marks.strong)));
  add(fmt, button('<i>I</i>', 'Italic (⌘I)', toggleMark(schema.marks.em), view, (s) => markActive(s, schema.marks.em)));
  add(fmt, button('<code>&lt;&gt;</code>', 'Code (⌘`)', toggleMark(schema.marks.code), view, (s) => markActive(s, schema.marks.code)));

  const blocks = group();
  add(blocks, button('H1', 'Heading 1 (⌘⌥1)', setBlockType(schema.nodes.heading, { level: 1 }), view, (s) => blockActive(s, schema.nodes.heading, { level: 1 })));
  add(blocks, button('H2', 'Heading 2 (⌘⌥2)', setBlockType(schema.nodes.heading, { level: 2 }), view, (s) => blockActive(s, schema.nodes.heading, { level: 2 })));
  add(blocks, button('H3', 'Heading 3 (⌘⌥3)', setBlockType(schema.nodes.heading, { level: 3 }), view, (s) => blockActive(s, schema.nodes.heading, { level: 3 })));
  add(blocks, button('¶', 'Paragraph (⌘⌥0)', setBlockType(schema.nodes.paragraph), view));

  const structure = group();
  add(structure, button('•', 'Bullet list (⌘⇧8)', wrapInList(schema.nodes.bullet_list), view));
  add(structure, button('1.', 'Numbered list (⌘⇧9)', wrapInList(schema.nodes.ordered_list), view));
  add(structure, button('"', 'Block quote', wrapIn(schema.nodes.blockquote), view));
  add(structure, button('√x', 'Inline math (⌘M) — or type $x^2$', insertMath(false), view));
  add(structure, button('∑', 'Display math (⌘⇧M) — or type $$ on an empty line', insertMath(true), view));

  add(structure, button('†', 'Footnote (⌘⌥F)', insertFootnote, view));

  const figBtn = document.createElement('button');
  figBtn.type = 'button';
  figBtn.textContent = '🖼';
  figBtn.title = 'Insert figure — or paste/drop an image';
  figBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    pickAndInsertFigure(view);
  });
  structure.appendChild(figBtn);

  add(structure, button('⊞', 'Insert table', insertTable(), view));

  // Table surgery — only shown while the selection is inside a table.
  const tableGroup = group('tb-table');
  add(tableGroup, button('+Col', 'Add column', addColumnAfter, view));
  add(tableGroup, button('−Col', 'Delete column', deleteColumn, view));
  add(tableGroup, button('+Row', 'Add row', addRowAfter, view));
  add(tableGroup, button('−Row', 'Delete row', deleteRow, view));
  add(tableGroup, button('⧉', 'Merge selected cells', mergeCells, view));
  add(tableGroup, button('⊟', 'Split cell', splitCell, view));
  add(tableGroup, button('Hdr', 'Toggle header row', toggleHeaderRow, view));
  add(tableGroup, button('L', 'Align column left', alignColumn('left'), view));
  add(tableGroup, button('C', 'Align column center', alignColumn('center'), view));
  add(tableGroup, button('R', 'Align column right (numbers)', alignColumn('right'), view));
  add(tableGroup, button('Style', 'Cycle table style: booktabs → grid → plain', cycleTableStyle, view));
  const optsBtn = document.createElement('button');
  optsBtn.type = 'button';
  optsBtn.textContent = 'Opts';
  optsBtn.title = 'Raw Typst #table arguments — full control (stroke/fill functions, column widths, …)';
  optsBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    editTableOptions(view);
  });
  tableGroup.appendChild(optsBtn);
  add(tableGroup, button('✕⊞', 'Delete table', deleteTable, view));

  const hist = group();
  add(hist, button('↺', 'Undo (⌘Z)', undo, view));
  add(hist, button('↻', 'Redo (⌘⇧Z)', redo, view));

  // right side
  const right = group('tb-right');

  const fileLabel = document.createElement('span');
  fileLabel.className = 'tb-file';
  fileLabel.textContent = 'Untitled';
  right.appendChild(fileLabel);

  const toggleWrap = document.createElement('label');
  toggleWrap.className = 'tb-toggle';
  toggleWrap.title = 'Toggle the Knuth–Plass layout oracle on/off to compare with plain browser layout';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = true;
  toggle.addEventListener('change', () => {
    toggleTypeset(view);
    view.focus();
  });
  toggleWrap.append(toggle, document.createTextNode(' TeX layout'));
  right.appendChild(toggleWrap);

  const statsEl = document.createElement('span');
  statsEl.className = 'tb-stats';
  right.appendChild(statsEl);

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.textContent = '⚙ Settings';
  settingsBtn.title = 'Document settings — font, paper, margins, hyphenation, equation numbering';
  settingsBtn.addEventListener('click', () => toggleSettingsPanel(view, settingsBtn));
  right.appendChild(settingsBtn);

  const fileBtn = document.createElement('button');
  fileBtn.type = 'button';
  fileBtn.textContent = 'File ▾';
  fileBtn.addEventListener('click', () => toggleFileMenu(fileBtn, view, fm));
  right.appendChild(fileBtn);

  return {
    update(state) {
      for (const b of buttons) b.update(state);
      toggle.checked = isTypesetEnabled(state);
      tableGroup.style.display = isInTable(state) ? '' : 'none';
    },
    stats(s) {
      statsEl.textContent = `oracle ${s.ms.toFixed(1)} ms · ${s.paragraphs}¶ · ${s.lines} lines`;
    },
    setFile(name, dirty) {
      fileLabel.textContent = name + (dirty ? ' •' : '');
      fileLabel.title = dirty ? `${name} — unsaved changes` : name;
    },
  };
}

// ---------- File menu ----------

let openMenu: HTMLElement | null = null;

function toggleFileMenu(anchor: HTMLElement, view: EditorView, fm: FileManager) {
  if (openMenu) {
    closeMenu();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'file-menu';
  openMenu = menu;

  const mac = /Mac/.test(navigator.platform);
  const mod = mac ? '⌘' : 'Ctrl+';

  const item = (label: string, hint: string, run: () => void, disabled = false) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'file-menu-item';
    el.disabled = disabled;
    el.innerHTML = `<span>${label}</span><span class="file-menu-hint">${hint}</span>`;
    el.addEventListener('click', () => {
      closeMenu();
      run();
      view.focus();
    });
    menu.appendChild(el);
    return el;
  };
  const divider = () => {
    const d = document.createElement('div');
    d.className = 'file-menu-divider';
    menu.appendChild(d);
  };

  item('New', '', () => {
    if (confirm('Replace the current document with an empty one?')) fm.newDoc();
  });
  item('Open demo document', '', () => {
    if (confirm('Replace the current document with the demo? (Save yours first if it matters.)')) {
      void import('./demo-doc').then(({ demoDoc }) => fm.newDoc(demoDoc(), 'Demo'));
    }
  });
  item('Open…', `${mod}O`, () => void fm.open());
  item('Save', `${mod}S`, () => void fm.save());
  item('Save As…', mac ? '⇧⌘S' : 'Ctrl+Shift+S', () => void fm.saveAs(), !fm.supportsFS);
  item('Edit bibliography…', '', () => editBibliography(view, (m) => fm.notify(m)));
  item('Import bibliography (.bib)…', '', () => importBibliography(view, (m) => fm.notify(m)));
  divider();
  const recentsHolder = document.createElement('div');
  menu.appendChild(recentsHolder);
  divider();
  item('Export PDF (Typst)', '', () => {
    const name = fm.name === 'Untitled' ? 'document' : fm.name;
    void import('./pdf').then(({ exportPdf }) => exportPdf(fm.currentDoc(), name, (m) => fm.notify(m)));
  });
  item('Download copy (.typ)', '', () => fm.exportCopy());
  item('Print / PDF', `${mod}P`, () => window.print());

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6 + window.scrollY}px`;
  menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth) + window.scrollX}px`;

  void fm.recents().then((entries) => {
    if (!openMenu || !entries.length) return;
    const head = document.createElement('div');
    head.className = 'file-menu-head';
    head.textContent = 'Recent';
    recentsHolder.appendChild(head);
    for (const entry of entries.slice(0, 6)) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'file-menu-item';
      el.innerHTML = `<span>${entry.name.replace(/</g, '&lt;')}</span>`;
      el.addEventListener('click', () => {
        closeMenu();
        void fm.openRecent(entry);
      });
      recentsHolder.appendChild(el);
    }
  });

  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeMenu();
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);

  function closeMenu() {
    menu.remove();
    openMenu = null;
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
}
