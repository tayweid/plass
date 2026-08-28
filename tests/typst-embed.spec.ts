import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

test('toolbar Typst embed accepts real native typing and keeps source as document truth', async ({ page }) => {
  await page.goto('/?new=1');
  const insert = page.locator('button[title^="Typst embed"]');
  await page.locator('.tb-flyout-wrap', { has: insert }).hover();
  await insert.click();

  const source = '#rect(width: 84pt, height: 18pt, fill: rgb("4b72c2"))';
  const sourceDOM = page.locator('[data-typst-source]');
  await sourceDOM.click();
  await page.keyboard.insertText(source);

  // This is a real contenteditable mutation, not a programmatic state setup:
  // what paints beside the preview is the exact text held by ProseMirror.
  await expect(sourceDOM).toHaveText(source);
  expect(await page.evaluate(() => ({
    type: window.view.state.doc.firstChild?.type.name,
    source: window.view.state.doc.firstChild?.textContent,
  }))).toEqual({ type: 'typst_embed', source });

  const embed = page.locator('.ts-typst-embed');
  await expect(embed).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(embed.locator('svg')).toHaveCount(1);
  await expect(sourceDOM).toHaveText(source);
  const geometry = await embed.evaluate((element) => {
    const style = getComputedStyle(element);
    const source = element.querySelector<HTMLElement>('.ts-typst-source');
    return {
      flowHeight: Number.parseFloat(style.getPropertyValue('--typst-embed-flow-height')),
      boxHeight: element.getBoundingClientRect().height,
      sourcePosition: source ? getComputedStyle(source).position : '',
    };
  });
  expect(geometry.flowHeight).toBeGreaterThan(0);
  expect(Math.abs(geometry.boxHeight - geometry.flowHeight)).toBeLessThan(0.75);
  expect(geometry.sourcePosition).toBe('absolute');
});

test('narrow Typst inspector rests in the gutter and expands without changing document flow', async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 820 });
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const source = '#rect(width: 100%, height: 24pt, fill: rgb("4b72c2"))';
    const embed = state.schema.nodes.typst_embed.create(null, state.schema.text(source));
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, embed));
  });

  const embed = page.locator('.ts-typst-embed');
  const source = embed.locator('.ts-typst-source');
  const rendered = embed.locator('.ts-typst-preview-render');
  await expect(embed).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await page.mouse.move(4, 4);

  const resting = await embed.evaluate((element) => {
    const sourceRect = element.querySelector<HTMLElement>('.ts-typst-source')!.getBoundingClientRect();
    const renderRect = element.querySelector<HTMLElement>('.ts-typst-preview-render')!.getBoundingClientRect();
    const overlapWidth = Math.max(0, Math.min(sourceRect.right, renderRect.right) - Math.max(sourceRect.left, renderRect.left));
    const overlapHeight = Math.max(0, Math.min(sourceRect.bottom, renderRect.bottom) - Math.max(sourceRect.top, renderRect.top));
    return {
      embedHeight: element.getBoundingClientRect().height,
      sourceWidth: sourceRect.width,
      sourceHeight: sourceRect.height,
      overlapArea: overlapWidth * overlapHeight,
    };
  });
  expect(resting.sourceWidth).toBeLessThanOrEqual(120);
  expect(resting.sourceHeight).toBeLessThanOrEqual(32);
  expect(resting.overlapArea).toBe(0);

  await source.hover();
  await expect.poll(() => source.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(300);
  await expect(rendered).toBeVisible();
  const expandedHeight = await embed.evaluate((element) => element.getBoundingClientRect().height);
  expect(Math.abs(expandedHeight - resting.embedHeight)).toBeLessThan(0.75);
});

test('ordinary Typst-labelled code stays native and an exact legacy marker migrates', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const code = state.schema.nodes.code_block.create(
      { params: 'typst' },
      state.schema.text('#rect(width: 10pt)'),
    );
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, code));
  });

  const code = page.locator('.ProseMirror > pre').first();
  await expect(code).toBeVisible();
  await expect(code.locator('code')).toHaveText('#rect(width: 10pt)');
  await expect(page.locator('.ts-typst-preview')).toHaveCount(0);
  await page.waitForTimeout(250); // Past the old raw-preview debounce.
  await expect(page.locator('.ts-typst-preview')).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      type: window.view.state.doc.firstChild?.type.name,
      params: window.view.state.doc.firstChild?.attrs.params,
    })),
  ).toEqual({ type: 'code_block', params: 'typst' });

  await page.evaluate(() => {
    const { state } = window.view;
    const legacy = state.schema.nodes.code_block.create(
      { params: 'typst-raw' },
      state.schema.text('#circle(radius: 4pt)'),
    );
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, legacy));
  });
  await expect.poll(() => page.evaluate(() => window.view.state.doc.firstChild?.type.name)).toBe('typst_embed');
  expect(await page.evaluate(() => window.view.state.doc.firstChild?.textContent)).toBe('#circle(radius: 4pt)');
});

