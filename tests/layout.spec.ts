import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __breakSig: () => string;
    __layoutPerf: () => {
      live: { totalMs: number; changedBlocks?: number } | null;
      settle: { totalMs: number; paragraphs?: number; lines?: number } | null;
    };
    __layoutDispatchStats: (reset?: boolean) => { lines: number; pageMarks: number };
    __paginationSnapshotStats: (reset?: boolean) => {
      captures: number;
      spacerScans: number;
      tableScans: number;
      heightQueries: number;
    };
  }
}

test('exact live paragraph remains unchanged when the oracle settles', async ({ page }) => {
  await page.goto('/?new=1');
  const text =
    'The Knuth-Plass algorithm is based on the idea of cost. A line which has a very tight or ' +
    'very loose fit has a higher cost than one that is just right. Ending a line with a hyphen ' +
    'incurs extra cost and ending two successive lines with hyphens even more. There is no ' +
    'hyphenation worth considering in this sentence.';
  await page.evaluate((text) => {
    const { state } = window.view;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(text));
    const doc = state.schema.nodes.doc.create(state.doc.attrs, [paragraph]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  }, text);

  const paragraph = page.locator('.ProseMirror > p').first();
  await expect(paragraph).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__breakSig().length)).toBeGreaterThan(0);
  // Let the initial document's compiled verification and page pass drain so
  // the counter below describes only the edit under test.
  await page.waitForTimeout(1_200);
  await page.evaluate(() => window.__layoutDispatchStats(true));
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Swiftly, ', 1));
  });

  await expect.poll(() => page.evaluate(() => window.__layoutDispatchStats().lines)).toBe(1);
  const liveBreaks = await page.evaluate(() => window.__breakSig());
  expect(liveBreaks.length).toBeGreaterThan(0);

  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.__breakSig())).toBe(liveBreaks);
  expect(await page.evaluate(() => window.__layoutDispatchStats().lines)).toBe(1);
  expect(await paragraph.textContent()).toBe('Swiftly, ' + text);

  const perf = await page.evaluate(() => window.__layoutPerf());
  expect(perf.live?.totalMs).toBeGreaterThan(0);
  expect(perf.settle?.totalMs).toBeGreaterThan(0);
  expect(perf.settle?.paragraphs).toBe(1);
});

test('caption and footnote edits share one exact live decoration update', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { schema, doc: current } = window.view.state;
    const caption =
      'A long figure caption exercises exact line selection while its editable text changes. '.repeat(6);
    const note = schema.nodes.footnote.create(
      null,
      schema.text('A sufficiently long footnote body also wraps across several exact lines. '.repeat(5)),
    );
    const figure = schema.nodes.figure.create(
      {
        src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        label: '',
        name: '',
      },
      [schema.text(caption), note],
    );
    const doc = schema.nodes.doc.create(current.attrs, [figure]);
    window.view.dispatch(window.view.state.tr.replaceWith(0, current.content.size, doc.content));
  });

  await expect(page.locator('figcaption')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__breakSig().length)).toBeGreaterThan(0);
  await page.waitForTimeout(1_200);

  await page.evaluate(() => window.__layoutDispatchStats(true));
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Precisely, ', 1));
  });
  await expect.poll(() => page.evaluate(() => window.__layoutDispatchStats().lines)).toBe(1);
  const captionBreaks = await page.evaluate(() => window.__breakSig());
  await page.waitForTimeout(1_200);
  expect(await page.evaluate(() => window.__breakSig())).toBe(captionBreaks);
  expect(await page.evaluate(() => window.__layoutDispatchStats().lines)).toBe(1);

  await page.evaluate(() => window.__layoutDispatchStats(true));
  await page.evaluate(() => {
    const { state } = window.view;
    let footnotePos = -1;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'footnote') {
        footnotePos = pos;
        return false;
      }
      return true;
    });
    if (footnotePos < 0) throw new Error('footnote fixture was not created');
    window.view.dispatch(state.tr.insertText('Notably, ', footnotePos + 1));
  });
  await expect.poll(() => page.evaluate(() => window.__layoutDispatchStats().lines)).toBe(1);
  const footnoteBreaks = await page.evaluate(() => window.__breakSig());
  await page.waitForTimeout(1_200);
  expect(await page.evaluate(() => window.__breakSig())).toBe(footnoteBreaks);
  expect(await page.evaluate(() => window.__layoutDispatchStats().lines)).toBe(1);
  expect(
    await page.evaluate(() => {
      let text = '';
      window.view.state.doc.descendants((node) => {
        if (node.type.name === 'footnote') {
          text = node.textContent;
          return false;
        }
        return true;
      });
      return text;
    }),
  ).toMatch(/^Notably, /);
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

  await page.evaluate(() => window.__paginationSnapshotStats(true));
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Precisely, ', 1));
  });
  await expect
    .poll(() => page.evaluate(() => window.__paginationSnapshotStats().captures), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(1_200);
  const paginationStats = await page.evaluate(() => window.__paginationSnapshotStats());
  expect(paginationStats.spacerScans).toBe(paginationStats.captures);
  expect(paginationStats.tableScans).toBe(paginationStats.captures);
  expect(paginationStats.heightQueries).toBeGreaterThan(0);

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
