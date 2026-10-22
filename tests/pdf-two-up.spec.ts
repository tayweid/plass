import { readFile } from 'node:fs/promises';
import { expect, test } from './fixture';
import { settleLocal } from './settle';

// PDF, 2 per sheet (src/pdf.ts twoUpSource): the document's pages side by
// side at full size, half Letter on landscape Letter (Taylor, 2026-10-21).
// The app's own Typst places the PDF's pages as images; the test reads
// the sheets' count and size back from the file.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

test('PDF, 2 per sheet: a half-Letter document on landscape Letter sheets, two pages to each', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const words = 'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing. ';
    const paras = Array.from({ length: 14 }, (_, i) => s.nodes.paragraph.create(null, s.text(`${i + 1}. ${words.repeat(4)}`)));
    const tr = state.tr.replaceWith(0, state.doc.content.size, paras);
    tr.setDocAttribute('settings', { ...state.doc.attrs.settings, page: 'half-letter' });
    window.view.dispatch(tr);
  });
  await settleLocal(page);
  const count = (pdf: string) => Number(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/.exec(pdf)?.slice(1).find(Boolean));

  // The document as it prints: its page count.
  const single = page.waitForEvent('download', { timeout: 90_000 });
  await page.locator('#toolbar [aria-label="Export PDF"]').click();
  const pages = count((await readFile((await (await single).path())!)).toString('latin1'));
  expect(pages).toBeGreaterThanOrEqual(3);

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = page.waitForEvent('download', { timeout: 90_000 });
  await page.getByRole('menuitem', { name: 'PDF, 2 per sheet' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Plass (2 per sheet).pdf');
  const text = (await readFile((await file.path())!)).toString('latin1');
  expect(count(text)).toBe(Math.ceil(pages / 2));
  // Landscape Letter: 11 × 8.5 in = 792 × 612 pt.
  const boxes = [...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => `${Math.round(+m[1])}x${Math.round(+m[2])}`);
  expect(new Set(boxes)).toEqual(new Set(['792x612']));
});
