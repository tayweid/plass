import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// A cell fill never hides a table's rules: Typst draws strokes over fills.
// A booktabs table's top and bottom rules used to sit under a filled cell
// in the first or last row, and a grid table's stroke beside a filled cell
// lost the half its neighbour drew (Taylor, 2026-10-13). Read from the
// page's own pixels: the darkest pixel across each rule, over a filled cell
// and over a plain one, must both be ink.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

async function tables(page: Page) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const p = (t: string) => s.nodes.paragraph.create(null, t ? s.text(t) : undefined);
    const cell = (t: string, fill = '', header = false) => (header ? s.nodes.table_header : s.nodes.table_cell).create({ fill }, p(t));
    const table = (style: string) =>
      s.nodes.table.create({ style, caption: '', label: '' }, [
        s.nodes.table_row.create(null, [cell('Test', '', true), cell('Header', '', true), cell('New Col', 'gray-dark', true)]),
        s.nodes.table_row.create(null, [cell('a'), cell('Test'), cell('b')]),
        s.nodes.table_row.create(null, [cell('c'), cell('d'), cell('e', 'gray-dark')]),
      ]);
    // The caret stays in the first paragraph, outside every table.
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [p('Fills and rules.'), table('booktabs'), p('Between.'), table('grid'), p('After.')]));
  });
  await settleLocal(page);
}

/** For each table: the darkest pixel (0–255) across the top rule over the
 *  filled and an unfilled header cell, the bottom rule under the filled and
 *  an unfilled last-row cell, and (grid) the stroke left of the filled cell. */
async function rulePixels(page: Page) {
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext('2d')!;
    g.drawImage(bitmap, 0, 0);
    const dpr = bitmap.width / innerWidth;
    const darkest = (x: number, y: number, vertical: boolean) => {
      let min = 255;
      for (let d = -4; d <= 4; d++) {
        const [r, gr, b] = g.getImageData(Math.round((vertical ? x + d / 2 : x) * dpr), Math.round((vertical ? y : y + d / 2) * dpr), 1, 1).data;
        min = Math.min(min, Math.round((r + gr + b) / 3));
      }
      return min;
    };
    return [...document.querySelectorAll('.ProseMirror table')].map((t) => {
      const rows = t.querySelectorAll('tr');
      const head = rows[0].children;
      const last = rows[2].children;
      const box = (e: Element) => e.getBoundingClientRect();
      const mid = (e: Element) => (box(e).left + box(e).right) / 2;
      return {
        topFilled: darkest(mid(head[2]), box(head[2]).top, false),
        topPlain: darkest(mid(head[1]), box(head[1]).top, false),
        bottomFilled: darkest(mid(last[2]), box(last[2]).bottom, false),
        bottomPlain: darkest(mid(last[1]), box(last[1]).bottom, false),
        sideFilled: darkest(box(last[2]).left, (box(last[2]).top + box(last[2]).bottom) / 2, true),
      };
    });
  }, shot);
}

test('a filled cell never hides a booktabs or grid rule', async ({ page }) => {
  await tables(page);
  const [booktabs, grid] = await rulePixels(page);
  // A missing rule reads as the fill (220) or white; a 1pt stroke at 1x
  // anti-aliases to about 80.
  const INK = 140;
  for (const [name, t] of Object.entries({ booktabs, grid })) {
    expect(t.topPlain, `${name} top rule`).toBeLessThan(INK);
    expect(t.topFilled, `${name} top rule over a fill`).toBeLessThan(INK);
    expect(t.bottomPlain, `${name} bottom rule`).toBeLessThan(INK);
    expect(t.bottomFilled, `${name} bottom rule under a fill`).toBeLessThan(INK);
  }
  expect(grid.sideFilled, 'grid stroke beside a fill').toBeLessThan(INK);
  // Booktabs has no vertical rules: still white there.
  expect(booktabs.sideFilled).toBeGreaterThan(200);
});
