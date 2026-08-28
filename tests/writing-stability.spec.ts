import { expect, test, type Page } from 'playwright/test';

interface ProseMirrorJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorJSON[];
  text?: string;
}

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
    __pageOracle: unknown;
  }
}

interface HeldPublicationSetup {
  caretTop: number;
  exactGaps: number;
  exactPageCount: number;
  insertionPos: number;
  original: ProseMirrorJSON;
}

async function enterMappedPublicationHold(
  page: Page,
  paragraphCount = 64,
  targetOffset = 8,
  remoteFigureSrc?: string,
): Promise<HeldPublicationSetup> {
  await page.goto('/?new=1');

  await page.evaluate(({ paragraphCount, remoteFigureSrc }) => {
    const { state } = window.view;
    const paragraphs = Array.from({ length: paragraphCount }, (_, index) =>
      state.schema.nodes.paragraph.create(
        null,
        state.schema.text(
          `Paragraph ${index + 1}. ` +
            'Mapped page starts may hold briefly, but only with provenance from a successful exact Typst layout.',
        ),
      ),
    );
    const content = remoteFigureSrc
      ? [
          ...paragraphs,
          state.schema.nodes.figure.create({ src: remoteFigureSrc }, state.schema.text('Remote figure')),
        ]
      : paragraphs;
    const doc = state.schema.nodes.doc.create(state.doc.attrs, content);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  }, { paragraphCount, remoteFigureSrc });

  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  const exactPageCount = await page.locator('.page-box').count();
  expect(exactPageCount).toBeGreaterThan(1);
  const exactGaps = await page.locator('.ts-pagegap').count();
  expect(exactGaps).toBe(exactPageCount - 1);

  const targetIndex = paragraphCount - targetOffset;
  const setup = await page.evaluate((index) => {
    const oracle = window.__pageOracle as unknown as {
      request: (...args: unknown[]) => void;
      __realRequest?: (...args: unknown[]) => void;
    };
    oracle.__realRequest = oracle.request.bind(oracle);
    oracle.request = () => {};

    const { state } = window.view;
    let start = 0;
    for (let child = 0; child < index; child++) start += state.doc.child(child).nodeSize;
    const insertionPos = start + 1 + 18;
    const selectionType = state.selection.constructor as unknown as {
      create(doc: typeof state.doc, from: number, to?: number): typeof state.selection;
    };
    window.view.dispatch(state.tr.setSelection(selectionType.create(state.doc, insertionPos)).scrollIntoView());
    window.view.focus();
    return {
      insertionPos,
      original: state.doc.toJSON() as ProseMirrorJSON,
      caretTop: window.view.coordsAtPos(insertionPos).top,
    };
  }, targetIndex);

  await page.keyboard.type('Z');
  await expect
    .poll(() => page.evaluate(() => window.__pagLog().at(-1)?.startsWith('held[') ?? false), {
      timeout: 15_000,
    })
    .toBe(true);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'held');
  await expect(page.locator('#hud')).toContainText(`${exactPageCount} p · updating`);
  await expect(page.locator('.page-box')).toHaveCount(exactPageCount);
  await expect(page.locator('.ts-pagegap')).toHaveCount(exactGaps);
  expect(await page.locator('.ProseMirror .ts-forced-lines').count()).toBeGreaterThan(0);

  return { ...setup, exactGaps, exactPageCount };
}

async function expectContinuousWithoutPublishedLayout(page: Page): Promise<void> {
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'continuous', { timeout: 15_000 });
  await expect(page.locator('.page-box')).toHaveCount(0);
  await expect(page.locator('.ProseMirror .ts-forced-lines')).toHaveCount(0);
  await expect(page.locator('.ProseMirror .ts-br, .ProseMirror .ts-hyphen')).toHaveCount(0);
  await expect(page.locator('.ProseMirror .ts-pagegap')).toHaveCount(0);

  const publicationState = await page.evaluate(async () => {
    const { typesetKey } = await import('/src/typeset-plugin.ts');
    const state = typesetKey.getState(window.view.state);
    return {
      decorations: state?.decos.find().length ?? -1,
      hasPageBasis: state?.pageBasis != null,
      pageMarks: state?.pageMarks.find().length ?? -1,
    };
  });
  expect(publicationState).toEqual({ decorations: 0, hasPageBasis: false, pageMarks: 0 });
}

