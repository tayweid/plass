import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: {
      loadHandle(handle: FileSystemFileHandle, dir: FileSystemDirectoryHandle): Promise<boolean>;
    };
    __typstEmbedPreviewStats(): { requests: number; publications: number; views: number };
  }
}

const publicationSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">' +
  '<g class="typst-page" transform="translate(0, 0)"><path d="M10 10h10v10H10z"/></g></svg>';

test('asset-generation invalidation withdraws readiness until the replacement publication applies', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async (svg) => {
    const { TypstEmbedPreviewManager } = await import('/src/raw-preview.ts');
    let compiles = 0;
    const manager = new TypstEmbedPreviewManager(window.view, async () => {
      compiles++;
      return { svg, regions: [] };
    });
    let retained: import('/src/typst-document-publication').TypstDocumentSvgPublication | null = null;
    let applies = 0;
    const listener: import('/src/raw-preview').ManagedDocumentPreviewView = {
      pending() {},
      applyDocumentPreview(publication) {
        retained = publication;
        applies++;
        return false;
      },
      compileError(message) { throw new Error(message); },
      needsDocumentPreview: () => true,
      retainedDocumentPreview: () => retained,
    };
    manager.register(listener);
    const waitFor = async (predicate: () => boolean) => {
      const deadline = performance.now() + 4_000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error('publication wait timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await waitFor(() => manager.isReadyFor(window.view.state.doc));
    manager.invalidate(window.view.state.doc, true);
    const readyImmediatelyAfterForce = manager.isReadyFor(window.view.state.doc);
    await waitFor(() => applies === 2 && manager.isReadyFor(window.view.state.doc));
    const readyAfterReplacement = manager.isReadyFor(window.view.state.doc);
    manager.destroy();
    return { compiles, applies, readyImmediatelyAfterForce, readyAfterReplacement };
  }, publicationSvg);

  expect(result).toEqual({
    compiles: 1,
    applies: 2,
    readyImmediatelyAfterForce: false,
    readyAfterReplacement: true,
  });
});

test('large publication registration and region lookup remain linear', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async (svg) => {
    const { TypstEmbedPreviewManager } = await import('/src/raw-preview.ts');
    const s = window.view.state.schema;
    const blocks: import('prosemirror-model').Node[] = [];
    for (let index = 0; index < 700; index++) {
      blocks.push(s.nodes.paragraph.create(null, [
        s.nodes.typst_inline.create({ src: '#sym.arrow.r' }),
        s.text(` atom ${index} `),
        s.nodes.math_inline.create({ src: `x_${index}` }),
      ]));
    }
    const indexedDoc = s.nodes.doc.create(null, blocks);
    const targets: Array<{ pos: number; channel: 'inline' | 'preview'; expected: number }> = [];
    let inline = 0;
    let preview = 0;
    indexedDoc.descendants((node, pos) => {
      if (node.type.name === 'typst_inline') {
        targets.push({ pos, channel: 'inline', expected: inline++ });
        targets.push({ pos, channel: 'preview', expected: preview++ });
      } else if (node.type.name === 'math_inline') {
        targets.push({ pos, channel: 'preview', expected: preview++ });
      }
      return true;
    });
    const originalDescendants = indexedDoc.descendants.bind(indexedDoc);
    let visits = 0;
    Object.defineProperty(indexedDoc, 'descendants', {
      configurable: true,
      value(callback: Parameters<typeof indexedDoc.descendants>[0]) {
        return originalDescendants((...args) => {
          visits++;
          return callback(...args);
        });
      },
    });

    let compilerCalls = 0;
    const manager = new TypstEmbedPreviewManager(window.view, async () => {
      compilerCalls++;
      return { svg, regions: [] };
    });
    const lookupCorrect = targets.every((target) =>
      manager.regionIndexAt(indexedDoc, target.pos, target.channel) === target.expected);
    const firstVisits = visits;
    for (const target of targets) manager.regionIndexAt(indexedDoc, target.pos, target.channel);
    const secondVisits = visits;

    let applies = 0;
    let current: import('/src/typst-document-publication').TypstDocumentSvgPublication | null = null;
    const listeners: import('/src/raw-preview').ManagedDocumentPreviewView[] = [];
    for (let index = 0; index < 700; index++) {
      const listener: import('/src/raw-preview').ManagedDocumentPreviewView = {
        pending() {},
        applyDocumentPreview(publication) {
          current = publication;
          applies++;
          return false;
        },
        compileError(message) { throw new Error(message); },
        needsDocumentPreview: () => true,
        retainedDocumentPreview: () => current,
      };
      listeners.push(listener);
      manager.register(listener);
    }
    const deadline = performance.now() + 4_000;
    while (manager.stats().publications !== 1) {
      if (performance.now() > deadline) throw new Error('coalesced publication wait timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stats = manager.stats();
    manager.destroy();
    return {
      lookupCorrect,
      firstVisits,
      secondVisits,
      descendants: indexedDoc.nodeSize - indexedDoc.childCount - 2,
      compilerCalls,
      applies,
      stats,
    };
  }, publicationSvg);

  expect(result.lookupCorrect).toBe(true);
  expect(result.firstVisits).toBeGreaterThan(0);
  expect(result.secondVisits).toBe(result.firstVisits);
  expect(result.firstVisits).toBeLessThan(3_000);
  expect(result.compilerCalls).toBe(1);
  expect(result.applies).toBe(700);
  expect(result.stats).toMatchObject({ requests: 1, publications: 1, views: 700 });
});

