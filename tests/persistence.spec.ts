import { expect, test } from './fixture';
import { settleLocal } from './settle';

test('autosave pauses instead of overwriting an externally changed file', async ({ page }) => {
  await page.goto('/?new=1');
  const dirName = `plass-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const beforeResolution = await page.evaluate(async (name) => {
    const app = window as typeof window & {
      view: import('prosemirror-view').EditorView;
      __fm: {
        adoptFolder(dir: FileSystemDirectoryHandle, intent: 'save'): Promise<unknown>;
        handle: FileSystemFileHandle | null;
        hasConflict: boolean;
        dirty: boolean;
      };
    };
    const setText = (text: string) => {
      const { state } = app.view;
      const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(text));
      app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
    };

    setText('baseline editor content');
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(name, { create: true });
    await app.__fm.adoptFolder(dir, 'save');
    const handle = app.__fm.handle!;

    const external = await handle.createWritable();
    await external.write('EXTERNAL VERSION — DO NOT OVERWRITE');
    await external.close();

    setText('my newer editor content');
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    return {
      disk: await (await handle.getFile()).text(),
      conflict: app.__fm.hasConflict,
      dirty: app.__fm.dirty,
    };
  }, dirName);

  expect(beforeResolution.disk).toBe('EXTERNAL VERSION — DO NOT OVERWRITE');
  expect(beforeResolution.conflict).toBe(true);
  expect(beforeResolution.dirty).toBe(true);
  await expect(page.locator('#toast')).toContainText('changed outside Plass');
  await expect(page.locator('#toast .toast-action')).toHaveText('Overwrite disk');

  await page.locator('#toast .toast-action').click();
  await expect.poll(async () =>
    page.evaluate(async (name) => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(name);
        const handle = await dir.getFileHandle('Plass.typ');
        return await (await handle.getFile()).text();
      } catch {
        return '';
      }
    }, dirName),
  ).toContain('my newer editor content');
  expect(await page.evaluate(() => (window as typeof window & { __fm: { hasConflict: boolean } }).__fm.hasConflict)).toBe(false);
});

test('an edit made during a slow write remains dirty and is saved next', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const app = window as typeof window & {
      view: import('prosemirror-view').EditorView;
      __fm: {
        loadHandle(handle: FileSystemFileHandle): Promise<boolean>;
        dirty: boolean;
      };
    };
    let current = 'initial\n';
    let pending = current;
    let writeStarts = 0;
    const handle = {
      kind: 'file',
      name: 'race.typ',
      async getFile() {
        return new File([current], 'race.typ', { type: 'text/plain', lastModified: Date.now() });
      },
      async createWritable() {
        return {
          async write(value: string | Blob) {
            writeStarts++;
            await new Promise((resolve) => setTimeout(resolve, 300));
            pending = value instanceof Blob ? await value.text() : String(value);
          },
          async close() {
            current = pending;
          },
        };
      },
    } as unknown as FileSystemFileHandle;

    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (!/Could not (?:update recents|persist file handle)/.test(String(args[0]))) originalWarn(...args);
    };
    await app.__fm.loadHandle(handle);
    console.warn = originalWarn;
    const setText = (text: string) => {
      const { state } = app.view;
      const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(text));
      app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
    };
    setText('first snapshot');
    for (let i = 0; i < 100 && writeStarts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    setText('second snapshot');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return { current, writeStarts, dirty: app.__fm.dirty };
  });

  expect(result.writeStarts).toBe(2);
  expect(result.current).toContain('second snapshot');
  expect(result.dirty).toBe(false);
});

test('starting a new document cannot silently discard dirty work', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text('keep this work'));
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
  });

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('unsaved changes');
    await dialog.dismiss();
  });
  const started = await page.evaluate(() =>
    (window as typeof window & { __fm: { newDoc(): boolean } }).__fm.newDoc(),
  );
  expect(started).toBe(false);
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText('keep this work');
});

test('an immediate reload preserves the latest editor snapshot', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text('last instant edit'));
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
  });
  // Reload immediately, before the normal 400 ms session debounce.
  await page.reload();
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText('last instant edit');
});

test('a referenced image reloads after its project file changes', async ({ page }) => {
  await page.goto('/?new=1');
  const dirName = `plass-asset-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const assetPath = 'figures/live-preview.svg';
  const svg = (color: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="${color}"/></svg>`;

  await page.evaluate(async ({ name, path, svg }) => {
    const app = window as typeof window & {
      view: import('prosemirror-view').EditorView;
      __fm: {
        adoptFolder(dir: FileSystemDirectoryHandle, intent: 'save'): Promise<unknown>;
        writeAsset(path: string, data: Blob): Promise<boolean>;
      };
    };
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(name, { create: true });
    await app.__fm.adoptFolder(dir, 'save');
    if (!await app.__fm.writeAsset(path, new Blob([svg], { type: 'image/svg+xml' }))) {
      throw new Error('could not create watched image');
    }
    const { state } = app.view;
    const figure = state.schema.nodes.figure.create({ src: path, name: 'live-preview.svg' });
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, figure));
  }, { name: dirName, path: assetPath, svg: svg('red') });

  const image = page.locator('.ts-figure > img');
  await expect(image).toHaveAttribute('src', /^blob:/);
  const firstUrl = await image.getAttribute('src');

  // File timestamps are the cache key. Leave a small gap so even a coarse
  // filesystem clock records this as a different version.
  await page.waitForTimeout(100);
  await page.evaluate(async ({ path, svg }) => {
    const fm = (window as typeof window & {
      __fm: { writeAsset(path: string, data: Blob): Promise<boolean> };
    }).__fm;
    if (!await fm.writeAsset(path, new Blob([svg], { type: 'image/svg+xml' }))) {
      throw new Error('could not update watched image');
    }
  }, { path: assetPath, svg: svg('blue') });

  // The production watcher polls every four seconds in browsers where a
  // native filesystem observer is unavailable.
  await expect.poll(() => image.getAttribute('src'), { timeout: 7_000 }).not.toBe(firstUrl);
});

test('project image cache never crosses directory boundaries', async ({ page }) => {
  await page.goto('/?new=1');
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const assetPath = 'figures/shared.svg';
  const svg = (color: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="${color}"/></svg>`;

  const firstMtime = await page.evaluate(async ({ aName, bName, path, red, tan }) => {
    const app = window as typeof window & {
      view: import('prosemirror-view').EditorView;
      __fm: {
        adoptFolder(dir: FileSystemDirectoryHandle, intent: 'save'): Promise<unknown>;
        statAsset(path: string): Promise<{ mtime: number; size: number; type: string } | null>;
        writeAsset(path: string, data: Blob): Promise<boolean>;
      };
    };
    const root = await navigator.storage.getDirectory();
    const a = await root.getDirectoryHandle(aName, { create: true });
    const b = await root.getDirectoryHandle(bName, { create: true });

    // Prepare B before it becomes active so the watcher can never observe an
    // intermediate missing file and accidentally invalidate A's old cache.
    const bFigures = await b.getDirectoryHandle('figures', { create: true });
    const bFile = await bFigures.getFileHandle('shared.svg', { create: true });
    const bWriter = await bFile.createWritable();
    await bWriter.write(new Blob([tan], { type: 'image/svg+xml' }));
    await bWriter.close();

    await app.__fm.adoptFolder(a, 'save');
    if (!await app.__fm.writeAsset(path, new Blob([red], { type: 'image/svg+xml' }))) {
      throw new Error('could not create the first project image');
    }
    const stat = await app.__fm.statAsset(path);
    if (!stat) throw new Error('could not stat the first project image');
    const { state } = app.view;
    const figure = state.schema.nodes.figure.create({ src: path, name: 'shared.svg' });
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, figure));

    (window as typeof window & { __assetDirs: { a: FileSystemDirectoryHandle; b: FileSystemDirectoryHandle } }).__assetDirs = { a, b };
    return stat.mtime;
  }, {
    aName: `plass-asset-scope-a-${suffix}`,
    bName: `plass-asset-scope-b-${suffix}`,
    path: assetPath,
    red: svg('red'),
    tan: svg('tan'),
  });

  const image = page.locator('.ts-figure > img');
  await expect(image).toHaveAttribute('src', /^blob:/);
  const firstUrl = await image.getAttribute('src');
  expect(firstUrl).not.toBeNull();
  const renderedPixel = () => image.evaluate(async (element) => {
    const img = element as HTMLImageElement;
    try {
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) return [];
      context.drawImage(img, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    } catch {
      return [];
    }
  });
  await expect.poll(renderedPixel).toEqual([255, 0, 0, 255]);

  await page.evaluate(async ({ path, mtime }) => {
    const app = window as typeof window & {
      __assetDirs: { b: FileSystemDirectoryHandle };
      __fm: {
        adoptFolder(dir: FileSystemDirectoryHandle, intent: 'save'): Promise<unknown>;
        statAsset(path: string): Promise<{ mtime: number; size: number; type: string } | null>;
      };
    };
    const originalStat = app.__fm.statAsset.bind(app.__fm);
    app.__fm.statAsset = async (candidate: string) => {
      const stat = await originalStat(candidate);
      return stat && candidate === path ? { ...stat, mtime } : stat;
    };
    await app.__fm.adoptFolder(app.__assetDirs.b, 'save');
    // Drive the app's registered watcher. Importing figures.ts here creates
    // a second module instance whose refresh hook has never been wired.
    window.dispatchEvent(new Event('focus'));
  }, { path: assetPath, mtime: firstMtime });

  await expect.poll(() => image.getAttribute('src'), { timeout: 2_000 }).not.toBe(firstUrl);
  await expect.poll(renderedPixel).toEqual([210, 180, 140, 255]);
  expect(await page.evaluate(async (url) => {
    return new Promise<boolean>((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(false);
      probe.onerror = () => resolve(true);
      probe.src = url!;
    });
  }, firstUrl)).toBe(true);
});

