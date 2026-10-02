# Plass.app on the Claerbout shell — the plan

Written 2026-09-30 from the Knuth side, after the shell landed there and
its basic stability was settled (knuth `docs/APP.md`, "Electron, one shell
for Claerbout"; knuth `docs/SHELL_STABILITY.md`). ROADMAP.md's "Planned:
Plass.app on the Claerbout shell" is the decision; this is the work,
in order, with what each step depends on. Conventions as in knuth's
DESIGN.md: DECIDED marks a decision of record, OPEN a question that still
needs one. Nothing here is decided beyond what ROADMAP.md already says.

## Where the two sides stand

**Plass today.** One Swift file (`app/Sources/main.swift`, ~960 lines) puts
the vite build inside a WKWebView: the page from `plass://app/` in the
bundle (compiler WASM and fonts included, 43 MB of `dist`, a 20 MB zip);
a `plass` message handler answering `permission`, `stat`, `read`, `write`,
`child`, `list`, `rename`, `openPanel`, `savePanel`, `folderPanel` and
`document`, with bytes as base64; a grants model (`grants.json`, 400
roots, files and folders chosen in a panel or opened from Finder) that
persists so recents reopen without asking; a Finder open that grants and
opens or fronts a window; the private WebKit flag
`SubpixelInlineLayoutEnabled`; page dialogs; a self-test harness
(`PLASS_SELFTEST`) that runs a script in the page; and `src/native-fs.ts`,
which gives the file manager the File System Access surface over that
handler. The deploy builds it with `app/build.sh` on a GitHub Mac and
publishes `app/Plass.app.zip`; `public/install` unzips it straight over
the old app. The `webkit-app` Playwright project runs the suite in WebKit
with `tests/fixture.ts` standing in for the Swift handler.

**The shell today** (knuth `app/shell/`, after e1746f3). `main.js` is
generic over an `app.json`: name, bundle id, scheme, port, icon, document
types, window sizes, engine command. It owns a window per document, the
`<scheme>://app` page from the bundle, `open` and `saveAs` dialogs, text
file operations (`read`, `write`, `stat`, `rename`, `remove`: UTF-8, 8 MB
limit, any absolute path), Finder opens, single-instance handling, a menu,
and trust per window by the origin the shell loaded into it. It assumes
exactly two Pythons, uv or in the tab, and a setup screen choosing
between them. Around it: `package.mjs` (`@electron/packager`, the app
without Electron's framework, ad-hoc signed on arm64), `complete.sh` (the
framework cloned from a sibling Claerbout app or downloaded and checked,
built beside its place and renamed in), `launcher.swift` (the bundle's
executable: exec Electron, or complete first under a progress window),
`public/install` (unpack beside the destination, complete, refuse a
running app, swap), `smoke.mjs` (Playwright `_electron` against the
built app), and the deploy job that packages both processors, installs
through the install line and smoke-tests before publishing.

What Plass needs that the shell has not got: no Python at all; directory
operations and bytes, not just text; a folder picker; some notion of
which paths the page may touch; and whatever the Swift menu does beyond
New, Open and Close. What Plass has that it can drop: the private WebKit
flag, the WebKit test project and its stand-in, the self-test harness
(Playwright drives the real app instead), and, depending on step 1,
`native-fs.ts` and the grants model.

## Steps

### 1. The experiment that sizes everything else: File System Access in the window

Chromium is the engine now, and the file manager is written for
Chromium's API. Before porting a line of `native-fs.ts`, run Plass's page
inside the shell from the checkout and see what the API does there.

Setup, one afternoon: a `plass.json` beside knuth's `knuth.json` (name,
`envPrefix` PLASS, scheme `plass`, the page path pointed at Plass's
`dist`), and knuth's shell run with `CLAERBOUT_APP=plass.json` after
step 2's change lets it start with no Python. Then, in the window:

- `showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`:
  do they open, and do the handles read and write?
- A handle stored in IndexedDB and read back after relaunch: does
  `queryPermission` say granted, does `requestPermission` resolve
  without a prompt (Electron has no prompt UI; the answer comes from
  `session.setPermissionRequestHandler` and
  `setPermissionCheckHandler`, which the shell can set), and does a
  read then succeed?
- A Finder open: the shell has the path, the page has no handle.
  The app needs a way from a path to a handle, or the page keeps a
  by-path route for opened files.

Three outcomes, and the rest of the plan forks on them:

