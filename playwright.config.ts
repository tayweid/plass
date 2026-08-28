import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5199',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'firefox-fallback',
      testMatch: /(?:fallback|cross-browser-core)\.spec\.ts/,
      use: { browserName: 'firefox' },
    },
    {
      name: 'webkit-fallback',
      testMatch: /(?:fallback|cross-browser-core)\.spec\.ts/,
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