test('reconnecting a recovered session never guesses past a differing disk copy', async ({ page }) => {
  await page.goto('/');
  const dirName = `plass-reconnect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.evaluate(async (name) => {
    const app = window as typeof window & {
      view: import('prosemirror-view').EditorView;
      __fm: {
        adoptFolder(dir: FileSystemDirectoryHandle, intent: 'save'): Promise<unknown>;
        handle: FileSystemFileHandle | null;
      };
    };
    const setText = (text: string) => {
      const { state } = app.view;
      const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(text));
      app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
    };
    setText('saved baseline');
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(name, { create: true });
    await app.__fm.adoptFolder(dir, 'save');
    setText('recovered editor version');
    const external = await app.__fm.handle!.createWritable();
    await external.write('EXTERNAL RECONNECT VERSION');
    await external.close();
  }, dirName);

  await page.reload();
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText('recovered editor version');
  await expect.poll(() =>
    page.evaluate(() => (window as typeof window & { __fm: { hasConflict: boolean } }).__fm.hasConflict),
  ).toBe(true);
  const disk = await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(name);
    return (await (await dir.getFileHandle('Plass.typ')).getFile()).text();
  }, dirName);
  expect(disk).toBe('EXTERNAL RECONNECT VERSION');
});

test('a fresh document names the tab after the app', async ({ page }) => {
  // The tab is how you find Plass among a dozen others, so an untouched
  // document should say which app it is rather than that it has no name.
  // Matches Knuth, whose tab reads Knuth.py for the same reason.
  await page.goto('/');
  await expect(page).toHaveTitle('Plass.typ');
  await expect(page.locator('#file-name')).toHaveText('Plass');
});

test('an untouched document downloads under the app name', async ({ page }) => {
  // It used to export as document.typ, from when the default name was a
  // placeholder. Plass is a name, so the file carries it like any other.
  await page.goto('/');
  const download = page.waitForEvent('download');
  await page.evaluate(() => {
    const fm = (window as typeof window & { __fm: { exportCopy(): void } }).__fm;
    fm.exportCopy();
  });
  expect((await download).suggestedFilename()).toBe('Plass.typ');
});

test('a new document can be named on its first save', async ({ page }) => {
  // The picker cannot open headless; record the name the save would have used.
  await page.addInitScript(() => {
    (window as any).__pickedWith = null;
    (window as any).showDirectoryPicker = async () => {
      (window as any).__pickedWith = (window as any).__fm?.name ?? null;
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    };
  });
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);

  const chip = page.locator('#file-name');
  await expect(chip).toHaveText('Plass');
  await chip.click();
  await page.keyboard.type('MiniExam');
  await page.keyboard.press('Enter');

  await expect.poll(() => page.evaluate(() => (window as any).__pickedWith)).toBe('MiniExam');
  expect(await page.evaluate(() => (window as any).__fm.name)).toBe('MiniExam');
  await expect(chip).toHaveText('MiniExam');
});

test('Escape backs out of naming without saving', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__pickedWith = null;
    (window as any).showDirectoryPicker = async () => {
      (window as any).__pickedWith = (window as any).__fm?.name ?? null;
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    };
  });
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);

  const chip = page.locator('#file-name');
  await chip.click();
  await page.keyboard.type('Discarded');
  await page.keyboard.press('Escape');

  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__pickedWith)).toBeNull();
  expect(await page.evaluate(() => (window as any).__fm.name)).toBe('Plass');
  await expect(chip).toHaveText('Plass');
});

test('renaming a Markdown document keeps it Markdown', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);

  const out = await page.evaluate(async () => {
    const app = window as typeof window & {
      view: import('prosemirror-view').EditorView;
      __fm: {
        loadHandle(handle: FileSystemFileHandle, dir: FileSystemDirectoryHandle): Promise<boolean>;
        rename(name: string): Promise<void>;
        handle: FileSystemFileHandle;
      };
    };
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`rn-${Math.random().toString(36).slice(2)}`, { create: true });
    const handle = await dir.getFileHandle('Block_Outline.md', { create: true });
    const writable = await handle.createWritable();
    await writable.write('# Microeconomics Outline\n\nPart A / Coordination\n');
    await writable.close();

    await app.__fm.loadHandle(handle, dir);
    await app.__fm.rename('Block_Outline_2');

    // An edit after the rename must still be written as Markdown: renaming a
    // .md file to .typ left its Markdown bytes behind a Typst extension, and
    // reopening turned every heading into a raw island.
    const { state } = app.view;
    app.view.dispatch(state.tr.insertText('Extra. ', 1));
    await new Promise((resolve) => setTimeout(resolve, 1_700));

    const names: string[] = [];
    for await (const key of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(key);
    return { names, name: app.__fm.handle.name, bytes: await (await app.__fm.handle.getFile()).text() };
  });

  expect(out.name).toBe('Block_Outline_2.md');
  expect(out.names).toEqual(['Block_Outline_2.md']);
  expect(out.bytes).toContain('Extra.');
  expect(out.bytes).toMatch(/^# .*Microeconomics Outline/m); // a Markdown heading
  expect(out.bytes).not.toContain('#set page'); // not a Typst preamble
});

test('a second window refuses a file the first already has open', async ({ context }) => {
  const dirName = `win-${Math.random().toString(36).slice(2)}`;
  const seed = async (page: import('playwright/test').Page) => {
    await page.goto('/?new=1');
    await page.waitForFunction(() => !!(window as any).__fm);
  };

  const a = await context.newPage();
  await seed(a);
  const openedA = await a.evaluate(async (dirName) => {
    const fm = (window as any).__fm;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName, { create: true });
    const h = await dir.getFileHandle('Shared.typ', { create: true });
    const w = await h.createWritable();
    await w.write('= Shared\n');
    await w.close();
    return await fm.loadHandle(h, dir);
  }, dirName);
  expect(openedA).toBe(true);

  const b = await context.newPage();
  await seed(b);
  const openedB = await b.evaluate(async (dirName) => {
    const fm = (window as any).__fm;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName);
    const h = await dir.getFileHandle('Shared.typ');
    return await fm.loadHandle(h, dir);
  }, dirName);

  expect(openedB).toBe(false);
  await expect(b.locator('#toast')).toContainText('already open in another Plass window');
  expect(await b.evaluate(() => (window as any).__fm.handle)).toBeNull();
  // The escape hatch still works.
  await b.locator('#toast .toast-action').click();
  await expect.poll(() => b.evaluate(() => (window as any).__fm.handle?.name ?? null)).toBe('Shared.typ');
});

/** The page inside Plass.app, as far as these tests need it: the shell's
 *  bridge is present (every request is kept on `__shell`; `focus` is
 *  answered as given, null being an older shell's answer to anything it
 *  does not know), and window.close() is recorded instead of done. */
const inPlassApp = (page: import('playwright/test').Page, focusAnswer: { focused: boolean } | null) =>
  page.addInitScript((answer) => {
    const w = window as any;
    w.__shell = [];
    w.claerbout = {
      request: async (message: { type: string }) => {
        w.__shell.push(message);
        if (message.type !== 'focus') return null;
        // As slow as fronting a minimized window: the shell restores it first.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return answer;
      },
      on: () => () => {},
    };
    w.__closed = false;
    w.close = () => {
      w.__closed = true;
    };
  }, focusAnswer);

/** Window A holds Shared.typ in a folder; a fresh window B, with no file. */
const twoAppWindows = async (context: import('playwright/test').BrowserContext, focusAnswer: { focused: boolean } | null) => {
  const dirName = `launch-${Math.random().toString(36).slice(2)}`;
  const a = await context.newPage();
  await inPlassApp(a, focusAnswer);
  await a.goto('/?new=1');
  await a.waitForFunction(() => !!(window as any).__fm);
  const openedA = await a.evaluate(async (dirName) => {
    const fm = (window as any).__fm;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName, { create: true });
    const h = await dir.getFileHandle('Shared.typ', { create: true });
    const w = await h.createWritable();
    await w.write('= Shared\n');
    await w.close();
    return await fm.loadHandle(h, dir);
  }, dirName);
  expect(openedA).toBe(true);
  const b = await context.newPage();
  await inPlassApp(b, focusAnswer);
  await b.goto('/?new=1');
  await b.waitForFunction(() => !!(window as any).__openLaunched);
  return { a, b, dirName };
};

/** Finder opens Shared.typ: the shell has dropped it on window B. */
const launchIn = (b: import('playwright/test').Page, dirName: string) =>
  b.evaluate(async (dirName) => {
    const w = window as any;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName);
    const h = await dir.getFileHandle('Shared.typ');
    await w.__openLaunched([h]);
    return { closed: w.__closed as boolean, holdsNothing: w.__fm.handle === null, toast: document.getElementById('toast')?.textContent ?? '' };
  }, dirName);

const focusRequests = (page: import('playwright/test').Page) =>
  page.evaluate(() => (window as any).__shell.filter((m: { type: string }) => m.type === 'focus').length);

test('in Plass.app a launch of a file another window holds fronts that window and closes this one', async ({ context }) => {
  // Finder opens a file Plass.app already shows: the shell lands a new
  // window on it, the window that has it asks the shell to front it, and
  // the new window goes away instead of showing a toast on a blank sheet.
  const { a, b, dirName } = await twoAppWindows(context, { focused: true });
  const launched = await launchIn(b, dirName);
  expect(launched.closed).toBe(true);
  expect(launched.holdsNothing).toBe(true);
  expect(launched.toast).not.toContain('already open');
  expect(await focusRequests(a)).toBe(1);

  // Open… in a window asks nobody to come forward: this window may hold a
  // document of its own, so the toast stays the answer there.
  const opened = await b.evaluate(async (dirName) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName);
    return await (window as any).__fm.loadHandle(await dir.getFileHandle('Shared.typ'), dir);
  }, dirName);
  expect(opened).toBe(false);
  await expect(b.locator('#toast')).toContainText('already open in another Plass window');
  expect(await focusRequests(a)).toBe(1);
});

test('under a shell without the focus request the launch window keeps the toast', async ({ context }) => {
  // Plass.app on a shell older than 0.2.1: the holder asks and is answered
  // null, so it is not fronted and the launch window cannot leave the file
  // to it. It says where the file is and leaves the way through, as Open…
  // does.
  const { a, b, dirName } = await twoAppWindows(context, null);
  const launched = await launchIn(b, dirName);
  expect(launched.closed).toBe(false);
  expect(launched.holdsNothing).toBe(true);
  expect(launched.toast).toContain('already open in another Plass window');
  expect(await focusRequests(a)).toBe(1);
  await b.locator('#toast .toast-action').click();
  await expect.poll(() => b.evaluate(() => (window as any).__fm.handle?.name ?? null)).toBe('Shared.typ');
});

test('a file renamed outside Plass stops autosave and says so', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);
  await page.evaluate(async () => {
    const fm = (window as any).__fm;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`mv-${Math.random().toString(36).slice(2)}`, { create: true });
    const h = await dir.getFileHandle('Outline.typ', { create: true });
    const w = await h.createWritable();
    await w.write('= Outline\n');
    await w.close();
    await fm.loadHandle(h, dir);
    // Renamed in Finder: the handle no longer resolves to a file.
    await (await dir.getFileHandle('Outline.typ')).move('Outline_2.typ');
  });

  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Edited. ', 1));
  });

  await expect(page.locator('#toast')).toContainText('has moved or been renamed', { timeout: 10_000 });
  expect(await page.evaluate(() => (window as any).__fm.dirty)).toBe(true);
});

test('a reloaded window comes back to its own file, not an untitled sheet', async ({ page }) => {
  // A "New" window is secondary, so it never restored the origin-wide "last"
  // record — the same position an app window is in after a Finder launch.
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);

  const dirName = `rl-${Math.random().toString(36).slice(2)}`;
  await page.evaluate(async (dirName) => {
    const fm = (window as any).__fm;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName, { create: true });
    const h = await dir.getFileHandle('Block_Outline.typ', { create: true });
    const w = await h.createWritable();
    await w.write('= Microeconomics Outline\n\nPart A.\n');
    await w.close();
    await fm.loadHandle(h, dir);
  }, dirName);

  expect(await page.evaluate(() => (window as any).__fm.name)).toBe('Block_Outline');
  await expect(page.locator('#file-name')).toHaveText('Block_Outline');

  await page.reload();
  await page.waitForFunction(() => !!(window as any).__fm);

  await expect.poll(() => page.evaluate(() => (window as any).__fm.name)).toBe('Block_Outline');
  await expect(page.locator('#file-name')).toHaveText('Block_Outline');
  expect(await page.evaluate(() => (window as any).__fm.handle?.name ?? null)).toBe('Block_Outline.typ');
  expect(await page.evaluate(() => (window as any).__fm.dir?.name ?? null)).toBe(dirName);
});

test('the folder grant opens where the document already lives', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__pickedStartIn = 'unset';
    (window as any).showDirectoryPicker = async (opts: any) => {
      (window as any).__pickedStartIn = opts?.startIn?.name ?? null;
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    };
  });
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as any).__fm);

  await page.evaluate(async () => {
    const fm = (window as any).__fm;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`si-${Math.random().toString(36).slice(2)}`, { create: true });
    const h = await dir.getFileHandle('Launched.typ', { create: true });
    const w = await h.createWritable();
    await w.write('= Launched\n');
    await w.close();
    // A Finder launch delivers a bare handle with no folder.
    await fm.loadHandle(h, null);
    await fm.attachFolder();
  });

  // Chrome opens the dialog in the folder holding this file, not a default.
  expect(await page.evaluate(() => (window as any).__pickedStartIn)).toBe('Launched.typ');
});

for (const verdict of ['prompt', 'denied'] as const) {
  test(`a reloaded window keeps its file's name when permission is ${verdict}`, async ({ page }) => {
    await page.goto('/?new=1');
    await page.waitForFunction(() => !!(window as any).__fm);
    await page.evaluate(async () => {
      const fm = (window as any).__fm;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(`pm-${Math.random().toString(36).slice(2)}`, { create: true });
      const h = await dir.getFileHandle('Block_Outline.typ', { create: true });
      const w = await h.createWritable();
      await w.write('= Outline\n');
      await w.close();
      await fm.loadHandle(h, dir);
    });
    await page.waitForTimeout(500);

    // On reload the browser has not carried the write grant over — which is
    // what a file-handler launch gives you, and what used to make a refresh
    // silently rename the document to an untitled sheet.
    await page.addInitScript((verdict) => {
      const proto = (self as any).FileSystemHandle?.prototype;
      if (proto) proto.queryPermission = async () => verdict;
    }, verdict);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__fm);

    await expect.poll(() => page.evaluate(() => (window as any).__fm.name)).toBe('Block_Outline');
    await expect(page.locator('#file-name')).toHaveText('Block_Outline');
  });
}

