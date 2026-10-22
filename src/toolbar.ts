// Zen's shape: the paper's way in and out in the bar beside the traffic
// lights (Open with its recent papers, New window, the name with its save
// dot and folder — Knuth's bar — then, in Plass.app, History, and
// Export), the tools on a rail down the left in the bar's old groups, the
// occasional ones behind Extras. Menus preserve the editor selection and
// keep geometry reads off typing.

import './toolbar.css';
import { TextSelection } from 'prosemirror-state';
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { liftTarget } from 'prosemirror-transform';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { NodeRange, type Node as PMNode } from 'prosemirror-model';
import { wrapInList } from 'prosemirror-schema-list';
import { schema } from './schema';
import { cycleHeading, headingLevelAt, nextHeadingLevel, toggleListSpacing } from './editing';
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
import { closeHistory, installUpdate, isNativeShell, moveHistory, onHistoryView, onUpdate, openHistory } from './claerbout';
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
  /** Draw the paper two pages side by side, or stacked (paper-scale.ts). */
  toggleSpread: () => void;
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
  // A page, its corner folded, with a solid + badge at its foot: a new
  // document (Taylor, 2026-10-17; Knuth's and ManimLive's are the same).
  newwindow: '<path d="M12 21H7a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2h5.5L17 7v3.5"/><path d="M12.5 2.5V7H17"/><path fill="currentColor" stroke="none" fill-rule="evenodd" d="M22.5 17a5.5 5.5 0 1 1-11 0a5.5 5.5 0 1 1 11 0ZM16.15 13.9v2.25H13.9v1.7h2.25v2.25h1.7v-2.25h2.25v-1.7h-2.25V13.9Z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  list: '<circle cx="4" cy="6" r="1.2" fill="currentColor"/><circle cx="4" cy="12" r="1.2" fill="currentColor"/><circle cx="4" cy="18" r="1.2" fill="currentColor"/><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>',
  // ManimLive's chevron (maniml shell), 12 by 6: Taylor liked its size.
  chevron: '<path d="m6 9 6 6 6-6"/>',
  numlist: '<path d="M3 4.5 4.5 3.8V9"/><path d="M3.2 14.6c.3-.8 2.6-1 2.6.4 0 1-2.6 2-2.6 3.5h2.8"/><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/>',
  looselist: '<circle cx="4" cy="5" r="1.2" fill="currentColor"/><circle cx="4" cy="19" r="1.2" fill="currentColor"/><line x1="8" y1="5" x2="21" y2="5"/><line x1="8" y1="19" x2="21" y2="19"/><polyline points="12.5 9.5 14.5 7.8 16.5 9.5"/><polyline points="12.5 14.5 14.5 16.2 16.5 14.5"/>',
  // The rail's All tools switch: a panel with its side column and a
  // chevron pointing out of it.
  drawer: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/><polyline points="13.5 9.5 16 12 13.5 14.5"/>',
  // ManimLive's console glyph (maniml viewer), the code block's.
  terminal: '<path d="m5 8 4 4-4 4"/><path d="M12 16h7"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  // The block pill's (block-chrome.ts): a row or a column with a plus; a
  // cell as a 2 x 2 grid with one cell filled (not a square in a square,
  // which reads as a stop button); vertical alignment as a box against a
  // line; a bin.
  rows: '<rect x="3" y="4.5" width="18" height="6.5" rx="1.5"/><line x1="12" y1="14.5" x2="12" y2="20.5"/><line x1="9" y1="17.5" x2="15" y2="17.5"/>',
  cols: '<rect x="4.5" y="3" width="6.5" height="18" rx="1.5"/><line x1="14.5" y1="12" x2="20.5" y2="12"/><line x1="17.5" y1="9" x2="17.5" y2="15"/>',
  rowsabove: '<rect x="3" y="13" width="18" height="6.5" rx="1.5"/><line x1="12" y1="3.5" x2="12" y2="9.5"/><line x1="9" y1="6.5" x2="15" y2="6.5"/>',
  colsleft: '<rect x="13" y="3" width="6.5" height="18" rx="1.5"/><line x1="3.5" y1="12" x2="9.5" y2="12"/><line x1="6.5" y1="9" x2="6.5" y2="15"/>',
  delrow: '<rect x="3" y="4.5" width="18" height="6.5" rx="1.5"/><line x1="9.5" y1="15" x2="14.5" y2="20"/><line x1="14.5" y1="15" x2="9.5" y2="20"/>',
  delcol: '<rect x="4.5" y="3" width="6.5" height="18" rx="1.5"/><line x1="15" y1="9.5" x2="20" y2="14.5"/><line x1="20" y1="9.5" x2="15" y2="14.5"/>',
  merge: '<rect x="3" y="6" width="18" height="12" rx="2"/><polyline points="6.5 10 9 12 6.5 14"/><polyline points="17.5 10 15 12 17.5 14"/>',
  splitcell: '<rect x="3" y="6" width="18" height="12" rx="2"/><line x1="12" y1="6" x2="12" y2="18"/><polyline points="8.5 10 6.2 12 8.5 14"/><polyline points="15.5 10 17.8 12 15.5 14"/>',
  cell: '<path d="M12 12V3.5H5.5a2 2 0 0 0-2 2V12z" fill="currentColor" fill-opacity=".45" stroke="none"/><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><line x1="12" y1="3.5" x2="12" y2="20.5"/><line x1="3.5" y1="12" x2="20.5" y2="12"/>',
  valigntop: '<line x1="4" y1="4" x2="20" y2="4"/><rect x="8" y="7" width="8" height="10" rx="1.5"/>',
  valignmid: '<line x1="4" y1="12" x2="7" y2="12"/><line x1="17" y1="12" x2="20" y2="12"/><rect x="8" y="7" width="8" height="10" rx="1.5"/>',
  valignbot: '<line x1="4" y1="20" x2="20" y2="20"/><rect x="8" y="7" width="8" height="10" rx="1.5"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
};

