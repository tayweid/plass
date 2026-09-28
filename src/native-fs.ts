// Files through Plass.app's Swift shell.
//
// In Chrome the file manager works through the File System Access API:
// pickers hand it FileSystemFileHandle/DirectoryHandle objects, which it
// reads, writes, compares, and stores in IndexedDB. WebKit has none of
// that, so inside Plass.app this module supplies the same surface backed
// by the shell (app/Sources/main.swift, the `plass` message handler): the
// pickers are native panels and every read and write is a message the
// shell answers. Everything above this layer — autosave, conflicts, the
// disk watcher, recents, project folders — is the same code in both.
//
// The shell only touches paths the writer granted: a file or folder chosen
// in one of its panels, or opened from Finder. Grants persist, so recents
// and a reloaded window's own file reopen without asking again (as Chrome's
// persisted permissions do).
//
// A handle is plain data plus methods on its prototype. Structured clone
// (IndexedDB, BroadcastChannel) keeps the data and drops the prototype;
// `reviveNativeHandles` puts it back wherever stored values are read.

interface ShellReply {
  error?: { name: string; message: string };
  [key: string]: unknown;
}

interface ShellBridge {
  postMessage(message: unknown): Promise<ShellReply>;
}

function bridge(): ShellBridge | null {
  if (typeof window === 'undefined') return null; // node tests import the store
  const handlers = (window as unknown as { webkit?: { messageHandlers?: { plass?: ShellBridge } } }).webkit
    ?.messageHandlers;
  return handlers?.plass ?? null;
}

/** Running inside Plass.app (the shell's message handler is present). */
export function isNativeShell(): boolean {
  return bridge() !== null;
}

async function call(message: Record<string, unknown>): Promise<ShellReply> {
  const shell = bridge();
  if (!shell) throw new DOMException('Plass.app shell is not available', 'NotSupportedError');
  const reply = await shell.postMessage(message);
  if (reply?.error) throw new DOMException(reply.error.message, reply.error.name);
  return reply;
}

// ---------- bytes over the bridge (base64 strings) ----------

async function toBase64(data: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(data);
  });
  return url.slice(url.indexOf(',') + 1);
}

function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (native) return native(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const MIME: Record<string, string> = {
  typ: 'text/plain', md: 'text/markdown', txt: 'text/plain', bib: 'text/plain', tex: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', pdf: 'application/pdf',
};

function mimeFor(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? '';
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirname = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf('/')));

function childPath(dir: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/')) {
    throw new DOMException(`Name is not allowed: ${name}`, 'TypeError');
  }
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

// ---------- handles ----------

/** The disk watcher polls getFile() every 1.5 s: answer an unchanged file
 *  from the last read, so a poll costs one stat and no transfer. */
const fileCache = new Map<string, { modified: number; size: number; file: File }>();

type Permission = 'granted' | 'denied' | 'prompt';

abstract class NativeHandle {
  readonly __plassNative = true;
  abstract readonly kind: 'file' | 'directory';
  constructor(
    public path: string,
    public name = basename(path),
  ) {}

  async isSameEntry(other: unknown): Promise<boolean> {
    const o = other as { kind?: string; path?: string } | null;
    return !!o && o.kind === this.kind && o.path === this.path;
  }

  async queryPermission(): Promise<Permission> {
    const reply = await call({ type: 'permission', path: this.path });
    return reply.granted ? 'granted' : 'prompt';
  }

  async requestPermission(): Promise<Permission> {
    return this.queryPermission();
  }
}

export class NativeFileHandle extends NativeHandle {
  readonly kind = 'file' as const;

  async getFile(): Promise<File> {
    const stat = await call({ type: 'stat', path: this.path });
    if (stat.kind !== 'file') throw new DOMException(`${this.name} was not found`, 'NotFoundError');
    const modified = stat.modified as number;
    const size = stat.size as number;
    const cached = fileCache.get(this.path);
    if (cached && cached.modified === modified && cached.size === size) return cached.file;
    const reply = await call({ type: 'read', path: this.path });
    const bytes = fromBase64(reply.data as string);
    const file = new File([bytes as BlobPart], this.name, { type: mimeFor(this.name), lastModified: reply.modified as number });
    fileCache.set(this.path, { modified: reply.modified as number, size: reply.size as number, file });
    return file;
  }

