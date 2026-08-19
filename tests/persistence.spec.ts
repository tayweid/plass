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
    const { refreshAssets } = await import('/src/figures.ts');
    refreshAssets();
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
  await expect(page.locator('.tb-file')).toHaveText('Plass');
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

  const chip = page.locator('.tb-file');
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

  const chip = page.locator('.tb-file');
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
