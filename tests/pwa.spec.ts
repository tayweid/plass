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
