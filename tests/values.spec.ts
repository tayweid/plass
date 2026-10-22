import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Values from Knuth's values.json (src/values.ts): text that knows its key,
// kept current as the file changes, a missing key outlined, `{{` to insert
// one, and the Markdown span the save writes.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null) => Promise<unknown>; save: () => Promise<unknown> };
  }
}

const DOC = `The mean price was [0]{.value name=prices.0} dollars over [0]{.value name=n} sales, a slope of [0]{.value name=fit.slope digits=2}, and [41]{.value name=gone}.
`;

async function write(page: Page, name: string, text: string) {
  await page.evaluate(async ({ name, text }) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
  }, { name, text });
}

async function open(page: Page, values: unknown) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await write(page, 'values.json', JSON.stringify(values));
  await write(page, 'paper.md', DOC);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await window.__fm.loadHandle(await root.getFileHandle('paper.md'), root);
  });
  await settleLocal(page);
}

const text = (page: Page) => page.evaluate(() => window.view.state.doc.textContent);

test('values come from values.json, follow it when it changes, and a missing one is outlined', async ({ page }) => {
  await open(page, { prices: [4.5, 7], n: 120, fit: { slope: -0.12345 } });
  await expect.poll(() => text(page)).toBe('The mean price was 4.5 dollars over 120 sales, a slope of −0.12, and 41.');
  // The missing key keeps its text, outlined; the others are not.
  await expect(page.locator('.ProseMirror .ts-value-missing')).toHaveText('41');
  await expect(page.locator('.ProseMirror .ts-value-live')).toHaveCount(3);

  // Knuth runs again: the file changes, the text follows.
  await write(page, 'values.json', JSON.stringify({ prices: [5.25, 7], n: 121, fit: { slope: 0.5 }, gone: 'back' }));
  await expect.poll(() => text(page), { timeout: 8000 }).toBe('The mean price was 5.25 dollars over 121 sales, a slope of 0.50, and back.');
  await expect(page.locator('.ProseMirror .ts-value-missing')).toHaveCount(0);
  // A refresh is not an edit to undo.
  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('ControlOrMeta+z');
  expect(await text(page)).toContain('5.25');
});

test('{{ opens the picker: a key, :2 for decimals, Enter inserts it; the save writes the span', async ({ page }) => {
  await open(page, { prices: [4.5, 7], n: 120, fit: { slope: 0.12345 } });
  await expect.poll(() => text(page)).toContain('4.5 dollars');
  // At the end of the paragraph.
  await page.evaluate(() => {
    const { state } = window.view;
    const end = state.doc.firstChild!.nodeSize - 1;
    const Sel = state.selection.constructor as unknown as { near: (p: unknown) => import('prosemirror-state').Selection };
    window.view.focus();
    window.view.dispatch(state.tr.setSelection(Sel.near(state.doc.resolve(end))));
  });
  await page.keyboard.type(' Slope {{slo');
  const menu = page.getByRole('listbox', { name: 'Values' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option')).toHaveText(['0.12345fit.slope']);
  await page.keyboard.type(':3');
  await expect(menu.getByRole('option')).toHaveText(['0.123fit.slope']);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  expect(await text(page)).toMatch(/ Slope 0\.123$/);
  // Typing on after it is plain text, not the value.
  await page.keyboard.type('!');
  const marked = await page.evaluate(() => {
    const out: string[] = [];
    window.view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'value')) out.push(n.text!);
    });
    return out;
  });
  expect(marked.at(-1)).toBe('0.123');

  await page.evaluate(() => window.__fm.save());
  const saved = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getFileHandle('paper.md')).getFile()).text();
  });
  expect(saved).toContain('[4.5]{.value name=prices.0}');
  expect(saved).toContain('Slope [0.123]{.value name=fit.slope digits=3}!');
});
