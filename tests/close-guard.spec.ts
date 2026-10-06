// Closing a window with unsaved work (docs/CLAERBOUT-SHELL.md, "Closing
// a window"). In Plass.app the page tells the shell what closing now would
// cost (`{type: 'unsaved', unsaved, name, save, label?, detail?}`, sent
// when the values change and once after load) and answers the shell's
// `save {id, reason: 'close', choose}` (quietly, or through the first
// save's folder picker when the writer pressed Save in the shell's
// dialog); it never registers `beforeunload` there. In a browser tab
// Chrome's own "Leave site?" asks, while closing would lose work, and
// never for Plass's own update reload.
//
// The shell is a stand-in on `window.claerbout` (as in rewind.spec.ts):
// every request kept on `__shell`, the page's listeners kept so a test can
// send an event (`__fire`), and every `beforeunload` registration counted.
// The disk watcher (the file manager's 1.5 s poll) is held still, so a
// file changed under the document is met by the next write.
import { expect, test, type Page } from './fixture';

const PATH = '/Users/someone/papers/Close.typ';
const EDITOR = '.ProseMirror[contenteditable="true"]';

const inPlassApp = (page: Page, unsavedAnswer: { guarded: boolean } | null = { guarded: true }) =>
  page.addInitScript(
    ({ path, unsavedAnswer }) => {
      const w = window as any;
      w.__shell = [];
      w.__listeners = {} as Record<string, Array<(detail: unknown) => void>>;
      w.__fire = (event: string, detail: unknown) => (w.__listeners[event] ?? []).forEach((listener: (d: unknown) => void) => listener(detail));
      // The app's own registrations (Vite's dev client keeps one of its
      // own, which never asks anything).
      w.__beforeunload = 0;
      const addEventListener = window.addEventListener.bind(window);
      w.addEventListener = (type: string, ...rest: unknown[]) => {
        if (type === 'beforeunload' && /\/src\//.test(new Error().stack ?? '')) w.__beforeunload++;
        return (addEventListener as (...args: unknown[]) => void)(type, ...rest);
      };
      w.claerbout = {
        request: async (message: { type: string; name?: string }) => {
          // What the disk holds when the page answers, for the save's order.
          if (message.type === 'saved' && w.__read) w.__shell.push({ ...message, disk: await w.__read() });
          else w.__shell.push(message);
          if (message.type === 'document') return { path: message.name ? path : null };
          if (message.type === 'unsaved') return unsavedAnswer;
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
    { path: PATH, unsavedAnswer },
  );

/** The first save's folder picker, answered with an OPFS folder of the
 *  test's choosing (`__pickDir`), or refused the way `__pickError` names. */
const withFolderPicker = (page: Page) =>
  page.addInitScript(() => {
    const w = window as any;
    w.__picks = 0;
    w.showDirectoryPicker = async () => {
      w.__picks++;
      if (w.__pickError) throw new DOMException('refused', w.__pickError);
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle(w.__pickDir, { create: true });
    };
  });

/** A fresh window holding Close.typ (`text`) in its own OPFS folder. */
async function openClose(page: Page, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);
  const dirName = `close-${Math.random().toString(36).slice(2)}`;
  const opened = await page.evaluate(
    async ({ dirName, text }) => {
      const w = window as any;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(dirName, { create: true });
      const handle = await dir.getFileHandle('Close.typ', { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      w.__read = async () => {
        try {
          return await (await (await dir.getFileHandle('Close.typ')).getFile()).text();
        } catch {
          return null;
        }
      };
      w.__write = async (next: string) => {
        const out = await (await dir.getFileHandle('Close.typ', { create: true })).createWritable();
        await out.write(next);
        await out.close();
      };
      w.__remove = () => dir.removeEntry('Close.typ');
      return await w.__fm.loadHandle(handle, dir);
    },
    { dirName, text },
  );
  expect(opened).toBe(true);
}

const fresh = async (page: Page) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);
};
const typeAtEnd = async (page: Page, text: string) => {
  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
};
const reports = (page: Page) => page.evaluate(() => (window as any).__shell.filter((m: { type: string }) => m.type === 'unsaved'));
const lastReport = async (page: Page) => (await reports(page)).at(-1);
const answers = (page: Page) => page.evaluate(() => (window as any).__shell.filter((m: { type: string }) => m.type === 'saved'));
const fire = (page: Page, event: string, detail: unknown) => page.evaluate(([event, detail]) => (window as any).__fire(event, detail), [event, detail] as const);
const disk = (page: Page) => page.evaluate(() => (window as any).__read());
const dirty = (page: Page) => page.evaluate(() => (window as any).__fm.dirty as boolean);
/** The shell asks the page to save for a close; resolves to its answer. */
async function closeSave(page: Page, id: string, choose: boolean) {
  const before = (await answers(page)).length;
  await fire(page, 'save', { id, reason: 'close', choose });
  await expect.poll(async () => (await answers(page)).length, { timeout: 10_000 }).toBe(before + 1);
  return (await answers(page)).at(-1);
}

test('in Plass.app a typed never-saved document is reported unsaved, a blank one is not, and nothing registers beforeunload', async ({ page }) => {
  await inPlassApp(page);
  await fresh(page);
  // Once after load: a blank sheet loses nothing.
  await expect.poll(() => reports(page)).toEqual([{ type: 'unsaved', unsaved: false, name: 'Plass.md', save: 'choose' }]);

  await page.locator(EDITOR).click();
  await page.keyboard.type('A thought worth keeping.');
  await expect.poll(() => lastReport(page)).toEqual({ type: 'unsaved', unsaved: true, name: 'Plass.md', save: 'choose' });
  // Sent when the values change, not on every key.
  expect(await reports(page)).toHaveLength(2);

  // Emptied again: a blank sheet, though edited.
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect.poll(() => lastReport(page)).toMatchObject({ unsaved: false });
  expect(await dirty(page)).toBe(true);

  // No text, but something else on the sheet (a page break), or a setting
  // changed: not blank.
  await page.evaluate(() => {
    const v = (window as any).view;
    v.dispatch(v.state.tr.insert(0, v.state.schema.nodes.page_break.create()));
  });
  await expect.poll(() => lastReport(page)).toMatchObject({ unsaved: true });
  await page.evaluate(() => {
    const v = (window as any).view;
    v.dispatch(v.state.tr.delete(0, v.state.doc.child(0).nodeSize));
  });
  await expect.poll(() => lastReport(page)).toMatchObject({ unsaved: false });
  await page.evaluate(() => {
    const v = (window as any).view;
    v.dispatch(v.state.tr.setDocAttribute('settings', { ...v.state.doc.attrs.settings, sizePt: 14 }));
  });
  await expect.poll(() => lastReport(page)).toMatchObject({ unsaved: true });

  // The shell asks; the page never registers its own question.
  expect(await page.evaluate(() => (window as any).__beforeunload)).toBe(0);
});

test('in Plass.app a file document reports a quiet save, a conflict no save, and a file gone Save to a Folder…', async ({ page, context }) => {
  await inPlassApp(page);
  await openClose(page, '= Close\n\nThe first version.\n');
  await expect.poll(() => lastReport(page)).toEqual({ type: 'unsaved', unsaved: false, name: 'Close.typ', save: 'quiet' });

  // Typed, not yet autosaved: a quiet save can write it.
  await typeAtEnd(page, ' Typed.');
  await expect.poll(() => lastReport(page)).toEqual({ type: 'unsaved', unsaved: true, name: 'Close.typ', save: 'quiet' });
  // Autosaved: nothing to lose.
  await expect.poll(() => lastReport(page), { timeout: 5000 }).toEqual({ type: 'unsaved', unsaved: false, name: 'Close.typ', save: 'quiet' });
  expect(await disk(page)).toContain('The first version. Typed.');

  // Changed outside Plass, then typed: the write meets the change, and Save
  // is not offered — the writer settles it in the window.
  await page.evaluate(() => (window as any).__write('= Close\n\nChanged in another editor.\n'));
  await page.keyboard.type(' Again.');
  await expect.poll(() => lastReport(page), { timeout: 5000 }).toMatchObject({ unsaved: true, name: 'Close.typ', save: 'none' });
  const conflict = await lastReport(page);
  expect(conflict.detail).toContain('Close.typ was changed outside Plass');
  expect(conflict.label).toBeUndefined();
  expect(await disk(page)).toBe('= Close\n\nChanged in another editor.\n');

  // A file moved away: Save to a Folder….
  const other = await context.newPage();
  await inPlassApp(other);
  await openClose(other, '= Close\n\nThe first version.\n');
  await other.evaluate(() => (window as any).__remove());
  await typeAtEnd(other, ' Typed after it went.');
  await expect.poll(() => lastReport(other), { timeout: 5000 }).toMatchObject({ unsaved: true, name: 'Close.typ', save: 'choose', label: 'Save to a Folder…' });
  expect((await lastReport(other)).detail).toContain('Close.typ has moved or been renamed');
});

test('in Plass.app the close’s quiet save writes a file document at once, and says why it cannot for the rest', async ({ page, context }) => {
  await inPlassApp(page);
  await openClose(page, '= Close\n\nThe first version.\n');
  await typeAtEnd(page, ' Typed.');
  const asked = Date.now();
  const written = await closeSave(page, 'q1', false);
  // Inside the shell's 3 s, well before autosave's 1.2 s would have run.
  expect(Date.now() - asked).toBeLessThan(1200);
  expect(written).toMatchObject({ type: 'saved', id: 'q1', ok: true });
  expect(written.error).toBeUndefined();
  expect(written.disk).toContain('The first version. Typed.');
  expect(await dirty(page)).toBe(false);
  await expect(page.locator('#toast')).not.toContainText('Saved Close.typ');
  // Clean before the answer went: the shell's last report says so.
  expect(await lastReport(page)).toMatchObject({ unsaved: false });

  // A conflict is never written over quietly.
  await page.evaluate(() => (window as any).__write('= Close\n\nChanged in another editor.\n'));
  await page.keyboard.type(' Again.');
  const refused = await closeSave(page, 'q2', false);
  expect(refused).toMatchObject({ id: 'q2', ok: false });
  expect(refused.error).toContain('will not save over that change');
  expect(refused.disk).toBe('= Close\n\nChanged in another editor.\n');
  // The report the shell's dialog reads is the conflict's, sent first.
  expect(await lastReport(page)).toMatchObject({ unsaved: true, save: 'none' });
  // Pressing Save anyway (an older report) does not write over it either.
  expect(await closeSave(page, 'q3', true)).toMatchObject({ id: 'q3', ok: false });
  expect(await disk(page)).toBe('= Close\n\nChanged in another editor.\n');

  // No file: the quiet save cannot place it; a blank sheet loses nothing.
  const untitled = await context.newPage();
  await inPlassApp(untitled);
  await fresh(untitled);
  expect(await closeSave(untitled, 'n1', false)).toMatchObject({ id: 'n1', ok: true });
  await untitled.locator(EDITOR).click();
  await untitled.keyboard.type('Never saved.');
  expect(await closeSave(untitled, 'n2', false)).toMatchObject({ id: 'n2', ok: false, error: 'it has no file yet' });

  // A rewind's save is what it was: no file, no save.
  await fire(untitled, 'save', { id: 'r1', reason: 'rewind' });
  await expect.poll(async () => (await answers(untitled)).at(-1)).toMatchObject({ id: 'r1', ok: false, error: 'it has no file yet' });
});

test('in Plass.app the close dialog’s Save runs the first save’s folder picker, and Save to a Folder… for a file gone', async ({ page, context }) => {
  await inPlassApp(page);
  await withFolderPicker(page);
  await fresh(page);
  await page.locator(EDITOR).click();
  await page.keyboard.type('Saved on the way out.');
  const dirName = `close-pick-${Math.random().toString(36).slice(2)}`;

  // Cancelled: not saved, the window stays.
  await page.evaluate(() => ((window as any).__pickError = 'AbortError'));
  expect(await closeSave(page, 'p1', true)).toMatchObject({ id: 'p1', ok: false, error: 'it was not saved' });
  expect(await lastReport(page)).toMatchObject({ unsaved: true, save: 'choose' });

  // A picker refused for want of a user activation: said, and offered
  // again on the toast, from a click this time.
  await page.evaluate(() => ((window as any).__pickError = 'SecurityError'));
  expect(await closeSave(page, 'p2', true)).toMatchObject({ id: 'p2', ok: false, error: 'the folder picker could not open' });
  await expect(page.locator('#toast')).toContainText('Plass could not open the folder picker for Plass.md');
  await expect(page.locator('#toast .toast-action')).toHaveText('Save to a folder…');

  // Picked: the document has its file, the answer is ok.
  await page.evaluate((dirName) => {
    const w = window as any;
    w.__pickError = null;
    w.__pickDir = dirName;
  }, dirName);
  const saved = await closeSave(page, 'p3', true);
  expect(saved).toMatchObject({ id: 'p3', ok: true });
  expect(await page.evaluate(() => (window as any).__picks)).toBe(3);
  const onDisk = await page.evaluate(async (dirName) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName);
    return (await (await dir.getFileHandle('Plass.md')).getFile()).text();
  }, dirName);
  expect(onDisk).toContain('Saved on the way out.');
  expect(await page.evaluate(() => (window as any).__fm.handle?.name)).toBe('Plass.md');
  expect(await lastReport(page)).toEqual({ type: 'unsaved', unsaved: false, name: 'Plass.md', save: 'quiet' });

  // A file gone: Save to a Folder… is the same picker, and the document
  // lands in the folder chosen under its own name.
  const gone = await context.newPage();
  await inPlassApp(gone);
  await withFolderPicker(gone);
  await openClose(gone, '= Close\n\nThe first version.\n');
  await gone.evaluate(() => (window as any).__remove());
  await typeAtEnd(gone, ' Typed after it went.');
  await expect.poll(() => lastReport(gone), { timeout: 5000 }).toMatchObject({ save: 'choose', label: 'Save to a Folder…' });
  expect(await closeSave(gone, 'm1', false)).toMatchObject({ id: 'm1', ok: false, error: 'it has moved or been renamed' });
  const elsewhere = `close-elsewhere-${Math.random().toString(36).slice(2)}`;
  await gone.evaluate((dirName) => ((window as any).__pickDir = dirName), elsewhere);
  expect(await closeSave(gone, 'm2', true)).toMatchObject({ id: 'm2', ok: true });
  const moved = await gone.evaluate(async (dirName) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName);
    return (await (await dir.getFileHandle('Close.typ')).getFile()).text();
  }, elsewhere);
  expect(moved).toContain('Typed after it went.');
});

