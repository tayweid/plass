import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests',
  // The port audit (tests/port-audit.spec.ts) is a measurement run on
  // purpose with `npm run audit`, not part of the verification suite.
  testIgnore: process.env.PLASS_AUDIT ? [] : ['**/port-audit.spec.ts'],
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5199',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // The window at which the drawn page is the laid-out page: the
        // panel (src/style.css) is the window less the 44 px rail and the
        // 8 px edge, and a Letter page is 816 CSS px, so 868 px draws it
        // at 1:1 (src/paper-scale.ts). A paper of two sheets or more that
        // runs past the panel has the scroll rail's 20 px gutter at the
        // right (src/scroll-rail.ts) and is drawn at 804 / 816 here. The
        // layout tests read the page's geometry in the layout's own px, as
        // they always have; the layout is the same at any width, which
        // tests/frame.spec.ts checks at other widths with the page drawn
        // larger and smaller.
        viewport: { width: 868, height: 720 },
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
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
