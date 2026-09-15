import { expect, test } from 'playwright/test';
import { settleLocal } from './settle';

test('auto columns follow late math ink and stop scheduling once its advance is stable', async ({ page }) => {
  test.setTimeout(60_000);
  let resumeCompiler = () => {};
  const gate = new Promise<void>((resolve) => { resumeCompiler = resolve; });
  await page.context().route(/typst_ts_web_compiler_bg\.wasm(?:$|\?)/, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto('/?new=1');
    await page.waitForFunction(() => Boolean(window.view));
    await page.evaluate(() => {
      const { state } = window.view;
      const { table, table_row, table_cell, paragraph, math_inline } = state.schema.nodes;
      const cells = [
        table_cell.create(null, paragraph.create(null, math_inline.create({ src: '\\sum_{n=1}^{20}\\frac{n^2}{n+1}' }))),
        table_cell.create(null, paragraph.create(null, state.schema.text('The fractional column receives the remaining space.'))),
      ];
      window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, table.create({ columnWidths: ['auto', '1fr'], insetPt: 9 }, table_row.create(null, cells))));
    });
    await expect(page.locator('.math-inline .katex')).toHaveCount(1);
    await settleLocal(page);
    const before = await page.locator('.ts-table-sized col').first().evaluate((element) => parseFloat((element as HTMLElement).style.width));
    resumeCompiler();
    await expect(page.locator('.math-inline.math-ink svg')).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => page.locator('.ts-table-sized').evaluate((element) => {
      const col = parseFloat((element.querySelector('col') as HTMLElement).style.width);
      const math = element.querySelector<HTMLElement>('.math-inline')!;
      const style = getComputedStyle(math);
      const advance = math.getBoundingClientRect().width + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
      return Math.abs(col - advance - 24); // 9pt inset on each side = 24px.
    })).toBeLessThan(0.1);
    const after = await page.locator('.ts-table-sized col').first().evaluate((element) => parseFloat((element as HTMLElement).style.width));
    expect(Math.abs(after - before)).toBeGreaterThan(0.1);
    await settleLocal(page);
    const count = await page.evaluate(() => window.__pagCount());
    // An observer watching cell widths can feed table allocation back into
    // itself. Once atom ink settles, there must be no further layout loop.
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.__pagCount())).toBe(count);
  } finally {
    resumeCompiler();
  }
});