  async createWritable(): Promise<{ write(data: unknown): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> {
    const parts: BlobPart[] = [];
    const path = this.path;
    return {
      async write(data: unknown) {
        parts.push(data as BlobPart);
      },
      async close() {
        await call({ type: 'write', path, data: await toBase64(new Blob(parts)) });
        fileCache.delete(path);
      },
      async abort() {
        parts.length = 0;
      },
    };
  }

  /** Rename in place (Chrome's handle.move(newName)). */
  async move(newName: string): Promise<void> {
    const reply = await call({ type: 'rename', path: this.path, name: newName });
    fileCache.delete(this.path);
    this.path = reply.path as string;
    this.name = basename(this.path);
    announceDocument(this as unknown as FileSystemFileHandle);
  }
}

export class NativeDirectoryHandle extends NativeHandle {
  readonly kind = 'directory' as const;

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<NativeFileHandle> {
    const reply = await call({ type: 'child', path: childPath(this.path, name), kind: 'file', create: !!opts.create });
    return new NativeFileHandle(reply.path as string);
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<NativeDirectoryHandle> {
    const reply = await call({ type: 'child', path: childPath(this.path, name), kind: 'directory', create: !!opts.create });
    return new NativeDirectoryHandle(reply.path as string);
  }

  async resolve(handle: unknown): Promise<string[] | null> {
    const path = (handle as { path?: string } | null)?.path;
    if (!path) return null;
    if (path === this.path) return [];
    const prefix = this.path === '/' ? '/' : `${this.path}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length).split('/') : null;
  }

  async *entries(): AsyncIterableIterator<[string, NativeFileHandle | NativeDirectoryHandle]> {
    const reply = await call({ type: 'list', path: this.path });
    for (const entry of reply.entries as Array<{ name: string; kind: 'file' | 'directory' }>) {
      const path = childPath(this.path, entry.name);
      yield [entry.name, entry.kind === 'file' ? new NativeFileHandle(path) : new NativeDirectoryHandle(path)];
    }
  }

  async *values(): AsyncIterableIterator<NativeFileHandle | NativeDirectoryHandle> {
    for await (const [, handle] of this.entries()) yield handle;
  }

  async *keys(): AsyncIterableIterator<string> {
    for await (const [name] of this.entries()) yield name;
  }

  [Symbol.asyncIterator]() {
    return this.entries();
  }
}

/** Put the prototype back on handles that went through structured clone
 *  (IndexedDB records, BroadcastChannel messages). Anything else passes
 *  through untouched. */
export function reviveNativeHandles<T>(value: T, depth = 0): T {
  if (!value || typeof value !== 'object' || depth > 4) return value;
  const v = value as unknown as { __plassNative?: boolean; kind?: string; path?: string; name?: string };
  if (v.__plassNative === true && typeof v.path === 'string') {
    if (v instanceof NativeHandle) return value;
    return (v.kind === 'directory' ? new NativeDirectoryHandle(v.path, v.name) : new NativeFileHandle(v.path, v.name)) as T;
  }
  if (Array.isArray(value)) return value.map((item) => reviveNativeHandles(item, depth + 1)) as T;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = reviveNativeHandles(item, depth + 1);
  return out as T;
}

// ---------- pickers ----------

type PickerStart = { path?: string; kind?: string } | undefined;

function startIn(handle: unknown): { startIn?: string } {
  const h = handle as PickerStart;
  if (!h?.path) return {};
  return { startIn: h.kind === 'file' ? dirname(h.path) : h.path };
}

function extensions(types?: FilePickerType[]): string[] {
  const out: string[] = [];
  for (const t of types ?? []) for (const list of Object.values(t.accept)) for (const ext of list) out.push(ext.replace(/^\./, ''));
  return out;
}

function aborted(): DOMException {
  return new DOMException('The user aborted a request.', 'AbortError');
}

/** Tell the shell which file this window shows (its title-bar proxy icon,
 *  and where a Finder open of the same file should land). */
export function announceDocument(handle: FileSystemFileHandle | null): void {
  if (!isNativeShell()) return;
  const path = (handle as unknown as { path?: string } | null)?.path ?? null;
  void call({ type: 'document', path }).catch(() => undefined);
}

/** A file this window was opened with from Finder (the shell loads the
 *  page with ?open=<path>). Taken once: the parameter is removed so a
 *  reload restores the window's own session instead. */
export function takeLaunchFile(): FileSystemFileHandle | null {
  if (!isNativeShell()) return null;
  const url = new URL(location.href);
  const path = url.searchParams.get('open');
  if (!path) return null;
  url.searchParams.delete('open');
  window.history.replaceState(null, '', url.toString());
  return new NativeFileHandle(path) as unknown as FileSystemFileHandle;
}

function install(): void {
  if (!isNativeShell()) return;
  window.showOpenFilePicker = async (opts = {}) => {
    const reply = await call({ type: 'openPanel', extensions: extensions(opts.types), multiple: !!opts.multiple, ...startIn(opts.startIn) });
    if (reply.cancelled) throw aborted();
    return (reply.paths as string[]).map((p) => new NativeFileHandle(p)) as unknown as FileSystemFileHandle[];
  };
  window.showSaveFilePicker = async (opts = {}) => {
    const reply = await call({ type: 'savePanel', suggestedName: opts.suggestedName ?? '', ...startIn(opts.startIn) });
    if (reply.cancelled) throw aborted();
    return new NativeFileHandle(reply.path as string) as unknown as FileSystemFileHandle;
  };
  window.showDirectoryPicker = async (opts = {}) => {
    const reply = await call({ type: 'folderPanel', ...startIn(opts.startIn) });
    if (reply.cancelled) throw aborted();
    return new NativeDirectoryHandle(reply.path as string) as unknown as FileSystemDirectoryHandle;
  };
}

install();
