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
