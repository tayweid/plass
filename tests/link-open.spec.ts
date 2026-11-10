import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Opening a link from the page (src/link-open.ts): ⌘-click (Ctrl-click off
// a Mac) opens a Markdown link or a bare URL in a new tab, a plain click
// only places the caret, resting on a link shows a hint, and ⌘ held over
// one shows a hand. Only web and email addresses open.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null) => Promise<unknown> };
    __opened: string[];
  }
}

const SHEET = [
  '# Links',
  '',
  'A Markdown link to [the Typst docs](https://typst.app/docs) sits here, and a bare URL https://example.com/page follows it.',
  '',
  'Mail [me](mailto:someone@example.com), or read [the notes](notes.md). Code `https://code.example` stays code.',
  '',
  '| Site | Address |',
  '|---|---|',
  '| Typst | https://cell.example/x |',
  '',
  ': Sites, from https://cap.example/list',
  '',
].join('\n');

async function openSheet(page: Page) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('links.md', { create: true });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
    await window.__fm.loadHandle(h, root);
  }, SHEET);
  await settleLocal(page);
  // Record what would open instead of opening it.
  await page.evaluate(() => {
    window.__opened = [];
    window.open = ((url: string) => {
      window.__opened.push(url);
      return null;
    }) as typeof window.open;
  });
}

/** The screen point at the middle of the first three characters of
 *  `needle` in the page's text. */
async function pointOf(page: Page, needle: string) {
  return page.evaluate((needle) => {
    const walk = document.createTreeWalker(document.querySelector('.ProseMirror')!, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + 3);
      const r = range.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    throw new Error(`no ${needle} on the page`);
  }, needle);
}

const opened = (page: Page) => page.evaluate(() => window.__opened);

test('⌘-click opens a Markdown link; a plain click places the caret', async ({ page }) => {
  await openSheet(page);
  const link = page.locator('.ProseMirror a[href="https://typst.app/docs"]');

  await link.click();
  expect(await opened(page)).toEqual([]);
  // The caret is in the link's words (ProseMirror reads the browser's
  // selection on selectionchange, a moment after the click).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { $from } = window.view.state.selection;
        const start = $from.parent.textContent.indexOf('the Typst docs');
        return start >= 0 && $from.parentOffset >= start && $from.parentOffset <= start + 'the Typst docs'.length;
      }),
    )
    .toBe(true);

  await link.click({ modifiers: ['ControlOrMeta'] });
  expect(await opened(page)).toEqual(['https://typst.app/docs']);
  // The page stays, and the document is untouched.
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.evaluate(() => window.view.state.doc.textContent)).toContain('the Typst docs');
});

test('⌘-click opens a bare URL, a mail link, and nothing on plain words', async ({ page }) => {
  await openSheet(page);
  const bare = await pointOf(page, 'example.com');
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(bare.x, bare.y);
  await page.keyboard.up('ControlOrMeta');
  expect(await opened(page)).toEqual(['https://example.com/page']);

  await page.locator('.ProseMirror a[href^="mailto:"]').click({ modifiers: ['ControlOrMeta'] });
  expect((await opened(page)).at(-1)).toBe('mailto:someone@example.com');

  const words = await pointOf(page, 'sits here');
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(words.x, words.y);
  await page.keyboard.up('ControlOrMeta');
  expect(await opened(page)).toHaveLength(2);
});

test('a link that is not a web or email address says so instead of opening', async ({ page }) => {
  await openSheet(page);
  await page.locator('.ProseMirror a[href="notes.md"]').click({ modifiers: ['ControlOrMeta'] });
  expect(await opened(page)).toEqual([]);
  await expect(page.locator('#toast')).toContainText('Only web and email links open');
});

