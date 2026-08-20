// Real files: open/save .typ documents on disk.
//
// Chromium: File System Access API — Open/Save with real handles,
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
import { holdOpenFile, openInAnotherWindow } from './open-files';
import { typToDoc } from './typ-parser';
import { INPUT_LIMITS, inputSizeError, readBoundedText } from './input-limits';

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
  /** Whether boot restored this tab's own crash/reload session. */
  hasSessionDoc?: () => boolean;
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

/** The name a document carries before it has one of its own. Names here are
 *  stored without an extension; the tab adds it, so a fresh tab reads
 *  Plass.typ and says which app it is rather than that the file is nameless. */
export const DEFAULT_DOC_NAME = 'Plass';
type WriteResult = 'clean' | 'pending' | 'conflict' | 'stale' | 'noop';

export class FileManager {
  private openHandle: FileSystemFileHandle | null = null;

  /** The open file. Assigning it announces this window's claim on it, so no
   *  assignment site can forget to (see open-files.ts), and clears a stale
   *  "file has vanished" state along with the handle that vanished. */
  get handle(): FileSystemFileHandle | null {
    return this.openHandle;
  }

  set handle(handle: FileSystemFileHandle | null) {
    this.openHandle = handle;
    this.missing = false;
    holdOpenFile(handle);
    // Every site assigns dir on the line after handle, so recording waits
    // one microtask and captures the pair.
    queueMicrotask(() => this.rememberTabFile());
  }

  /** Where this WINDOW's open file is recorded, so a reload reconnects to
   *  its own document. Set by the app; null in tests and leaves no trace. */
  tabKey: string | null = null;

  /** The file this document was being written to is no longer there. */
  private missing = false;
  /** The format the open document is written in — its file's extension.
   *  A document's format IS its file's, so nothing Plass does on the user's
   *  behalf may change one without rewriting the other: a Markdown file
   *  renamed to .typ is read back as Typst, and its headings return as raw
   *  islands. Tracked rather than derived from the handle, because fallback
   *  mode has a document and a name but no handle to read it off. */
  private format: '.md' | '.typ' = '.typ';

  /** Project folder: relative asset paths resolve inside it. */
  dir: FileSystemDirectoryHandle | null = null;
  name = DEFAULT_DOC_NAME;
  dirty = false;
  readonly supportsFS = typeof window.showOpenFilePicker === 'function';
  private saveTimer = 0;
  /** Exact contents last read from or successfully written to the active
   * file. Every write compares against this baseline first. */
  private diskBaseline: string | null = null;
  private changeRevision = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private conflict = false;
  /** Last-session file awaiting a permission re-grant (browsers downgrade
   *  stored handles to 'prompt' across reloads; re-requesting needs a
   *  user gesture). Preserve a restored/edited screen copy on reconnect,
   *  but never assume it should overwrite a differing disk copy. */
  private pendingRestore: {
    handle: FileSystemFileHandle;
    dir: FileSystemDirectoryHandle | null;
    keepSession: boolean;
    startRevision: number;
  } | null = null;

