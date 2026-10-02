// A smoke test of Plass.app on the Claerbout shell: launch the shell from
// the checkout (or a built app) on a .typ in a throwaway folder, see the
// document open and typeset, edit it, save with ⌘S, and check the disk;
// see the page fill the panel at its width, then drag the window wider
// and zoom (the window stays, the page is drawn larger and nothing is
// laid out again), see the rail under the bar and the menus' blur, and,
// on a shell that hides the title bar, see Knuth's bar beside the
// traffic lights, with the folder the shell knows the file by.
//
//   node app/smoke.mjs                 # the checkout: the shell on dist/
//   node app/smoke.mjs path/to/Plass.app
//
// Needs dist/ (npx vite build) and the shell (app/shell-path.mjs). The
// open relies on the shell's drop-based launch (docs/CLAERBOUT-SHELL.md,
// step 1): the page reports `ready` and the shell drops the file on it.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, repo, shell } from './shell-path.mjs';

const { _electron: electron } = createRequire(path.join(shell, 'package.json'))('@playwright/test');
const bundle = process.argv[2];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plass-smoke-'));
const doc = path.join(work, 'docs', 'smoke.typ');
fs.mkdirSync(path.dirname(doc));
fs.writeFileSync(doc, '= Smoke\n\nA paragraph typeset inside the shell.\n');

const app = await electron.launch({
  ...(bundle
    ? { executablePath: path.join(bundle, 'Contents', 'MacOS', 'Plass'), args: [doc] }
    : { cwd: repo, args: [shell, doc] }),
  env: {
    ...process.env,
    ...(bundle ? {} : { CLAERBOUT_APP: config }),
    PLASS_CONFIG_DIR: path.join(work, 'config'),
  },
  timeout: 300_000,
});
// On GitHub Actions the step log needs a sign-in, but an ::error::
// annotation is on the run's summary for anyone: say it there too.
const report = (line) => {
  console.error(line);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${line.replace(/\n/g, '%0A')}`);
};
const fail = async (message) => {
  report(`smoke: ${message}`);
  // What the window showed and what the shell logged, for a run one
  // cannot watch (the deploy's Mac).
  try {
    const page = app.windows().find((window) => window.url().startsWith('plass://'));
    if (page) {
      report(`smoke: title "${await page.title()}", url ${page.url()}`);
      report(`smoke: page text: ${(await page.evaluate(() => document.body.innerText)).slice(0, 600).replace(/\n+/g, ' | ')}`);
    }
    const log = path.join(os.homedir(), 'Library', 'Logs', 'Plass.log');
    if (fs.existsSync(log)) report(`smoke: Plass.log:\n${fs.readFileSync(log, 'utf8').split('\n').slice(-12).join('\n')}`);
  } catch (error) {
    report(`smoke: (no diagnostics: ${error.message})`);
  }
  await app.close().catch(() => {});
  process.exit(1);
};

let page = null;
const deadline = Date.now() + 60_000;
while (!page && Date.now() < deadline) {
  page = app.windows().find((window) => window.url().startsWith('plass://')) ?? null;
  if (!page) await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!page) await fail(`no document window (${app.windows().map((window) => window.url())})`);
page.on('pageerror', (error) => report(`smoke: page error: ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') report(`smoke: console: ${message.text()}`); });

// The document opens (the shell's drop) and typesets.
await page.waitForFunction(() => document.title.startsWith('smoke'), null, { timeout: 30_000 })
  .catch(() => fail(`the document did not open (title: ${document.title})`));
await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('typeset inside the shell'), null, { timeout: 30_000 })
  .catch(() => fail('the document did not render'));
// Chromium unhinted: the exact path must be on (src/environment-check.ts).
const notice = await page.evaluate(() => document.body.innerText.includes('exact') && document.body.innerText.includes('off'));
if (notice) await fail('the environment check turned the exact path off');