test('a clean document hot-reloads an external change to its file', async ({ page }) => {
  await page.goto('/?new=1');
  const dirName = `plass-hot-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await page.evaluate(async (name) => {
    const app = window as typeof window & {
      view: import('prosemirror-view').EditorView;
      __fm: {
        adoptFolder(dir: FileSystemDirectoryHandle, intent: 'save'): Promise<unknown>;
        handle: FileSystemFileHandle | null;
      };
    };
    const { state } = app.view;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text('baseline editor content'));
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(name, { create: true });
    await app.__fm.adoptFolder(dir, 'save');

    // Another writer replaces the file while the editor copy is clean.
    const external = await app.__fm.handle!.createWritable();
    await external.write('hot reloaded from disk');
    await external.close();
  }, dirName);

  await expect(page.locator('#toast')).toContainText('changed on disk — reloaded', { timeout: 10_000 });
  await expect.poll(() =>
    page.evaluate(() => {
      const app = window as typeof window & {
        view: import('prosemirror-view').EditorView;
        __fm: { dirty: boolean; hasConflict: boolean };
      };
      return {
        text: app.view.state.doc.textContent,
        dirty: app.__fm.dirty,
        conflict: app.__fm.hasConflict,
      };
    }),
  ).toEqual({ text: 'hot reloaded from disk', dirty: false, conflict: false });
});

test('an opened .md file shows .md in the window title', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as { __fm?: unknown }).__fm));
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('Notes.md', { create: true });
    const w = await h.createWritable();
    await w.write('# Hello\n\nA paragraph.\n');
    await w.close();
    const fm = (window as unknown as { __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> } }).__fm;
    await fm.loadHandle(h);
  });
  await expect(page).toHaveTitle('Notes.md');
});

// A Markdown file's `bibliography:` names a .bib beside it (plan step 7):
// read once the folder is there, put in the document — with a bibliography
// block at the end when it has none, so the page prints the references and
// Typst finds the keys — and embedded by the next save as a {=bibtex} block
// in place of the key. Without the folder nothing is read and a save keeps
// the line, so nothing is lost.
type SidecarApp = typeof window & {
  view: import('prosemirror-view').EditorView;
  __fm: {
    loadHandle(h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null): Promise<boolean>;
    attachFolder(): Promise<boolean>;
    save(): Promise<void>;
    pendingBibliography: string | null;
    handle: FileSystemFileHandle | null;
    dirty: boolean;
  };
  __sourceView: { enter(): Promise<void> | void; exit(): Promise<void> | void };
  __audit: () => Promise<unknown>;
};
type Page = import('playwright/test').Page;

const ARROW = '@book{arrow1951, title={Social Choice and Individual Values}, author={Arrow, Kenneth J.}, year={1951}}\n';

/** A folder in the origin's private file system holding `files`. */
async function seedFolder(page: Page, prefix: string, files: Record<string, string>): Promise<string> {
  const dirName = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.evaluate(
    async ([name, entries]) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(name, { create: true });
      for (const [file, text] of Object.entries(entries)) {
        const w = await (await dir.getFileHandle(file, { create: true })).createWritable();
        await w.write(text);
        await w.close();
      }
    },
    [dirName, files] as const,
  );
  return dirName;
}

/** The document's top-level block kinds, and whether the references list is painted. */
const blocksAndList = (page: Page) =>
  page.evaluate(() => {
    const app = window as SidecarApp;
    const kinds: string[] = [];
    app.view.state.doc.forEach((n) => kinds.push(n.type.name));
    return { kinds, painted: document.querySelectorAll('#editor [data-bib-sig]').length };
  });

/** Opening and closing the source view with no edit is the identity, and no edit. */
async function sourceTripIsIdentity(page: Page): Promise<void> {
  const trip = await page.evaluate(async () => {
    const app = window as SidecarApp;
    const before = JSON.stringify(app.view.state.doc.toJSON());
    await app.__sourceView.enter();
    await app.__sourceView.exit();
    return { same: JSON.stringify(app.view.state.doc.toJSON()) === before, dirty: app.__fm.dirty };
  });
  expect(trip).toEqual({ same: true, dirty: false });
}

test('a bibliography: sidecar is read once the folder is attached, and the save embeds it', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as { __fm?: unknown }).__fm));
  const dirName = await seedFolder(page, 'plass-sidecar', {
    'refs.bib': ARROW,
    'Paper.md': '---\ntitle: Paper\nbibliography: refs.bib\n---\n\nArrow [@arrow1951] started it.\n',
  });

  const opened = await page.evaluate(async (name) => {
    const app = window as SidecarApp;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    // A launched file: a handle and no folder.
    await app.__fm.loadHandle(await dir.getFileHandle('Paper.md'));
    return { bib: app.view.state.doc.attrs.bib, pending: app.__fm.pendingBibliography };
  }, dirName);
  expect(opened.bib).toBeNull();
  expect(opened.pending).toBe('refs.bib');
  await expect(page.locator('#toast')).toContainText('its bibliography is refs.bib');

  // With no folder, a save keeps the key (and writes no bibliography).
  const unread = await page.evaluate(async () => {
    const app = window as SidecarApp;
    const end = app.view.state.doc.content.size - 1;
    app.view.dispatch(app.view.state.tr.insertText(' Then', end));
    await app.__fm.save();
    return (await app.__fm.handle!.getFile()).text();
  });
  expect(unread).toContain('bibliography: refs.bib');
  expect(unread).not.toContain('{=bibtex}');

  // The folder is granted: the sidecar is read, not as an edit, and the
  // document gets the block that prints it.
  const attached = await page.evaluate(async (name) => {
    const app = window as SidecarApp;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => dir;
    const ok = await app.__fm.attachFolder();
    const { bib, frontmatter } = app.view.state.doc.attrs;
    return { ok, bib, frontmatter, pending: app.__fm.pendingBibliography, dirty: app.__fm.dirty };
  }, dirName);
  expect(attached.ok).toBe(true);
  expect(attached.bib?.content).toContain('@book{arrow1951');
  expect(attached.frontmatter).toBe('');
  expect(attached.pending).toBeNull();
  expect(attached.dirty).toBe(false);
  await expect(page.locator('#toast')).toContainText('bibliography read from refs.bib');
  await expect.poll(() => blocksAndList(page)).toEqual({ kinds: ['doc_title', 'paragraph', 'bibliography'], painted: 1 });
  await sourceTripIsIdentity(page);
  // Typst compiles it: the citation's key is in the document now.
  await settleLocal(page);
  expect(await page.evaluate(() => (window as SidecarApp).__audit())).not.toBeNull();

  // The next save writes the entries as a {=bibtex} block, and the key goes.
  const saved = await page.evaluate(async () => {
    const app = window as SidecarApp;
    const end = app.view.state.doc.child(1).nodeSize + app.view.state.doc.child(0).nodeSize - 1;
    app.view.dispatch(app.view.state.tr.insertText(' it.', end));
    await app.__fm.save();
    return (await app.__fm.handle!.getFile()).text();
  });
  expect(saved).toContain('```{=bibtex}\n@book{arrow1951');
  expect(saved).not.toContain('bibliography:');
  expect(saved).toMatch(/^---\ntitle: Paper\n---\n/);
});

test('a bibliography: sidecar read on an open with the folder prints, and the source trip is the identity', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as { __fm?: unknown }).__fm));
  const dirName = await seedFolder(page, 'plass-sidecar-open', {
    'refs.bib': ARROW,
    'Paper.md': '---\ntitle: Paper\nbibliography: refs.bib\n---\n\nArrow [@arrow1951] started it.\n',
  });
  const opened = await page.evaluate(async (name) => {
    const app = window as SidecarApp;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    await app.__fm.loadHandle(await dir.getFileHandle('Paper.md'), dir);
    const { bib, frontmatter } = app.view.state.doc.attrs;
    return { bib, frontmatter, pending: app.__fm.pendingBibliography, dirty: app.__fm.dirty };
  }, dirName);
  expect(opened.bib?.content).toContain('@book{arrow1951');
  expect(opened.frontmatter).toBe('');
  expect(opened.pending).toBeNull();
  expect(opened.dirty).toBe(false);
  await expect(page.locator('#toast')).toContainText('bibliography read from refs.bib');
  await expect.poll(() => blocksAndList(page)).toEqual({ kinds: ['doc_title', 'paragraph', 'bibliography'], painted: 1 });
  await sourceTripIsIdentity(page);
});

