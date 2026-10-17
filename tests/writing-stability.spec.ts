import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

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
    __pagCount: () => number;
    __suffixPaginationStats: (reset?: boolean) => SuffixPaginationStats;
  }
}

function prefixSignature(signature: string, beforePos: number): string[] {
  return signature
    .split(',')
    .filter(Boolean)
    .filter((entry) => Number(entry.slice(0, entry.indexOf('@'))) < beforePos);
}

/** `logStart` is a `__pagCount()` snapshot, NOT a `__pagLog().length` one:
 * the log is a 40-entry ring, so length deltas freeze once it fills and a
 * long soak would wait forever on entries that were pushed (and shifted)
 * just fine. The monotone push counter says how many tail entries are new. */
async function waitForTerminalPagination(page: Page, logStart: number) {
  await settleLocal(page, logStart);
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

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';

async function openTyp(page: Page, text: string, name: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as { __fm?: unknown }).__fm && window.view));
  await page.evaluate(async ({ text, name }) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    await (window as unknown as { __fm: { loadHandle(h: FileSystemFileHandle): Promise<unknown> } }).__fm.loadHandle(handle);
  }, { text, name });
  await settleLocal(page);
}

/** The blocks either side of the second page gap: the foot of the second
 * sheet (the last two blocks on it) and the head of the third. */
const aroundSecondGap = (page: Page) =>
  page.evaluate(() => {
    const gap = document.querySelectorAll('.ProseMirror > .ts-pagegap')[1];
    const text = (el: Element | null | undefined) => el?.textContent?.slice(0, 4) ?? null;
    return {
      footBefore: text(gap.previousElementSibling?.previousElementSibling),
      foot: text(gap.previousElementSibling),
      head: text(gap.nextElementSibling),
    };
  });

/** Press Enter at the start of top-level block `index` with a fresh stats
 * window (its first install is the sampled one), and wait for that install's
 * verification and the settled pass. */
async function enterAtStartOf(page: Page, index: number) {
  await page.evaluate((index) => {
    const { state } = window.view;
    let pos = 0;
    for (let i = 0; i < index; i++) pos += state.doc.child(i).nodeSize;
    const selectionType = state.selection.constructor as unknown as {
      create(doc: typeof state.doc, from: number): typeof state.selection;
    };
    window.view.dispatch(state.tr.setSelection(selectionType.create(state.doc, pos + 1)));
    window.view.focus();
    window.__suffixPaginationStats(true);
  }, index);
  const before = await page.evaluate(() => window.__pagCount());
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.__suffixPaginationStats().compared), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await waitForTerminalPagination(page, before);
}

const blockPos = (page: Page, index: number) =>
  page.evaluate((index) => {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += window.view.state.doc.child(i).nodeSize;
    return pos;
  }, index);

/** The edit's pass installed a suffix seeded strictly above `pageStart`,
 * and the sampled full pass agreed with it: no mismatch, the session's
 * suffix path still on. */
async function expectVerifiedSeedAbove(page: Page, pageStart: number) {
  const stats = await page.evaluate(() => window.__suffixPaginationStats());
  expect(stats.eligible).toBeGreaterThanOrEqual(1);
  expect(stats.matches).toBeGreaterThanOrEqual(1);
  expect(stats.mismatches).toBe(0);
  expect(stats.lastAnchorPos).not.toBeNull();
  expect(stats.lastAnchorPos!).toBeLessThan(pageStart);
  expect((await latestPagination(page)).entry).toContain(`suffix=fallback@${stats.lastAnchorPos}`);
}

test('an Enter at the start of the paragraph that opens a page seeds the suffix on the page before: the installed pages are the full pass\'s', async ({ page }) => {
  test.setTimeout(60_000);
  // At 1 in margins every page of this document ends with room for one
  // more line, so the empty paragraph an Enter makes at the start of P12
  // (which opens the third sheet) belongs at the foot of the second. A
  // seed at the third page's start held the second as it was; the sampled
  // check's full pass put the line back and tripped the kill-switch for
  // the session (found 2026-10-16, src/layout/pagination-suffix.ts).
  const paragraphs = Array.from({ length: 30 }, (_, i) => `P${i} ` + FILLER.repeat(3).trimEnd());
  await openTyp(page, '#set page(margin: 1in)\n\n' + paragraphs.join('\n\n') + '\n', 'suffix-page-top.typ');
  expect(await aroundSecondGap(page)).toMatchObject({ foot: 'P11 ', head: 'P12 ' });
  const pageStart = await blockPos(page, 12);

  await enterAtStartOf(page, 12);
  // The empty line went back to the second sheet: the edit changed the
  // page before the one it opened, which is what a seed must not hold.
  expect(await aroundSecondGap(page)).toMatchObject({ footBefore: 'P11 ', foot: '', head: 'P12 ' });
  await expectVerifiedSeedAbove(page, pageStart);
});

test('an Enter under a heading that opens a page seeds the suffix on the page before: the heading run goes back with the line', async ({ page }) => {
  test.setTimeout(60_000);
  // P10 is shortened so the second sheet's foot has room for the heading
  // and one line, not two: the heading opens the third sheet because P12's
  // first frame (two lines, the orphan rule) does not fit beside it, and a
  // heading is sticky (src/layout/flow-rules.ts). The empty paragraph an
  // Enter makes at P12's start is one line, so it fits, and the heading
  // goes back to the second sheet with it. The heading's page start is
  // before the dirty block, but the second sheet ended by reading it, so a
  // seed there would hold that sheet as it was.
  const words = FILLER.repeat(3).trimEnd().split(' ');
  const paragraphs = Array.from({ length: 30 }, (_, i) => `P${i} ` + (i === 10 ? words.slice(0, -30) : words).join(' '));
  const blocks = [...paragraphs.slice(0, 12), '=== Heading here', ...paragraphs.slice(12)];
  await openTyp(page, '#set page(margin: 1in)\n\n' + blocks.join('\n\n') + '\n', 'suffix-heading-top.typ');
  expect(await aroundSecondGap(page)).toMatchObject({ foot: 'P11 ', head: 'Head' });
  const pageStart = await blockPos(page, 12);

  await enterAtStartOf(page, 13);
  expect(await aroundSecondGap(page)).toEqual({ footBefore: 'Head', foot: '', head: 'P12 ' });
  await expectVerifiedSeedAbove(page, pageStart);
});

test('a late edit in a 40–50-page document recomputes only a stable suffix', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');


  const initialLogLength = await page.evaluate(() => window.__pagCount());
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
  const editLogLength = await page.evaluate(() => window.__pagCount());
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
