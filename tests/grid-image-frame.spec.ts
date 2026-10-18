import { expect, test } from './fixture';
import { settleLocal } from './settle';

// Demo_C's graphs were image-only paragraphs beside tables. Treating
// those paragraphs as text subtracted a leading from every grid row,
// eventually hiding a page that the PDF needed.
for (const { size, margin } of [{ size: 11, margin: 0.3 }, { size: 13, margin: 1 }]) test(`image-only grid cells keep their full printed frame at ${size}pt and ${margin}in margins`, async ({ page }) => {
  test.setTimeout(90_000);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="264" height="224"><rect width="264" height="224" fill="#38786d"/></svg>').toString('base64');
  const text = [
    '---', `fontsize: ${size}pt`, `margin: ${margin}in`, '---', '', '# Graph worksheet', '',
    ...Array.from({ length: 8 }, (_, i) => [
      `## Exercise ${i + 1}`, '',
      '::::: {.columns gutter=1em}', '', ':::: {.column width=66.667%}', '',
      '::: {.table style=plain inset=4pt columns="auto 1fr"}', '',
      '| Quantity | Answer |', '| :--- | :--- |', '| Market | __________ |', '| Efficient | __________ |', '',
      ':::', '', '::::', '', ':::: {.column width=33.333%}', '',
      `![](data:image/svg+xml;base64,${svg}){width=100%}`, '', '::::', '', ':::::', '',
      `After graph ${i + 1}, explain the difference between the market and efficient quantities.`, '',
    ]).flat(),
  ].join('\n');
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(async text => {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('graph-worksheet.md', { create: true });
    const writable = await file.createWritable();
    await writable.write(text);
    await writable.close();
    await window.__fm.loadHandle(file);
  }, text);
  await expect.poll(() => page.locator('.ts-inline-image img').evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalHeight > 0))).toBe(true);
  await settleLocal(page);
  const geometry = await page.evaluate(async () => {
    const { blockFrameSlackEm } = await import('/src/typ-serializer.ts');
    const { getSettings } = await import('/src/settings.ts');
    const s = getSettings(window.view.state);
    const slack = blockFrameSlackEm(window.view.state.schema.nodes.paragraph.create(), s);
    const F = parseFloat(getComputedStyle(window.view.dom).fontSize);
    return [...document.querySelectorAll('.ProseMirror .ts-grid-row')].map(row => {
      const image = row.querySelector('.ts-inline-image img')!.getBoundingClientRect();
      const table = row.querySelector('table')!.getBoundingClientRect();
      return { imageTop: image.top, tableTop: table.top, rowHeight: row.getBoundingClientRect().height, expectedHeight: image.height + (slack.above + slack.below) * F };
    });
  });
  expect(geometry).toHaveLength(8);
  for (const row of geometry) {
    expect(Math.abs(row.imageTop - row.tableTop), JSON.stringify(row)).toBeLessThan(0.1);
    expect(Math.abs(row.rowHeight - row.expectedHeight), JSON.stringify(row)).toBeLessThan(0.1);
  }
  const report = await page.evaluate(() => window.__audit());
  expect(report).not.toBeNull();
  expect(report!.summary.pagesAgree, JSON.stringify(report!.pages)).toBe(true);
  expect(report!.summary.mismatch).toBe(0);
  expect(report!.summary.typstFail, JSON.stringify(report!.blocks)).toBe(0);
  expect(report!.summary.chromeMismatch).toBe(0);
});
