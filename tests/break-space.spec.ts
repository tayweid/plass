import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// The space a line breaks at (src/break-space.ts). The layout draws a
// line's break after its last space (a `<br class="ts-br">`, or a
// `.ts-pagegap` where the line ends a page), and the editor's `white-space:
// normal` collapses that space, which Chrome's editing then treats as
// deletable whitespace beside whatever it writes: a letter typed at the end
// of a line ran the line's last word into the next line's first ("Every
// line break" became "Every linexbreak"). Each edit here starts with the
// caret put at a line end by the keys a writer uses: a click in the line,
// then the line-end key.

type Hooks = {
  view: import('prosemirror-view').EditorView;
  __loadDemo: () => void;
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

/** Click in the line that ends at `end`, then press the line-end key. */
async function caretTo(page: Page, end: number) {
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
  // The case: the break space is collapsed, so measured as the character
  // after the caret it is an empty box (src/caret-box.ts).
  const empty = await page.evaluate((end) => {
    const box = (window as unknown as Hooks).view.coordsAtPos(end);
    return !(box.bottom > box.top);
  }, end);
  expect(empty, 'the break space is collapsed').toBe(true);
}

/** An IME's composition, as Chromium's input method controller drives it:
 *  each update replaces the composed text, then the commit. */
async function compose(page: Page, updates: string[], commit: string) {
  const cdp = await page.context().newCDPSession(page);
  for (const text of updates) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  await cdp.send('Input.insertText', { text: commit });
  await cdp.detach();
}

for (const kind of ['br', 'gap'] as const) {
  const where = kind === 'br' ? 'a line end' : 'a line end at a page break';

  test(`a letter typed at ${where} keeps the space the line breaks at`, async ({ page }) => {
    await demo(page);
    const end = await lineEnd(page, kind);
    const [word, next] = [await text(page, end - 4, end), await text(page, end + 1, end + 6)];
    await caretTo(page, end);
    await page.keyboard.type('xy');
    await expect.poll(() => text(page, end - 4, end + 8)).toBe(`${word}xy ${next}`);
    expect(await head(page)).toBe(end + 2);
    // Undo takes the letters away and leaves the line as it was.
    await page.waitForTimeout(600);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => text(page, end - 4, end + 6)).toBe(`${word} ${next}`);
  });

  test(`a space typed at ${where} is the space already there`, async ({ page }) => {
    await demo(page);
    const end = await lineEnd(page, kind);
    const [word, next] = [await text(page, end - 4, end), await text(page, end + 1, end + 6)];
    await caretTo(page, end);
    await page.keyboard.type(' ');
    await expect.poll(() => head(page)).toBe(end + 1);
    expect(await text(page, end - 4, end + 6)).toBe(`${word} ${next}`);
  });

  test(`Backspace at ${where} deletes the letter before the caret, not the space after it`, async ({ page }) => {
    await demo(page);
    const end = await lineEnd(page, kind);
    const [word, next] = [await text(page, end - 4, end), await text(page, end + 1, end + 6)];
    await caretTo(page, end);
    await page.keyboard.press('Backspace');
    await expect.poll(() => text(page, end - 4, end + 5)).toBe(`${word.slice(0, -1)} ${next}`);
    expect(await head(page)).toBe(end - 1);
  });

  test(`Backspace at the start of the line after ${where} deletes the break space`, async ({ page }) => {
    await demo(page);
    const end = await lineEnd(page, kind);
    const [word, next] = [await text(page, end - 4, end), await text(page, end + 1, end + 6)];
    await caretTo(page, end);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => head(page)).toBe(end + 1);
    await page.keyboard.press('Backspace');
    await expect.poll(() => text(page, end - 4, end + 5)).toBe(`${word}${next}`);
    expect(await head(page)).toBe(end);
  });

  test(`Delete at ${where} deletes the break space`, async ({ page }) => {
    await demo(page);
    const end = await lineEnd(page, kind);
    const [word, next] = [await text(page, end - 4, end), await text(page, end + 1, end + 6)];
    await caretTo(page, end);
    await page.keyboard.press('Delete');
    await expect.poll(() => text(page, end - 4, end + 5)).toBe(`${word}${next}`);
    expect(await head(page)).toBe(end);
  });

  test(`an IME's text at ${where} keeps the space the line breaks at`, async ({ page }) => {
    await demo(page);
    const end = await lineEnd(page, kind);
    const [word, next] = [await text(page, end - 4, end), await text(page, end + 1, end + 6)];
    await caretTo(page, end);
    // A dead key's accent, then kana turned to kanji.
    await compose(page, ['e', 'é'], 'é');
    await expect.poll(() => text(page, end - 4, end + 7)).toBe(`${word}é ${next}`);
    expect(await head(page)).toBe(end + 1);
    await compose(page, ['ka', 'か', '下'], '下');
    await expect.poll(() => text(page, end - 4, end + 8)).toBe(`${word}é下 ${next}`);
    expect(await head(page)).toBe(end + 2);
    // The next key typed goes on after it.
    await page.keyboard.type('x');
    await expect.poll(() => text(page, end - 4, end + 9)).toBe(`${word}é下x ${next}`);
  });

  test(`an IME's text over a selection ending at ${where} replaces only the selection`, async ({ page }) => {
    await demo(page);
    const end = await lineEnd(page, kind);
    const [word, next] = [await text(page, end - 4, end), await text(page, end + 1, end + 6)];
    await caretTo(page, end);
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).view.state.selection.from)).toBe(end - 1);
    await compose(page, ['e', 'é'], 'é');
    await expect.poll(() => text(page, end - 4, end + 6)).toBe(`${word.slice(0, -1)}é ${next}`);
    expect(await head(page)).toBe(end);
  });
}