test('in Plass.app an older shell’s null answer stops the reports, and the page still registers no beforeunload', async ({ page }) => {
  await inPlassApp(page, null);
  await fresh(page);
  await expect.poll(() => reports(page)).toHaveLength(1);
  await page.locator(EDITOR).click();
  await page.keyboard.type('Typed under an older shell.');
  await expect.poll(() => dirty(page)).toBe(true);
  await page.waitForTimeout(300);
  expect(await reports(page)).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).__beforeunload)).toBe(0);
  // The shell closes it as it always did: nothing in the page holds it.
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(dialogs).toEqual([]);
});

test('in a browser tab Chrome asks before leaving only while closing would lose work, and not for Plass’s own update reload', async ({ context }) => {
  const dialogsOf = (page: Page) => {
    const seen: string[] = [];
    page.on('dialog', (dialog) => {
      seen.push(dialog.type());
      void dialog.dismiss();
    });
    return seen;
  };

  // A blank sheet, clicked (Chrome asks only a page the user has touched):
  // it closes.
  const blank = await context.newPage();
  const blankDialogs = dialogsOf(blank);
  await fresh(blank);
  await blank.locator(EDITOR).click();
  await blank.close({ runBeforeUnload: true });
  await expect.poll(() => blank.isClosed()).toBe(true);
  expect(blankDialogs).toEqual([]);

  // Typed: Chrome's "Leave site?"; dismissed, the tab stays.
  const typed = await context.newPage();
  const typedDialogs = dialogsOf(typed);
  await fresh(typed);
  await typed.locator(EDITOR).click();
  await typed.keyboard.type('Worth a question.');
  await typed.close({ runBeforeUnload: true });
  await expect.poll(() => typedDialogs).toEqual(['beforeunload']);
  await typed.waitForTimeout(300);
  expect(typed.isClosed()).toBe(false);
  // Emptied again: nothing to lose, no question.
  await typed.keyboard.press('ControlOrMeta+a');
  await typed.keyboard.press('Backspace');
  await typed.close({ runBeforeUnload: true });
  await expect.poll(() => typed.isClosed()).toBe(true);
  expect(typedDialogs).toEqual(['beforeunload']);

  // A file document, autosaved: nothing to lose.
  const filed = await context.newPage();
  const filedDialogs = dialogsOf(filed);
  await openClose(filed, '= Close\n\nThe first version.\n');
  await typeAtEnd(filed, ' Typed.');
  await expect.poll(() => dirty(filed), { timeout: 5000 }).toBe(false);
  await filed.close({ runBeforeUnload: true });
  await expect.poll(() => filed.isClosed()).toBe(true);
  expect(filedDialogs).toEqual([]);

  // Plass's own reload after a deploy (a lazy chunk that 404s): no
  // question, and the session copy comes back, still unsaved.
  const updated = await context.newPage();
  const updatedDialogs = dialogsOf(updated);
  await fresh(updated);
  await updated.locator(EDITOR).click();
  await updated.keyboard.type('Kept across the update.');
  await expect.poll(() => dirty(updated)).toBe(true);
  await Promise.all([updated.waitForEvent('load'), updated.evaluate(() => window.dispatchEvent(new Event('vite:preloadError')))]);
  await updated.waitForFunction(() => !!(window as any).__fm);
  await expect(updated.locator('.ProseMirror[contenteditable="true"]')).toContainText('Kept across the update.');
  expect(await dirty(updated)).toBe(true);
  expect(updatedDialogs).toEqual([]);
});