- **(a) It all works, and persisted handles reopen.** `native-fs.ts`
  and the grants model retire. The shell supplies nothing for files
  except the Finder-open path. This is the ROADMAP's hope; it is
  probably not quite what happens, because of the next case.
- **(b) It works, but persistence needs the shell's say-so.** Chromium
  asks the embedder whether a stored handle may be used again; Chrome
  answers with its own persisted-permissions store, Electron with the
  permission handlers. The shell grants what the page holds, which is
  the grants model in a few lines of `main.js`, with no `grants.json`:
  a handle in IndexedDB is the grant. Most likely.
- **(c) It does not work.** `native-fs.ts` is ported to
  `window.claerbout.request`: `child`, `list`, `folderPanel`,
  `permission` and `document` join the protocol, bytes cross as
  `ArrayBuffer` (structured clone over IPC, no base64), and the grants
  model comes along as a check in `main.js`. The port is mechanical:
  the module already isolates every message in `call()`.

DECIDE on the outcome, in this file, before step 4.

DECIDED (2026-09-30, run against knuth `ba6475f` with `pythons: ["browser"]`
and `web: ../dist` in `app/plass.json`, Playwright `_electron` driving the
window): **outcome (b), and the Finder open has a handle too.** What was
seen, each point tried in the window and again after a relaunch on the
same config folder:

- The page runs from `plass://app/` unchanged: the vite build's relative
  paths resolve, the compiler WASM and the fonts load, the welcome
  document typesets, `window.claerbout` is present and no
  `window.webkit`. `showOpenFilePicker`, `showDirectoryPicker` and
  `showSaveFilePicker` are Chromium's own and open native sheets on the
  window (`sheet-begin` fires; a second picker says "File picker already
  active"). The window must be focused when the picker is asked for, or
  Chromium answers with a plain AbortError; the shell's windows are.
- A `FileSystemFileHandle` and a `FileSystemDirectoryHandle` (obtained
  by a drop of the real paths through the protocol, since a native sheet
  cannot be driven from a script) read, write (`createWritable` reached
  the disk), list entries, and store in IndexedDB. After a relaunch they
  come back: `queryPermission` says `prompt`, `getFile` before any
  request is NotAllowedError, and `requestPermission` resolves without a
  user gesture (Chrome would throw a SecurityError there) and without any
  prompt UI, then reads and writes succeed. Electron answers from
  `session.setPermissionRequestHandler` (`permission: 'fileSystem'`,
  details `{fileAccessType: 'readable' | 'writable', filePath,
  isDirectory}`) and grants when none is set; a handler that denies makes
  `requestPermission` `denied` and every read fail. With
  `setPermissionCheckHandler` returning true for `fileSystem`, a stored
  handle is `granted` at once and reads with no request at all: that is
  Chrome's persisted-permissions store in three lines of `main.js`, and
  it is the grants model. A handle in IndexedDB is the grant; no
  `grants.json`.
- The Finder open: Electron has no API from a path to a handle, but the
  shell can dispatch a drop of the path through the window's own
  debugger (`webContents.debugger.attach('1.3')`, then
  `Input.dispatchDragEvent` with `files: [path]` for `dragEnter`,
  `dragOver`, `drop`), and the page's drop listener receives a real
  `FileSystemFileHandle` (`getAsFileSystemHandle`) that it reads, writes
  and stores like one from a picker. So the page keeps no by-path route:
  the shell opens the window at `?open=<path>` as before and, once the
  page says it is listening, drops the file on it. (Recorded as the
  answer to the first OPEN item below.)
- Service workers cannot register on the custom scheme
  (`navigator.serviceWorker.getRegistrations()` throws
  InvalidStateError); Plass registers none anyway.

So: `native-fs.ts`, `reviveNativeHandles`, the grants model and
`grants.json` retire, and `app/Sources/main.swift`'s whole file protocol
goes with them. The shell's part is the two permission handlers and the
Finder drop, plus the `command` event step 4 describes.


### 2. Which Pythons an app offers becomes config (in knuth)

DONE 2026-09-30 in knuth (`ba6475f`, `pythons` and `web` in `app.json`).
The same day, for step 1's outcome: explicit permission handlers
(`fileSystem`, `fullscreen`, `clipboard-sanitized-write` and the config's
`permissions` for the app's own origins, everything else refused and
logged) and the Finder drop behind `"openBy": "drop"`, made on the page's
`ready` request. Uncommitted in the knuth checkout as this is written.

The shell's state machine encodes uv-or-Pyodide. This is
SHELL_STABILITY's first deferred Phase 2 item, reopened here: `app.json`
gains `"pythons": [...]`; with one entry the setup page never asks, and
`["browser"]` means "the page from the bundle, no engine, no Choose
Python… in the menu". Knuth is unchanged with `["uv", "browser"]`. Done
in knuth, tested with its smoke test in both configs, and needed before
step 1 can run comfortably (without it, the setup screen must be clicked
through each launch).

### 3. The shell moves to its own repository

DONE 2026-09-30: `github.com/tayweid/claerbout`, tagged `v0.1.0` the same
day and `v0.1.1` hours later (`package.mjs --web` resolved against the
config's folder; Plass's `app/build.mjs` had absolutized the path, Knuth's
deploy had not). Then `v0.1.4`/`v0.1.5` the same evening: the deploy's first app jobs
failed in the smoke test on the GitHub Mac, whose shell has no locale and
whose bash 3.2 read `$version…` in `complete.sh` as a variable, so no
framework was placed and the install line still said success (its EXIT
trap ended in a successful `rm`). Found from the Knuth side; the install
line now braces its variables and keeps its exit status. Plass builds on
`v0.1.5`, verified here by installing under `env -i` with no sibling
(Electron downloaded) and running the smoke test on the result. Then
`v0.1.7` on 2026-10-01, with Knuth, when the shell's engine environment
moved beside uv's Pythons (`v0.1.6`/`v0.1.7`, engine-only changes; Plass
has no engine, and its smoke test from the checkout passed on the tag
unchanged). Its README has the config keys. Plass finds it beside the main
checkout for development (`app/shell-path.mjs`, `CLAERBOUT_SHELL`
overrides) and the deploy clones it at `CLAERBOUT_TAG`: the tag is the
dependency. Not an npm dependency on purpose: that would put Electron in
Plass's `node_modules` on every `npm ci`, the Linux verify job included,
for a shell only the Mac app job runs. If it ever becomes one, the
form is the tag's tarball, as Knuth uses:
`https://github.com/tayweid/claerbout/archive/refs/tags/v0.1.1.tar.gz`.
It resolves, carries an integrity hash and survives `npm install`;
`github:tayweid/claerbout#v0.1.0` locks as `git+ssh://`, which a GitHub
runner's `npm ci` cannot fetch, and a `git+https` entry is rewritten back
to it (Knuth's first deploys).

DECIDED in knuth (APP.md): the template leaves knuth when Plass is its
second user. That is now. The repository (`claerbout`, or
`claerbout-shell`) carries `main.js`, `preload.js`, `complete.sh`,
`launcher.swift`, `package.mjs`, the install-line template, `smoke.mjs`
and the deploy steps as a reusable workflow, with `electron` and
`@electron/packager` pinned in its `package.json`. Knuth and Plass each
depend on a tag. The bump rule from SHELL_STABILITY: one tag, one pull
request per app the same day, because a sibling clone needs an exact
Electron match and a gap means a full download for whoever installs in
it.

Two generalizations go in with the move, since Plass is the reason for
them: `package.mjs --config`, and the bundle's contents from config (a
`web` path for the page; the `python` package optional, absent for
Plass), so Plass's bundle is the shell plus `dist`. `smoke.mjs` reads
the app's name, prefix, readiness selector and a run action from the
config too. The install line is generated from a template with the name,
site and prefix filled in.