test('Typst embed keeps source adjacent and retains last-good preview on an error', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const { TypstEmbedPreviewManager, TypstEmbedView } = await import('/src/raw-preview.ts');
    const nodeType = window.view.state.schema.nodes.typst_embed;
    const first = nodeType.create(null, window.view.state.schema.text('#rect(width: 10pt)'));
    window.view.dispatch(
      window.view.state.tr.replaceWith(0, window.view.state.doc.content.size, first),
    );
    const requests: Array<{ source: string; key: string; revision: number; priority: string }> = [];
    let call = 0;
    const compiler: import('/src/raw-preview').TypstEmbedCompiler = async (doc, onMessage, request) => {
      requests.push({ source: doc.textContent, ...request });
      call++;
      if (call === 1) {
        return {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><g class="typst-page" transform="translate(0, 0)"><path d="M10 10h10v10H10z"/></g></svg>',
          regions: [{ index: 0, start: { page: 1, x: 10, y: 10 }, end: { page: 1, x: 10, y: 20 } }],
        };
      }
      onMessage('synthetic whole-document compilation failed');
      return null;
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const manager = new TypstEmbedPreviewManager(window.view, compiler);
    const nodeView = new TypstEmbedView(first, window.view, () => 0, manager);
    nodeView.contentDOM.textContent = first.textContent;
    host.appendChild(nodeView.dom);

    const waitFor = async (predicate: () => boolean) => {
      const deadline = performance.now() + 3_000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error('timed out waiting for embed preview state');
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
    };

    await waitFor(() => nodeView.previewEl.dataset.previewState === 'ready');
    const goodMarkup = nodeView.renderEl.innerHTML;
    const ready = {
      source: nodeView.contentDOM.textContent,
      sourceVisible: getComputedStyle(nodeView.sourceEl).display !== 'none',
      previewVisible: getComputedStyle(nodeView.previewEl).display !== 'none',
      adjacent:
        nodeView.dom.children[0] === nodeView.sourceEl && nodeView.dom.children[1] === nodeView.previewEl,
      svg: nodeView.renderEl.querySelectorAll('svg').length,
      state: nodeView.previewEl.dataset.previewState,
      lastGood: nodeView.previewEl.dataset.lastGood,
    };

    const broken = nodeType.create(null, window.view.state.schema.text('#broken('));
    window.view.dispatch(
      window.view.state.tr.replaceWith(0, window.view.state.doc.content.size, broken),
    );
    nodeView.update(broken);
    nodeView.contentDOM.textContent = broken.textContent;
    await waitFor(() => nodeView.previewEl.dataset.previewState === 'error');
    const failed = {
      source: nodeView.contentDOM.textContent,
      sourceVisible: getComputedStyle(nodeView.sourceEl).display !== 'none',
      previewVisible: getComputedStyle(nodeView.previewEl).display !== 'none',
      state: nodeView.previewEl.dataset.previewState,
      lastGood: nodeView.previewEl.dataset.lastGood,
      error: nodeView.previewEl.dataset.previewError,
      status: nodeView.statusEl.textContent,
      keptMarkup: nodeView.renderEl.innerHTML === goodMarkup,
      svg: nodeView.renderEl.querySelectorAll('svg').length,
    };

    // Selection/decorations can make ProseMirror offer the same node to a
    // node view again. That must not turn a failed compile into a retry loop.
    nodeView.update(broken);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const callsAfterUnchangedUpdate = requests.length;

    nodeView.destroy();
    manager.destroy();
    host.remove();
    return { ready, failed, requests, callsAfterUnchangedUpdate };
  });

  expect(result.ready).toEqual({
    source: '#rect(width: 10pt)',
    sourceVisible: true,
    previewVisible: true,
    adjacent: true,
    svg: 1,
    state: 'ready',
    lastGood: 'true',
  });
  expect(result.failed).toMatchObject({
    source: '#broken(',
    sourceVisible: true,
    previewVisible: true,
    state: 'error',
    lastGood: 'true',
    keptMarkup: true,
    svg: 1,
  });
  expect(result.failed.error).toContain('compilation failed');
  expect(result.failed.status).toContain('showing the last good result');
  expect(result.requests).toHaveLength(2);
  expect(result.callsAfterUnchangedUpdate).toBe(2);
  expect(result.requests[0].key).toBe(result.requests[1].key);
  expect(result.requests[0].revision).toBeLessThan(result.requests[1].revision);
  expect(result.requests.every((request) => request.priority === 'foreground')).toBe(true);
  expect(result.requests[0].source).toContain('#rect(width: 10pt)');
  expect(result.requests[1].source).toContain('#broken(');
});

