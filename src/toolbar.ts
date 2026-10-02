// Zen's shape: the paper's way in and out in the bar beside the traffic
// lights (File, the name with its save dot, Export), the tools on a rail
// down the left in the bar's old groups, the occasional ones behind Extras.
// Menus preserve the editor selection and keep geometry reads off typing.

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
import { checkForUpdate, installUpdate, isNativeShell, onUpdate } from './claerbout';
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

export function buildToolbar(container: HTMLElement, rail: HTMLElement, view: EditorView, fm: FileManager, actions: ToolbarActions): Toolbar {
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
  titleBar.className = 'doc-title';
  const dot = document.createElement('span');
  dot.className = 'doc-title-dot';
  dot.setAttribute('aria-hidden', 'true');
  titleBar.append(fileLabel, dot);

  // The rail: the tools in groups under hairlines, scrolling as one when
  // the window is short, the view switch pinned below them.
  rail.setAttribute('aria-label', 'Document tools');
  const railGroups = document.createElement('div');
  railGroups.className = 'tb-rail-groups';
  rail.append(railGroups);
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
  // The bar, left to right: File, the name, Export — the paper's way in
  // and out, beside the traffic lights.
  const fileBtn = trigger(container, 'File', icon('open'));
  fileBtn.classList.add('tb-tile');
  container.append(titleBar);
  const exportBtn = trigger(container, 'Export', icon('download'));
  exportBtn.classList.add('tb-tile');
  exportBtn.title = 'Export — PDF, .typ, .tex';
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
  const settingsBtn = glyphButton(moreGroup, 'Document settings', icon('sliders'));
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
  rail.append(sourceBtn);
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
