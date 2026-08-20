import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
  }
}

// Regression: the SVG sanitizer once stripped the compiled text layer
// (foreignObject .tsel spans), silently failing the page oracle on every
// document. The fallback paginator masked it for plain paragraphs (it splits
// them at line boundaries) but moves list items whole — a long bullet
// crossing a page boundary left a large gap instead of splitting mid-item.
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

  // The compiled page oracle must take authority (not the local fallback).
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


// The oracle is not always the one answering — a long document, a timeout, or
// a compile failure puts the local fallback in charge. It used to move a list
// item whole, which is the same large gap the test above guards against, so it
// has to split inside the item too.
async function fallbackOnly(page: import('playwright/test').Page) {
  await page.goto('/?new=1');
  // Pin the page oracle to fail so the fallback engine is what runs.
  await page.evaluate(() => {
    const oracle = window.__pageOracle as unknown as {
      clear: () => void;
      request: (sig: string) => void;
      results: Map<string, { status: string; reason: string }>;
    };
    oracle.clear();
    oracle.request = (sig: string) => {
      oracle.results.set(sig, { status: 'fail', reason: 'test: page oracle disabled' });
    };
  });
}

const SENTENCE =
  'I think the jump from intro to intermediate is not quite what I have been thinking it is. ';

async function buildLongItem(page: import('playwright/test').Page) {
  await page.evaluate((sentence) => {
    const { state } = window.view;
    const s = state.schema;
    const item = (t: string) => s.nodes.list_item.create(null, s.nodes.paragraph.create(null, s.text(t)));
    const blocks = [
      ...Array.from({ length: 14 }, (_, i) =>
        s.nodes.paragraph.create(null, s.text(`Filler paragraph ${i + 1}. ${sentence}${sentence}`)),
      ),
      s.nodes.bullet_list.create(null, [item(sentence.repeat(14)), item('Short tail item')]),
    ];
    window.view.dispatch(
      state.tr.replaceWith(0, state.doc.content.size, s.nodes.doc.create(state.doc.attrs, blocks).content),
    );
  }, SENTENCE);
  await expect.poll(() => page.locator('.page-box').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(2500);
}

/** Break positions from the last fallback pagination, with the list geometry. */
function readBreaks(page: import('playwright/test').Page) {
  return page.evaluate(() => {
    const doc = window.view.state.doc;
    const items: Array<{ from: number; to: number; firstBlock: number; long: boolean }> = [];
    doc.descendants((n, pos) => {
      if (n.type.name === 'list_item') {
        items.push({ from: pos, to: pos + n.nodeSize, firstBlock: pos + 1, long: n.textContent.length > 400 });
      }
      return true;
    });
    const log = window.__pagLog();
    const entry = log[log.length - 1] ?? '';
    const positions = (entry.split(':')[1] ?? '')
      .split(',')
      .filter(Boolean)
      .map((s) => Number(s.split('@')[0]));
    const heights = (entry.split(':')[1] ?? '')
      .split(',')
      .filter(Boolean)
      .map((s) => Number(s.split('@')[1]));
    return { items, positions, heights };
  });
}

test('a long list item breaks inside itself rather than jumping whole', async ({ page }) => {
  test.setTimeout(60_000);
  await fallbackOnly(page);
  await buildLongItem(page);

  const { items, positions } = await readBreaks(page);
  const long = items.find((i) => i.long)!;
  const inside = positions.filter((p) => p > long.firstBlock && p < long.to - 1);
  expect(inside.length).toBeGreaterThan(0);
});

test('a break never strands a bullet marker on the page above', async ({ page }) => {
  test.setTimeout(60_000);
  await fallbackOnly(page);
  await buildLongItem(page);

  // Moving an item whole must break AT the item, never at the paragraph
  // just inside it — that would leave the bullet behind by itself.
  const { items, positions } = await readBreaks(page);
  for (const item of items) {
    expect(positions).not.toContain(item.firstBlock);
  }
});
