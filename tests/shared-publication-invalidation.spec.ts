import { expect, test } from 'playwright/test';

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
      submitted: number;
      running: boolean;
      queueDepth: number;
      succeeded: number;
    };
    __typstEmbedPreviewStats(): {
      requests: number;
      publications: number;
      views: number;
    };
  }
}

async function waitForCompilerIdle(page: import('playwright/test').Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const stats = window.__compileCoordinatorStats();
    return Number(stats.running) + stats.queueDepth;
  })).toBe(0);
}

test('rapid formula replacement publishes only the latest whole-document revision', async ({ page }) => {
  await page.goto('/?new=1');
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await waitForCompilerIdle(page);

  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = s.nodes.paragraph.create(null, [
      s.text('A rapidly revised invariant '),
      s.nodes.math_inline.create({ src: 'x_0' }),
      s.text(' remains editable.'),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
  });

  const math = page.locator('.math-inline');
  await expect(math).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  const firstHref = await math.locator('image[data-exact-document-publication]').getAttribute('href');
  const before = await page.evaluate(() => window.__documentCompileBrokerStats());

  const finalSource = '\\frac{x_{latest}}{1+y_{latest}}';
  await page.evaluate((sources) => {
    for (const src of sources) {
      const { state } = window.view;
      let mathPos = -1;
      state.doc.descendants((node, pos) => {
        if (mathPos < 0 && node.type.name === 'math_inline') mathPos = pos;
        return mathPos < 0;
      });
      if (mathPos < 0) throw new Error('inline formula disappeared during replacement burst');
      const node = state.doc.nodeAt(mathPos)!;
      window.view.dispatch(state.tr.setNodeMarkup(mathPos, undefined, { ...node.attrs, src }));
    }
  }, ['x_1', 'x_2^2', '\\sum_i x_i', finalSource]);

  await expect(math).toHaveAttribute('data-math', finalSource);
  await expect(math).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect.poll(() => math.locator('image').getAttribute('href')).not.toBe(firstHref);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await waitForCompilerIdle(page);

  const result = await page.evaluate(() => {
    let source = '';
    window.view.state.doc.descendants((node) => {
      if (!source && node.type.name === 'math_inline') source = node.attrs.src as string;
      return !source;
    });
    return {
      source,
      broker: window.__documentCompileBrokerStats(),
      previews: window.__typstEmbedPreviewStats(),
    };
  });
  expect(result.source).toBe(finalSource);
  expect(result.broker.compilerTasks - before.compilerTasks).toBe(1);
  expect(result.previews.views).toBe(1);

  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.replaceWith(
      0,
      state.doc.content.size,
      state.schema.nodes.paragraph.create(null, state.schema.text('Formula removed cleanly.')),
    ));
  });
  await expect(math).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__typstEmbedPreviewStats().views)).toBe(0);
  await waitForCompilerIdle(page);
});

test('a size setting change republishes exact math without touching math nodes', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = s.nodes.paragraph.create(null, [
      s.text('Scaled exact atom '),
      s.nodes.math_inline.create({ src: '\\frac{x^2 + 1}{y}' }),
      s.text(' in prose.'),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
  });

  const math = page.locator('.math-inline');
  await expect(math).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  const before = await math.evaluate((element) => ({
    href: element.querySelector('image')?.getAttribute('href') ?? '',
    width: element.getBoundingClientRect().width,
    source: element.getAttribute('data-math'),
  }));

  await page.evaluate(() => {
    const view = window.view;
    let docChanges = 0;
    const dispatch = view.dispatch.bind(view);
    view.dispatch = ((tr) => {
      if (tr.docChanged) docChanges++;
      dispatch(tr);
    }) as typeof view.dispatch;
    (window as Window & { __settingsDocChanges?: () => number }).__settingsDocChanges = () => docChanges;
    const settings = { ...view.state.doc.attrs.settings, sizePt: 14 };
    view.dispatch(view.state.tr.setDocAttribute('settings', settings));
  });

  await expect(math).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect.poll(() => math.locator('image').getAttribute('href')).not.toBe(before.href);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  const after = await math.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    source: element.getAttribute('data-math'),
  }));
  expect(after.source).toBe(before.source);
  expect(after.width).toBeGreaterThan(before.width * 1.05);
  expect(await page.evaluate(() =>
    (window as Window & { __settingsDocChanges?: () => number }).__settingsDocChanges?.(),
  )).toBe(1);
});