// Edit and save.
await page.click('.ProseMirror p');
await page.keyboard.press('End');
await page.keyboard.type(' Edited.');
await page.keyboard.press('Meta+s');
for (let i = 0; i < 40 && !fs.readFileSync(doc, 'utf8').includes('Edited.'); i++) await page.waitForTimeout(250);
const saved = fs.readFileSync(doc, 'utf8');
if (!saved.includes('Edited.')) await fail(`⌘S did not reach the disk:\n${saved}`);

// The paper is the panel (src/style.css, src/paper-scale.ts): the page is
// laid out at its own width, 816 CSS px, and drawn at the panel's width by
// a transform, so it meets the panel's edges at any window width, and a
// resize or a zoom draws it larger or smaller without laying anything out
// again. Every pagination pass writes its stats into the HUD's title (the
// built page has no test hooks), so a pass is a mutation of that
// attribute: there must be none across the drag and the zoom. The page
// once resized the window to the paper 180 ms after every resize, which
// snapped a drag back and, under a zoom, walked the window there in four
// steps over a second; nothing sizes the window now. A zoom step goes
// through View → Zoom In as a user takes it, where a shell that follows
// the zoom (app/plass.json followZoom, shell 0.2.1) scales the window in
// one step; a zoom level set from outside the menu is the page's alone.
// One item is a half step, ×1.2^0.5.
// The shell this runs on: the checkout's main.js, or the bundle's, read for what it can do.
const shellMain = bundle ? path.join(bundle, 'Contents', 'Resources', 'app', 'main.js') : path.join(shell, 'main.js');
const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
const paper = () => page.evaluate(() => {
  const panel = document.getElementById('scroll').getBoundingClientRect();
  const stack = document.getElementById('stack');
  const drawn = stack.getBoundingClientRect();
  return {
    panel: { left: panel.left, right: panel.right, width: panel.width },
    drawn: { left: drawn.left, right: drawn.right, width: drawn.width },
    laid: stack.offsetWidth,
    editor: document.querySelector('.ProseMirror').clientWidth,
  };
});
const filled = (p) => p.laid === 816 && Math.abs(p.drawn.left - p.panel.left) < 0.05 && Math.abs(p.drawn.right - p.panel.right) < 0.05;
const window0 = await bounds();
const atRest = await paper();
if (!filled(atRest)) await fail(`the page does not fill the panel: ${JSON.stringify(atRest)}`);
await page.evaluate(() => {
  window.__passes = 0;
  window.__passAt = performance.now();
  window.__resizes = 0;
  new MutationObserver((records) => {
    window.__passes += records.length;
    window.__passAt = performance.now();
  }).observe(document.getElementById('hud'), { attributes: true, attributeFilter: ['title'] });
  window.addEventListener('resize', () => { window.__resizes += 1; });
});
// The edit's own settled pass first (it runs 250 ms after the last key):
// a second without one, then count from nothing.
await page.waitForFunction(() => performance.now() - window.__passAt > 1000, null, { timeout: 30_000 })
  .catch(() => fail('the page never settled after the edit'));