### 4. The page speaks the shell

DONE 2026-09-30 in this repository (uncommitted): `src/claerbout.ts`
replaces `src/native-fs.ts` (deleted), with `isNativeShell()` as the
bridge's presence and `takeLaunchFile()` returning the dropped handle
(`?open=` taken once, `{type: 'ready'}` sent, the first dropped file of
that name is the launch, a 10 s timeout for a shell that cannot drop).
`kv-store.ts` stores browser handles as they are; `open-files.ts` no
longer announces a path (a picker handle has none; the shell's window →
document map holds the Finder-opened path, which is what it fronts on).
The Swift menu inventory: About, Show Log, Hide, Quit, New Window, Close,
the Edit standards, the Window standards. Nothing acts in the page, so no
`command` item is needed today; ⌘S and ⌘O stay the page's keydown
handlers, which the shell's menu leaves alone. Service worker: none
registered, and none can be on the scheme (step 1).

- `isNativeShell()` becomes "`window.claerbout` is present". The
  `standalone` test in `main.ts` follows it.
- `takeLaunchFile` keeps `?open=<path>`: the shell opens a document
  window at that URL exactly as the Swift one did.
- Files by the outcome of step 1: nothing (a), a permission handler in
  the shell (b), or `native-fs.ts` over `window.claerbout.request` (c).
