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
    loadHandle(h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null, discardConfirmed?: boolean): Promise<boolean>;
    newDoc(doc?: unknown, name?: string): boolean;
  };
  __loadDemo(): void;
  view: {
    state: {
      schema: {
        nodes: Record<string, { create(attrs: Record<string, unknown> | null, content?: unknown): unknown }>;
        text(t: string): unknown;
      };
      doc: { content: { size: number } };
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
    // A second export links the image the first one wrote, adding no copy —
    // through a new handle on the same folder, as after a reload or with the
    // folder attached again: the file is found by its content, not by
    // anything this tab remembers.
    app.__fm.dir = await root.getDirectoryHandle('typ-export');
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
  expect(result.names[0]).toMatch(/-[0-9a-f]{12}\.svg$/);
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
    // The table's `gutter` has no Markdown form (it is kept as `params`), so
    // the conversion has something to say it could not keep.
    const original = '= Paper\n\n#table(columns: 2, gutter: 3pt, [a], [b])\n\nOne paragraph of the source.\n';
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
  // What the conversion could not keep is on the export's own toast, not on
  // notices the "Exported" toast replaces at once.
  const exported = result.messages.filter((m) => m.startsWith('Exported open-typ/Paper.md'));
  expect(exported).toHaveLength(1);
  expect(exported[0]).toContain(
    'Exported open-typ/Paper.md — table styling/captions are not representable in Markdown — simplified to a plain table',
  );
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

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('Export → Markdown asks before replacing an .md already in the folder', async ({ page }) => {
  // The chain that lost a writer's Markdown source: Paper.md is the source,
  // Export → Typst writes Paper.typ beside it, Paper.typ is opened, and
  // Export → Markdown would write the print form back over Paper.md.
  await page.goto('/?new=1');
  const answers = [false, true];
  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    if (/already exists/.test(d.message()) && !answers.shift()) void d.dismiss();
    else void d.accept();
  });
  const result = await page.evaluate(async () => {
    const list = async (d: FileSystemDirectoryHandle) => {
      const names: string[] = [];
      for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(k);
      return names.sort();
    };
    const app = window as ExportApp;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('md-source', { create: true });
    const source = '# Paper\n\n<!-- plass:comment\nKeep this note.\n-->\n\nBody text.\n';
    const md = await dir.getFileHandle('Paper.md', { create: true });
    const w = await md.createWritable();
    await w.write(source);
    await w.close();
    await app.__fm.loadHandle(md, dir, true);

    const toast = document.getElementById('toast')!;
    const messages: string[] = [];
    const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });
    await app.__fm.exportCopy();
    await app.__fm.loadHandle(await dir.getFileHandle('Paper.typ'), dir, true);
    await app.__fm.exportCopy();
    await app.__fm.exportMdCopy();
    const declined = await (await md.getFile()).text();
    await app.__fm.exportMdCopy();
    await new Promise((r) => setTimeout(r, 0));
    observer.disconnect();
    const accepted = await (await md.getFile()).text();
    return { source, declined, accepted, messages, files: await list(dir) };
  });

  expect(result.messages).toContain('Paper.typ is the open document — open Paper.md and export Typst from it');
  expect(asked.filter((m) => m === 'Paper.md already exists in this folder — overwrite it?')).toHaveLength(2);
  expect(result.declined).toBe(result.source);
  expect(result.accepted).not.toContain('Keep this note.');
  expect(result.messages.some((m) => m.startsWith('Exported md-source/Paper.md'))).toBe(true);
  expect(result.files).toEqual(['Paper.md', 'Paper.typ']);
});

