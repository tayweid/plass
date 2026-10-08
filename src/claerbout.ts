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
// - A rewind (the shell's history view, its History page over the
//   record). Before it writes anything the shell asks every window on
//   the project to `save` (answered `saved`, within 3 s, or the window is
//   passed over and its card says to reopen it), and after it every
//   window hears `reload` with the paths it wrote or removed: the window
//   whose file is among them reads it again (`onShellSave`,
//   `onShellReload`).
// - Closing a window with unsaved work (shell 0.2.8). The page tells the
//   shell whether closing now would lose work, and what the close
//   dialog's Save can do (`unsaved`, `unsavedReporter`); at ⌘W, the red
//   button, File › Close, ⌘Q and an update's relaunch the shell asks the
//   page to `save {reason: 'close', choose}` quietly first, and shows the
//   standard sheet (Save / Don't Save / Cancel) when that cannot be done.
//   The page never registers `beforeunload` in the shell: Electron would
//   refuse the close without a word, and block ⌘Q with it.
// - The History page in the room (shell 0.2.3). The History tile beside
//   the name, File › History… and the shell's View › History… toggle the
//   shell's History page over this window's panel, the room (#scroll),
//   not a window of its own (Taylor, 2026-10-02: "instead of a new
//   window, i just want it to open in the same window in the main area"):
//   `openHistory` sends the room's box, `moveHistory` the box again when
//   it changes, `closeHistory` puts it away, and `onHistoryView` hears
//   the shell say when it is up (`history {kind: 'inline', state}`, the
//   only thing the tile's pressed look follows) and View › History…
//   asking the page to do what its tile does (`toggle`). The document
//   stays loaded under it, so a rewind's save and reload above reach it
//   as they reach any window on the project. toolbar.ts drives it.
// - The View menu's zoom (shell 0.2.11, `window.zoom: "page"` in
//   app/plass.json): the shell holds Chromium's zoom at 1, so the bar and
//   the rail never scale, and tells the page `zoom {step}`; the paper
//   draws itself larger or smaller (paper-scale.ts zoomPaper).
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

/** The View menu's Zoom In (1), Zoom Out (-1) and Actual Size (0), as the
 *  shell tells them; returns the unsubscribe; nothing outside the app, and
 *  nothing under a shell older than 0.2.11 (it zoomed the window itself). */
