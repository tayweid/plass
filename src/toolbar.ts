// Chrome, Typora-style: a slim quiet bar — filename plus a single row of
// icon buttons whose labels fade in on hover. Everything lives on the bar
// (no overflow menu): file actions, inserts, document tools, exports. The
// only dropdown is Recents, which is inherently a dynamic list.

import { TextSelection } from 'prosemirror-state';
import { setBlockType, toggleMark } from 'prosemirror-commands';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { insertMath } from './math';
import { insertFootnote } from './footnotes';
import { pickAndInsertFigure } from './figures';
import { insertStructuredTable } from './table-editor';
import { editBibliography } from './citations';
import { toggleSettingsPanel } from './settings';
import { isPwaInstalled, onPwaInstallState, requestPwaInstall } from './pwa-install';
import type { TypesetStats } from './typeset-plugin';
import { DEFAULT_DOC_NAME, type FileManager } from './file-manager';

export interface Toolbar {
  update: (state: EditorState) => void;
  stats: (s: TypesetStats) => void;
  setFile: (name: string, dirty: boolean) => void;
  /** The source view opened or closed: press the toggle, and rest the
   *  formatting tools while the text is the truth. */
  setSourceMode: (active: boolean) => void;
}

export interface ToolbarActions {
  /** Toggle the source view (SOURCE-VIEW.md). */
  toggleSource: () => void;
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
  install: '<rect x="3" y="3" width="18" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="8.5 9.5 12 13 15.5 9.5"/><line x1="12" y1="6" x2="12" y2="13"/>',
  alignleft: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="14" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/>',
  aligncenter: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="6.5" y1="12" x2="17.5" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/>',
  alignright: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
};

