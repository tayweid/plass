import { expect, test, type Page } from 'playwright/test';
import { settleLocal } from './settle';

// The embedded axes from Checkpoint_A_1, reduced to its containing grid.
const AXES = '<svg xmlns="http://www.w3.org/2000/svg" width="250" height="165" viewBox="0 0 250 165"><path d="M18 8V147H242" fill="none" stroke="#999" stroke-width="1"/></svg>';
const SOURCE = `data:image/svg+xml;base64,${Buffer.from(AXES).toString('base64')}`;
const REPLACEMENT = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#38786d"/></svg>';

async function openImages(page: Page) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(async (source) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('images.typ', { create: true });
    const w = await h.createWritable();
    await w.write(`#grid(columns: (1.65fr, 1fr), gutter: 1em, [Question text], [#image("${source}")\n\nNotes below the graph.])\n\n#figure(image("${source}"), caption: [Keep this caption.]) <fig:axes>`);
    await w.close();
    await window.__fm.loadHandle(h);
  }, SOURCE);
  await settleLocal(page);
}

test('replace a selected embedded image directly, preserving its grid, notes, kind and attributes', async ({ page }) => {
  await openImages(page);
  await page.evaluate(() => {
    window.view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') window.view.dispatch(window.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: 'Question axes', title: 'Cost and benefit', widthPct: 75 }));
    });
  });
  const cell = page.locator('.ts-grid-cell').nth(1);
  await cell.locator('.ts-inline-image img').click();
  await expect(page.getByRole('toolbar', { name: 'Image controls' })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  await (await chooser).setFiles({ name: 'replacement.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(REPLACEMENT) });
  await expect.poll(() => page.evaluate(() => {
    let src = '';
    window.view.state.doc.descendants((node) => { if (node.type.name === 'image') src = node.attrs.src; });
    return src;
  })).not.toBe(SOURCE);
  await expect(cell.locator('.ts-inline-image')).toHaveCount(1);
  await expect(cell.locator('.ts-figure')).toHaveCount(0);
  await expect(cell.locator('p').last()).toHaveText('Notes below the graph.');
  await expect(page.locator('.ts-grid-cell').first()).toHaveText('Question text');
  expect(await page.evaluate(() => (window.view.state.selection as any).node.attrs)).toMatchObject({ alt: 'Question axes', title: 'Cost and benefit', widthPct: 75 });
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => (window.view.state.selection as any).node.attrs.src)).toBe(SOURCE);
});

