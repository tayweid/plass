import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __breakSig: () => string;
    __layoutPerf: () => {
      live: { totalMs: number; changedBlocks?: number } | null;
      settle: { totalMs: number; paragraphs?: number; lines?: number } | null;
    };
  }
}

test('exact live paragraph remains unchanged when the oracle settles', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const text =
      'The Knuth-Plass algorithm is based on the idea of cost. A line which has a very tight or ' +
      'very loose fit has a higher cost than one that is just right. Ending a line with a hyphen ' +
      'incurs extra cost and ending two successive lines with hyphens even more. There is no ' +
      'hyphenation worth considering in this sentence.';
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(text));
    const doc = state.schema.nodes.doc.create(state.doc.attrs, [paragraph]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });

  const paragraph = page.locator('.ProseMirror > p').first();
  await expect(paragraph).toBeVisible();
  await paragraph.click();
  await page.keyboard.press('End');
  await page.keyboard.type('x');

  await expect.poll(() => page.evaluate(() => window.__layoutPerf().live?.changedBlocks ?? 0)).toBeGreaterThan(0);
  const liveBreaks = await page.evaluate(() => window.__breakSig());
  expect(liveBreaks.length).toBeGreaterThan(0);

  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.__breakSig())).toBe(liveBreaks);

  const perf = await page.evaluate(() => window.__layoutPerf());
  expect(perf.live?.totalMs).toBeGreaterThan(0);
  expect(perf.settle?.totalMs).toBeGreaterThan(0);
  expect(perf.settle?.paragraphs).toBe(1);
});
