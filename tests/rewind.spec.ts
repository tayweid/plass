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

const inPlassApp = (page: Page, historyAnswer: { opened: boolean } | null = { opened: true }) =>
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

test('File › History… asks Plass.app for the History window, and is not in a browser tab', async ({ page, context }) => {
  // A browser tab: no shell, no item.
  await page.goto('/?new=1');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Open…' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'History…' })).toHaveCount(0);

  // Plass.app: the item, with the shell's View-menu keys beside it.
  const app = await context.newPage();
  await inPlassApp(app);
  await app.goto('/?new=1');
  await app.getByRole('button', { name: 'File', exact: true }).click();
  const item = app.getByRole('menuitem', { name: 'History…' });
  await expect(item).toBeVisible();
  await expect(item.locator('kbd')).toHaveText('⇧⌘H');
  await item.click();
  await expect.poll(() => app.evaluate(() => (window as any).__shell.filter((m: { type: string }) => m.type === 'history'))).toEqual([{ type: 'history', action: 'open' }]);
  await expect(app.locator('#toast')).not.toContainText('history view');

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

const historyAsks = (page: Page) => page.evaluate(() => (window as any).__shell.filter((m: { type: string }) => m.type === 'history'));

test('the History tile beside the name asks Plass.app for the History window as File › History… does, and is not in a browser tab', async ({ page, context }) => {
  // A browser tab: no shell, no tile.
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);
  await expect(page.locator('#doc-pod')).toBeVisible();
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);

  // Plass.app: the tile, its caption on hover, and a click sends the
  // request the menu item sends, the same one: the item after it adds a
  // second, identical.
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
  await expect.poll(() => historyAsks(app)).toEqual([{ type: 'history', action: 'open' }]);
  await expect(editor).toBeFocused();
  await app.getByRole('button', { name: 'File', exact: true }).click();
  await app.getByRole('menuitem', { name: 'History…' }).click();
  await expect.poll(() => historyAsks(app)).toEqual([{ type: 'history', action: 'open' }, { type: 'history', action: 'open' }]);
  await expect(app.locator('#toast')).not.toContainText('history view');
  await expect(tile).toBeVisible();

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
  expect(await historyAsks(old)).toEqual([{ type: 'history', action: 'open' }]);
});
