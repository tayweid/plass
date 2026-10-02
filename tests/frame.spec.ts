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
  bar: { left: number; fileLeft: number; fileCentre: number };
  railCentre: number;
  hud: { right: number; top: number };
  lastPage: { bottom: number };
}

const geometry = (page: Page) =>
  page.evaluate((): Geometry => {
    const stack = document.getElementById('stack')!.getBoundingClientRect();
    const room = document.getElementById('scroll')!;
    const bar = document.getElementById('toolbar')!.getBoundingClientRect();
    const file = document.querySelector('#toolbar .tb-tile')!.getBoundingClientRect();
    const tile = document.querySelector('#rail .tb-btn')!.getBoundingClientRect();
    const hud = document.getElementById('hud')!.getBoundingClientRect();
    const pages = document.querySelectorAll('.page-box');
    return {
      passes: window.__pagCount(),
      pages: document.querySelectorAll('.page-box').length,
      editorWidth: document.querySelector<HTMLElement>('.ProseMirror')!.clientWidth,
      stack: { left: stack.left, width: stack.width, right: stack.right },
      room: { left: room.getBoundingClientRect().left, clientWidth: room.clientWidth, scrollWidth: room.scrollWidth },
      bar: { left: bar.left, fileLeft: file.left, fileCentre: file.left + file.width / 2 },
      railCentre: tile.left + tile.width / 2,
      hud: { right: hud.right, top: hud.top },
      lastPage: { bottom: pages[pages.length - 1].getBoundingClientRect().bottom },
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
  // traffic lights' room ends (none in a tab: there it stands over the
  // rail's column of tiles, 6 px in).
  const axis = (g: Geometry) => g.room.left + g.room.clientWidth / 2;
  const onAxis = (g: Geometry) => {
    expect(Math.abs(g.stack.left + g.stack.width / 2 - axis(g))).toBeLessThan(1);
    expect(Math.abs(g.hud.right - (g.stack.right - 18))).toBeLessThan(1);
  };
  onAxis(before);
  expect(before.bar.fileLeft).toBe(before.bar.left + 6);
  expect(before.bar.fileCentre).toBe(before.railCentre);

  // At the end of the document the last page ends above the HUD's row
  // (the room keeps it, --margin-bottom): the count never sits on the
  // paper's edge.
  await page.evaluate(() => {
    const room = document.getElementById('scroll')!;
    room.scrollTop = room.scrollHeight;
  });
  await page.waitForTimeout(200);
  const end = await geometry(page);
  expect(end.hud.top).toBeGreaterThan(end.lastPage.bottom + 8);
  await page.evaluate(() => { document.getElementById('scroll')!.scrollTop = 0; });

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

test('the frame is Zen\'s: a dark edge all round a rounded room, the rail narrow, the bar a drag region with its controls the page\'s', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  const look = await page.evaluate(() => {
    const room = document.getElementById('scroll')!;
    const bar = document.getElementById('toolbar')!.getBoundingClientRect();
    const rail = document.getElementById('rail')!.getBoundingClientRect();
    const tile = document.querySelector('#rail .tb-btn')!.getBoundingClientRect();
    const roomRect = room.getBoundingClientRect();
    return {
      frame: getComputedStyle(document.body).backgroundColor,
      roomBackground: getComputedStyle(room).backgroundColor,
      radius: getComputedStyle(room).borderRadius,
      paperShadow: getComputedStyle(document.querySelector('.page-box')!).boxShadow,
      room: { left: roomRect.left, top: roomRect.top, right: roomRect.right, bottom: roomRect.bottom },
      barBottom: bar.bottom,
      barLeft: bar.left,
      barRight: bar.right,
      rail: { left: rail.left, top: rail.top, right: rail.right, bottom: rail.bottom },
      tile: { left: tile.left, width: tile.width, height: tile.height },
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  // A dark grey frame, not black, and the room a shade lighter, where the
  // paper's soft shadow shows.
  expect(look.frame).toBe('rgb(24, 24, 26)');
  expect(look.roomBackground).toBe('rgb(43, 42, 45)');
  expect(look.radius).toBe('12px');
  expect(look.paperShadow).not.toBe('none');
  // The bar spans the whole window (it is the window's title bar in
  // Plass.app); the rail runs under it down the left edge, as narrow as
  // Zen's: 32 px tiles with the frame's 8 px either side. The room starts
  // where they end and keeps the same 8 px to the window's right and
  // bottom edges.
  expect(look.barLeft).toBe(0);
  expect(look.barRight).toBe(look.width);
  expect(look.rail).toEqual({ left: 0, top: look.barBottom, right: look.room.left, bottom: look.height });
  expect(look.tile).toEqual({ left: 8, width: 32, height: 32 });
  expect(look.rail.right).toBe(48);
  expect(look.room).toEqual({ left: 48, top: look.barBottom, right: look.width - 8, bottom: look.height - 8 });
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

test('the rail and the panels it opens keep off the bar; a short window says the tools go on and keeps settings and the switch', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  const barBottom = await page.evaluate(() => document.getElementById('toolbar')!.getBoundingClientRect().bottom);
  // Document settings is taller than the room under its tile: it opens
  // beside the rail, stops below the bar and scrolls inside itself.
  await page.getByRole('button', { name: 'Document settings', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Document settings', exact: true });
  const bounds = (await panel.boundingBox())!;
  expect(bounds.y).toBeGreaterThan(barBottom);
  expect(bounds.x).toBeGreaterThanOrEqual(48);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(800 - 8);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  // So do the flyouts.
  await page.getByRole('button', { name: 'Extras', exact: true }).click();
  const extras = (await page.getByRole('menu', { name: 'Extras', exact: true }).boundingBox())!;
  expect(extras.y).toBeGreaterThan(barBottom);
  await page.keyboard.press('Escape');

  // A tall window shows every tool; a short one cuts the tool groups, and
  // a fade at the cut says which way the rest is. Document settings and
  // the view switch are pinned below the groups, as Zen pins its bottom
  // icons: whole and inside the window at any height (at 1100×560 the cut
  // once fell just past Extras and took Document settings with it).
  const cue = () => page.evaluate(() => {
    const groups = document.querySelector('.tb-rail-groups')!;
    return { above: groups.classList.contains('tb-more-above'), below: groups.classList.contains('tb-more-below') };
  });
  const pinned = () => page.evaluate(() => {
    const groups = document.querySelector('.tb-rail-groups')!;
    const cut = groups.getBoundingClientRect().bottom;
    return ['Document settings', 'Plain text view'].map((name) => {
      const tile = document.querySelector(`#rail [aria-label="${name}"]`)!;
      const bounds = tile.getBoundingClientRect();
      return { name, scrolls: groups.contains(tile), belowCut: bounds.top >= cut, inWindow: bounds.bottom <= innerHeight - 8 };
    });
  });
  await expect.poll(cue).toEqual({ above: false, below: false });
  for (const height of [560, 480, 360]) {
    await page.setViewportSize({ width: 1100, height });
    await expect.poll(cue).toEqual({ above: false, below: true });
    for (const tile of await pinned()) expect(tile).toEqual({ name: tile.name, scrolls: false, belowCut: true, inWindow: true });
  }

  // A tile Tab reaches under the fade scrolls clear of it (the groups'
  // scroll padding is the fade's height).
  await page.setViewportSize({ width: 1100, height: 480 });
  await expect.poll(cue).toEqual({ above: false, below: true });
  const target = await page.evaluate(() => {
    const groups = document.querySelector('.tb-rail-groups')!;
    const fade = groups.getBoundingClientRect().bottom - 28;
    const tiles = [...groups.querySelectorAll<HTMLButtonElement>('.tb-btn:not(:disabled)')];
    const index = tiles.findIndex((tile) => tile.getBoundingClientRect().bottom > fade);
    return { name: tiles[index].getAttribute('aria-label')!, tabs: index };
  });
  await page.locator('#rail .tb-btn').first().focus();
  for (let i = 0; i < target.tabs; i++) await page.keyboard.press('Tab');
  await expect(page.locator(`#rail [aria-label="${target.name}"]`)).toBeFocused();
  const clear = await page.evaluate(() => {
    const groups = document.querySelector('.tb-rail-groups')!.getBoundingClientRect();
    const tile = document.activeElement!.getBoundingClientRect();
    return tile.top >= groups.top - 0.5 && tile.bottom <= groups.bottom - 28 + 0.5;
  });
  expect(clear).toBe(true);
  await page.evaluate(() => {
    const groups = document.querySelector('.tb-rail-groups')!;
    groups.scrollTop = groups.scrollHeight;
  });
  await expect.poll(cue).toEqual({ above: true, below: false });
});

test('print shows the paper alone: the bar, the rail and the HUD are gone', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.emulateMedia({ media: 'print' });
  const shown = await page.evaluate(() => ['#toolbar', '#rail', '#hud', '.view-switch'].map((selector) => getComputedStyle(document.querySelector(selector)!).display));
  expect(shown).toEqual(['none', 'none', 'none', 'none']);
  await page.emulateMedia({ media: 'screen' });
});
