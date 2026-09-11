// The library bibliography: an app-level .bib the writer points Plass at
// once, whose entries the @ picker offers beside the document's own.
// Citing a library-only entry copies THAT ONE ENTRY into the document's
// embedded bibliography (merge-on-cite), so a document stays
// self-contained and carries exactly the entries it cites — never a
// stale snapshot of a whole library (ROADMAP.md, citations plan).
//
// Storage: the file handle, persisted in the same IndexedDB store as
// recents, re-read when the file changes on disk. Where the File System
// Access API is missing the library is a content snapshot imported once.

import { parseBibTeX, type BibEntry } from './bibtex';
import { INPUT_LIMITS, textSizeError } from './input-limits';
import { kvDelete, kvGet, kvSet } from './kv-store';

const KEY = 'library-bib';

interface LibraryRecord {
  name: string;
  handle?: FileSystemFileHandle;
  /** Snapshot fallback (no File System Access API): the .bib text itself. */
  content?: string;
}

interface Loaded {
  name: string;
  entries: BibEntry[];
  mtime: number;
  source: 'file' | 'snapshot';
}

let record: LibraryRecord | null | undefined; // undefined = not read yet
let loaded: Loaded | null = null;
let needsPermission = false;
let loading: Promise<void> | null = null;
let lastCheck = 0;
const listeners = new Set<() => void>();

export function onLibraryChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const notify = () => {
  for (const cb of listeners) cb();
};

async function readRecord(): Promise<LibraryRecord | null> {
  if (record !== undefined) return record;
  try {
    record = ((await kvGet(KEY)) as LibraryRecord | null) ?? null;
  } catch {
    record = null;
  }
  return record;
}

async function readHandle(handle: FileSystemFileHandle, name: string): Promise<Loaded | null> {
  const perm = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
  if (perm !== 'granted') {
    needsPermission = true;
    return null;
  }
  needsPermission = false;
  const file = await handle.getFile();
  if (loaded?.source === 'file' && loaded.mtime === file.lastModified && loaded.name === name) return loaded;
  const text = await file.text();
  if (textSizeError(text, INPUT_LIMITS.bibliographyBytes, 'Library bibliography')) return null;
  return { name, entries: parseBibTeX(text), mtime: file.lastModified, source: 'file' };
}

/** Load (or re-check) the library. Cheap when nothing changed: the file's
 *  modification time is compared, at most every two seconds. */
export function refreshLibrary(): Promise<void> {
  if (loading) return loading;
  const now = Date.now();
  if (loaded && now - lastCheck < 2000) return Promise.resolve();
  lastCheck = now;
  loading = (async () => {
    const rec = await readRecord();
    let next: Loaded | null = null;
    if (rec?.handle) {
      try {
        next = await readHandle(rec.handle, rec.name);
      } catch (e) {
        console.warn('library bibliography could not be read', e);
        next = null;
      }
    } else if (rec?.content !== undefined) {
      next = loaded?.source === 'snapshot' ? loaded : { name: rec.name, entries: parseBibTeX(rec.content), mtime: 0, source: 'snapshot' };
    }
    const changed = (next?.entries.length ?? 0) !== (loaded?.entries.length ?? 0) || next?.mtime !== loaded?.mtime || next?.name !== loaded?.name;
    loaded = next;
    if (changed) notify();
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** The library's entries as last loaded (synchronous; call refreshLibrary
 *  to pick up changes). */
export function libraryEntries(): readonly BibEntry[] {
  return loaded?.entries ?? [];
}

export function libraryEntry(key: string): BibEntry | null {
  return loaded?.entries.find((e) => e.key === key) ?? null;
}

export interface LibraryStatus {
  name: string;
  count: number;
  source: 'file' | 'snapshot';
  needsPermission: boolean;
}

export async function libraryStatus(): Promise<LibraryStatus | null> {
  const rec = await readRecord();
  if (!rec) return null;
  await refreshLibrary();
  return { name: rec.name, count: loaded?.entries.length ?? 0, source: rec.handle ? 'file' : 'snapshot', needsPermission };
}

/** A user gesture: ask the browser for read access to the stored handle. */
export async function requestLibraryPermission(): Promise<boolean> {
  const rec = await readRecord();
  if (!rec?.handle) return false;
  const perm = (await rec.handle.requestPermission?.({ mode: 'read' })) ?? 'granted';
  if (perm !== 'granted') return false;
  lastCheck = 0;
  loaded = null;
  await refreshLibrary();
  return true;
}

export async function setLibraryHandle(handle: FileSystemFileHandle, name = handle.name): Promise<void> {
  record = { name, handle };
  await kvSet(KEY, record);
  loaded = null;
  lastCheck = 0;
  await refreshLibrary();
  notify();
}

export async function setLibrarySnapshot(name: string, content: string): Promise<void> {
  record = { name, content };
  await kvSet(KEY, record);
  loaded = null;
  lastCheck = 0;
  await refreshLibrary();
  notify();
}

export async function forgetLibrary(): Promise<void> {
  record = null;
  loaded = null;
  needsPermission = false;
  await kvDelete(KEY);
  notify();
}

/** Pick a .bib with the file picker where available; otherwise read one
 *  file as a snapshot. Returns the library's name, or null when cancelled. */
export async function chooseLibrary(): Promise<string | null> {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'BibTeX', accept: { 'text/plain': ['.bib'] } }],
        multiple: false,
      });
      if (!handle) return null;
      await setLibraryHandle(handle);
      return handle.name;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bib,text/plain';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const text = await file.text();
      if (textSizeError(text, INPUT_LIMITS.bibliographyBytes, 'Library bibliography')) return resolve(null);
      await setLibrarySnapshot(file.name, text);
      resolve(file.name);
    });
    input.click();
  });
}

/** Merge-on-cite: the document's bibliography text with one entry's raw
 *  BibTeX appended (unchanged when the key is already there). */
export function mergeEntryIntoBib(bib: { name: string; content: string } | null, entry: BibEntry): { name: string; content: string } {
  const name = bib?.name ?? 'references.bib';
  const content = bib?.content ?? '';
  if (parseBibTeX(content).some((e) => e.key === entry.key)) return { name, content };
  const raw = entry.raw.trim();
  return { name, content: content.trim() ? `${content.trimEnd()}\n\n${raw}\n` : `${raw}\n` };
}
