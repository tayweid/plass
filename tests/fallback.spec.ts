import { expect, test } from 'playwright/test';

test('upload/download fallback preserves a Typst document without filesystem APIs', async ({ page }) => {
  await page.addInitScript(() => {
    delete window.showOpenFilePicker;
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
  await page.goto('/?new=1');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.evaluate(() =>
    (window as typeof window & { __fm: { open(): Promise<void> } }).__fm.open(),
  );
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'fallback.typ',
    mimeType: 'text/plain',
    buffer: Buffer.from('= Fallback test\n\nThis document stays local.\n'),
  });

  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText('Fallback test');
  await expect(page.locator('#toast')).toContainText('saving downloads a copy');

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() =>
    (window as typeof window & { __fm: { save(): Promise<void> } }).__fm.save(),
  );
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fallback.typ');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toContain('= Fallback test');
});
