// Figures: node view, insertion (toolbar / paste / drop), caption behavior.

import { Plugin, NodeSelection, TextSelection, type Command } from 'prosemirror-state';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { scheduleTypeset, invalidatePageLayout } from './typeset-plugin';
import type { FileManager } from './file-manager';
import {
  allowRemoteImageOrigin,
  isRemoteSource,
  loadRemoteImage,
  onRemoteImagePermissionChange,
  remoteImageStatus,
  retryRemoteImage,
  sanitizeSvgImage,
} from './remote-images';

// ---------- project assets (relative paths) ----------

let fmRef: FileManager | null = null;

export function setFigureFileManager(fm: FileManager) {
  fmRef = fm;
}

export const isPathSrc = (src: string) => !!src && !/^(data:|blob:)/i.test(src) && !isRemoteSource(src);

/** path → object URL, keyed by mtime so rewrites refresh. */
const assetCache = new Map<string, { mtime: number; url: string }>();
const embeddedSvgCache = new Map<string, Promise<string | null>>();

async function assetUrl(path: string): Promise<string | null> {
  if (!fmRef) return null;
  const file = await fmRef.readAsset(path);
  if (!file) return null;
  const cached = assetCache.get(path);
  if (cached && cached.mtime === file.mtime) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const type = file.type || (/\.svg$/i.test(path) ? 'image/svg+xml' : 'image/png');
  let data = file.data;
  if (type === 'image/svg+xml' || /\.svg$/i.test(path)) {
    try {
      data = sanitizeSvgImage(file.data);
    } catch {
      return null;
    }
  }
  const url = URL.createObjectURL(new Blob([data.slice().buffer], { type }));
  assetCache.set(path, { mtime: file.mtime, url });
  return url;
}

const ASSET_EVENT = 'typeset-assets-changed';

function dataUrlBytes(src: string): { blob: Blob; ext: string } | null {
  const m = /^data:image\/(png|jpe?g|gif|svg\+xml)((?:;[^,]*)*),(.*)$/is.exec(src);
  if (!m) return null;
  const ext = m[1] === 'svg+xml' ? 'svg' : m[1] === 'jpeg' ? 'jpg' : m[1];
  const mime = `image/${m[1]}`;
  if (/(?:^|;)base64(?:;|$)/i.test(m[2])) {
    const bin = atob(m[3]);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return { blob: new Blob([data.buffer], { type: mime }), ext };
  }
  return { blob: new Blob([decodeURIComponent(m[3])], { type: mime }), ext };
}

/** Data-SVG images can themselves contain remote subresources. Sanitize them
 * into a blob URL before display; ordinary raster data URLs remain direct. */
function embeddedDisplayUrl(src: string): Promise<string | null> {
  if (/^blob:/i.test(src)) return Promise.resolve(src);
  if (!/^data:/i.test(src)) return Promise.resolve(src);
  let decoded: ReturnType<typeof dataUrlBytes> = null;
  try {
    decoded = dataUrlBytes(src);
  } catch {
    return Promise.resolve(null);
  }
  if (!decoded) return Promise.resolve(null);
  if (decoded.ext !== 'svg') return Promise.resolve(src);
  const existing = embeddedSvgCache.get(src);
  if (existing) return existing;
  const pending = (async () => {
    const clean = sanitizeSvgImage(new Uint8Array(await decoded.blob.arrayBuffer()));
    return URL.createObjectURL(new Blob([clean.slice().buffer], { type: 'image/svg+xml' }));
  })().catch(() => null);
  embeddedSvgCache.set(src, pending);
  return pending;
}

/** Write every embedded (data-URL) figure out to figures/ and swap the
 *  document to file references. Called when a document becomes a project. */