test('figure replacement retains caption, label, size and position; width controls use the containing area', async ({ page }) => {
  await openImages(page);
  const inline = page.locator('.ts-inline-image');
  await inline.locator('img').click();
  await page.getByLabel('Width (%)').fill('50');
  await page.getByLabel('Width (%)').press('Enter');
  const ratio = await inline.evaluate((element) => element.getBoundingClientRect().width / element.parentElement!.getBoundingClientRect().width);
  expect(ratio).toBeCloseTo(0.5, 2);
  await page.getByRole('button', { name: 'Fit to cell', exact: true }).click();
  expect(await inline.evaluate((element) => element.getBoundingClientRect().width / element.parentElement!.getBoundingClientRect().width)).toBeCloseTo(1, 2);
  const figure = page.locator('.ts-figure');
  await figure.locator('img').click();
  await page.getByLabel('Width (%)').fill('60');
  await page.getByLabel('Width (%)').press('Enter');
  const before = await page.evaluate(() => {
    let result: any;
    window.view.state.doc.descendants((node, pos) => { if (node.type.name === 'figure') result = { pos, json: node.toJSON() }; });
    return result;
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  await (await chooser).setFiles({ name: 'replacement.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(REPLACEMENT) });
  await expect.poll(() => page.evaluate((pos) => window.view.state.doc.nodeAt(pos)?.attrs.src, before.pos)).not.toBe(SOURCE);
  const after = await page.evaluate((pos) => window.view.state.doc.nodeAt(pos)!.toJSON(), before.pos);
  expect(after).toEqual({ ...before.json, attrs: { ...before.json.attrs, src: after.attrs.src, name: 'replacement.svg' } });
  await expect(figure.locator('figcaption')).toContainText('Keep this caption.');
  expect(await figure.locator('img').evaluate((element) => element.getBoundingClientRect().width / element.parentElement!.getBoundingClientRect().width)).toBeCloseTo(0.6, 2);
  // Returning to automatic sizing restores the inherited image behavior.
  await page.getByRole('button', { name: 'Auto size', exact: true }).click();
  expect(await page.evaluate((pos) => window.view.state.doc.nodeAt(pos)?.attrs.widthPct, before.pos)).toBeNull();
});

test('an open picker follows its original image through edits and ignores a later selection', async ({ page }) => {
  await openImages(page);
  await page.locator('.ts-inline-image img').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  const picker = await chooser;
  // An edit before the image moves its document position while the picker
  // is pending. Selecting the figure must not redirect the replacement.
  await page.evaluate(() => window.view.dispatch(window.view.state.tr.insertText('Updated ', 4)));
  await page.locator('.ts-figure img').click();
  await picker.setFiles({ name: 'replacement.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(REPLACEMENT) });
  await expect.poll(() => page.evaluate(() => {
    const sources: string[] = [];
    window.view.state.doc.descendants((node) => { if (node.type.name === 'image' || node.type.name === 'figure') sources.push(node.attrs.src); });
    return sources;
  })).toEqual([`data:image/svg+xml;base64,${Buffer.from(REPLACEMENT).toString('base64')}`, SOURCE]);
  await expect(page.locator('.ts-grid-cell').first()).toHaveText('Updated Question text');
  await expect(page.locator('figcaption')).toContainText('Keep this caption.');
});

test('a canceled picker and a deleted target leave remaining document content intact', async ({ page }) => {
  await openImages(page);
  await page.locator('.ts-inline-image img').click();
  const before = await page.evaluate(() => window.view.state.doc.toJSON());
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  await (await chooser).setFiles([]);
  expect(await page.evaluate(() => window.view.state.doc.toJSON())).toEqual(before);
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  const pending = await chooser;
  await page.evaluate(() => {
    const { from, to } = window.view.state.selection;
    window.view.dispatch(window.view.state.tr.delete(from, to));
  });
  const afterDelete = await page.evaluate(() => window.view.state.doc.toJSON());
  await pending.setFiles({ name: 'replacement.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(REPLACEMENT) });
  expect(await page.evaluate(() => window.view.state.doc.toJSON())).toEqual(afterDelete);
  await expect(page.locator('figcaption')).toContainText('Keep this caption.');
});

test('saving the embedded SVG attaches its project, links original bytes, and refreshes external edits', async ({ page }) => {
  await openImages(page);
  await page.evaluate(() => {
    window.showDirectoryPicker = async () => navigator.storage.getDirectory();
  });
  await page.locator('.ts-inline-image img').click();
  await page.getByRole('button', { name: 'Save SVG to project', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.view.state.selection as any).node?.attrs.src)).toMatch(/^figures\/.+\.svg$/);
  const path = await page.evaluate(() => (window.view.state.selection as any).node.attrs.src as string);
  const saved = await page.evaluate(async (path) => {
    const asset = await (window.__fm as any).readAsset(path);
    return new TextDecoder().decode(asset.data);
  }, path);
  expect(saved).toBe(AXES);
  await expect(page.locator('.image-toolbar-source')).toContainText(path);
  await expect(page.locator('.ts-inline-image img')).toHaveJSProperty('naturalWidth', 250);
  await page.evaluate(async ({ path, replacement }) => {
    await (window.__fm as any).writeAsset(path, new Blob([replacement], { type: 'image/svg+xml' }));
    window.dispatchEvent(new Event('focus'));
  }, { path, replacement: REPLACEMENT });
  await expect(page.locator('.ts-inline-image img')).toHaveJSProperty('naturalWidth', 200);
  await expect(page.locator('.ts-grid-cell').nth(1).locator('p').last()).toHaveText('Notes below the graph.');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => (window.view.state.selection as any).node.attrs.src)).toBe(SOURCE);
});

test('project replacement references an existing file in place and handles a canceled native picker', async ({ page }) => {
  await openImages(page);
  await page.evaluate(async (replacement) => {
    const root = await navigator.storage.getDirectory();
    window.showDirectoryPicker = async () => root;
    await (window.__fm as any).attachFolder();
    const handle = await root.getFileHandle('replacement.svg', { create: true });
    const writable = await handle.createWritable();
    await writable.write(replacement);
    await writable.close();
    window.showOpenFilePicker = async () => [handle];
  }, REPLACEMENT);
  await page.locator('.ts-inline-image img').click();
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.view.state.selection as any).node?.attrs.src)).toBe('replacement.svg');
  await expect(page.locator('.ts-inline-image img')).toHaveJSProperty('naturalWidth', 200);
  const before = await page.evaluate(() => window.view.state.doc.toJSON());
  await page.evaluate(() => {
    window.showOpenFilePicker = async () => { throw new DOMException('Canceled', 'AbortError'); };
  });
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  expect(await page.evaluate(() => window.view.state.doc.toJSON())).toEqual(before);
});
