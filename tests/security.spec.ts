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
