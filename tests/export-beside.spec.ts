import { expect, test } from 'playwright/test';

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

    (document.querySelector('[title="Export — PDF, .typ, .tex"]') as HTMLElement).click();
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
    (document.querySelector('[title="Export — PDF, .typ, .tex"]') as HTMLElement).click();
    (document.querySelector('[title="Export PDF via Typst"]') as HTMLElement).click();
  });
  expect((await download).suggestedFilename()).toBe('Plass.pdf');
});

test('.typ and .tex exports write into the project folder when one is attached', async ({ page }) => {
  await page.goto('/?new=1');
  let downloads = 0;
  page.on('download', () => downloads++);

  const result = await page.evaluate(async () => {
    const app = window as typeof window & {
      __fm: {
        dir: FileSystemDirectoryHandle | null;
        name: string;
        exportCopy(): Promise<void>;
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

    (document.querySelector('[title="Export — PDF, .typ, .tex"]') as HTMLElement).click();
    (document.querySelector('[title="Export a .typ copy"]') as HTMLElement).click();
    (document.querySelector('[title="Export a .tex copy (vanilla LaTeX for journals)"]') as HTMLElement).click();

    const deadline = Date.now() + 10_000;
    const done = () =>
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
    return { typ: await read('.typ'), tex: await read('.tex'), messages };
  });

  expect(result.typ).not.toBeNull();
  expect(result.tex).toContain('\\documentclass');
  expect(downloads).toBe(0);
});