export function onShellZoom(listener: (step: 1 | -1 | 0) => void): () => void {
  const shell = bridge();
  if (!shell) return () => {};
  return shell.on('zoom', (detail) => {
    const step = (detail as { step?: unknown } | null)?.step;
    if (step === 1 || step === -1 || step === 0) listener(step);
  });
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

/** What closing this window now would cost, as the page tells the shell
 *  (`{type: 'unsaved', ...}`), and what the close dialog's Save can do.
 *  - `unsaved`: closing now would lose work. A blank sheet that was never
 *    saved is not unsaved: it closes without a question.
 *  - `name`: the document's name with its extension, for the dialog's
 *    "Do you want to save the changes you made to “Notes.md”?".
 *  - `save`: 'quiet', the document has a file and its edits can be
 *    written without asking (autosave has not got to them yet); 'choose',
 *    the writer picks a place (never saved, or the file moved away);
 *    'none', no Save at all (the file changed outside Plass, which is
 *    never overwritten quietly: the writer settles it in the window).
 *  - `label`: the Save button's words when they are not the shell's
 *    ("Save…" for 'choose', "Save" for 'quiet').
 *  - `detail`: the dialog's second line when it is not the shell's. */
export interface UnsavedReport {
  unsaved: boolean;
  name: string;
  save: 'quiet' | 'choose' | 'none';
  label?: string;
  detail?: string;
}

/** The window's `unsaved` reports. Call the function it returns with the
 *  window's values once after load and whenever they may have changed;
 *  it sends only when they did. It resolves to whether the shell guards
 *  this window's close: a shell from 0.2.8 answers `{guarded: true}`; an
 *  older one answers null, after which nothing more is sent (its log
 *  would fill with "unknown shell message") and the close is the shell's
 *  as it always was. A report the bridge failed is sent again with the
 *  next call. Nothing in a browser tab, whose close is the page's own
 *  `beforeunload`. Never rejects. */
export function unsavedReporter(): (report: UnsavedReport) => Promise<boolean> {
  let refused = false;
  let guarded = false;
  let sent = '';
  return (report) => {
    const shell = bridge();
    if (!shell || refused) return Promise.resolve(false);
    const message: Record<string, unknown> = { type: 'unsaved', unsaved: report.unsaved, name: report.name, save: report.save };
    if (report.label) message.label = report.label;
    if (report.detail) message.detail = report.detail;
    const key = JSON.stringify(message);
    if (key === sent) return Promise.resolve(guarded);
    sent = key;
    return shell.request(message).then(
      (reply) => {
        guarded = (reply as { guarded?: unknown } | null)?.guarded === true;
        if (!guarded) refused = true;
        return guarded;
      },
      () => {
        if (sent === key) sent = '';
        return false;
      },
    );
  };
}

/** What a shell's `save` asks: `reason`, 'rewind' (a rewind is about to
 *  write the project) or 'close' (the window is closing with unsaved
 *  work); `choose`, for a close, whether the writer pressed Save in the
 *  shell's dialog, so the page may open its own picker to give the
 *  document a place (the shell has granted the page a user activation
 *  for it), or only the quiet write it tries first. */
export interface ShellSaveAsk {
  reason: string;
  choose: boolean;
}

/** The shell's `save {id, reason, choose?}`. For a rewind (`reason:
 *  'rewind'`), every window on the project writes its open document
 *  before the rewind writes the project's files; for a close (`reason:
 *  'close'`), the closing window saves first, quietly or, with `choose`,
 *  through its own picker. `save` resolves to null once the document is
 *  on disk (at once when nothing changed), or to why it could not, in
 *  words that follow "could not be saved:" on the History page's card;
 *  the answer is `{type: 'saved', id, ok: true}` or `{type: 'saved', id,
 *  ok: false, error}`, which refuses the rewind or keeps the window open.
 *  The shell waits 3 s for a rewind's and a quiet close's answer, and as
 *  long as it takes for a chosen one (a picker stays open as long as the
 *  writer needs). Returns the unsubscribe; nothing outside the app. */
export function onShellSave(save: (ask: ShellSaveAsk) => Promise<string | null>): () => void {
  const shell = bridge();
  if (!shell) return () => {};
  return shell.on('save', (detail) => {
    const { id, reason, choose } = (detail ?? {}) as { id?: unknown; reason?: unknown; choose?: unknown };
    if (typeof id !== 'string') return;
    void save({ reason: typeof reason === 'string' ? reason : 'rewind', choose: choose === true })
      .then(
        (error) => error,
        (e: unknown) => (e instanceof Error ? e.message : String(e)) || 'Plass could not write it',
      )
      .then((error) =>
        shell.request(error === null ? { type: 'saved', id, ok: true } : { type: 'saved', id, ok: false, error }),
      )
      .catch(() => undefined);
  });
}

/** What a `reload` says of the rewind that wrote the file: the commit it
 *  went to (`to`, a full sha) and, for another app's rewind, which app
 *  (`app`, as the record names it: 'knuth'). */
export interface Rewound {
  to: string | null;
  app: string | null;
}

/** What the window says when a rewind reloads its paper: "Rewound to
 *  1a2b3c4" (the commit, as the History page shows it, seven
 *  characters), or "Rewound by Knuth" when another app made it. */
export function rewoundText({ to, app }: Rewound): string {
  if (app) return `Rewound by ${app.charAt(0).toUpperCase()}${app.slice(1)}`;
  return to ? `Rewound to ${to.slice(0, 7)}` : 'Rewound';
}

/** One file, however the two sides spell it: the shell sends the paths it
 *  wrote as git's top level (symbolic links resolved) joined with each
 *  file's path in the record, while this window's path is the one it was
 *  given, and on a Mac /tmp, /var and /etc are links into /private: the
 *  smoke's document under os.tmpdir() is /var/folders/… to the window
 *  and /private/var/folders/… in a rewind's paths. */
export function samePath(a: string, b: string): boolean {
  const bare = (p: string) => (/^\/private\/(tmp|var|etc)(\/|$)/.test(p) ? p.slice('/private'.length) : p);
  return a === b || bare(a) === bare(b);
}

/** The shell's `reload {id, paths, reason: 'rewind', to, app?}`: a rewind
 *  wrote or removed `paths` (absolute). When this window's file, as the
 *  shell knows it (`path()`, the answer to `document`), is among them,
 *  `reload` reads it again; otherwise nothing happens. The shell sends
 *  it after its own rewinds and when it sees another app's on the
 *  record; nothing is answered. Returns the unsubscribe; nothing outside
 *  the app. */
export function onShellReload(path: () => string | null, reload: (rewound: Rewound) => void): () => void {
  const shell = bridge();
  if (!shell) return () => {};
  return shell.on('reload', (detail) => {
    const { paths, to, app } = (detail ?? {}) as { paths?: unknown; to?: unknown; app?: unknown };
    const mine = path();
    if (!mine || !Array.isArray(paths) || !paths.some((p) => typeof p === 'string' && samePath(p, mine))) return;
    reload({ to: typeof to === 'string' && to ? to : null, app: typeof app === 'string' && app ? app : null });
  });
}

/** The room's box in the page's CSS px (its getBoundingClientRect). */
export interface RoomBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Ask the shell for the History page of this window's project, laid over
 *  `room` in this window (`{type: 'history', action: 'open', inline}`).
 *  Resolves to what it did:
 *  - 'inline': the page is in the room (`{opened: true, inline: true}`,
 *    shell 0.2.3). A window with no record gets it too, saying why (not
 *    saved yet, the folder rule in words, the record off, no git), so the
 *    page has nothing of its own to say then. A second ask while it is up
 *    answers the same and changes nothing.
 *  - 'window': a shell from before the room (0.2.1, 0.2.2) answers
 *    `{opened: true}` without `inline` and opens its History window, as
 *    it always did; nothing is up in the room, and no event says so.
 *  - null: a browser tab, a shell without the history view (older than
 *    0.2.1 answers null), a box the shell refused (`{opened: false}`), or
 *    a failed bridge. Never rejects. */
export function openHistory(room: RoomBox): Promise<'inline' | 'window' | null> {
  const shell = bridge();
  if (!shell) return Promise.resolve(null);
  return shell.request({ type: 'history', action: 'open', inline: room }).then(
    (reply) => {
      const { opened, inline } = (reply ?? {}) as { opened?: unknown; inline?: unknown };
      if (opened !== true) return null;
      return inline === true ? 'inline' : 'window';
    },
    () => null,
  );
}

/** The room's box changed while the History page is in it: the shell moves
 *  the page to it (`bounds`). Answered `{ok: true}`, or `{ok: false}` when
 *  nothing is up; either way there is nothing to do with it. */
export function moveHistory(room: RoomBox): void {
  void bridge()?.request({ type: 'history', action: 'bounds', inline: room }).catch(() => undefined);
}

/** Put the History page in the room away (`close`; answered `{closed:
 *  true}` whether or not one was up). The tile un-presses when the shell
 *  says it went, not here. */
export function closeHistory(): void {
  void bridge()?.request({ type: 'history', action: 'close' }).catch(() => undefined);
}

/** What the shell says of the History page in the room: it came or went
 *  (`{kind: 'inline', state: 'open' | 'closed'}`, whichever side moved it:
 *  the tile, Escape or the close tile in the page, View › History…, a
 *  reload of this page), or View › History… asks this page to do what its
 *  tile does (`{kind: 'toggle'}`, sent only while nothing is up: the
 *  room's box is the page's to send). */
export type HistoryViewEvent = { kind: 'inline'; open: boolean } | { kind: 'toggle' };

/** The shell's `history` events to a document page; returns the
 *  unsubscribe; nothing outside the app. Other kinds (the History page's
 *  own: commit, refs, state, focus) never reach a document page and are
 *  passed over. */
export function onHistoryView(listener: (event: HistoryViewEvent) => void): () => void {
  const shell = bridge();
  if (!shell) return () => {};
  return shell.on('history', (detail) => {
    const { kind, state } = (detail ?? {}) as { kind?: unknown; state?: unknown };
    if (kind === 'inline' && (state === 'open' || state === 'closed')) listener({ kind, open: state === 'open' });
    else if (kind === 'toggle') listener({ kind });
  });
}
