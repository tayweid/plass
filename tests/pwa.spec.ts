import { expect, test } from 'playwright/test';

test('manifest has a stable install identity and reachable icons', async ({ request }) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    name: 'Plass',
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
  });
  expect(manifest.icons.map((entry: { sizes: string }) => entry.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512']),
  );
  for (const icon of manifest.icons) {
    expect((await request.get(`/${icon.src}`)).ok()).toBe(true);
  }
});

test('a launch is routed to an existing window, and a window that has the file keeps it', async ({ page, request }) => {
  // Finder double-clicks a file: the browser focuses an existing Plass
  // window instead of opening a blank one (launch_handler), and when that
  // window already shows the file nothing is reloaded.
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.launch_handler.client_mode).toEqual(['focus-existing', 'auto']);

  await page.goto('/?new=1');
  await page.waitForFunction(() => !!(window as unknown as { __openLaunched?: unknown }).__openLaunched);
  const result = await page.evaluate(async () => {
    const app = window as typeof window & {
      view: import('prosemirror-view').EditorView;
      __fm: { loadHandle(handle: FileSystemFileHandle): Promise<boolean> };
      __openLaunched: (files: FileSystemFileHandle[]) => Promise<void>;
    };
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(`launch-${Date.now()}.typ`, { create: true });
    const w = await handle.createWritable();
    await w.write('On disk.\n');
    await w.close();
    await app.__fm.loadHandle(handle);
    // An unsaved edit; a reload would lose it or ask about it.
    app.view.dispatch(app.view.state.tr.insertText('Edited. ', 1));
    let confirms = 0;
    window.confirm = () => { confirms++; return true; };
    await app.__openLaunched([handle]);
    return { text: app.view.state.doc.textContent, confirms, toast: document.getElementById('toast')?.textContent ?? '' };
  });
  expect(result.text).toBe('Edited. On disk.');
  expect(result.confirms).toBe(0);
  expect(result.toast).toContain('is open here');
});

test('Install Plass uses the browser installation prompt when offered', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperties(event, {
      prompt: {
        value: async () => {
          document.documentElement.dataset.installPrompted = 'yes';
        },
      },
      userChoice: {
        value: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
      },
    });
    window.dispatchEvent(event);
  });

  await page.getByRole('button', { name: 'Install Plass' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-install-prompted', 'yes');
});

test('Install Plass explains Safari installation when no prompt is available', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15',
    });
    window.addEventListener('beforeinstallprompt', (event) => event.stopImmediatePropagation());
  });
  await page.goto('/?new=1');

  await page.getByRole('button', { name: 'Install Plass' }).click();
  await expect(page.locator('#toast')).toContainText('File → Add to Dock');
});

test('installed app state removes the redundant Install action', async ({ page }) => {
  await page.goto('/?new=1');
  const install = page.getByRole('button', { name: 'Install Plass' });
  await expect(install).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(install).toBeHidden();
});
