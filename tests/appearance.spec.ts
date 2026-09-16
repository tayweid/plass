import { expect, test, type Page } from 'playwright/test';
import { settleLocal } from './settle';

// Editor appearance (appearance.ts): "Warm paper" is a screen-only device
// preference. It recolors the sheet, the ink, the chrome, and the source
// view; it moves nothing, changes no document, and is not what prints.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown>; isDirty?: () => boolean };
    __pagLog: () => string[];
    __pagCount: () => number;
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';
const TYP =
  '#set page(paper: "us-letter", margin: 1.25in, numbering: "1", number-align: center)\n#set par(justify: true, leading: 10.215pt, spacing: 21.465pt)\n#set text(font: "New Computer Modern", size: 12.5pt)\n\n= Warm\n\n' +
  Array.from({ length: 9 }, () => FILLER.repeat(4).trimEnd()).join('\n\n') +
  '\n\nA note#footnote[An entry at the foot of the page.] here.\n\n// plass:comment\n// | A comment strip on the warm sheet.\n// /plass:comment\n\n' +
  FILLER.repeat(3).trimEnd() +
  '\n';

const colors = (page: Page) =>
  page.evaluate(() => {
    const css = (sel: string, prop: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      return el ? getComputedStyle(el).getPropertyValue(prop) : null;
    };
    return {
      sheet: css('.page-box', 'background-color'),
      ink: css('.ProseMirror', 'color'),
      folio: css('#pages .page-num', 'color'),
      footnote: css('.fn-body', 'color'),
      rule: css('.fn-body.fn-first', 'border-top-color'),
      source: css('#source', 'background-color'),
      sourceInk: css('#source .cm-editor', 'color'),
      preset: document.documentElement.dataset.appearance ?? 'standard',
    };
  });

const geometry = (page: Page) =>
  page.evaluate(() => ({
    pag: window.__pagLog().at(-1),
    boxes: [...document.querySelectorAll<HTMLElement>('.page-box')].map((b) => [b.style.top, b.getBoundingClientRect().height]),
    lines: [...document.querySelectorAll<HTMLElement>('.ProseMirror p')].slice(0, 4).map((p) => p.getBoundingClientRect().height),
    note: document.querySelector<HTMLElement>('.editor-comment')?.getBoundingClientRect().height,
    title: document.title,
    typ: null as string | null,
  }));

const openSettings = (page: Page) => page.getByRole('button', { name: 'Document settings', exact: true }).click();
const pickAppearance = async (page: Page, label: string) => {
  const row = page.locator('.settings-row-appearance');
  await row.locator('.ts-select-btn').click();
  await row.locator('.ts-select-item', { hasText: label }).click();
};

test('Warm paper recolors the screen only, persists on the device, and prints in the publication palette', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('warm.typ', { create: true });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
    await window.__fm.loadHandle(h);
  }, TYP);
  await settleLocal(page);
  const standard = await colors(page);
  expect(standard.preset).toBe('standard');
  expect(standard.sheet).toBe('rgb(255, 255, 255)');
  expect(standard.ink).toBe('rgb(26, 26, 26)');
  const before = await geometry(page);
  await page.evaluate(() => {
    (window as unknown as { __docBefore: unknown }).__docBefore = window.view.state.doc;
  });
  const serializedBefore = await page.evaluate(async () => (await import('/src/typ-serializer.ts')).docToTyp(window.view.state.doc));

  await openSettings(page);
  await expect(page.locator('.settings-row-appearance')).toBeVisible();
  await pickAppearance(page, 'Warm paper');
  await page.keyboard.press('Escape');
  const warm = await colors(page);
  expect(warm).toMatchObject({
    preset: 'warm',
    sheet: 'rgb(252, 251, 247)',
    ink: 'rgb(44, 43, 38)',
    folio: 'rgb(44, 43, 38)',
    footnote: 'rgb(44, 43, 38)',
    rule: 'rgb(44, 43, 38)',
  });
  // Nothing moved, nothing changed in the document, nothing became dirty.
  await page.waitForTimeout(400);
  const after = await geometry(page);
  expect(after.pag).toBe(before.pag);
  expect(after.boxes).toEqual(before.boxes);
  expect(after.lines).toEqual(before.lines);
  expect(after.note).toBe(before.note);
  expect(after.title).toBe(before.title);
  expect(await page.evaluate(() => window.view.state.doc === (window as unknown as { __docBefore: unknown }).__docBefore)).toBe(true);
  expect(await page.evaluate(async () => (await import('/src/typ-serializer.ts')).docToTyp(window.view.state.doc))).toBe(serializedBefore);
  expect(serializedBefore).not.toContain('appearance');
  expect(await page.evaluate(() => localStorage.getItem('typeset-appearance'))).toBe('warm');

  // The source view shares the palette.
  await page.getByRole('button', { name: 'Plain text view', exact: true }).click();
  await expect(page.locator('#source')).toBeVisible();
  const sourceWarm = await colors(page);
  expect(sourceWarm.source).toBe('rgb(252, 251, 247)');
  expect(sourceWarm.sourceInk).toBe('rgb(44, 43, 38)');
  await page.getByRole('button', { name: 'Plain text view', exact: true }).click();
  await expect(page.locator('#source')).toBeHidden();

  // Print restores the publication palette.
  await page.emulateMedia({ media: 'print' });
  const printed = await colors(page);
  expect(printed.ink).toBe('rgb(26, 26, 26)');
  expect(printed.footnote).toBe('rgb(26, 26, 26)');
  await page.emulateMedia({ media: null });

  // Reload: the choice is remembered, with no flash of Standard in the
  // first paint (the attribute is set before the editor mounts).
  await page.reload();
  await page.waitForFunction(() => Boolean(window.view));
  expect((await colors(page)).preset).toBe('warm');
  expect((await colors(page)).sheet).toBe('rgb(252, 251, 247)');

  // Back to Standard.
  await openSettings(page);
  await pickAppearance(page, 'Standard');
  await page.keyboard.press('Escape');
  expect((await colors(page)).sheet).toBe('rgb(255, 255, 255)');
  expect(await page.evaluate(() => localStorage.getItem('typeset-appearance'))).toBeNull();
});
