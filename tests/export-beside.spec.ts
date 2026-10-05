import { readFile } from 'node:fs/promises';
import { expect, test } from './fixture';

// PDF export lands next to the document, not in ~/Downloads. The Origin
// Private File System stands in for a granted project folder: it is a real
// FileSystemDirectoryHandle, so the write path under test is the real one.
test('PDF export writes into the project folder when one is attached', async ({ page }) => {
  await page.goto('/?new=1');
  let downloads = 0;
  page.on('download', () => downloads++);

  const result = await page.evaluate(async () => {
    const app = window as typeof window & {
      __fm: {
        dir: FileSystemDirectoryHandle | null;
        name: string;
        saveBeside(name: string, blob: Blob): Promise<string | null>;
      };
    };
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('project', { create: true });
    app.__fm.dir = dir;

    const toast = document.getElementById('toast')!;
    const messages: string[] = [];
    const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });

    (document.querySelector('[title="Export — PDF, .md, .typ, .tex"]') as HTMLElement).click();
    (document.querySelector('[title="Export PDF via Typst"]') as HTMLElement).click();

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !messages.some((m) => m.startsWith('Exported '))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    observer.disconnect();

    let header = '';
    try {
      const h = await dir.getFileHandle(`${app.__fm.name}.pdf`);
      const bytes = new Uint8Array(await (await h.getFile()).arrayBuffer());
      header = new TextDecoder().decode(bytes.slice(0, 5));
    } catch {
      /* missing — the assertion below reports it */
    }
    return { messages, header, name: app.__fm.name };
  });

  expect(result.header).toBe('%PDF-');
  expect(result.messages.some((m) => m.startsWith(`Exported project/${result.name}.pdf`))).toBe(true);
  expect(downloads).toBe(0);
});

test('PDF export downloads when there is no folder and no file handle', async ({ page }) => {
  await page.goto('/?new=1');
  const download = page.waitForEvent('download');
  await page.evaluate(() => {
    (document.querySelector('[title="Export — PDF, .md, .typ, .tex"]') as HTMLElement).click();
    (document.querySelector('[title="Export PDF via Typst"]') as HTMLElement).click();
  });
  expect((await download).suggestedFilename()).toBe('Plass.pdf');
});

test('.md, .typ and .tex exports write into the project folder when one is attached', async ({ page }) => {
  await page.goto('/?new=1');
  let downloads = 0;
  page.on('download', () => downloads++);

  const result = await page.evaluate(async () => {
    const app = window as typeof window & {
      __fm: {
        dir: FileSystemDirectoryHandle | null;
        name: string;
        exportCopy(): Promise<void>;
        exportMdCopy(): Promise<void>;
        exportTexCopy(): void;
      };
    };
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('project-src', { create: true });
    app.__fm.dir = dir;

    const toast = document.getElementById('toast')!;
    const messages: string[] = [];
    const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });

    (document.querySelector('[title="Export — PDF, .md, .typ, .tex"]') as HTMLElement).click();
    (document.querySelector('[title="Export a .md copy"]') as HTMLElement).click();
    (document.querySelector('[title="Export a .typ copy"]') as HTMLElement).click();
    (document.querySelector('[title="Export a .tex copy (vanilla LaTeX for journals)"]') as HTMLElement).click();

    const deadline = Date.now() + 10_000;
    const done = () =>
      messages.some((m) => m.startsWith(`Exported project-src/${app.__fm.name}.md`)) &&
      messages.some((m) => m.startsWith(`Exported project-src/${app.__fm.name}.typ`)) &&
      messages.some((m) => m.startsWith(`Exported project-src/${app.__fm.name}.tex`));
    while (Date.now() < deadline && !done()) await new Promise((r) => setTimeout(r, 50));
    observer.disconnect();

    const read = async (ext: string) => {
      try {
        const h = await dir.getFileHandle(`${app.__fm.name}${ext}`);
        return await (await h.getFile()).text();
      } catch {
        return null;
      }
    };
    return { md: await read('.md'), typ: await read('.typ'), tex: await read('.tex'), messages };
  });

  expect(result.md).not.toBeNull();
  expect(result.typ).toMatch(/^\/\/ Exported from Plass/);
  expect(result.tex).toContain('\\documentclass');
  expect(downloads).toBe(0);
});

// Export → Typst is the source Plass compiles, not the editable file: the
// islands print as code, editorial comments are absent, and in a project
// folder every embedded image is written to figures/ and linked by path so
// the .typ compiles with the typst CLI (src/typ-export-compile.test.ts).
type ExportApp = typeof window & {
  __fm: {
    dir: FileSystemDirectoryHandle | null;
    name: string;
    exportCopy(): Promise<void>;
    exportMdCopy(): Promise<void>;
    loadHandle(h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null): Promise<boolean>;
  };
  __loadDemo(): void;
  view: {
    state: {
      schema: { nodes: Record<string, { create(attrs: null, content: unknown): unknown }>; text(t: string): unknown };
      tr: { insert(pos: number, node: unknown): unknown };
    };
    dispatch(tr: unknown): void;
  };
};