test('registered Typst embed recompiles when document settings change', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const embed = state.schema.nodes.typst_embed.create(
      null,
      state.schema.text('Context-sensitive preview'),
    );
    window.view.dispatch(
      state.tr.replaceWith(0, state.doc.content.size, embed).setMeta('addToHistory', false),
    );
  });

  const embed = page.locator('.ts-typst-embed');
  await expect(embed).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  const initialHeight = await embed.locator('svg').getAttribute('height');
  expect(initialHeight).not.toBeNull();

  await page.evaluate(() => {
    const { state } = window.view;
    const settings = state.doc.attrs.settings as Record<string, unknown>;
    window.view.dispatch(state.tr.setDocAttribute('settings', {
      ...settings,
      sizePt: Number(settings.sizePt) + 4,
    }));
  });
  await expect.poll(() => embed.locator('svg').getAttribute('height'), { timeout: 30_000 })
    .not.toBe(initialHeight);
  await expect(embed).toHaveAttribute('data-preview-state', 'ready');
  await expect(embed.getByRole('status')).toHaveText('Preview is current.');
});

test('all Typst embeds share one exact document compile and prior definitions stay in scope', async ({ page }) => {
  await page.goto('/?new=1');
  // The editor deliberately starts layout asynchronously. Under a loaded CI
  // runner, the initial empty document's startup publication can begin after
  // page.goto() but before the replacement below. Finish that separate
  // document lifecycle before sampling the broker: the assertion then stays
  // strict about the two embeds sharing one task for their immutable doc.
  await expect.poll(
    () => page.evaluate(() => window.__documentCompileBrokerStats().publications),
    { timeout: 30_000 },
  ).toBeGreaterThan(0);
  const before = await page.evaluate(() => ({
    embeds: window.__typstEmbedPreviewStats(),
    document: window.__documentCompileBrokerStats(),
  }));
  await page.evaluate(() => {
    const { state } = window.view;
    const define = state.schema.nodes.typst_embed.create(
      null,
      state.schema.text([
        '#let state = "ordinary user binding"',
        '#let here = "ordinary user binding"',
        '#let context_badge(body) = rect(width: 72pt, height: 14pt, fill: rgb("4b72c2"))',
      ].join('\n')),
    );
    const use = state.schema.nodes.typst_embed.create(
      null,
      state.schema.text('#context_badge[Prior definition is in scope]'),
    );
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [define, use]));
  });

  const embeds = page.locator('.ts-typst-embed');
  await expect(embeds).toHaveCount(2);
  await expect(embeds.nth(0)).toHaveAttribute('data-preview-state', 'empty', { timeout: 30_000 });
  await expect(embeds.nth(1)).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(embeds.nth(1).locator('svg')).toHaveCount(1);
  await expect(embeds.nth(1).locator('svg > image[data-exact-document-publication]')).toHaveCount(1);
  await expect(embeds.nth(1).locator('.typst-page')).toHaveCount(0);
  expect(await embeds.nth(1).locator('svg > image').getAttribute('href')).toMatch(/^blob:/);
  expect(await embeds.nth(0).evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __layoutSnapshotStats(): { status: string } })
      .__layoutSnapshotStats().status,
  ), { timeout: 30_000 }).toBe('ok');
  const after = await page.evaluate(() => ({
    embeds: window.__typstEmbedPreviewStats(),
    document: window.__documentCompileBrokerStats(),
  }));
  expect(after.embeds.requests - before.embeds.requests).toBe(1);
  expect(after.embeds.publications - before.embeds.publications).toBe(1);
  expect(after.embeds.views).toBe(2);
  expect(after.document.compilerTasks - before.document.compilerTasks).toBe(1);
  expect(after.document.publications - before.document.publications).toBe(1);
  expect(after.document.owners).toBe(2);

  // Selection/layout-only updates do not invalidate the document compile.
  await page.locator('[data-typst-source]').nth(1).click();
  await page.waitForTimeout(260);
  const unchanged = await page.evaluate(() => window.__typstEmbedPreviewStats());
  expect(unchanged.requests).toBe(after.embeds.requests);
});

