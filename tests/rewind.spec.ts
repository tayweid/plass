// A rewind from the shell's History window, as the page in Plass.app takes
// it (docs/CLAERBOUT-SHELL.md, "OPEN"; the shell's README, "The history
// view"): `save {id}` writes the open document through ⌘S's write and
// answers `saved`, at once when nothing changed and `ok: false` with why
// when it cannot; `reload {paths, to, app?}` reads the file again, in
// place, only when the window's own path is among the paths; and File ›
// History… and the History tile beside the name ask for the History
// window, one call, inside Plass.app only.
//
// The shell is a stand-in on `window.claerbout` (as in persistence.spec.ts):
// every request kept on `__shell`, the page's listeners kept so a test can
// send an event (`__fire`), and the `document` report answered with a path,
// as the shell answers it with the file it matched. The disk watcher (the
// file manager's 1.5 s poll) is held still, so a file changed under the
// document is read by the reload or by nothing.
import { expect, test, type Page } from './fixture';

const PATH = '/Users/someone/papers/Rewind.typ';
const SHA = 'f00dfeed'.repeat(5);

const inPlassApp = (page: Page, historyAnswer: { opened: boolean; inline?: boolean } | null = { opened: true, inline: true }) =>
  page.addInitScript(
    ({ path, historyAnswer }) => {
      const w = window as any;
      w.__shell = [];
      w.__listeners = {} as Record<string, Array<(detail: unknown) => void>>;
      w.__fire = (event: string, detail: unknown) => (w.__listeners[event] ?? []).forEach((listener: (d: unknown) => void) => listener(detail));
      w.claerbout = {
        request: async (message: { type: string; name?: string }) => {
          // What the disk holds when the page answers, for the save's order.
          if (message.type === 'saved' && w.__read) w.__shell.push({ ...message, disk: await w.__read() });
          else w.__shell.push(message);
          if (message.type === 'document') return { path: message.name ? path : null };
          if (message.type === 'history') return historyAnswer;
          return null;
        },
        on: (event: string, listener: (detail: unknown) => void) => {
          (w.__listeners[event] ??= []).push(listener);
          return () => {
            w.__listeners[event] = w.__listeners[event].filter((l: unknown) => l !== listener);
          };
        },
        pathOf: () => '',
      };
      const setInterval = window.setInterval.bind(window);
      w.setInterval = (handler: TimerHandler, ms?: number, ...rest: unknown[]) => (ms === 1500 ? 0 : setInterval(handler, ms, ...rest));
    },
    { path: PATH, historyAnswer },
  );

/** A fresh window holding Rewind.typ (`text`) in its own OPFS folder, its
 *  path known to the shell. */