test('a late edit holds only mapped exact page starts while replacement layout is pending', async ({ page }) => {
  test.setTimeout(60_000);
  const setup = await enterMappedPublicationHold(page, 160, 12);
  expect(setup.exactPageCount).toBeGreaterThan(5);

  const edited = await page.evaluate(() => ({
    doc: window.view.state.doc.toJSON() as ProseMirrorJSON,
    selection: window.view.state.selection.head,
    caretTop: window.view.coordsAtPos(window.view.state.selection.head).top,
    spellcheck: window.view.dom.spellcheck,
  }));
  expect(edited.selection).toBe(setup.insertionPos + 1);
  expect(edited.spellcheck).toBe(true);
  expect(Math.abs(edited.caretTop - setup.caretTop)).toBeLessThanOrEqual(2);
  expect(edited.doc).not.toEqual(setup.original);

  // Undo returns to the cached exact document. No local pagination pass is
  // available to manufacture a different result.
  // Choose the browser engine's platform modifier. The test runner's Node
  // host is not necessarily the same platform as the browser under test.
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(() => page.evaluate(() => window.view.state.selection.head), { timeout: 5_000 })
    .toBe(setup.insertionPos);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 15_000 });
  expect(await page.evaluate(() => window.view.state.doc.toJSON() as ProseMirrorJSON)).toEqual(setup.original);
});

test('settings invalidation synchronously revokes a mapped exact publication hold', async ({ page }) => {
  test.setTimeout(60_000);
  await enterMappedPublicationHold(page);

  const cleared = await page.evaluate(async () => {
    const { typesetKey } = await import('/src/typeset-plugin.ts');
    const { state } = window.view;
    const settings = state.doc.attrs.settings as Record<string, unknown>;
    const transaction = state.tr.setDocAttribute('settings', {
      ...settings,
      sizePt: Number(settings.sizePt) + 0.5,
    });
    let describedRanges = 0;
    for (const map of transaction.mapping.maps) map.forEach(() => describedRanges++);

    window.view.dispatch(transaction);

    const typesetState = typesetKey.getState(window.view.state);
    return {
      breaks: document.querySelectorAll('.ProseMirror .ts-br, .ProseMirror .ts-hyphen').length,
      decorations: typesetState?.decos.find().length ?? -1,
      describedRanges,
      forcedLines: document.querySelectorAll('.ProseMirror .ts-forced-lines').length,
      gaps: document.querySelectorAll('.ProseMirror .ts-pagegap').length,
      hasPageBasis: typesetState?.pageBasis != null,
      pageMarks: typesetState?.pageMarks.find().length ?? -1,
    };
  });

  expect(cleared).toEqual({
    breaks: 0,
    decorations: 0,
    describedRanges: 0,
    forcedLines: 0,
    gaps: 0,
    hasPageBasis: false,
    pageMarks: 0,
  });
  await expectContinuousWithoutPublishedLayout(page);
});

test('asset invalidation synchronously revokes a mapped exact publication hold', async ({ page }) => {
  test.setTimeout(60_000);
  const remoteFigureSrc = 'https://publication-hold.test/pixel.png';
  await page.route(remoteFigureSrc, (route) =>
    route.fulfill({
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      status: 200,
    }),
  );
  await enterMappedPublicationHold(page, 64, 8, remoteFigureSrc);

  const cleared = await page.evaluate(async () => {
    const { typesetKey } = await import('/src/typeset-plugin.ts');
    const pathChip = document.querySelector<HTMLButtonElement>('.fig-path-chip.remote');
    if (!pathChip) throw new Error('expected a blocked remote-image permission control');
    let assetEvents = 0;
    window.addEventListener('typeset-assets-changed', () => assetEvents++, { once: true });

    // Dispatch the actual permission control's event and inspect in the same task,
    // before ResizeObserver or the scheduled replacement layout can run.
    pathChip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));

    const typesetState = typesetKey.getState(window.view.state);
    return {
      assetEvents,
      breaks: document.querySelectorAll('.ProseMirror .ts-br, .ProseMirror .ts-hyphen').length,
      decorations: typesetState?.decos.find().length ?? -1,
      forcedLines: document.querySelectorAll('.ProseMirror .ts-forced-lines').length,
      gaps: document.querySelectorAll('.ProseMirror .ts-pagegap').length,
      hasPageBasis: typesetState?.pageBasis != null,
      pageMarks: typesetState?.pageMarks.find().length ?? -1,
      remoteAllowed: pathChip.classList.contains('remote-allowed'),
    };
  });

  expect(cleared).toEqual({
    assetEvents: 1,
    breaks: 0,
    decorations: 0,
    forcedLines: 0,
    gaps: 0,
    hasPageBasis: false,
    pageMarks: 0,
    remoteAllowed: true,
  });
  await expectContinuousWithoutPublishedLayout(page);
});

test('editor-width invalidation revokes a mapped exact publication hold', async ({ page }) => {
  test.setTimeout(60_000);
  await enterMappedPublicationHold(page);

  const widths = await page.evaluate(async () => {
    const before = window.view.dom.getBoundingClientRect().width;
    window.view.dom.style.width = `${before - 24}px`;
    const after = window.view.dom.getBoundingClientRect().width;

    // Exercise the same scheduled view update that ResizeObserver requests in production.
    const { scheduleTypeset } = await import('/src/typeset-plugin.ts');
    scheduleTypeset(window.view);
    return { after, before };
  });

  expect(Math.abs(widths.after - widths.before)).toBeGreaterThan(0.5);
  await expectContinuousWithoutPublishedLayout(page);
});