export async function migrateEmbeddedFigures(view: EditorView) {
  if (!fmRef?.inFolder) return;
  const found: Array<{ pos: number; src: string }> = [];
  view.state.doc.descendants((n, pos) => {
    if (n.type.name === 'figure' && /^data:/.test(n.attrs.src as string)) found.push({ pos, src: n.attrs.src as string });
    return true;
  });
  if (!found.length) return;
  const moves: Array<{ pos: number; path: string }> = [];
  let n = 0;
  for (const f of found) {
    let decoded: ReturnType<typeof dataUrlBytes> = null;
    try {
      decoded = dataUrlBytes(f.src);
    } catch {
      // Preserve malformed embedded content in the document; do not abort
      // migration of the remaining valid figures.
    }
    if (!decoded) continue;
    n++;
    const name = (view.state.doc.nodeAt(f.pos)?.attrs.name as string) || `embedded-${n}.${decoded.ext}`;
    const path = projectImagePath(name.includes('.') ? name : `${name}.${decoded.ext}`);
    if (await fmRef.writeAsset(path, decoded.blob)) moves.push({ pos: f.pos, path });
  }
  if (!moves.length) return;
  let tr = view.state.tr;
  for (const m of moves) {
    const node = tr.doc.nodeAt(m.pos);
    if (node?.type.name === 'figure') tr = tr.setNodeMarkup(m.pos, undefined, { ...node.attrs, src: m.path });
  }
  view.dispatch(tr);
  fmRef.notify(`${moves.length} embedded image${moves.length === 1 ? '' : 's'} moved to figures/`);
}

/**
 * Poll referenced images for on-disk changes (FSA has no watcher): the
 * regenerate-the-plot → alt-tab loop updates figures live. Checks on window
 * focus and every few seconds while a project folder is open.
 */
let assetCheck: (() => void) | null = null;

/** Re-check project assets now (e.g. right after a folder is attached)
 *  instead of waiting out the watch interval. */
export function refreshAssets() {
  assetCheck?.();
}

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
  assetCheck = () => void check();
}

