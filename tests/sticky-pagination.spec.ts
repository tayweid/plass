import { expect, test } from 'playwright/test';
import { settleLocal as waitSettled } from './settle';

// PAGE-PORT Phase 3: sticky blocks (Typst's `Distributor::frame` snapshot /
// `finalize` restore, vendor/typst typst-layout/src/flow/distribute.rs
// :340-369, :445-458). Headings are sticky by default (heading.rs:294): a
// heading must never be the last thing on a page, a run of consecutive
// headings migrates as one, and a run that already starts a page cannot
// migrate (the `may_progress` guard, distribute.rs:48-63).
//
// Every scenario drives the app's own instances (`window.view`) and reads
// the local paginator's verdict through the port audit: after each settled
// local pass the document is compiled once and the local page starts are
// diffed against Typst's (`__audit`, never installed). Agreement means the
// local rule reproduced Typst's decision exactly; the pagination log entry
// then tells us WHERE both of them broke the page.

interface StartDiff {
  firstDiffPage: number;
  cause: string;
  localStart: { pos: number; unit: string } | null;
  exactStart: { pos: number; unit: string } | null;
}

interface Settled {
  /** Spacer positions of the settled local pagination. */
  starts: number[];
  /** `__pagCount()` after it, for the next wait. */
  count: number;
  /** The port audit's page comparison against Typst for this revision. */
  agree: boolean;
  diff: StartDiff | null;
}

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
    __pagCount: () => number;
    __audit: () => Promise<{ pages: { agree: boolean; firstDiff: StartDiff | null } } | null>;
  }
}

type Page = import('playwright/test').Page;

const SENTENCE =
  'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';

/** Wait for the local pagination of the current revision to settle, then
 * measure it against Typst with the port audit (one compile, never
 * installed) and return the spacer positions with the comparison. */
async function settleLocal(page: Page, countBefore: number): Promise<Settled> {
  await waitSettled(page, countBefore);
  return page.evaluate(async () => {
    const entry = window.__pagLog().at(-1)!;
    const list = entry.slice(entry.indexOf(']:') + 2);
    const starts = list ? list.split(',').map((s) => Number(s.split('@')[0])) : [];
    const count = window.__pagCount();
    const report = await window.__audit();
    if (!report) throw new Error('port audit: Typst compile failed');
    return { starts, count, agree: report.pages.agree, diff: report.pages.firstDiff };
  });
}

/** Top-level block positions by child index. */
async function blockPositions(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const out: number[] = [];
    window.view.state.doc.forEach((_node, offset) => out.push(offset));
    return out;
  });
}

/** A disagreement this step may report that is NOT the rule under test: a
 * line-level knife edge inside the long filler paragraph (child 1) — the
 * widow/orphan and page-top spacing residuals PAGE-PORT.md's Status block
 * tracks under Phases 2 and 6. Anything touching the heading run or its
 * paragraph, or classified `sticky`, fails the test. */
function residualOutsideSite(last: StartDiff | null, fillerPos: number): boolean {
  if (!last || last.cause === 'sticky') return false;
  const inFiller = (e: { pos: number; unit: string } | null) => !!e && e.pos === fillerPos && e.unit === 'line';
  return inFiller(last.localStart) || inFiller(last.exactStart);
}

/** Append one sentence to the filler paragraph (child 1): the blocks after
 * it walk down the page by about one line. */
async function growFiller(page: Page): Promise<void> {
  await page.evaluate((sentence) => {
    const { state } = window.view;
    const filler = state.doc.child(1);
    const at = state.doc.child(0).nodeSize + 1 + filler.content.size;
    window.view.dispatch(state.tr.insertText(' ' + sentence.trim(), at));
  }, SENTENCE);
}

// A heading that would end a page migrates to the next page with its
// paragraph. The filler before the heading grows one sentence per step, so
// the heading walks across the page-1 boundary: some steps leave it well
// above the bottom (the page breaks inside the paragraph after it), one or
// more would leave it LAST on the page — those must break BEFORE the
// heading instead. The local prediction must agree with Typst at every step.
test('a heading that would be last on a page migrates with its paragraph', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?new=1');
  await page.evaluate((sentence) => {
    const { state } = window.view;
    const { schema } = state;
    const p = (t: string) => schema.nodes.paragraph.create(null, schema.text(t));
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      schema.nodes.heading.create({ level: 1 }, schema.text('Sticky heading fixture')),
      p(sentence.repeat(22).trim()),
      schema.nodes.heading.create({ level: 2 }, schema.text('A section heading near the page bottom')),
      p(sentence.repeat(6).trim()),
      p(sentence.repeat(8).trim()),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  }, SENTENCE);
  let settled = await settleLocal(page, 0);
  let stickyDiffs = 0;

  let agreedMigrations = 0;
  for (let step = 0; step < 12; step++) {
    await growFiller(page);
    settled = await settleLocal(page, settled.count);
    const { starts } = settled;
    if (settled.diff?.cause === 'sticky') stickyDiffs++;
    const [, fillerPos, h2Pos, bodyPos] = await blockPositions(page);

    // The heading never ends a page: no page starts at the body paragraph's
    // block start or at its first line.
    expect(starts, `step ${step}: page starts ${starts}`).not.toContain(bodyPos);
    expect(starts, `step ${step}: page starts ${starts}`).not.toContain(bodyPos + 1);
    if (!settled.agree) {
      expect(residualOutsideSite(settled.diff, fillerPos), `step ${step}: ${JSON.stringify(settled.diff)}`).toBe(true);
    } else if (starts.includes(h2Pos)) {
      agreedMigrations++;
    }
  }
  // At least one step pushed the heading onto the next page, locally and
  // in Typst alike; no disagreement was ever a sticky one.
  expect(agreedMigrations).toBeGreaterThan(0);
  expect(stickyDiffs).toBe(0);
});

