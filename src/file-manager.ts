// Real files: open/save .typ documents on disk.
//
// Chromium: File System Access API — Open/Save/Save As with real handles,
// silent autosave to the open file, recents persisted in IndexedDB (file
// handles are structured-cloneable), and automatic reconnection to the last
// file when the browser still grants permission.
// Safari/Firefox fallback: open via <input type=file>, save via download.
//
// The on-disk format is .typ (the serializer's output); opening runs the
// importer, which preserves unrecognized Typst verbatim as raw islands — so
// open + save never destroys content we don't model.

import type { Node as PMNode } from 'prosemirror-model';
import { docToTyp } from './typ-serializer';
import { typToDoc } from './typ-parser';

export interface FileHooks {
  getDoc: () => PMNode;
  /** Replace the editor document (fresh state: history resets). */
  setDoc: (doc: PMNode) => void;
  emptyDoc: () => PMNode;
  /** Name/dirty changed — update chrome. */
  onState: () => void;
  message: (text: string) => void;
  /** Toast with a click action. */
  messageAction?: (text: string, action: { label: string; run: () => void }) => void;
  /** The current document just became a fresh project (folder adopted,
   *  document kept) — migrate embedded figures etc. */
  onProjectKept?: () => void;
}

export interface RecentEntry {
  name: string;
  time: number;
  handle: FileSystemFileHandle;
  /** Project folder the file lives in (folder mode). */
  dir?: FileSystemDirectoryHandle;
}

// ONE picker type covering both formats: multiple entries become an
// either/or filter dropdown in Chrome's dialog (defaulting to the first,
// which greys the other format out); a single entry keeps .typ and .md
// selectable together.
const TYP_TYPE: FilePickerType[] = [
  {
    description: 'Plass documents (.typ, .md)',
    accept: { 'text/plain': ['.typ'], 'text/markdown': ['.md'] },
  },
];

const isMd = (name: string) => /\.md$/i.test(name);

export class FileManager {
  handle: FileSystemFileHandle | null = null;
  /** Project folder: relative asset paths resolve inside it. */
  dir: FileSystemDirectoryHandle | null = null;
  name = 'Untitled';
  dirty = false;
  readonly supportsFS = typeof window.showOpenFilePicker === 'function';
  private saveTimer = 0;
  /** Last-session file awaiting a permission re-grant (browsers downgrade
   *  stored handles to 'prompt' across reloads; re-requesting needs a
   *  user gesture). The session doc on screen IS this file's latest state. */
  private pendingRestore: { handle: FileSystemFileHandle; dir: FileSystemDirectoryHandle | null } | null = null;