await page.evaluate(() => { window.__passes = 0; });
await app.evaluate(({ BrowserWindow }, width) => {
  const window = BrowserWindow.getAllWindows()[0];
  window.setSize(width, window.getBounds().height);
}, window0.width + 200);
await page.waitForTimeout(600);
const dragged = await bounds();
if (dragged.width !== window0.width + 200) await fail(`a drag from ${window0.width} to ${window0.width + 200} wide was answered with ${dragged.width}`);
const wider = await paper();
if (!filled(wider) || !(wider.drawn.width > atRest.drawn.width + 150)) await fail(`a wider window did not draw the page wider: ${JSON.stringify({ atRest, wider })}`);
await page.evaluate(() => { window.__resizes = 0; });
const follows = fs.existsSync(shellMain) && fs.readFileSync(shellMain, 'utf8').includes('followZoom');
const viewItem = (label) => app.evaluate(({ Menu }, name) => {
  const view = Menu.getApplicationMenu().items.find((item) => item.label === 'View');
  view.submenu.items.find((item) => item.label === name && item.visible !== false).click();
}, label);
if (follows) { await viewItem('Zoom In'); await page.waitForTimeout(200); await viewItem('Zoom In'); }
else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(1));
await page.waitForTimeout(800);
const zoomed = await bounds();
const resizes = await page.evaluate(() => window.__resizes);
const underZoom = await paper();
// Knuth's bar (src/style.css, the name pill; knuth/src/styles.css): its
// height is the lights' band at every zoom (--topbar is the overlay's
// height in CSS px), so its row stays on the traffic lights.
const band = await page.evaluate(() => {
  const overlay = navigator.windowControlsOverlay;
  return { lights: overlay?.visible ? overlay.getTitlebarAreaRect().height : null, bar: document.getElementById('toolbar').getBoundingClientRect().height };
});
if (band.lights !== null && Math.abs(band.lights - band.bar) > 0.5) await fail(`under a zoom step the lights' band is ${band.lights}px and the bar ${band.bar}px`);
if (follows) await viewItem('Actual Size');
else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(0));
await page.waitForTimeout(600);
const passes = await page.evaluate(() => window.__passes);
const grew = zoomed.width / dragged.width;
if (follows ? grew < 1.09 || grew > 1.25 : zoomed.width !== dragged.width || zoomed.height !== dragged.height) {
  await fail(`a zoom step took the window from ${dragged.width}×${dragged.height} to ${zoomed.width}×${zoomed.height}${follows ? ' (the shell should have scaled it with the zoom, up to its display)' : ''}`);
}
if (resizes < 1 || resizes > 4) await fail(`a zoom step fired ${resizes} resize events`);
if (!filled(underZoom)) await fail(`under a zoom step the page does not fill the panel: ${JSON.stringify(underZoom)}`);
if (underZoom.editor !== atRest.editor || wider.editor !== atRest.editor) await fail(`the editor's width moved: ${atRest.editor}, ${wider.editor}, ${underZoom.editor} CSS px`);
if (passes) await fail(`a drag and a zoom step ran ${passes} pagination pass(es); they should only draw the page at another scale`);

// Zen's shape (src/style.css): the bar across the top, the rail down the
// left under it, the panel of paper in the rest, edged by the frame's 8 px
// at the window's right and bottom, under any shell.
const frame = await page.evaluate(() => {
  const rect = (id) => document.getElementById(id).getBoundingClientRect();
  const bar = rect('toolbar');
  const rail = rect('rail');
  const panel = rect('scroll');
  return { bar: { bottom: bar.bottom }, rail: { left: rail.left, top: rail.top, right: rail.right, bottom: rail.bottom }, panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom }, paper: getComputedStyle(document.getElementById('scroll')).backgroundColor, width: innerWidth, height: innerHeight };
});
if (frame.rail.left !== 0 || frame.rail.top !== frame.bar.bottom || frame.rail.bottom !== frame.height || frame.panel.left !== frame.rail.right || frame.panel.top !== frame.bar.bottom
  || frame.panel.right !== frame.width - 8 || frame.panel.bottom !== frame.height - 8 || frame.paper !== 'rgb(255, 255, 255)') {
  await fail(`the rail is not under the bar down the left edge of the panel of paper: ${JSON.stringify(frame)}`);
}

// The menus are frosted glass over the paper (src/toolbar.css): the
// built stylesheet must keep the unprefixed backdrop-filter, the one
// Chromium reads. The minifier once kept only a hand-written -webkit-
// line, and the paper showed through the File menu, its text readable.
await page.click('#toolbar .tb-tile');
const glass = await page.evaluate(() => {
  const menu = document.querySelector('.tb-menu:not([hidden])');
  return menu ? getComputedStyle(menu).backdropFilter : null;
});
await page.keyboard.press('Escape');
if (!glass || glass === 'none') await fail(`the File menu draws no blur (backdrop-filter: ${glass})`);