export class FigureView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private img: HTMLImageElement;
  private chip: HTMLButtonElement;
  private pathChip: HTMLButtonElement;
  private sourceVersion = 0;
  private unsubscribeRemote: () => void;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('figure');
    this.dom.className = 'ts-figure';

    this.img = document.createElement('img');
    this.img.alt = '';
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
      this.activatePathChip();
    });
    this.updatePathChip();

    this.contentDOM = document.createElement('figcaption');
    this.dom.append(this.img, this.chip, this.pathChip, this.contentDOM);
    this.unsubscribeRemote = onRemoteImagePermissionChange(this.onRemotePermission);
    this.setSrc(node.attrs.src as string);
  }

  private updatePathChip() {
    const src = this.node.attrs.src as string;
    const remote = remoteImageStatus(src);
    this.pathChip.classList.remove('embedded', 'remote', 'remote-allowed', 'remote-invalid', 'remote-error');
    if (remote) {
      if (remote.reason) {
        this.pathChip.textContent = `blocked: ${remote.host}`;
        this.pathChip.title = remote.reason;
        this.pathChip.classList.add('remote-invalid');
      } else if (!remote.allowed) {
        this.pathChip.textContent = `load from ${remote.host}`;
        this.pathChip.title = `Blocked for privacy — click to allow ${remote.origin} for this session`;
        this.pathChip.classList.add('remote');
      } else {
        this.pathChip.textContent = `remote: ${remote.host}`;
        this.pathChip.title = `Remote images from ${remote.origin} are allowed for this session`;
        this.pathChip.classList.add('remote-allowed');
      }
    } else if (isPathSrc(src)) {
      this.pathChip.textContent = src;
      this.pathChip.title = 'The image file this figure references — click to change';
    } else {
      this.pathChip.textContent = 'embedded';
      this.pathChip.classList.add('embedded');
      this.pathChip.title = fmRef?.inFolder
        ? 'Stored inside the document — click to reference a project file instead'
        : 'Stored inside the document — open a project folder (Project button) to use file paths';
    }
  }

  private activatePathChip() {
    const src = this.node.attrs.src as string;
    const remote = remoteImageStatus(src);
    if (!remote) {
      this.editPath();
      return;
    }
    if (remote.reason) {
      fmRef?.notify(remote.reason);
      return;
    }
    if (remote.allowed) {
      if (this.dom.classList.contains('fig-missing')) {
        retryRemoteImage(src);
        this.setSrc(src);
        invalidatePageLayout(this.view);
        return;
      }
      fmRef?.notify(`Remote images from ${remote.origin} are allowed for this session`);
      return;
    }
    const granted = allowRemoteImageOrigin(src);
    if (granted.allowed) {
      fmRef?.notify(`Loading remote images from ${granted.origin} for this session`);
      invalidatePageLayout(this.view);
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

  private onRemotePermission = (origin: string) => {
    const remote = remoteImageStatus(this.node.attrs.src as string);
    if (remote?.origin !== origin) return;
    this.updatePathChip();
    this.setSrc(this.node.attrs.src as string);
  };

  /** Embedded data loads directly; project and explicitly approved remote
   *  sources resolve to object URLs. Unapproved remotes remain inert. */
  private setSrc(src: string) {
    const version = ++this.sourceVersion;
    this.dom.classList.remove('fig-missing', 'fig-remote-blocked', 'fig-remote-loading');
    delete this.dom.dataset.placeholder;

    const remote = remoteImageStatus(src);
    if (remote) {
      this.img.removeAttribute('src');
      this.dom.classList.add('fig-missing', 'fig-remote-blocked');
      if (remote.reason) {
        this.dom.dataset.placeholder = remote.reason;
        scheduleTypeset(this.view);
        return;
      }
      if (!remote.allowed) {
        this.dom.dataset.placeholder = `Remote image blocked — click “load from ${remote.host}” to allow it`;
        scheduleTypeset(this.view);
        return;
      }
      this.dom.classList.add('fig-remote-loading');
      this.dom.dataset.placeholder = `Loading remote image from ${remote.host}…`;
      void loadRemoteImage(src).then(
        (asset) => {
          if (version !== this.sourceVersion || this.node.attrs.src !== src) return;
          this.dom.classList.remove('fig-missing', 'fig-remote-blocked', 'fig-remote-loading');
          delete this.dom.dataset.placeholder;
          this.img.src = asset.objectUrl;
          this.updatePathChip();
          invalidatePageLayout(this.view);
        },
        (error) => {
          if (version !== this.sourceVersion || this.node.attrs.src !== src) return;
          this.dom.classList.remove('fig-remote-loading');
          this.dom.dataset.placeholder = `Remote image could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
          this.pathChip.textContent = `retry from ${remote.host}`;
          this.pathChip.title = 'The previous remote image load failed — click to retry';
          this.pathChip.classList.add('remote-error');
          fmRef?.notify(this.dom.dataset.placeholder);
          scheduleTypeset(this.view);
        },
      );
      return;
    }

    if (!src) {
      this.img.removeAttribute('src');
      this.dom.classList.add('fig-missing');
      this.dom.dataset.placeholder = 'missing image source';
      scheduleTypeset(this.view);
      return;
    }
    if (!isPathSrc(src)) {
      void embeddedDisplayUrl(src).then((url) => {
        if (version !== this.sourceVersion || this.node.attrs.src !== src) return;
        if (url) this.img.src = url;
        else {
          this.dom.classList.add('fig-missing');
          this.dom.dataset.placeholder = 'embedded SVG could not be sanitized';
          scheduleTypeset(this.view);
        }
      });
      return;
    }
    this.img.removeAttribute('src');
    void assetUrl(src).then((url) => {
      if (version !== this.sourceVersion || this.node.attrs.src !== src) return;
      if (url) {
        this.dom.classList.remove('fig-missing');
        delete this.dom.dataset.placeholder;
        if (this.img.src !== url) this.img.src = url;
      } else {
        this.dom.classList.add('fig-missing');
        this.img.removeAttribute('src');
        this.dom.dataset.placeholder = `missing: ${src}`;
        scheduleTypeset(this.view);
      }
    });
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const sourceChanged = node.attrs.src !== this.node.attrs.src;
    this.node = node;
    if (sourceChanged) this.setSrc(node.attrs.src as string);
    this.updateChip();
    this.updatePathChip();
    return true;
  }

  destroy() {
    window.removeEventListener(ASSET_EVENT, this.onAssets);
    this.unsubscribeRemote();
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

/** Inline images use the same privacy and asset-resolution boundary as
 * figures. A wrapper provides a visible consent/error control without ever
 * assigning an unapproved URL to an <img> element. */
export class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private action: HTMLButtonElement;
  private sourceVersion = 0;
  private unsubscribeRemote: () => void;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('span');
    this.dom.className = 'ts-inline-image';
    this.dom.contentEditable = 'false';

    this.img = document.createElement('img');
    this.img.addEventListener('load', () => scheduleTypeset(this.view));
    this.img.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const pos = this.getPos();
      if (pos !== undefined) {
        this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
        this.view.focus();
      }
    });

    this.action = document.createElement('button');
    this.action.type = 'button';
    this.action.className = 'inline-image-action';
    this.action.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.activate();
    });

    this.dom.append(this.img, this.action);
    window.addEventListener(ASSET_EVENT, this.onAssets);
    this.unsubscribeRemote = onRemoteImagePermissionChange(this.onRemotePermission);
    this.updateAttributes();
    this.setSrc(node.attrs.src as string);
  }

  private updateAttributes() {
    this.img.alt = (this.node.attrs.alt as string | null) ?? '';
    this.img.title = (this.node.attrs.title as string | null) ?? '';
  }

  private showMessage(message: string, actionable = false) {
    this.action.textContent = message;
    this.action.disabled = !actionable;
    this.dom.classList.add('inline-image-missing');
    this.dom.classList.toggle('inline-image-remote', actionable);
  }

  private setSrc(src: string) {
    const version = ++this.sourceVersion;
    this.dom.classList.remove('inline-image-missing', 'inline-image-remote');
    this.img.removeAttribute('src');

    const remote = remoteImageStatus(src);
    if (remote) {
      if (remote.reason) {
        this.showMessage(remote.reason);
        return;
      }
      if (!remote.allowed) {
        this.showMessage(`Load image from ${remote.host}`, true);
        return;
      }
      this.showMessage(`Loading image from ${remote.host}…`);
      void loadRemoteImage(src).then(
        (asset) => {
          if (version !== this.sourceVersion || this.node.attrs.src !== src) return;
          this.dom.classList.remove('inline-image-missing', 'inline-image-remote');
          this.img.src = asset.objectUrl;
          invalidatePageLayout(this.view);
        },
        (error) => {
          if (version !== this.sourceVersion || this.node.attrs.src !== src) return;
          this.showMessage(`Retry remote image: ${error instanceof Error ? error.message : String(error)}`, true);
          scheduleTypeset(this.view);
        },
      );
      return;
    }

    if (!src) {
      this.showMessage('missing image source');
      return;
    }
    if (!isPathSrc(src)) {
      void embeddedDisplayUrl(src).then((url) => {
        if (version !== this.sourceVersion || this.node.attrs.src !== src) return;
        if (url) this.img.src = url;
        else {
          this.showMessage('embedded SVG could not be sanitized');
          scheduleTypeset(this.view);
        }
      });
      return;
    }
    void assetUrl(src).then((url) => {
      if (version !== this.sourceVersion || this.node.attrs.src !== src) return;
      if (url) {
        this.dom.classList.remove('inline-image-missing');
        this.img.src = url;
      } else {
        this.showMessage(`missing: ${src}`);
        scheduleTypeset(this.view);
      }
    });
  }

  private activate() {
    const src = this.node.attrs.src as string;
    const remote = remoteImageStatus(src);
    if (!remote || remote.reason) {
      if (remote?.reason) fmRef?.notify(remote.reason);
      return;
    }
    if (remote.allowed) {
      retryRemoteImage(src);
      this.setSrc(src);
      invalidatePageLayout(this.view);
      return;
    }
    const granted = allowRemoteImageOrigin(src);
    if (granted.allowed) {
      fmRef?.notify(`Loading remote images from ${granted.origin} for this session`);
      invalidatePageLayout(this.view);
    }
  }

  private onAssets = () => {
    if (isPathSrc(this.node.attrs.src as string)) this.setSrc(this.node.attrs.src as string);
  };

  private onRemotePermission = (origin: string) => {
    const remote = remoteImageStatus(this.node.attrs.src as string);
    if (remote?.origin === origin) this.setSrc(this.node.attrs.src as string);
  };

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const sourceChanged = node.attrs.src !== this.node.attrs.src;
    this.node = node;
    this.updateAttributes();
    if (sourceChanged) this.setSrc(node.attrs.src as string);
    return true;
  }

  destroy() {
    window.removeEventListener(ASSET_EVENT, this.onAssets);
    this.unsubscribeRemote();
  }

  stopEvent(event: Event) {
    return event.target === this.action;
  }

  ignoreMutation() {
    return true;
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
  reader.onload = () => {
    insertFigureNode(view, String(reader.result), file.name);
    // Nudge toward the file-based workflow (the embedded copy is frozen at
    // paste time; a project keeps it a living file).
    if (fmRef && typeof window.showDirectoryPicker === 'function') {
      fmRef.notifyAction('Image embedded in the document', {
        label: 'Save as project',
        run: () => void fmRef?.openFolder('save'),
      });
    }
  };
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
