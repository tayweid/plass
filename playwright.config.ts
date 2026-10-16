import { defineConfig } from 'playwright/test';

// The dev server's port: vite.config.ts's 5199, or PLASS_TEST_PORT, which
// `npm run ci` sets to a free port of its own. A server already on 5199
// may be another checkout's (a worktree's) code, and reusing it tests that.
const PORT = Number(process.env.PLASS_TEST_PORT) || 5199;

export default defineConfig({
  testDir: './tests',
  // The port audit (tests/port-audit.spec.ts) is a measurement run on
  // purpose with `npm run audit`, not part of the verification suite.
  testIgnore: process.env.PLASS_AUDIT ? [] : ['**/port-audit.spec.ts'],
  timeout: 30_000,
  // On GitHub a failed test runs once more: a spec that fails on a busy
  // runner and then passes is reported flaky instead of failing the
  // deploy, and a real failure fails both runs.
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // The window at which the drawn page is the laid-out page: the
        // panel (src/style.css) is the window less the 44 px rail and, a
        // paper running past the panel as every Letter page does here, the
        // scroll rail's 20 px gutter (src/scroll-rail.ts), and a Letter
        // page is 816 CSS px, so 880 px draws it at 1:1 (src/paper-scale.ts;
        // a paper that fits the panel keeps the 8 px edge and is drawn at
        // 828 / 816). The layout tests read the page's geometry in the
        // layout's own px, as they always have; the layout is the same at
        // any width, which tests/frame.spec.ts checks at other widths with
        // the page drawn larger and smaller.
        viewport: { width: 880, height: 720 },
        // Linux Chromium hints the bundled fonts by default, which rounds
        // every glyph advance to a whole pixel: a 26-letter run measured
        // 225px against 212.6px on macOS, lines overflowed the port's exact
        // breaks, and every vertical-parity test failed on CI (tests/
        // environment-fingerprint.spec.ts prints the numbers). Unhinted
        // text has the linear advances the layout assumes on every
        // platform. A Chromium flag: WebKit refuses to launch with it.
        launchOptions: { args: ['--font-render-hinting=none'] },
      },
    },
    {
      name: 'firefox-fallback',
      testMatch: /fallback\.spec\.ts/,
      use: { browserName: 'firefox' },
    },
    {
      name: 'webkit-fallback',
      testMatch: /fallback\.spec\.ts/,
      use: { browserName: 'webkit' },
    },
    // Plass.app's engine is Chromium (the Claerbout shell): the `chromium`
    // project covers the app's page, and app/smoke.mjs drives the built app.
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1${process.env.PLASS_TEST_PORT ? ` --port ${PORT}` : ''}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI && !process.env.PLASS_TEST_PORT,
    timeout: 30_000,
  },
});
