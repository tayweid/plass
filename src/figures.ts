// Figures: node view, insertion (toolbar / paste / drop), caption behavior.

import { Plugin, NodeSelection, TextSelection, type Command } from 'prosemirror-state';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { scheduleTypeset, invalidatePageLayout } from './typeset-plugin';
import type { FileManager } from './file-manager';

// ---------- project assets (relative paths) ----------

let fmRef: FileManager | null = null;

export function setFigureFileManager(fm: FileManager) {
  fmRef = fm;
}

const isPathSrc = (src: string) => !!src && !/^(data:|https?:|blob:)/.test(src);

/** path → object URL, keyed by mtime so rewrites refresh. */
const assetCache = new Map<string, { mtime: number; url: string }>();

async function assetUrl(path: string): Promise<string | null> {
  if (!fmRef) return null;
  const file = await fmRef.readAsset(path);
  if (!file) return null;
  const cached = assetCache.get(path);
  if (cached && cached.mtime === file.mtime) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(new Blob([file.data.slice().buffer], { type: file.type || 'image/png' }));
  assetCache.set(path, { mtime: file.mtime, url });
  return url;
}

const ASSET_EVENT = 'typeset-assets-changed';

/**
 * Poll referenced images for on-disk changes (FSA has no watcher): the
 * regenerate-the-plot → alt-tab loop updates figures live. Checks on window
 * focus and every few seconds while a project folder is open.
 */
export function startAssetWatch(view: EditorView) {
  const check = async () => {
    if (!fmRef?.inFolder) return;
    const paths = new Set<string>();
    view.state.doc.descendants((n) => {
      if (n.type.name === 'figure' && isPathSrc(n.attrs.src as string)) paths.add(n.attrs.src as string);
      return true;
    });
    let changed = false;
    for (const path of paths) {
      const file = await fmRef.readAsset(path);
      if (!file) continue;
      const cached = assetCache.get(path);
      if (!cached || cached.mtime !== file.mtime) changed = true;
    }
    if (changed) {
      window.dispatchEvent(new CustomEvent(ASSET_EVENT));
      invalidatePageLayout(view);
    }
  };
  window.addEventListener('focus', () => void check());
  window.setInterval(() => void check(), 4000);
}

export class FigureView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private img: HTMLImageElement;
  private chip: HTMLButtonElement;
  private pathChip: HTMLButtonElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('figure');
    this.dom.className = 'ts-figure';

    this.img = document.createElement('img');
    this.img.alt = '';
    this.setSrc(node.attrs.src as string);
    this.img.addEventListener('load', () => scheduleTypeset(this.view));
    window.addEventListener(ASSET_EVENT, this.onAssets);
    // Click the image to select the whole figure.
    this.img.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos !== undefined) {
        this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
        this.view.focus();
      }
    });

    this.chip = document.createElement('button');
    this.chip.type = 'button';
    this.chip.className = 'fig-label-chip';
    this.chip.contentEditable = 'false';
    this.chip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.editLabel();
    });
    this.updateChip();

    this.pathChip = document.createElement('button');
    this.pathChip.type = 'button';
    this.pathChip.className = 'fig-path-chip';
    this.pathChip.contentEditable = 'false';
    this.pathChip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.editPath();
    });
    this.updatePathChip();

    this.contentDOM = document.createElement('figcaption');
    this.dom.append(this.img, this.chip, this.pathChip, this.contentDOM);
  }

  private updatePathChip() {
    const src = this.node.attrs.src as string;
    if (isPathSrc(src)) {
      this.pathChip.textContent = src;
      this.pathChip.title = 'The image file this figure references — click to change';
      this.pathChip.classList.remove('embedded');
    } else {
      this.pathChip.textContent = 'embedded';
      this.pathChip.classList.add('embedded');
      this.pathChip.title = fmRef?.inFolder
        ? 'Stored inside the document — click to reference a project file instead'
        : 'Stored inside the document — open a project folder (Project button) to use file paths';
    }
  }

  private editPath() {
    if (!fmRef?.inFolder && !isPathSrc(this.node.attrs.src as string)) {
      fmRef?.notify('Open a project folder first (Project button) — then figures can reference files by path');
      return;
    }
    const src = this.node.attrs.src as string;
    const input = document.createElement('input');
    input.className = 'fig-path-input';
    input.value = isPathSrc(src) ? src : 'figures/';
    input.placeholder = 'figures/plot.svg';
    input.spellcheck = false;
    this.pathChip.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      input.replaceWith(this.pathChip);
      const path = input.value.trim().replace(/^\.?\//, '');
      if (commit && path && path !== src) {
        const pos = this.getPos();
        if (pos !== undefined) {
          this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, src: path }));
          if (fmRef?.inFolder) {
            void fmRef.readAsset(path).then((f) => {
              if (!f) fmRef?.notify(`No file at ${path} yet — the figure will fill in when it appears`);
            });
          }
        }
      }
      this.view.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  private updateChip() {
    const label = this.node.attrs.label as string;
    this.chip.textContent = label ? `@${label}` : '+ label';
    this.chip.title = label
      ? `Reference this figure by typing @${label} — click to change`
      : 'Add a label so you can reference this figure with @label';
    this.chip.classList.toggle('empty', !label);
  }

  private editLabel() {
    const input = document.createElement('input');
    input.className = 'fig-label-input';
    input.value = this.node.attrs.label;
    input.placeholder = 'fig:label';
    input.spellcheck = false;
    this.chip.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      input.replaceWith(this.chip);
      if (commit) {
        const label = input.value.trim().replace(/[^a-zA-Z0-9:._-]/g, '-');
        const pos = this.getPos();
        if (pos !== undefined && label !== this.node.attrs.label) {
          this.view.dispatch(
            this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, label }),
          );
        }
      }
      this.view.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  private onAssets = () => {
    if (isPathSrc(this.node.attrs.src as string)) this.setSrc(this.node.attrs.src as string);
  };

  /** Data/remote srcs load directly; project paths resolve through the
   *  folder handle to an object URL (missing file → placeholder). */
  private setSrc(src: string) {
    if (!isPathSrc(src)) {
      this.img.src = src;
      this.dom.classList.remove('fig-missing');
      return;
    }
    void assetUrl(src).then((url) => {
      if (this.node.attrs.src !== src) return;
      if (url) {
        this.dom.classList.remove('fig-missing');
        if (this.img.src !== url) this.img.src = url;
      } else {
        this.dom.classList.add('fig-missing');
        this.img.removeAttribute('src');
        this.dom.dataset.missingPath = src;
        scheduleTypeset(this.view);
      }
    });
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    if (node.attrs.src !== this.node.attrs.src) this.setSrc(node.attrs.src as string);
    this.node = node;
    this.updateChip();
    this.updatePathChip();
    return true;
  }

  destroy() {
    window.removeEventListener(ASSET_EVENT, this.onAssets);
  }

  selectNode() {
    this.dom.classList.add('figure-selected');
  }

  deselectNode() {
    this.dom.classList.remove('figure-selected');
  }

  stopEvent(e: Event) {
    // Events on the label chip/input are ours, not the editor's.
    return (
      e.target instanceof HTMLElement &&
      !!e.target.closest('.fig-label-chip, .fig-label-input, .fig-path-chip, .fig-path-input')
    );
  }

  ignoreMutation(m: ViewMutationRecord) {
    return !this.contentDOM.contains(m.target);
  }
}