test('consecutive zero-output embeds keep collision-free editable source lanes', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const sources = [
      '#let alpha = 1',
      '#let beta = alpha + 1',
      '#let gamma = beta + 1',
    ];
    const embeds = sources.map((source) =>
      state.schema.nodes.typst_embed.create(null, state.schema.text(source)));
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, embeds));
  });

  const embeds = page.locator('.ts-typst-embed');
  await expect(embeds).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await expect(embeds.nth(index)).toHaveAttribute('data-preview-state', 'empty', { timeout: 30_000 });
  }
  await expect.poll(async () => {
    const boxes = await page.locator('.ts-typst-source').evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      }));
    return boxes.length === 3 && boxes.slice(1).every((box, index) => box.top >= boxes[index].bottom + 5);
  }).toBe(true);
  expect(await embeds.evaluateAll((elements) =>
    elements.every((element) => element.getBoundingClientRect().height === 0))).toBe(true);
});

test('a multi-page embed never overlays following editable content', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const body = Array.from({ length: 44 }, (_, index) =>
      `A naturally flowing embedded paragraph ${index + 1} that remains inside normal document flow.`
    ).join('\n\n');
    const source = `#block[\n${body}\n]`;
    const embed = state.schema.nodes.typst_embed.create(null, state.schema.text(source));
    const after = state.schema.nodes.paragraph.create(null, state.schema.text('Editable content after the multi-page embed.'));
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [embed, after]));
  });

  const embed = page.locator('.ts-typst-embed');
  await expect(embed).toHaveAttribute('data-preview-state', 'proof', { timeout: 30_000 });
  await expect(embed).toHaveAttribute('data-region-pages', /^1-[2-9]\d*$/);
  await expect(embed.locator('svg')).toHaveCount(0);
  await expect(embed.getByRole('status')).toContainText(/spans [2-9]\d* Typst pages/);
  expect(await embed.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
  const after = page.getByText('Editable content after the multi-page embed.', { exact: true });
  await expect(after).toBeVisible();
  const overlap = await page.evaluate(() => {
    const preview = document.querySelector('.ts-typst-preview-render')?.getBoundingClientRect();
    const paragraph = [...document.querySelectorAll('p')].find((node) =>
      node.textContent === 'Editable content after the multi-page embed.')?.getBoundingClientRect();
    return !!preview && !!paragraph && preview.width > 0 && preview.bottom > paragraph.top;
  });
  expect(overlap).toBe(false);
});

test('whole-document embed preview resolves a project-local image through the export VFS', async ({ page }) => {
  await page.goto('/?new=1');
  const assetPath = 'figures/embed-context.svg';
  await page.evaluate(async (path) => {
    const app = window as typeof window & {
      view: import('prosemirror-view').EditorView;
      __fm: {
        adoptFolder(dir: FileSystemDirectoryHandle, intent: 'save'): Promise<unknown>;
        writeAsset(path: string, data: Blob): Promise<boolean>;
      };
    };
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`plass-embed-${Date.now()}`, { create: true });
    await app.__fm.adoptFolder(dir, 'save');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="12"><rect width="30" height="12" fill="#16a085"/></svg>';
    if (!await app.__fm.writeAsset(path, new Blob([svg], { type: 'image/svg+xml' }))) {
      throw new Error('could not write project embed image');
    }
    const { state } = app.view;
    const source = `#image("${path}", width: 30pt)`;
    const embed = state.schema.nodes.typst_embed.create(null, state.schema.text(source));
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, embed));
  }, assetPath);

  const embed = page.locator('.ts-typst-embed');
  await expect(embed).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(embed.locator('svg')).toHaveCount(1);
  await expect(embed.locator('[data-typst-source]')).toHaveText(`#image("${assetPath}", width: 30pt)`);
  expect(Number.parseFloat(await embed.evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--typst-embed-flow-height'),
  ))).toBeGreaterThan(0);
});
