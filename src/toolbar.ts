// Zen's shape: the paper's way in and out in the bar beside the traffic
// lights (File, the name with its save dot and folder — Knuth's bar —
// then, in Plass.app, History, and Export), the tools on a rail down the
// left in the bar's old groups, the occasional ones behind Extras. Menus
// preserve the editor selection and keep geometry reads off typing.

import './toolbar.css';
import { TextSelection } from 'prosemirror-state';
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { wrapInList } from 'prosemirror-schema-list';
import { schema } from './schema';
import { toggleListSpacing } from './editing';
import { insertMath } from './math';
import { insertFootnote } from './footnotes';
import { pickAndInsertFigure } from './figures';
import { insertStructuredTable } from './table-editor';
import { insertGrid } from './grid-editor';
import { insertEditorComment } from './editor-comments';
import { editBibliography } from './citations';
import { toggleSettingsPanel } from './settings';
import { placeFlyout } from './flyout';
import { isPwaInstalled, onPwaInstallState, requestPwaInstall } from './pwa-install';
import { checkForUpdate, closeHistory, installUpdate, isNativeShell, moveHistory, onHistoryView, onUpdate, openHistory } from './claerbout';
import type { TypesetStats } from './typeset-plugin';
import { DEFAULT_DOC_NAME, type FileManager } from './file-manager';

// Every deploy publishes the Mac app beside this page (.github/workflows/
// deploy.yml), so both links are this page's version.
const APP_ZIP = 'https://plass.tayweid.io/app/Plass.app.zip';
const APP_LINE = 'curl -fsSL https://plass.tayweid.io/install | bash';

