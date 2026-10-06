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
import { ensureMathConverter } from './math-convert';
import { kvGet as idbGet, kvSet as idbSet } from './kv-store';
import { holdOpenFile, openInAnotherWindow } from './open-files';
import { typToDoc } from './typ-parser';
import { INPUT_LIMITS, inputSizeError, readBoundedText } from './input-limits';
import { dataUrlBytes, projectImagePath } from './figures';

export interface FileHooks {
  getDoc: () => PMNode;
  /** Replace the editor document (fresh state: history resets). */
  setDoc: (doc: PMNode) => void;
  /** The open file's new contents put in place of the document it already
   *  shows (a change on disk, a rewind): only what differs is replaced, so
   *  the caret and the scroll stay where the text still allows. Not an
   *  edit of the writer's: the document then matches the disk. */
  reloadDoc: (doc: PMNode) => void;
  emptyDoc: () => PMNode;
  /** Name/dirty changed — update chrome. */
  onState: () => void;
  message: (text: string) => void;
  /** Toast with a click action. */
  messageAction?: (text: string, action: { label: string; run: () => void }) => void;
  /** The current document just became a fresh project (folder adopted,
   *  document kept). Images fixed in the document stay fixed: importing
   *  happens when an image is inserted, not here. */
  onProjectKept?: () => void;
  /** Whether boot restored this tab's own crash/reload session. */
  hasSessionDoc?: () => boolean;
  /** The open file changed: the handle now held, or null for none. Every
   *  assignment of `handle` reports it (Plass.app tells its shell, which
   *  keeps the project's autosave record: claerbout.ts reportDocument). */
  onFile?: (handle: FileSystemFileHandle | null) => void;
  /** The document's text as the writer typed it, when a source view is
   *  open in `format` — saved verbatim, never re-serialized, until the
   *  writer returns to the page view (SOURCE-VIEW.md, decision 3). Null
   *  when the page view is the truth or the source is in the other format. */
  getText?: (format: '.md' | '.typ') => string | null;
  /** The bibliography a Markdown file's `bibliography:` sidecar makes,
   *  read once the folder is there (attachFolder; md-parser's
   *  mergeSidecarBib): put in the shown document, with `frontmatter` — the
   *  carried front matter less its `bibliography:` line — and a
   *  bibliography block at the end when it has none, as withSidecarBib
   *  makes the document on open. Not the writer's edit and no undo step:
   *  the document matches its file but for the bibliography, which the
   *  next save embeds. */
  setBib?: (bib: { name: string; content: string }, frontmatter: string) => void;
}

/** What a parse of the open file said, for its toast. */
interface ImportReport {
  warnings: string[];
  /** A Markdown file's front-matter warnings (also in `warnings`). */
  frontmatterWarnings?: string[];
}

/** The open file read in its format (mdToDoc or typToDoc). */
type ParsedFile = ImportReport & {
  doc: PMNode;
  /** A Markdown file's `bibliography:` sidecar path. */
  bibliography?: string;
};

/** The tail of an open or reload toast: blocks kept as source, counted, and
 *  a Markdown file's front-matter warnings worded as warnings, the first
 *  one shown. Empty when there is nothing to say. */
function importNote(r: ImportReport): string {
  const fm = r.frontmatterWarnings ?? [];
  const blocks = r.warnings.length - fm.length;
  const parts: string[] = [];
  if (blocks) parts.push(`${blocks} block(s) preserved as raw Typst`);
  // The toast names one: a warning that a save loses something, if any.
  const first = fm.find((m) => /\bdrop|\bignored\b|\bonly the\b/i.test(m)) ?? fm[0];
  if (fm.length) parts.push(`front matter: ${fm.length === 1 ? '1 warning' : `${fm.length} warnings`} — ${first}${fm.length > 1 ? ' …' : ''}`);
  return parts.length ? ` — ${parts.join('; ')}` : '';
}

/** The toast's tail for a `bibliography:` sidecar read into the document:
 *  `kept`, its entries the document already held (kept as it held them). */
function sidecarNote(path: string, fileName: string, kept: number): string {
  const held = kept ? ` (${kept === 1 ? '1 key the document already held keeps its entry' : `${kept} keys the document already held keep their entries`})` : '';
  return ` — bibliography read from ${path}${held}; the next save embeds it in ${fileName} (a {=bibtex} block in place of bibliography:)`;
}

/** The toast's tail for a `bibliography:` sidecar left unread, no folder
 *  being open. */
function unreadNote(path: string): string {
  return ` — its bibliography is ${path}, beside it: open its project folder to read it (until then a save keeps the bibliography: line)`;
}

/** The `bibliography:` sidecar a Markdown document still carries the line
 *  of in its front matter (the reader keeps it there until the sidecar is
 *  read: md-parser's withSidecarBib), or null. */