- The Swift shell's `document` message (which file a window shows, for
  Finder to front it and for the panels' start folder) maps to the
  shell's window → document map; the shell already keeps one for
  `setRepresentedFilename` and the dialogs' start folder.
- The menu. Inventory `buildMenu()` in the Swift shell; New Window,
  Open…, Close and the log are the shell's. Anything that acts in the
  page (save, export, a view toggle) becomes a config-declared item
  that sends a `command` event to the focused window; the page
  subscribes with `window.claerbout.on('command', …)`. This is the one
  protocol addition Plass is likely to need; `fullscreen` is a menu
  role, and `keepAwake` is ManimLive's.
- Confirm the page registers no service worker. Knuth found one inside a
  shell can only serve a stale page; Plass's `index.html` links a
  manifest for the browser install and that is fine to keep.

### 5. Packaging, install and deploy

DONE 2026-09-30, untested in CI until the shell is on GitHub:
`app/plass.json` (with `site` and `elsewhere`), `npm run app`
(`app/run.mjs`, the shell on `dist/`, a document path opens it),
`npm run app:build` (`app/build.mjs`, the shell's `package.mjs --config`;
`--install`, `--zip`, `--arch` pass through), `npm run app:install-script`
(renders `public/install` from the shell's template: the same
`curl … | bash` line, now `Plass-<arch>.zip`, a running Plass refused,
the swap atomic, Electron cloned from a sibling or downloaded once), and
the deploy's app job rewritten on knuth's: clone the shell at
`CLAERBOUT_TAG`, package both processors from the verified site, install
through the install line, smoke-test the installed app and the
self-completing download, publish three zips; the fallback keeps all
three when the build fails. Run here the way the deploy runs it: `--zip`
wrote `Plass-arm64.zip` and `Plass.app.zip` (20 MB each), the rendered
install line installed from that folder with Electron cloned from a
sibling (the complete `--install` build, 331 MB), and `app/smoke.mjs`
passed on the installed app and on the `--install` one. README's
install section says macOS 13 and the Electron download.

- `app/plass.json` in this repository, the shell as a dependency, and
  `npm run app` starting it from the checkout against `dist` or the
  Vite dev server.
- The deploy's app job: package with the config, install through the
  generated install line with `PLASS_SIBLINGS=""`, smoke-test with
  Playwright `_electron` (open a `.typ`, see it render, save, check the
  file), publish `app/Plass-<arch>.zip` and, if the page ever gets a
  download button, `app/Plass.app.zip`. The failure rule stays: a build
  that fails republishes the live app.
- The install line becomes the shell's: refuse a running Plass, unpack
  beside the destination, complete (Knuth's framework cloned when it is
  installed and on the same Electron; else the one-time download), swap.
  The download goes from 20 MB to about 20 MB plus the shell's 3 MB, and
  the first launch or the install line adds Electron.
- macOS 13 or later (Electron 44). The Swift app's floor was lower;
  README's install section says so.

### 6. Tests

