// A smoke test of Plass.app on the Claerbout shell: launch the shell from
// the checkout (or a built app) on a .typ in a throwaway folder, see the
// document open and typeset, edit it, save with ⌘S, and check the disk.
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
const fail = async (message) => {
  console.error(`smoke: ${message}`);
  // What the window showed and what the shell logged, for a run one
  // cannot watch (the deploy's Mac).
  try {
    const page = app.windows().find((window) => window.url().startsWith('plass://'));
    if (page) {
      console.error(`smoke: title "${await page.title()}", url ${page.url()}`);
      console.error(`smoke: page text: ${(await page.evaluate(() => document.body.innerText)).slice(0, 600).replace(/\n+/g, ' | ')}`);
    }
    const log = path.join(os.homedir(), 'Library', 'Logs', 'Plass.log');
    if (fs.existsSync(log)) console.error(`smoke: Plass.log:\n${fs.readFileSync(log, 'utf8').split('\n').slice(-12).join('\n')}`);
  } catch (error) {
    console.error(`smoke: (no diagnostics: ${error.message})`);
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
page.on('pageerror', (error) => console.error(`smoke: page error: ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') console.error(`smoke: console: ${message.text()}`); });

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

await app.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`smoke (${bundle ? path.basename(bundle) : 'checkout'}): ok`);
