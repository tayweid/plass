import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

test('native editing and exact whole-document Proof work across supported engines', async ({ page }) => {
  test.setTimeout(75_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const cell = (text: string) => s.nodes.table_cell.create(null, paragraph(text));
    const blocks = [
      s.nodes.paragraph.create(null, [
        s.text('Cross-engine exact formula '),
        s.nodes.math_inline.create({ src: 'x^2 + y^2' }),
        s.text(' remains native around the shared crop.'),
      ]),
      s.nodes.table.create({ style: 'booktabs', caption: 'Cross-engine table' }, [
        s.nodes.table_row.create(null, [cell('ENGINE_CELL'), cell('exact')]),
        s.nodes.table_row.create(null, [cell('value'), cell('42')]),
      ]),
      s.nodes.typst_embed.create(null, s.text('#rect(width: 54pt, height: 8pt)')),
    ];
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, blocks));
  });

  await expect(page.locator('.math-inline')).toHaveAttribute('data-preview-state', 'ready', { timeout: 60_000 });
  await expect(page.locator('.ts-typst-embed')).toHaveAttribute('data-preview-state', 'ready', { timeout: 60_000 });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 60_000 });

  await page.evaluate(() => {
    const { state } = window.view;
    let pos = -1;
    state.doc.descendants((node, nodePos) => {
      if (pos < 0 && node.type.name === 'paragraph' && node.textContent === 'ENGINE_CELL') pos = nodePos;
      return pos < 0;
    });
    if (pos < 0) throw new Error('cross-engine table cell disappeared');
    const selection = state.selection.constructor as typeof import('prosemirror-state').TextSelection;
    window.view.dispatch(state.tr.setSelection(selection.create(state.doc, pos + 1 + 'ENGINE_CELL'.length)));
    window.view.focus();
  });
  await page.keyboard.type('_typed', { delay: 4 });
  await expect(page.locator('td p').first()).toHaveText('ENGINE_CELL_typed');
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 60_000 });

  await page.getByRole('button', { name: 'Proof', exact: true }).click();
  const proof = page.getByRole('dialog', { name: 'Exact Typst proof' });
  await expect(proof.getByRole('status')).toContainText('exact Typst output', { timeout: 60_000 });
  await expect(proof.locator('.typst-proof-document > svg .typst-page')).toHaveCount(1);
});