async function carriedBibliography(doc: PMNode): Promise<string | null> {
  const kept = String(doc.attrs.frontmatter ?? '');
  if (!/^bibliography[ \t]*:/m.test(kept)) return null;
  const { readFrontmatter } = await import('./md-frontmatter');
  return readFrontmatter(`---\n${kept}\n---\n`).bibliography ?? null;
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

/** A project-relative path's segments: `./refs.bib` is `refs.bib`, as a
 *  `.` segment names the folder it is in (a `..` one is refused by the
 *  callers). */
const projectPathParts = (path: string): string[] => path.split('/').filter((seg) => seg && seg !== '.');

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
    this.hooks.onFile?.(handle);
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
  private fileFormat: '.md' | '.typ' = '.typ';

  /** The format the open document is written in (see `fileFormat`). */
  get format(): '.md' | '.typ' {
    return this.fileFormat;
  }

  /** Project folder: relative asset paths resolve inside it. */
  dir: FileSystemDirectoryHandle | null = null;
  /** The `bibliography:` sidecar the open Markdown file names, until it is
   *  read (it needs the folder): attachFolder reads it then. */
  private bibliographyPath: string | null = null;
  name = DEFAULT_DOC_NAME;
  dirty = false;
  readonly supportsFS = typeof window.showOpenFilePicker === 'function';
  private saveTimer = 0;
  /** Exact contents last read from or successfully written to the active
   * file. Every write compares against this baseline first. */
  private diskBaseline: string | null = null;
  /** lastModified of the disk version we've seen or written — the disk
   *  watcher's cheap first check before reading any text. */
  private diskMtime = 0;
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
      // Coming back from the outside editor is exactly when a disk change
      // is most likely — don't make the return wait for a poll tick.
      else void this.pollDisk();
    });
    window.setInterval(() => void this.pollDisk(), 1500);
  }

  /** External edits, hot-reloaded. The File System Access API has no
   *  stable change events, so the open handle is polled: lastModified is
   *  a cheap metadata read, and text is only read (bounded) when it
   *  moves. A change under a CLEAN document reloads it in place; a dirty
   *  or conflicted document is left to the write path, which already
   *  detects the divergence against diskBaseline and runs the explicit
   *  conflict flow. */
  private async pollDisk() {
    if (!this.handle || this.dirty || this.conflict || this.missing) return;
    const handle = this.handle;
    let file: File;
    try {
      file = await handle.getFile();
    } catch {
      return; // moved, deleted, or permission lapsed — the write path says so
    }
    if (file.lastModified === this.diskMtime) return;
    this.diskMtime = file.lastModified;
    if (this.documentSizeError(file)) return; // the write path reports oversize
    const text = await this.readDocumentText(file);
    // The document may have started changing under these awaits; a reload
    // now would eat keystrokes — the conflict flow owns that case.
    if (handle !== this.handle || this.dirty) return;
    if (text === this.diskBaseline) return; // our own write, or a bare touch
    const note = await this.putInPlace(handle, file, text);
    if (note === null || note === 'shown') return;
    this.hooks.message(`${file.name} changed on disk — reloaded${note}`);
  }

  /** The shell's `reload`: a rewind (`lead`, "Rewound to 1a2b3c4" or
   *  "Rewound by Knuth") wrote or removed the open file. It is read again
   *  and put in place as the disk watcher puts an outside edit, but
   *  whatever its mtime says, and every outcome is said: the document
   *  reloaded (or already showing it: the watcher may get there first, or
   *  the rewind left these bytes alone); the file gone, since the commit
   *  rewound to lacks it, with the editor's copy kept; or edits typed
   *  since the rewind saved the document, kept, with autosave paused as
   *  for any change outside Plass. */
  async reloadFromDisk(lead: string): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    let file: File;
    try {
      file = await handle.getFile();
    } catch (e) {
      if (!this.noteMissingFile(e, `${lead}: ${handle.name} is not in that version — your editor copy is safe`)) {
        this.hooks.message(`${lead} — ${handle.name} could not be read again`);
      }
      return;
    }
    const sizeError = this.documentSizeError(file);
    if (sizeError) {
      this.hooks.message(`${lead} — ${sizeError}`);
      return;
    }
    const text = await this.readDocumentText(file);
    if (handle !== this.handle) return;
    if (text === this.diskBaseline) {
      this.hooks.message(lead);
      return;
    }
    if (this.dirty) {
      this.conflict = true;
      this.hooks.onState();
      this.reportConflict(handle.name, `${lead} under unsaved edits to ${handle.name} — autosave is paused and your editor copy is safe`);
      return;
    }
    const note = await this.putInPlace(handle, file, text);
    // Typing began while it was parsed: the write path's conflict flow has it.
    if (note === null) return;
    this.hooks.message(`${lead}${note === 'shown' ? '' : note}`);
  }

  /** The file's text put in place of the clean document it already shows
   *  (hooks.reloadDoc), the disk baseline moved to it. What its toast says
   *  of the read (importNote; '' for nothing); 'shown' when the other
   *  reader (the watcher, or a rewind's reload) put this text in place
   *  while it was parsed, so only one of them speaks of it; null when the
   *  document began changing, or the window took another file, meanwhile.
   *  A Markdown file's `bibliography:` sidecar is read again with it. */
  private async putInPlace(handle: FileSystemFileHandle, file: File, text: string): Promise<string | 'shown' | null> {
    const parsed = await this.parse(file.name, text);
    const shown = (this.hooks.getDoc().attrs.bib as { content?: string } | null)?.content;
    const sidecar = await this.withSidecar(parsed, this.dir, file.name, shown);
    if (handle !== this.handle || this.dirty) return null;
    if (text === this.diskBaseline) return 'shown';
    this.diskBaseline = text;
    this.diskMtime = file.lastModified;
    this.bibliographyPath = sidecar.pending;
    this.hooks.reloadDoc(sidecar.doc);
    this.hooks.onState();
    return importNote(parsed) + sidecar.note;
  }

  /** The open file's text read in its format. */
  private async parse(fileName: string, text: string): Promise<ParsedFile> {
    return isMd(fileName) ? (await import('./md-parser')).mdToDoc(text) : typToDoc(text);
  }

  /** The sidecar a Markdown file's `bibliography:` names (beside it, in
   *  `dir`), read once and put in the parsed document (withSidecarBib):
   *  its entries in the bibliography, with a block to print it, and the
   *  carried front matter less that line, so the next save embeds the
   *  entries (a {=bibtex} block) in place of the key. Without the folder
   *  it stays to be read (`pending`), and its line stays in the file.
   *  `note` is what the toast says about it, unless the read found
   *  `shown`, the bibliography the document already shows (a reload says
   *  nothing of a read it announced before). */
  private async withSidecar(
    parsed: ParsedFile,
    dir: FileSystemDirectoryHandle | null,
    fileName: string,
    shown?: string,
  ): Promise<{ doc: PMNode; pending: string | null; note: string }> {
    const path = parsed.bibliography;
    if (!path) return { doc: parsed.doc, pending: null, note: '' };
    if (!dir) return { doc: parsed.doc, pending: path, note: unreadNote(path) };
    const read = await this.readSidecar(path, dir);
    if (typeof read === 'string') return { doc: parsed.doc, pending: path, note: ` — bibliography: ${read}` };
    const { withSidecarBib } = await import('./md-parser');
    const put = withSidecarBib(parsed.doc, read.content);
    const content = (put.doc.attrs.bib as { content: string }).content;
    return { doc: put.doc, pending: null, note: shown === content ? '' : sidecarNote(path, fileName, put.kept) };
  }

  /** A `bibliography:` sidecar's entries, read through `readAsset` (4 MiB
   *  at most) from `dir`; or why they could not be. */
  private async readSidecar(path: string, dir: FileSystemDirectoryHandle): Promise<{ content: string } | string> {
    let data: Uint8Array | null;
    try {
      data = (await this.readAsset(path, INPUT_LIMITS.bibliographyBytes, dir))?.data ?? null;
    } catch {
      return inputSizeError(INPUT_LIMITS.bibliographyBytes + 1, INPUT_LIMITS.bibliographyBytes, path) ?? `${path} could not be read`;
    }
    if (!data) return `${path} is not in ${dir.name} — nothing was read`;
    // The bibliography panel's own clean-up of what it saves, with line
    // breaks as the Markdown reader holds them (CRLF and CR as \n), so the
    // {=bibtex} block a save writes reads back as the same text.
    const content = new TextDecoder()
      .decode(data)
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .trim();
    if (!content) return `${path} is empty — nothing was read`;
    return { content };
  }

  /** The `bibliography:` sidecar the open Markdown file names, while it is
   *  unread (no folder yet): null when there is none, or it was read. */
  get pendingBibliography(): string | null {
    return this.bibliographyPath;
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
  private noteMissingFile(error: unknown, said?: string): boolean {
    if ((error as DOMException | null)?.name !== 'NotFoundError') return false;
    if (this.missing) return true;
    this.missing = true;
    this.dirty = true;
    this.hooks.onState();
    const name = this.handle?.name ?? `${this.name}${this.format}`;
    const text = said ?? `${name} has moved or been renamed — Plass can no longer save to it, and your editor copy is safe`;
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

  /** The on-disk text for the current doc in the handle's format. Text the
   *  writer is typing in a source view of that format is the document and
   *  goes out verbatim. */
  private async serialize(fileName: string, doc?: PMNode): Promise<string> {
    const typed = this.hooks.getText?.(isMd(fileName) ? '.md' : '.typ');
    if (typeof typed === 'string') return typed;
    doc ??= this.hooks.getDoc();
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
    const text = await this.serialize(handle.name);
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
    // Our own write is not an external change: move the watcher's
    // baseline past it so the next poll doesn't re-read the file.
    this.diskMtime = (await handle.getFile()).lastModified;
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
    this.fileFormat = '.typ';
    this.bibliographyPath = null;
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
    // (A Finder launch in Plass.app asks first, with the holder fronted and
    // the launch window closed: main.ts openLaunched. Open…, Recents and a
    // restore never front anyone — this window may hold its own document.)
    if (!stealConfirmed) {
      const elsewhere = await openInAnotherWindow(handle);
      if (elsewhere) {
        this.hooks.messageAction?.(
          `${elsewhere.name} is already open in another Plass window`,
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
    const parsed = await this.parse(file.name, text);
    const sidecar = await this.withSidecar(parsed, dir, file.name);
    clearTimeout(this.saveTimer);
    this.handle = handle;
    this.dir = dir;
    this.pendingRestore = null;
    this.diskBaseline = text;
    this.conflict = false;
    this.changeRevision = 0;
    this.name = file.name.replace(/\.(typ|md)$/i, '');
    this.fileFormat = isMd(file.name) ? '.md' : '.typ';
    this.bibliographyPath = sidecar.pending;
    this.dirty = false;
    this.hooks.setDoc(sidecar.doc);
    this.hooks.onState();
    const where = dir ? `${dir.name}/${file.name}` : file.name;
    this.hooks.message(`Opened ${where}${importNote(parsed)}${sidecar.note}`);
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
      // This window's record carries the folder now, so a reload reconnects
      // with it: figures load, and a sidecar read here is not a conflict.
      this.rememberTabFile();
      this.hooks.onState();
      const bib = await this.readPendingBibliography();
      this.hooks.message(`Project folder attached — ${dir.name}/${this.handle.name}${bib}`);
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

  /** The open file's unread `bibliography:` sidecar, now that the folder is
   *  here: read, and put in the shown document (hooks.setBib) — merged
   *  into the bibliography it holds by now, if it holds one (entries added
   *  while the sidecar was unread). What the toast says of it. */
  private async readPendingBibliography(): Promise<string> {
    const path = this.bibliographyPath;
    const handle = this.handle;
    if (!path || !this.dir || !handle) return '';
    // While the Markdown source is open, its text is the document: a
    // bibliography put in the page under it would be lost on the way back.
    if (typeof this.hooks.getText?.('.md') === 'string') return ` — ${path} is read when ${handle.name} is next opened (not while its source is open)`;
    const read = await this.readSidecar(path, this.dir);
    if (handle !== this.handle) return '';
    if (typeof read === 'string') return ` — bibliography: ${read}`;
    const [{ mergeSidecarBib }, { withoutEntry }] = await Promise.all([import('./md-parser'), import('./md-frontmatter')]);
    if (handle !== this.handle) return '';
    const doc = this.hooks.getDoc();
    const merged = mergeSidecarBib(doc.attrs.bib as { name: string; content: string } | null, read.content);
    this.bibliographyPath = null;
    this.hooks.setBib?.(merged.bib, withoutEntry(String(doc.attrs.frontmatter ?? ''), 'bibliography'));
    return sidecarNote(path, handle.name, merged.kept);
  }

  private async walkTo(path: string, from = this.dir): Promise<FileSystemFileHandle | null> {
    if (!from) return null;
    const parts = projectPathParts(path);
    if (!parts.length || parts.some((seg) => seg === '..')) return null;
    let d = from;
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
   *  budget before the browser allocates the file's ArrayBuffer. `from`:
   *  the folder to read in, when it is not yet the project's (a file being
   *  opened in it). */
  async readAsset(path: string, maxBytes?: number, from = this.dir): Promise<{ data: Uint8Array; mtime: number; type: string } | null> {
    let f: File;
    try {
      const h = await this.walkTo(path, from);
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
      const parts = projectPathParts(path);
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
      const result = await this.writeOpenFile();
      if (result === 'failed') this.hooks.message('Save failed');
      else if (this.handle === handle && result !== 'conflict' && result !== 'stale' && result !== 'missing') {
        this.hooks.message(`Saved ${handle.name}`);
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

  /** ⌘S's write of a document that has a file: through the queue
   *  autosave writes by, which checks the disk against what Plass last
   *  saw first. A conflict and a file gone are said where they are found;
   *  'failed' is anything else. */
  private async writeOpenFile(): Promise<WriteResult | 'missing' | 'failed'> {
    try {
      return await this.enqueueWrite(false);
    } catch (e) {
      if (this.noteMissingFile(e)) return 'missing';
      console.warn(e);
      return 'failed';
    }
  }

  /** The shell's `save` (claerbout.ts onShellSave): a rewind saves every
   *  window on its project before it writes. ⌘S's write, without its
   *  toast: null once the document is on disk, at once when nothing
   *  changed; else why not, which refuses the rewind, in words the
   *  History window's card puts after "could not be saved:". */
  async saveForShell(): Promise<string | null> {
    const handle = this.handle;
    if (!handle) return 'it has no file yet';
    if (!this.dirty) return null;
    switch (await this.writeOpenFile()) {
      case 'conflict':
        return 'it changed on disk outside Plass, and Plass is keeping its own copy until you choose';
      case 'missing':
        return 'it has moved or been renamed';
      case 'failed':
        return 'Plass could not write it';
      case 'stale':
        return 'the window opened another document meanwhile';
      default:
        return null;
    }
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
      // Export → Typst is the print form (comments gone, islands as code),
      // not a copy to keep editing; Export → Markdown is.
      this.hooks.message(`Name set to “${name}” — the file on disk keeps its old name; Export → Markdown writes a renamed .md copy`);
      return;
    }
    this.name = name;
    this.hooks.onState();
  }

  /** The current document node (for exporters). */
  currentDoc() {
    return this.hooks.getDoc();
  }

  /** Put an exported file (PDF etc.) next to the document. In folder mode
   *  it is written straight into the project folder; a file opened without
   *  its folder (Finder launch) gets a save dialog that opens in that file's
   *  own folder; with no filesystem APIs it downloads. Resolves to the
   *  destination for the toast, or null when the user cancelled the dialog. */
  async saveBeside(fileName: string, blob: Blob): Promise<string | null> {
    if (this.dir && (await this.writeAsset(fileName, blob))) {
      return `${this.dir.name}/${fileName}`;
    }
    if (this.handle && typeof window.showSaveFilePicker === 'function') {
      try {
        const target = await window.showSaveFilePicker({ suggestedName: fileName, startIn: this.handle });
        const w = await target.createWritable();
        await w.write(blob);
        await w.close();
        return target.name;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return null;
        console.warn('saveBeside picker failed', e);
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
    return fileName;
  }

  /** A .tex copy beside the document (vanilla LaTeX for journals). */
  exportTexCopy() {
    void import('./tex-serializer').then(async ({ docToTex }) => {
      const text = docToTex(this.hooks.getDoc());
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const where = await this.saveBeside(`${this.name}.tex`, blob);
      if (where !== null) this.hooks.message(`Exported ${where} — vanilla LaTeX for journal submission`);
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

  /** Export → Typst: a .typ beside the document holding the source Plass
   *  compiles — islands printed as code, editorial comments absent — built
   *  from the document directly, never through `serialize`, so a source view
   *  open in Typst cannot hand out its editable text instead. In a project
   *  folder every embedded image is written to figures/ and linked by path,
   *  so the file compiles with the typst CLI; without a folder the data URLs
   *  stay (the CLI cannot read them) and the toast says so. The open
   *  document is never the target: a .typ that IS the open file is the
   *  writer's source, not an export to overwrite — and neither is a .typ
   *  already in the folder, unasked: it may be the writer's source too (the
   *  guard below sends a writer from their X.typ to X.md and back here), so
   *  it is replaced without a question only while its bytes are still the
   *  last export this app wrote to it, which keeps re-exporting one click.
   *  Nothing is written until the text is built and the target cleared, so
   *  a document the serializer refuses, or a declined overwrite, leaves no
   *  images behind; a refusal is said on the toast. */
  async exportCopy() {
    const fileName = `${this.name}.typ`;
    if (await this.isOpenFile(fileName)) {
      const md = `${this.name}.md`;
      this.hooks.message(
        (await this.folderFile(md))
          ? `${fileName} is the open document — open ${md} and export Typst from it`
          : `${fileName} is the open document — Export → Markdown, then export Typst from the .md`,
      );
      return;
    }
    try {
      const doc = this.hooks.getDoc();
      // The export's math is native Typst, converted by the local converter.
      await ensureMathConverter();
      const images = await this.planEmbeddedImages(doc);
      const build = (paths: Map<string, string>) =>
        docToTyp(doc, { islands: 'print', resolveImage: (src) => paths.get(src) ?? src });
      const planned = new Map([...images.planned].map(([src, p]) => [src, p.path]));
      let text = build(planned);
      const replace = await this.mayReplaceInFolder(
        fileName,
        `${fileName} already exists in this folder — replace it with this document's Typst export? Anything only ${fileName} holds, such as its page setup, is lost.`,
        (there) => this.isLastTypExport(there),
      );
      if (!replace) return;
      const paths = new Map<string, string>();
      for (const [src, p] of images.planned) {
        if (!p.write || (await this.writeAsset(p.path, p.blob))) paths.set(src, p.path);
      }
      // An image that would not write stays a data URL rather than a path
      // to nothing.
      if (paths.size < planned.size) text = build(paths);
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const where = await this.saveBeside(fileName, blob);
      if (where === null) return;
      // Only a write into the folder is vouched for; a save dialog the
      // folder write fell back to put the text somewhere else.
      if (this.dir && where === `${this.dir.name}/${fileName}`) await this.rememberTypExport(fileName, text);
      const kept = images.found - paths.size;
      const count = (n: number) => `${n} embedded image${n === 1 ? '' : 's'}`;
      let note = '';
      // One line of toast: it truncates rather than wraps.
      if (kept && !this.dir) {
        note = ' — embedded images need the project folder open to compile outside Plass';
      } else if (kept) {
        note = ` — ${count(kept)} could not be written to figures/`;
      } else if (paths.size) {
        note = ` — ${count(paths.size)} written to figures/`;
      }
      this.hooks.message(`Exported ${where}${note}`);
    } catch (e) {
      console.error('Typst export failed', e);
      this.hooks.message(`Typst export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Export → Markdown: a .md beside the document — how a .typ document
   *  becomes a Markdown source. Text the writer is typing in a Markdown
   *  source view goes out verbatim, as a save would write it. When the open
   *  file already is that .md, this is a save, not a second writer racing
   *  the autosave poller on the same path. An X.md already in the folder is
   *  a Markdown source — most likely the writer's own, the one the open
   *  .typ was exported from — so it is replaced only on a yes, as a first
   *  save into a folder asks, and never while another Plass window has it
   *  open. (Outside a folder the save dialog asks.) */
  async exportMdCopy() {
    const fileName = `${this.name}.md`;
    if (await this.isOpenFile(fileName)) {
      await this.save();
      return;
    }
    try {
      // Not through `serialize`, which toasts each notice on its own: the
      // "Exported" toast would replace them at once, and a conversion must
      // say what it could not keep. They ride on that toast instead.
      const typed = this.hooks.getText?.('.md');
      const warned = new Set<string>();
      let text: string;
      if (typeof typed === 'string') text = typed;
      else {
        const { docToMd } = await import('./md-serializer');
        text = docToMd(this.hooks.getDoc(), (m) => warned.add(m));
      }
      if (!(await this.mayReplaceInFolder(fileName, `${fileName} already exists in this folder — overwrite it?`))) return;
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const where = await this.saveBeside(fileName, blob);
      if (where !== null) this.hooks.message(`Exported ${where}${warned.size ? ` — ${[...warned].join('; ')}` : ''}`);
    } catch (e) {
      console.error('Markdown export failed', e);
      this.hooks.message(`Markdown export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** `fileName` at the top of the project folder, or null when it is not
   *  there or there is no folder. */
  private async folderFile(fileName: string): Promise<FileSystemFileHandle | null> {
    if (!this.dir) return null;
    try {
      return await this.dir.getFileHandle(fileName);
    } catch {
      return null;
    }
  }

  /** Whether an export may write `fileName` into the project folder. Yes
   *  when nothing is there (and with no folder, where the save dialog asks
   *  for itself). No, said on a toast, while another Plass window has the
   *  file open: that window would reload into the export, or meet it as a
   *  conflict over its unsaved edits. Otherwise only on a yes to `question`,
   *  unless `known` vouches for what is there. */
  private async mayReplaceInFolder(
    fileName: string,
    question: string,
    known?: (there: FileSystemFileHandle) => Promise<boolean>,
  ): Promise<boolean> {
    const there = await this.folderFile(fileName);
    if (!there) return true;
    const elsewhere = await openInAnotherWindow(there);
    if (elsewhere) {
      this.hooks.message(`${elsewhere.name} is open in another Plass window — close it there, then export again`);
      return false;
    }
    if (known && (await known(there))) return true;
    return confirm(question);
  }

  /** Whether the bytes in `there` are still the last Typst export this app
   *  wrote to that file (`rememberTypExport`): an X.typ opened and edited
   *  since, written by hand, or exported by another browser is not. */
  private async isLastTypExport(there: FileSystemFileHandle): Promise<boolean> {
    try {
      const records = ((await idbGet(TYP_EXPORTS_KEY)) as TypExportRecord[] | null) ?? [];
      for (const record of records) {
        if (!(await record.file.isSameEntry(there).catch(() => false))) continue;
        const bytes = new Uint8Array(await (await there.getFile()).arrayBuffer());
        return record.hash === (await sha256Hex(bytes, TYP_EXPORT_HASH_BYTES));
      }
    } catch (e) {
      console.warn('Could not read the Typst export records', e);
    }
    return false;
  }

  /** Note what Export → Typst just wrote to `fileName` in the folder, so the
   *  next export may replace it unasked while it is unchanged. */
  private async rememberTypExport(fileName: string, text: string): Promise<void> {
    try {
      const file = await this.folderFile(fileName);
      if (!file) return;
      const hash = await sha256Hex(new TextEncoder().encode(text), TYP_EXPORT_HASH_BYTES);
      const records = ((await idbGet(TYP_EXPORTS_KEY)) as TypExportRecord[] | null) ?? [];
      const kept: TypExportRecord[] = [];
      for (const record of records) {
        if (!(await record.file.isSameEntry(file).catch(() => false))) kept.push(record);
      }
      await idbSet(TYP_EXPORTS_KEY, [{ file, hash }, ...kept].slice(0, TYP_EXPORTS_KEPT));
    } catch (e) {
      console.warn('Could not record the Typst export', e);
    }
  }

  /** Whether `fileName` beside the document is the open file itself. Names
   *  compare without case: APFS, the default macOS volume, ignores it, so
   *  with "Paper.TYP" open a write to "Paper.typ" lands on the open file.
   *  In a folder the two entries are compared as well. */
  private async isOpenFile(fileName: string): Promise<boolean> {
    const open = this.handle;
    if (!open) return false;
    if (open.name.toLowerCase() === fileName.toLowerCase()) return true;
    const there = await this.folderFile(fileName);
    try {
      return !!there && (await open.isSameEntry(there));
    } catch {
      return false;
    }
  }

  /** Where each distinct data-URL image in `doc` (image and figure nodes)
   *  goes under figures/ — read-only, so nothing is on disk before the text
   *  is built. A file is named after its content (a short SHA-256 of the
   *  bytes), so exporting again, after a reload or with the folder attached
   *  anew, links the file already there instead of adding a copy; a name
   *  taken by other bytes gets a fresh collision-safe one. `found` counts
   *  every embedded image; one not planned (no folder, a type other than
   *  PNG/JPEG/GIF/SVG, past the size limit) stays a data URL. */
  private async planEmbeddedImages(
    doc: PMNode,
  ): Promise<{ planned: Map<string, { path: string; blob: Blob; write: boolean }>; found: number }> {
    const found = new Map<string, string>();
    doc.descendants((node) => {
      const src = node.attrs.src;
      if (
        (node.type.name === 'image' || node.type.name === 'figure') &&
        typeof src === 'string' &&
        /^data:/i.test(src) &&
        !found.has(src)
      ) {
        found.set(src, String(node.attrs.name || node.attrs.alt || ''));
      }
      return true;
    });
    const planned = new Map<string, { path: string; blob: Blob; write: boolean }>();
    if (!this.dir) return { planned, found: found.size };
    for (const [src, hint] of found) {
      let decoded: ReturnType<typeof dataUrlBytes> = null;
      try {
        decoded = dataUrlBytes(src);
      } catch {
        // Past the size limit: it stays a data URL, like an unknown type.
      }
      if (!decoded) continue;
      const bytes = new Uint8Array(await decoded.blob.arrayBuffer());
      const hash = await sha256Hex(bytes, 6);
      // A name from the alt text or file name, in the letters a path keeps;
      // one with none of them (日本語, α, -) is "image", never a dotfile.
      const stem =
        hint
          .replace(/\.[^.]+$/, '')
          .replace(/[^a-zA-Z0-9_-]+/g, '-')
          .slice(0, 40)
          .replace(/^[-.]+|-+$/g, '') || 'image';
      const path = `figures/${stem}-${hash}.${decoded.ext}`;
      const there = await this.statAsset(path);
      if (!there) planned.set(src, { path, blob: decoded.blob, write: true });
      else if (there.size === bytes.length && sameBytes((await this.readAsset(path))?.data, bytes)) {
        planned.set(src, { path, blob: decoded.blob, write: false });
      } else planned.set(src, { path: projectImagePath(`${stem}.${decoded.ext}`), blob: decoded.blob, write: true });
    }
    return { planned, found: found.size };
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
    const localText = await this.serialize(file.name);
    const differs = localText !== diskText && !(await this.sidecarOnly(file.name, diskText, dir, localText));
    // A `bibliography:` sidecar the session document still carries the
    // line of is unread: read now if the folder is here, else when it is.
    const pending = isMd(file.name) ? await carriedBibliography(this.hooks.getDoc()) : null;
    clearTimeout(this.saveTimer);
    this.handle = handle;
    this.dir = dir;
    this.pendingRestore = null;
    this.diskBaseline = diskText;
    this.name = file.name.replace(/\.(typ|md)$/i, '');
    this.fileFormat = isMd(file.name) ? '.md' : '.typ';
    this.bibliographyPath = pending;
    this.conflict = differs;
    this.dirty = this.conflict;
    this.hooks.onState();
    if (this.conflict) {
      this.reportConflict(file.name);
      return;
    }
    const bib = pending && !dir ? unreadNote(pending) : await this.readPendingBibliography();
    if (handle !== this.handle) return;
    this.hooks.message(`Reconnected — ${dir ? `${dir.name}/` : ''}${file.name}${bib}`);
  }

  /** Whether the session document's text `localText` differs from the
   *  file's only by its `bibliography:` sidecar, read in when the file was
   *  opened with its folder (withSidecar): the session holds that read,
   *  the file does not until a save embeds it. Not an outside change. */
  private async sidecarOnly(fileName: string, diskText: string, dir: FileSystemDirectoryHandle | null, localText: string): Promise<boolean> {
    if (!dir || !isMd(fileName)) return false;
    const parsed = await this.parse(fileName, diskText);
    if (!parsed.bibliography) return false;
    const opened = await this.withSidecar(parsed, dir, fileName);
    if (opened.pending !== null) return false;
    const { docToMd } = await import('./md-serializer');
    return docToMd(opened.doc, () => {}) === localText;
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
    return this.tabKey ? this.restoreFrom(this.tabKey, true) : false;
  }

  /** Take a file's NAME without its contents or its write access. A window
   *  that cannot reopen its file still knows WHICH document it was showing,
   *  and reverting the title to an untitled sheet throws that away for no
   *  reason — losing access is not losing identity. */
  private adoptFileIdentity(handle: FileSystemFileHandle) {
    this.name = handle.name.replace(/\.(typ|md)$/i, '');
    this.fileFormat = isMd(handle.name) ? '.md' : '.typ';
    this.hooks.onState();
  }

  /** Reconnect to the last open file if the browser still grants access. */
  async restoreLast(): Promise<boolean> {
    return this.restoreFrom('last');
  }

  private async restoreFrom(key: string, ownWindowFile = false): Promise<boolean> {
    if (!this.supportsFS) return false;
    // Kept outside the try so a failure part-way through can still say which
    // document this window was showing.
    let handle: FileSystemFileHandle | null = null;
    try {
      const stored = (await idbGet(key)) as
        | FileSystemFileHandle
        | { handle: FileSystemFileHandle; dir: FileSystemDirectoryHandle }
        | null;
      if (!stored) return false;
      handle = 'handle' in stored ? stored.handle : stored;
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
      if (perm !== 'prompt') {
        // Access is gone for good, but the name is readable without it, and
        // this window's own file is not in question. Keep the title.
        console.warn(`Reconnect to ${handle.name} refused (permission ${perm})`);
        if (ownWindowFile) this.adoptFileIdentity(handle);
        return false;
      }
      // The handle survives but needs a fresh grant, and that requires a
      // user gesture. Take on the file's identity NOW (the restored
      // session doc is its content) and finish on the first interaction.
      const keepSession = this.hooks.hasSessionDoc?.() ?? false;
      this.pendingRestore = { handle, dir, keepSession, startRevision: this.changeRevision };
      this.adoptFileIdentity(handle);
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
    } catch (e) {
      // Never fail silently here: an unexplained return is how a refreshed
      // window ends up calling itself untitled.
      console.warn('Could not reconnect to the stored file', e);
      if (ownWindowFile && handle) this.adoptFileIdentity(handle);
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
      const parsed = await this.parse(file.name, text);
      const sidecar = await this.withSidecar(parsed, null, file.name);
      clearTimeout(this.saveTimer);
      this.handle = null; // no write access in fallback mode
      this.dir = null;
      this.pendingRestore = null;
      this.diskBaseline = null;
      this.conflict = false;
      this.changeRevision = 0;
      this.name = file.name.replace(/\.(typ|md)$/i, '');
      this.fileFormat = isMd(file.name) ? '.md' : '.typ';
      this.bibliographyPath = sidecar.pending;
      this.dirty = false;
      this.hooks.setDoc(sidecar.doc);
      this.hooks.onState();
      this.hooks.message(`Opened ${file.name}${importNote(parsed)}${sidecar.note} (read-only source; saving downloads a copy)`);
    });
    input.click();
  }
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The first `keep` bytes of the SHA-256 of `bytes`, in hex. */
async function sha256Hex(bytes: BufferSource, keep: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, keep)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Typst exports this app wrote (shared kv-store) ----------

/** One record per exported file: its handle (folder and name in one, compared
 *  with isSameEntry) and a short SHA-256 of the bytes written. */
interface TypExportRecord {
  file: FileSystemFileHandle;
  hash: string;
}

const TYP_EXPORTS_KEY = 'typ-exports';
/** 128 bits: a file edited since is told from the export by far more than
 *  any accident, and the record stays small. */
const TYP_EXPORT_HASH_BYTES = 16;
/** Enough for every folder a writer exports from in a term; an older one
 *  dropped off only means its next export asks once. */
const TYP_EXPORTS_KEPT = 32;

// ---------- recents (persisted in the shared kv-store) ----------

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
