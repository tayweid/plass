// Plass.app's shell: the Claerbout Electron shell (docs/CLAERBOUT-SHELL.md).
//
// Files need nothing from it. The window is Chromium, so the file manager
// works through the File System Access API exactly as in a browser tab:
// the pickers are native sheets, handles read and write, and a handle
// stored in IndexedDB reopens after a relaunch because the shell's
// permission handler grants what the page holds (a stored handle is the
// grant). Two things cross the bridge (`window.claerbout`, preload.js):
//
// - A Finder open. The shell opens a window at `?open=<path>` and, once
//   the page says it is ready, drops the file on it through the window's
//   own debugger: the page receives a real FileSystemFileHandle, like one
//   from a picker. There is no other way from a path to a handle.
// - Nothing else yet. `command` events (menu items acting in the page)
//   are the shell's when a menu item needs one; the shell this replaced
//   had no menu item that acted in the page.

interface ClaerboutBridge {
  request(message: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (detail: unknown) => void): () => void;
}

function bridge(): ClaerboutBridge | null {
  if (typeof window === 'undefined') return null; // node tests import the store
  return (window as unknown as { claerbout?: ClaerboutBridge }).claerbout ?? null;
}

/** Running inside Plass.app (the shell's bridge is present). */
export function isNativeShell(): boolean {
  return bridge() !== null;
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
