import { expect, test } from 'playwright/test';

// SOURCE-VIEW.md step 0, decision 6: the page machinery sleeps while the
// ProseMirror view is mounted but hidden behind the (future) source view.
// A hidden editor measures zero heights, so any pass that runs behind it
// would capture a poisoned pagination snapshot; a compile nobody is looking
// at wastes the worker. This spec drives the app's own instances through
// the DEV hooks (`window.view`, `__layoutSuspend`, the stats counters) —
// never a dynamic import of app modules (CLAUDE.md, testing gotchas).

interface CompilerStats {
  tasksPosted: number;
  active: boolean;
  queued: number;
}

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
    __pagCount: () => number;
    __layoutSuspend: (suspended: boolean) => boolean;
    __layoutDispatchStats: (reset?: boolean) => { lines: number; pageMarks: number };
    __paginationSnapshotStats: (reset?: boolean) => {
      captures: number;
      spacerScans: number;
      heightQueries: number;
    };
    __pageParityStats: (reset?: boolean) => { predictions: number };
    __compilerLifecycleStats: () => Promise<CompilerStats>;
  }
}

type Page = import('playwright/test').Page;

const SENTENCE =
  'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';

async function buildMultiPageDocument(page: Page): Promise<void> {
  await page.goto('/?new=1');
  await page.evaluate((sentence) => {
    const { state } = window.view;
    const { schema } = state;
    const blocks = [];
    for (let i = 0; i < 14; i++) {
      blocks.push(schema.nodes.paragraph.create(null, schema.text(`Paragraph ${i + 1}. ` + sentence.repeat(8).trim())));
    }
    const doc = schema.nodes.doc.create(state.doc.attrs, blocks);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  }, SENTENCE);
}

/** Wait until Typst's page answer for the current document is installed. */
async function settleExact(page: Page, pagCountAbove: number): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate((above) => {
          const log = window.__pagLog();
          return window.__pagCount() > above && (log.at(-1)?.startsWith('exact[') ?? false);
        }, pagCountAbove),
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true);
  return page.evaluate(() => window.__pagLog().at(-1)!);
}

/** Pages implied by a pagination log entry: one spacer per page break. */
function pagesInEntry(entry: string): number {
  const list = entry.slice(entry.indexOf(']:') + 2);
  return list ? list.split(',').length + 1 : 1;
}

/** Counters that must not move while the editor sleeps. */
async function quietCounters(page: Page) {
  return page.evaluate(async () => {
    const compiler = await window.__compilerLifecycleStats();
    return {
      passes: window.__pagCount(),
      lastEntry: window.__pagLog().at(-1) ?? null,
      dispatches: window.__layoutDispatchStats(),
      snapshot: window.__paginationSnapshotStats(),
      parityPredictions: window.__pageParityStats().predictions,
      compilerTasks: compiler.tasksPosted,
    };
  });
}

/** Let every background compile and telemetry pass for the current
 * document drain, so the counters below describe only the sleep window. */
async function drainBackgroundWork(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(async () => {
      const s = await window.__compilerLifecycleStats();
      return !s.active && s.queued === 0;
    }), { timeout: 20_000 })
    .toBe(true);
  await page.waitForTimeout(1_500);
  await page.evaluate(() => {
    window.__layoutDispatchStats(true);
    window.__paginationSnapshotStats(true);
  });
}

async function hideEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('editor')!.style.display = 'none';
    document.getElementById('pages')!.style.display = 'none';
  });
}

async function showEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('editor')!.style.display = '';
    document.getElementById('pages')!.style.display = '';
  });
}

/** The pass count after two animation frames: resume() schedules its one
 * settled pass on the next frame, and no oracle can answer that fast. */
async function passesAfterTwoFrames(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.__pagCount())));
      }),
  );
}

test('a hidden, suspended editor runs no pass, compiles nothing, and resumes into exact pagination', async ({ page }) => {
  await buildMultiPageDocument(page);
  const exactBefore = await settleExact(page, 0);
  const pagesBefore = pagesInEntry(exactBefore);
  expect(pagesBefore).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.locator('.page-box').count()).toBe(pagesBefore);
  await drainBackgroundWork(page);

  const before = await quietCounters(page);
  expect(await page.evaluate(() => window.__layoutSuspend(true))).toBe(true);
  await hideEditor(page);
  // The failure this spec exists to catch: a hidden editor measures nothing.
  expect(await page.evaluate(() => window.view.dom.clientWidth)).toBe(0);

  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Typed while the page view slept. ', 1));
  });
  await page.waitForTimeout(2_000);

  const during = await quietCounters(page);
  expect(during.passes).toBe(before.passes);
  expect(during.lastEntry).toBe(before.lastEntry);
  expect(during.dispatches).toEqual({ lines: 0, pageMarks: 0 });
  expect(during.snapshot).toEqual({ captures: 0, spacerScans: 0, heightQueries: 0 });
  expect(during.parityPredictions).toBe(before.parityPredictions);
  expect(during.compilerTasks).toBe(before.compilerTasks);
  // The edit itself landed in the document; only its layout waited.
  expect(await page.evaluate(() => window.view.state.doc.firstChild!.textContent)).toContain('Typed while the page view slept.');

  await showEditor(page);
  expect(await page.evaluate(() => window.__layoutSuspend(false))).toBe(false);
  // Exactly one full pass on resume — the same pass an opened document gets.
  expect(await passesAfterTwoFrames(page)).toBe(before.passes + 1);
  const resumed = await page.evaluate(() => window.__pagLog().at(-1)!);
  expect(resumed.startsWith('exact[')).toBe(false);
  expect(await page.evaluate(() => window.__paginationSnapshotStats().captures)).toBeGreaterThanOrEqual(1);

  // The re-armed oracle answers for the edited document.
  const exactAfter = await settleExact(page, before.passes);
  expect(pagesInEntry(exactAfter)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.locator('.page-box').count()).toBe(pagesInEntry(exactAfter));
  const after = await quietCounters(page);
  expect(after.compilerTasks).toBeGreaterThan(before.compilerTasks);
});

test('resuming an unchanged document lands back on its exact pagination in one pass', async ({ page }) => {
  await buildMultiPageDocument(page);
  const exactBefore = await settleExact(page, 0);
  await drainBackgroundWork(page);

  const before = await quietCounters(page);
  await page.evaluate(() => window.__layoutSuspend(true));
  await hideEditor(page);
  await page.waitForTimeout(500);
  const during = await quietCounters(page);
  expect(during.passes).toBe(before.passes);
  expect(during.snapshot.captures).toBe(0);

  await showEditor(page);
  await page.evaluate(() => window.__layoutSuspend(false));
  expect(await passesAfterTwoFrames(page)).toBe(before.passes + 1);
  // The oracle cache survived sleep: the one resumed pass is already exact,
  // with the same page breaks, and no compile was needed to get there.
  expect(await page.evaluate(() => window.__pagLog().at(-1))).toBe(exactBefore);
  await page.waitForTimeout(1_000);
  const after = await quietCounters(page);
  expect(after.passes).toBe(before.passes + 1);
  expect(after.compilerTasks).toBe(before.compilerTasks);
  expect(await page.locator('.page-box').count()).toBe(pagesInEntry(exactBefore));
});