async function openRewind(page: Page, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);
  const dirName = `rewind-${Math.random().toString(36).slice(2)}`;
  const opened = await page.evaluate(
    async ({ dirName, text }) => {
      const w = window as any;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(dirName, { create: true });
      const handle = await dir.getFileHandle('Rewind.typ', { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      w.__read = async () => {
        try {
          return await (await (await dir.getFileHandle('Rewind.typ')).getFile()).text();
        } catch {
          return null;
        }
      };
      w.__write = async (next: string) => {
        const out = await (await dir.getFileHandle('Rewind.typ', { create: true })).createWritable();
        await out.write(next);
        await out.close();
      };
      w.__remove = () => dir.removeEntry('Rewind.typ');
      return await w.__fm.loadHandle(handle, dir);
    },
    { dirName, text },
  );
  expect(opened).toBe(true);
  // The shell answered the report: the bar shows the folder.
  await expect(page.locator('#doc-folder')).toHaveAttribute('title', '/Users/someone/papers');
}

const fire = (page: Page, event: string, detail: unknown) => page.evaluate(([event, detail]) => (window as any).__fire(event, detail), [event, detail] as const);
const answers = (page: Page) => page.evaluate(() => (window as any).__shell.filter((m: { type: string }) => m.type === 'saved'));
const disk = (page: Page) => page.evaluate(() => (window as any).__read());
const docText = (page: Page) => page.evaluate(() => (window as any).view.state.doc.textContent as string);
const state = (page: Page) =>
  page.evaluate(() => {
    const w = window as any;
    const { $head } = w.view.state.selection;
    return { block: $head.parent.textContent as string, offset: $head.parentOffset as number, scroll: document.getElementById('scroll')!.scrollTop, dirty: w.__fm.dirty as boolean, conflict: w.__fm.hasConflict as boolean };
  });

test('in Plass.app a rewind’s save writes the open document through ⌘S’s write and answers saved', async ({ page }) => {
  await inPlassApp(page);
  await openRewind(page, '= Rewind\n\nThe first version.\n');

  // Typed, not yet autosaved (that waits 1.2 s): the save writes it before
  // it answers.
  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  const asked = Date.now();
  await fire(page, 'save', { id: 's1', reason: 'rewind' });
  await expect.poll(() => answers(page)).toHaveLength(1);
  const [first] = await answers(page);
  // Inside the 3 s the shell waits before it passes a window over.
  expect(Date.now() - asked).toBeLessThan(3000);
  expect(first).toMatchObject({ type: 'saved', id: 's1', ok: true });
  expect(first.error).toBeUndefined();
  expect(first.disk).toContain('The first version. Typed.');
  expect((await state(page)).dirty).toBe(false);
  // ⌘S's toast is not the rewind's: the save is quiet.
  await expect(page.locator('#toast')).not.toContainText('Saved Rewind.typ');

  // Nothing changed since: answered at once.
  await fire(page, 'save', { id: 's2', reason: 'rewind' });
  await expect.poll(() => answers(page)).toHaveLength(2);
  expect((await answers(page))[1]).toMatchObject({ id: 's2', ok: true });

  // Typed again while the file changed outside Plass: Plass keeps its copy
  // and says why it could not save, which refuses the rewind.
  await page.keyboard.type(' Again.');
  await page.evaluate(() => (window as any).__write('= Rewind\n\nChanged in another editor.\n'));
  await fire(page, 'save', { id: 's3', reason: 'rewind' });
  await expect.poll(() => answers(page)).toHaveLength(3);
  const third = (await answers(page))[2];
  expect(third).toMatchObject({ id: 's3', ok: false });
  expect(third.error).toContain('changed on disk outside Plass');
  expect(third.disk).toContain('Changed in another editor.');
  expect(await docText(page)).toContain('Typed. Again.');
});

test('in Plass.app a window with no file answers the rewind’s save that it has none', async ({ page }) => {
  await inPlassApp(page);
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);
  await fire(page, 'save', { id: 'n1', reason: 'rewind' });
  await expect.poll(() => answers(page)).toHaveLength(1);
  expect((await answers(page))[0]).toMatchObject({ type: 'saved', id: 'n1', ok: false, error: 'it has no file yet' });
});

