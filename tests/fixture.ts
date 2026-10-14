// The test and expect every spec imports: Playwright's own. Plass.app's
// window is Chromium (the Claerbout shell, docs/CLAERBOUT-SHELL.md), so the
// `chromium` project is the app's page as well as the browser's; the built
// app itself is driven by app/smoke.mjs.
//
// In Chromium each test gets a persistent context (its own fresh profile
// directory) instead of Playwright's usual off-the-record one. Chromium 153
// (Playwright 1.63) kills the browser process (SIGTRAP) when an off-the-record
// profile reads a stored file handle out of IndexedDB — an OPFS handle put
// in IDB and read straight back is enough — and the app keeps its open file,
// its recents and its Typst exports as handles in IDB, so every test that
// opens a file through the origin private file system took the browser down
// ("Target page, context or browser has been closed"). Chromium 151
// (Playwright 1.62) and a persistent profile on 153 both read it back. The
// page is the same app either way: Plass.app's shell is a persistent
// profile too.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from 'playwright/test';

export const test = base.extend({
  // The other browsers (the fallback projects) keep Playwright's context.
  context: async ({ context: offTheRecord, browserName, playwright, launchOptions, headless, viewport, baseURL, permissions }, use) => {
    if (browserName !== 'chromium') return use(offTheRecord);
    const profile = await mkdtemp(join(tmpdir(), 'plass-pw-'));
    const context = await playwright.chromium.launchPersistentContext(profile, { ...launchOptions, headless, viewport, baseURL, permissions });
    await use(context);
    await context.close();
    await rm(profile, { recursive: true, force: true });
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()));
  },
});

/** The key that puts the caret at the end of its line. On a Mac,
 *  Playwright sends End as the Mac's scrollToEndOfDocument: Chrome moves
 *  the caret as well, but it also smooth-scrolls the panel to the bottom
 *  of the paper, and a test that reads geometry in the next 100 ms or so
 *  (a pill, a click point) finds it mid-scroll. Cmd+Right is the Mac's
 *  line end, and moves only the caret. */
export const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';
export { expect } from 'playwright/test';
export type { Page } from 'playwright/test';