/** A glyph from ICONS: 24 viewBox, stroke 1.7, round caps and joins. */
export function icon(name: string): string {
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
    // so otherwise the paper is born as Plass.md and can only be renamed
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
  // Save…, Knuth's chip at the pill's end (knuth/src/main.ts, #doc-save),
  // only while the paper has no file yet: Plass saves as you type once it
  // has one. It is ⌘S: the picker asks where the paper lives.
  const saveChip = document.createElement('button');
  saveChip.type = 'button';
  saveChip.className = 'doc-save';
  saveChip.id = 'doc-save';
  saveChip.textContent = 'Save…';
  saveChip.title = 'Save… — pick where it lives (⌘S)';
  saveChip.hidden = true;
  saveChip.addEventListener('mousedown', (e) => e.preventDefault());
  saveChip.addEventListener('click', () => void fm.save());
  titleBar.append(fileLabel, dot, folder, saveChip);
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
  // All tools at the top, under its own hairline, in the same place open
  // or shut, so the drawer closes where it opened.
  const railTop = document.createElement('div');
  railTop.className = 'tb-rail-top';
  rail.append(railTop, railGroups, railFoot);
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
      // The open drawer labels its rows itself: no caption beside them.
      if (button.closest('#rail') && document.documentElement.classList.contains('rail-open')) return;
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
  // The bar, left to right: Open, New window, the name, History (Plass.app,
  // below), Export — the paper's way in and out, beside the traffic lights.
  // Open is a split tile like Export: the folder half opens a paper (⌘O),
  // the chevron half lists the recent ones (Taylor, 2026-10-17, for every
  // Claerbout app; knuth/src/main.ts has the same tile). No Save anywhere:
  // Plass saves as you type, and ⌘S still saves (a first save asks for the
  // folder, as the name pill's rename does).
  const openSplit = document.createElement('span');
  openSplit.className = 'tb-split';
  openSplit.id = 'open-split';
  container.append(openSplit);
  const openBtn = glyphButton(openSplit, 'Open', icon('open'));
  openBtn.classList.add('tb-tile');
  openBtn.title = 'Open… (⌘O)';
  openBtn.setAttribute('aria-keyshortcuts', 'Meta+O');
  const recentBtn = trigger(openSplit, 'Recent papers', icon('chevron'));
  recentBtn.classList.add('tb-tile', 'tb-split-more');
  const newBtn = glyphButton(container, 'New window', icon('newwindow'));
  newBtn.classList.add('tb-tile');
  newBtn.id = 'new-window';
  newBtn.title = 'New window — a blank paper';
  container.append(titleBar);
  // Export is a split tile: the download half saves the PDF on one
  // click (⌘P, or ⌘E), the chevron half opens the other formats.
  const exportSplit = document.createElement('span');
  exportSplit.className = 'tb-split';
  exportSplit.id = 'export-split';
  container.append(exportSplit);
  const pdfBtn = glyphButton(exportSplit, 'Export PDF', icon('download'));
  pdfBtn.classList.add('tb-tile');
  pdfBtn.title = 'Export PDF (⌘P)';
  const exportBtn = trigger(exportSplit, 'Export', icon('chevron'));
  exportBtn.classList.add('tb-tile', 'tb-split-more');
  exportBtn.title = 'Export as .md, .typ or .tex';
  // The drawer's switch: the rail opens into every tool, labelled, with
  // its markdown and its keys, pushing the page over (--rail, style.css;
  // the paper refits as the panel narrows). Remembered per browser.
  const drawerBtn = glyphButton(railTop, 'All tools', icon('drawer'));
  drawerBtn.id = 'rail-drawer';
  drawerBtn.setAttribute('aria-pressed', 'false');
  const setDrawer = (open: boolean) => {
    // The frame the drawer opens or shuts, nothing in the rail fades: a
    // row's label turns back into a hover caption as it shuts, and its
    // fade would show it for a frame or two outside the narrowing rail.
    const root = document.documentElement;
    root.classList.add('rail-switching');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('rail-switching')));
    root.classList.toggle('rail-open', open);
    drawerBtn.setAttribute('aria-pressed', String(open));
    drawerBtn.title = open ? 'Fewer tools' : 'All tools — with their markdown and keys';
    try {
      localStorage.setItem('typeset-rail-open', open ? '1' : '0');
    } catch {
      /* no storage: the drawer simply forgets */
    }
  };
  drawerBtn.addEventListener('click', () => {
    closeMenu();
    setDrawer(!document.documentElement.classList.contains('rail-open'));
  });
  let drawerWasOpen = false;
  try {
    drawerWasOpen = localStorage.getItem('typeset-rail-open') === '1';
  } catch {
    /* no storage */
  }
  setDrawer(drawerWasOpen);
  // The foot: the bibliography, then Document settings at the very bottom.
  const bibBtn = glyphButton(railFoot, 'Bibliography', icon('book'));
  bibBtn.title = 'Edit bibliography — or write a ```bibtex block';
  const settingsBtn = glyphButton(railFoot, 'Document settings', icon('sliders'));
  // The view switch, on the page at its lower left (the HUD's corner
  // opposite): a quiet chip with the source glyph and no word; its name
  // (Plain text on the page, Paper in the text) is its title.
  const sourceBtn = document.createElement('button');
  sourceBtn.type = 'button';
  sourceBtn.className = 'tb-source view-switch';
  sourceBtn.setAttribute('aria-label', 'Plain text view');
  sourceBtn.setAttribute('aria-pressed', 'false');
  sourceBtn.title = 'Switch to plain text (⌘/)';
  sourceBtn.innerHTML = icon('code');
  sourceBtn.addEventListener('mousedown', (e) => e.preventDefault());
  sourceBtn.addEventListener('click', () => { closeMenu(); actions.toggleSource(); });
  document.body.append(sourceBtn);
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
  const recent = createMenu('Recent papers', recentBtn);
  const exports = createMenu('Export', exportBtn);
  const get = createMenu('Get Plass', recentBtn, recent);

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
  const runCmd = (command: Command) => () => {
    command(view.state, view.dispatch, view);
    view.focus();
  };
  const ancestor = (...names: string[]) => {
    const { $from } = view.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if (names.includes($from.node(depth).type.name)) return $from.node(depth);
    }
    return null;
  };
  // The rail's tools (Taylor, 2026-10-17). At rest the rail holds what is
  // hard to type in markdown: Insert (image, table, grid, math, footnote),
  // the Blocks, alignment, the code block, the bibliography. Its foot's
  // All tools switch opens it into every tool, labelled, with its markdown
  // and keys (Basics, the rest of Insert and Code, Document, Keys): the
  // markdown cheat sheet and the old Headings, Text style, Lists, Insert
  // and Extras menus in one list. Each tool is one button: a tile at rest
  // (its name the hover caption), a row with its hint when open.
  type ToolOptions = ItemOptions & { hint?: string; rest?: boolean };
  const section = (name: string) => {
    const group = document.createElement('div');
    group.className = 'tb-rail-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', name);
    const head = document.createElement('div');
    head.className = 'tb-rail-head';
    head.setAttribute('aria-hidden', 'true');
    head.textContent = name;
    group.append(head);
    railGroups.append(group);
    return group;
  };
  const tool = (group: HTMLElement, label: string, run: () => void, options: ToolOptions) => {
    const button = item(group, label, run, { tile: true, ...options });
    if (options.hint) {
      const hint = document.createElement('span');
      hint.className = 'tb-hint';
      hint.textContent = options.hint;
      button.append(hint);
    }
    if (!options.rest) button.classList.add('tb-drawer-only');
    return button;
  };
  const commandTool = (group: HTMLElement, label: string, command: Command, options: ToolOptions) =>
    tool(group, label, runCmd(command), { editing: true, enabled: () => command(view.state), ...options });
  const tico = (text: string) => `<span class="ico tico">${text}</span>`;

  const textGroup = section('Text');
  textGroup.classList.add('tb-cycles');
  const insertGroup = section('Insert');
  const blocksGroup = section('Blocks');
  const layoutGroup = section('Layout');
  const codeGroup = section('Code');
  const documentGroup = section('Document');
  const basicsGroup = section('Basics');
  basicsGroup.classList.add('tb-basics');
  const keysGroup = section('Keys');

  // INSERT
  commandTool(insertGroup, 'Image', insertFigureCmd, { rest: true, glyph: icon('image'), hint: 'paste · ⌘⌥I', title: 'Insert figure (⌘⌥I) — or paste/drop an image' });
  tool(insertGroup, 'Table', () => insertStructuredTable(view), { rest: true, editing: true, glyph: icon('table'), hint: '⌘⌥T', title: 'Insert table (⌘⌥T)' });
  tool(insertGroup, 'Grid', () => insertGrid(view), { rest: true, editing: true, glyph: icon('grid'), hint: 'side by side', title: 'Side-by-side grid — any blocks in columns; Grid layout sets the split' });
  commandTool(insertGroup, 'Inline math', insertMath(false), { rest: true, glyph: tico('Σ'), hint: '$x^2$ · ⌘M', title: 'Inline math (⌘M) — or type $x^2$' });
  commandTool(insertGroup, 'Footnote', insertFootnote, { rest: true, glyph: tico('†'), hint: '^[note] · ⌘⌥F', title: 'Footnote (⌘⌥F) — or type ^[' });
  commandTool(insertGroup, 'Display equation', insertMath(true), { glyph: tico('∑'), hint: '$$ · ⌘⇧M', title: 'Display equation (⌘⇧M)' });
  tool(insertGroup, 'Reference or cite', () => {
    const { state, dispatch } = view;
    const { $from } = state.selection;
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, '￼', '￼');
    dispatch(state.tr.insertText(before && /[\w.]/.test(before) ? ' @' : '@').scrollIntoView());
    view.focus();
  }, { editing: true, glyph: tico('@'), hint: '@', title: 'Reference or cite — type @: the picker lists equations, figures, tables, sections and works' });
  // A value from Knuth's values.json (values.ts): the tool types the `{{`
  // that opens the picker.
  tool(insertGroup, 'Value', () => {
    view.dispatch(view.state.tr.insertText('{{').scrollIntoView());
    view.focus();
  }, { editing: true, glyph: tico('{}'), hint: '{{', title: 'Value from values.json — type {{: the picker lists what Knuth computed; {{name:2 rounds to two decimals' });
  tool(insertGroup, 'Title block', () => {
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
  }, { editing: true, glyph: tico('T'), hint: 'title · authors', title: 'Title block — title, authors, date, abstract' });
  tool(insertGroup, 'Page break', () => {
    const { state, dispatch } = view;
    const { $from } = state.selection;
    const pos = $from.after($from.depth > 0 ? 1 : 0);
    dispatch(state.tr.insert(pos, schema.nodes.page_break.create()).scrollIntoView());
    view.focus();
  }, { editing: true, glyph: icon('pagebreak'), hint: '⌘⏎', title: 'Page break (⌘⏎)' });

  // BLOCKS
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
  // A pressed Quote or Solution tile, pressed again, takes the whole block
  // away (its paragraphs back to body text), and so does a pressed Code
  // block (Taylor, 2026-10-17: no separate Remove button).
  const unwrapQuote = () => {
    const { state } = view;
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type !== schema.nodes.blockquote) continue;
      const range = new NodeRange(state.doc.resolve($from.before(d) + 1), state.doc.resolve($from.after(d) - 1), d);
      const target = liftTarget(range);
      if (target !== null) view.dispatch(state.tr.lift(range, target).scrollIntoView());
      break;
    }
    view.focus();
  };
  const quoteKind = () => {
    const quote = ancestor('blockquote');
    return quote ? ((quote.attrs.kind as string | null) ?? 'quote') : null;
  };
  tool(blocksGroup, 'Block quote', () => (quoteKind() === 'quote' ? unwrapQuote() : setBlockKind(null)), {
    rest: true, editing: true, glyph: icon('quote'), hint: '> text · ⌃>', title: 'Block quote (⌃>) — or type > at a line start',
    checked: () => quoteKind() === 'quote',
  });
  tool(blocksGroup, 'Solution', () => (quoteKind() === 'solution' ? unwrapQuote() : setBlockKind('solution')), {
    rest: true, editing: true, glyph: icon('solution'), hint: 'red, ruled', title: 'Solution block — red text with a red rule on the left',
    checked: () => quoteKind() === 'solution',
  });
  commandTool(blocksGroup, 'Comment', insertEditorComment, {
    rest: true, glyph: icon('comment'), hint: 'never printed', title: 'Editorial comment — a note on the page and in the file, never printed',
  });
  const inCode = () => view.state.selection.$from.parent.type === schema.nodes.code_block && !view.state.selection.$from.parent.attrs.params;
  const toggleCode: Command = (state, dispatch) =>
    inCode() ? setBlockType(schema.nodes.paragraph)(state, dispatch) : setBlockType(schema.nodes.code_block, { params: '' })(state, dispatch);
  commandTool(blocksGroup, 'Code block', toggleCode, {
    rest: true, glyph: icon('terminal'), hint: '```', title: 'Code block — monospaced source listing', checked: inCode,
  });

  // LAYOUT
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
  for (const [label, align, title, hint] of [
    ['Justified', null, 'Align left (justified body text)', 'the default'],
    ['Center', 'center', 'Center text', ''],
    ['Right', 'right', 'Align right', ''],
  ] as const) {
    tool(layoutGroup, label, () => setAlign(align), {
      title, hint, editing: true, enabled: alignmentEnabled,
      glyph: icon(align === 'center' ? 'aligncenter' : align === 'right' ? 'alignright' : 'alignleft'),
      checked: () => alignmentEnabled() && selectedParagraphs().every(({ node }) => (node.attrs.align ?? null) === align),
    });
  }

  // TEXT, at rest: two tiles that show the caret's heading level and
  // alignment and step through them on each press (Taylor, 2026-10-17);
  // the drawer lists each level and alignment as its own row instead.
  const headingTile = tool(textGroup, 'Heading level', runCmd(cycleHeading), { rest: true, glyph: tico('¶'), editing: true, enabled: () => cycleHeading(view.state) });
  headingTile.id = 'heading-cycle';
  const headingGlyph = headingTile.querySelector<HTMLElement>('.tico')!;
  const headingLabel = headingTile.querySelector<HTMLElement>('.lbl')!;
  const levelName = (level: number | null) => (level === null ? 'Body text' : `Heading ${level}`);
  refreshTiles.push(() => {
    const level = headingLevelAt(view.state) ?? null;
    const glyph = level === null ? '¶' : `H${level}`;
    if (headingGlyph.textContent !== glyph) headingGlyph.textContent = glyph;
    const caption = `${levelName(level)} · click for ${levelName(nextHeadingLevel(level))}`;
    if (headingLabel.textContent !== caption) headingLabel.textContent = caption;
    setAttr(headingTile, 'title', `${caption} (⌘⌥0–3)`);
  });
  const ALIGNS = [null, 'center', 'right'] as const;
  const alignName = (align: (typeof ALIGNS)[number]) => (align === 'center' ? 'Center' : align === 'right' ? 'Right' : 'Justified');
  const alignGlyph = (align: (typeof ALIGNS)[number]) => icon(align === 'center' ? 'aligncenter' : align === 'right' ? 'alignright' : 'alignleft');
  const currentAlign = () => (selectedParagraphs()[0]?.node.attrs.align ?? null) as (typeof ALIGNS)[number];
  const nextAlign = () => ALIGNS[(ALIGNS.indexOf(currentAlign()) + 1) % ALIGNS.length];
  const alignTile = tool(textGroup, 'Alignment', () => setAlign(nextAlign()), { rest: true, glyph: alignGlyph(null), editing: true, enabled: alignmentEnabled });
  alignTile.id = 'align-cycle';
  const alignLabel = alignTile.querySelector<HTMLElement>('.lbl')!;
  refreshTiles.push(() => {
    const align = currentAlign();
    if (alignTile.dataset.align !== String(align)) {
      alignTile.dataset.align = String(align);
      alignTile.querySelector('svg')?.remove();
      alignTile.insertAdjacentHTML('afterbegin', alignGlyph(align));
    }
    const caption = `${alignName(align)} · click for ${alignName(nextAlign())}`;
    if (alignLabel.textContent !== caption) alignLabel.textContent = caption;
    setAttr(alignTile, 'title', caption);
  });
  for (const tile of [headingTile, alignTile]) tile.classList.add('tb-rest-only');

  // CODE
  commandTool(codeGroup, 'Raw Typst block', setBlockType(schema.nodes.code_block, { params: 'typst-raw' }), {
    glyph: tico('#'), hint: '```typst', title: 'Raw Typst block — kept in the file as Typst, shown and printed as code, never run',
  });
  tool(codeGroup, 'Inline raw Typst', () => void import('./inline-raw').then(({ insertTypstInline }) => insertTypstInline(view)), {
    editing: true, glyph: tico('#·'), hint: 'kept verbatim', title: 'Inline raw Typst — kept in the file verbatim, shown and printed as inline code, never run',
  });

  // DOCUMENT
  bibBtn.addEventListener('click', () => { closeMenu(); editBibliography(view, (m) => fm.notify(m)); });
  tool(documentGroup, 'Demo document', () => {
    if (confirm('Replace the current document with the demo? (Save yours first if it matters.)')) {
      void import('./demo-doc').then(({ demoDoc }) => fm.newDoc(demoDoc(), 'Demo'));
    }
  }, { glyph: tico('?'), hint: 'a tour', title: 'Open the demo document — what Plass does, written in Plass' });

  // BASICS: what markdown writes plainly, so the rail at rest leaves it out.
  for (const level of [null, 1, 2, 3]) {
    const command = level ? setBlockType(schema.nodes.heading, { level }) : setBlockType(schema.nodes.paragraph);
    const current = () => {
      const node = view.state.selection.$from.parent;
      return level ? node.type === schema.nodes.heading && node.attrs.level === level : node.type === schema.nodes.paragraph;
    };
    commandTool(basicsGroup, level ? `Heading ${level}` : 'Body text', command, {
      glyph: tico(level ? `H${level}` : '¶'),
      hint: level ? `${'#'.repeat(level)} · ⌘⌥${level}` : '⌘⌥0',
      title: level ? `Heading ${level} (⌘⌥${level})` : 'Body text (⌘⌥0)',
      checked: current,
      enabled: () => command(view.state) || current(),
    });
  }
  for (const [name, label, hint, glyph] of [
    ['strong', 'Bold', '**text** · ⌘B', tico('<b>B</b>')],
    ['em', 'Italic', '*text* · ⌘I', tico('<i>I</i>')],
    ['strike', 'Strikethrough', '~~text~~ · ⌘⇧X', tico('<s>S</s>')],
    ['code', 'Inline code', '`code` · ⌘`', tico('`')],
  ]) {
    const mark = schema.marks[name];
    commandTool(basicsGroup, label, toggleMark(mark), {
      glyph, hint, title: `${label} (${hint.split(' · ')[1]})`,
      checked: () => {
        const { selection, storedMarks, doc } = view.state;
        return selection.empty ? !!mark.isInSet(storedMarks ?? selection.$from.marks()) : doc.rangeHasMark(selection.from, selection.to, mark);
      },
    });
  }
  commandTool(basicsGroup, 'Bulleted list', wrapInList(schema.nodes.bullet_list), { glyph: icon('list'), hint: '- item · ⌘⇧8', title: 'Bulleted list (⌘⇧8)' });
  commandTool(basicsGroup, 'Numbered list', wrapInList(schema.nodes.ordered_list), { glyph: icon('numlist'), hint: '1. item · ⌘⇧9', title: 'Numbered list (⌘⇧9)' });
  commandTool(basicsGroup, 'Loose list spacing', toggleListSpacing, {
    glyph: icon('looselist'), hint: '⌘⇧7', title: 'Item spacing (⌘⇧7) — tight, or loose with paragraph spacing between items',
    checked: () => ancestor('bullet_list', 'ordered_list')?.attrs.tight === false,
  });

  // KEYS: the paper's way in and out, as rows of the cheat sheet.
  tool(keysGroup, 'Open', () => void fm.open(), { glyph: icon('open'), hint: '⌘O', title: 'Open… (⌘O)' });
  tool(keysGroup, 'Save', () => void fm.save(), { glyph: icon('download'), hint: '⌘S', title: 'Save (⌘S)' });
  tool(keysGroup, 'Export PDF', () => exportPdfNow(), { glyph: icon('download'), hint: '⌘P', title: 'Export PDF (⌘P)' });
  tool(keysGroup, 'Plain text view', () => actions.toggleSource(), { glyph: icon('code'), hint: '⌘/', title: 'Switch between the page and plain text (⌘/)' });
  tool(keysGroup, 'Two pages side by side', () => actions.toggleSpread(), { glyph: tico('▯▯'), hint: 'view', title: 'Draw the pages two side by side, or one below another' });
  openBtn.addEventListener('click', () => { closeMenu(); void fm.open(); });
  newBtn.addEventListener('click', () => {
    closeMenu();
    const url = new URL(location.href);
    url.searchParams.set('new', '1');
    window.open(url.toString(), '_blank');
  });
  // Plass.app: the shell's History page, the record of this document's
  // folder with a rewind to any point of it, in this window's room — the
  // panel that is the paper (#scroll), under the bar and right of the
  // rail — not a window of its own (Taylor, 2026-10-02: "instead of a new
  // window, i just want it to open in the same window in the main
  // area"). Two ways in, one toggle: the History tile in the bar right
  // after the name pill ("i think it belongs as a tile on the topbar
  // beside the address", with the same glyph as Knuth's; the File menu's
  // History… item went with the menu, 2026-10-17), and the shell's
  // View › History… (⇧⌘H, the shell's menu takes the keys), which asks
  // the page to do what the tile does (`toggle`), since the room's box is the page's to send. The shell
  // lays its page over the box and says when it comes and goes (Escape and
  // the page's own close tile put it away too, and a reload of this page);
  // the tile is pressed exactly while it is up, from that word alone,
  // never from the click. While it is up the room is measured again
  // whenever its box changes — a resize of the window, the scroll rail's
  // gutter coming or going (the panel's right edge, 8 px or 20 px) — and
  // the shell moves the page to it. The document stays loaded
  // underneath, hidden (style.css, .history-inline: the page's rounded
  // corners show the frame, not the paper), so a rewind's save and reload
  // reach it as ever. A document with no record gets the page saying why;
  // a shell from before the room (0.2.1, 0.2.2) opens its History window
  // instead, as it did; a shell without the view answers null, and the
  // tile goes.
  if (isNativeShell()) {
    const historyTile = glyphButton(container, 'History', HISTORY_GLYPH);
    historyTile.id = 'history-tile';
    historyTile.classList.add('tb-tile');
    historyTile.title = 'History (⇧⌘H)';
    historyTile.setAttribute('aria-keyshortcuts', 'Shift+Meta+H');
    historyTile.setAttribute('aria-pressed', 'false');
    // Inside the name pill, at its far right after the folder (Taylor,
    // 2026-10-17; Knuth's pill holds it the same way): the paper's record
    // beside the paper's name.
    titleBar.append(historyTile);
    titleBar.classList.add('has-history');
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
        historyTile.hidden = true;
        titleBar.classList.remove('has-history');
        fm.notify('This Plass.app has no history view — Plass → Check for Updates…');
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
    // The page is the shell's, above everything this one draws in the
    // room, so whatever opens or acts there puts it away first, as Knuth's
    // bar does: the Open and Export tiles (their menus drop over the
    // room; Open's picker comes up over it) and the rail (its tiles edit
    // the paper under the page; its flyouts and Document settings open
    // over the room). On the press, before the
    // click opens anything, and on the keys that press a tile or open its
    // menu, for a bar the focus came back to. The History tile is the
    // toggle itself; the HUD and the scroll rail are hidden while the page
    // is up (style.css), so they open nothing.
    const putAway = () => { if (shown) closeHistory(); };
    const presses = (e: KeyboardEvent) => e.key === 'Enter' || e.key === ' '
      || (['ArrowDown', 'ArrowUp', 'ArrowRight'].includes(e.key) && (e.target as Element).classList.contains('tb-menu-trigger'));
    for (const way of [openBtn, recentBtn, pdfBtn, exportBtn, rail]) {
      way.addEventListener('pointerdown', putAway, true);
      way.addEventListener('keydown', (e) => { if (presses(e)) putAway(); }, true);
    }
    historyTile.addEventListener('click', () => { closeMenu(); showHistory(); });
  }
  const installButton = tool(documentGroup, 'Install Plass', () => void requestPwaInstall((message) => fm.notify(message)), {
    glyph: icon('install'), hint: 'its own window', title: 'Install Plass as an app',
  });
  installButton.classList.add('pwa-install');
  installButton.hidden = isNativeShell() || isPwaInstalled();
  onPwaInstallState((installed) => { installButton.hidden = isNativeShell() || installed; });
  // Open's side half: the recent papers straight away, not a submenu
  // (Taylor, 2026-10-17), loaded each time it opens; then the way to open
  // a whole project folder, and at the foot what applies in one place
  // only — the Mac app from a Mac browser tab, the app's own update in
  // Plass.app.
  heading(recent.element, 'Recent papers');
  const recentEntries = document.createElement('div');
  recentEntries.setAttribute('role', 'group');
  recentEntries.setAttribute('aria-label', 'Recent papers');
  recent.element.append(recentEntries);
  divider(recent.element);
  item(recent.element, 'Open project folder…', () => void fm.openFolder('open'));
  // The Mac app, from a browser tab on a Mac: every deploy publishes it
  // beside this page, so the download and the install line are this
  // page's version. Inside Plass.app there is nothing to get.
  const mac = /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2;
  if (mac && !isNativeShell()) {
    divider(recent.element);
    item(recent.element, 'Get Plass for your Mac', () => {}, { title: 'Plass.app: the download, or the install line', submenu: get });
  }
  // Inside Plass.app: the app updating itself (the shell's update.js). The
  // shell looks at the site after launch and says when it has a newer
  // build; the item shows only then, and offers the install, whose steps
  // show as notices until the app relaunches. Checking is the shell's own
  // Plass › Check for Updates… (Taylor, 2026-10-17: it is in the app's
  // menu, so not in this one).
  if (isNativeShell()) {
    const updateFoot = document.createElement('div');
    updateFoot.hidden = true;
    recent.element.append(updateFoot);
    divider(updateFoot);
    let offered: string | null = null;
    const updateItem = item(updateFoot, 'Install update', () => {
      if (!offered) return;
      setLabel('Updating…');
      installUpdate();
    }, { title: 'Plass.app: install the site\u2019s newer build and relaunch' });
    const label = updateItem.querySelector('.tb-menu-label');
    const setLabel = (text: string) => {
      if (label) label.textContent = text;
      updateFoot.hidden = false;
    };
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
          if (offered) setLabel(`Install update${when}`);
          else updateFoot.hidden = true;
          fm.notify(`Could not update Plass: ${step.text ?? 'unknown error'}`);
          break;
        default:
          break;
      }
    });
  }

  heading(exports.element, 'Export');
  const exportPdfNow = (perSheet: 1 | 2 = 1) => {
    void import('./pdf').then(({ exportPdf }) =>
      exportPdf(
        fm.currentDoc(),
        fm.name,
        (m) => fm.notify(m),
        (name, blob) => fm.saveBeside(name, blob),
        (m) => fm.notifyAction(m, { label: 'Try again', run: () => exportPdfNow(perSheet) }),
        { perSheet },
      ),
    );
  };
  pdfBtn.addEventListener('click', () => { closeMenu(); exportPdfNow(); });
  // ⌘P is Print everywhere on a Mac, and Plass's print is the PDF, so it
  // runs the export in place of the browser's print dialog; ⌘E stays.
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if ((key !== 'p' && key !== 'e') || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (e.repeat) return;
    closeMenu();
    exportPdfNow();
  });
  // Two pages to a sheet, side by side at full size (half Letter on
  // landscape Letter): print it and cut down the middle.
  item(exports.element, 'PDF, 2 per sheet', () => exportPdfNow(2), { title: 'Export a PDF with two pages side by side on each sheet (half Letter on landscape Letter)' });
  item(exports.element, 'Markdown (.md)', () => void fm.exportMdCopy(), { title: 'Export a .md copy' });
  item(exports.element, 'Typst (.typ)', () => void fm.exportCopy(), { title: 'Export a .typ copy' });
  item(exports.element, 'LaTeX (.tex)', () => fm.exportTexCopy(), { title: 'Export a .tex copy (vanilla LaTeX for journals)' });
  item(get.element, '‹ Recent papers', () => showMenu(recent, true));
  divider(get.element);
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
      settingsBtn.disabled = active;
      bibBtn.disabled = active;
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
      if (saveChip.hidden === !fm.saved) saveChip.hidden = fm.saved;
      titleBar.classList.toggle('has-save', !fm.saved);
      repaintFolder();
    },
    setPath(path) {
      documentPath = path;
      repaintFolder();
    },
  };
}

