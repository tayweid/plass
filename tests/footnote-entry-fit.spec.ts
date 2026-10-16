import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Footnote entries at a page's foot, measured against Typst with the port
// audit (`__audit`): one long paragraph, footnote markers inserted on
// chosen lines, the top margin set so the page bottom falls where each
// rule decides.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __tableProofSvg: () => Promise<string | null>;
    __audit: () => Promise<{
      pages: { agree: boolean; local: Array<{ pos: number; line: number }>; firstDiff: unknown };
    } | null>;
  }
}

const SENTENCE = 'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';
// Two lines in the entry area (0.85 em text across the full measure).
const NOTE =
  'A note long enough to wrap onto a second line of the entry area at the foot of the page, where Typst keeps the two lines of a footnote together.';

/** The paragraph at `marginTop` (in), a footnote marker inserted mid-line on
 *  each of `lines` (0-based, counted before any marker is in). */
async function paragraphWithNotes(page: Page, marginTop: number, lines: number[]) {
  await page.goto('/?new=1');
  await page.evaluate(({ sentence, marginTop }) => {
    const { state } = window.view;
    const { schema } = state;
    const tr = state.tr.replaceWith(0, state.doc.content.size, schema.nodes.paragraph.create(null, schema.text(sentence.repeat(44).trim())));
    tr.setDocAttribute('settings', { ...state.doc.attrs.settings, marginTop, marginRight: 1, marginBottom: 1, marginLeft: 1 });
    window.view.dispatch(tr);
  }, { sentence: SENTENCE, marginTop });
  await settleLocal(page, 0);
  const before = await page.evaluate(() => window.__pagCount());
  await page.evaluate(({ lines, note }) => {
    const view = window.view;
    const text = view.state.doc.textContent;
    // The third word of each line: inside the line, so the marker's width
    // cannot push it onto the next one.
    const starts: number[][] = [];
    let last = Number.NEGATIVE_INFINITY;
    for (const m of text.matchAll(/\S+/g)) {
      const top = view.coordsAtPos(1 + m.index!, 1).top;
      if (Math.abs(top - last) > 2) starts.push([]);
      starts[starts.length - 1].push(1 + m.index!);
      last = top;
    }
    const { schema } = view.state;
    let tr = view.state.tr;
    for (const k of [...lines].sort((a, b) => b - a)) {
      tr = tr.insert(starts[k][2] - 1, schema.nodes.footnote.create(null, schema.text(note)));
    }
    view.dispatch(tr);
  }, { lines, note: NOTE });
  await settleLocal(page, before);
}

/** The line each page after the first starts at, the page's and Typst's. */
async function pageStarts(page: Page) {
  const report = await page.evaluate(() => window.__audit());
  if (!report) throw new Error('port audit: Typst compile failed');
  return { agree: report.pages.agree, diff: report.pages.firstDiff, local: report.pages.local.map((s) => s.line) };
}

/** Typst's text baselines on the first page, px from its top: each
 *  `.typst-text` group's translates summed below its `.typst-page`. */
function typstBaselinesPage1(svg: string): number[] {
  const pages: number[][] = [];
  const stack: number[] = [];
  const re = /<(\/?)g\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const [, close, attrs, selfClose] = m;
    if (close) {
      stack.pop();
      continue;
    }
    const cls = (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/);
    const tr = /transform="translate\(([-\d.]+)[, ]+([-\d.]+)\)"/.exec(attrs);
    const isPage = cls.includes('typst-page');
    const y = isPage ? 0 : (stack.at(-1) ?? 0) + (tr ? Number(tr[2]) : 0);
    if (isPage) pages.push([]);
    else if (cls.includes('typst-text') && pages.length) pages[pages.length - 1].push(y);
    if (!selfClose) stack.push(y);
  }
  return [...new Set(pages[0])].map((y) => (y * 4) / 3).sort((a, b) => a - b);
}

/** The painted line tops on the first sheet, px from its top: the body's
 *  lines, and each footnote entry's. */