  constructor(private hooks: FileHooks) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });
  }

  /** Call on every document change: marks dirty, schedules a disk autosave. */
  noteChange() {
    this.changeRevision++;
    if (!this.dirty) {
      this.dirty = true;
      this.hooks.onState();
    }
    if (this.handle && !this.conflict && !this.missing) {
      clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => void this.flush(), 1200);
    }
  }

  private async flush() {
    if (!this.handle || !this.dirty || this.conflict || this.missing) return;
    try {
      await this.enqueueWrite(false);
    } catch (e) {
      if (!this.noteMissingFile(e)) console.warn('Autosave to file failed', e);
    }
  }

  /** Whether a failure means the file is gone from where the handle pointed —
   *  renamed, moved, or deleted outside Plass. Such a handle can never be
   *  written again, so autosave has to stop AND say so: silence here means
   *  every later keystroke fails to reach the disk while the document still
   *  looks like it is saving. */
  private noteMissingFile(error: unknown): boolean {
    if ((error as DOMException | null)?.name !== 'NotFoundError') return false;
    if (this.missing) return true;
    this.missing = true;
    this.dirty = true;
    this.hooks.onState();
    const name = this.handle?.name ?? `${this.name}${this.format}`;
    const text = `${name} has moved or been renamed — Plass can no longer save to it, and your editor copy is safe`;
    const action = { label: 'Save to a folder…', run: () => void this.saveElsewhere() };
    if (this.hooks.messageAction) this.hooks.messageAction(text, action);
    else this.hooks.message(text);
    return true;
  }

  /** Re-home a document whose file vanished: let go of the dead handle and
   *  run the ordinary first-save flow, which asks where it should live. */
  private async saveElsewhere() {
    this.handle = null;
    this.diskBaseline = null;
    this.hooks.onState();
    await this.save();
  }

  private async writeText(handle: FileSystemFileHandle, text: string) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  }

  private documentSizeError(file: File): string | null {
    return inputSizeError(file.size, INPUT_LIMITS.documentBytes, file.name);
  }

  private readDocumentText(file: File): Promise<string> {
    return readBoundedText(file, INPUT_LIMITS.documentBytes, file.name);
  }

  /** The on-disk text for the current doc in the handle's format. */
  private async serialize(fileName: string, doc: PMNode = this.hooks.getDoc()): Promise<string> {
    if (isMd(fileName)) {
      const { docToMd } = await import('./md-serializer');
      const warned = new Set<string>();
      const text = docToMd(doc, (m) => warned.add(m));
      // Lossy-save notices, once per distinct message per save.
      for (const m of warned) this.hooks.message(m);
      return text;
    }
    return docToTyp(doc);
  }

  get hasConflict(): boolean {
    return this.conflict;
  }

  private enqueueWrite(force: boolean): Promise<WriteResult> {
    let result: WriteResult = 'noop';
    const run = this.writeQueue.then(async () => {
      result = await this.writeSnapshot(force);
    });
    this.writeQueue = run.catch(() => undefined);
    return run.then(() => result);
  }

  private async writeSnapshot(force: boolean): Promise<WriteResult> {
    const handle = this.handle;
    if (!handle || (!this.dirty && !force)) return 'noop';
    const revision = this.changeRevision;
    const doc = this.hooks.getDoc();
    const text = await this.serialize(handle.name, doc);
    if (handle !== this.handle) return 'stale';

    if (!force && this.diskBaseline !== null) {
      const diskFile = await handle.getFile();
      const sizeError = this.documentSizeError(diskFile);
      if (sizeError) {
        this.conflict = true;
        this.dirty = true;
        this.hooks.onState();
        this.reportConflict(handle.name, `${sizeError} — autosave is paused and your editor copy is safe`);
        return 'conflict';
      }
      const diskText = await this.readDocumentText(diskFile);
      if (handle !== this.handle) return 'stale';
      if (diskText !== this.diskBaseline && diskText !== text) {
        this.conflict = true;
        this.dirty = true;
        this.hooks.onState();
        this.reportConflict(handle.name);
        return 'conflict';
      }
      // Another writer produced byte-identical content; adopt it as the new
      // baseline without doing a redundant write.
      if (diskText === text) {
        this.diskBaseline = diskText;
        this.conflict = false;
        const pending = revision !== this.changeRevision;
        this.dirty = pending;
        this.hooks.onState();
        if (pending) this.scheduleFollowupSave();
        return pending ? 'pending' : 'clean';
      }
    }

    await this.writeText(handle, text);
    if (handle !== this.handle) return 'stale';
    this.diskBaseline = text;
    this.conflict = false;
    const pending = revision !== this.changeRevision;
    this.dirty = pending;
    this.hooks.onState();
    if (pending) this.scheduleFollowupSave();
    return pending ? 'pending' : 'clean';
  }

  private scheduleFollowupSave() {
    if (!this.handle || this.conflict) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 250);
  }

  private reportConflict(fileName: string, detail?: string) {
    const text = detail ?? `${fileName} changed outside Plass — autosave is paused and your editor copy is safe`;
    const action = {
      label: 'Overwrite disk',
      run: () => void this.overwriteConflict(),
    };
    if (this.hooks.messageAction) this.hooks.messageAction(text, action);
    else this.hooks.message(text);
  }

  private async overwriteConflict() {
    const handle = this.handle;
    if (!handle || !this.conflict) return;
    try {
      const result = await this.enqueueWrite(true);
      if (this.handle === handle && result !== 'stale' && result !== 'conflict') {
        this.hooks.message(`Overwrote ${handle.name} with the Plass version`);
      }
    } catch (e) {
      if (this.noteMissingFile(e)) return;
      console.warn('Conflict overwrite failed', e);
      this.hooks.message('Could not overwrite the changed file');
    }
  }

  /** Start a fresh unsaved document (empty, or the given content e.g. the demo). */
  newDoc(doc?: PMNode, name = DEFAULT_DOC_NAME): boolean {
    if (this.dirty && !confirm('Start a new document? Your current document has unsaved changes.')) return false;
    clearTimeout(this.saveTimer);
    this.handle = null;
    this.dir = null;
    this.pendingRestore = null;
    this.diskBaseline = null;
    this.conflict = false;
    this.changeRevision = 0;
    this.name = name;
    this.format = '.typ';
    this.dirty = false;
    this.hooks.setDoc(doc ?? this.hooks.emptyDoc());
    this.hooks.onState();
    void idbSet('last', null);
    return true;
  }

  async open() {
    if (!this.supportsFS) {
      this.openViaInput();
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker!({ types: TYP_TYPE, startIn: this.dir ?? this.handle ?? undefined });
      await this.loadHandle(handle);
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
    }
  }

  async loadHandle(
    handle: FileSystemFileHandle,
    dir: FileSystemDirectoryHandle | null = null,
    discardConfirmed = false,
    stealConfirmed = false,
  ): Promise<boolean> {
    const file = await handle.getFile();
    const sizeError = this.documentSizeError(file);
    if (sizeError) {
      this.hooks.message(sizeError);
      return false;
    }
    // One window per file: a second window would autosave against its own
    // baseline and quietly overwrite the first. Say where the file already
    // is, and leave a way through in case that window is gone or wedged.
    if (!stealConfirmed) {
      const elsewhere = await openInAnotherWindow(handle);
      if (elsewhere) {
        this.hooks.messageAction?.(
          `${elsewhere} is already open in another Plass window`,
          { label: 'Open here anyway', run: () => void this.loadHandle(handle, dir, discardConfirmed, true) },
        );
        return false;
      }
    }
    if (
      this.dirty &&
      !discardConfirmed &&
      !confirm(`Open ${handle.name}? Your current document has unsaved changes.`)
    ) return false;
    const text = await this.readDocumentText(file);
    const { doc, warnings } = isMd(file.name)
      ? (await import('./md-parser')).mdToDoc(text)
      : typToDoc(text);
    clearTimeout(this.saveTimer);
    this.handle = handle;
    this.dir = dir;
    this.pendingRestore = null;
    this.diskBaseline = text;
    this.conflict = false;
    this.changeRevision = 0;
    this.name = file.name.replace(/\.(typ|md)$/i, '');
    this.format = isMd(file.name) ? '.md' : '.typ';
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
    return true;
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
      // Start where the document already is. A Finder-launched file has a
      // handle but no folder, and its own folder is the answer the user
      // means — not whatever the browser last defaulted to.
      const dir = await window.showDirectoryPicker!({
        mode: 'readwrite',
        startIn: this.dir ?? this.handle ?? undefined,
      });
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
        return (await this.loadHandle(best.handle, dir, true)) ? 'loaded' : null;
      }
    }
    // The current document moves in, keeping its shown name — an unsaved
    // doc still called Plass becomes Plass.typ, matching the tab.
    const fileName = `${this.name}${this.format}`;
    let overwriteConfirmed = false;
    if (intent === 'save') {
      let exists = false;
      try {
        await dir.getFileHandle(fileName);
        exists = true;
      } catch {
        /* not there — good */
      }
      if (exists && !confirm(`${fileName} already exists in this folder — overwrite it?`)) return null;
      overwriteConfirmed = exists;
    }
    const handle = await dir.getFileHandle(fileName, { create: true });
    const priorText = overwriteConfirmed
      ? null
      : await this.readDocumentText(await handle.getFile());
    this.handle = handle;
    this.dir = dir;
    this.diskBaseline = priorText;
    this.conflict = false;
    this.changeRevision++;
    this.name = fileName.replace(/\.(typ|md)$/i, '');
    this.dirty = true;
    await this.enqueueWrite(overwriteConfirmed);
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
      const dir = await window.showDirectoryPicker!({ mode: 'readwrite', startIn: this.handle });
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

  /** Metadata-only project asset lookup. Watchers use this so polling never
   * allocates the whole image merely to compare modification times. */
  async statAsset(path: string): Promise<{ mtime: number; size: number; type: string } | null> {
    try {
      const h = await this.walkTo(path);
      if (!h) return null;
      const f = await h.getFile();
      return { mtime: f.lastModified, size: f.size, type: f.type };
    } catch {
      return null;
    }
  }

  /** Read a project-relative asset (image). Null when absent/no folder.
   *  Callers that process untrusted document references can impose a byte
   *  budget before the browser allocates the file's ArrayBuffer. */
  async readAsset(path: string, maxBytes?: number): Promise<{ data: Uint8Array; mtime: number; type: string } | null> {
    let f: File;
    try {
      const h = await this.walkTo(path);
      if (!h) return null;
      f = await h.getFile();
    } catch {
      return null;
    }
    if (maxBytes !== undefined && f.size > maxBytes) {
      throw new Error(`Project asset exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB compilation limit`);
    }
    return { data: new Uint8Array(await f.arrayBuffer()), mtime: f.lastModified, type: f.type };
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
      const handle = this.handle;
      try {
        const result = await this.enqueueWrite(false);
        if (this.handle === handle && result !== 'conflict' && result !== 'stale') {
          this.hooks.message(`Saved ${handle.name}`);
        }
      } catch (e) {
        if (this.noteMissingFile(e)) return;
        console.warn(e);
        this.hooks.message('Save failed');
      }
      return;
    }
    // First save: the paper gets a home. One question — where should it
    // live? — and the folder IS the project from then on.
    if (typeof window.showDirectoryPicker !== 'function') {
      await this.downloadCopy(this.format);
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
    // Renaming is a name change, never a format change — the file keeps the
    // extension it already has, and a typed one is stripped rather than
    // stacked ("Notes.md" must not become "Notes.md.typ").
    const ext = this.format;
    const name = raw.replace(/\.(typ|md)$/i, '').replace(/[\\/:*?"<>|]/g, '-').trim();
    if (!name || name === this.name) return;
    if (this.handle) {
      const move = (this.handle as { move?: (n: string) => Promise<void> }).move;
      if (typeof move === 'function') {
        try {
          await move.call(this.handle, `${name}${ext}`);
          this.name = name;
          this.hooks.onState();
          this.hooks.message(`Renamed to ${name}${ext}`);
          try {
            await addRecent(this.handle, `${name}${ext}`);
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
      this.hooks.message(`Name set to “${name}” — the file on disk keeps its old name; use Export for a renamed copy`);
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
      a.download = `${this.name}.tex`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.hooks.message(`Downloaded ${a.download} — vanilla LaTeX for journal submission`);
    });
  }

  /** Download the document in one format. The explicit ".typ" export always
   *  says .typ; a save with no filesystem APIs to save through must say the
   *  document's OWN format, or the fallback path quietly converts the file. */
  private async downloadCopy(ext: '.md' | '.typ') {
    const fileName = `${this.name}${ext}`;
    const text = await this.serialize(fileName);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
    this.hooks.message(`Downloaded ${a.download}`);
  }

  exportCopy() {
    void this.downloadCopy('.typ');
  }

  /** Reconnect this tab's own restored editor snapshot to its file without
   * guessing which copy is newer. Equal content resumes normally; differing
   * content enters the same explicit conflict flow as an external edit. */
  private async attachRestoredSession(
    handle: FileSystemFileHandle,
    dir: FileSystemDirectoryHandle | null,
    file: File,
    diskText: string,
  ): Promise<void> {
    const localText = await this.serialize(file.name, this.hooks.getDoc());
    clearTimeout(this.saveTimer);
    this.handle = handle;
    this.dir = dir;
    this.pendingRestore = null;
    this.diskBaseline = diskText;
    this.name = file.name.replace(/\.(typ|md)$/i, '');
    this.format = isMd(file.name) ? '.md' : '.typ';
    this.conflict = localText !== diskText;
    this.dirty = this.conflict;
    this.hooks.onState();
    if (this.conflict) this.reportConflict(file.name);
    else this.hooks.message(`Reconnected — ${dir ? `${dir.name}/` : ''}${file.name}`);
  }

  /** Remember which file THIS window has open. The origin-wide 'last'
   *  record cannot answer "what was I editing?" — it answers "what did any
   *  window touch most recently", which is exactly what used to flash
   *  another window's document into an app window at launch. */
  private rememberTabFile(): void {
    if (!this.tabKey) return;
    const record = this.handle ? { handle: this.handle, dir: this.dir } : null;
    void idbSet(this.tabKey, record).catch((e) => console.warn('Could not record this window\u2019s file', e));
  }

  /** Reconnect to the file this window itself had open before a reload. */
  async restoreTabFile(): Promise<boolean> {
    return this.tabKey ? this.restoreFrom(this.tabKey) : false;
  }

  /** Reconnect to the last open file if the browser still grants access. */
  async restoreLast(): Promise<boolean> {
    return this.restoreFrom('last');
  }

  private async restoreFrom(key: string): Promise<boolean> {
    if (!this.supportsFS) return false;
    try {
      const stored = (await idbGet(key)) as
        | FileSystemFileHandle
        | { handle: FileSystemFileHandle; dir: FileSystemDirectoryHandle }
        | null;
      if (!stored) return false;
      const handle = 'handle' in stored ? stored.handle : stored;
      const dir = 'handle' in stored ? stored.dir : null;
      const target = dir ?? handle;
      // A handle whose browser has no permissions API (or that needs none,
      // like an origin-private one) is not a denial: try it and let the read
      // below fail if it truly cannot be opened.
      const perm = (await target.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (perm === 'granted') {
        if (this.hooks.hasSessionDoc?.()) {
          const file = await handle.getFile();
          const sizeError = this.documentSizeError(file);
          if (sizeError) {
            this.hooks.message(`${sizeError} — the restored editor copy was left untouched`);
            return false;
          }
          await this.attachRestoredSession(handle, dir, file, await this.readDocumentText(file));
        } else {
          await this.loadHandle(handle, dir, true);
        }
        return true;
      }
      if (perm !== 'prompt') return false;
      // The handle survives but needs a fresh grant, and that requires a
      // user gesture. Take on the file's identity NOW (the restored
      // session doc is its content) and finish on the first interaction.
      const keepSession = this.hooks.hasSessionDoc?.() ?? false;
      this.pendingRestore = { handle, dir, keepSession, startRevision: this.changeRevision };
      this.name = handle.name.replace(/\.(typ|md)$/i, '');
      this.format = isMd(handle.name) ? '.md' : '.typ';
      this.dirty = keepSession;
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
      const file = await p.handle.getFile();
      const sizeError = this.documentSizeError(file);
      if (sizeError) {
        this.hooks.message(`${sizeError} — the restored editor copy was left untouched`);
        return false;
      }
      const diskText = await this.readDocumentText(file);
      const keepSession = p.keepSession || this.changeRevision !== p.startRevision;
      if (keepSession) {
        await this.attachRestoredSession(p.handle, p.dir, file, diskText);
      } else {
        this.pendingRestore = null;
        await this.loadHandle(p.handle, p.dir, true);
      }
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
      const sizeError = this.documentSizeError(file);
      if (sizeError) {
        this.hooks.message(sizeError);
        return;
      }
      if (this.dirty && !confirm(`Open ${file.name}? Your current document has unsaved changes.`)) return;
      const text = await this.readDocumentText(file);
      const { doc, warnings } = isMd(file.name)
        ? (await import('./md-parser')).mdToDoc(text)
        : typToDoc(text);
      clearTimeout(this.saveTimer);
      this.handle = null; // no write access in fallback mode
      this.dir = null;
      this.pendingRestore = null;
      this.diskBaseline = null;
      this.conflict = false;
      this.changeRevision = 0;
      this.name = file.name.replace(/\.(typ|md)$/i, '');
      this.format = isMd(file.name) ? '.md' : '.typ';
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
