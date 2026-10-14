import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// An IME's composition while the layout would re-break its paragraph
// (src/typeset-plugin.ts, holdForComposition). Found 2026-10-06: two words
// joined across a page break by a Backspace, then an accent typed with a
// dead key into the join, came out with the accent twice ("layoutoracle"
// became "layoutééoracle"). A layout pass during the composition re-drew
// the line round the text node Chrome was composing in, Chrome lost the
// composition, and its commit inserted the composed text again. The passes
// now wait for the composition to end, then lay the paragraph out.

type Hooks = {
  view: import('prosemirror-view').EditorView;
  __loadDemo: () => void;
  __pagCount: () => number;
};

const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

async function demo(page: Page) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as Hooks).view && (window as unknown as Hooks).__loadDemo));
  await page.evaluate(() => (window as unknown as Hooks).__loadDemo());
  await settleLocal(page);
}

/** The first line end in the demo whose break is a `<br>` (`br`) or a page
 *  gap (`gap`), after a word: the position before the break space. */
const lineEnd = (page: Page, kind: 'br' | 'gap') =>
  page.evaluate((kind) => {
    const { view } = window as unknown as Hooks;
    const breaks = view.dom.querySelectorAll(kind === 'br' ? 'br.ts-br' : 'p .ts-pagegap');
    for (const el of breaks) {
      const pos = view.posAtDOM(el, 0);
      if (view.state.doc.textBetween(pos - 1, pos) !== ' ') continue;
      if (/\p{L}{3}$/u.test(view.state.doc.textBetween(pos - 4, pos - 1))) return pos - 1;
    }
    throw new Error(`no line end before a ${kind}`);
  }, kind);

const text = (page: Page, from: number, to: number) =>
  page.evaluate(([from, to]) => (window as unknown as Hooks).view.state.doc.textBetween(from, to), [from, to]);

const head = (page: Page) => page.evaluate(() => (window as unknown as Hooks).view.state.selection.head);

const passes = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__pagCount());

/** Click in the line that ends at `end`, press the line-end key, step to
 *  the next line's start and Backspace the break space: the line's last
 *  word and the next line's first are one word, which the layout re-breaks. */
async function joinAt(page: Page, end: number) {
  const point = await page.evaluate((end) => {
    const { view } = window as unknown as Hooks;
    const panel = document.getElementById('scroll')!;
    panel.scrollTop += view.coordsAtPos(end - 3).top - panel.getBoundingClientRect().top - panel.clientHeight / 2;
    const box = view.coordsAtPos(end - 3);
    return { x: box.left, y: (box.top + box.bottom) / 2 };
  }, end);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press(LINE_END);
  await expect.poll(() => head(page)).toBe(end);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => head(page)).toBe(end + 1);
  const before = await passes(page);
  await page.keyboard.press('Backspace');
  await settleLocal(page, before);
  expect(await head(page)).toBe(end);
}

/** An IME's composition, as Chromium's input method controller drives it:
 *  each update replaces the composed text, then the commit. Each update
 *  waits longer than the layout's settle delay (250 ms), so a pass that
 *  ran during the composition would have run between them. */
async function compose(page: Page, updates: string[], commit: string) {
  const cdp = await page.context().newCDPSession(page);
  for (const text of updates) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await page.waitForTimeout(400);
  }
  await cdp.send('Input.insertText', { text: commit });
  await cdp.detach();
}

for (const kind of ['gap', 'br'] as const) {
  const where = kind === 'gap' ? 'a page break' : 'a line break';

  test(`an IME's text in two words joined across ${where} is written once`, async ({ page }) => {
    await demo(page);
    const end = await lineEnd(page, kind);
    const [word, next] = [await text(page, end - 4, end), await text(page, end + 1, end + 6)];
    await joinAt(page, end);
    expect(await text(page, end - 4, end + 5)).toBe(`${word}${next}`);
    const held = await passes(page);
    await compose(page, ['e', 'é'], 'é');
    await expect.poll(() => text(page, end - 4, end + 6)).toBe(`${word}é${next}`);
    expect(await head(page)).toBe(end + 1);
    // No pass ran while it composed; the paragraph is laid out after.
    expect(await passes(page)).toBe(held);
    await settleLocal(page, held);
    expect(await text(page, end - 4, end + 6)).toBe(`${word}é${next}`);
  });

  test(`IME compositions in a row in a word joined across ${where} are each written once`, async ({ page }) => {
    await demo(page);
    const end = await lineEnd(page, kind);
    const [word, next] = [await text(page, end - 4, end), await text(page, end + 1, end + 6)];
    await joinAt(page, end);
    // A dead key's accent, then kana turned to kanji, then a key.
    await compose(page, ['e', 'é'], 'é');
    await expect.poll(() => text(page, end - 4, end + 6)).toBe(`${word}é${next}`);
    await compose(page, ['ka', 'か', '下'], '下');
    await expect.poll(() => text(page, end - 4, end + 7)).toBe(`${word}é下${next}`);
    expect(await head(page)).toBe(end + 2);
    await page.keyboard.type('x');
    await expect.poll(() => text(page, end - 4, end + 8)).toBe(`${word}é下x${next}`);
    expect(await head(page)).toBe(end + 3);
  });
}