test('Export → Typst asks before replacing a .typ it did not write, and re-exports its own unasked', async ({ page }) => {
  // The chain the open-.typ toast recommends: Paper.typ is the writer's
  // source, Export → Markdown writes Paper.md, Paper.md is opened, and
  // Export → Typst would write the print form over Paper.typ — its page
  // setup and table styling, which the .md cannot hold, gone unasked.
  await page.goto('/?new=1');
  const answers = [false, true, false];
  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    if (/already exists/.test(d.message()) && !answers.shift()) void d.dismiss();
    else void d.accept();
  });
  const result = await page.evaluate(async () => {
    const list = async (d: FileSystemDirectoryHandle) => {
      const names: string[] = [];
      for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(k);
      return names.sort();
    };
    const app = window as ExportApp;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('typ-chain', { create: true });
    const source =
      '#set page(paper: "a4", margin: 1.5in)\n#set text(size: 12pt)\n\n= Paper\n\n' +
      '#table(columns: 2, gutter: 3pt, [a], [b])\n\nOne paragraph of the source.\n';
    const typ = await dir.getFileHandle('Paper.typ', { create: true });
    const write = async (text: string) => {
      const w = await typ.createWritable();
      await w.write(text);
      await w.close();
    };
    const read = async () => (await typ.getFile()).text();
    await write(source);
    await app.__fm.loadHandle(typ, dir, true);

    const toast = document.getElementById('toast')!;
    const messages: string[] = [];
    const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });
    await app.__fm.exportCopy();
    await app.__fm.exportMdCopy();
    await app.__fm.loadHandle(await dir.getFileHandle('Paper.md'), dir, true);
    const asked0 = messages.length;
    // Declined: nothing is written, figures/ included.
    await app.__fm.exportCopy();
    const declined = await read();
    const afterDecline = await list(dir);
    const quietDecline = messages.slice(asked0).filter((m) => m.startsWith('Exported')).length === 0;
    // Accepted: the export replaces it.
    await app.__fm.exportCopy();
    const accepted = await read();
    // Unchanged since that export: re-exporting is one click, no question.
    await app.__fm.exportCopy();
    const again = await read();
    // Edited by hand since: it is the writer's again, and asked about.
    const edited = accepted.replace('One paragraph of the source.', 'An edit made by hand.');
    await write(edited);
    await app.__fm.exportCopy();
    const keptEdit = await read();
    await new Promise((r) => setTimeout(r, 0));
    observer.disconnect();
    return { source, declined, afterDecline, quietDecline, accepted, again, edited, keptEdit, messages };
  });

  expect(result.messages).toContain('Paper.typ is the open document — Export → Markdown, then export Typst from the .md');
  expect(result.messages.some((m) => m.startsWith('Exported typ-chain/Paper.md'))).toBe(true);
  const question =
    "Paper.typ already exists in this folder — replace it with this document's Typst export? Anything only Paper.typ holds, such as its page setup, is lost.";
  expect(asked.filter((m) => m === question)).toHaveLength(3);
  expect(asked).toHaveLength(3);
  expect(result.declined).toBe(result.source);
  expect(result.afterDecline).toEqual(['Paper.md', 'Paper.typ']);
  expect(result.quietDecline).toBe(true);
  expect(result.accepted).toMatch(/^\/\/ Exported from Plass — exact on typst /);
  expect(result.accepted).toContain('One paragraph of the source.');
  expect(result.again).toBe(result.accepted);
  expect(result.keptEdit).toBe(result.edited);
  expect(result.messages.filter((m) => m.startsWith('Exported typ-chain/Paper.typ'))).toHaveLength(2);
});

test('an export never replaces a file another Plass window has open', async ({ page, context }) => {
  // The other window would reload into the export, or meet it as a conflict
  // over its unsaved edits: the export is refused there, with no question.
  await page.goto('/?new=1');
  const other = await context.newPage();
  await other.goto('/?new=1');
  const asked: string[] = [];
  for (const p of [page, other]) p.on('dialog', (d) => (asked.push(d.message()), void d.accept()));
  const original = '= Held\n\nOpen in the other window.\n';
  await other.evaluate(async (text) => {
    const app = window as ExportApp;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('held', { create: true });
    const write = async (name: string, body: string) => {
      const h = await dir.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(body);
      await w.close();
      return h;
    };
    await write('Held.md', '# Held\n\nOpen in the other window.\n');
    await app.__fm.loadHandle(await write('Held.typ', text), dir, true);
  }, original);

  const result = await page.evaluate(async () => {
    const app = window as ExportApp;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('held');
    const { schema } = app.view.state;
    app.__fm.newDoc(schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text('A different text.'))]), 'Held');
    app.__fm.dir = dir;
    const toast = document.getElementById('toast')!;
    const messages: string[] = [];
    const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });
    await app.__fm.exportCopy();
    const typ = await (await (await dir.getFileHandle('Held.typ')).getFile()).text();
    await new Promise((r) => setTimeout(r, 0));
    observer.disconnect();
    return { typ, messages };
  });

  expect(result.typ).toBe(original);
  expect(result.messages).toContain('Held.typ is open in another Plass window — close it there, then export again');
  expect(asked).toEqual([]);
});