test('the .typ export writes embedded images to figures/ and leaves comments out', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const app = window as ExportApp;
    app.__loadDemo();
    const { schema } = app.view.state;
    app.view.dispatch(
      app.view.state.tr.insert(0, schema.nodes.editor_comment.create(null, schema.text('Check the sign before posting.'))),
    );
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('typ-export', { create: true });
    app.__fm.dir = dir;

    const toast = document.getElementById('toast')!;
    const messages: string[] = [];
    const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });
    await app.__fm.exportCopy();
    // A second export links the image the first one wrote, adding no copy.
    await app.__fm.exportCopy();
    await new Promise((r) => setTimeout(r, 0));
    observer.disconnect();

    const typ = await (await (await dir.getFileHandle(`${app.__fm.name}.typ`)).getFile()).text();
    const figures = await dir.getDirectoryHandle('figures');
    const names: string[] = [];
    for await (const name of (figures as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    const svg = names.length ? await (await (await figures.getFileHandle(names[0])).getFile()).text() : '';
    return { typ, names, svg, messages, name: app.__fm.name };
  });

  expect(result.typ).toMatch(/^\/\/ Exported from Plass — exact on typst /);
  expect(result.typ).not.toContain('plass:comment');
  expect(result.typ).not.toContain('Check the sign before posting.');
  expect(result.typ).not.toContain('image("data:');
  expect(result.names).toHaveLength(1);
  expect(result.names[0]).toMatch(/\.svg$/);
  expect(result.typ).toContain(`image("figures/${result.names[0]}"`);
  expect(result.svg).toContain('<svg');
  expect(result.messages).toContain(`Exported typ-export/${result.name}.typ — 1 embedded image written to figures/`);
});

test('without a folder the .typ export keeps its images as data and says so', async ({ page }) => {
  await page.goto('/?new=1');
  const download = page.waitForEvent('download');
  const messages = await page.evaluate(async () => {
    const app = window as ExportApp;
    app.__loadDemo();
    const toast = document.getElementById('toast')!;
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });
    await app.__fm.exportCopy();
    await new Promise((r) => setTimeout(r, 0));
    observer.disconnect();
    return seen;
  });
  const file = await download;
  expect(file.suggestedFilename()).toBe('Demo.typ');
  const text = await readFile((await file.path())!, 'utf8');
  expect(text).toContain('image("data:image/svg+xml');
  expect(messages).toContain('Exported Demo.typ — embedded images need the project folder open to compile outside Plass');
});

test('Export → Typst never overwrites the open .typ; Export → Markdown writes the .md beside it', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const app = window as ExportApp;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('open-typ', { create: true });
    const original = '= Paper\n\nOne paragraph of the source.\n';
    const handle = await dir.getFileHandle('Paper.typ', { create: true });
    const w = await handle.createWritable();
    await w.write(original);
    await w.close();
    await app.__fm.loadHandle(handle, dir);

    const toast = document.getElementById('toast')!;
    const messages: string[] = [];
    const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });
    await app.__fm.exportCopy();
    await new Promise((r) => setTimeout(r, 0));
    const after = await (await handle.getFile()).text();
    await app.__fm.exportMdCopy();
    await new Promise((r) => setTimeout(r, 0));
    observer.disconnect();
    const md = await (await (await dir.getFileHandle('Paper.md')).getFile()).text();
    return { original, after, md, messages };
  });

  expect(result.messages).toContain('Paper.typ is the open document — Export → Markdown, then export Typst from the .md');
  expect(result.after).toBe(result.original);
  expect(result.md).toContain('# Paper');
  expect(result.md).toContain('One paragraph of the source.');
  expect(result.messages).toContain('Exported open-typ/Paper.md');
});

test('the .typ export from an open Typst source is the print form, not the typed text', async ({ page }) => {
  // A save from the source writes the typed bytes verbatim; the export must
  // not take that shortcut, or an island typed there would run in the .typ.
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as { __sourceView?: unknown }).__sourceView);
  const result = await page.evaluate(async () => {
    const app = window as ExportApp & {
      __sourceView: { enter(): Promise<boolean>; text(): string | null; setText(text: string): void };
    };
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('typ-source', { create: true });
    app.__fm.dir = dir;
    await app.__sourceView.enter();
    const sv = app.__sourceView;
    sv.setText(sv.text()!.trimEnd() + '\n\n#let width = 3cm\n\nA paragraph typed in the source.\n');
    await app.__fm.exportCopy();
    const typ = await (await (await dir.getFileHandle(`${app.__fm.name}.typ`)).getFile()).text();
    return { typ, typed: sv.text() ?? '' };
  });

  expect(result.typed).toContain('\n\n#let width = 3cm\n\n');
  expect(result.typ).toMatch(/^\/\/ Exported from Plass — exact on typst /);
  expect(result.typ).toContain('A paragraph typed in the source.');
  expect(result.typ).toContain('```\n#let width = 3cm\n```');
});
