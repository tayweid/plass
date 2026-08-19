import { expect, test } from 'playwright/test';

// The compiled previews are a shared, serialized resource: every table, raw
// island, and oracle batch queues behind one Typst worker. These two cases are
// the ways a real document used to lose previews outright.

test('every table in a table-heavy document renders', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text());
  });
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);

  // Comfortably past the old queue ceiling, which dropped the tail of the
  // document on the floor: the requests were rejected, never retried, and the
  // last tables stayed at "table…" forever.
  const N = 30;
  await page.evaluate((N) => {
    const { state } = window.view;
    const s = state.schema;
    const cell = (t: string) => s.nodes.table_cell.create(null, s.nodes.paragraph.create(null, s.text(t)));
    const blocks = [];
    for (let i = 0; i < N; i++) {
      blocks.push(s.nodes.paragraph.create(null, s.text(`Table ${i + 1} follows.`)));
      blocks.push(
        s.nodes.table.create(null, [
          s.nodes.table_row.create(null, [cell('A'), cell('B')]),
          s.nodes.table_row.create(null, [cell(`r${i}`), cell(`v${i}`)]),
        ]),
      );
    }
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, s.nodes.doc.create(state.doc.attrs, blocks).content));
  }, N);

  await expect.poll(() => page.locator('.ts-table-block').count(), { timeout: 60_000 }).toBe(N);
  // A table that splits across a page renders several fragment SVGs, so the
  // question is whether any table is still waiting — not how many SVGs exist.
  await expect.poll(() => page.locator('.ts-table-loading').count(), { timeout: 120_000, intervals: [500] }).toBe(0);
  expect(warnings.filter((w) => /queue is full/.test(w))).toEqual([]);
});

test('an image path above the project folder degrades to a placeholder', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text());
  });
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);

  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    window.view.dispatch(
      state.tr.replaceWith(
        0,
        state.doc.content.size,
        s.nodes.doc.create(state.doc.attrs, [
          s.nodes.paragraph.create(null, s.text('Before the figure.')),
          s.nodes.figure.create({ src: '../name.png' }, s.text('A caption')),
          s.nodes.paragraph.create(null, s.text('After the figure.')),
        ]).content,
      ),
    );
  });

  // "/../name.png" is not a legal compiler asset path, so registering the
  // reference literally used to fail the whole document compile — the page
  // oracle with it — over one unreachable image.
  await page.waitForTimeout(6_000);
  expect(warnings.filter((w) => /doc svg compile failed/.test(w))).toEqual([]);
  expect(await page.locator('figure').first().getAttribute('data-placeholder')).toContain(
    'outside the project folder',
  );
});