  constructor(private hooks: FileHooks) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });
  }

  /** Call on every document change: marks dirty, schedules a disk autosave. */
  noteChange() {
    if (!this.dirty) {
      this.dirty = true;
      this.hooks.onState();
    }
    if (this.handle) {
      clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => void this.flush(), 1200);
    }
  }

  private async flush() {
    if (!this.handle || !this.dirty) return;
    try {
      await this.write(this.handle);
      this.dirty = false;
      this.hooks.onState();
    } catch (e) {
      console.warn('Autosave to file failed', e);
    }
  }

  private async write(handle: FileSystemFileHandle) {
    const w = await handle.createWritable();
    await w.write(await this.serialize(handle.name));
    await w.close();
  }

  /** The on-disk text for the current doc in the handle's format. */
  private async serialize(fileName: string): Promise<string> {
    if (isMd(fileName)) {
      const { docToMd } = await import('./md-serializer');
      const warned = new Set<string>();
      const text = docToMd(this.hooks.getDoc(), (m) => warned.add(m));
      // Lossy-save notices, once per distinct message per save.
      for (const m of warned) this.hooks.message(m);
      return text;
    }
    return docToTyp(this.hooks.getDoc());
  }

  /** Start a fresh unsaved document (empty, or the given content e.g. the demo). */
  newDoc(doc?: PMNode, name = 'Untitled') {
    this.handle = null;
    this.dir = null;
    this.name = name;
    this.dirty = false;
    this.hooks.setDoc(doc ?? this.hooks.emptyDoc());
    this.hooks.onState();
    void idbSet('last', null);
  }

  async open() {
    if (!this.supportsFS) {
      this.openViaInput();
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker!({ types: TYP_TYPE });
      await this.loadHandle(handle);
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
    }
  }

  async loadHandle(handle: FileSystemFileHandle, dir: FileSystemDirectoryHandle | null = null) {
    const file = await handle.getFile();
    const text = await file.text();
    const { doc, warnings } = isMd(file.name)
      ? (await import('./md-parser')).mdToDoc(text)
      : typToDoc(text);
    this.handle = handle;
    this.dir = dir;
    this.name = file.name.replace(/\.(typ|md)$/i, '');
    this.dirty = false;
    this.hooks.setDoc(doc);
    this.hooks.onState();
    const where = dir ? `${dir.name}/${file.name}` : file.name;
    this.hooks.message(
      warnings.length
        ? `Opened ${where} — ${warnings.length} block(s) preserved as raw Typst`
        : `Opened ${where}`,
    );
    try {
      await addRecent(handle, file.name, dir);
      await idbSet('last', dir ? { handle, dir } : handle);
    } catch (e) {
      console.warn('Could not persist file handle', e);
    }
  }

  // ---------- project folders ----------

  get inFolder(): boolean {
    return this.dir !== null;
  }

  /** Does the document have a home on disk yet? */
  get saved(): boolean {
    return this.handle !== null;
  }

  /** Open a directory as a project. intent 'open' loads the folder's
   *  document; intent 'save' gives the CURRENT document a home there. */
  async openFolder(intent: 'open' | 'save' = 'open'): Promise<'kept' | 'loaded' | null> {
    if (typeof window.showDirectoryPicker !== 'function') {
      this.hooks.message('Project folders need the File System Access API (Chrome/Edge)');
      return null;
    }
    try {
      const dir = await window.showDirectoryPicker!({ mode: 'readwrite' });
      return await this.adoptFolder(dir, intent);
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
      return null;
    }
  }

  /**
   * Adopt a folder. If it contains a .typ, open (the newest) one; if it is
   * a fresh folder, the CURRENT document moves in — that is how "make what
   * I'm writing into a project" works.
   */
  async adoptFolder(dir: FileSystemDirectoryHandle, intent: 'open' | 'save' = 'open'): Promise<'kept' | 'loaded' | null> {
    if (intent === 'open') {
      let best: { handle: FileSystemFileHandle; time: number } | null = null;
      for await (const entry of dir.values()) {
        if (entry.kind === 'file' && /\.(typ|md)$/i.test(entry.name)) {
          const f = await (entry as FileSystemFileHandle).getFile();
          if (!best || f.lastModified > best.time) best = { handle: entry as FileSystemFileHandle, time: f.lastModified };
        }
      }
      if (best) {
        if (this.dirty && !confirm(`Open ${best.handle.name} from this folder? Your current document has unsaved changes.`)) {
          return null;
        }
        await this.loadHandle(best.handle, dir);
        return 'loaded';
      }
    }
    // The current document moves in, keeping its shown name — an unsaved
    // doc labeled Untitled becomes Untitled.typ, matching the tab.
    const fileName = `${this.name}.typ`;
    if (intent === 'save') {
      let exists = false;
      try {
        await dir.getFileHandle(fileName);
        exists = true;
      } catch {
        /* not there — good */
      }
      if (exists && !confirm(`${fileName} already exists in this folder — overwrite it?`)) return null;
    }
    const handle = await dir.getFileHandle(fileName, { create: true });
    this.handle = handle;
    this.dir = dir;
    this.name = fileName.replace(/\.typ$/i, '');
    await this.write(handle);
    this.dirty = false;
    this.hooks.onState();
    this.hooks.message(`Saved — ${dir.name}/${fileName}`);
    try {
      await addRecent(handle, fileName, dir);
      await idbSet('last', { handle, dir });
    } catch (e) {
      console.warn('Could not persist file handle', e);
    }
    this.hooks.onProjectKept?.();
    return 'kept';
  }

  /** Attach the containing folder to the already-open file. File-handler
   *  launches (Finder double-click) deliver a bare file handle with no
   *  directory context, so relative asset paths can't resolve until the
   *  user grants the folder. The file must sit at the folder's top level —
   *  that is the project-root shape the rest of folder mode assumes. */
  async attachFolder(): Promise<boolean> {
    if (!this.handle || typeof window.showDirectoryPicker !== 'function') return false;
    try {
      const dir = await window.showDirectoryPicker!({ mode: 'readwrite' });
      const segs = await dir.resolve(this.handle);
      if (!segs || segs.length !== 1) {
        this.hooks.message(`That folder doesn't contain ${this.handle.name} at its top level`);
        return false;
      }
      this.dir = dir;
      this.hooks.onState();
      this.hooks.message(`Project folder attached — ${dir.name}/${this.handle.name}`);
      try {
        await addRecent(this.handle, this.handle.name, dir);
        await idbSet('last', { handle: this.handle, dir });
      } catch (e) {
        console.warn('Could not persist file handle', e);
      }
      return true;
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
      return false;
    }
  }

  private async walkTo(path: string): Promise<FileSystemFileHandle | null> {
    if (!this.dir) return null;
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || parts.some((seg) => seg === '..')) return null;
    let d = this.dir;
    for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]);
    return d.getFileHandle(parts[parts.length - 1]);
  }

  /** Read a project-relative asset (image). Null when absent/no folder. */
  async readAsset(path: string): Promise<{ data: Uint8Array; mtime: number; type: string } | null> {
    try {
      const h = await this.walkTo(path);
      if (!h) return null;
      const f = await h.getFile();
      return { data: new Uint8Array(await f.arrayBuffer()), mtime: f.lastModified, type: f.type };
    } catch {
      return null;
    }
  }

  /** Write bytes to a project-relative path, creating directories. */
  async writeAsset(path: string, data: Uint8Array | Blob): Promise<boolean> {
    try {
      if (!this.dir) return false;
      const parts = path.split('/').filter(Boolean);
      if (!parts.length || parts.some((seg) => seg === '..')) return false;
      let d = this.dir;
      for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i], { create: true });
      const h = await d.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await h.createWritable();
      await w.write(data instanceof Blob ? data : new Blob([data.slice().buffer]));
      await w.close();
      return true;
    } catch (e) {
      console.warn('writeAsset failed', e);
      return false;
    }
  }

  /** Project-relative path of a picked file when it lives inside the folder. */
  async relativize(handle: FileSystemFileHandle): Promise<string | null> {
    if (!this.dir) return null;
    try {
      const segs = await this.dir.resolve(handle);
      return segs ? segs.join('/') : null;
    } catch {
      return null;
    }
  }

  async save() {
    // A pending reconnect resolves here too — the click that asked to
    // save is the gesture the permission prompt needs.
    if (!this.handle && this.pendingRestore) {
      if (await this.completeRestore()) return;
    }
    if (this.handle) {
      try {
        await this.write(this.handle);
        this.dirty = false;
        this.hooks.onState();
        this.hooks.message(`Saved ${this.name}.typ`);
      } catch (e) {
        console.warn(e);
        this.hooks.message('Save failed');
      }
      return;
    }
    // First save: the paper gets a home. One question — where should it
    // live? — and the folder IS the project from then on.
    if (typeof window.showDirectoryPicker !== 'function') {
      this.exportCopy();
      return;
    }
    await this.openFolder('save');
  }

  /** Surface a transient status message. */
  notify(text: string) {
    this.hooks.message(text);
  }

  /** Toast with a click action (falls back to a plain message). */
  notifyAction(text: string, action: { label: string; run: () => void }) {
    if (this.hooks.messageAction) this.hooks.messageAction(text, action);
    else this.hooks.message(text);
  }

  /** Rename the document; renames the on-disk file too when supported. */
  async rename(raw: string) {
    const name = raw.replace(/\.typ$/i, '').replace(/[\\/:*?"<>|]/g, '-').trim();
    if (!name || name === this.name) return;
    if (this.handle) {
      const move = (this.handle as { move?: (n: string) => Promise<void> }).move;
      if (typeof move === 'function') {
        try {
          await move.call(this.handle, `${name}.typ`);
          this.name = name;
          this.hooks.onState();
          this.hooks.message(`Renamed to ${name}.typ`);
          try {
            await addRecent(this.handle, `${name}.typ`);
            await idbSet('last', this.handle);
          } catch {
            /* non-fatal */
          }
        } catch (e) {
          console.warn('rename failed', e);
          this.hooks.message('Could not rename the file on disk');
        }
        return;
      }
      this.name = name;
      this.hooks.onState();
      this.hooks.message(`Name set to “${name}” — the file on disk keeps its old name (Save As to write a new one)`);
      return;
    }
    this.name = name;
    this.hooks.onState();
  }

  /** The current document node (for exporters). */
  currentDoc() {
    return this.hooks.getDoc();
  }

  /** Plain download of the current document (works everywhere). */
  exportTexCopy() {
    void import('./tex-serializer').then(({ docToTex }) => {
      const text = docToTex(this.hooks.getDoc());
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.name === 'Untitled' ? 'document' : this.name}.tex`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.hooks.message(`Downloaded ${a.download} — vanilla LaTeX for journal submission`);
    });
  }

  exportCopy() {
    const text = docToTyp(this.hooks.getDoc());
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.name === 'Untitled' ? 'document' : this.name}.typ`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.hooks.message(`Downloaded ${a.download}`);
  }

  /** Reconnect to the last open file if the browser still grants access. */
  async restoreLast(): Promise<boolean> {
    if (!this.supportsFS) return false;
    try {
      const stored = (await idbGet('last')) as
        | FileSystemFileHandle
        | { handle: FileSystemFileHandle; dir: FileSystemDirectoryHandle }
        | null;
      if (!stored) return false;
      const handle = 'handle' in stored ? stored.handle : stored;
      const dir = 'handle' in stored ? stored.dir : null;
      const target = dir ?? handle;
      const perm = (await target.queryPermission?.({ mode: 'readwrite' })) ?? 'denied';
      if (perm === 'granted') {
        await this.loadHandle(handle, dir);
        return true;
      }
      if (perm !== 'prompt') return false;
      // The handle survives but needs a fresh grant, and that requires a
      // user gesture. Take on the file's identity NOW (the restored
      // session doc is its content) and finish on the first interaction.
      this.pendingRestore = { handle, dir };
      this.name = handle.name.replace(/\.(typ|md)$/i, '');
      this.dirty = true;
      this.hooks.onState();
      const attempt = () => {
        document.removeEventListener('pointerdown', attempt, true);
        document.removeEventListener('keydown', attempt, true);
        void this.completeRestore();
      };
      document.addEventListener('pointerdown', attempt, true);
      document.addEventListener('keydown', attempt, true);
      this.hooks.message(`Click anywhere to reconnect to ${handle.name}`);
      return false;
    } catch {
      return false;
    }
  }

  /** Finish reconnecting to the last session's file. Must run inside a
   *  user gesture (permission prompt). */
  async completeRestore(): Promise<boolean> {
    const p = this.pendingRestore;
    if (!p || this.handle) return this.handle !== null;
    try {
      const target = p.dir ?? p.handle;
      const perm = (await target.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
      if (perm !== 'granted') return false;
      this.pendingRestore = null;
      const file = await p.handle.getFile();
      const diskText = await file.text();
      this.handle = p.handle;
      this.dir = p.dir;
      this.name = file.name.replace(/\.(typ|md)$/i, '');
      if ((await this.serialize(file.name)) !== diskText) {
        // The session doc is newer (the reload interrupted an autosave):
        // bring the file up to date rather than clobbering the screen.
        await this.write(p.handle);
      }
      this.dirty = false;
      this.hooks.onState();
      this.hooks.message(`Reconnected — ${this.dir ? `${this.dir.name}/` : ''}${file.name}`);
      try {
        await idbSet('last', p.dir ? { handle: p.handle, dir: p.dir } : p.handle);
      } catch {
        /* recents already know this file */
      }
      return true;
    } catch (e) {
      console.warn('Reconnect failed', e);
      return false;
    }
  }

  async recents(): Promise<RecentEntry[]> {
    if (!this.supportsFS) return [];
    return ((await idbGet('recents')) as RecentEntry[] | null) ?? [];
  }

  async openRecent(entry: RecentEntry) {
    try {
      const target = entry.dir ?? entry.handle;
      let perm = (await target.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (perm !== 'granted') {
        perm = (await target.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
      }
      if (perm !== 'granted') {
        this.hooks.message(`Permission declined for ${entry.name}`);
        return;
      }
      await this.loadHandle(entry.handle, entry.dir ?? null);
    } catch (e) {
      console.warn(e);
      this.hooks.message(`Could not open ${entry.name} (moved or deleted?)`);
    }
  }

  private openViaInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.typ,.md,text/plain,text/markdown';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const { doc, warnings } = isMd(file.name)
        ? (await import('./md-parser')).mdToDoc(await file.text())
        : typToDoc(await file.text());
      this.handle = null; // no write access in fallback mode
      this.name = file.name.replace(/\.typ$/i, '');
      this.dirty = false;
      this.hooks.setDoc(doc);
      this.hooks.onState();
      this.hooks.message(
        `Opened ${file.name}${warnings.length ? ` — ${warnings.length} raw block(s)` : ''} (read-only source; saving downloads a copy)`,
      );
    });
    input.click();
  }
}

// ---------- IndexedDB (file handles are structured-cloneable) ----------

const DB_NAME = 'typeset-files';
const STORE = 'kv';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<unknown> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function addRecent(handle: FileSystemFileHandle, fileName: string, dir: FileSystemDirectoryHandle | null = null) {
  try {
    const list = (((await idbGet('recents')) as RecentEntry[] | null) ?? []).slice(0, 12);
    const kept: RecentEntry[] = [];
    for (const entry of list) {
      const same = await entry.handle.isSameEntry?.(handle).catch(() => false);
      if (!same) kept.push(entry);
    }
    const entry: RecentEntry = { name: dir ? `${dir.name}/${fileName}` : fileName, time: Date.now(), handle };
    if (dir) entry.dir = dir;
    kept.unshift(entry);
    await idbSet('recents', kept.slice(0, 8));
  } catch (e) {
    console.warn('Could not update recents', e);
  }
}
