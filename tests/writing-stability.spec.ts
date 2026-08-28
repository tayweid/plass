import { expect, test } from 'playwright/test';

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

test('a late edit holds only mapped exact page starts while replacement layout is pending', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');

  const count = 160;
  await page.evaluate((paragraphCount) => {
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
    const doc = state.schema.nodes.doc.create(state.doc.attrs, paragraphs);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  }, count);

  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  const exactPageCount = await page.locator('.page-box').count();
  expect(exactPageCount).toBeGreaterThan(5);
  const exactGaps = await page.locator('.ts-pagegap').count();
  expect(exactGaps).toBe(exactPageCount - 1);

  const targetIndex = count - 12;
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
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect
    .poll(() => page.evaluate(() => window.view.state.selection.head), { timeout: 5_000 })
    .toBe(setup.insertionPos);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 15_000 });
  expect(await page.evaluate(() => window.view.state.doc.toJSON() as ProseMirrorJSON)).toEqual(setup.original);
});
