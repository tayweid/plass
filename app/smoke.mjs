// A smoke test of Plass.app on the Claerbout shell: launch the shell from
// the checkout (or a built app) on a .typ in a throwaway folder, see the
// document open and typeset, edit it, save with ⌘S, and check the disk;
// then drag the window wider and zoom (the window stays, the paper does
// not re-lay), and, on a shell that hides the title bar, see the bar
// padded by the traffic lights' room.
//
//   node app/smoke.mjs                 # the checkout: the shell on dist/
//   node app/smoke.mjs path/to/Plass.app
//
// Needs dist/ (npx vite build) and the shell (app/shell-path.mjs). The
// open relies on the shell's drop-based launch (docs/CLAERBOUT-SHELL.md,
// step 1): the page reports `ready` and the shell drops the file on it.
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

// The window is room around a fixed-width paper (src/style.css, the
// room): nothing sizes the window back to the paper, so a drag wider
// stays wider — the page once resized itself to the paper 180 ms after
// every resize, which snapped a drag back and, under a zoom (innerWidth
// in zoomed px, resizeTo in screen px), walked the window to the zoomed
// paper's width in four steps over a second. A zoom step now scales the
// paper in place: one resize event, the window's bounds untouched, the
// editor's width (in CSS px) the same, so the layout never runs.
const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
const window0 = await bounds();
await app.evaluate(({ BrowserWindow }, width) => {
  const window = BrowserWindow.getAllWindows()[0];
  window.setSize(width, window.getBounds().height);
}, window0.width + 200);
await page.waitForTimeout(600);
const dragged = await bounds();
if (dragged.width !== window0.width + 200) await fail(`a drag from ${window0.width} to ${window0.width + 200} wide was answered with ${dragged.width}`);
const editorWidth = () => page.evaluate(() => document.querySelector('.ProseMirror').clientWidth);
const widthBefore = await editorWidth();
await page.evaluate(() => {
  window.__resizes = 0;
  window.addEventListener('resize', () => { window.__resizes += 1; });
});
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(1));
await page.waitForTimeout(800);
const zoomed = await bounds();
const resizes = await page.evaluate(() => window.__resizes);
const widthAfter = await editorWidth();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(0));
if (zoomed.width !== dragged.width || zoomed.height !== dragged.height) await fail(`a zoom step moved the window from ${dragged.width}×${dragged.height} to ${zoomed.width}×${zoomed.height}`);
if (resizes !== 1) await fail(`a zoom step fired ${resizes} resize events, not one`);
if (widthAfter !== widthBefore) await fail(`a zoom step changed the editor's width from ${widthBefore} to ${widthAfter}`);

// A shell that hides the title bar (app/plass.json, titleBarStyle; the
// shell's README) publishes the lights' room to the page as the Window
// Controls Overlay, and the bar pads its row by it. Plass.app is built
// on a tag of the shell, which carries the key only from its next tag:
// the check is for a shell that has it.
const shellMain = bundle ? path.join(bundle, 'Contents', 'Resources', 'app', 'main.js') : path.join(shell, 'main.js');
const hidesTitleBar = process.platform === 'darwin' && fs.existsSync(shellMain) && fs.readFileSync(shellMain, 'utf8').includes('titleBarStyle');
if (hidesTitleBar) {
  const bar = await page.evaluate(() => {
    const overlay = navigator.windowControlsOverlay;
    const rect = overlay?.getTitlebarAreaRect?.();
    const toolbar = document.getElementById('toolbar');
    return {
      visible: overlay?.visible === true,
      x: rect?.x ?? 0,
      height: rect?.height ?? 0,
      barHeight: toolbar.getBoundingClientRect().height,
      padding: parseFloat(getComputedStyle(toolbar).paddingLeft),
    };
  });
  if (!bar.visible || bar.x <= 0) await fail(`the shell hides the title bar but the page sees no overlay (${JSON.stringify(bar)})`);
  if (bar.height !== bar.barHeight) await fail(`the lights' room is ${bar.height}px tall, the bar ${bar.barHeight}px`);
  if (bar.padding <= bar.x) await fail(`the bar is padded ${bar.padding}px, inside the lights' ${bar.x}px`);
}

await app.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`smoke (${bundle ? path.basename(bundle) : 'checkout'}): ok`);
