import { expect, test, type Page } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __documentCompileBrokerStats(): {
      compilerTasks: number;
      publications: number;
      sharedRequests: number;
      owners: number;
    };
    __compileCoordinatorStats(): {
      running: boolean;
      queueDepth: number;
    };
    __remoteAssetPublicationProbe?: {
      doc: import('prosemirror-model').Node;
      events: number;
    };
  }
}

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function waitForExactPublication(page: Page): Promise<void> {
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => {
    const stats = window.__compileCoordinatorStats();
    return Number(stats.running) + stats.queueDepth;
  })).toBe(0);
}

async function waitForNewPublication(page: Page, prior: number): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => window.__documentCompileBrokerStats().publications),
    { timeout: 30_000 },
  ).toBeGreaterThan(prior);
  await waitForExactPublication(page);
}

async function installAssetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = { doc: window.view.state.doc, events: 0 };
    window.__remoteAssetPublicationProbe = probe;
    window.addEventListener('typeset-assets-changed', () => probe.events++);
  });
}

async function publicationSnapshot(page: Page) {
  return page.evaluate(async () => {
    const { testCompilerLifecycleStats } = await import('/src/typst-worker-client.ts');
    return {
      broker: window.__documentCompileBrokerStats(),
      compilerEpoch: testCompilerLifecycleStats().epoch,
      events: window.__remoteAssetPublicationProbe?.events ?? -1,
      sameDoc: window.__remoteAssetPublicationProbe?.doc === window.view.state.doc,
    };
  });
}

test('granting remote-image permission republishes a cached unchanged document', async ({ page }) => {
  let requests = 0;
  await page.route('https://publication.test/pixel.png', async (route) => {
    requests++;
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: PIXEL,
    });
  });

  await page.goto('/?new=1');
  await waitForExactPublication(page);
  const beforeDocument = await page.evaluate(() => window.__documentCompileBrokerStats());
  await page.evaluate(() => {
    const { state } = window.view;
    const src = 'https://publication.test/pixel.png';
    const figure = state.schema.nodes.figure.create({ src }, state.schema.text('Remote figure'));
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, figure));
  });
  await expect(page.locator('.fig-path-chip.remote')).toBeVisible();
  await waitForNewPublication(page, beforeDocument.publications);
  expect(requests).toBe(0);

  await installAssetProbe(page);
  const ready = await publicationSnapshot(page);
  await page.locator('.fig-path-chip.remote').click();
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator('.ts-figure img')).toHaveAttribute('src', /^blob:/);
  await waitForNewPublication(page, ready.broker.publications);
  const refreshed = await publicationSnapshot(page);

  expect(refreshed.sameDoc).toBe(true);
  expect(refreshed.events).toBe(1);
  expect(refreshed.compilerEpoch).toBe(ready.compilerEpoch + 1);
  expect(refreshed.broker.compilerTasks).toBe(ready.broker.compilerTasks + 1);
  expect(refreshed.broker.publications).toBe(ready.broker.publications + 1);
});

test('an explicit remote-image retry republishes a cached unchanged document', async ({ page }) => {
  let requests = 0;
  await page.route('https://publication-retry.test/pixel.png', async (route) => {
    requests++;
    if (requests === 1) {
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: PIXEL,
    });
  });

  await page.goto('/?new=1');
  await waitForExactPublication(page);
  const beforeDocument = await page.evaluate(() => window.__documentCompileBrokerStats());
  await page.evaluate(() => {
    const { state } = window.view;
    const figure = state.schema.nodes.figure.create(
      { src: 'https://publication-retry.test/pixel.png' },
      state.schema.text('Remote figure'),
    );
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, figure));
  });
  await expect(page.locator('.fig-path-chip.remote')).toBeVisible();
  await waitForNewPublication(page, beforeDocument.publications);

  await installAssetProbe(page);
  const beforePermission = await publicationSnapshot(page);
  await page.locator('.fig-path-chip.remote').click();
  await expect(page.locator('.fig-path-chip.remote-error')).toContainText('retry from publication-retry.test');
  await expect.poll(() => requests).toBe(1);
  await waitForNewPublication(page, beforePermission.broker.publications);
  const readyToRetry = await publicationSnapshot(page);

  await page.locator('.fig-path-chip.remote-error').click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator('.ts-figure img')).toHaveAttribute('src', /^blob:/);
  await waitForNewPublication(page, readyToRetry.broker.publications);
  const refreshed = await publicationSnapshot(page);

  expect(refreshed.sameDoc).toBe(true);
  expect(readyToRetry.events).toBe(1);
  expect(refreshed.events).toBe(2);
  expect(refreshed.compilerEpoch).toBe(readyToRetry.compilerEpoch + 1);
  expect(refreshed.broker.compilerTasks).toBe(readyToRetry.broker.compilerTasks + 1);
  expect(refreshed.broker.publications).toBe(readyToRetry.broker.publications + 1);
});
