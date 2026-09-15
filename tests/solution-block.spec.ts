import { expect, test } from 'playwright/test';
import { settleLocal } from './settle';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
    __audit: () => Promise<{ pages: { agree: boolean } } | null>;
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';

/** A problem-set document whose second solution block crosses the first
 *  page boundary, so the block's own vertical box decides where page 2
 *  starts. */
async function loadProblemSet(page: import('playwright/test').Page) {
  await page.goto('/?new=1');
  await page.evaluate((filler) => {
    const { state } = window.view;
    const { schema } = state;
    const p = schema.nodes.paragraph;
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      schema.nodes.heading.create({ level: 1 }, schema.text('Problem Set 3 Solutions')),
      p.create(null, schema.text('Problem 1. Show that the series converges. ' + filler.repeat(3))),
      schema.nodes.blockquote.create({ kind: 'solution' }, [
        p.create(null, schema.text('Solution. Bound each term by a geometric series. ' + filler.repeat(4))),
        p.create(null, schema.text('The partial sums are therefore Cauchy. ' + filler.repeat(2))),
      ]),
      p.create(null, schema.text('Problem 2. ' + filler.repeat(6))),
      schema.nodes.blockquote.create({ kind: 'solution' }, [p.create(null, schema.text('Solution. ' + filler.repeat(20)))]),
      p.create(null, schema.text('Problem 3. ' + filler.repeat(5))),
      schema.nodes.blockquote.create(null, [p.create(null, schema.text('A plain quote for comparison. ' + filler.repeat(2)))]),
      p.create(null, schema.text('Closing remarks. ' + filler.repeat(4))),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  }, FILLER);
}

test('solution block paginates locally and agrees with Typst', async ({ page }) => {
  test.setTimeout(60_000);
  await loadProblemSet(page);

  // Paint: red text, a left rule that is not part of the layout box, and
  // the same measure as a plain quote (container width minus the 1em
  // inset — nothing fractional for clientWidth to round).
  const paint = await page.evaluate(() =>
    [...document.querySelectorAll('.ProseMirror blockquote')].map((b) => {
      const cs = getComputedStyle(b);
      return {
        kind: (b as HTMLElement).dataset.kind ?? null,
        color: cs.color,
        border: cs.borderLeftWidth,
        measure: b.clientWidth - parseFloat(cs.paddingLeft),
        parent: b.parentElement!.clientWidth - parseFloat(cs.paddingLeft),
      };
    }),
  );
  expect(paint.map((q) => q.kind)).toEqual(['solution', 'solution', null]);
  for (const q of paint) {
    expect(Math.abs(q.measure - q.parent)).toBeLessThan(0.01);
    expect(q.border).toBe('0px');
  }
  expect(paint[0].color).toBe('rgb(192, 0, 0)');
  expect(paint[2].color).not.toBe('rgb(192, 0, 0)');

  await settleLocal(page);

  // Typst splits the long solution mid-block (block is breakable): a page
  // spacer sits INSIDE the second solution block, with no moved-whole gap.
  const gaps = await page.evaluate(() =>
    [...document.querySelectorAll('.ts-pagegap')].map((el) => ({
      inSolution: Boolean(el.closest('blockquote[data-kind="solution"] p')),
      height: parseFloat((el as HTMLElement).style.height),
    })),
  );
  expect(gaps.length).toBeGreaterThanOrEqual(1);
  const inside = gaps.filter((g) => g.inSolution);
  expect(inside.length, JSON.stringify(gaps)).toBeGreaterThanOrEqual(1);
  for (const g of inside) expect(g.height).toBeLessThan(400);

  // The left rule stops at the page's last line and resumes at the next
  // page's first line: the overlay paints one segment per page, and no
  // segment overlaps the spacer's extent.
  const rule = await page.evaluate(() => {
    const gap = document.querySelector<HTMLElement>('blockquote[data-kind="solution"] .ts-pagegap')!;
    const block = gap.closest<HTMLElement>('blockquote[data-kind="solution"]')!;
    const b = block.getBoundingClientRect();
    const g = gap.getBoundingClientRect();
    const segs = [...document.querySelectorAll<HTMLElement>('.ts-solution-rules > div')]
      .map((el) => el.getBoundingClientRect())
      .filter((s) => s.bottom > b.top + 0.5 && s.top < b.bottom - 0.5)
      .map((s) => ({ top: +s.top.toFixed(1), bottom: +s.bottom.toFixed(1), left: +s.left.toFixed(1) }));
    return { block: { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1) }, gap: { top: +g.top.toFixed(1), bottom: +g.bottom.toFixed(1) }, segs };
  });
  expect(rule.segs.length, JSON.stringify(rule)).toBe(2);
  expect(Math.abs(rule.segs[0].top - rule.block.top)).toBeLessThan(0.6);
  expect(Math.abs(rule.segs[0].bottom - rule.gap.top)).toBeLessThan(0.6);
  expect(Math.abs(rule.segs[1].top - rule.gap.bottom)).toBeLessThan(0.6);
  expect(Math.abs(rule.segs[1].bottom - rule.block.bottom)).toBeLessThan(0.6);
  // Centered on the block's left edge: 1pt (4/3 px) left of it.
  for (const seg of rule.segs) expect(Math.abs(seg.left + 4 / 3 - rule.block.left)).toBeLessThan(0.6);

  // Proof for the eye: the split solution block at the page boundary.
  await page.evaluate(() => document.querySelector('blockquote[data-kind="solution"] .ts-pagegap')?.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: test.info().outputPath('solution-page-gap.png') });

  // Vertical parity: the local paginator (editor block heights) lands on
  // the page starts Typst produces — the solution block's box equals its
  // compiled height. Measured by the port audit, never installed.
  const report = await page.evaluate(() => window.__audit());
  expect(report?.pages.agree, JSON.stringify(report?.pages)).toBe(true);
});

