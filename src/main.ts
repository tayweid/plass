import 'katex/dist/katex.min.css';
import './style.css';

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history } from 'prosemirror-history';
import { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { baseKeys, buildInputRules, buildKeymap, collapseSpaces} from './editing';
import { typesetPlugin, type PageInfo, type TypesetStats } from './typeset-plugin';
import { MathView } from './math';
import { demoDoc } from './demo-doc';
import { buildToolbar, type Toolbar } from './toolbar';
import { TablePreviewView } from './table-preview';
import { equationsPlugin } from './equations';
import { FigureView, ImageView, figuresPlugin, isPathSrc, migrateEmbeddedFigures, refreshAssets, setFigureFileManager, startAssetWatch } from './figures';
import { FootnoteView, footnoteGuard, footnoteMarkerClick } from './footnotes';
import { BibliographyView, citationsPlugin } from './citations';
import { CodeBlockView, rawIslandPlugin } from './raw-preview';
import { refAutocomplete } from './ref-autocomplete';
import { applySettings, formatPageNumber, getSettings } from './settings';
import { FileManager } from './file-manager';

const STORAGE_KEY = 'typeset-doc-v1';
const SESSION_KEY = 'typeset-doc-session';
const SECONDARY_KEY = 'typeset-secondary-tab';

/** Whether this tab owns the shared localStorage session and the
 *  last-file reconnect (the primary tab). Windows opened via "New"
 *  (?new) are marked secondary FOR THEIR LIFETIME — their unsaved work
 *  lives in per-tab sessionStorage, so parallel windows never clobber
 *  each other's autosave or steal the primary's file handle. The mark is
 *  a per-tab fact, persisted in sessionStorage: a reloaded primary that
 *  restores its own session must STAY primary. */
let primaryTab = false;
let restoredSessionDoc = false;

/** Installed-app window (Finder launch or Dock open) vs plain browser tab. */
const standalone = window.matchMedia('(display-mode: standalone)').matches;

function loadDoc(): PMNode {
  // A "New" window starts empty. window.open COPIES the opener's
  // sessionStorage into the new tab, so the inherited session must be
  // discarded; stripping ?new afterward lets reloads of this tab restore
  // its own work through the session branch below.
  if (new URLSearchParams(location.search).has('new')) {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.setItem(SECONDARY_KEY, '1');
    const url = new URL(location.href);
    url.searchParams.delete('new');
    window.history.replaceState(null, '', url.toString());
    return schema.nodes.doc.createAndFill()!;
  }
  primaryTab = sessionStorage.getItem(SECONDARY_KEY) !== '1';
  // A reloaded tab restores its own session first, whichever kind it is.
  try {
    const own = sessionStorage.getItem(SESSION_KEY);
    if (own) {
      restoredSessionDoc = true;
      return PMNode.fromJSON(schema, JSON.parse(own));
    }
  } catch (e) {
    console.warn('Could not restore tab session.', e);
  }
  // Beyond its own reload session, an app window starts on a fresh
  // sheet: restoring another window's localStorage document here is what
  // flashed the previous file for an instant before a Finder-launched
  // file loaded over it, and a Dock open reads better empty than resuming
  // whatever window autosaved last.
  if (standalone) return schema.nodes.doc.createAndFill()!;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return PMNode.fromJSON(schema, JSON.parse(raw));
  } catch (e) {
    console.warn('Could not restore saved document, starting fresh.', e);
  }
  return demoDoc();
}

let saveTimer = 0;
function persistSession(view: EditorView) {
  try {
    const json = JSON.stringify(view.state.doc.toJSON());
    sessionStorage.setItem(SESSION_KEY, json);
    if (primaryTab) localStorage.setItem(STORAGE_KEY, json);
  } catch (e) {
    console.warn('Autosave failed.', e);
  }
}

function scheduleSave(view: EditorView) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => persistSession(view), 400);
}

function makeState(doc: PMNode, onStats: (s: TypesetStats) => void): EditorState {
  return EditorState.create({
    doc,
    plugins: [
      // Before the keymaps: the popup must see Enter/Tab/arrows first.
      refAutocomplete(),
      buildInputRules(),
      buildKeymap(),
      baseKeys,
      history(),
      equationsPlugin(),
      citationsPlugin(),
      figuresPlugin(),
      rawIslandPlugin(),
      footnoteGuard(),
      collapseSpaces(),
      typesetPlugin({ onStats, onPages: renderPages }),
    ],
  });
}