function icon(name: string): string {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export function buildToolbar(container: HTMLElement, view: EditorView, fm: FileManager, actions: ToolbarActions): Toolbar {
  const fileLabel = document.createElement('span');
  fileLabel.className = 'tb-file';
  fileLabel.textContent = DEFAULT_DOC_NAME;
  fileLabel.title = 'Click to rename';
  fileLabel.addEventListener('click', () => {
    // Rename IN PLACE: the pill text itself becomes editable — no element
    // swap, no native input chrome, nothing moves. A caret appears, the
    // name is selected, and Enter/blur commit (Escape cancels).
    //
    // An unsaved paper names itself the same way and then goes on to the one
    // question a first save asks — where should it live? The name has to be
    // settable here: a folder picker has no filename field to type it into,
    // so otherwise the paper is born as Plass.typ and can only be renamed
    // afterwards. Escape backs out of the save entirely; ⌘S still saves
    // straight away for anyone who does not care what it is called.
    if (fileLabel.isContentEditable) return;
    const firstSave = !fm.saved;
    fileLabel.textContent = fm.name;
    try {
      fileLabel.contentEditable = 'plaintext-only';
    } catch {
      fileLabel.contentEditable = 'true';
    }
    fileLabel.spellcheck = false;
    fileLabel.classList.add('tb-file-editing');
    fileLabel.focus();
    const range = document.createRange();
    range.selectNodeContents(fileLabel);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      fileLabel.removeEventListener('keydown', onKey);
      fileLabel.removeEventListener('blur', onBlur);
      fileLabel.contentEditable = 'false';
      fileLabel.classList.remove('tb-file-editing');
      const name = (fileLabel.textContent ?? '').trim();
      const renamed = commit && !!name && name !== fm.name;
      if (!renamed) fileLabel.textContent = fm.name;
      view.focus();
      // The save has to see the new name, so it waits for the rename.
      const named = renamed ? fm.rename(name) : Promise.resolve();
      if (commit && firstSave) void named.then(() => fm.save());
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    };
    const onBlur = () => finish(true);
    fileLabel.addEventListener('keydown', onKey);
    fileLabel.addEventListener('blur', onBlur);
  });

  // Two capsules: the title, and one tools pill of pipe-separated groups.
  let currentPod!: HTMLElement;
  let toolsPill: HTMLElement | null = null;
  let sourceBtn!: HTMLButtonElement;
  const docTools: HTMLButtonElement[] = [];
  const pod = () => {
    currentPod = document.createElement('div');
    currentPod.className = 'tb-pod';
    container.appendChild(currentPod);
    return currentPod;
  };
  const group = () => {
    if (!toolsPill) {
      toolsPill = pod();
      toolsPill.classList.add('tb-tools');
    } else {
      const div = document.createElement('span');
      div.className = 'tb-div';
      toolsPill.appendChild(div);
    }
    currentPod = document.createElement('span');
    currentPod.className = 'tb-group';
    toolsPill.appendChild(currentPod);
    return currentPod;
  };
  // ---------- anchored popup menus (document-lifecycle actions) ----------
  let openMenu: HTMLElement | null = null;
  let openAnchor: HTMLElement | null = null;
  const closeMenu = () => {
    openMenu?.remove();
    openMenu = null;
    openAnchor = null;
    document.removeEventListener('mousedown', onMenuDown, true);
  };
  const onMenuDown = (e: MouseEvent) => {
    if (openMenu && !openMenu.contains(e.target as Node) && !openAnchor?.contains(e.target as Node)) {
      closeMenu();
    }
  };
  /** Toggle a popup below `anchor`; the trigger never moves — the menu
   *  drops into the room band under the pills. */
  const toggleMenu = (anchor: HTMLElement, build: (menu: HTMLElement) => void) => {
    if (openMenu && openAnchor === anchor) {
      closeMenu();
      return;
    }
    closeMenu();
    openMenu = document.createElement('div');
    openMenu.className = 'file-menu';
    openAnchor = anchor;
    const rect = anchor.getBoundingClientRect();
    openMenu.style.top = `${rect.bottom + 8 + window.scrollY}px`;
    openMenu.style.left = `${Math.max(8, rect.left - 10) + window.scrollX}px`;
    document.body.appendChild(openMenu);
    document.addEventListener('mousedown', onMenuDown, true);
    build(openMenu);
  };
  const menuItem = (menu: HTMLElement, label: string, run: () => void) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'file-menu-item';
    const text = document.createElement('span');
    text.textContent = label;
    el.appendChild(text);
    el.addEventListener('click', () => {
      closeMenu();
      run();
    });
    menu.appendChild(el);
    return el;
  };
  const menuDivider = (menu: HTMLElement) => {
    const div = document.createElement('div');
    div.className = 'file-menu-divider';
    menu.appendChild(div);
  };

  // Hover flyouts: mousing over a group trigger lays a pill of the
  // group's own icon buttons OVER the trigger — same icons, no dropdown,
  // one click to act. Pure :hover, and the flyout overlaps its trigger,
  // so the cursor never crosses a gap.
  const flyout = (
    parent: HTMLElement,
    glyph: string,
    title: string,
    items: Array<{ glyph: string; label: string; title: string; run: (btn: HTMLElement) => void }>,
  ) => {
    const wrap = document.createElement('span');
    wrap.className = 'tb-flyout-wrap';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'tb-btn';
    trigger.title = title;
    trigger.innerHTML = glyph;
    trigger.addEventListener('mousedown', (e) => e.preventDefault());
    wrap.appendChild(trigger);
    const fly = document.createElement('span');
    fly.className = 'tb-flyout';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb-btn';
      b.title = it.title;
      b.innerHTML = `${it.glyph}<span class="lbl">${it.label}</span>`;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => it.run(b));
      fly.appendChild(b);
    }
    wrap.appendChild(fly);
    parent.appendChild(wrap);
  };

  {
    // The title pill: the document's identity plus its lifecycle — the
    // name, the save dot, and two popup menus (file, export). Everything
    // that acts INSIDE the text lives in the tools pill instead.
    const titleBar = document.createElement('div');
    titleBar.className = 'doc-title';
    const dot = document.createElement('span');
    dot.className = 'doc-title-dot';
    dot.setAttribute('aria-hidden', 'true');
    titleBar.appendChild(fileLabel);
    titleBar.appendChild(dot);

    flyout(titleBar, icon('open'), 'File — new, open, recent papers', [
      {
        glyph: icon('new'),
        label: 'New',
        title: 'New document — opens in a new window',
        run: () => {
          const url = new URL(location.href);
          url.searchParams.set('new', '1');
          window.open(url.toString(), '_blank');
        },
      },
      { glyph: icon('open'), label: 'Open', title: 'Open… (⌘O)', run: () => void fm.open() },
      {
        glyph: icon('clock'),
        label: 'Recent',
        title: 'Your papers',
        run: (btn) =>
          toggleMenu(btn, (menu) => {
            void fm.recents().then((entries) => {
              if (!openMenu || openMenu !== menu) return;
              if (!entries.length) {
                const hint = document.createElement('div');
                hint.className = 'file-menu-hint';
                hint.style.padding = '6px 10px';
                hint.textContent = 'No papers yet — they appear here once saved.';
                menu.appendChild(hint);
              }
              for (const entry of entries.slice(0, 8)) {
                menuItem(menu, entry.name, () => void fm.openRecent(entry));
              }
              menuDivider(menu);
              menuItem(menu, 'Open project folder…', () => void fm.openFolder('open'));
            });
          }),
      },
    ]);
    // The source toggle rides on the title pill: it is about the document
    // as a whole (which surface is the truth), not about the text inside.
    sourceBtn = document.createElement('button');
    sourceBtn.type = 'button';
    sourceBtn.className = 'tb-btn tb-source';
    sourceBtn.title = 'Source view — edit the file as text (⌘/)';
    sourceBtn.setAttribute('aria-pressed', 'false');
    sourceBtn.innerHTML = icon('code');
    sourceBtn.addEventListener('mousedown', (e) => e.preventDefault());
    sourceBtn.addEventListener('click', () => actions.toggleSource());
    titleBar.appendChild(sourceBtn);
    container.appendChild(titleBar);
  }

  /** Icon button whose text label fades in on hover. */
  const barBtn = (glyph: string, label: string, title: string, run: () => void) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tb-btn';
    el.title = title;
    el.innerHTML = `${glyph}<span class="lbl">${label}</span>`;
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', () => run());
    currentPod.appendChild(el);
    return el;
  };
  const runCmd = (c: Command) => () => {
    c(view.state, view.dispatch, view);
    view.focus();
  };

  // ---------- insert ----------
  group();
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
  // Block-format cycler: the trigger shows the NEXT step in the caret
  // block's H1 -> H2 -> H3 -> paragraph progression and clicking applies
  // it; hovering fans out all four, aligned so the next step's option
  // sits exactly over the trigger (the flyout re-centers as the
  // progression advances).
  const blockCycle = (() => {
    const wrap = document.createElement('span');
    wrap.className = 'tb-flyout-wrap';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'tb-btn';
    trigger.innerHTML = '<span class="ico tico">H1</span><span class="lbl">Format</span>';
    const tico = trigger.querySelector('.tico') as HTMLElement;
    trigger.addEventListener('mousedown', (e) => e.preventDefault());
    wrap.appendChild(trigger);
    const fly = document.createElement('span');
    fly.className = 'tb-flyout tb-flyout-dyn';
    const LEVELS: Array<{ label: string; title: string; level: number | null }> = [
      { label: 'H1', title: 'Heading 1 (⌘⌥1)', level: 1 },
      { label: 'H2', title: 'Heading 2 (⌘⌥2)', level: 2 },
      { label: 'H3', title: 'Heading 3 (⌘⌥3)', level: 3 },
      { label: '¶', title: 'Body text (⌘⌥0)', level: null },
    ];
    const apply = (level: number | null) => {
      const cmd = level ? setBlockType(schema.nodes.heading, { level }) : setBlockType(schema.nodes.paragraph);
      cmd(view.state, view.dispatch);
      view.focus();
    };
    const items: HTMLButtonElement[] = [];
    for (const it of LEVELS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb-btn';
      b.title = it.title;
      b.innerHTML = `<span class="ico tico">${it.label}</span>`;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => apply(it.level));
      fly.appendChild(b);
      items.push(b);
    }
    wrap.appendChild(fly);
    currentPod.appendChild(wrap);

    const current = (state: EditorState): number | null => {
      const { $from } = state.selection;
      if ($from.depth < 1) return null;
      const node = $from.node(1);
      return node.type === schema.nodes.heading ? (node.attrs.level as number) : null;
    };
    const next = (cur: number | null): number | null => (cur === null ? 1 : cur === 3 ? null : cur + 1);
    let lastCurrent: number | null | undefined;
    const refresh = (state: EditorState) => {
      const cur = current(state);
      // Character transactions leave the block-format UI unchanged. Besides
      // avoiding redundant DOM writes, this keeps the flyout's offset reads
      // entirely off the ordinary typing path (including native table cells).
      if (cur === lastCurrent) return;
      lastCurrent = cur;
      const nx = next(cur);
      tico.textContent = nx ? `H${nx}` : '¶';
      trigger.title = nx ? `Make this block Heading ${nx}` : 'Back to body text';
      items.forEach((b, i) => b.classList.toggle('tb-flyout-cur', i === (cur ? cur - 1 : 3)));
      const b = items[nx ? nx - 1 : 3];
      fly.style.left = `${wrap.offsetWidth / 2 - (b.offsetLeft + b.offsetWidth / 2)}px`;
    };
    trigger.addEventListener('click', () => apply(next(current(view.state))));
    return { refresh };
  })();
  // Inline text styles. The keyboard (⌘B, ⌘I, ⌘⇧X) and the input rules
  // (**bold**, *italic*, ~~strike~~) stay the primary path; the flyout is
  // for discoverability — strikethrough especially has no visible surface
  // otherwise.
  flyout(currentPod, '<span class="ico tico"><b>B</b></span>', 'Text style — bold, italic, strikethrough', [
    {
      glyph: '<span class="ico tico"><b>B</b></span>',
      label: 'Bold',
      title: 'Bold (⌘B) — or type **text**',
      run: runCmd(toggleMark(schema.marks.strong)),
    },
    {
      glyph: '<span class="ico tico"><i>I</i></span>',
      label: 'Italic',
      title: 'Italic (⌘I) — or type *text*',
      run: runCmd(toggleMark(schema.marks.em)),
    },
    {
      glyph: '<span class="ico tico"><s>S</s></span>',
      label: 'Strike',
      title: 'Strikethrough (⌘⇧X) — or type ~~text~~',
      run: runCmd(toggleMark(schema.marks.strike)),
    },
  ]);
  // Paragraph alignment: applies to every top-level paragraph the
  // selection touches. Left = the justified default (align attr null).
  const setAlign = (align: 'center' | 'right' | null) => {
    const { state } = view;
    const { from, to } = state.selection;
    let tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === schema.nodes.paragraph && state.doc.resolve(pos).depth === 0) {
        if ((node.attrs.align ?? null) !== align) {
          tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, align });
        }
        return false;
      }
      return true;
    });
    if (tr.steps.length) view.dispatch(tr);
    view.focus();
  };
  flyout(currentPod, icon('aligncenter'), 'Align paragraph — left, center, right', [
    { glyph: icon('alignleft'), label: 'Left', title: 'Align left (justified body text)', run: () => setAlign(null) },
    { glyph: icon('aligncenter'), label: 'Center', title: 'Center text', run: () => setAlign('center') },
    { glyph: icon('alignright'), label: 'Right', title: 'Align right', run: () => setAlign('right') },
  ]);
  barBtn(icon('image'), 'Figure', 'Insert figure (⌘⌥I) — or paste/drop an image', runCmd(insertFigureCmd));
  barBtn(icon('table'), 'Table', 'Insert table (⌘⌥T)', () => insertStructuredTable(view));
  barBtn('<span class="ico tico">Σ</span>', 'Math', 'Inline math (⌘M) — or type $x^2$; ⌘⇧M for display', runCmd(insertMath(false)));
  barBtn('<span class="ico tico">†</span>', 'Note', 'Footnote (⌘⌥F) — or type ^[', runCmd(insertFootnote));
  flyout(currentPod, icon('code'), 'Code block — source code or raw Typst', [
    {
      glyph: icon('code'),
      label: 'Code',
      title: 'Code block — monospaced source listing',
      run: () => {
        setBlockType(schema.nodes.code_block, { params: '' })(view.state, view.dispatch);
        view.focus();
      },
    },
    {
      glyph: '<span class="ico tico">#</span>',
      label: 'Typst',
      title: 'Raw Typst block — compiles into the document (rules, spacing, anything Typst)',
      run: () => {
        setBlockType(schema.nodes.code_block, { params: 'typst-raw' })(view.state, view.dispatch);
        view.focus();
      },
    },
    {
      glyph: '<span class="ico tico">#·</span>',
      label: 'Inline',
      title: 'Inline raw Typst — mid-sentence: fill lines (#h(1fr)), blanks, symbols',
      run: () => void import('./inline-raw').then(({ insertTypstInline }) => insertTypstInline(view)),
    },
  ]);
  barBtn(icon('pagebreak'), 'Break', 'Page break (⌘⏎)', () => {
    const { state, dispatch } = view;
    const { $from } = state.selection;
    const pos = $from.after($from.depth > 0 ? 1 : 0);
    dispatch(state.tr.insert(pos, schema.nodes.page_break.create()).scrollIntoView());
    view.focus();
  });
  {
    // Document apparatus splits into its own pill: settings is the face,
    // bibliography and help flank it; export rides alongside.
    const docPod = pod();
    flyout(docPod, icon('sliders'), 'Document — bibliography, settings, help', [
      {
        glyph: icon('book'),
        label: 'Bib',
        title: 'Edit bibliography',
        run: () => editBibliography(view, (m) => fm.notify(m)),
      },
      {
        glyph: icon('sliders'),
        label: 'Settings',
        title: 'Document settings',
        run: (btn) => toggleSettingsPanel(view, btn),
      },
      {
        glyph: '<span class="ico tico">?</span>',
        label: 'Help',
        title: 'Markdown & shortcuts',
        run: () => showHelp(fm),
      },
    ]);
    for (const b of docPod.querySelectorAll<HTMLButtonElement>('[title="Edit bibliography"], [title="Document settings"]')) {
      docTools.push(b);
    }
    const div = document.createElement('span');
    div.className = 'tb-div';
    docPod.appendChild(div);
    flyout(docPod, icon('download'), 'Export — PDF, .typ, .tex', [
      { glyph: icon('filedown'), label: '.typ', title: 'Export a .typ copy', run: () => void fm.exportCopy() },
      {
        glyph: icon('download'),
        label: 'PDF',
        title: 'Export PDF via Typst',
        run: () => {
          void import('./pdf').then(({ exportPdf }) =>
            exportPdf(fm.currentDoc(), fm.name, (m) => fm.notify(m), (name, blob) => fm.saveBeside(name, blob)),
          );
        },
      },
      {
        glyph: icon('filedown'),
        label: '.tex',
        title: 'Export a .tex copy (vanilla LaTeX for journals)',
        run: () => fm.exportTexCopy(),
      },
    ]);
    const installButton = barBtn(
      icon('install'),
      'Install',
      'Install Plass as an app',
      () => void requestPwaInstall((message) => fm.notify(message)),
    );
    installButton.classList.add('pwa-install');
    installButton.setAttribute('aria-label', 'Install Plass');
    installButton.hidden = isPwaInstalled();
    onPwaInstallState((installed) => {
      installButton.hidden = installed;
    });
  }

  return {
    update(state) {
      blockCycle.refresh(state);
    },
    stats() {},
    setSourceMode(active) {
      sourceBtn.setAttribute('aria-pressed', String(active));
      sourceBtn.classList.toggle('active', active);
      // The tools pill acts on the ProseMirror document, which is not the
      // truth while the source is open.
      toolsPill?.classList.toggle('tb-resting', active);
      for (const b of toolsPill?.querySelectorAll<HTMLButtonElement>('button') ?? []) b.disabled = active;
      // So do the bibliography and settings editors; help and export stay
      // (export parses the text on demand, decision 9).
      for (const b of docTools) {
        b.disabled = active;
        b.classList.toggle('tb-resting-btn', active);
      }
    },
    setFile(name, dirty) {
      const unsaved = !fm.saved || dirty;
      // The save state is the dot beside the name.
      const bar = fileLabel.closest('.doc-title') ?? fileLabel.parentElement;
      bar?.classList.toggle('doc-saved', !unsaved);
      bar?.classList.toggle('doc-unsaved', unsaved);
      if (!fm.saved) {
        if (!fileLabel.isContentEditable) fileLabel.textContent = name;
        fileLabel.title = 'Click to name and save — you pick the folder your paper lives in';
        return;
      }
      fileLabel.textContent = name;
      fileLabel.title = dirty ? `${name} — unsaved changes` : `${name} — click to rename`;
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
        <code># ## ###</code><span>headings (⌘⌥1–3 · ⌘⌥0 back to text)</span>
        <code>**bold** *italic* \`code\`</code><span>inline styles (⌘B / ⌘I / ⌘\`)</span>
        <code>- item · 1. item</code><span>lists (Tab / ⇧Tab to nest)</span>
        <code>&gt; quote · \`\`\`</code><span>block quote · code block</span>
        <code>$x^2$ · $$</code><span>inline math · display equation (⌘M / ⌘⇧M)</span>
        <code>@</code><span>reference or cite — picker lists equations, figures, tables, sections, works</span>
        <code>^[note] · \\footnote{…}</code><span>footnotes (⌘⌥F); ] or Enter exits</span>
        <code>⌘⌥T · ⌘⌥I · ⌘⏎</code><span>insert table · insert figure · page break</span>
        <code>⌘O ⌘S</code><span>open · save (first save picks the paper's folder)</span>
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
