// Plass.app's shell: the Claerbout Electron shell (docs/CLAERBOUT-SHELL.md).
//
// Files need nothing from it. The window is Chromium, so the file manager
// works through the File System Access API exactly as in a browser tab:
// the pickers are native sheets, handles read and write, and a handle
// stored in IndexedDB reopens after a relaunch because the shell's
// permission handler grants what the page holds (a stored handle is the
// grant). Three things cross the bridge (`window.claerbout`, preload.js):
//
// - A Finder open. The shell opens a window at `?open=<path>` and, once
//   the page says it is ready, drops the file on it through the window's
//   own debugger: the page receives a real FileSystemFileHandle, like one
//   from a picker. There is no other way from a path to a handle.
// - A window asking to come forward (`focus`, shell 0.2.1). Every Finder
//   open lands in a new window, since the shell cannot know which window
//   holds which file; when that file is already open in another window,
//   that window fronts itself and the new one closes (open-files.ts,
//   main.ts openLaunched). No page can focus another window; the shell
//   can, on that window's own request.
// - The app updating itself (the shell's update.js): `update` requests
//   check the site for a newer build (and, with action 'install', install
//   it), and `update` events report the shell's own check after launch and
//   the install's steps, until the app relaunches into the new build.
// - Which file this window holds (`document`, with the shell's autosave
//   record; knuth's docs/AUTOSAVE.md). The shell keeps a git record of
//   every project a window is on, and for that it needs the window's file
//   as a path, which a page that keeps files by handle cannot learn
//   itself. The page sends the handle's name whenever its open file
//   changes (`reportDocument`, from the file manager's handle setter),
//   with the path when the preload's `pathOf(file)` knows it (Electron's
//   webUtils.getPathForFile: a dropped File has a path; a File from a
//   handle's getFile() is blob-backed and has none, measured
//   2026-10-02), with the File's size and lastModified, and the shell
//   matches them against the files its permission handler has lately
//   seen handles touch — Chromium asks it, with the path but no window,
//   on every read and write. The shell also makes it the window's
//   represented file. Knuth opens by path and never needs this.
// - Nothing else. `command` events (menu items acting in the page) are
//   the shell's when a menu item needs one; the shell this replaced had no
//   menu item that acted in the page.

interface ClaerboutBridge {
  request(message: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (detail: unknown) => void): () => void;
  /** The path of a File the page holds; '' when Chromium has none for it.
   *  Absent on a shell older than the autosave record. */
  pathOf?(file: File): string;
}

function bridge(): ClaerboutBridge | null {
  if (typeof window === 'undefined') return null; // node tests import the store
  return (window as unknown as { claerbout?: ClaerboutBridge }).claerbout ?? null;
}

/** Running inside Plass.app (the shell's bridge is present). */
export function isNativeShell(): boolean {
  return bridge() !== null;
}

/** Ask the shell to bring THIS window forward: shown, unminimized, focused,
 *  the app made active. True when it did. False in a browser tab, and under
 *  a shell without the `focus` request (older than 0.2.1: it logs "unknown
 *  shell message" and answers null), which is how a launch window knows it
 *  cannot leave the file to the window that has it. Never rejects. */
export function focusThisWindow(): Promise<boolean> {
  const shell = bridge();
  if (!shell) return Promise.resolve(false);
  return shell.request({ type: 'focus' }).then(
    (reply) => (reply as { focused?: unknown } | null)?.focused === true,
    () => false,
  );
}

/** Tell the shell which file this window holds now (null: none), so its
 *  window → document map is right for a page that keeps files by handle:
 *  the window's represented file, and the project its autosave record
 *  follows. The handle's name, size and lastModified go, and its path
 *  when the preload's `pathOf` knows it (only a path-backed File; one
 *  from a handle is not, and the shell matches the rest to the file the
 *  handle touched instead — reading the File here is what makes it
 *  touch it first). Nothing in a browser tab, and nothing under a shell
 *  without `pathOf` (older than the record). Never rejects.
 *
 *  Resolves to the file's path as the shell knows it — the path it took,
 *  or the file it matched the report to — or null: a browser tab, an
 *  older shell, no file, or a report that matched nothing. The page keeps
 *  it to show where the document lives (the bar's folder, toolbar.ts). */