// Entries that arrive another way while the sidecar is unread (merge-on-
// cite, the Bibliography panel) take nothing with them: a save keeps the
// line, and the folder's read merges the sidecar into them.
test('a bibliography: sidecar read after the document gained entries of its own is merged in', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as { __fm?: unknown }).__fm));
  const dirName = await seedFolder(page, 'plass-sidecar-merge', {
    'refs.bib': ARROW,
    'Paper.md': '---\ntitle: Paper\nbibliography: refs.bib\n---\n\nArrow [@arrow1951] and Knuth [@knuth1984].\n',
  });
  const saved = await page.evaluate(async (name) => {
    const app = window as SidecarApp;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    await app.__fm.loadHandle(await dir.getFileHandle('Paper.md'));
    // What merge-on-cite does: the entry, and the block to print it.
    const { state } = app.view;
    const tr = state.tr.setDocAttribute('bib', { name: 'references.bib', content: '@book{knuth1984, title={The TeXbook}, year={1984}}' });
    app.view.dispatch(tr.insert(tr.doc.content.size, state.schema.nodes.bibliography.create()));
    await app.__fm.save();
    return (await app.__fm.handle!.getFile()).text();
  }, dirName);
  expect(saved).toContain('bibliography: refs.bib');
  expect(saved).toContain('```{=bibtex}\n@book{knuth1984');

  const attached = await page.evaluate(async (name) => {
    const app = window as SidecarApp;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => dir;
    await app.__fm.attachFolder();
    const { bib, frontmatter } = app.view.state.doc.attrs;
    return { content: bib?.content as string, frontmatter, pending: app.__fm.pendingBibliography };
  }, dirName);
  expect(attached.content).toMatch(/^@book\{knuth1984[^]*\n\n@book\{arrow1951/);
  expect(attached.frontmatter).toBe('');
  expect(attached.pending).toBeNull();
  await expect.poll(() => blocksAndList(page)).toEqual({ kinds: ['doc_title', 'paragraph', 'bibliography'], painted: 1 });
});

