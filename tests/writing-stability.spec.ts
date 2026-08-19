import { expect, test, type Page } from 'playwright/test';

interface SuffixPaginationStats {
  attempts: number;
  eligible: number;
  compared: number;
  matches: number;
  mismatches: number;
  fullUnits: number;
  suffixUnits: number;
  lastReason: string;
  lastStartPos: number | null;
  lastAnchorPos: number | null;
}

interface ProseMirrorJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorJSON[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
    __pageOracle: unknown;
    __suffixPaginationStats: (reset?: boolean) => SuffixPaginationStats;
  }
}

function prefixSignature(signature: string, beforePos: number): string[] {
  return signature
    .split(',')
    .filter(Boolean)
    .filter((entry) => Number(entry.slice(0, entry.indexOf('@'))) < beforePos);
}

async function waitForTerminalPagination(page: Page, logStart: number) {
  await expect
    .poll(
      () =>
        page.evaluate((start) =>
          window
            .__pagLog()
            .slice(start)
            .some((entry) => entry.startsWith('exact[') || entry.includes('[entry=fail')),
        logStart),
      { timeout: 30_000, intervals: [200, 400, 800] },
    )
    .toBe(true);
}

async function latestPagination(page: Page) {
  return page.evaluate(() => {
    const entry = window.__pagLog().at(-1) ?? '';
    const bracket = entry.indexOf('[');
    const separator = entry.indexOf(':');
    return {
      entry,
      path: bracket < 0 ? '' : entry.slice(0, bracket),
      signature: separator < 0 ? '' : entry.slice(separator + 1),
    };
  });
}

test('a late edit in a 40–50-page document recomputes only a stable suffix', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');

  // The suffix planner and comparator are FALLBACK-engine machinery: when the
  // page oracle answers, a late edit paginates on the exact/held path and the
  // shadow comparison never runs. Pin the oracle to fail so every pass runs
  // the fallback engine deterministically.
  await page.evaluate(() => {
    const oracle = window.__pageOracle as unknown as {
      clear: () => void;
      request: (sig: string) => void;
      results: Map<string, { status: string; reason: string }>;
    };
    oracle.clear();
    oracle.request = (sig: string) => {
      oracle.results.set(sig, { status: 'fail', reason: 'test: page oracle disabled' });
    };
  });

  const initialLogLength = await page.evaluate(() => window.__pagLog().length);
  await page.evaluate(
    (count) => {
      const { state } = window.view;
      const paragraphs = Array.from({ length: count }, (_, index) =>
        state.schema.nodes.paragraph.create(
          null,
          state.schema.text(`Paragraph ${index + 1}. Stable suffix pagination fixture.`),
        ),
      );
      const doc = state.schema.nodes.doc.create(state.doc.attrs, paragraphs);
      window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
    },
    960,
  );

  await expect.poll(() => page.locator('.page-box').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(40);
  const pageCount = await page.locator('.page-box').count();
  expect(pageCount).toBeLessThanOrEqual(50);
  await waitForTerminalPagination(page, initialLogLength);

  const initialPagination = await latestPagination(page);
  expect(initialPagination.signature).not.toBe('');
  const targetIndex = 900;
  const setup = await page.evaluate(({ targetIndex, textOffset }) => {
    const { state } = window.view;
    let targetStart = 0;
    for (let index = 0; index < targetIndex; index++) targetStart += state.doc.child(index).nodeSize;
    const insertionPos = targetStart + 1 + textOffset;
    const original = state.doc.toJSON() as ProseMirrorJSON;
    const expected = structuredClone(original);
    const targetText = expected.content?.[targetIndex]?.content?.[0];
    if (!targetText?.text) throw new Error('plain-paragraph fixture changed shape');
    targetText.text = targetText.text.slice(0, textOffset) + 'Z' + targetText.text.slice(textOffset);

    const selectionType = state.selection.constructor as unknown as {
      create(doc: typeof state.doc, from: number, to?: number): typeof state.selection;
    };
    window.view.dispatch(state.tr.setSelection(selectionType.create(state.doc, insertionPos)).scrollIntoView());
    window.view.focus();
    return { insertionPos, original, expected, docSize: state.doc.content.size };
  }, { targetIndex, textOffset: 32 });

  await page.waitForTimeout(100);
  const caretBefore = await page.evaluate(() => {
    const pos = window.view.state.selection.head;
    const scroll = document.querySelector<HTMLElement>('#scroll');
    return { pos, top: window.view.coordsAtPos(pos).top, scrollTop: scroll?.scrollTop ?? 0 };
  });

  await page.evaluate(() => window.__suffixPaginationStats(true));
  const editLogLength = await page.evaluate(() => window.__pagLog().length);
  await page.keyboard.type('Z');

  await expect
    .poll(() => page.evaluate(() => window.__suffixPaginationStats().compared), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await waitForTerminalPagination(page, editLogLength);

  const stats = await page.evaluate(() => window.__suffixPaginationStats());
  expect(stats.attempts).toBeGreaterThanOrEqual(1);
  expect(stats.eligible).toBeGreaterThanOrEqual(1);
  expect(stats.matches).toBeGreaterThanOrEqual(1);
  expect(stats.mismatches).toBe(0);
  expect(stats.fullUnits).toBeGreaterThan(0);
  expect(stats.suffixUnits).toBeGreaterThan(0);
  expect(stats.suffixUnits).toBeLessThan(stats.fullUnits * 0.25);
  expect(stats.lastStartPos).not.toBeNull();
  expect(stats.lastAnchorPos).not.toBeNull();
  expect(stats.lastStartPos!).toBeGreaterThan(setup.docSize * 0.8);
  expect(stats.lastAnchorPos!).toBeLessThanOrEqual(stats.lastStartPos!);

  const finalPagination = await latestPagination(page);
  expect(finalPagination.signature).not.toBe('');
  expect(prefixSignature(finalPagination.signature, stats.lastAnchorPos!)).toEqual(
    prefixSignature(initialPagination.signature, stats.lastAnchorPos!),
  );
  await page.waitForTimeout(800);
  expect((await latestPagination(page)).signature).toBe(finalPagination.signature);

  const finalState = await page.evaluate(() => ({
    doc: window.view.state.doc.toJSON() as ProseMirrorJSON,
    selection: {
      from: window.view.state.selection.from,
      to: window.view.state.selection.to,
      empty: window.view.state.selection.empty,
    },
    caret: (() => {
      const pos = window.view.state.selection.head;
      const scroll = document.querySelector<HTMLElement>('#scroll');
      return { pos, top: window.view.coordsAtPos(pos).top, scrollTop: scroll?.scrollTop ?? 0 };
    })(),
  }));

  expect(finalState.doc).toEqual(setup.expected);
  expect(finalState.selection).toEqual({
    from: setup.insertionPos + 1,
    to: setup.insertionPos + 1,
    empty: true,
  });
  expect(finalState.caret.pos).toBe(caretBefore.pos + 1);
  expect(Math.abs(finalState.caret.top - caretBefore.top)).toBeLessThanOrEqual(2);
  expect(Math.abs(finalState.caret.scrollTop - caretBefore.scrollTop)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => window.view.dom.spellcheck)).toBe(true);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect
    .poll(() => page.evaluate(() => window.view.state.selection.head), { timeout: 5_000 })
    .toBe(setup.insertionPos);
  expect(await page.evaluate(() => window.view.state.doc.toJSON() as ProseMirrorJSON)).toEqual(setup.original);
});