// A shell that hides the title bar (app/plass.json, titleBarStyle; the
// shell's README) publishes the lights' room to the page as the Window
// Controls Overlay, and the bar pads its row by it on the left, where
// its File tile then sits. Plass.app is built on a tag of the shell,
// which carries the key only from its next tag: the check is for a shell
// that has it.
// Knuth's bar, as knuth main has it since c6875a4 ("The bar as tall as
// the rail is wide", 2026-10-02), measured in the same shell: the bar the
// lights' band (44 px at rest, the rail's width; app/plass.json puts the
// lights at {14, 15}, so the band is 2·15 + 14), the File tile 32 px
// square 12 px past the lights' room and 6 px down, the name pill 30 px
// tall 7 px down, centred on the band, Export beside it.
const hidesTitleBar = process.platform === 'darwin' && fs.existsSync(shellMain) && fs.readFileSync(shellMain, 'utf8').includes('titleBarStyle');
if (hidesTitleBar) {
  const bar = await page.evaluate(() => {
    const overlay = navigator.windowControlsOverlay;
    const rect = overlay?.getTitlebarAreaRect?.();
    const toolbar = document.getElementById('toolbar');
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      visible: overlay?.visible === true,
      x: rect?.x ?? 0,
      height: rect?.height ?? 0,
      barHeight: toolbar.getBoundingClientRect().height,
      padding: parseFloat(getComputedStyle(toolbar).paddingLeft),
      file: box(toolbar.querySelector('.tb-tile')),
      pod: box(document.getElementById('doc-pod')),
    };
  });
  if (!bar.visible || bar.x <= 0) await fail(`the shell hides the title bar but the page sees no overlay (${JSON.stringify(bar)})`);
  if (bar.height !== bar.barHeight || bar.barHeight !== 44) await fail(`the lights' room is ${bar.height}px tall, the bar ${bar.barHeight}px (Knuth's is 44)`);
  if (bar.padding !== bar.x + 12 || bar.file.x !== bar.x + 12) await fail(`the File tile is at ${bar.file.x}px, the bar padded ${bar.padding}px, the lights' room ${bar.x}px (Knuth's tile is 12 px past it)`);
  if (bar.file.width !== 32 || bar.file.height !== 32 || bar.file.y !== 6) await fail(`the File tile is ${JSON.stringify(bar.file)} (Knuth's is 32 px square, 6 px down)`);
  if (bar.pod.height !== 30 || bar.pod.y !== 7) await fail(`the name pill is ${JSON.stringify(bar.pod)} (Knuth's is 30 px tall, 7 px down)`);
}

// The folder beside the name: the shell answers the page's report of its
// file with the path (src/claerbout.ts reportDocument), and the pill shows
// its folder, home as ~. A shell without the record (older than 0.2.1)
// answers nothing: said and skipped.
const folder = await page.evaluate(() => {
  const el = document.getElementById('doc-folder');
  return { text: el.textContent, title: el.title, shown: getComputedStyle(el).display !== 'none' };
});
// (The shell keeps the path it was given; /var is /private/var.)
const expectedFolder = [path.dirname(doc), fs.realpathSync(path.dirname(doc))];
if (fs.existsSync(shellMain) && fs.readFileSync(shellMain, 'utf8').includes('autosave.js')) {
  if (!folder.shown || !expectedFolder.includes(folder.title)) await fail(`the pill's folder is ${JSON.stringify(folder)}, not ${expectedFolder[0]}`);
} else console.log('smoke: the shell answers no path; the folder is not checked');

