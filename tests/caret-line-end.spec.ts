import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// A caret at the end of a wrapped line (src/caret-box.ts): the position
// just before the space the line breaks at. The editor's `white-space:
// normal` collapses that space between the line's last word and the
// layout's `<br class="ts-br">`, so ProseMirror's default measure of the
// caret (side 1, the character after it) is an all-zero box, and the
// caret is drawn at the end of its line, side -1's box. What read the
// caret there: the scroll rail's caret mark, and the pass that holds a
// followed caret still on the screen (paperPass).

type Hooks = {
  view: import('prosemirror-view').EditorView;
  __loadDemo: () => void;
  __pagCount: () => number;
};

async function demo(page: Page) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as Hooks).view && (window as unknown as Hooks).__loadDemo));
  await page.evaluate(() => (window as unknown as Hooks).__loadDemo());
  await settleLocal(page);
}

/** Every line end in the document: the position before a break space, the
 *  stack y of its line, the sheet that holds it. */
const lineEnds = (page: Page) =>
  page.evaluate(() => {
    const { view } = window as unknown as Hooks;
    const stack = document.getElementById('stack')!.getBoundingClientRect();
    const sheets = [...document.querySelectorAll('#pages .page-box')].map((el) => el.getBoundingClientRect().top - stack.top);
    const out: Array<{ pos: number; y: number; page: number }> = [];
    for (const br of view.dom.querySelectorAll('br.ts-br')) {
      const pos = view.posAtDOM(br, 0);
      if (view.state.doc.textBetween(pos - 1, pos) !== ' ') continue;
      const y = br.getBoundingClientRect().top - stack.top;
      out.push({ pos: pos - 1, y, page: sheets.filter((top) => top <= y).length });
    }
    return out;
  });

/** The caret's state: whether it is at a line end, whether side 1 reads an
 *  empty box there, and its drawn top in the window. */
const caretState = (page: Page) =>
  page.evaluate(() => {
    const { view } = window as unknown as Hooks;
    const head = view.state.selection.head;
    const side1 = view.coordsAtPos(head);
    const empty = !(side1.bottom > side1.top);
    const atLineEnd =
      view.state.doc.textBetween(head, Math.min(head + 1, view.state.doc.content.size)) === ' ' &&
      [...view.dom.querySelectorAll('br.ts-br, .ts-pagegap')].some((el) => view.posAtDOM(el, 0) === head + 1);
    return { head, atLineEnd, empty, top: (empty ? view.coordsAtPos(head, -1) : side1).top };
  });

/** Scroll the panel so a stack y is at its middle. */
const centre = (page: Page, y: number) =>
  page.evaluate((y) => {
    const panel = document.getElementById('scroll')!;
    const stack = document.getElementById('stack')!;
    const scale = stack.getBoundingClientRect().width / stack.offsetWidth;
    const top = stack.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
    panel.scrollTop = top + y * scale - panel.clientHeight / 2;
  }, y);

test("the rail's caret mark at a line end is on its line's page", async ({ page }) => {
  test.setTimeout(90_000);
  await demo(page);
  // The mark moves in the frame after a selection that moved without an
  // edit (scroll-rail.ts, `selection`); on a busy runner that frame can come
  // late, so the mark is read once it has held still for three frames.
  const mark = (pos: number) =>
    page.evaluate(async (pos) => {
      const { view } = window as unknown as Hooks;
      const TS = view.state.selection.constructor as typeof import('prosemirror-state').TextSelection;
      view.dispatch(view.state.tr.setSelection(TS.create(view.state.doc, pos)));
      const el = document.querySelector<HTMLElement>('#scrollrail .sr-caret')!;
      const read = () => ({ f: parseFloat(el.style.getPropertyValue('--f')), label: el.getAttribute('aria-label') ?? '' });
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      await frame();
      await frame();
      let last = read();
      for (let still = 0, n = 0; still < 3 && n < 120; n++) {
        await frame();
        const now = read();
        still = now.f === last.f && now.label === last.label ? still + 1 : 0;
        last = now;
      }
      return last;
    }, pos);
  // The demo can still reflow after its first settled pass (a late load
  // moves its page starts): the three marks are taken again whenever the
  // line end they were taken at is no longer one once they are read.
  let end: { pos: number; y: number; page: number } | undefined;
  let before = { f: 0, label: '' };
  let atEnd = before;
  let after = before;
  let atEndState = { atLineEnd: false, empty: false };
  for (let attempt = 0; attempt < 4; attempt++) {
    await settleLocal(page);
    end = (await lineEnds(page)).find((e) => e.page === 2);
    expect(end, 'a line end on page 2').toBeTruthy();
    before = await mark(end!.pos - 1);
    expect((await caretState(page)).atLineEnd, 'one before the line end is mid-line').toBe(false);
    atEnd = await mark(end!.pos);
    atEndState = await caretState(page);
    after = await mark(end!.pos + 1);
    if ((await lineEnds(page)).some((e) => e.pos === end!.pos && e.page === 2)) break;
  }
  // The case: side 1 measures nothing at the line end.
  expect(atEndState).toMatchObject({ atLineEnd: true, empty: true });
  for (const m of [before, atEnd, after]) expect(m.label).toMatch(/, page 2$/);
  // The line end is on the line of the letter before it; the start of the
  // next line, one further, is below.
  expect(Math.abs(atEnd.f - before.f)).toBeLessThan(1e-3);
  expect(after.f).toBeGreaterThan(atEnd.f);
});

