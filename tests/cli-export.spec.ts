import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfPageCount, pdfStampsBlanked } from '../src/pdf-sheets';
import { expect, test } from './fixture';
import { settleLocal } from './settle';

// The `plass` command (cli/export.ts) writes the PDF the app's Export
// makes (Taylor, 2026-11-06): the same document, read as the app opens it
// with its values from values.json and a figure beside it, through the
// app's own compiler (the typst.ts wasm, src/typst-node.ts under Node;
// the worker in the app) with the same fonts. The two PDFs are the same
// bytes but for the compile's stamps (the dates and the ids Typst derives
// from them: src/pdf-sheets.ts pdfStampsBlanked). The command here is the
// checkout's, cli/plass.js; dist/cli/plass.mjs, the one Plass.app carries,
// is the same code bundled (scripts/verify-production.ts runs it, and
// app/smoke.mjs runs the app's).

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null) => Promise<unknown>; name: string };
  }
}

const SHEET = `---
title: Checkpoint
plass:
  page: half-letter
---

# A checkpoint

The price is [4.5]{.value name="price" digits=2} and the count is
[10]{.value name="qty"}, so $p \\cdot q = \\frac{a}{b}$ matters.^[A footnote, at the foot.]

![A box beside the document](figures/box.svg){width=40%}

| a | b |
|---|---|
| 1 | 2 |

::: solution
Revenue is [45]{.value name="rev" digits=1}, in red.
:::

${Array.from({ length: 18 }, (_, i) => `Paragraph ${i + 1}. The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing.`).join('\n\n')}
`;
const BOX = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect x="10" y="10" width="100" height="60" fill="#e6f0ff" stroke="#000"/></svg>\n';
const VALUES = '{"price": 7.25, "qty": 12, "rev": 87}\n';

test('plass export writes the PDF the app’s Export makes', async ({ page }) => {
  test.setTimeout(180_000);

  // The command, on the document in a folder of its own.
  const folder = await mkdtemp(join(tmpdir(), 'plass-cli-'));
  await mkdir(join(folder, 'figures'));
  await writeFile(join(folder, 'sheet.md'), SHEET);
  await writeFile(join(folder, 'figures', 'box.svg'), BOX);
  await writeFile(join(folder, 'values.json'), VALUES);
  execFileSync(process.execPath, ['cli/plass.js', 'export', join(folder, 'sheet.md'), '-o', join(folder, 'cli.pdf'), '-q'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const fromCommand = new Uint8Array(await readFile(join(folder, 'cli.pdf')));
  await rm(folder, { recursive: true, force: true });
  expect(pdfPageCount(fromCommand)).toBeGreaterThanOrEqual(2);

  // The app, on the same files in a folder it holds (the origin private
  // file system is a real directory handle): values refreshed from
  // values.json, then Export PDF, which lands beside the document.
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(
    async ({ sheet, box, values }) => {
      const root = await navigator.storage.getDirectory();
      const write = async (dir: FileSystemDirectoryHandle, name: string, data: string) => {
        const h = await dir.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write(data);
        await w.close();
        return h;
      };
      await write(await root.getDirectoryHandle('figures', { create: true }), 'box.svg', box);
      await write(root, 'values.json', values);
      await window.__fm.loadHandle(await write(root, 'sheet.md', sheet), root);
    },
    { sheet: SHEET, box: BOX, values: VALUES },
  );
  await expect(page.locator('.ProseMirror:not(.ts-measure-probe)')).toContainText('7.25');
  await expect(page.locator('.ProseMirror:not(.ts-measure-probe)')).toContainText('87.0');
  await settleLocal(page);
  const fromApp = await page.evaluate(async () => {
    const toast = document.getElementById('toast')!;
    const messages: string[] = [];
    const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });
    (document.querySelector('#toolbar [aria-label="Export PDF"]') as HTMLElement).click();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !messages.some((m) => m.startsWith('Exported ') || m.includes('failed'))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    observer.disconnect();
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(`${window.__fm.name}.pdf`);
    return { messages, bytes: [...new Uint8Array(await (await h.getFile()).arrayBuffer())] };
  });
  expect(fromApp.messages.some((m) => /^Exported \/?sheet\.pdf/.test(m)), fromApp.messages.join(' | ')).toBe(true);
  const exported = new Uint8Array(fromApp.bytes);
  expect(pdfPageCount(exported)).toBe(pdfPageCount(fromCommand));
  expect(pdfStampsBlanked(fromCommand)).toBe(pdfStampsBlanked(exported));
});