test('Export → Markdown from the open .md is a save, and a .typ export never writes over an open .TYP', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const list = async (d: FileSystemDirectoryHandle) => {
      const names: string[] = [];
      for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(k);
      return names.sort();
    };
    const app = window as ExportApp;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('open-md', { create: true });
    const write = async (name: string, text: string) => {
      const h = await dir.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      return h;
    };
    const toast = document.getElementById('toast')!;
    const messages: string[] = [];
    const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });

    await app.__fm.loadHandle(await write('Notes.md', '# Notes\n\nA line.\n'), dir, true);
    await app.__fm.exportMdCopy();
    await new Promise((r) => setTimeout(r, 0));
    const afterMd = await list(dir);

    // OPFS is case-sensitive, so a second file would show here; on APFS
    // (case-insensitive) the write would have landed on the open file.
    await app.__fm.loadHandle(await write('Upper.TYP', '= Upper\n\nText.\n'), dir, true);
    await app.__fm.exportCopy();
    await new Promise((r) => setTimeout(r, 0));
    observer.disconnect();
    return { messages, afterMd, afterTyp: await list(dir) };
  });

  expect(result.messages).toContain('Saved Notes.md');
  expect(result.afterMd).toEqual(['Notes.md']);
  expect(result.messages).toContain('Upper.typ is the open document — Export → Markdown, then export Typst from the .md');
  expect(result.afterTyp).toEqual(['Notes.md', 'Upper.TYP']);
});

test('the .typ export names images by content and keeps what it cannot write as data', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(
    async (png) => {
      const list = async (d: FileSystemDirectoryHandle) => {
        const names: string[] = [];
        for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(k);
        return names.sort();
      };
      const app = window as ExportApp;
      const { schema } = app.view.state;
      const n = schema.nodes;
      // An inline image whose alt has no ASCII letters (its file must not be
      // a dotfile), a WebP figure (no figures/ form: it stays data), and a
      // formula whose source starts "data:" (not an image at all).
      const para = n.paragraph.create(null, [
        n.image.create({ src: png, alt: 'α' }),
        schema.text(' and '),
        n.math_inline.create({ src: 'data:x' }),
      ]);
      const webp = n.figure.create(
        { src: 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', name: 'photo.webp' },
        schema.text('A photo.'),
      );
      app.view.dispatch(app.view.state.tr.insert(0, para));
      app.view.dispatch(app.view.state.tr.insert(app.view.state.doc.content.size, webp));
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('typ-kept', { create: true });
      app.__fm.dir = dir;

      const toast = document.getElementById('toast')!;
      const messages: string[] = [];
      const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
      observer.observe(toast, { childList: true, characterData: true, subtree: true });
      await app.__fm.exportCopy();
      await new Promise((r) => setTimeout(r, 0));
      observer.disconnect();
      const typ = await (await (await dir.getFileHandle(`${app.__fm.name}.typ`)).getFile()).text();
      return { typ, figures: await list(await dir.getDirectoryHandle('figures')), messages, name: app.__fm.name };
    },
    PNG_1PX,
  );

  expect(result.figures).toHaveLength(1);
  expect(result.figures[0]).toMatch(/^image-[0-9a-f]{12}\.png$/);
  expect(result.typ).toContain(`#image("figures/${result.figures[0]}")`);
  expect(result.typ).toContain('image("data:image/webp;base64,');
  expect(result.messages).toContain(`Exported typ-kept/${result.name}.typ — 1 embedded image could not be written to figures/`);
});

test('a .typ export the serializer refuses writes nothing and says why', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(
    async (png) => {
      const list = async (d: FileSystemDirectoryHandle) => {
        const names: string[] = [];
        for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(k);
        return names.sort();
      };
      const app = window as ExportApp;
      const { schema } = app.view.state;
      const n = schema.nodes;
      // Inline Typst in a table cell is outside the cell subset the
      // serializer writes (src/table-integrity.test.ts): it throws. The
      // editor refuses to type such a cell, so the document arrives whole,
      // as a file does.
      const table = n.table.create(null, [
        n.table_row.create(null, [n.table_cell.create(null, [n.paragraph.create(null, [n.typst_inline.create({ src: '#h(1em)' })])])]),
      ]);
      const figure = n.figure.create({ src: png, name: 'dot.png' }, schema.text('A dot.'));
      app.__fm.newDoc(n.doc.create(null, [figure, table]), 'Refused');
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('typ-refused', { create: true });
      app.__fm.dir = dir;

      const toast = document.getElementById('toast')!;
      const messages: string[] = [];
      const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
      observer.observe(toast, { childList: true, characterData: true, subtree: true });
      let rejected = false;
      await app.__fm.exportCopy().catch(() => (rejected = true));
      await new Promise((r) => setTimeout(r, 0));
      observer.disconnect();
      return { rejected, files: await list(dir), messages };
    },
    PNG_1PX,
  );

  expect(result.rejected).toBe(false);
  // No .typ, and no figures/ folder holding an orphan image.
  expect(result.files).toEqual([]);
  expect(result.messages.some((m) => m.startsWith('Typst export failed: Cannot export table cell 1:1: unsupported inline typst_inline'))).toBe(true);
});
