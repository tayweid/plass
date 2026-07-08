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
}

export interface RecentEntry {
  name: string;
  time: number;
  handle: FileSystemFileHandle;
  /** Project folder the file lives in (folder mode). */
  dir?: FileSystemDirectoryHandle;
}

const TYP_TYPE: FilePickerType[] = [
  { description: 'Typst document', accept: { 'text/plain': ['.typ'] } },
];

export class FileManager {
  handle: FileSystemFileHandle | null = null;
  /** Project folder: relative asset paths resolve inside it. */
  dir: FileSystemDirectoryHandle | null = null;
  name = 'Untitled';
  dirty = false;
  readonly supportsFS = typeof window.showOpenFilePicker === 'function';
  private saveTimer = 0;

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
    await w.write(docToTyp(this.hooks.getDoc()));
    await w.close();
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
    const { doc, warnings } = typToDoc(text);
    this.handle = handle;
    this.dir = dir;
    this.name = file.name.replace(/\.typ$/i, '');
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

  /** Open a directory as a project: its .typ is the document, relative
   *  image paths resolve inside it. */
  async openFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
      this.hooks.message('Project folders need the File System Access API (Chrome/Edge)');
      return;
    }
    try {
      const dir = await window.showDirectoryPicker!({ mode: 'readwrite' });
      await this.adoptFolder(dir);
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
    }
  }

  /** Use the folder's newest .typ, or create paper.typ in it. */
  async adoptFolder(dir: FileSystemDirectoryHandle) {
    let best: { handle: FileSystemFileHandle; time: number } | null = null;
    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && /\.typ$/i.test(entry.name)) {
        const f = await (entry as FileSystemFileHandle).getFile();
        if (!best || f.lastModified > best.time) best = { handle: entry as FileSystemFileHandle, time: f.lastModified };
      }
    }
    let handle = best?.handle;
    if (!handle) {
      handle = await dir.getFileHandle('paper.typ', { create: true });
      const w = await handle.createWritable();
      await w.write(docToTyp(this.hooks.emptyDoc()));
      await w.close();
    }
    await this.loadHandle(handle, dir);
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
    if (!this.handle) return this.saveAs();
    try {
      await this.write(this.handle);
      this.dirty = false;
      this.hooks.onState();
      this.hooks.message(`Saved ${this.name}.typ`);
    } catch (e) {
      console.warn(e);
      this.hooks.message('Save failed — try Save As…');
    }
  }

  async saveAs() {
    if (!this.supportsFS) {
      this.exportCopy();
      return;
    }
    try {
      const handle = await window.showSaveFilePicker!({
        suggestedName: `${this.name === 'Untitled' ? 'document' : this.name}.typ`,
        types: TYP_TYPE,
      });
      await this.write(handle);
      this.handle = handle;
      this.name = handle.name.replace(/\.typ$/i, '');
      this.dirty = false;
      this.hooks.onState();
      this.hooks.message(`Saved ${handle.name}`);
      try {
        await addRecent(handle, handle.name);
        await idbSet('last', handle);
      } catch (err) {
        console.warn('Could not persist file handle', err);
      }
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
    }
  }

  /** Surface a transient status message. */
  notify(text: string) {
    this.hooks.message(text);
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
      if (perm !== 'granted') return false;
      await this.loadHandle(handle, dir);
      return true;
    } catch {
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
    input.accept = '.typ,text/plain';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const { doc, warnings } = typToDoc(await file.text());
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