test('an opened .md file words its front-matter warnings as warnings', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as { __fm?: unknown }).__fm));
  const settings = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('Settings.md', { create: true });
    const w = await h.createWritable();
    await w.write('---\nfontsize: 99pt\npapersize: a4\n---\n\nBody.\n');
    await w.close();
    const app = window as unknown as { view: import('prosemirror-view').EditorView; __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> } };
    await app.__fm.loadHandle(h);
    return app.view.state.doc.attrs.settings;
  });
  expect(settings.page).toBe('a4');
  expect(settings.sizePt).toBe(12.5);
  await expect(page.locator('#toast')).toContainText('front matter: 1 warning — fontsize: 99pt is out of range');
  await expect(page.locator('#toast')).not.toContainText('raw Typst');
});

// A reload brings back the session's own document. A sidecar read on the
// open (with the folder) is in it and not yet in the file — no outside
// change, so the reload reconnects clean; one left unread (no folder) is
// still pending, and attaching the folder later reads it.
test('a reload after the sidecar was read with the folder reconnects clean (./ path)', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as { __fm?: unknown }).__fm));
  const dirName = await seedFolder(page, 'plass-sidecar-reload', {
    'refs.bib': ARROW.replace(/\n/g, '\r\n'),
    'Paper.md': '---\ntitle: Paper\nbibliography: ./refs.bib\n---\n\nArrow [@arrow1951] started it.\n',
  });
  await page.evaluate(async (name) => {
    const app = window as SidecarApp;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    await app.__fm.loadHandle(await dir.getFileHandle('Paper.md'), dir);
  }, dirName);
  await expect(page.locator('#toast')).toContainText('bibliography read from ./refs.bib');
  expect(await page.evaluate(() => ((window as SidecarApp).view.state.doc.attrs.bib as { content: string } | null)?.content.includes('\r'))).toBe(false);

  await page.reload();
  await page.waitForFunction(() => (window as unknown as SidecarApp).__fm?.handle?.name === 'Paper.md');
  await expect(page.locator('#toast')).toContainText('Reconnected');
  const after = await page.evaluate(() => {
    const app = window as SidecarApp & { __fm: { hasConflict: boolean } };
    return { conflict: app.__fm.hasConflict, dirty: app.__fm.dirty, bib: (app.view.state.doc.attrs.bib as { content: string } | null)?.content ?? null };
  });
  expect(after).toEqual({ conflict: false, dirty: false, bib: expect.stringContaining('@book{arrow1951') });
  await expect.poll(() => blocksAndList(page)).toEqual({ kinds: ['doc_title', 'paragraph', 'bibliography'], painted: 1 });
});