// Two consecutive headings are ONE sticky run: the checkpoint sits at the
// first (distribute.rs:358-362 takes it only when no checkpoint is live),
// so a page that would end inside or right after the run breaks before the
// FIRST heading — never between the two.
test('two consecutive headings migrate together', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?new=1');
  await page.evaluate((sentence) => {
    const { state } = window.view;
    const { schema } = state;
    const p = (t: string) => schema.nodes.paragraph.create(null, schema.text(t));
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      schema.nodes.heading.create({ level: 1 }, schema.text('Sticky run fixture')),
      p(sentence.repeat(20).trim()),
      schema.nodes.heading.create({ level: 1 }, schema.text('Part two')),
      schema.nodes.heading.create({ level: 2 }, schema.text('Its first section')),
      p(sentence.repeat(6).trim()),
      p(sentence.repeat(8).trim()),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  }, SENTENCE);
  let settled = await settleLocal(page, 0);
  let stickyDiffs = 0;

  let agreedMigrations = 0;
  for (let step = 0; step < 14; step++) {
    await growFiller(page);
    settled = await settleLocal(page, settled.count);
    const { starts } = settled;
    if (settled.diff?.cause === 'sticky') stickyDiffs++;
    const [, fillerPos, h1Pos, h2Pos, bodyPos] = await blockPositions(page);

    expect(starts, `step ${step}: page starts ${starts}`).not.toContain(h2Pos);
    expect(starts, `step ${step}: page starts ${starts}`).not.toContain(bodyPos);
    expect(starts, `step ${step}: page starts ${starts}`).not.toContain(bodyPos + 1);
    if (!settled.agree) {
      expect(residualOutsideSite(settled.diff, fillerPos), `step ${step}: ${JSON.stringify(settled.diff)}`).toBe(true);
    } else if (starts.includes(h1Pos)) {
      agreedMigrations++;
    }
  }
  expect(agreedMigrations).toBeGreaterThan(0);
  expect(stickyDiffs).toBe(0);
});

// A heading run that already starts a page cannot migrate: `stickable` is
// decided at the run's first block from `regions.may_progress()`, which is
// false at a region top (distribute.rs:48-63, regions.rs:109-111). An
// unbreakable block after the run that does not fit below it moves to the
// next page ALONE; the run stays, and nothing loops or leaves a blank page.
// The pointer the port replaced would have re-migrated the run into a blank
// page here.
test('a heading run already at a page top does not migrate', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?new=1');

  const build = (sentences: number) =>
    page.evaluate(
      ({ sentence, sentences }) => {
        const { state } = window.view;
        const { schema } = state;
        const p = (t: string, keep = false) =>
          schema.nodes.paragraph.create(keep ? { keep: true } : null, schema.text(t));
        const doc = schema.nodes.doc.create(state.doc.attrs, [
          schema.nodes.heading.create({ level: 1 }, schema.text('Page-top run fixture')),
          p(sentence.repeat(3).trim()),
          schema.nodes.page_break.create(),
          schema.nodes.heading.create({ level: 1 }, schema.text('Part two')),
          schema.nodes.heading.create({ level: 2 }, schema.text('A tall unbreakable block follows')),
          p(sentence.repeat(sentences).trim(), true),
          p(sentence.repeat(2).trim()),
        ]);
        window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
      },
      { sentence: SENTENCE, sentences },
    );

  // Size the keep paragraph (Typst: `#block(breakable: false)`) so it fits a
  // page on its own but not below the two headings: measured, not assumed.
  const measure = () =>
    page.evaluate(() => {
      const { doc } = window.view.state;
      const pos = (index: number) => {
        let at = 0;
        for (let i = 0; i < index; i++) at += doc.child(i).nodeSize;
        return at;
      };
      const box = (index: number) => (window.view.nodeDOM(pos(index)) as HTMLElement).getBoundingClientRect();
      const root = getComputedStyle(document.documentElement);
      const pageH = parseFloat(root.getPropertyValue('--page-h'));
      const contentH =
        pageH -
        parseFloat(root.getPropertyValue('--page-margin-top')) -
        parseFloat(root.getPropertyValue('--page-margin-bottom'));
      // The run's span from the first heading's top to the keep block's top.
      const runH = box(5).top - box(3).top;
      return { contentH, runH, keepH: box(5).height };
    });
  let sentences = 24;
  await build(sentences);
  let geometry = await measure();
  for (let attempt = 0; attempt < 8; attempt++) {
    const lo = geometry.contentH - geometry.runH + 8;
    const hi = geometry.contentH - 12;
    if (geometry.keepH > lo && geometry.keepH < hi) break;
    const perSentence = geometry.keepH / sentences;
    sentences = Math.max(1, Math.round((lo + hi) / 2 / perSentence));
    await build(sentences);
    geometry = await measure();
  }
  expect(geometry.keepH).toBeGreaterThan(geometry.contentH - geometry.runH);
  expect(geometry.keepH).toBeLessThan(geometry.contentH);

  // A fresh revision (one more word in the trailing paragraph) so the
  // comparison below is against a publication made after the stats reset.
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText(' Done.', state.doc.content.size - 1));
  });
  const { starts, agree, diff } = await settleLocal(page, 0);
  const [, , , h1Pos, , keepPos] = await blockPositions(page);

  // Page 2 starts at the run (the explicit break); page 3 at the keep block
  // — exactly two page starts, three pages: the run was not re-migrated
  // into a blank page (that would repeat the run's position and add a page).
  expect(starts).toEqual([h1Pos, keepPos]);
  expect(await page.locator('.page-box').count()).toBe(3);
  expect(agree, JSON.stringify(diff)).toBe(true);
});