export interface Toolbar {
  update: (state: EditorState) => void;
  stats: (s: TypesetStats) => void;
  setFile: (name: string, dirty: boolean) => void;
  /** Where the open file lives, as Plass.app's shell knows it (claerbout.ts
   *  reportDocument), or null: the bar shows its folder beside the name. */
  setPath: (path: string | null) => void;
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

const ICONS: Record<string, string> = {
  grid: '<rect x="3" y="4" width="10" height="16" rx="1.5"/><rect x="15.5" y="4" width="5.5" height="16" rx="1.5"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="21"/>',
  pagebreak: '<polyline points="8 3 8 8 16 8 16 3"/><line x1="3" y1="12" x2="7" y2="12"/><line x1="10" y1="12" x2="14" y2="12"/><line x1="17" y1="12" x2="21" y2="12"/><polyline points="8 21 8 16 16 16 16 21"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  install: '<rect x="3" y="3" width="18" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="8.5 9.5 12 13 15.5 9.5"/><line x1="12" y1="6" x2="12" y2="13"/>',
  alignleft: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="14" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/>',
  aligncenter: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="6.5" y1="12" x2="17.5" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/>',
  alignright: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/>',
  paragraph: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="15" y2="18"/>',
  // Quotation marks, so the Blocks group reads apart from Lists above it.
  quote: '<circle cx="7.5" cy="14.5" r="2.6" fill="currentColor" stroke="none"/><path d="M4.9 14.4C4.9 10.6 6.7 8.1 10.2 6.8"/><circle cx="16.5" cy="14.5" r="2.6" fill="currentColor" stroke="none"/><path d="M13.9 14.4C13.9 10.6 15.7 8.1 19.2 6.8"/>',
  // The solution block's own mark: its red rule beside the text.
  solution: '<line x1="5" y1="4" x2="5" y2="20" stroke="#d9433a" stroke-width="2.8"/><line x1="10" y1="8" x2="20" y2="8"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="16" x2="16" y2="16"/>',
  open: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  list: '<circle cx="4" cy="6" r="1.2" fill="currentColor"/><circle cx="4" cy="12" r="1.2" fill="currentColor"/><circle cx="4" cy="18" r="1.2" fill="currentColor"/><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
};

function icon(name: string): string {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

// The History tile's glyph, the standard history icon: a clock face with a
// counter-clockwise arrow around its left side (Material's "history" in the
// icons' stroke), the arrowhead at nine o'clock pointing back down the arc,
// the hands at twelve and four. Taylor asked for "the rewind clock one":
// the glyph people already read as history, where the record's river it
// replaced had to be learned. One SVG in both apps, byte for byte: Knuth's
// copy is HISTORY_GLYPH in knuth/src/main.ts, and a change is made to both.
// Knuth's bar also has a Restart session tile, an arrow round a circle
// (Feather's rotate-ccw); the hands tell the two apart, so they stay long
// enough to read at 18 px.
const HISTORY_GLYPH = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12a8 8 0 1 1 2.34 5.66M2.2 9.8 5 12.6l2.8-2.8"/><polyline points="13 7.5 13 12 16.5 14"/></svg>';

/** A folder as a person reads it: their home as ~ (Knuth's, src/main.ts).
 *  The page has no way to ask for the home folder, so a home is what macOS
 *  puts there — /Users/<name> — but not /Users/Shared, which is no one's. */
function tilde(path: string): string {
  return path.replace(/^\/(?:Users|home)\/(?!Shared(?:\/|$))[^/]+(?=\/|$)/, '~');
}

export function buildToolbar(container: HTMLElement, rail: HTMLElement, view: EditorView, fm: FileManager, actions: ToolbarActions): Toolbar {
  // The name pill, Knuth's (knuth/src/main.ts, #doc-pod): the document's
  // name, its save dot and the folder it lives in.
  const fileLabel = document.createElement('span');
  fileLabel.className = 'name';
  fileLabel.id = 'file-name';
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

  container.setAttribute('aria-label', 'Document toolbar');
  fileLabel.tabIndex = 0;
  fileLabel.setAttribute('role', 'button');
  fileLabel.addEventListener('keydown', (e) => {
    if (!fileLabel.isContentEditable && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      fileLabel.click();
    }
  });
  const titleBar = document.createElement('div');
  titleBar.className = 'doc-pod';
  titleBar.id = 'doc-pod';
  const dot = document.createElement('span');
  dot.className = 'doc-mark';
  dot.id = 'doc-mark';
  dot.setAttribute('aria-hidden', 'true');
  // The folder beside the name, in a sibling so the name's own text stays
  // exactly the name: the file's folder (home as ~) where the shell knows
  // the path, else a project folder's name (a browser tab working in a
  // folder), else nothing — a tab with a bare file shows the name alone.
  // It is what gives way when the pill is short, from its start, so the
  // nearest folder stays (style.css).
  const folder = document.createElement('span');
  folder.className = 'doc-folder';
  folder.id = 'doc-folder';
  folder.hidden = true;
  const folderText = document.createElement('span');
  folderText.dir = 'ltr';
  folder.append(folderText);
  titleBar.append(fileLabel, dot, folder);
  let documentPath: string | null = null;
  const repaintFolder = () => {
    const where = documentPath ? documentPath.slice(0, documentPath.lastIndexOf('/')) || '/' : null;
    const text = where ? tilde(where) : fm.dir?.name ?? '';
    if (folderText.textContent !== text) folderText.textContent = text;
    folder.title = where ?? '';
    folder.hidden = !text;
  };

  // The rail: the tools in groups under hairlines, scrolling as one when
  // the window is short; Document settings and the view switch pinned
  // below them, as Zen pins its bottom icons, so a short window only
  // ever cuts tools.
  rail.setAttribute('aria-label', 'Document tools');
  const railGroups = document.createElement('div');
  railGroups.className = 'tb-rail-groups';
  const railFoot = document.createElement('div');
  railFoot.className = 'tb-rail-foot';
  rail.append(railGroups, railFoot);
  const railGroup = (name: string) => {
    if (railGroups.childElementCount) {
      const rule = document.createElement('div');
      rule.className = 'tb-rule';
      rule.setAttribute('role', 'separator');
      railGroups.append(rule);
    }
    const group = document.createElement('div');
    group.className = 'tb-rail-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', name);
    railGroups.append(group);
    return group;
  };
  const textGroup = railGroup('Text');
  const insertGroup = railGroup('Insert');
  const blocksGroup = railGroup('Blocks');
  const moreGroup = railGroup('More');
  // A short window cuts the groups: a fade at the cut edge says the rest
  // is a scroll away (toolbar.css). Read on scroll and resize only.
  const railCue = () => {
    const { scrollTop, scrollHeight, clientHeight } = railGroups;
    railGroups.classList.toggle('tb-more-above', scrollTop > 1);
    railGroups.classList.toggle('tb-more-below', scrollTop + clientHeight < scrollHeight - 1);
  };
  railGroups.addEventListener('scroll', railCue, { passive: true });
  new ResizeObserver(railCue).observe(railGroups);

  let captionButton: HTMLButtonElement | null = null;
  const attachCaption = (button: HTMLButtonElement) => {
    const show = () => {
      captionButton?.classList.remove('tb-caption-active');
      captionButton = button;
      button.classList.add('tb-caption-active');
      const label = button.querySelector<HTMLElement>('.lbl');
      if (!label) return;
      // (Reads on hover or focus, never on the typing path.)
      if (button.closest('#rail')) {
        // A rail tile's caption sits to its right, fixed to the window:
        // the rail's groups scroll, and a scrolling box clips what hangs
        // out of it.
        const rect = button.getBoundingClientRect();
        label.style.top = `${rect.top + rect.height / 2}px`;
        label.style.left = `${rect.right + 12}px`;
        return;
      }
      const panelElement = button.closest<HTMLElement>('.tb-menu-extras');
      if (panelElement) {
        // A glyph in a flyout: the same rule as the rail — the caption
        // beside the panel, level with the glyph, covering no row of it;
        // above the glyph when the window has no room beside the panel.
        // The panel is the caption's containing block (toolbar.css).
        const panel = panelElement.getBoundingClientRect();
        const glyph = button.getBoundingClientRect();
        const originX = panel.left + panelElement.clientLeft;
        const originY = panel.top + panelElement.clientTop;
        const width = label.offsetWidth;
        if (panel.right + 8 + width <= window.innerWidth - 8) {
          label.style.left = `${panel.right + 8 - originX}px`;
          label.style.top = `${glyph.top + glyph.height / 2 - originY}px`;
          label.style.transform = 'translateY(-50%)';
        } else {
          const middle = Math.max(8 + width / 2, Math.min(glyph.left + glyph.width / 2, window.innerWidth - 8 - width / 2));
          label.style.left = `${middle - originX}px`;
          label.style.top = `${glyph.top - 6 - originY}px`;
          label.style.transform = 'translate(-50%, -100%)';
        }
        return;
      }
      label.style.marginLeft = '0px';
      const rect = label.getBoundingClientRect();
      const shift = Math.max(0, 8 - rect.left) - Math.max(0, rect.right - (window.innerWidth - 8));
      if (shift) label.style.marginLeft = `${shift}px`;
    };
    const hide = () => {
      button.classList.remove('tb-caption-active');
      if (captionButton === button) captionButton = null;
    };
    button.addEventListener('mouseenter', show);
    button.addEventListener('focus', show);
    button.addEventListener('mouseleave', hide);
    button.addEventListener('blur', hide);
  };
  const glyphButton = (parent: HTMLElement, name: string, glyph: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tb-btn';
    button.setAttribute('aria-label', name);
    button.title = name;
    button.innerHTML = `${glyph}<span class="lbl">${name}</span>`;
    attachCaption(button);
    button.addEventListener('mousedown', (e) => e.preventDefault());
    parent.append(button);
    return button;
  };
  const trigger = (parent: HTMLElement, name: string, glyph: string) => {
    const button = glyphButton(parent, name, glyph);
    button.classList.add('tb-menu-trigger');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    return button;
  };
  // The bar, left to right: File, the name, History (Plass.app, below),
  // Export — the paper's way in and out, beside the traffic lights.
  const fileBtn = trigger(container, 'File', icon('open'));
  fileBtn.classList.add('tb-tile');
  container.append(titleBar);
  const exportBtn = trigger(container, 'Export', icon('download'));
  exportBtn.classList.add('tb-tile');
  exportBtn.title = 'Export — PDF, .md, .typ, .tex';
  // The rail, top to bottom, in the bar's old groups; the Blocks, once a
  // row inside Extras, are tiles of their own.
  const formatBtn = trigger(textGroup, 'Headings', '<span class="ico tico">H1</span>');
  const styleBtn = trigger(textGroup, 'Text style', '<span class="ico tico"><b>B</b></span>');
  const listBtn = trigger(textGroup, 'Lists', icon('list'));
  const figureBtn = glyphButton(insertGroup, 'Insert figure', icon('image'));
  const mathBtn = glyphButton(insertGroup, 'Inline math', '<span class="ico tico">Σ</span>');
  const noteBtn = glyphButton(insertGroup, 'Footnote', '<span class="ico tico">†</span>');
  const insertBtn = trigger(insertGroup, 'Insert', icon('plus'));
  insertBtn.title = 'Insert — table, grid, display equation, title block, page break';
  const extrasBtn = trigger(moreGroup, 'Extras', '<span class="ico tico">⋯</span>');
  const settingsBtn = glyphButton(railFoot, 'Document settings', icon('sliders'));
  // The formatting tools rest while the text is the truth (the Blocks
  // tiles rest through their own refresh, below).
  for (const button of [formatBtn, styleBtn, listBtn, figureBtn, mathBtn, noteBtn]) button.classList.add('tb-rests');
  const sourceBtn = document.createElement('button');
  sourceBtn.type = 'button';
  sourceBtn.className = 'tb-btn tb-source view-switch';
  sourceBtn.setAttribute('aria-label', 'Plain text view');
  sourceBtn.setAttribute('aria-pressed', 'false');
  sourceBtn.title = 'Switch to plain text (⌘/)';
  sourceBtn.innerHTML = `${icon('code')}<span class="lbl view-switch-label" aria-hidden="true">Plain text</span>`;
  attachCaption(sourceBtn);
  sourceBtn.addEventListener('mousedown', (e) => e.preventDefault());
  sourceBtn.addEventListener('click', () => { closeMenu(); actions.toggleSource(); });
  railFoot.append(sourceBtn);
  // The tiles swallow mousedown (the editor keeps its selection), so a
  // mouse click moves no focus: a tile that Escape handed the focus back
  // to would keep its ring and its caption beside the panel the click
  // opened. A click on a tile lets that other tile go first.
  for (const frame of [container, rail]) {
    frame.addEventListener('click', (e) => {
      const clicked = (e.target as Element).closest('.tb-btn');
      const held = document.activeElement;
      if (e.detail > 0 && clicked && held !== clicked && held instanceof HTMLElement && held.matches('#toolbar .tb-btn, #rail .tb-btn')) held.blur();
    }, true);
  }
  settingsBtn.addEventListener('click', () => { closeMenu(); toggleSettingsPanel(view, settingsBtn); });

  interface Menu {
    element: HTMLElement;
    anchor: HTMLButtonElement;
    parent?: Menu;
    refresh?: () => void;
  }
  let openMenu: Menu | null = null;
  let sourceActive = false;
  const closeMenu = (restoreFocus = false) => {
    if (!openMenu) return;
    const { element, anchor } = openMenu;
    element.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    openMenu = null;
    if (restoreFocus) anchor.focus({ preventScroll: true });
  };
  const menuButtons = (menu: Menu) =>
    [...menu.element.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([hidden])')]
      .filter((button) => !button.closest('[hidden]'));
  const showMenu = (menu: Menu, focus = false) => {
    closeMenu();
    menu.refresh?.();
    openMenu = menu;
    menu.element.hidden = false;
    menu.anchor.setAttribute('aria-expanded', 'true');
    menu.anchor.setAttribute('aria-controls', menu.element.id);
    // Read geometry only when a menu opens, never on the typing path.
    if (menu.anchor.closest('#rail')) placeFlyout(menu.element, menu.anchor);
    else {
      // A dropdown: under its tile in the bar.
      const rect = menu.anchor.getBoundingClientRect();
      const { style } = menu.element;
      const top = rect.bottom + 10;
      style.top = `${top}px`;
      style.maxHeight = `${Math.max(80, window.innerHeight - top - 8)}px`;
      style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.element.offsetWidth - 8))}px`;
    }
    if (focus) menuButtons(menu)[0]?.focus();
  };
  const createMenu = (name: string, anchor: HTMLButtonElement, parent?: Menu): Menu => {
    const element = document.createElement('div');
    element.id = `tb-menu-${name.toLowerCase().replaceAll(' ', '-')}`;
    element.className = 'tb-menu';
    element.setAttribute('role', 'menu');
    element.setAttribute('aria-label', name);
    element.hidden = true;
    document.body.append(element);
    const menu = { element, anchor, parent };
    if (!parent) {
      anchor.setAttribute('aria-controls', element.id);
      anchor.addEventListener('click', () => {
        if (openMenu?.anchor === anchor) closeMenu(true);
        else showMenu(menu, true);
      });
      // A rail tile's flyout also opens to the right (ArrowLeft, below,
      // closes it).
      const flyout = !!anchor.closest('#rail');
      anchor.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (flyout && e.key === 'ArrowRight')) {
          e.preventDefault();
          e.stopPropagation();
          showMenu(menu, true);
          if (e.key === 'ArrowUp') menuButtons(menu).at(-1)?.focus();
        }
      });
    }
    return menu;
  };
  const format = createMenu('Headings', formatBtn);
  const textStyle = createMenu('Text style', styleBtn);
  const lists = createMenu('Lists', listBtn);
  const insert = createMenu('Insert', insertBtn);
  insert.element.classList.add('tb-menu-extras');
  const extras = createMenu('Extras', extrasBtn);
  extras.element.classList.add('tb-menu-extras');
  const fileMenu = createMenu('File', fileBtn);
  const exports = createMenu('Export', exportBtn);
  const recent = createMenu('Recent', fileBtn, fileMenu);
  const get = createMenu('Get Plass', fileBtn, fileMenu);

  document.addEventListener('mousedown', (e) => {
    if (openMenu && !openMenu.element.contains(e.target as Node) && !openMenu.anchor.contains(e.target as Node)) closeMenu();
  }, true);
  window.addEventListener('resize', () => closeMenu());
  document.addEventListener('keydown', (e) => {
    if (!openMenu) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (e.key === 'Tab') {
      closeMenu(true);
      return;
    }
    if (!openMenu.element.contains(e.target as Node) && e.target !== openMenu.anchor) return;
    const buttons = menuButtons(openMenu);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    // The glyph rows (Extras, Insert) walk sideways with the arrows.
    const horizontal = openMenu.element.classList.contains('tb-menu-extras') && ['ArrowLeft', 'ArrowRight'].includes(e.key);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || horizontal) {
      e.preventDefault();
      const previous = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
        : (index + (previous ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (e.key === 'ArrowLeft' && openMenu.parent) {
      e.preventDefault();
      const childId = openMenu.element.id;
      const parent = openMenu.parent;
      showMenu(parent);
      parent.element.querySelector<HTMLButtonElement>(`[aria-controls="${childId}"]`)?.focus();
    } else if (e.key === 'ArrowLeft' && openMenu.anchor.closest('#rail')) {
      // Back into the rail, the way the flyout came.
      e.preventDefault();
      closeMenu(true);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== ' ') {
      const ordered = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)];
      const match = ordered.find((button) => (button.getAttribute('aria-label') ?? button.textContent)?.trim().toLowerCase().startsWith(e.key.toLowerCase()));
      if (match) { e.preventDefault(); match.focus(); }
    }
  });

  type ItemOptions = {
    title?: string;
    shortcut?: string;
    checked?: () => boolean;
    enabled?: () => boolean;
    submenu?: Menu;
    editing?: boolean;
    glyph?: string;
    /** A rail tile rather than a menu item: a plain button, pressed rather
     *  than checked, refreshed on every state change, not only while a
     *  menu is open. */
    tile?: boolean;
  };
  const refreshItems: Array<() => void> = [];
  const refreshTiles: Array<() => void> = [];
  // Written only on change: the tiles refresh on the typing path, and a
  // same-value write is still a mutation the chrome must not publish.
  const setAttr = (element: HTMLElement, name: string, value: string) => {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  const item = (parent: HTMLElement, label: string, run: () => void, options: ItemOptions = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = options.tile ? 'tb-btn' : 'tb-menu-item';
    if (!options.tile) {
      button.tabIndex = -1;
      button.setAttribute('role', options.checked ? 'menuitemcheckbox' : 'menuitem');
    }
    button.title = options.title ?? label;
    const text = document.createElement('span');
    text.className = options.glyph ? 'lbl' : 'tb-menu-label';
    text.textContent = label;
    if (options.glyph) {
      button.classList.add('tb-btn');
      button.setAttribute('aria-label', label);
      button.innerHTML = options.glyph;
    }
    button.append(text);
    if (options.glyph) attachCaption(button);
    if (!options.glyph && (options.shortcut || options.submenu)) {
      const shortcut = document.createElement('kbd');
      shortcut.textContent = options.shortcut ?? '›';
      shortcut.setAttribute('aria-hidden', 'true');
      button.append(shortcut);
    }
    if (options.submenu) {
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-controls', options.submenu.element.id);
      button.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          showMenu(options.submenu!, true);
        }
      });
    }
    // The editor's model selection survives pointer and keyboard use.
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      if (options.submenu) showMenu(options.submenu, true);
      else {
        closeMenu(!options.tile);
        run();
      }
    });
    if (options.checked || options.enabled || options.editing) {
      const refresh = () => {
        if (options.checked) setAttr(button, options.tile ? 'aria-pressed' : 'aria-checked', String(options.checked()));
        const disabled = !!(options.editing && sourceActive) || !!(options.enabled && !options.enabled());
        if (button.disabled !== disabled) button.disabled = disabled;
      };
      (options.tile ? refreshTiles : refreshItems).push(refresh);
      refresh();
    }
    parent.append(button);
    return button;
  };
  const divider = (parent: HTMLElement) => {
    const div = document.createElement('div');
    div.className = 'tb-menu-divider';
    div.setAttribute('role', 'separator');
    parent.append(div);
  };
  const heading = (parent: HTMLElement, label: string) => {
    const div = document.createElement('div');
    div.className = 'tb-menu-heading';
    div.textContent = label;
    div.setAttribute('role', 'presentation');
    parent.append(div);
  };
  const refresh = () => refreshItems.forEach((update) => update());
  const refreshRail = () => refreshTiles.forEach((update) => update());
  format.refresh = refresh;
  textStyle.refresh = refresh;
  lists.refresh = refresh;
  insert.refresh = refresh;
  extras.refresh = refresh;
  const runCmd = (command: Command) => () => {
    command(view.state, view.dispatch, view);
    view.focus();
  };
  const commandItem = (parent: HTMLElement, label: string, command: Command, options: ItemOptions = {}) =>
    item(parent, label, runCmd(command), { editing: true, enabled: () => command(view.state), ...options });
  const ancestor = (...names: string[]) => {
    const { $from } = view.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if (names.includes($from.node(depth).type.name)) return $from.node(depth);
    }
    return null;
  };
  const extraGroup = (menu: Menu, name: string) => {
    const group = document.createElement('div');
    group.className = 'tb-extra-section';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', name);
    const label = document.createElement('span');
    label.className = 'tb-extra-heading';
    label.textContent = name;
    const row = document.createElement('div');
    row.className = 'tb-extra-row';
    group.append(label, row);
    menu.element.append(group);
    return row;
  };
  const insertRow = extraGroup(insert, 'Insert');
  const alignmentRow = extraGroup(extras, 'Alignment');
  const codeRow = extraGroup(extras, 'Code');
  const documentRow = extraGroup(extras, 'Document');
  const textColumn = format.element;
  for (const level of [null, 1, 2, 3]) {
    const command = level ? setBlockType(schema.nodes.heading, { level }) : setBlockType(schema.nodes.paragraph);
    const current = () => {
      const node = view.state.selection.$from.parent;
      return level ? node.type === schema.nodes.heading && node.attrs.level === level : node.type === schema.nodes.paragraph;
    };
    commandItem(textColumn, level ? `Heading ${level}` : 'Body text', command, {
      title: level ? `Heading ${level} (⌘⌥${level})` : 'Body text (⌘⌥0)',
      shortcut: `⌘⌥${level ?? 0}`,
      checked: current,
      // The already-selected style remains available and visibly checked.
      enabled: () => command(view.state) || current(),
    });
  }
  for (const [name, label, shortcut, title] of [
    ['strong', 'Bold', '⌘B', 'Bold (⌘B) — or type **text**'],
    ['em', 'Italic', '⌘I', 'Italic (⌘I) — or type *text*'],
    ['strike', 'Strikethrough', '⌘⇧X', 'Strikethrough (⌘⇧X) — or type ~~text~~'],
  ]) {
    const mark = schema.marks[name];
    commandItem(textStyle.element, label, toggleMark(mark), {
      title, shortcut,
      checked: () => {
        const { selection, storedMarks, doc } = view.state;
        return selection.empty ? !!mark.isInSet(storedMarks ?? selection.$from.marks()) : doc.rangeHasMark(selection.from, selection.to, mark);
      },
    });
  }

  const selectedParagraphs = () => {
    const { state } = view;
    const { from, to } = state.selection;
    const paragraphs: Array<{ node: PMNode; pos: number }> = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === schema.nodes.paragraph && state.doc.resolve(pos).depth === 0) {
        paragraphs.push({ node, pos });
        return false;
      }
      return true;
    });
    return paragraphs;
  };
  const setAlign = (align: 'center' | 'right' | null) => {
    let tr = view.state.tr;
    for (const { node, pos } of selectedParagraphs()) {
      if ((node.attrs.align ?? null) !== align) tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, align });
    }
    if (tr.steps.length) view.dispatch(tr);
    view.focus();
  };
  const alignmentEnabled = () => selectedParagraphs().length > 0;
  for (const [label, align, title] of [
    ['Justified', null, 'Align left (justified body text)'],
    ['Center', 'center', 'Center text'],
    ['Right', 'right', 'Align right'],
  ] as const) {
    item(alignmentRow, label, () => setAlign(align), {
      title, editing: true, enabled: alignmentEnabled,
      glyph: icon(align === 'center' ? 'aligncenter' : align === 'right' ? 'alignright' : 'alignleft'),
      checked: () => alignmentEnabled() && selectedParagraphs().every(({ node }) => (node.attrs.align ?? null) === align),
    });
  }
  commandItem(lists.element, 'Bulleted list', wrapInList(schema.nodes.bullet_list), {
    title: 'Bulleted list (⌘⇧8) — or type - at a line start', shortcut: '⌘⇧8',
  });
  commandItem(lists.element, 'Numbered list', wrapInList(schema.nodes.ordered_list), {
    title: 'Numbered list (⌘⇧9) — or type 1. at a line start', shortcut: '⌘⇧9',
  });
  commandItem(lists.element, 'Loose list spacing', toggleListSpacing, {
    title: 'Item spacing (⌘⇧7) — tight, or loose with paragraph spacing between items', shortcut: '⌘⇧7',
    checked: () => ancestor('bullet_list', 'ordered_list')?.attrs.tight === false,
  });
  const setBlockKind = (kind: 'solution' | null) => {
    const { state } = view;
    const { $from, $to } = state.selection;
    for (let d = $from.sharedDepth($to.pos); d > 0; d--) {
      const node = $from.node(d);
      if (node.type === schema.nodes.blockquote) {
        if ((node.attrs.kind ?? null) !== kind) view.dispatch(state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, kind }));
        view.focus();
        return;
      }
    }
    wrapIn(schema.nodes.blockquote, { kind })(state, view.dispatch);
    view.focus();
  };
  item(blocksGroup, 'Block quote', () => setBlockKind(null), {
    title: 'Block quote (⌃>) — or type > at a line start', editing: true, tile: true,
    glyph: icon('quote'),
    checked: () => !!ancestor('blockquote') && !ancestor('blockquote')!.attrs.kind,
  });
  item(blocksGroup, 'Solution', () => setBlockKind('solution'), {
    title: 'Solution block — red text with a red rule on the left', editing: true, tile: true,
    glyph: icon('solution'),
    checked: () => ancestor('blockquote')?.attrs.kind === 'solution',
  });
  commandItem(blocksGroup, 'Comment', insertEditorComment, {
    title: 'Editorial comment — a note on the page and in the file, never printed',
    glyph: icon('comment'), tile: true,
  });
  commandItem(blocksGroup, 'Remove quote', lift, {
    title: 'Plain body text — lift out of the quote or solution block',
    glyph: icon('paragraph'), tile: true,
    enabled: () => !!ancestor('blockquote') && lift(view.state),
  });

  const directCommand = (button: HTMLButtonElement, command: Command, title: string) => {
    button.title = title;
    button.addEventListener('click', () => { closeMenu(); runCmd(command)(); });
  };
  directCommand(figureBtn, insertFigureCmd, 'Insert figure (⌘⌥I) — or paste/drop an image');
  directCommand(mathBtn, insertMath(false), 'Inline math (⌘M) — or type $x^2$; ⌘⇧M for display');
  directCommand(noteBtn, insertFootnote, 'Footnote (⌘⌥F) — or type ^[');
  item(insertRow, 'Table', () => insertStructuredTable(view), { title: 'Insert table (⌘⌥T)', shortcut: '⌘⌥T', editing: true, glyph: icon('table') });
  item(insertRow, 'Grid', () => insertGrid(view), { title: 'Side-by-side grid — any blocks in columns; the grid bar sets the split', editing: true, glyph: icon('grid') });
  commandItem(insertRow, 'Display equation', insertMath(true), { title: 'Display equation (⌘⇧M)', shortcut: '⌘⇧M', glyph: '<span class="ico tico">∑</span>' });
  item(insertRow, 'Title block', () => {
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
      schema.nodes.abstract.create(null, [schema.nodes.paragraph.create(null, [schema.text('Abstract text.')])]),
    ];
    let tr = state.tr.insert(0, nodes);
    tr = tr.setSelection(TextSelection.create(tr.doc, 1, 1 + 'Title'.length));
    dispatch(tr.scrollIntoView());
    view.focus();
  }, { title: 'Title block — title, authors, date, abstract', editing: true, glyph: '<span class="ico tico">T</span>' });
  item(insertRow, 'Page break', () => {
    const { state, dispatch } = view;
    const { $from } = state.selection;
    const pos = $from.after($from.depth > 0 ? 1 : 0);
    dispatch(state.tr.insert(pos, schema.nodes.page_break.create()).scrollIntoView());
    view.focus();
  }, { title: 'Page break (⌘⏎)', shortcut: '⌘⏎', editing: true, glyph: icon('pagebreak') });
  commandItem(codeRow, 'Code block', setBlockType(schema.nodes.code_block, { params: '' }), {
    title: 'Code block — monospaced source listing', glyph: icon('code'),
  });
  commandItem(codeRow, 'Raw Typst block', setBlockType(schema.nodes.code_block, { params: 'typst-raw' }), {
    title: 'Raw Typst block — kept in the file as Typst, shown and printed as code, never run', glyph: '<span class="ico tico">#</span>',
  });
  item(codeRow, 'Inline raw Typst', () => void import('./inline-raw').then(({ insertTypstInline }) => insertTypstInline(view)), {
    title: 'Inline raw Typst — kept in the file verbatim, shown and printed as inline code, never run', editing: true,
    glyph: '<span class="ico tico">#·</span>',
  });
  item(documentRow, 'Bibliography', () => editBibliography(view, (m) => fm.notify(m)), {
    title: 'Edit bibliography', enabled: () => !sourceActive, glyph: icon('book'),
  });
  item(fileMenu.element, 'New document', () => {
    const url = new URL(location.href);
    url.searchParams.set('new', '1');
    window.open(url.toString(), '_blank');
  }, { title: 'New document — opens in a new window' });
  item(fileMenu.element, 'Open…', () => void fm.open(), { title: 'Open… (⌘O)', shortcut: '⌘O' });
  item(fileMenu.element, 'Recent papers', () => {}, { title: 'Your papers', submenu: recent });
  item(fileMenu.element, 'Save', () => void fm.save(), { shortcut: '⌘S' });
  // Plass.app: the shell's History page, the record of this document's
  // folder with a rewind to any point of it, in this window's room — the
  // panel that is the paper (#scroll), under the bar and right of the
  // rail — not a window of its own (Taylor, 2026-10-02: "instead of a new
  // window, i just want it to open in the same window in the main
  // area"). Three ways in, one toggle: the History tile in the bar right
  // after the name pill ("i think it belongs as a tile on the topbar
  // beside the address", a bar tile like File, with the same river glyph
  // as Knuth's), this item, and the shell's View › History… (⇧⌘H, the
  // shell's menu takes the keys), which asks the page to do what the tile
  // does (`toggle`), since the room's box is the page's to send. The shell
  // lays its page over the box and says when it comes and goes (Escape and
  // the page's own close tile put it away too, and a reload of this page);
  // the tile is pressed exactly while it is up, from that word alone,
  // never from the click. While it is up the room is measured again
  // whenever its box changes — a resize of the window, the scroll rail's
  // gutter coming or going (the panel's right edge, 8 px or 20 px), a zoom
  // step — and the shell moves the page to it. The document stays loaded
  // underneath, hidden (style.css, .history-inline: the page's rounded
  // corners show the frame, not the paper), so a rewind's save and reload
  // reach it as ever. A document with no record gets the page saying why;
  // a shell from before the room (0.2.1, 0.2.2) opens its History window
  // instead, as it did; a shell without the view answers null, and the
  // item and the tile go.
  if (isNativeShell()) {
    const historyTile = glyphButton(container, 'History', HISTORY_GLYPH);
    historyTile.id = 'history-tile';
    historyTile.classList.add('tb-tile');
    historyTile.title = 'History (⇧⌘H)';
    historyTile.setAttribute('aria-keyshortcuts', 'Shift+Meta+H');
    historyTile.setAttribute('aria-pressed', 'false');
    titleBar.after(historyTile);
    const ways: HTMLElement[] = [historyTile];
    const room = document.getElementById('scroll')!;
    const roomBox = () => {
      const r = room.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    let shown = false;
    const showHistory = () => {
      if (shown) {
        closeHistory();
        return;
      }
      void openHistory(roomBox()).then((how) => {
        if (how) return;
        for (const way of ways) way.hidden = true;
        fm.notify('This Plass.app has no history view — File → Check for updates…');
      });
    };
    onHistoryView((event) => {
      if (event.kind === 'toggle') {
        closeMenu();
        showHistory();
        return;
      }
      if (event.open === shown) return;
      shown = event.open;
      historyTile.setAttribute('aria-pressed', String(shown));
      document.documentElement.classList.toggle('history-inline', shown);
      // Back from the record: the caret where it was, for typing on. The
      // shell gives the window's page its focus back; the editor lost it
      // when the paper was hidden.
      if (!shown && (document.activeElement === document.body || view.dom.contains(document.activeElement))) view.focus();
    });
    // The room's box, again whenever it changes while the page is in it,
    // once a frame. A size change is what moves it: the room's top and
    // left are the bar's and the rail's, fixed.
    let frame = 0;
    const follow = () => {
      if (!shown || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (shown) moveHistory(roomBox());
      });
    };
    new ResizeObserver(follow).observe(room);
    // A zoom step changes the CSS px → DIP the shell multiplies the box
    // by; under followZoom (app/plass.json) the window scales with it, so
    // the box in CSS px may not change at all. A change of the device
    // pixel ratio is the step.
    const zoomStep = () => {
      matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => {
        follow();
        zoomStep();
      }, { once: true });
    };
    zoomStep();
    // The page is the shell's, above everything this one draws in the
    // room, so whatever opens or acts there puts it away first, as Knuth's
    // bar does: the File and Export tiles (their menus drop over the room)
    // and the rail (its tiles edit the paper under the page; its flyouts
    // and Document settings open over the room). On the press, before the
    // click opens anything, and on the keys that press a tile or open its
    // menu, for a bar the focus came back to. The History tile is the
    // toggle itself; the HUD and the scroll rail are hidden while the page
    // is up (style.css), so they open nothing.
    const putAway = () => { if (shown) closeHistory(); };
    const presses = (e: KeyboardEvent) => e.key === 'Enter' || e.key === ' '
      || (['ArrowDown', 'ArrowUp', 'ArrowRight'].includes(e.key) && (e.target as Element).classList.contains('tb-menu-trigger'));
    for (const way of [fileBtn, exportBtn, rail]) {
      way.addEventListener('pointerdown', putAway, true);
      way.addEventListener('keydown', (e) => { if (presses(e)) putAway(); }, true);
    }
    historyTile.addEventListener('click', () => { closeMenu(); showHistory(); });
    ways.push(item(fileMenu.element, 'History…', showHistory, { shortcut: '⇧⌘H', title: 'The record of this document\u2019s folder, and a rewind to any point of it (⇧⌘H)' }));
  }
  item(documentRow, 'Markdown & shortcuts', () => showHelp(fm), { title: 'Markdown & shortcuts', glyph: '<span class="ico tico">?</span>' });
  const installButton = item(documentRow, 'Install Plass', () => void requestPwaInstall((message) => fm.notify(message)), {
    title: 'Install Plass as an app', glyph: icon('install'),
  });
  installButton.classList.add('pwa-install');
  installButton.setAttribute('aria-label', 'Install Plass');
  installButton.hidden = isNativeShell() || isPwaInstalled();
  onPwaInstallState((installed) => { installButton.hidden = isNativeShell() || installed; });
  // The Mac app, from a browser tab on a Mac: every deploy publishes it
  // beside this page, so the download and the install line are this
  // page's version. Inside Plass.app there is nothing to get.
  const mac = /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2;
  if (mac && !isNativeShell()) {
    divider(fileMenu.element);
    item(fileMenu.element, 'Get Plass for your Mac', () => {}, { title: 'Plass.app: the download, or the install line', submenu: get });
  }
  // Inside Plass.app: the app updating itself (the shell's update.js;
  // also Plass menu → Check for Updates…). The shell looks at the site
  // after launch and says when it has a newer build; the item then offers
  // the install, whose steps show as notices until the app relaunches.
  if (isNativeShell()) {
    divider(fileMenu.element);
    let offered: string | null = null;
    const updateItem = item(fileMenu.element, 'Check for updates…', () => {
      if (offered) {
        setLabel('Updating…');
        installUpdate();
        return;
      }
      setLabel('Checking…');
      void checkForUpdate().then((step) => {
        const when = step?.latest?.built ? ` (built ${step.latest.built.slice(0, 10)})` : '';
        if (step?.state === 'available') {
          offered = step.latest?.build ?? 'new';
          setLabel(`Install update${when}`);
          fm.notify(`A new Plass is available${when} — File → Install update`);
        } else {
          setLabel('Check for updates…');
          if (step?.state === 'current') fm.notify(`Plass is up to date${step.current?.build ? ` (build ${step.current.build})` : ''}`);
          else if (step?.state === 'development') fm.notify('Running from a checkout: nothing to update');
          else fm.notify(step?.text ? `Could not check for updates: ${step.text}` : 'Could not check for updates');
        }
      });
    }, { title: 'Plass.app: compare this build with the site\u2019s and install a newer one' });
    const label = updateItem.querySelector('.tb-menu-label');
    const setLabel = (text: string) => { if (label) label.textContent = text; };
    onUpdate((step) => {
      const when = step.latest?.built ? ` (built ${step.latest.built.slice(0, 10)})` : '';
      switch (step.state) {
        case 'available':
          offered = step.latest?.build ?? 'new';
          setLabel(`Install update${when}`);
          break;
        case 'downloading':
        case 'unpacking':
        case 'completing':
        case 'installing':
          setLabel('Updating…');
          if (step.text) fm.notify(step.text);
          break;
        case 'ready':
          setLabel('Relaunching…');
          fm.notify(step.text ?? 'Plass relaunches now');
          break;
        case 'failed':
          setLabel(offered ? `Install update${when}` : 'Check for updates…');
          fm.notify(`Could not update Plass: ${step.text ?? 'unknown error'}`);
          break;
        default:
          break;
      }
    });
  }

  const back = (menu: Menu) => {
    item(menu.element, '‹ File', () => showMenu(fileMenu, true));
    divider(menu.element);
  };
  heading(exports.element, 'Export');
  const exportPdfNow = () => {
    void import('./pdf').then(({ exportPdf }) =>
      exportPdf(
        fm.currentDoc(),
        fm.name,
        (m) => fm.notify(m),
        (name, blob) => fm.saveBeside(name, blob),
        (m) => fm.notifyAction(m, { label: 'Try again', run: exportPdfNow }),
      ),
    );
  };
  item(exports.element, 'PDF', exportPdfNow, { title: 'Export PDF via Typst' });
  item(exports.element, 'Markdown (.md)', () => void fm.exportMdCopy(), { title: 'Export a .md copy' });
  item(exports.element, 'Typst (.typ)', () => void fm.exportCopy(), { title: 'Export a .typ copy' });
  item(exports.element, 'LaTeX (.tex)', () => fm.exportTexCopy(), { title: 'Export a .tex copy (vanilla LaTeX for journals)' });
  back(get);
  heading(get.element, 'Plass for your Mac');
  const getHint = (text: string) => {
    const hint = document.createElement('div');
    hint.className = 'tb-menu-hint';
    hint.textContent = text;
    get.element.append(hint);
  };
  getHint('Opens .typ and .md from Finder and works offline. For Macs with Apple silicon; macOS 13 or later.');
  item(get.element, 'Download Plass.app', () => window.open(APP_ZIP, '_blank', 'noopener'), {
    title: 'Download Plass.app (a zip; unzip and drag to Applications)',
  });
  getHint('Unzip and drag to Applications. The first launch is refused once because the app is not signed with Apple: in System Settings → Privacy & Security click Open Anyway. It then gets Electron, the window it runs in — shared with Knuth if you have it, else a 130 MB download, once.');
  item(get.element, 'Copy the install line', () => {
    void navigator.clipboard.writeText(APP_LINE).then(
      () => fm.notify('Install line copied — paste it in Terminal'),
      () => fm.notify(APP_LINE),
    );
  }, { title: 'The terminal way: no Gatekeeper prompt, and the same line updates' });
  getHint(APP_LINE);
  divider(get.element);
  const pwaItem = item(get.element, 'Install this page as an app', () => void requestPwaInstall((message) => fm.notify(message)), {
    title: 'Install Plass from the browser (a window without the browser’s chrome; still the browser)',
  });
  onPwaInstallState((installed) => { pwaItem.hidden = installed; });
  back(recent);
  heading(recent.element, 'Recent papers');
  const recentEntries = document.createElement('div');
  recentEntries.setAttribute('role', 'group');
  recentEntries.setAttribute('aria-label', 'Recent papers');
  recent.element.append(recentEntries);
  divider(recent.element);
  item(recent.element, 'Open project folder…', () => void fm.openFolder('open'));
  let recentRequest = 0;
  recent.refresh = () => {
    const request = ++recentRequest;
    const hint = document.createElement('div');
    hint.className = 'tb-menu-hint';
    hint.textContent = 'Loading recent papers…';
    hint.setAttribute('role', 'status');
    recentEntries.replaceChildren(hint);
    void fm.recents().then((entries) => {
      if (request !== recentRequest) return;
      if (!entries.length) hint.textContent = 'Your saved papers will appear here.';
      else {
        recentEntries.replaceChildren();
        for (const entry of entries.slice(0, 8)) item(recentEntries, entry.name, () => void fm.openRecent(entry));
      }
    }).catch(() => {
      if (request === recentRequest) hint.textContent = 'Recent papers could not be loaded.';
    });
  };

  return {
    update() {
      // The rail's tiles show the selection's state at all times; a menu's
      // items only while it is open.
      refreshRail();
      if (openMenu) refresh();
    },
    stats() {},
    setSourceMode(active) {
      sourceActive = active;
      closeMenu();
      sourceBtn.setAttribute('aria-pressed', String(active));
      sourceBtn.title = active ? 'Switch to paper (⌘/)' : 'Switch to plain text (⌘/)';
      sourceBtn.querySelector('.view-switch-label')!.textContent = active ? 'Paper' : 'Plain text';
      settingsBtn.disabled = active;
      for (const button of rail.querySelectorAll<HTMLButtonElement>('.tb-rests')) button.disabled = active;
      refreshRail();
      refresh();
    },
    setFile(name, dirty) {
      const unsaved = !fm.saved || dirty;
      titleBar.classList.toggle('doc-saved', !unsaved);
      titleBar.classList.toggle('doc-unsaved', unsaved);
      if (!fileLabel.isContentEditable) fileLabel.textContent = name;
      fileLabel.setAttribute('aria-label', `${name} — ${unsaved ? 'unsaved' : 'saved'}; rename document`);
      if (!fm.saved) fileLabel.title = 'Click to name and save — you pick the folder your paper lives in';
      else fileLabel.title = dirty ? `${name} — unsaved changes` : `${name} — click to rename`;
      dot.title = !fm.saved ? 'Not saved yet — ⌘S picks its folder' : dirty ? 'Unsaved changes' : 'Saved';
      repaintFolder();
    },
    setPath(path) {
      documentPath = path;
      repaintFolder();
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