test('in Plass.app ⌘R keeps a never-saved document unsaved: the dot, and the close’s question', async ({ page }) => {
  await inPlassApp(page);
  await fresh(page);
  await page.locator(EDITOR).click();
  await page.keyboard.type('Typed before the reload.');
  await expect(page).toHaveTitle('Plass.md •');

  await page.reload();
  await page.waitForFunction(() => !!(window as any).__fm);
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText('Typed before the reload.');
  expect(await dirty(page)).toBe(true);
  await expect(page).toHaveTitle('Plass.md •');
  // The reloaded page's first report says so.
  await expect.poll(async () => (await reports(page))[0]).toEqual({ type: 'unsaved', unsaved: true, name: 'Plass.md', save: 'choose' });
  expect(await closeSave(page, 'k1', false)).toMatchObject({ id: 'k1', ok: false, error: 'it has no file yet' });

  // A new sheet over it (its "unsaved changes" question answered yes),
  // then reloaded: clean, and the bit with it.
  page.once('dialog', (dialog) => void dialog.accept());
  expect(await page.evaluate(() => (window as any).__fm.newDoc())).toBe(true);
  await expect.poll(() => dirty(page)).toBe(false);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__fm);
  expect(await dirty(page)).toBe(false);
  await expect(page).toHaveTitle('Plass.md');
});
