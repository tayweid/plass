import 'katex/dist/katex.min.css';
import './style.css';

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history } from 'prosemirror-history';
import { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { baseKeys, buildInputRules, buildKeymap } from './editing';
import { typesetPlugin, type PageInfo, type TypesetStats } from './typeset-plugin';
import { MathView } from './math';
import { demoDoc } from './demo-doc';
import { buildToolbar, type Toolbar } from './toolbar';
import { TablePreviewView } from './table-preview';
import { equationsPlugin } from './equations';
import { FigureView, figuresPlugin, migrateEmbeddedFigures, setFigureFileManager, startAssetWatch } from './figures';
import { FootnoteView, footnoteMarkerClick } from './footnotes';
import { BibliographyView, citationsPlugin } from './citations';
import { refAutocomplete } from './ref-autocomplete';
import { applySettings, formatPageNumber, getSettings } from './settings';
import { FileManager } from './file-manager';

const STORAGE_KEY = 'typeset-doc-v1';

function loadDoc(): PMNode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return PMNode.fromJSON(schema, JSON.parse(raw));
  } catch (e) {
    console.warn('Could not restore saved document, starting fresh.', e);
  }
  return demoDoc();
}

let saveTimer = 0;
function scheduleSave(view: EditorView) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(view.state.doc.toJSON()));
    } catch (e) {
      console.warn('Autosave failed.', e);
    }
  }, 400);
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
      typesetPlugin({ onStats, onPages: renderPages }),
    ],
  });
}

const editorEl = document.getElementById('editor')!;
const toolbarEl = document.getElementById('toolbar')!;
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
  const sig = `${info.count}:${info.pageH}:${info.marginBottom}:${info.marginLeft}:${info.marginRight}:${s.pageNumShow}:${s.pageNumFormat}:${s.pageNumAlign}:${s.pageNumStart}`;
  if (sig !== pageSignature) {
    pageSignature = sig;
    const frag = document.createDocumentFragment();
    for (let k = 0; k < info.count; k++) {
      const top = k * (info.pageH + info.gap);
      const box = document.createElement('div');
      box.className = 'page-box';
      box.style.top = `${top}px`;
      frag.appendChild(box);
      if (s.pageNumShow) {
        const num = document.createElement('div');
        num.className = 'page-num';
        // Typst's folio: centered one third of the margin below the content.
        num.style.top = `${top + info.pageH - (2 / 3) * info.marginBottom - 0.55 * s.sizePt * (4 / 3)}px`;
        num.style.textAlign = s.pageNumAlign;
        num.style.padding = `0 ${info.marginRight}px 0 ${info.marginLeft}px`;
        num.textContent = formatPageNumber(s, k + 1, info.count);
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

const view = new EditorView(editorEl, {
  state: makeState(loadDoc(), onStats),
  nodeViews: {
    math_inline: (node, v, getPos) => new MathView(node, v, getPos),
    math_display: (node, v, getPos) => new MathView(node, v, getPos),
    figure: (node, v, getPos) => new FigureView(node, v, getPos),
    footnote: (node) => new FootnoteView(node),
    bibliography: (node, v) => new BibliographyView(node, v),
    table: (node, v, getPos) => new TablePreviewView(node, v, getPos),
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
      chromeRecede();
    }
  },
});

// Chrome recedes while typing; any mouse movement brings it back.
function chromeRecede() {
  document.body.classList.add('typing');
}
window.addEventListener(
  'mousemove',
  () => {
    document.body.classList.remove('typing');
  },
  { passive: true },
);

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
    document.title = `${fileManager.name}${fileManager.dirty ? ' •' : ''} — Typeset`;
  },
  message: showMessage,
  messageAction: showMessage,
  onProjectKept: () => void migrateEmbeddedFigures(view),
});

toolbar = buildToolbar(toolbarEl, view, fileManager);
setFigureFileManager(fileManager);
startAssetWatch(view);
void import('./pdf').then(({ setAssetReader }) =>
  setAssetReader(async (path) => (await fileManager.readAsset(path))?.data ?? null),
);
toolbar.update(view.state);
toolbar.setFile(fileManager.name, fileManager.dirty);
applySettings(view.state);

// Reconnect to the last open file if the browser still grants access.
void fileManager.restoreLast();

// App-level shortcuts (the browser's defaults would take over otherwise).
window.addEventListener(
  'keydown',
  (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      void (e.shiftKey ? fileManager.saveAs() : fileManager.save());
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

// Handy for debugging and scripted testing.
declare global {
  interface Window {
    view: EditorView;
  }
}
window.view = view;
// Test hooks: adopt a directory handle (e.g. OPFS) as the project folder,
// and run the app-instance embedded-figure migration (dynamic imports in a
// test page can hit a second module instance under vite HMR).
(window as unknown as { __fm: FileManager }).__fm = fileManager;
(window as unknown as { __migrateEmbedded: () => Promise<void> }).__migrateEmbedded = () =>
  migrateEmbeddedFigures(view);