test('opening files replaces editor state without orphaning exact preview listeners', async ({ page }) => {
  test.setTimeout(70_000);
  await page.goto('/?new=1');

  const loadFile = async (name: string, suffix: string) => page.evaluate(async ({ name, suffix }) => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    const s = window.view.state.schema;
    const documentNode = s.nodes.doc.create(null, [
      s.nodes.paragraph.create(null, [
        s.text(`Loaded ${suffix} with exact math `),
        s.nodes.math_inline.create({ src: `x_${suffix}^2` }),
        s.text('.'),
      ]),
      s.nodes.typst_embed.create(null, s.text(
        `#rect(width: 48pt, height: 8pt, fill: rgb("4b72c2")) // ${suffix}`,
      )),
    ]);
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`publication-open-${name}`, { create: true });
    const handle = await dir.getFileHandle(`${name}.typ`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(docToTyp(documentNode));
    await writable.close();
    return window.__fm.loadHandle(handle, dir);
  }, { name, suffix });

  expect(await loadFile('first', 'a')).toBe(true);
  await expect(page.locator('.math-inline')).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.ts-typst-embed')).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  expect(await page.evaluate(() => window.__typstEmbedPreviewStats().views)).toBe(2);

  expect(await loadFile('second', 'b')).toBe(true);
  await expect(page.locator('.math-inline')).toHaveAttribute('data-math', 'x_b^2');
  await expect(page.locator('.math-inline')).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.ts-typst-embed')).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  expect(await page.evaluate(() => window.__typstEmbedPreviewStats().views)).toBe(2);
});

test('environment-mutating Typst embeds are explicit Proof-only layout boundaries', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const embed = s.nodes.typst_embed.create(null, s.text('#set text(fill: rgb("d14343"))'));
    const prose = s.nodes.paragraph.create(null, s.text('This sentence is red in exact output.'));
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [embed, prose]));
  });

  const embed = page.locator('.ts-typst-embed');
  await expect(embed).toHaveAttribute('data-preview-state', 'proof');
  await expect(embed.locator('.ts-typst-preview-status')).toContainText('affect content outside');
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'continuous', { timeout: 30_000 });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-reason', /document style rule/);
  const nativeColor = await page.locator('.ProseMirror > p').evaluate((element) => getComputedStyle(element).color);
  expect(nativeColor).not.toContain('209, 67, 67');

  await page.getByRole('button', { name: 'Proof', exact: true }).click();
  const proof = page.locator('.typst-proof');
  await expect(proof).toBeVisible();
  await expect(proof.locator('svg')).toHaveCount(1, { timeout: 30_000 });
  const hasExactRed = await proof.locator('svg').evaluate((svg) =>
    [...svg.querySelectorAll('*')].some((element) =>
      (element.getAttribute('fill') ?? '').toLowerCase().includes('#d14343')),
  );
  expect(hasExactRed).toBe(true);
});
