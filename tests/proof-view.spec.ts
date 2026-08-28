import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

test('exact proof preserves Typst page coordinates and final PDF compiles from the same document', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const tableCell = (text: string) => s.nodes.table_cell.create(null, paragraph(text));
    const table = s.nodes.table.create(
      { style: 'booktabs', caption: 'Parity // table caption remains', label: 'tab:parity' },
      [
        s.nodes.table_row.create(null, [tableCell('Visible // cell remains'), tableCell('B')]),
        s.nodes.table_row.create(null, [tableCell('1'), tableCell('2')]),
      ],
    );
    const document = s.nodes.doc.create(state.doc.attrs, [
      s.nodes.heading.create({ level: 1 }, s.text('Exact output contract')),
      paragraph('The proof and PDF share one whole-document serialization and asset boundary.'),
      s.nodes.paragraph.create(null, [
        s.text('Literal // after comment opener remains. Code: '),
        s.text('alpha ` beta', [s.marks.code.create()]),
      ]),
      table,
      s.nodes.typst_embed.create(null, s.text('#line(length: 100%)')),
      s.nodes.page_break.create(),
      s.nodes.heading.create({ level: 2 }, s.text('Second physical page')),
      paragraph('Content after an explicit page break must remain on page two.'),
    ]);
    window.view.dispatch(
      state.tr.replaceWith(0, state.doc.content.size, document.content).setMeta('addToHistory', false),
    );
  });

  await page.getByRole('button', { name: 'Proof', exact: true }).click();
  const proof = page.getByRole('dialog', { name: 'Exact Typst proof' });
  await expect(proof).toBeVisible();
  // The table caption contains a literal `//`; without serializer escaping it
  // comments out the closing bracket and this exact compile fails. The proof
  // intentionally strips Typst's foreignObject text-selection layer, so
  // readiness—not DOM textContent—is the faithful assertion here.
  await expect(proof.getByRole('status')).toContainText('2 pages · exact Typst output', { timeout: 30_000 });

  const transcript = proof.locator('.typst-proof-transcript');
  await expect(transcript).toHaveAttribute('role', 'document');
  await expect(transcript).toHaveAttribute('aria-label', 'Current document');
  await expect(transcript).toContainText('Exact output contract');
  await expect(transcript).toContainText('Visible // cell remains');
  await expect(transcript.locator('table caption')).toHaveText('Table 1: Parity // table caption remains');
  await expect(transcript).toContainText('#line(length: 100%)');
  await expect(proof.locator('.typst-proof-document')).toHaveAttribute('aria-hidden', 'true');

  const svg = proof.locator('.typst-proof-document > svg');
  await expect(svg).toHaveAttribute('width', '612.000');
  await expect(svg).toHaveAttribute('data-proof-pages', '2');
  await expect(svg).toHaveAttribute('data-proof-page-gap-pt', '18');
  await expect(svg.locator('.typst-page')).toHaveCount(2);
  await expect(svg.locator('.typst-proof-page-offset')).toHaveCount(2);
  await expect(svg.locator('.typst-proof-paper')).toHaveCount(2);
  await expect(svg.locator('.typst-proof-paper').nth(0)).toHaveAttribute('height', '792');
  await expect(svg.locator('.typst-proof-paper').nth(1)).toHaveAttribute('y', '792');

  const proofPaint = await proof.evaluate((element) => ({
    overlay: getComputedStyle(element).backgroundColor,
    opacity: getComputedStyle(element).opacity,
    animationName: getComputedStyle(element).animationName,
    bar: getComputedStyle(element.querySelector('.typst-proof-bar')!).backgroundColor,
    paper: getComputedStyle(element.querySelector('.typst-proof-paper')!).fill,
  }));
  expect(proofPaint).toEqual({
    overlay: 'rgb(233, 231, 226)',
    opacity: '1',
    animationName: 'none',
    bar: 'rgb(249, 248, 245)',
    paper: 'rgb(255, 255, 255)',
  });

  // Page presentation adds only an outer gap transform. Typst's own page
  // coordinate systems are unchanged, which keeps proof content exact.
  expect(await svg.locator('.typst-page').nth(0).getAttribute('transform')).toBe('translate(0, 0)');
  expect(await svg.locator('.typst-page').nth(1).getAttribute('transform')).toBe('translate(0, 792)');
  expect(await svg.locator('.typst-proof-page-offset').nth(0).getAttribute('transform')).toBe('translate(0 0)');
  expect(await svg.locator('.typst-proof-page-offset').nth(1).getAttribute('transform')).toBe('translate(0 18)');

  await page.keyboard.press('Tab');
  await expect(proof.getByRole('button', { name: 'Back to editing' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(proof).toHaveCount(0);

  // Exercise the product export path, not a second test-only module import.
  // Both actions therefore read the same live FileManager document, while
  // compileDocSvg and compileDocPdf share prepareDocumentCompileInput.
  const pdfButton = page.locator('button[title="Export PDF via Typst"]');
  const exportWrap = page.locator('.tb-flyout-wrap', { has: pdfButton });
  await exportWrap.hover();
  const downloadPromise = page.waitForEvent('download');
  await pdfButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Plass.pdf');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const pdf = Buffer.concat(chunks);
  expect(pdf.subarray(0, 8).toString('latin1')).toMatch(/^%PDF-/);
  expect(pdf.byteLength).toBeGreaterThan(1_000);
});

test('ordinary language-labelled code has the same plain paint as native code', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const { compileDocSvg } = await import('/src/pdf.ts');
    const { docToTyp } = await import('/src/typ-serializer.ts');
    const { state } = window.view;
    const s = state.schema;
    const source = 'def classify(value):\n    return value + 42  # plain native paint';
    const make = (params: string) => s.nodes.doc.create(state.doc.attrs, [
      s.nodes.code_block.create({ params }, s.text(source)),
    ]);
    const labelled = make('python');
    const unlabelled = make('');
    const [labelledSvg, unlabelledSvg] = await Promise.all([
      compileDocSvg(labelled),
      compileDocSvg(unlabelled),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, labelled.content));
    return {
      source,
      identicalPaint: labelledSvg === unlabelledSvg,
      exportSource: docToTyp(labelled),
    };
  });

  expect(result.identicalPaint).toBe(true);
  expect(result.exportSource).toContain('// typeset:code-block-params "python"');
  expect(result.exportSource).toContain('#raw("def classify(value):\\n');
  expect(result.exportSource).not.toContain('```python');
  const code = page.locator('.ProseMirror > pre > code');
  await expect(code).toHaveText(result.source);
  expect(await code.locator('*').count()).toBe(0);

  await page.getByRole('button', { name: 'Proof', exact: true }).click();
  const proof = page.getByRole('dialog', { name: 'Exact Typst proof' });
  await expect(proof.getByRole('status')).toContainText('exact Typst output', { timeout: 30_000 });
  await expect(proof.locator('.typst-proof-document > svg')).toHaveCount(1);
});