test('a sidecar left unread stays pending across a reload, and the folder reads it', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as { __fm?: unknown }).__fm));
  const dirName = await seedFolder(page, 'plass-sidecar-pending', {
    'refs.bib': ARROW,
    'Paper.md': '---\ntitle: Paper\nbibliography: refs.bib\n---\n\nArrow [@arrow1951] started it.\n',
  });
  await page.evaluate(async (name) => {
    const app = window as SidecarApp;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    await app.__fm.loadHandle(await dir.getFileHandle('Paper.md'));
  }, dirName);
  await expect(page.locator('#toast')).toContainText('its bibliography is refs.bib');

  await page.reload();
  await page.waitForFunction(() => (window as unknown as SidecarApp).__fm?.handle?.name === 'Paper.md');
  await expect(page.locator('#toast')).toContainText('its bibliography is refs.bib');
  expect(await page.evaluate(() => (window as unknown as SidecarApp).__fm.pendingBibliography)).toBe('refs.bib');

  const attached = await page.evaluate(async (name) => {
    const app = window as SidecarApp;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => dir;
    await app.__fm.attachFolder();
    const { bib, frontmatter } = app.view.state.doc.attrs;
    return { content: (bib as { content: string } | null)?.content ?? null, frontmatter, pending: app.__fm.pendingBibliography, dirty: app.__fm.dirty };
  }, dirName);
  expect(attached).toEqual({ content: expect.stringContaining('@book{arrow1951'), frontmatter: '', pending: null, dirty: false });
  await expect(page.locator('#toast')).toContainText('bibliography read from refs.bib');
});

test('the open toast names a front-matter warning that a save loses something first', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as { __fm?: unknown }).__fm));
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('Authors.md', { create: true });
    const w = await h.createWritable();
    // The plass.foo warning (kept as written: nothing lost) comes first.
    await w.write('---\nplass:\n  foo: 1\nauthor:\n  - name: Alice Smith\n    affiliation: Pitt\n  - name: Bob\n---\n\nBody.\n');
    await w.close();
    await (window as unknown as SidecarApp).__fm.loadHandle(h);
  });
  await expect(page.locator('#toast')).toContainText('front matter: 2 warnings — author: only the names are kept');
});
