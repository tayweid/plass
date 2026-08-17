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

test('shrinking to one page removes every held page spacer', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const paragraphs = Array.from({ length: 32 }, (_, i) =>
      state.schema.nodes.paragraph.create(
        null,
        state.schema.text(
          `Paragraph ${i + 1}. ` +
            'Exact pagination must remain stable while a document is edited and then settle cleanly. '.repeat(5),
        ),
      ),
    );
    const doc = state.schema.nodes.doc.create(state.doc.attrs, paragraphs);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });

  await expect.poll(() => page.locator('.page-box').count(), { timeout: 15_000 }).toBeGreaterThan(1);
  await expect.poll(() => page.locator('.ts-pagegap').count(), { timeout: 15_000 }).toBeGreaterThan(0);

  await page.evaluate(() => {
    const { state } = window.view;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text('A short final document.'));
    const doc = state.schema.nodes.doc.create(state.doc.attrs, [paragraph]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });

  await expect.poll(() => page.locator('.page-box').count(), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => page.locator('.ts-pagegap').count(), { timeout: 15_000 }).toBe(0);
  // Give obsolete long-document compiles time to finish: their completion
  // must not restore the superseded page state.
  await page.waitForTimeout(1_000);
  expect(await page.locator('.page-box').count()).toBe(1);
  expect(await page.locator('.ts-pagegap').count()).toBe(0);
});
