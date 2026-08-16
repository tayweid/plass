import { expect, test } from 'playwright/test';

test('Typst SVG boundary strips active content and preserves safe glyph references', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const { mountTypstSvg } = await import('/src/safe-svg.ts');
    const host = document.createElement('div');
    mountTypstSvg(
      host,
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <script data-bad="script">globalThis.compromised = true</script>
        <foreignObject data-bad="foreign"><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject>
        <image data-bad="remote-image" href="https://tracker.invalid/pixel.png" onerror="globalThis.compromised = true"/>
        <a data-bad="js-link" xlink:href="javascript:alert(1)" onclick="globalThis.compromised = true"><text>bad</text></a>
        <a data-safe="web-link" href="https://example.com/paper"><text>safe</text></a>
        <path id="glyph" d="M0 0"/>
        <use data-safe="glyph" href="#glyph"/>
      </svg>`,
    );
    const attrs = [...host.querySelectorAll('*')].flatMap((el) =>
      el.getAttributeNames().map((name) => `${name}=${el.getAttribute(name)}`),
    );
    return {
      activeElements: host.querySelectorAll('script, foreignObject, iframe, object, embed').length,
      remoteImageHref: host.querySelector('[data-bad="remote-image"]')?.getAttribute('href') ?? null,
      jsHref: host.querySelector('[data-bad="js-link"]')?.getAttribute('href') ??
        host.querySelector('[data-bad="js-link"]')?.getAttribute('xlink:href') ?? null,
      eventAttrs: attrs.filter((attr) => /^on/i.test(attr)),
      safeHref: host.querySelector('[data-safe="web-link"]')?.getAttribute('href') ?? null,
      safeRel: host.querySelector('[data-safe="web-link"]')?.getAttribute('rel') ?? null,
      glyphHref: host.querySelector('[data-safe="glyph"]')?.getAttribute('href') ??
        host.querySelector('[data-safe="glyph"]')?.getAttribute('xlink:href') ?? null,
      compromised: Boolean((globalThis as typeof globalThis & { compromised?: boolean }).compromised),
    };
  });

  expect(result.activeElements).toBe(0);
  expect(result.remoteImageHref).toBeNull();
  expect(result.jsHref).toBeNull();
  expect(result.eventAttrs).toEqual([]);
  expect(result.safeHref).toBe('https://example.com/paper');
  expect(result.safeRel).toContain('noopener');
  expect(result.glyphHref).toBe('#glyph');
  expect(result.compromised).toBe(false);
});

test('hostile bibliography values never become autocomplete markup', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const content = `
@article{safe-key,
  author = {Example, Alice},
  title = {<img src=x onerror=alert(1)>},
  year = {2026}
}
@article{<img/src=x/onerror=alert(1)>, title={Invalid Key}}
`;
    app.view.dispatch(app.view.state.tr.setDocAttribute('bib', { name: 'hostile.bib', content }));
  });

  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await editor.click();
  await page.keyboard.type('@');
  await expect(page.locator('.ref-menu')).toBeVisible();
  await expect(page.locator('.ref-menu img')).toHaveCount(0);
  await expect(page.locator('.ref-menu')).toContainText('<img src=x onerror=alert(1');
  await expect(page.locator('.ref-menu')).not.toContainText('Invalid Key');
});

test('compiled bibliography SVG cannot restore a dangerous URL', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const citation = state.schema.nodes.citation.create({ key: 'safe' });
    const bibliography = state.schema.nodes.bibliography.create();
    let tr = state.tr.replaceWith(1, 1, citation);
    tr = tr.insert(tr.doc.content.size, bibliography);
    tr = tr.setDocAttribute('bib', {
      name: 'hostile-link.bib',
      content: '@misc{safe, title={Link Probe}, author={Example, Alice}, year={2026}, url={javascript:alert(1)}}',
    });
    app.view.dispatch(tr);
  });

  const ink = page.locator('.bib-ink');
  await expect(ink.locator('svg')).toBeVisible({ timeout: 20_000 });
  await expect(ink.locator('use')).not.toHaveCount(0);
  const active = await ink.locator('*').evaluateAll((els) =>
    els.flatMap((el) =>
      el.getAttributeNames()
        .filter((name) => name.startsWith('on') || /^(?:href|xlink:href)$/i.test(name))
        .map((name) => `${name}=${el.getAttribute(name)}`),
    ),
  );
  expect(active.some((attr) => /javascript:/i.test(attr))).toBe(false);
  expect(active.some((attr) => /^on/i.test(attr))).toBe(false);
});

test('compiler watchdog stops a stuck job without freezing the UI and then recovers', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const { testCompilerWatchdog } = await import('/src/typst-worker-client.ts');
    let uiTicks = 0;
    const timer = window.setInterval(() => uiTicks++, 10);
    const started = performance.now();
    const error = await testCompilerWatchdog();
    const watchdogMs = performance.now() - started;
    window.clearInterval(timer);

    // The timed-out worker is discarded. Both rendering paths must work on
    // the freshly-created replacement, proving a poisoned compiler session
    // cannot strand later previews or exports.
    const { compileSvg, compileTyp } = await import('/src/pdf.ts');
    const svg = await compileSvg('[worker recovered]');
    const pdf = await compileTyp('[worker recovered]');
    return {
      code: error.code,
      watchdogMs,
      uiTicks,
      hasSvg: svg?.includes('<svg') ?? false,
      pdfHeader: pdf ? new TextDecoder().decode(pdf.slice(0, 5)) : '',
    };
  });

  expect(result.code).toBe('timeout');
  expect(result.watchdogMs).toBeLessThan(2_000);
  expect(result.uiTicks).toBeGreaterThan(0);
  expect(result.hasSvg).toBe(true);
  expect(result.pdfHeader).toBe('%PDF-');
});

test('remote images make no request until the user grants their origin', async ({ page }) => {
  let requests = 0;
  await page.route('https://remote.test/pixel.png', async (route) => {
    requests++;
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });

  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const src = 'https://remote.test/pixel.png';
    const figure = state.schema.nodes.figure.create({ src }, state.schema.text('Remote figure'));
    const inline = state.schema.nodes.image.create({ src, alt: 'Remote inline image' });
    const paragraph = state.schema.nodes.paragraph.create(null, [state.schema.text('Inline: '), inline]);
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [figure, paragraph]));
  });

  const figure = page.locator('.ts-figure');
  const inline = page.locator('.ts-inline-image');
  await expect(figure.locator('.fig-path-chip.remote')).toBeVisible();
  await expect(inline.locator('.inline-image-action')).toContainText('Load image from remote.test');
  await page.waitForTimeout(1_000);

  expect(requests).toBe(0);
  await expect(figure.locator('img')).not.toHaveAttribute('src', /remote\.test/);
  await expect(inline.locator('img')).not.toHaveAttribute('src', /remote\.test/);

  await figure.locator('.fig-path-chip.remote').click();
  await expect.poll(() => requests).toBe(1);
  await expect(figure.locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(inline.locator('img')).toHaveAttribute('src', /^blob:/);
  // Both node views and background export code share a one-fetch byte cache.
  expect(requests).toBe(1);
});

test('embedded SVG images cannot smuggle an automatic remote subrequest', async ({ page }) => {
  let requests = 0;
  await page.route('https://tracker.test/pixel.png', async (route) => {
    requests++;
    await route.abort();
  });
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
      <image href="https://tracker.test/pixel.png" width="20" height="20"/>
      <script>alert(1)</script>
    </svg>`;
    const src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const figure = state.schema.nodes.figure.create({ src }, state.schema.text('Embedded SVG'));
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, figure));
  });

  await expect(page.locator('.ts-figure img')).toHaveAttribute('src', /^blob:/);
  await page.waitForTimeout(500);
  expect(requests).toBe(0);
});

test('a failed approved image is retried only by another user action', async ({ page }) => {
  let requests = 0;
  await page.route('https://flaky.test/pixel.png', async (route) => {
    requests++;
    if (requests === 1) {
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const figure = state.schema.nodes.figure.create(
      { src: 'https://flaky.test/pixel.png' },
      state.schema.text('Flaky figure'),
    );
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, figure));
  });

  await page.locator('.fig-path-chip.remote').click();
  await expect(page.locator('.fig-path-chip.remote-error')).toContainText('retry from flaky.test');
  await page.waitForTimeout(750);
  expect(requests).toBe(1);

  await page.locator('.fig-path-chip.remote-error').click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator('.ts-figure img')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('.fig-path-chip.remote-error')).toHaveCount(0);
});