DONE 2026-09-30 for what does not wait on step 3: the `webkit-app`
project and the stand-in are gone (`tests/fixture.ts` re-exports
Playwright's own); `npm run app:smoke` (`app/smoke.mjs`) drives the shell
from the checkout or a built app: launch on a `.typ`, the drop opens it,
it typesets on the exact path, an edit and ⌘S reach the disk. It passed
against knuth's shell the day it was written. The deploy runs it against
the built app once step 5 packages one.

- Delete the `webkit-app` project from `playwright.config.ts` and the
  handler stand-in from `tests/fixture.ts`; `chromium` is the app's
  engine and the suite already runs there. `webkit-fallback` stays: it
  covers Safari as a browser, not the app.
- One `_electron` spec (or the shell's `smoke.mjs` with Plass's config)
  drives the built app in CI: launch on a document, render, save, quit.
  It replaces the in-app self-test harness, which drove the page from
  inside the Swift shell because nothing else could.
- The port audit is untouched: it measures the page, not the shell.

### 7. Retire the Swift shell

DONE 2026-09-30, the evening of the first release on the new app
(`app/Sources`, `app/build.sh`, `app/Info.plist`, the self-test harness
with them; AGENTS.md, ROADMAP.md and README describe the shell as it is).
`grants.json` is read by nothing and left where it is. Release note:
recents ask for their folder once, since Chromium's storage starts empty.

After one release on the new app: `app/Sources`, `app/build.sh`,
`app/Info.plist`, the `SubpixelInlineLayoutEnabled` note and the WebKit
caveats wherever they are written, `grants.json` handling (outcome a or
b), and `native-fs.ts` (outcome a). Knuth removed its Swift shell the
same day the Electron one was installed; Plass can wait for one release
because its shell has a grants model to carry across.

What does not carry across: Chromium's storage lives under
`~/Library/Application Support/Plass/Chromium`, so WebKit's IndexedDB
(recents, stored handles) starts empty, and `grants.json` is read by
nothing. Recents re-ask once. Say so in the release note.

## Order and size

Step 2 first, in knuth, half a day. Step 1 next, one afternoon, and its
DECIDE. Step 3 is a day and produces the repository both apps use. Steps
4 and 5 together are the port proper: two to three days for outcome (b),
a day more for (c). Step 6 with them. Step 7 a release later.

Blocked on nothing outside this repository except step 2, and the
signing question (SHELL_STABILITY item 6), which Plass inherits as-is:
ad-hoc signed, Gatekeeper's Open Anyway once, the install line never
prompted.

## OPEN

- ~~Whether a page opened from Finder needs a handle (outcome a or b) or
  keeps a by-path route for that one file.~~ Answered under step 1: the
  shell drops the path on the page and the page holds a real handle.
- ~~Whether Plass wants the page's download button at all, or stays with
  the install line only, as today.~~ Answered 2026-09-30 (`2429264`): File
  → Get Plass for your Mac offers both. And since 2026-10-01 the installed
  app updates itself (shell 0.2.0, `update.js`): File → Check for updates…
  inside Plass.app compares this build with the site's `app/latest.json`
  and installs a newer one, relaunching; the shell also checks quietly
  after launch and the item then reads Install update. `src/claerbout.ts`
  has the three calls (`checkForUpdate`, `installUpdate`, `onUpdate`).
- ~~Fullscreen as a menu role is enough, or the page needs to ask for it.~~
  Both work, checked 2026-10-01 in the shell from the checkout:
  `document.fullscreenEnabled` is true in the window and
  `requestFullscreen()` on the page fills the screen (the shell grants
  the page its own fullscreen, `grantPermissions`), beside View → Toggle
  Full Screen. Nothing to add.
- ~~Whether the page's bar can be the window's title bar, beside the
  traffic lights, as Zen's is.~~ DECIDED 2026-10-01: yes, and the page
  learns it from the Window Controls Overlay, not from the shell. The
  shell's config gains `window.titleBarStyle` (`default`, or
  `hiddenInset`/`hidden`: no native title bar, the page reaches the top
  of the window, the lights over it) and `window.trafficLightPosition`
  (`{x, y}`); `app/plass.json` sets `hiddenInset` and `{x: 20, y: 23}`.
  Whenever the title bar is not native the shell also sets Electron's
  `titleBarOverlay: true`, which on macOS draws nothing and publishes
  the lights' room to the page: `navigator.windowControlsOverlay.visible`
  is true, `getTitlebarAreaRect()` is the rest of the bar, and CSS
  `env(titlebar-area-x/y/width/height)` are set. Under a native title
  bar (the tagged shell v0.2.0, which ignores the two keys; a browser
  tab; the Chrome PWA) `visible` is false and the `env()` fallbacks
  apply, so one stylesheet is right under either bar and nothing crosses
  the bridge; `geometrychange` on the overlay is the event if the page
  ever needs the fact in JS (fullscreen hides the lights and the room
  drops to 0). Measured on the shell's Electron 44.5.0: `hiddenInset` +
  overlay gives area `{x: 84, y: 0, h: 36}` with the lights at their
  default place, `{x: 100, h: 60}` with `{x: 20, y: 23}` (the area is
  2·y + 14 px tall, so y = 23 centres the lights on Plass's 60 px bar);
  `hidden` + overlay `{x: 78, h: 32}`. The bar is `-webkit-app-region:
  drag`, with `no-drag` on the pills, the menus and the view switch;
  Electron handles the mouse over a drag region natively, so hovering
  the bar's empty part no longer wakes every button (hovering a pill
  does) and a click there does not reach the page's outside-click menu
  closer. The bar pads its row by `env(titlebar-area-x)` on both sides,
  so the pills keep the paper's axis; the app's `minWidth` is 740, the
  row's width beside the lights. Plass.app from the deploy is built on
  tag v0.2.0: the frame and the end of the window-fitting ship with the
  next Plass deploy, the bar beside the lights with the next shell tag.