test('resting on a link shows its address and the gesture; ⌘ held shows a hand', async ({ page }) => {
  await openSheet(page);
  const hint = page.locator('#link-hint');
  await page.locator('.ProseMirror a[href="https://typst.app/docs"]').hover();
  await expect(hint).toHaveClass(/show/);
  await expect(hint).toContainText('https://typst.app/docs');
  await expect(hint).toContainText(/click to open/);
  // Under the line, beside the pointer.
  const [h, a] = await Promise.all([hint.boundingBox(), page.locator('.ProseMirror a[href="https://typst.app/docs"]').boundingBox()]);
  expect(h!.y).toBeGreaterThan(a!.y + a!.height - 1);

  // A bare URL's hint is the gesture alone: its address is on the page.
  const bare = await pointOf(page, 'example.com');
  await page.mouse.move(bare.x, bare.y);
  await expect(hint).toHaveClass(/show/);
  await expect(hint).toHaveText(/^(⌘|Ctrl)-click to open$/);

  // ⌘ held: the hand. Typing hides the hint; leaving a link drops the hand.
  await page.keyboard.down('ControlOrMeta');
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await expect(editor).toHaveClass(/ts-link-armed/);
  await page.keyboard.up('ControlOrMeta');
  await expect(editor).not.toHaveClass(/ts-link-armed/);
  const words = await pointOf(page, 'sits here');
  await page.mouse.move(words.x, words.y);
  await expect(hint).not.toHaveClass(/show/);
});

const LINK_BLUE = 'rgb(0, 0, 238)';

test('every link is drawn in the link blue, underlined, as print shows it; code is not', async ({ page }) => {
  await openSheet(page);
  const look = (sel: string) =>
    page.locator(sel).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, line: cs.textDecorationLine };
    });
  expect(await look('.ProseMirror a[href="https://typst.app/docs"]')).toEqual({ color: LINK_BLUE, line: 'underline' });
  // A bare URL: a decoration over exactly its text, in a paragraph and a cell.
  // (A URL broken across lines is drawn in a piece per line.)
  const urls = await page.locator('.ProseMirror p .ts-url').evaluateAll((els) => els.map((e) => e.textContent).join(''));
  expect(urls).toBe('https://example.com/pagehttps://cell.example/x');
  expect(await look('.ProseMirror .ts-url')).toEqual({ color: LINK_BLUE, line: 'underline' });
  // Inline code holds its URL as text, as Typst's raw prints it.
  expect(await page.locator('.ProseMirror code .ts-url').count()).toBe(0);
  // The caption's URL, painted by its widget.
  await expect(page.locator('.native-table-caption .ts-url')).toHaveText('https://cap.example/list');
  expect(await look('.native-table-caption .ts-url')).toEqual({ color: LINK_BLUE, line: 'underline' });

  // Typing a URL draws it as a link at once; editing it away undraws it.
  await page.evaluate(() => {
    const view = window.view;
    let end = -1;
    view.state.doc.descendants((n, pos) => {
      if (end < 0 && n.isTextblock && n.textContent.endsWith('follows it.')) end = pos + 1 + n.content.size;
    });
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(end))));
    view.focus();
  });
  await page.keyboard.type(' See https://typed.example/now');
  const drawn = () => page.locator('.ProseMirror p .ts-url').evaluateAll((els) => els.map((e) => e.textContent).join(''));
  await expect.poll(drawn).toContain('https://typed.example/now');
  for (let k = 0; k < 'https://typed.example/now'.length; k++) await page.keyboard.press('Backspace');
  await expect.poll(drawn).toBe('https://example.com/pagehttps://cell.example/x');
});

test('⌘-click opens a URL in a table caption; a plain click still opens Table settings', async ({ page }) => {
  await openSheet(page);
  const url = page.locator('.native-table-caption .ts-url');
  await url.click({ modifiers: ['ControlOrMeta'] });
  expect(await opened(page)).toEqual(['https://cap.example/list']);
  await page.locator('.native-table-caption').click({ position: { x: 4, y: 4 } });
  await expect(page.getByRole('dialog', { name: 'Table settings' })).toBeVisible();
  expect(await opened(page)).toHaveLength(1);
});
