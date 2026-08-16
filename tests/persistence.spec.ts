import { expect, test } from 'playwright/test';

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
        const handle = await dir.getFileHandle('Untitled.typ');
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
    return (await (await dir.getFileHandle('Untitled.typ')).getFile()).text();
  }, dirName);
  expect(disk).toBe('EXTERNAL RECONNECT VERSION');
});