test('Extras menu wraps into a solution, re-kinds, and lifts back out', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const p = state.schema.nodes.paragraph;
    const doc = state.schema.nodes.doc.create(state.doc.attrs, [
      p.create(null, state.schema.text('Problem 1.')),
      p.create(null, state.schema.text('Solution body.')),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  });
  await page.click('.ProseMirror p:nth-child(2)');

  const solutionBtn = page.locator('button[title^="Solution block"]');
  const quoteBtn = page.locator('button[title^="Block quote"]');
  const plainBtn = page.locator('button[title^="Plain body text"]');
  const extras = page.getByRole('button', { name: 'Extras', exact: true });
  const blocks = page.locator('.tb-flyout-wrap', { has: page.getByRole('menuitem', { name: 'Blocks', exact: true }) });

  await extras.click();
  await blocks.hover();
  await solutionBtn.click();
  await expect(page.locator('.ProseMirror blockquote[data-kind="solution"] p')).toHaveText('Solution body.');
  await expect(page.locator('.ProseMirror > p', { hasText: 'Solution body.' })).toHaveCount(0);

  // Re-kind in place: the same container becomes a plain quote.
  await extras.click();
  await blocks.hover();
  await quoteBtn.click();
  await expect(page.locator('.ProseMirror blockquote:not([data-kind]) p')).toHaveText('Solution body.');
  await expect(page.locator('.ProseMirror blockquote[data-kind="solution"]')).toHaveCount(0);

  // And back to a solution, then lifted out to body text.
  await extras.click();
  await blocks.hover();
  await solutionBtn.click();
  await expect(page.locator('.ProseMirror blockquote[data-kind="solution"]')).toHaveCount(1);
  await extras.click();
  await blocks.hover();
  await plainBtn.click();
  await expect(page.locator('.ProseMirror blockquote')).toHaveCount(0);
  await expect(page.locator('.ProseMirror > p', { hasText: 'Solution body.' })).toHaveCount(1);
});