export function reportDocument(handle: FileSystemFileHandle | null): Promise<string | null> {
  const shell = bridge();
  if (!shell || typeof shell.pathOf !== 'function') return Promise.resolve(null);
  const pathOf = shell.pathOf.bind(shell);
  const send = (message: { path: string | null; name?: string; size?: number; modified?: number }) =>
    shell.request({ type: 'document', ...message }).then(
      (reply) => {
        const path = (reply as { path?: unknown } | null)?.path;
        return typeof path === 'string' && path.startsWith('/') ? path : null;
      },
      () => null,
    );
  if (!handle) return send({ path: null });
  return handle.getFile().then(
    (file) => {
      let path: string;
      try {
        path = pathOf(file);
      } catch {
        return null; // the bridge is broken: nothing to tell
      }
      return send({ path: path || null, name: handle.name, size: file.size, modified: file.lastModified });
    },
    () => null,
  );
}

/** How long the shell gets to drop the launched file once told the page
 *  is ready. A drop is one protocol round trip; this is for a shell that
 *  does not know how (an older one), so the window does not hang launching. */
const LAUNCH_DROP_MS = 10_000;

/** The file this window was opened with from Finder, or null. The shell
 *  loads the page with ?open=<path>; the parameter is taken once (removed,
 *  so a reload restores the window's own session instead) and the handle
 *  arrives as a drop the shell makes after the page reports `ready`. The
 *  first dropped file of that name is the launch; nothing else is. */
export function takeLaunchFile(): Promise<FileSystemFileHandle> | null {
  const shell = bridge();
  if (!shell) return null;
  const url = new URL(location.href);
  const path = url.searchParams.get('open');
  if (!path) return null;
  url.searchParams.delete('open');
  window.history.replaceState(null, '', url.toString());
  const name = path.slice(path.lastIndexOf('/') + 1);
  return new Promise<FileSystemFileHandle>((resolve, reject) => {
    const stop = () => {
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('drop', onDrop, true);
      window.clearTimeout(timer);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onDrop = (e: DragEvent) => {
      const item = [...(e.dataTransfer?.items ?? [])].find((i) => i.kind === 'file');
      if (!item) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
        .getAsFileSystemHandle?.()
        .then((handle) => {
          if (!handle || handle.kind !== 'file' || handle.name !== name) return;
          stop();
          resolve(handle as FileSystemFileHandle);
        });
    };
    const timer = window.setTimeout(() => {
      stop();
      reject(new DOMException(`${name} never arrived from the shell`, 'TimeoutError'));
    }, LAUNCH_DROP_MS);
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('drop', onDrop, true);
    void shell.request({ type: 'ready' }).catch(() => undefined);
  });
}

/** A step of Plass.app updating itself, as the shell reports it: `state`
 *  is one of current, available, development, unsupported, failed (a
 *  check's answers), then downloading, unpacking, completing, installing,
 *  ready (an install's events). */
export interface UpdateStep {
  state: string;
  text?: string;
  percent?: number | null;
  latest?: { version?: string | null; build?: string; built?: string | null };
  current?: { version?: string | null; build?: string | null; built?: string | null };
}

/** Ask the shell to compare this build with the site's; null outside it. */
export function checkForUpdate(): Promise<UpdateStep | null> {
  const shell = bridge();
  if (!shell) return Promise.resolve(null);
  return shell.request({ type: 'update' }).then((reply) => (reply ?? null) as UpdateStep | null, () => null);
}

/** Have the shell download the site's build, swap it in and relaunch;
 *  the steps arrive through `onUpdate`. */
export function installUpdate(): void {
  void bridge()?.request({ type: 'update', action: 'install' }).catch(() => undefined);
}

/** The shell's update events; returns the unsubscribe. */
export function onUpdate(listener: (step: UpdateStep) => void): () => void {
  const shell = bridge();
  if (!shell) return () => {};
  return shell.on('update', (detail) => listener((detail ?? {}) as UpdateStep));
}
