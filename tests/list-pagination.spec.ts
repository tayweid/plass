import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
  }
}

// Regression: the SVG sanitizer once stripped the compiled text layer
// (foreignObject .tsel spans), silently failing the page oracle on every
// document. The retired browser-geometry paginator once masked this for plain
// paragraphs but moved list items whole — a long bullet crossing a page
// boundary left a large gap instead of splitting mid-item.
test('page oracle splits a long bullet across the page boundary', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const { schema } = state;
    const p = schema.nodes.paragraph;
    const li = schema.nodes.list_item;
    const filler =
      'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      schema.nodes.heading.create({ level: 1 }, schema.text('Fall 2024 Notes')),
      schema.nodes.bullet_list.create(null, [
        li.create(null, p.create(null, schema.text('A short first bullet that spans about two lines when justified at the page measure. '))),
        li.create(null, p.create(null, schema.text(`Second bullet. ${filler.repeat(20)}`))),
        li.create(null, p.create(null, schema.text(`Third bullet. ${filler.repeat(28)}`))),
        li.create(null, p.create(null, schema.text('A short trailing bullet.'))),
      ]),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });

  // The compiled page oracle must take authority.
  await expect
    .poll(
      () => page.evaluate(() => window.__pagLog().at(-1)?.startsWith('exact[') ?? false),
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);

  // Typst splits the long bullets mid-item: every page spacer must sit
  // INSIDE a list-item paragraph, and the bullets stay on consecutive pages
  // without the moved-whole gap.
  const spacers = await page.evaluate(() =>
    [...document.querySelectorAll('.ts-pagegap')].map((el) => ({
      insideListItem: Boolean(el.closest('li > p')),
      height: parseFloat((el as HTMLElement).style.height),
    })),
  );
  expect(spacers.length).toBeGreaterThanOrEqual(2);
  for (const spacer of spacers) {
    expect(spacer.insideListItem).toBe(true);
    // A moved-whole bullet manufactures a gap of hundreds of px; a mid-item
    // split's spacer is page-gap + margins only.
    expect(spacer.height).toBeLessThan(400);
  }
});

// Typst encodes every selection run's physical rectangle on its surrounding
// SVG foreignObject. Browser HTML text metrics are not authoritative and can
// transiently differ on a cold Linux font load. A poisoned inner text box
// must therefore have no effect on compiled line/page extraction.
test('page oracle ignores browser text boxes and reads compiled SVG geometry', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const realBounds = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList?.contains('tsel')) return new DOMRect(0, 0, 4_000, 4_000);
      return realBounds.call(this);
    };

    const { state } = window.view;
    const paragraphs = Array.from({ length: 40 }, (_, index) =>
      state.schema.nodes.paragraph.create(
        null,
        state.schema.text(
          `Geometry paragraph ${index + 1}. ` +
            'Physical lines come from the compiler SVG rather than a browser fallback font. '.repeat(5),
        ),
      ),
    );
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraphs));
  });

  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect.poll(() => page.locator('.page-box').count()).toBeGreaterThan(1);
  await expect.poll(() => page.locator('.ts-pagegap').count()).toBeGreaterThan(0);
});


