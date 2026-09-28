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
    // Plass.app's engine: the whole suite in WebKit with the app's file path
    // (tests/fixture.ts stands in for the Swift shell). macOS only — Linux
    // WebKit is another build with other font rendering, so parity there
    // would say nothing about the app. The no-filesystem fallback is not
    // the app's; webkit-fallback covers it.
    ...(process.platform === 'darwin'
      ? [{
          name: 'webkit-app',
          // A project's testIgnore replaces the top-level one: repeat the audit rule.
          testIgnore: process.env.PLASS_AUDIT ? [/fallback\.spec\.ts/] : [/fallback\.spec\.ts/, /port-audit\.spec\.ts/],
          use: { browserName: 'webkit' as const },
        }]
      : []),
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