const editorEl = document.getElementById('editor')!;
const toolbarEl = document.getElementById('toolbar')!;
const scrollEl = document.getElementById('scroll')!;

// The page centers inside the scroll area, which is the window minus the
// scrollbar; the fixed toolbar spans the full window. Inset its right edge
// by the scrollbar width so the pills center on the page's axis, not the
// window's.
function syncToolbarInset() {
  toolbarEl.style.right = `${window.innerWidth - scrollEl.clientWidth}px`;
}
window.addEventListener('resize', syncToolbarInset);
requestAnimationFrame(syncToolbarInset);
const hudEl = document.getElementById('hud')!;
const toastEl = document.getElementById('toast')!;
const stackEl = document.getElementById('stack')!;
const pagesEl = document.getElementById('pages')!;

let pageCount = 0;
let pageSignature = '';

/** Paint the page boxes + numbers behind the editor. */
function renderPages(info: PageInfo) {
  stackEl.style.height = `${info.count * (info.pageH + info.gap) - info.gap}px`;
  pageCount = info.count;
  const s = getSettings(view.state);
  // A numbering-restart marker splits the document: roman front matter,
  // then the body restarts at 1 in the document's format.
  let restartPage = -1;
  {
    let markerPos = -1;
    view.state.doc.forEach((node, offset) => {
      if (markerPos < 0 && node.type.name === 'numbering_restart') markerPos = offset;
    });
    if (markerPos >= 0) {
      try {
        const host = view.dom.parentElement ?? view.dom;
        const stackTop = host.getBoundingClientRect().top;
        const c = view.coordsAtPos(markerPos + 1);
        restartPage = Math.min(info.count - 1, Math.max(0, Math.round((c.top - stackTop) / (info.pageH + info.gap))));
      } catch {
        restartPage = -1;
      }
    }
  }
  const folio = (k: number) =>
    restartPage < 0
      ? formatPageNumber(s, k + 1, info.count)
      : k < restartPage
        ? formatPageNumber({ ...s, pageNumFormat: 'i' }, k + 1, restartPage)
        : formatPageNumber(s, k - restartPage + 1, info.count - restartPage);
  const sig = `${info.count}:${info.pageH}:${info.marginBottom}:${info.marginLeft}:${info.marginRight}:${s.pageNumShow}:${s.pageNumFormat}:${s.pageNumAlign}:${s.pageNumStart}:${s.headerText}:${s.headerAlign}:${s.headerFirstPage}:${restartPage}`;
  if (sig !== pageSignature) {
    pageSignature = sig;
    const frag = document.createDocumentFragment();
    for (let k = 0; k < info.count; k++) {
      const top = k * (info.pageH + info.gap);
      const box = document.createElement('div');
      box.className = 'page-box';
      box.style.top = `${top}px`;
      frag.appendChild(box);
      if (s.headerText && (s.headerFirstPage || k > 0)) {
        const head = document.createElement('div');
        head.className = 'page-num page-header';
        // Typst header: block bottom sits header-ascent (30%) above the
        // content area, i.e. at 0.7 * top margin.
        const em = s.sizePt * (4 / 3);
        head.style.top = `${top + 0.7 * (s.marginTop * 96) - 1.2 * em}px`;
        head.style.textAlign = s.headerAlign;
        head.style.padding = `0 ${info.marginRight}px 0 ${info.marginLeft}px`;
        head.textContent = s.headerText.replace(
          /\{page\}/g,
          restartPage < 0 || k >= restartPage
            ? formatPageNumber({ ...s, pageNumFormat: '1' }, restartPage < 0 ? k + 1 : k - restartPage + 1, info.count)
            : formatPageNumber({ ...s, pageNumFormat: 'i' }, k + 1, restartPage),
        );
        frag.appendChild(head);
      }
      if (s.pageNumShow) {
        const num = document.createElement('div');
        num.className = 'page-num';
        // Typst's folio: centered one third of the margin below the content.
        num.style.top = `${top + info.pageH - (2 / 3) * info.marginBottom - 0.55 * s.sizePt * (4 / 3)}px`;
        num.style.textAlign = s.pageNumAlign;
        num.style.padding = `0 ${info.marginRight}px 0 ${info.marginLeft}px`;
        num.textContent = folio(k);
        frag.appendChild(num);
      }
    }
    pagesEl.replaceChildren(frag);
  }
  updateStatus();
}