test('a pass that carries the followed caret to the end of the line above holds the page still', async ({ page }) => {
  test.setTimeout(150_000);
  await demo(page);
  // A line's first word, its letters deleted from its end until what is
  // left fits on the line above: the caret, after the word, goes from the
  // start of a line to the end of the one above. Which line does that
  // depends on the demo's text, so try the lines from page 2 on in turn,
  // in paragraphs on one page: in one that crosses a page, the shorter
  // paragraph can carry the caret's line over the page break, and the
  // pass then scrolls to hold the caret still, as it should.
  const starts = await page.evaluate((ends) => {
    const { view } = window as unknown as Hooks;
    return ends
      .filter((e) => e.page >= 2)
      .filter((e) => {
        const $end = view.state.doc.resolve(e.pos);
        return !(view.nodeDOM($end.before()) as HTMLElement | null)?.querySelector('.ts-pagegap');
      })
      .map((e) => {
        const $start = view.state.doc.resolve(e.pos + 1);
        const word = $start.parent.textBetween($start.parentOffset, $start.parent.content.size, ' ', ' ').match(/^\S+/)?.[0] ?? '';
        return { y: e.y, end: e.pos + 1 + word.length, letters: word.length };
      })
      .filter((s) => s.letters >= 3);
  }, await lineEnds(page));
  expect(starts.length).toBeGreaterThan(0);

  let reached = false;
  for (const start of starts.slice(0, 12)) {
    await demo(page);
    await centre(page, start.y);
    await page.evaluate((pos) => {
      const { view } = window as unknown as Hooks;
      const TS = view.state.selection.constructor as typeof import('prosemirror-state').TextSelection;
      view.focus();
      view.dispatch(view.state.tr.setSelection(TS.create(view.state.doc, pos)));
    }, start.end);
    const first = await caretState(page);
    expect(first.atLineEnd).toBe(false);
    const scrollTop = () => page.evaluate(() => document.getElementById('scroll')!.scrollTop);
    const firstScroll = await scrollTop();
    const panel = await page.evaluate(() => {
      const r = document.getElementById('scroll')!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    for (let k = 1; k < start.letters; k++) {
      const count = await page.evaluate(() => (window as unknown as Hooks).__pagCount());
      await page.keyboard.press('Backspace');
      await settleLocal(page, count, 500);
      const now = await caretState(page);
      // The page holds still (the pass holds the caret's block, not its
      // box: paper-scale.ts), whichever line the caret is on.
      expect(Math.abs((await scrollTop()) - firstScroll), `after ${k} letter(s) deleted: ${JSON.stringify({ first, now })}`).toBeLessThan(1.5);
      expect(now.top).toBeGreaterThan(panel.top);
      expect(now.top).toBeLessThan(panel.bottom);
      if (now.atLineEnd) {
        expect(now.empty, 'side 1 measures nothing at the line end').toBe(true);
        reached = true;
        break;
      }
    }
    if (reached) break;
  }
  expect(reached, 'a line start whose first word, cut short, moved to the line above').toBe(true);
});
