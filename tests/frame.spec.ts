import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// The frame (src/style.css, "The room"): the paper is a fixed-width column
// in the room under the bar and right of the rail, and the window's size
// is room around it. Resizing the window must not touch the layout — the
// editor's width stays, pagination does not run again — and the chrome
// must keep the page's axis. The zoom step itself (CSS px stay CSS px) is
// driven in the shell by app/smoke.mjs; a browser tab cannot zoom from
// Playwright.

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
  stack: { left: number; width: number; right: number };
  room: { left: number; clientWidth: number; scrollWidth: number };
  bar: { left: number; fileLeft: number };
  hud: { right: number };
}

const geometry = (page: Page) =>
  page.evaluate((): Geometry => {
    const stack = document.getElementById('stack')!.getBoundingClientRect();
    const room = document.getElementById('scroll')!;
    const bar = document.getElementById('toolbar')!.getBoundingClientRect();
    const file = document.querySelector('#toolbar .tb-tile')!.getBoundingClientRect();
    const hud = document.getElementById('hud')!.getBoundingClientRect();
    return {
      passes: window.__pagCount(),
      pages: document.querySelectorAll('.page-box').length,
      editorWidth: document.querySelector<HTMLElement>('.ProseMirror')!.clientWidth,
      stack: { left: stack.left, width: stack.width, right: stack.right },
      room: { left: room.getBoundingClientRect().left, clientWidth: room.clientWidth, scrollWidth: room.scrollWidth },
      bar: { left: bar.left, fileLeft: file.left },
      hud: { right: hud.right },
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
  // Centered in the room (the room's content box: the window right of the
  // rail, less the scrollbar's gutter), the HUD just inside the paper's
  // right edge, and the bar's File tile at the bar's left, where the
  // traffic lights' room ends (none in a tab: 12px in).
  const axis = (g: Geometry) => g.room.left + g.room.clientWidth / 2;
  const onAxis = (g: Geometry) => {
    expect(Math.abs(g.stack.left + g.stack.width / 2 - axis(g))).toBeLessThan(1);
    expect(Math.abs(g.hud.right - (g.stack.right - 18))).toBeLessThan(1);
  };
  onAxis(before);
  expect(before.bar.fileLeft).toBe(before.bar.left + 12);

  // Wider: more room, the same paper and the same pagination.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(700);
  const wide = await geometry(page);
  expect(wide.passes).toBe(before.passes);
  expect(wide.pages).toBe(before.pages);
  expect(wide.editorWidth).toBe(before.editorWidth);
  expect(wide.stack.width).toBe(before.stack.width);
  onAxis(wide);

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

test('the frame is Zen\'s: one near-black surround — the bar, the rail, the room — the bar a drag region with its controls the page\'s', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  const look = await page.evaluate(() => {
    const room = document.getElementById('scroll')!;
    const bar = document.getElementById('toolbar')!.getBoundingClientRect();
    const rail = document.getElementById('rail')!.getBoundingClientRect();
    return {
      frame: getComputedStyle(document.body).backgroundColor,
      roomBackground: getComputedStyle(room).backgroundColor,
      radius: getComputedStyle(room).borderRadius,
      roomTop: room.getBoundingClientRect().top,
      roomLeft: room.getBoundingClientRect().left,
      barBottom: bar.bottom,
      barLeft: bar.left,
      barRight: bar.right,
      rail: { left: rail.left, top: rail.top, right: rail.right, bottom: rail.bottom },
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  expect(look.frame).toBe('rgb(17, 17, 18)');
  // One colour all round: the room paints the frame's, no panel.
  expect(look.roomBackground).toBe('rgb(17, 17, 18)');
  expect(look.radius).toBe('0px');
  // The bar spans the whole window (it is the window's title bar in
  // Plass.app); the rail runs under it down the left edge; the room
  // starts where they end.
  expect(look.barLeft).toBe(0);
  expect(look.barRight).toBe(look.width);
  expect(look.rail).toEqual({ left: 0, top: look.barBottom, right: look.roomLeft, bottom: look.height });
  expect(look.roomTop).toBe(look.barBottom);
  // Chromium exposes the property (inert in a tab; the shell's window
  // moves by the bar's empty part, and the tiles, the name, the menus
  // and the view switch keep their clicks). The rail scrolls, so it is
  // no drag region.
  expect(await appRegion(page, '#toolbar')).toBe('drag');
  expect(await appRegion(page, '#rail')).not.toBe('drag');
  for (const selector of ['.doc-title', '#toolbar .tb-tile', '.view-switch']) expect(await appRegion(page, selector)).toBe('no-drag');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  expect(await appRegion(page, '.tb-menu:not([hidden])')).toBe('no-drag');
});