let toolbar: Toolbar;
let lastStats: TypesetStats | null = null;

function onStats(s: TypesetStats) {
  lastStats = s;
  toolbar?.stats(s);
  updateStatus();
}

// Each deploy replaces the hashed chunk files, so a page cached across a
// deploy can 404 its lazy imports (the .md parser is one). Reload once to
// pick up the coherent new build instead of failing the import.
window.addEventListener('vite:preloadError', () => {
  if (sessionStorage.getItem('typeset-reloaded-for-update')) return;
  sessionStorage.setItem('typeset-reloaded-for-update', '1');
  location.reload();
});

const view = new EditorView(editorEl, {
  state: makeState(loadDoc(), onStats),
  nodeViews: {
    math_inline: (node, v, getPos) => new MathView(node, v, getPos),
    math_display: (node, v, getPos) => new MathView(node, v, getPos),
    image: (node, v, getPos) => new ImageView(node, v, getPos),
    figure: (node, v, getPos) => new FigureView(node, v, getPos),
    footnote: (node) => new FootnoteView(node),
    bibliography: (node, v) => new BibliographyView(node, v),
    table: (node, v, getPos) => new TablePreviewView(node, v, getPos),
    code_block: (node, v, getPos) => new CodeBlockView(node, v, getPos),
  },
  attributes: { spellcheck: 'true' },
  handleClick: (v, _pos, event) => footnoteMarkerClick(v, event),
  dispatchTransaction(tr) {
    const prevAttrs = view.state.doc.attrs;
    const prevMacros = getSettings(view.state).mathMacros;
    const newState = view.state.apply(tr);
    view.updateState(newState);
    toolbar?.update(newState);
    if (newState.doc.attrs !== prevAttrs) {
      applySettings(newState);
      // Macro changes must re-render every math node view.
      if (getSettings(newState).mathMacros !== prevMacros) queueMicrotask(refreshMathNodes);
    }
    if (tr.docChanged) {
      scheduleSave(view);
      fileManager.noteChange();
      updateStatus();
    }
  },
});

// Timers may never run once a tab is being discarded. Session storage is a
// synchronous, local write, so take the latest editor snapshot at lifecycle
// boundaries even while the slower real-file autosave finishes separately.
window.addEventListener('pagehide', () => {
  clearTimeout(saveTimer);
  persistSession(view);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearTimeout(saveTimer);
    persistSession(view);
  }
});

const fileManager = new FileManager({
  getDoc: () => view.state.doc,
  emptyDoc: () => schema.nodes.doc.create(null, [schema.nodes.paragraph.create()]),
  setDoc(doc) {
    view.updateState(makeState(doc, onStats));
    applySettings(view.state);
    toolbar?.update(view.state);
    updateStatus();
    scheduleSave(view);
    view.focus();
  },
  onState() {
    toolbar?.setFile(fileManager.name, fileManager.dirty);
    document.title = `${fileManager.name}${fileManager.dirty ? ' •' : ''} - Plass`;
  },
  message: showMessage,
  messageAction: showMessage,
  onProjectKept: () => void migrateEmbeddedFigures(view),
  hasSessionDoc: () => restoredSessionDoc,
});

toolbar = buildToolbar(toolbarEl, view, fileManager);
setFigureFileManager(fileManager);
startAssetWatch(view);
void import('./pdf').then(({ setAssetReader }) =>
  setAssetReader(async (path, maxBytes) => (await fileManager.readAsset(path, maxBytes))?.data ?? null),
);
toolbar.update(view.state);
toolbar.setFile(fileManager.name, fileManager.dirty);
applySettings(view.state);

/** Open a file-handler launch: the file arrives as a bare handle with no
 *  directory context, so documents with on-disk figures get a one-click
 *  folder grant. */
