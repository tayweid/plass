import { expect, test, type Page } from 'playwright/test';
import { settleLocal } from './settle';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __environment: () => { certified: boolean; ratio: number; browserPx: number; portPx: number } | null;
    __environmentSimulate: (ratio: number) => { certified: boolean } | null;
    __blockAuthority: (pos: number) => { authority: string } | null;
    __shapedWidthPt: (text: string, style?: 'regular' | 'bold' | 'italic') => number | null;
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

/** Hold one startup dependency until the test explicitly releases it. */
async function holdResource(page: Page, url: RegExp) {
  let release = () => {};
  let markRequested = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  await page.route(url, async (route) => {
    markRequested();
    await gate;
    await route.continue();
  });
  return { requested, release };
}

async function insertStartupParagraph(page: Page) {
  return page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText(
      'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. '.repeat(8),
      1,
    ));
    return window.view.state.doc.toJSON();
  });
}

test('the environment probe waits for the browser font when the sidecar arrives first', async ({ page }) => {
  test.setTimeout(60_000);
  const font = await holdResource(page, /NewCM10-Regular\.woff2(?:$|\?)/);
  try {
    // The load event waits for fonts; DOMContentLoaded lets us exercise the
    // actual startup while the browser's body face is still unavailable.
    await page.goto('/?new=1', { waitUntil: 'domcontentloaded' });
    const before = await insertStartupParagraph(page);
    await font.requested;
    await expect.poll(() => page.evaluate(() => window.__shapedWidthPt('Ready')), {
      timeout: 30_000,
    }).not.toBeNull();
    await settleLocal(page);
    expect(await page.evaluate(() => window.__environment())).toBeNull();
    await expect(page.locator('#toast')).not.toContainText('exact layout is off');

    const countBefore = await page.evaluate(() => window.__pagCount());
    font.release();
    await expect.poll(() => page.evaluate(() => window.__environment()?.certified), {
      timeout: 30_000,
    }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__blockAuthority(0)?.authority)).toBe('port');
    await settleLocal(page, countBefore);
    expect(await page.evaluate(() => window.view.state.doc.toJSON())).toEqual(before);
  } finally {
    font.release();
  }
});

test('a late sidecar automatically replaces cached fallback layouts without a document edit', async ({ page }) => {
  test.setTimeout(60_000);
  const sidecar = await holdResource(page, /typeset_sidecar_bg\.wasm(?:$|\?)/);
  try {
    await page.goto('/?new=1', { waitUntil: 'domcontentloaded' });
    const before = await insertStartupParagraph(page);
    await sidecar.requested;
    await page.evaluate(() => document.fonts.ready);
    await settleLocal(page);
    expect(await page.evaluate(() => window.__shapedWidthPt('Ready'))).toBeNull();
    expect(await page.evaluate(() => window.__blockAuthority(0)?.authority)).toBe('fallback');

    const countBefore = await page.evaluate(() => window.__pagCount());
    sidecar.release();
    await expect.poll(() => page.evaluate(() => window.__environment()?.certified), {
      timeout: 30_000,
    }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__blockAuthority(0)?.authority)).toBe('port');
    await settleLocal(page, countBefore);
    expect(await page.evaluate(() => window.view.state.doc.toJSON())).toEqual(before);
  } finally {
    sidecar.release();
  }
});