// Fail closed: a compiler failure must remove every mapped page artifact and
// advertise continuous editing instead of inventing browser-geometry pages.
test('page-oracle failure becomes explicit continuous editing with no page artifacts', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const paragraphs = Array.from({ length: 40 }, (_, index) =>
      state.schema.nodes.paragraph.create(
        null,
        state.schema.text(
          `Paragraph ${index + 1}. ` +
            'Exact pagination comes only from the full-document Typst snapshot. '.repeat(5),
        ),
      ),
    );
    const doc = state.schema.nodes.doc.create(state.doc.attrs, paragraphs);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });

  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect.poll(() => page.locator('.page-box').count()).toBeGreaterThan(1);
  await expect.poll(() => page.locator('.ts-pagegap').count()).toBeGreaterThan(0);

  await page.evaluate(() => {
    const oracle = window.__pageOracle as unknown as {
      get: (sig: string) => unknown;
      request: (...args: unknown[]) => void;
      __realGet?: (sig: string) => unknown;
      __realRequest?: (...args: unknown[]) => void;
    };
    oracle.__realGet = oracle.get.bind(oracle);
    oracle.__realRequest = oracle.request.bind(oracle);
    oracle.get = () => ({ status: 'fail', reason: 'test: exact page map unavailable' });
    oracle.request = () => {};
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Failure probe. ', 1));
  });

  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'continuous', { timeout: 15_000 });
  await expect(page.locator('.page-box')).toHaveCount(0);
  await expect(page.locator('.page-num')).toHaveCount(0);
  await expect(page.locator('.ts-pagegap')).toHaveCount(0);
  await expect(page.locator('#hud')).toContainText('Continuous edit · Exact Proof');
  await expect(page.locator('#hud')).toHaveAttribute('role', 'button');
  await page.locator('#hud').click();
  const proof = page.getByRole('dialog', { name: 'Exact Typst proof' });
  await expect(proof).toBeVisible();
  await expect(proof.getByRole('status')).toContainText('exact Typst output', { timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(proof).toHaveCount(0);

  // Repeated edits and settle passes cannot resurrect the obsolete exact
  // basis after the failure latch has closed.
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Still continuous. ', 1));
  });
  await page.waitForTimeout(1_200);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'continuous');
  await expect(page.locator('.page-box')).toHaveCount(0);
  await expect(page.locator('.ts-pagegap')).toHaveCount(0);
});

test('abandoned page starts stay gone while pending and return only after a new exact success', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const paragraphs = Array.from({ length: 34 }, (_, index) =>
      state.schema.nodes.paragraph.create(
        null,
        state.schema.text(`Recovery paragraph ${index + 1}. ` + 'The exact oracle owns every page start. '.repeat(7)),
      ),
    );
    window.view.dispatch(
      state.tr.replaceWith(
        0,
        state.doc.content.size,
        state.schema.nodes.doc.create(state.doc.attrs, paragraphs).content,
      ),
    );
  });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });

  await page.evaluate(() => {
    const oracle = window.__pageOracle as unknown as {
      clear: () => void;
      get: (sig: string) => unknown;
      request: (...args: unknown[]) => void;
      __realGet?: (sig: string) => unknown;
      __realRequest?: (...args: unknown[]) => void;
    };
    oracle.__realGet = oracle.get.bind(oracle);
    oracle.__realRequest = oracle.request.bind(oracle);
    oracle.get = () => ({ status: 'fail', reason: 'test: abandon exact basis' });
    oracle.request = () => {};
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Abandon. ', 1));
  });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'continuous', { timeout: 15_000 });

  // A later request may be pending, but that state alone cannot reopen the
  // old mapped basis.
  await page.evaluate(() => {
    const oracle = window.__pageOracle as unknown as {
      clear: () => void;
      get: (sig: string) => unknown;
      request: (...args: unknown[]) => void;
      __realGet: (sig: string) => unknown;
    };
    oracle.clear();
    oracle.get = oracle.__realGet;
    oracle.request = () => {};
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Pending. ', 1));
  });
  await page.waitForTimeout(1_200);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'continuous');
  await expect(page.locator('.ts-pagegap')).toHaveCount(0);

  // Only a newly compiled exact snapshot restores page chrome and spacers.
  await page.evaluate(() => {
    const oracle = window.__pageOracle as unknown as {
      clear: () => void;
      request: (...args: unknown[]) => void;
      __realRequest: (...args: unknown[]) => void;
    };
    oracle.clear();
    oracle.request = oracle.__realRequest;
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Recovered. ', 1));
  });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect.poll(() => page.locator('.page-box').count()).toBeGreaterThan(1);
  await expect.poll(() => page.locator('.ts-pagegap').count()).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__pagLog().at(-1)?.startsWith('exact['))).toBe(true);
});
