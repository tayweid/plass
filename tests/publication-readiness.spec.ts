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
    const status = manager.exactLayoutStatusFor.bind(manager);
    let released = false;
    manager.exactLayoutStatusFor = ((doc) => released
      ? status(doc)
      : { status: 'pending', reason: null }) as typeof manager.exactLayoutStatusFor;
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
  await expect(page.locator('.ProseMirror .ts-forced-lines')).toHaveCount(0);

  await page.evaluate(async () => {
    window.__layoutDispatchStats(true);
    window.__releaseExactPublication?.();
    const { scheduleTypeset } = await import('/src/typeset-plugin.ts');
    scheduleTypeset(window.view);
  });

  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect.poll(() => page.locator('.ProseMirror > p').first().locator('.ts-br, .ts-hyphen').count())
    .toBeGreaterThan(0);
  await expect(page.locator('.ProseMirror > p').first()).toHaveClass(/ts-forced-lines/);
  const dispatches = await page.evaluate(() => window.__layoutDispatchStats());
  expect(dispatches.lines).toBe(1);
});

test('opaque mark steps withdraw exact presentation synchronously and recover', async ({ page }) => {
  test.setTimeout(70_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const prose = 'Opaque document steps cannot safely map compiled ownership or pagination provenance. ';
    const blocks = [
      s.nodes.paragraph.create(null, s.text(prose.repeat(34))),
      s.nodes.paragraph.create(null, s.text(prose.repeat(34))),
    ];
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, blocks));
  });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect(page.locator('.ProseMirror > p.ts-forced-lines')).toHaveCount(2);

  const afterMixedStep = await page.evaluate(async () => {
    const { typesetKey } = await import('/src/typeset-plugin.ts');
    const { state } = window.view;
    const strong = state.schema.marks.strong.create();
    // The insert has a normal range map; AddMarkStep contributes an empty
    // StepMap. The whole transaction must fail open, not preserve paragraph 2.
    const tr = state.tr.insertText('X', 2).addMark(8, 24, strong);
    window.view.dispatch(tr);
    const presentation = typesetKey.getState(window.view.state)!;
    return {
      decorations: presentation.decos.find().length,
      pageMarks: presentation.pageMarks.find().length,
      pageBasis: presentation.pageBasis,
      forcedOwners: window.view.dom.querySelectorAll('.ts-forced-lines').length,
      pageGaps: window.view.dom.querySelectorAll('.ts-pagegap').length,
    };
  });
  expect(afterMixedStep).toEqual({
    decorations: 0,
    pageMarks: 0,
    pageBasis: null,
    forcedOwners: 0,
    pageGaps: 0,
  });

  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect(page.locator('.ProseMirror > p.ts-forced-lines')).toHaveCount(2);
});

test('terminal preview failure releases a mapped product layout hold', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const prose = 'Only genuinely pending publication work may retain untouched compiled lines. ';
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [
      s.nodes.paragraph.create(null, s.text(prose.repeat(28))),
      s.nodes.paragraph.create(null, s.text(prose.repeat(28))),
    ]));
  });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect(page.locator('.ProseMirror > p.ts-forced-lines')).toHaveCount(2);

  const heldImmediately = await page.evaluate(async () => {
    const { documentPreviewManagerFor } = await import('/src/raw-preview.ts');
    const manager = documentPreviewManagerFor(window.view);
    const actualStatus = manager.exactLayoutStatusFor.bind(manager);
    let terminal = false;
    manager.exactLayoutStatusFor = ((doc) => terminal
      ? { status: 'fail', reason: 'Injected terminal preview failure.' }
      : actualStatus(doc)) as typeof manager.exactLayoutStatusFor;

    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('X', 4));
    const held = window.view.dom.querySelectorAll('.ts-forced-lines').length;
    terminal = true;
    const { scheduleTypeset } = await import('/src/typeset-plugin.ts');
    scheduleTypeset(window.view);
    return held;
  });
  // The edited owner is native immediately; its untouched sibling is the
  // mapped exact presentation whose lifecycle this test exercises.
  expect(heldImmediately).toBe(1);

  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'continuous', {
    timeout: 10_000,
  });
  await expect(page.locator('#stack')).toHaveAttribute(
    'data-page-reason',
    'Injected terminal preview failure.',
  );
  await expect(page.locator('.ProseMirror .ts-forced-lines')).toHaveCount(0);
  await expect(page.locator('.ProseMirror .ts-pagegap')).toHaveCount(0);
});
