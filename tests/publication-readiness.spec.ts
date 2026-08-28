import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __layoutSnapshotStats(): {
      status: string;
      pages: number;
      blocks: number;
      revision: number;
      reason: string | null;
    };
    __layoutDispatchStats(reset?: boolean): { lines: number; pageMarks: number };
    __releaseExactPublication?: () => void;
  }
}

test('fresh lines and pages wait until every shared-publication view is ready', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(async () => {
    const { documentPreviewManagerFor } = await import('/src/raw-preview.ts');
    const manager = documentPreviewManagerFor(window.view);
    const ready = manager.isReadyFor.bind(manager);
    let released = false;
    manager.isReadyFor = ((doc) => released && ready(doc)) as typeof manager.isReadyFor;
    window.__releaseExactPublication = () => {
      released = true;
    };

    const { state } = window.view;
    const s = state.schema;
    const prose = 'Publication readiness must be atomic across line decisions and compiled atom geometry. ';
    const paragraph = s.nodes.paragraph.create(null, [
      s.text(prose.repeat(18)),
      s.nodes.math_inline.create({ src: '\\frac{x^2+1}{y}' }),
      s.text((' ' + prose).repeat(8)),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
  });

  // The manager may finish decoding and paint the formula first; the
  // deterministic gate simulates one more geometry consumer still retaining
  // the older publication.
  await expect(page.locator('.math-inline')).toHaveAttribute('data-preview-state', 'ready', {
    timeout: 30_000,
  });
  await expect.poll(() => page.evaluate(() => window.__layoutSnapshotStats().status), {
    timeout: 30_000,
  }).toBe('ok');
  await page.waitForTimeout(350);

  expect(await page.locator('#stack').getAttribute('data-page-mode')).not.toBe('exact');
  await expect(page.locator('.ProseMirror > p').first().locator('.ts-br, .ts-hyphen')).toHaveCount(0);

  await page.evaluate(async () => {
    window.__layoutDispatchStats(true);
    window.__releaseExactPublication?.();
    const { scheduleTypeset } = await import('/src/typeset-plugin.ts');
    scheduleTypeset(window.view);
  });

  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect.poll(() => page.locator('.ProseMirror > p').first().locator('.ts-br, .ts-hyphen').count())
    .toBeGreaterThan(0);
  const dispatches = await page.evaluate(() => window.__layoutDispatchStats());
  expect(dispatches.lines).toBe(1);
});