/** Enter inside a caption exits to a fresh paragraph after the figure. */
export const exitFigure: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type !== schema.nodes.figure) return false;
  if (dispatch) {
    const after = $from.after();
    const tr = state.tr.insert(after, schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

function insertFigureNode(view: EditorView, src: string, name: string) {
  const node = schema.nodes.figure.create({ src, name });
  let tr = view.state.tr.replaceSelectionWith(node);
  // Put the caret in the (empty) caption.
  let capPos = -1;
  tr.doc.descendants((n, p) => {
    if (capPos < 0 && n === node) capPos = p + 1;
    return capPos < 0;
  });
  if (capPos >= 0) tr = tr.setSelection(TextSelection.create(tr.doc, capPos));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** A collision-safe figures/ path for a new project image. */
function projectImagePath(name: string) {
  const clean = name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+/, '') || 'image.png';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const dot = clean.lastIndexOf('.');
  return dot > 0
    ? `figures/${clean.slice(0, dot)}-${stamp}${clean.slice(dot)}`
    : `figures/${clean}-${stamp}`;
}

export function insertFigureFromFile(view: EditorView, file: File) {
  // Folder mode: the file on disk is the source of truth from the first
  // moment — write it into figures/ and reference it by relative path.
  if (fmRef?.inFolder) {
    const path = projectImagePath(file.name);
    void fmRef.writeAsset(path, file).then((ok) => {
      if (ok) insertFigureNode(view, path, file.name);
      else fmRef?.notify('Could not write the image into the project folder');
    });
    return;
  }
  const reader = new FileReader();
  reader.onload = () => insertFigureNode(view, String(reader.result), file.name);
  reader.readAsDataURL(file);
}

export function pickAndInsertFigure(view: EditorView) {
  // In a project, prefer the FSA picker: a file already inside the folder is
  // referenced in place (no copy).
  if (fmRef?.inFolder && typeof window.showOpenFilePicker === 'function') {
    void (async () => {
      try {
        const [handle] = await window.showOpenFilePicker!({
          types: [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.svg'] } }],
        });
        const rel = await fmRef!.relativize(handle);
        if (rel) {
          insertFigureNode(view, rel, handle.name);
        } else {
          insertFigureFromFile(view, await handle.getFile());
        }
      } catch (e) {
        if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
      }
    })();
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) insertFigureFromFile(view, file);
  });
  input.click();
}

/** Paste or drop image files to create figures. */
export function figuresPlugin() {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        for (const file of files) insertFigureFromFile(view, file);
        return true;
      },
      handleDrop(view, event) {
        const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (at) {
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
        }
        for (const file of files) insertFigureFromFile(view, file);
        return true;
      },
    },
  });
}
