import { expect, test } from 'playwright/test';

// Raw islands and oracle batches share the serialized Typst worker. Native
// tables stay directly editable and must never recreate the deleted per-table
// preview queue.

test('every table in a table-heavy document stays native and editable', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text());
  });
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);

  // Comfortably past the old preview-queue ceiling. Native tables should all
  // mount immediately without compiled placeholder or loading DOM.
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

  await expect(page.locator('.ProseMirror table')).toHaveCount(N);
  await expect(page.locator('.ProseMirror table').last()).toContainText(`r${N - 1}`);
  await expect(page.locator('.ts-table-block, .ts-table-preview, .ts-table-loading')).toHaveCount(0);
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
