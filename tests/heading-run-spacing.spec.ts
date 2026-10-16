import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// A heading right after a heading is a run (`= Part two` then `== Its
// first section`). Typst gives both headings explicit block spacing,
// weakness 3 (flow/collect.rs `block`), and keeps the LARGER of the two
// (distribute.rs `keep_spacing`); the editor's boxes add the first
// heading's margin-bottom to the second's padding-top. An H1+H2 run was
// 4.9 px taller on the page than in print, so the paragraph after it lost
// a line at the bottom of page 1 at 1 in margins. The follower's padding
// now gives the sum back (`headingRunPadTopEm`, style.css).
//
// Each case is compiled once with the port audit (`__audit`) and the local
// page starts are compared with Typst's. Margins are set in the test, not
// taken from the defaults: the break depends on where the page bottom
// falls against the paragraph's lines, to the pixel.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagCount: () => number;
    __audit: () => Promise<{
      pages: {
        agree: boolean;
        local: Array<{ pos: number; line: number }>;
        firstDiff: unknown;
      };
    } | null>;
  }
}

const SENTENCE =
  'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';

async function build(page: Page, opts: { marginTop: number; run: Array<[number, string]>; title: string }) {
  await page.goto('/?new=1');
  await page.evaluate(({ sentence, marginTop, run, title }) => {
    const { state } = window.view;
    const { schema } = state;
    const p = (t: string) => schema.nodes.paragraph.create(null, schema.text(t));
    const h = (level: number, t: string) => schema.nodes.heading.create({ level }, schema.text(t));
    const doc = schema.nodes.doc.create(
      { ...state.doc.attrs, settings: { ...state.doc.attrs.settings, marginTop, marginRight: 1, marginBottom: 1, marginLeft: 1 } },
      [h(1, title), p(sentence.repeat(21).trim()), ...run.map(([level, text]) => h(level, text)), p(sentence.repeat(6).trim()), p(sentence.repeat(8).trim())],
    );
    const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
    tr.setDocAttribute('settings', doc.attrs.settings);
    window.view.dispatch(tr);
  }, { sentence: SENTENCE, ...opts });
  await settleLocal(page, 0);
  return page.evaluate(async () => {
    const report = await window.__audit();
    if (!report) throw new Error('port audit: Typst compile failed');
    const blocks: number[] = [];
    window.view.state.doc.forEach((_node, offset) => blocks.push(offset));
    return { pages: report.pages, body: blocks[blocks.length - 2] };
  });
}

// The reported break (tests/sticky-pagination.spec.ts, two consecutive
// headings, at 1 in): page 1 ends with three lines of the paragraph after
// the run in print; the page used to break after two.
test('the paragraph after an H1+H2 run breaks where Typst breaks it', async ({ page }) => {
  test.setTimeout(90_000);
  const { pages, body } = await build(page, {
    marginTop: 1,
    title: 'Sticky run fixture',
    run: [
      [1, 'Part two'],
      [2, 'Its first section'],
    ],
  });
  expect(pages.agree, JSON.stringify(pages.firstDiff)).toBe(true);
  expect(pages.local.map((s) => [s.pos, s.line])).toEqual([[body, 3]]);
});

// The other direction: an H3+H1 run was 4 px SHORTER on the page than in
// print (the H3's spacing below is the smaller one, so Typst's gap is the
// H1's), and the page kept a line Typst moves on.
test('the paragraph after an H3+H1 run breaks where Typst breaks it', async ({ page }) => {
  test.setTimeout(90_000);
  const { pages } = await build(page, {
    marginTop: 1.085,
    title: 'Sweep fixture',
    run: [
      [3, 'First heading'],
      [1, 'Second heading'],
    ],
  });
  expect(pages.agree, JSON.stringify(pages.firstDiff)).toBe(true);
});

// A fraction of a pixel. Typst's heading line is the bold face's cap height
// tall (0.686 em, against the body's 0.683), and the spacings the export
// emits are the page's gaps between frames; the model added the paragraph's
// frame top and bottom as 0.6846 em where the frame is 0.683, and a
// heading's as 0.6846 em where it is 0.686. A run came out 0.1 px shorter
// on the page than in print. At these top margins the page bottom falls
// inside that 0.1 px: the paragraph's next line ran 0.23 px (H1+H3) or
// 0.27 px (H2+H2) past the margin in print, and the page kept it.
for (const { marginTop, run, starts } of [
  { marginTop: 1.16, run: [1, 3], starts: 'line' },
  { marginTop: 1.09, run: [2, 2], starts: 'run' },
] as const) {
  test(`an H${run[0]}+H${run[1]} run at a ${marginTop} in top margin breaks where Typst breaks it`, async ({ page }) => {
    test.setTimeout(90_000);
    const { pages, body } = await build(page, {
      marginTop,
      title: 'Sweep fixture',
      run: [
        [run[0], 'First heading'],
        [run[1], 'Second heading'],
      ],
    });
    expect(pages.agree, JSON.stringify(pages.firstDiff)).toBe(true);
    // H1+H3: two lines of the paragraph after the run stay on page 1, the
    // third starts page 2. H2+H2: the second line does not fit, one line
    // would be an orphan, and the run goes to page 2 with the paragraph.
    const first = await page.evaluate(() => {
      const blocks: number[] = [];
      window.view.state.doc.forEach((_node, offset) => blocks.push(offset));
      return blocks[2];
    });
    expect(pages.local.map((s) => [s.pos, s.line])).toEqual([starts === 'line' ? [body, 2] : [first, 0]]);
  });
}
