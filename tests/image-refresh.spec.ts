import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// An asset refresh never empties an image. The folder watcher (figures.ts,
// startAssetWatch) tells every image view to look its file up again: on its
// first pass after a folder opens and on every file change. The views used
// to clear the image first and set it again once the lookup (real file
// system reads) came back, so every image on the page collapsed and the
// page reflowed twice; on the deploy's slower runner a snapshot landed in
// that gap (2026-10-14: block-chrome.spec saw three answer boxes at 30 px
// instead of 304). An image now keeps the picture it shows until the new
// one is ready.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null) => Promise<unknown> };
  }
}

const SHEET = readFileSync(new URL('./fixtures/block-chrome/sheet.md', import.meta.url), 'utf8');
const BOX = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="260" viewBox="0 0 200 260"><rect x="1" y="1" width="198" height="258" fill="none" stroke="#aaaaaa" stroke-width="1.2"/></svg>';

async function openSheet(page: Page) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(
    async ({ text, box }) => {
      const root = await navigator.storage.getDirectory();
      const write = async (dir: FileSystemDirectoryHandle, name: string, data: string) => {
        const h = await dir.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write(data);
        await w.close();
        return h;
      };
      await write(await root.getDirectoryHandle('i', { create: true }), 'box.svg', box);
      await window.__fm.loadHandle(await write(root, 'sheet.md', text), root);
    },
    { text: SHEET, box: BOX },
  );
  await settleLocal(page);
  await expect
    .poll(() => page.locator('.ProseMirror .ts-inline-image img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length))
    .toBeGreaterThanOrEqual(3);
}

/** The smallest drawn height any image reached, frame by frame, from now
 *  until `ms` after `act` ran. */
function minImageHeight(page: Page, act: string, ms: number) {
  return page.evaluate(
    ({ act, ms }) =>
      new Promise<number>((resolve) => {
        let min = Infinity;
        const images = () => [...document.querySelectorAll<HTMLImageElement>('.ProseMirror .ts-inline-image img, .ProseMirror .ts-figure img')];
        const end = performance.now() + ms;
        const tick = () => {
          for (const img of images()) min = Math.min(min, img.getBoundingClientRect().height);
          if (performance.now() < end) requestAnimationFrame(tick);
          else resolve(min);
        };
        requestAnimationFrame(tick);
        // Synchronous checks too: a frame could miss a gap between two of them.
        new MutationObserver(() => { for (const img of images()) if (!img.getAttribute('src')) min = 0; }).observe(document.querySelector('.ProseMirror')!, { subtree: true, attributes: true, attributeFilter: ['src'] });
        // eslint-disable-next-line no-new-func
        new Function(act)();
      }),
    { act, ms },
  );
}

test('an asset refresh keeps every image drawn while it looks the file up again', async ({ page }) => {
  await openSheet(page);
  const before = await page.locator('.ProseMirror .ts-inline-image img').first().evaluate((i) => i.getBoundingClientRect().height);
  expect(before).toBeGreaterThan(100);
  // What the watcher sends when it sees a folder or a file change.
  expect(await minImageHeight(page, "window.dispatchEvent(new CustomEvent('typeset-assets-changed'))", 800)).toBeGreaterThan(100);
  // And a real change on disk, picked up by the watcher's next pass.
  await page.evaluate(async (box) => {
    const root = await navigator.storage.getDirectory();
    const h = await (await root.getDirectoryHandle('i')).getFileHandle('box.svg');
    const w = await h.createWritable();
    await w.write(box.replace('#aaaaaa', '#999999'));
    await w.close();
  }, BOX);
  expect(await minImageHeight(page, "window.dispatchEvent(new Event('focus'))", 1500)).toBeGreaterThan(100);
});
