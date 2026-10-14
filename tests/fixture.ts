// The test and expect every spec imports: Playwright's own. Plass.app's
// window is Chromium (the Claerbout shell, docs/CLAERBOUT-SHELL.md), so the
// `chromium` project is the app's page as well as the browser's; the built
// app itself is driven by app/smoke.mjs.
export { test, expect } from 'playwright/test';
export type { Page } from 'playwright/test';
