import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// The frame (src/style.css, "The room"): the paper is a fixed-width column
// in a rounded room under the bar, and the window's size is room around
// it. Resizing the window must not touch the layout — the editor's width
// stays, pagination does not run again — and the chrome must keep the
// page's axis. The zoom step itself (CSS px stay CSS px) is driven in the
// shell by app/smoke.mjs; a browser tab cannot zoom from Playwright.

declare global {
  interface Window {
    __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> };
    __pagCount: () => number;
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';

async function openTyp(page: Page, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(async ({ text }) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('frame.typ', { create: true });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
    await window.__fm.loadHandle(h);
  }, { text });
  await settleLocal(page);
}

interface Geometry {
  passes: number;
  pages: number;
  editorWidth: number;
  stack: { left: number; width: number };
  room: { left: number; clientWidth: number; scrollWidth: number };
  pills: { left: number; right: number };
}

const geometry = (page: Page) =>
  page.evaluate((): Geometry => {
    const stack = document.getElementById('stack')!.getBoundingClientRect();
    const room = document.getElementById('scroll')!;
    const title = document.querySelector('.doc-title')!.getBoundingClientRect();
    const last = document.querySelector('#toolbar > .tb-pod:last-child')!.getBoundingClientRect();
    return {
      passes: window.__pagCount(),
      pages: document.querySelectorAll('.page-box').length,
      editorWidth: document.querySelector<HTMLElement>('.ProseMirror')!.clientWidth,
      stack: { left: stack.left, width: stack.width },
      room: { left: room.getBoundingClientRect().left, clientWidth: room.clientWidth, scrollWidth: room.scrollWidth },
      pills: { left: title.left, right: last.right },
    };
  });

const appRegion = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const style = getComputedStyle(document.querySelector(selector)!) as CSSStyleDeclaration & { appRegion?: string };
    return style.getPropertyValue('-webkit-app-region') || style.appRegion || '';
  }, selector);

test('the window is room around a fixed-width paper: a resize re-lays nothing and the chrome keeps the axis', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, Array.from({ length: 18 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') + '\n');
  const before = await geometry(page);
  expect(before.pages).toBeGreaterThan(2);
  // Centered in the room (the room's content box, which is the window
  // less the frame's insets and the scrollbar's gutter), the pills over
  // the paper's axis.
  const axis = (g: Geometry) => g.room.left + g.room.clientWidth / 2;
  expect(Math.abs(before.stack.left + before.stack.width / 2 - axis(before))).toBeLessThan(1);
  expect(Math.abs((before.pills.left + before.pills.right) / 2 - axis(before))).toBeLessThan(1.5);

  // Wider: more room, the same paper and the same pagination.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(700);
  const wide = await geometry(page);
  expect(wide.passes).toBe(before.passes);
  expect(wide.pages).toBe(before.pages);
  expect(wide.editorWidth).toBe(before.editorWidth);
  expect(wide.stack.width).toBe(before.stack.width);
  expect(Math.abs(wide.stack.left + wide.stack.width / 2 - axis(wide))).toBeLessThan(1);
  expect(Math.abs((wide.pills.left + wide.pills.right) / 2 - axis(wide))).toBeLessThan(1.5);

  // Narrower than the paper: the room scrolls sideways; still no layout.
  await page.setViewportSize({ width: 700, height: 600 });
  await page.waitForTimeout(700);
  const narrow = await geometry(page);
  expect(narrow.passes).toBe(before.passes);
  expect(narrow.pages).toBe(before.pages);
  expect(narrow.editorWidth).toBe(before.editorWidth);
  expect(narrow.stack.width).toBe(before.stack.width);
  expect(narrow.room.scrollWidth).toBeGreaterThan(narrow.room.clientWidth);
});

test('the frame is Zen\'s: a near-black frame, a rounded room, the bar a drag region with its controls the page\'s', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  const look = await page.evaluate(() => {
    const room = getComputedStyle(document.getElementById('scroll')!);
    const bar = document.getElementById('toolbar')!.getBoundingClientRect();
    return {
      frame: getComputedStyle(document.body).backgroundColor,
      roomBackground: room.backgroundColor,
      radius: room.borderRadius,
      roomTop: document.getElementById('scroll')!.getBoundingClientRect().top,
      barBottom: bar.bottom,
      barLeft: bar.left,
      barRight: bar.right,
      width: window.innerWidth,
    };
  });
  expect(look.frame).toBe('rgb(17, 17, 18)');
  expect(look.roomBackground).toBe('rgb(43, 42, 45)');
  expect(look.radius).toBe('12px');
  // The room starts where the bar ends; the bar spans the whole window
  // (it is the window's title bar in Plass.app).
  expect(look.roomTop).toBe(look.barBottom);
  expect(look.barLeft).toBe(0);
  expect(look.barRight).toBe(look.width);
  // Chromium exposes the property (inert in a tab; the shell's window
  // moves by the bar's empty part, and the pills, menus and the view
  // switch keep their clicks).
  expect(await appRegion(page, '#toolbar')).toBe('drag');
  for (const selector of ['.doc-title', '.tb-pod', '.view-switch']) expect(await appRegion(page, selector)).toBe('no-drag');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  expect(await appRegion(page, '.tb-menu:not([hidden])')).toBe('no-drag');
});
