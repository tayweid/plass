import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __environment: () => { certified: boolean; ratio: number; browserPx: number; portPx: number } | null;
    __environmentSimulate: (ratio: number) => { certified: boolean } | null;
    __blockAuthority: (pos: number) => { authority: string } | null;
  }
}

// The startup probe: the browser's text run against the port's shaped
// width. On this runner they agree; a browser that hints (Linux Chromium
// out of the box) would not, and the exact path goes off, visibly.
test('the environment probe certifies this browser and would fall back on a hinting one', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await expect.poll(() => page.evaluate(() => window.__environment()), { timeout: 30_000 }).not.toBeNull();
  const verdict = (await page.evaluate(() => window.__environment()))!;
  expect(verdict.certified).toBe(true);
  expect(Math.abs(verdict.ratio - 1)).toBeLessThan(0.004);
  expect(verdict.browserPx).toBeGreaterThan(100);

  // A paragraph laid out by the port before the simulated mismatch.
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('The committee reconvened after lunch to weigh the revised proposal against the earlier draft. '.repeat(3), 1));
  });
  await expect.poll(() => page.evaluate(() => window.__blockAuthority(0)?.authority), { timeout: 20_000 }).toMatch(/port|compiled/);

  // A hinting browser: six percent wide. The exact path goes off, the
  // writer is told, and the next layout comes from the legacy breaker.
  const simulated = await page.evaluate(() => window.__environmentSimulate(1.06));
  expect(simulated?.certified).toBe(false);
  await expect(page.locator('#toast')).toContainText('exact layout is off');
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('More words. ', 1));
  });
  await expect.poll(() => page.evaluate(() => window.__blockAuthority(0)?.authority), { timeout: 20_000 }).toBe('fallback');
});
