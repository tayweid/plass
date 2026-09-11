import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __library: typeof import('../src/library-bib');
  }
}

const LIBRARY = `@article{knuth86,
  author = {Knuth, Donald E. and Plass, Michael F.},
  title = {Breaking Paragraphs into Lines},
  journal = {Software: Practice and Experience},
  year = {1981},
}

@book{lamport94,
  author = {Lamport, Leslie},
  title = {{LaTeX}: A Document Preparation System},
  year = {1994},
}

@misc{third, title = {Third}, year = {2000}}
`;

// The library is a .bib outside any document. Its entries appear in the @
// picker beside the document's own; citing one copies THAT entry into the
// document's embedded bibliography, so the document stays self-contained.
test('library entries are offered in the picker and copied into the document on cite', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.__library);
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle(`library-${Date.now()}.bib`, { create: true });
    const w = await file.createWritable();
    await w.write(text);
    await w.close();
    await window.__library.setLibraryHandle(file, 'library.bib');
    window.view.focus();
  }, LIBRARY);
  await page.keyboard.type('See @knu');
  const menu = page.locator('.ref-menu');
  await expect(menu.locator('.ref-menu-item').first()).toContainText('@knuth86');
  await expect(menu.locator('.ref-menu-item').first().locator('.ref-menu-num')).toHaveText('lib');
  await page.keyboard.press('Enter');

  const state = () => page.evaluate(() => {
    const doc = window.view.state.doc;
    const bib = doc.attrs.bib as { name: string; content: string } | null;
    const cites: string[] = [];
    let bibliography = 0;
    doc.descendants((n) => {
      if (n.type.name === 'citation') cites.push(n.attrs.key as string);
      if (n.type.name === 'bibliography') bibliography++;
      return true;
    });
    return { cites, bibliography, bib: bib?.content ?? '', name: bib?.name ?? null };
  });
  let s = await state();
  expect(s.cites).toEqual(['knuth86']);
  expect(s.bibliography).toBe(1);
  expect(s.name).toBe('references.bib');
  expect(s.bib).toContain('@article{knuth86,');
  expect(s.bib).not.toContain('lamport94');

  // A second library entry joins it; citing the first again adds nothing.
  await page.keyboard.type(' and @lam');
  await expect(menu.locator('.ref-menu-item').first()).toContainText('@lamport94');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' then @knu');
  await expect(menu.locator('.ref-menu-item').first()).toContainText('@knuth86');
  await expect(menu.locator('.ref-menu-item').first().locator('.ref-menu-num')).toHaveText('[1]');
  await page.keyboard.press('Enter');
  s = await state();
  expect(s.cites).toEqual(['knuth86', 'lamport94', 'knuth86']);
  expect(s.bib.match(/@article\{knuth86,/g)?.length).toBe(1);
  expect(s.bib).toContain('@book{lamport94,');
  expect(s.bib).not.toContain('third');

  // The export embeds exactly the cited entries.
  const typ = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return docToTyp(window.view.state.doc);
  });
  expect(typ).toContain('#bibliography(bytes(');
  expect(typ).toContain('knuth86');
  expect(typ).toContain('lamport94');
  expect(typ).not.toContain('Third');

  // Forgetting the library leaves the document whole and stops offering
  // library-only keys.
  await page.evaluate(() => window.__library.forgetLibrary());
  await page.keyboard.type(' @thi');
  await expect(menu.locator('.ref-menu-item').filter({ hasText: '@third' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  s = await state();
  expect(s.cites).toEqual(['knuth86', 'lamport94', 'knuth86']);
});