async function paintedLinesPage1(page: Page) {
  return page.evaluate(() => {
    const view = window.view;
    const sheet = document.querySelector<HTMLElement>('#pages .page-box')!.getBoundingClientRect();
    const body = { tops: [] as number[], last: Number.NEGATIVE_INFINITY };
    const notes = { tops: [] as number[], last: Number.NEGATIVE_INFINITY };
    const walk = (from: number, text: string, lines: { tops: number[]; last: number }) => {
      for (const m of text.matchAll(/\S+/g)) {
        const top = view.coordsAtPos(from + m.index!, 1).top - sheet.top;
        if (Math.abs(top - lines.last) > 2 && top < sheet.height) lines.tops.push(top);
        lines.last = top;
      }
    };
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'footnote') {
        notes.last = Number.NEGATIVE_INFINITY;
        walk(pos + 1, node.textContent, notes);
        return false;
      }
      if (node.isText) walk(pos, node.text!, body);
      return true;
    });
    return { body: body.tops, notes: notes.tops.sort((a, b) => a - b) };
  });
}

/** Typst's baseline for each painted line: the deepest text baseline
 *  inside the line's box (a superscript sits higher in it). */
function baselineOffsets(painted: number[], typst: number[], window: [number, number]): number[] {
  return painted.map((top) => {
    const ys = typst.filter((y) => y > top + window[0] && y < top + window[1]);
    return ys.length ? Math.max(...ys) - top : Number.NaN;
  });
}

// A footnote entry is a paragraph to Typst's flow, so its first two lines
// go together: a two-line entry never splits. With room for only one of
// its lines below its marker's line, Typst moves that line to the next
// page with the entry (compose.rs: the first frame is empty, the line
// migrates). The page used to put one line of the entry at the foot and
// carry the other, keeping the marker's line where Typst does not.
test("a two-line footnote takes its marker's line to the next page rather than split", async ({ page }) => {
  test.setTimeout(90_000);
  await paragraphWithNotes(page, 1 + 9 / 96, [32]);
  const starts = await pageStarts(page);
  expect(starts.agree, JSON.stringify(starts.diff)).toBe(true);
  expect(starts.local).toEqual([32]);
});

// Three entries at a page's foot reserve what Typst reserves, to the
// hundredth of a pixel: the clearance and each entry's gap and frame, and
// nothing for the separator rule (a line's frame has no height). Each
// entry was read through offsetHeight (34 px for its 33.52) and the rule
// reserved its 0.5pt stroke: the page ran 2 px short, and at this margin
// moved line 29, which Typst keeps with 0.16 px to spare. A marker no
// longer grows its line: every painted line, the markers' included, sits
// the same distance above Typst's baseline, and so does every entry line.
test('three footnotes reserve what Typst reserves', async ({ page }) => {
  test.setTimeout(90_000);
  await paragraphWithNotes(page, 1 + 6.5 / 96, [2, 5, 8]);
  const starts = await pageStarts(page);
  expect(starts.agree, JSON.stringify(starts.diff)).toBe(true);
  expect(starts.local).toEqual([30]);
  const svg = await page.evaluate(() => window.__tableProofSvg());
  if (!svg) throw new Error('Typst compile failed');
  const typst = typstBaselinesPage1(svg);
  const painted = await paintedLinesPage1(page);
  expect(painted.body.length).toBe(30);
  expect(painted.notes.length).toBe(6);
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  const body = baselineOffsets(painted.body, typst, [8, 24]);
  expect(spread(body), body.map((o) => o.toFixed(3)).join(' ')).toBeLessThan(0.02);
  // Chrome lays each entry's box and its line pitch to 1/64 px, a few
  // hundredths over three entries; the old heights were off half a pixel
  // an entry.
  const notes = baselineOffsets(painted.notes, typst, [4, 17]);
  expect(spread(notes), notes.map((o) => o.toFixed(3)).join(' ')).toBeLessThan(0.1);
});
