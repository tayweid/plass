import { expect, test, type Page } from 'playwright/test';

const FRAME_CEILING_MS = 50;

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __layoutDispatchStats(reset?: boolean): { lines: number; pageMarks: number };
    __compileCoordinatorStats(): {
      submitted: number;
      running: boolean;
      queueDepth: number;
      succeeded: number;
    };
    __documentCompileBrokerStats(): {
      compilerTasks: number;
      publications: number;
      sharedRequests: number;
      owners: number;
    };
  }
}

interface SurfaceSample {
  rafMs: number;
  domText: string;
  stateText: string;
  lineDispatches: number;
  pageDispatches: number;
  compilerSubmissions: number;
}

async function installProbe(page: Page, selector: string, nodeType: string): Promise<void> {
  await page.evaluate(({ selector, nodeType }) => {
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) throw new Error(`missing typing surface ${selector}`);
    const samples: SurfaceSample[] = [];
    const baselineLayout = window.__layoutDispatchStats();
    const baselineCompiler = window.__compileCoordinatorStats();
    window.view.dom.addEventListener('beforeinput', () => {
      const started = performance.now();
      requestAnimationFrame(() => {
        let stateText = '';
        window.view.state.doc.descendants((node) => {
          if (!stateText && node.type.name === nodeType) stateText = node.textContent;
          return !stateText;
        });
        const layout = window.__layoutDispatchStats();
        const compiler = window.__compileCoordinatorStats();
        samples.push({
          rafMs: performance.now() - started,
          domText: target.textContent ?? '',
          stateText,
          lineDispatches: layout.lines - baselineLayout.lines,
          pageDispatches: layout.pageMarks - baselineLayout.pageMarks,
          compilerSubmissions: compiler.submitted - baselineCompiler.submitted,
        });
      });
    }, { capture: true });
    (window as Window & { __surfaceSamples?: () => SurfaceSample[] }).__surfaceSamples = () => samples;
  }, { selector, nodeType });
}

async function samples(page: Page): Promise<SurfaceSample[]> {
  return page.evaluate(() =>
    (window as Window & { __surfaceSamples?: () => SurfaceSample[] }).__surfaceSamples?.() ?? [],
  );
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity;
}

test('native table and Typst source bursts paint within two frames before publication work', async ({ page }) => {
  test.setTimeout(75_000);
  await page.goto('/?new=1');
  const fixture = await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const cell = (text: string) => s.nodes.table_cell.create(null, paragraph(text));
    const blocks: import('prosemirror-model').Node[] = [];
    for (let index = 0; index < 220; index++) {
      blocks.push(paragraph(
        `Technical paragraph ${index + 1}. ` +
        'Paint-first editing stays native while one exact publication settles in the background. '.repeat(2),
      ));
    }
    blocks.splice(90, 0, s.nodes.table.create({ style: 'booktabs', caption: 'Responsive native data' }, [
      s.nodes.table_row.create(null, [cell('TABLE_ACTIVE'), cell('Measured value')]),
      s.nodes.table_row.create(null, [cell('baseline'), cell('16 ms')]),
    ]));
    const embedStart = '#rect(width: 60pt, height: 8pt) // EMBED_ACTIVE';
    blocks.splice(10, 0, s.nodes.typst_embed.create(null, s.text(embedStart)));
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, blocks));
    return { tableStart: 'TABLE_ACTIVE', embedStart };
  });

  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 60_000 });
  await expect(page.locator('.ts-typst-embed')).toHaveAttribute('data-preview-state', 'ready', {
    timeout: 60_000,
  });

  const tableBurst = '_latest_table';
  await page.evaluate((start) => {
    const { state } = window.view;
    let pos = -1;
    state.doc.descendants((node, nodePos) => {
      if (pos < 0 && node.type.name === 'paragraph' && node.textContent === start) pos = nodePos;
      return pos < 0;
    });
    if (pos < 0) throw new Error('active table cell was not found');
    const selectionType = state.selection.constructor as typeof import('prosemirror-state').TextSelection;
    window.view.dispatch(state.tr.setSelection(selectionType.create(state.doc, pos + 1 + start.length)));
    window.view.focus();
  }, fixture.tableStart);
  await page.locator('td p', { hasText: fixture.tableStart }).scrollIntoViewIfNeeded();
  await installProbe(page, 'td p', 'table_cell');
  const tableBefore = await page.evaluate(() => window.__documentCompileBrokerStats());
  await page.keyboard.type(tableBurst, { delay: 4 });
  await expect.poll(async () => (await samples(page)).at(-1)?.domText).toBe(fixture.tableStart + tableBurst);
  const tableSamples = await samples(page);
  const tableExpected = fixture.tableStart + tableBurst;
  expect(tableSamples.every((sample) => sample.domText === sample.stateText)).toBe(true);
  expect(tableSamples.at(-1)?.domText).toBe(tableExpected);
  expect(p95(tableSamples.map((sample) => sample.rafMs))).toBeLessThanOrEqual(FRAME_CEILING_MS);
  expect(tableSamples[0]).toMatchObject({ lineDispatches: 0, pageDispatches: 0, compilerSubmissions: 0 });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => window.__documentCompileBrokerStats().compilerTasks))
    .toBe(tableBefore.compilerTasks + 1);

  const embedBurst = '\n#rect(width: 12pt, height: 6pt)';
  await page.evaluate((start) => {
    const { state } = window.view;
    let pos = -1;
    state.doc.descendants((node, nodePos) => {
      if (pos < 0 && node.type.name === 'typst_embed') pos = nodePos;
      return pos < 0;
    });
    if (pos < 0) throw new Error('Typst source surface was not found');
    const selectionType = state.selection.constructor as typeof import('prosemirror-state').TextSelection;
    window.view.dispatch(state.tr.setSelection(selectionType.create(state.doc, pos + 1 + start.length)));
    window.view.focus();
  }, fixture.embedStart);
  await page.locator('[data-typst-source]').scrollIntoViewIfNeeded();
  await installProbe(page, '[data-typst-source]', 'typst_embed');
  const embedBefore = await page.evaluate(() => window.__documentCompileBrokerStats());
  await page.keyboard.type(embedBurst, { delay: 4 });
  await expect.poll(async () => (await samples(page)).at(-1)?.domText).toBe(fixture.embedStart + embedBurst);
  const embedSamples = await samples(page);
  expect(embedSamples.every((sample) => sample.domText === sample.stateText)).toBe(true);
  expect(embedSamples.at(-1)?.domText).toBe(fixture.embedStart + embedBurst);
  expect(p95(embedSamples.map((sample) => sample.rafMs))).toBeLessThanOrEqual(FRAME_CEILING_MS);
  expect(embedSamples[0]).toMatchObject({ lineDispatches: 0, pageDispatches: 0, compilerSubmissions: 0 });
  await expect(page.locator('.ts-typst-embed')).toHaveAttribute('data-preview-state', 'ready', {
    timeout: 60_000,
  });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => window.__documentCompileBrokerStats().compilerTasks))
    .toBe(embedBefore.compilerTasks + 1);
});