function openLaunched(files: ReadonlyArray<FileSystemFileHandle>) {
  const [file] = files;
  void fileManager.loadHandle(file).then((opened) => {
    if (!opened) return;
    if (files.length > 1) {
      showMessage(`Opened ${file.name} — Plass opens one document at a time`);
    }
    let needsFolder = false;
    view.state.doc.descendants((n) => {
      if (n.type.name === 'figure' && isPathSrc(n.attrs.src as string)) needsFolder = true;
      return !needsFolder;
    });
    if (needsFolder && !fileManager.inFolder) {
      fileManager.notifyAction(`Figures live next to ${file.name} — grant folder access to load them`, {
        label: 'Grant folder',
        run: () => void fileManager.attachFolder().then((ok) => ok && refreshAssets()),
      });
    }
  }).catch((e) => {
    // Never fail a Finder launch into a silent blank window.
    console.warn('Launched file failed to open', e);
    showMessage(`Could not open ${file.name} — try double-clicking it again`);
  });
}

// OS file-handler launches (installed PWA, Finder double-click): handles
// arrive through the launch queue. Registered only now, near the end of
// boot: Chrome delivers already-queued launch files SYNCHRONOUSLY inside
// setConsumer — and reports (not propagates) consumer exceptions — so a
// consumer registered before fileManager/view exist throws a swallowed
// TDZ error and the launch is silently lost. Everything the handler
// touches must already be live. App windows start on an empty sheet (see
// loadDoc), so the launched file renders into blank space.
window.launchQueue?.setConsumer((params) => {
  if (params.files.length) openLaunched(params.files);
});

// Reconnect to the last open file if the browser still grants access —
// primary tab only: the IDB handle is shared across tabs, and a "New"
// window (or a reloaded secondary) must keep its own document instead of
// having the last-opened file load over it. App windows skip this too:
// they open empty or with the launched file, never someone else's last.
if (primaryTab && !standalone) void fileManager.restoreLast();

// App-level shortcuts (the browser's defaults would take over otherwise).
window.addEventListener(
  'keydown',
  (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      void fileManager.save();
    } else if (key === 'o' && !e.shiftKey) {
      e.preventDefault();
      void fileManager.open();
    }
  },
  { capture: true },
);

/** Touch every math node (same attrs) so node views re-render with new macros. */
function refreshMathNodes() {
  let tr = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'math_inline' || node.type.name === 'math_display') {
      tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs });
    }
    return true;
  });
  if (tr.steps.length) {
    tr.setMeta('addToHistory', false);
    view.dispatch(tr);
  }
}

let messageTimer = 0;
function showMessage(text: string, action?: { label: string; run: () => void }) {
  toastEl.textContent = text;
  toastEl.classList.toggle('actionable', !!action);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      toastEl.classList.remove('show');
      toastEl.hidden = true;
      action.run();
    });
    toastEl.appendChild(btn);
  }
  toastEl.hidden = false;
  toastEl.classList.add('show');
  clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => {
    toastEl.classList.remove('show');
    window.setTimeout(() => (toastEl.hidden = true), 250);
  }, action ? 8000 : 3500);
}

function updateStatus() {
  const words = view.state.doc.textBetween(0, view.state.doc.content.size, ' ', ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  const pages = pageCount ? `${pageCount} p · ` : '';
  hudEl.textContent = `${pages}${words} words`;
  hudEl.title = lastStats ? `layout oracle: ${lastStats.ms.toFixed(1)} ms for ${lastStats.lines} lines` : '';
}
updateStatus();

view.focus();

// Handy for debugging and scripted testing. Never expose the editor or file
// handles in the production bundle: imported content belongs to the document,
// not to a global scripting API.
declare global {
  interface Window {
    view: EditorView;
  }
}
if (import.meta.env.DEV) {
  window.view = view;
  // Test hooks: adopt a directory handle (e.g. OPFS) as the project folder,
  // and run the app-instance embedded-figure migration (dynamic imports in a
  // test page can hit a second module instance under vite HMR).
  (window as unknown as { __fm: FileManager }).__fm = fileManager;
  (window as unknown as { __migrateEmbedded: () => Promise<void> }).__migrateEmbedded = () =>
    migrateEmbeddedFigures(view);
}