test('in Plass.app a rewind’s reload reads the file again in place, and only when it is the window’s', async ({ page }) => {
  await inPlassApp(page);
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} holds a sentence or two of ordinary words, enough to wrap.`);
  const before = `= Rewind\n\n${paragraphs.join('\n\n')}\n`;
  await openRewind(page, before);

  // The caret at the end of paragraph 20, scrolled to it.
  const twenty = page.locator('.ProseMirror p', { hasText: 'Paragraph 20 holds' });
  await twenty.scrollIntoViewIfNeeded();
  await twenty.click();
  await page.keyboard.press('End');
  await page.waitForTimeout(500);
  const at = await state(page);
  expect(at.block).toContain('Paragraph 20 holds');
  expect(at.scroll).toBeGreaterThan(200);

  // The commit rewound to: paragraph 31 gone and 35 different, below the
  // caret, as the rewind wrote it.
  const after = `= Rewind\n\n${paragraphs.filter((_, i) => i !== 30).map((p, i) => (p.startsWith('Paragraph 35 ') ? 'Paragraph 35 as it was an hour ago.' : p)).join('\n\n')}\n`;
  await page.evaluate((text) => (window as any).__write(text), after);

  // Another file's rewind: nothing read, nothing said.
  await fire(page, 'reload', { id: 'r1', paths: ['/Users/someone/papers/Other.typ'], reason: 'rewind', to: SHA });
  await page.waitForTimeout(600);
  expect(await docText(page)).toContain('Paragraph 31 holds');
  await expect(page.locator('#toast')).not.toContainText('Rewound');

  // This file's: the paper reloads in place.
  await fire(page, 'reload', { id: 'r2', paths: ['/Users/someone/papers/Other.typ', PATH], reason: 'rewind', to: SHA });
  await expect(page.locator('#toast')).toContainText('Rewound to f00dfee');
  await expect.poll(() => docText(page)).toContain('Paragraph 35 as it was an hour ago.');
  expect(await docText(page)).not.toContain('Paragraph 31 holds');
  const now = await state(page);
  expect(now.block).toBe(at.block);
  expect(now.offset).toBe(at.offset);
  expect(Math.abs(now.scroll - at.scroll)).toBeLessThan(2);
  expect(now.dirty).toBe(false);
  // Not an edit: nothing is written back over what the rewind wrote.
  await page.waitForTimeout(1600);
  expect(await disk(page)).toBe(after);

  // Knuth's rewind of the file, seen on the record: said as Knuth's.
  await fire(page, 'reload', { id: SHA, paths: [PATH], reason: 'rewind', to: SHA, app: 'knuth' });
  await expect(page.locator('#toast')).toContainText('Rewound by Knuth');
});

test('in Plass.app a rewind under edits typed since its save keeps them, and one that removes the file says so', async ({ page }) => {
  await inPlassApp(page);
  await openRewind(page, '= Rewind\n\nThe saved version.\n');
  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed after the save.');
  await page.evaluate(() => (window as any).__write('= Rewind\n\nThe version rewound to.\n'));
  await fire(page, 'reload', { id: 'u1', paths: [PATH], reason: 'rewind', to: SHA });
  await expect(page.locator('#toast')).toContainText('Rewound to f00dfee under unsaved edits to Rewind.typ');
  expect(await docText(page)).toContain('Typed after the save.');
  expect((await state(page)).conflict).toBe(true);
  expect(await disk(page)).toBe('= Rewind\n\nThe version rewound to.\n');

  // Overwrite disk, then a rewind to a commit without the file.
  await page.locator('#toast .toast-action').click();
  await expect.poll(() => disk(page)).toContain('Typed after the save.');
  await page.evaluate(() => (window as any).__remove());
  await fire(page, 'reload', { id: 'u2', paths: [PATH], reason: 'rewind', to: SHA });
  await expect(page.locator('#toast')).toContainText('Rewound to f00dfee: Rewind.typ is not in that version — your editor copy is safe');
  expect(await docText(page)).toContain('Typed after the save.');
});

/** The room's box as the page measures it: #scroll's, in CSS px. */
const roomBox = (page: Page) =>
  page.evaluate(() => {
    const r = document.getElementById('scroll')!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
const historyAsks = (page: Page) => page.evaluate(() => (window as any).__shell.filter((m: { type: string }) => m.type === 'history'));
const openAsk = async (page: Page) => ({ type: 'history', action: 'open', inline: await roomBox(page) });

test('File › History… asks Plass.app for the History page in the room, and is not in a browser tab', async ({ page, context }) => {
  // A browser tab: no shell, no item.
  await page.goto('/?new=1');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Open…' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'History…' })).toHaveCount(0);

  // Plass.app: the item, with the shell's View-menu keys beside it; it
  // sends the room's box, as the tile does.
  const app = await context.newPage();
  await inPlassApp(app);
  await app.goto('/?new=1');
  await app.waitForFunction(() => !!(window as any).__fm);
  await app.getByRole('button', { name: 'File', exact: true }).click();
  const item = app.getByRole('menuitem', { name: 'History…' });
  await expect(item).toBeVisible();
  await expect(item.locator('kbd')).toHaveText('⇧⌘H');
  await item.click();
  await expect.poll(() => historyAsks(app)).toEqual([await openAsk(app)]);
  await expect(app.locator('#toast')).not.toContainText('history view');

  // A shell from before the room (0.2.1, 0.2.2) answers {opened: true}
  // and opens its History window: nothing said, nothing pressed.
  const older = await context.newPage();
  await inPlassApp(older, { opened: true });
  await older.goto('/?new=1');
  await older.waitForFunction(() => !!(window as any).__fm);
  await older.getByRole('button', { name: 'File', exact: true }).click();
  await older.getByRole('menuitem', { name: 'History…' }).click();
  await expect.poll(() => historyAsks(older)).toEqual([await openAsk(older)]);
  await older.waitForTimeout(300);
  await expect(older.locator('#toast')).not.toContainText('history view');
  await expect(older.locator('#history-tile')).toHaveAttribute('aria-pressed', 'false');

  // A shell without the history view answers null: said, and the item goes.
  const old = await context.newPage();
  await inPlassApp(old, null);
  await old.goto('/?new=1');
  await old.getByRole('button', { name: 'File', exact: true }).click();
  await old.getByRole('menuitem', { name: 'History…' }).click();
  await expect(old.locator('#toast')).toContainText('This Plass.app has no history view');
  await old.getByRole('button', { name: 'File', exact: true }).click();
  await expect(old.getByRole('menuitem', { name: 'Open…' })).toBeVisible();
  await expect(old.getByRole('menuitem', { name: 'History…' })).toBeHidden();
  // The tile goes with it: one call behind both.
  await expect(old.locator('#history-tile')).toBeHidden();
});

test('the History tile beside the name asks Plass.app for the History page in the room as File › History… does, and is not in a browser tab', async ({ page, context }) => {
  // A browser tab: no shell, no tile.
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);
  await expect(page.locator('#doc-pod')).toBeVisible();
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);

  // Plass.app: the tile, its caption on hover, and a click sends the
  // request the menu item sends, the same one. The stand-in never says
  // the page came up, so nothing is pressed and the item asks again.
  const app = await context.newPage();
  await inPlassApp(app);
  await app.goto('/?new=1');
  const tile = app.getByRole('button', { name: 'History', exact: true });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute('title', 'History (⇧⌘H)');
  await tile.hover();
  await expect(tile.locator('.lbl')).toHaveText('History');
  await expect(tile.locator('.lbl')).toHaveCSS('opacity', '1');
  // The click leaves the editor its focus, as every bar tile does.
  const editor = app.locator('.ProseMirror[contenteditable="true"]');
  await editor.click();
  await tile.click();
  const ask = await openAsk(app);
  await expect.poll(() => historyAsks(app)).toEqual([ask]);
  await expect(editor).toBeFocused();
  await app.getByRole('button', { name: 'File', exact: true }).click();
  await app.getByRole('menuitem', { name: 'History…' }).click();
  await expect.poll(() => historyAsks(app)).toEqual([ask, ask]);
  await expect(app.locator('#toast')).not.toContainText('history view');
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute('aria-pressed', 'false');

  // A shell without the history view answers null: the first click says
  // so and the tile hides itself, Export closing up to the pill; the
  // menu item goes too.
  const old = await context.newPage();
  await inPlassApp(old, null);
  await old.goto('/?new=1');
  await old.getByRole('button', { name: 'History', exact: true }).click();
  await expect(old.locator('#toast')).toContainText('This Plass.app has no history view');
  await expect(old.locator('#history-tile')).toBeHidden();
  const pod = (await old.locator('#doc-pod').boundingBox())!;
  const exportTile = (await old.getByRole('button', { name: 'Export', exact: true }).boundingBox())!;
  expect(exportTile.x).toBe(pod.x + pod.width + 6);
  await old.getByRole('button', { name: 'File', exact: true }).click();
  await expect(old.getByRole('menuitem', { name: 'Open…' })).toBeVisible();
  await expect(old.getByRole('menuitem', { name: 'History…' })).toBeHidden();
  expect(await historyAsks(old)).toEqual([{ type: 'history', action: 'open', inline: await roomBox(old) }]);
});

test('the History tile toggles the History page in the room: pressed by the shell’s word alone, open with the room’s box, bounds as it changes, close, and View › History…’s toggle', async ({ page }) => {
  await inPlassApp(page);
  await page.addInitScript(() => {
    const w = window as any;
    const matchMedia = window.matchMedia.bind(window);
    w.__resolutions = [];
    w.matchMedia = (query: string) => {
      const list = matchMedia(query);
      if (query.includes('resolution')) w.__resolutions.push(list);
      return list;
    };
  });
  await openRewind(page, '= Rewind\n\nThe first version.\n');
  const tile = page.locator('#history-tile');
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  const look = () =>
    page.evaluate(() => {
      const tile = document.getElementById('history-tile')!;
      const style = getComputedStyle(tile);
      return {
        pressed: tile.getAttribute('aria-pressed'),
        color: style.color,
        background: style.backgroundColor,
        inline: document.documentElement.classList.contains('history-inline'),
        paper: getComputedStyle(document.getElementById('scroll')!).visibility,
      };
    });
  const bar = () =>
    page.evaluate(() =>
      [...document.getElementById('toolbar')!.children].map((el) => {
        const r = el.getBoundingClientRect();
        return [el.id || el.getAttribute('aria-label'), r.x, r.y, r.width, r.height];
      }),
    );
  // The looks compared at rest, not halfway through the tiles' fades.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
  // The pointer off the tile, so its look is not its hover's.
  const away = () => page.mouse.move(400, 400);
  const rest = await look();
  expect(rest).toMatchObject({ pressed: 'false', inline: false, paper: 'visible' });
  const barAtRest = await bar();
  const roomAtRest = await roomBox(page);
  // The look of the bar's tiles when active: Export's with its menu open,
  // taken now, since with the page up its press puts the page away.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exportLook = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('#toolbar [aria-label="Export"]')!);
    return { color: style.color, background: style.backgroundColor };
  });
  await page.keyboard.press('Escape');

  // The click asks, with the room's box; the tile is not pressed until the
  // shell says the page is up.
  await editor.click();
  await tile.click();
  await away();
  await expect.poll(() => historyAsks(page)).toEqual([{ type: 'history', action: 'open', inline: roomAtRest }]);
  await page.waitForTimeout(200);
  expect(await look()).toEqual(rest);

  // Up: pressed as the bar's other tiles are when active (Export's open
  // menu), the paper hidden under the page; the room and the bar where
  // they were. Nothing sent for it.
  await fire(page, 'history', { kind: 'inline', state: 'open' });
  await expect.poll(async () => (await look()).pressed).toBe('true');
  await away();
  expect(await look()).toEqual({ pressed: 'true', ...exportLook, inline: true, paper: 'hidden' });
  expect(exportLook.background).not.toBe(rest.background);
  expect(await bar()).toEqual(barAtRest);
  expect(await roomBox(page)).toEqual(roomAtRest);
  expect(await historyAsks(page)).toHaveLength(1);

  // The window grows: the room's new box goes once, coalesced to a frame.
  await page.setViewportSize({ width: 1000, height: 760 });
  await expect.poll(() => historyAsks(page)).toHaveLength(2);
  const grown = await roomBox(page);
  expect(grown.width).toBe(roomAtRest.width + 120);
  expect(grown.height).toBe(roomAtRest.height + 40);
  expect((await historyAsks(page))[1]).toEqual({ type: 'history', action: 'bounds', inline: grown });
  await page.waitForTimeout(300);
  expect(await historyAsks(page)).toHaveLength(2);

  // A zoom step, which under followZoom (the shell scales the window with
  // it) may leave the CSS box as it was: the box goes again, for the shell
  // to multiply by the new zoom. The step is the device pixel ratio's
  // change, heard on a resolution query (kept by the init script below:
  // headless Chromium's emulated scale does not fire it), which the page
  // asks again for the next step.
  const queries = await page.evaluate(() => (window as any).__resolutions.length);
  expect(queries).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__resolutions.at(-1).dispatchEvent(new Event('change')));
  await expect.poll(() => historyAsks(page)).toHaveLength(3);
  expect((await historyAsks(page))[2]).toEqual({ type: 'history', action: 'bounds', inline: grown });
  expect(await page.evaluate(() => (window as any).__resolutions.length)).toBe(queries + 1);
  await page.setViewportSize({ width: 880, height: 720 });
  await expect.poll(async () => (await historyAsks(page)).at(-1)).toEqual({ type: 'history', action: 'bounds', inline: roomAtRest });
  const settled = (await historyAsks(page)).length;

  // The tile again asks to close; pressed until the shell says it went.
  await tile.click();
  await away();
  await expect.poll(() => historyAsks(page)).toHaveLength(settled + 1);
  expect((await historyAsks(page)).at(-1)).toEqual({ type: 'history', action: 'close' });
  expect((await look()).pressed).toBe('true');
  await fire(page, 'history', { kind: 'inline', state: 'closed' });
  await expect.poll(look).toEqual(rest);
  await expect(editor).toBeFocused();

  // Down, the room's changes are nobody's business.
  await page.setViewportSize({ width: 960, height: 700 });
  await page.waitForTimeout(300);
  expect(await historyAsks(page)).toHaveLength(settled + 1);
  await page.setViewportSize({ width: 880, height: 720 });

  // View › History… (the shell's toggle): what the tile does, both ways,
  // and with a menu open it closes the menu first.
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await fire(page, 'history', { kind: 'toggle' });
  await expect.poll(async () => (await historyAsks(page)).at(-1)).toEqual({ type: 'history', action: 'open', inline: roomAtRest });
  await expect(page.getByRole('menuitem', { name: 'Open…' })).toBeHidden();
  await fire(page, 'history', { kind: 'inline', state: 'open' });
  await expect.poll(async () => (await look()).pressed).toBe('true');
  await fire(page, 'history', { kind: 'toggle' });
  await expect.poll(async () => (await historyAsks(page)).at(-1)).toEqual({ type: 'history', action: 'close' });

  // Gone by the shell's word; File › History… is the tile's call and
  // brings it back. (With the page up, File's press puts it away before
  // the menu opens: the test below.)
  await fire(page, 'history', { kind: 'inline', state: 'closed' });
  await expect.poll(look).toEqual(rest);
  const before = (await historyAsks(page)).length;
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'History…' }).click();
  await expect.poll(() => historyAsks(page)).toHaveLength(before + 1);
  expect((await historyAsks(page)).at(-1)).toEqual({ type: 'history', action: 'open', inline: roomAtRest });
  await fire(page, 'history', { kind: 'inline', state: 'open' });
  await expect.poll(async () => (await look()).pressed).toBe('true');

  // Put away from the page's side (Escape, its close tile): the word alone
  // un-presses the tile.
  await fire(page, 'history', { kind: 'inline', state: 'closed' });
  await away();
  await expect.poll(look).toEqual(rest);
  expect(await historyAsks(page)).toHaveLength(before + 1);
});

test('with the History page in the room, File, Export and the rail put it away on the press, before anything opens under it', async ({ page }) => {
  await inPlassApp(page);
  await openRewind(page, '= Rewind\n\nThe first version.\n');
  const tile = page.locator('#history-tile');
  // What is open over the room as each close goes: it must be nothing,
  // since the shell's page sits above anything this page draws there.
  await page.evaluate(() => {
    const w = window as any;
    const request = w.claerbout.request;
    w.__openAtClose = [];
    w.claerbout.request = (message: { type: string; action?: string }) => {
      if (message.type === 'history' && message.action === 'close') {
        w.__openAtClose.push([...document.querySelectorAll('.tb-menu:not([hidden]), #document-settings')].map((el) => el.id));
      }
      return request(message);
    };
  });
  const closes = () => page.evaluate(() => (window as any).__openAtClose as string[][]);
  const up = async () => {
    await tile.click();
    await fire(page, 'history', { kind: 'inline', state: 'open' });
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
  };
  const down = async () => {
    await fire(page, 'history', { kind: 'inline', state: 'closed' });
    await expect(tile).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');
  };

  // File: the close on the press, then its menu.
  await up();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(page.locator('#tb-menu-file')).toBeVisible();
  expect(await closes()).toEqual([[]]);
  await down();
  await expect(page.locator('#tb-menu-file')).toBeHidden();

  // Export, the same.
  await up();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.locator('#tb-menu-export')).toBeVisible();
  expect(await closes()).toEqual([[], []]);
  await down();

  // The rail: a flyout (Headings) and Document settings.
  await up();
  await page.getByRole('button', { name: 'Headings', exact: true }).click();
  await expect(page.locator('#tb-menu-headings')).toBeVisible();
  expect(await closes()).toEqual([[], [], []]);
  await down();
  await up();
  await page.getByRole('button', { name: 'Document settings', exact: true }).click();
  await expect(page.locator('#document-settings')).toBeVisible();
  expect(await closes()).toEqual([[], [], [], []]);
  await down();
  await expect(page.locator('#document-settings')).toHaveCount(0);

  // From the keyboard: Enter on the File tile.
  await up();
  await page.getByRole('button', { name: 'File', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#tb-menu-file')).toBeVisible();
  expect(await closes()).toHaveLength(5);
  expect((await closes())[4]).toEqual([]);
  await down();

  // The History tile is the toggle alone: one close from its press.
  await up();
  await tile.click();
  await expect.poll(closes).toHaveLength(6);
  await page.waitForTimeout(200);
  expect(await closes()).toHaveLength(6);
  await fire(page, 'history', { kind: 'inline', state: 'closed' });

  // Down, the presses send nothing.
  const asked = (await historyAsks(page)).length;
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(page.locator('#tb-menu-file')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Headings', exact: true }).click();
  await page.keyboard.press('Escape');
  expect(await historyAsks(page)).toHaveLength(asked);
});

test('with the History page in the room the document under it still answers a rewind’s save and reload', async ({ page }) => {
  await inPlassApp(page);
  await openRewind(page, '= Rewind\n\nThe first version.\n');
  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  await page.locator('#history-tile').click();
  await fire(page, 'history', { kind: 'inline', state: 'open' });
  await expect(page.locator('#history-tile')).toHaveAttribute('aria-pressed', 'true');
  await fire(page, 'save', { id: 'h1', reason: 'rewind' });
  await expect.poll(() => answers(page)).toHaveLength(1);
  expect((await answers(page))[0]).toMatchObject({ id: 'h1', ok: true });
  expect((await answers(page))[0].disk).toContain('The first version. Typed.');
  await page.evaluate(() => (window as any).__write('= Rewind\n\nThe version rewound to.\n'));
  await fire(page, 'reload', { id: 'h2', paths: [PATH], reason: 'rewind', to: SHA });
  await expect.poll(() => docText(page)).toContain('The version rewound to.');
  expect(await docText(page)).not.toContain('Typed.');
  await expect(page.locator('#history-tile')).toHaveAttribute('aria-pressed', 'true');
});
