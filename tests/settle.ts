import { expect, type Page } from 'playwright/test';

declare global {
  interface Window {
    __pagLog: () => string[];
    __pagCount: () => number;
  }
}

/**
 * Wait for the local pagination of the current document to settle: at
 * least one pass after `countBefore`, then no further pass for `quietMs`.
 * The first pass after a load can run before the port and fonts are up;
 * the quiet window is what "settled" means with one renderer.
 */
export async function settleLocal(page: Page, countBefore = -1, quietMs = 900): Promise<string> {
  let seen = -1;
  let seenAt = 0;
  await expect
    .poll(
      async () => {
        const n = await page.evaluate(() => window.__pagCount());
        const now = Date.now();
        if (n !== seen) {
          seen = n;
          seenAt = now;
          return false;
        }
        return n > countBefore && now - seenAt >= quietMs;
      },
      { timeout: 45_000, intervals: [300] },
    )
    .toBe(true);
  const entry = await page.evaluate(() => window.__pagLog().at(-1) ?? '');
  expect(entry.startsWith('local[')).toBe(true);
  return entry;
}
