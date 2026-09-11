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
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