// Finder opens the same file again: the shell lands a new window on it,
// which finds the file open here, has this window brought forward and
// closes itself (src/main.ts openLaunched). A shell without the focus
// request leaves the toast in that window: said and skipped, since the
// checkout beside this one may predate it.
const knows = await page.evaluate(() => window.claerbout.request({ type: 'focus' }));
if (knows?.focused === true) {
  // The document is in the Dock: how a second open most often finds it, and
  // the slow path for the shell's focus answer (macOS restores the window
  // first).
  const first = await app.browserWindow(page);
  await first.evaluate((window) => window.minimize());
  await page.waitForTimeout(500);
  const opened = app.waitForEvent('window', { timeout: 30_000 });
  await app.evaluate(({ app: electronApp }, file) => electronApp.emit('open-file', { preventDefault() {} }, file), doc);
  const second = await opened;
  for (let i = 0; i < 80 && !second.isClosed(); i++) await page.waitForTimeout(250);
  if (!second.isClosed()) {
    const toast = await second.evaluate(() => document.getElementById('toast')?.textContent ?? '').catch(() => '?');
    await fail(`the second window on ${path.basename(doc)} stayed open (toast: "${toast}")`);
  }
  if (page.isClosed() || app.windows().length !== 1) await fail(`windows after the second open: ${app.windows().map((window) => window.url()).join(', ') || 'none'}`);
  if (await first.evaluate((window) => window.isMinimized())) await fail('the first window was not restored from the Dock');
  const front = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() ?? null);
  if (front === null) console.log('smoke: no window is focused here (the app is not active); the fronting is not checked');
  else if (!front.startsWith('smoke')) await fail(`after the second open the focused window is "${front}", not the first`);
} else console.log('smoke: the shell has no focus request; the second open is not checked');

// The autosave record (the shell's autosave.js; app/plass.json `autosave`,
// knuth's docs/AUTOSAVE.md): the document's folder, in no repository of
// anyone's, got one of its own, and its claerbout-autosave branch has the
// session's opening commit, made by the shell once the window's file was
// known. The page told it: the shell lands a Finder open with the path it
// was given, and the page reports the handle's path back (`document`)
// whenever its file changes. The user's side of that repository is
// untouched: HEAD is still unborn. A shell without the record (the
// checkout beside this one may predate it) is said and skipped.
const keepsRecord = fs.existsSync(shellMain) && fs.readFileSync(shellMain, 'utf8').includes('autosave.js');
if (keepsRecord) {
  const folder = path.dirname(doc);
  const recorded = () => {
    try {
      return execFileSync('git', ['-C', folder, 'log', '--format=%s', 'claerbout-autosave'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  let subjects = [];
  for (let i = 0; i < 60 && !subjects.includes('plass: session open'); i++) {
    subjects = recorded();
    if (!subjects.includes('plass: session open')) await page.waitForTimeout(500);
  }
  if (!subjects.includes('plass: session open')) await fail(`the autosave record has no "plass: session open" commit (it has: ${subjects.join(' | ') || 'no branch'})`);
  // One session: a report the shell could not match would have closed it
  // and the second open reopened it.
  if (subjects.filter((subject) => subject === 'plass: session open').length !== 1) await fail(`the session opened more than once (${subjects.join(' | ')})`);
  const head = spawnSync('git', ['-C', folder, 'rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' });
  if (head.status === 0) await fail(`the autosave record touched the user's HEAD (${head.stdout.trim()})`);
  // The page's report: the shell knows the window's file from the name
  // the page sent, matched to the file its handle touched, which is where
  // the window's represented file comes from.
  const represented = await (await app.browserWindow(page)).evaluate((window) => window.getRepresentedFilename());
  if (path.basename(represented) !== path.basename(doc)) await fail(`the window's represented file is "${represented}", not ${path.basename(doc)}`);
  console.log(`smoke: autosave record: ${subjects.join(' | ')}`);
} else console.log('smoke: the shell keeps no autosave record; not checked');

await app.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`smoke (${bundle ? path.basename(bundle) : 'checkout'}): ok`);
