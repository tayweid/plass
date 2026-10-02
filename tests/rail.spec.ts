import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// The scroll rail (src/scroll-rail.ts; docs/mockups/scroll-rail.md, the
// gutter mockup Taylor chose): the whole paper in a 20 px gutter of the
// frame at the window's right, there while the paper runs past the panel
// in the page view, one sheet or many. The panel gives the gutter 12 px of
// its width, so the page is drawn at (W − 64) / 816 while it is there and
// at (W − 52) / 816, main's scale, while it is not (a paper that fits the
// panel, the source view). The marks are placed from a settled layout pass
// in the stack's own px, so a mark sits at its heading's, figure's,
// table's or page gap's offset over the stack's height, down a track the
// panel's height.

type Hooks = {
  __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> };
  __pagCount: () => number;
  __sourceView: { enter: () => Promise<boolean>; exit: () => Promise<boolean> };
  view: import('prosemirror-view').EditorView;
};

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';
const para = (n: number) => FILLER.repeat(n).trimEnd();
const PAGE_W = 816;
const RAIL = 44;
const EDGE = 8;
const GUTTER = 20;
/** The digits' ink in a page number's 8 px box (style.css, .sr-num), as
 *  scroll-rail.ts takes it, and the frame it keeps from a mark. */
const INK = { top: 1.1, bottom: 7.15, clear: 0.5 };

/** A numbered paper of six sheets: a title, sections and subsections, a
 *  figure (its image missing, which still draws its box) and a captioned
 *  table. */
const PAPER = [
  '#set heading(numbering: "1.")',
  '#align(center, text(size: 1.55em, weight: 700)[Sorting by Neighbourhood])',
  '= Introduction', para(5), para(6), para(4),
  '== Sources', para(6), para(5),
  '#figure(image("missing.png"), caption: [The sorting index by decade.])',
  para(6),
  '= Method', para(7), para(5),
  '#figure(\n  table(columns: 2, [City], [Index], [Atlanta], [0.30]),\n  caption: [The index by city.],\n)',
  para(6), '== Estimation', para(8), para(6), '= Results', para(7), para(7), para(5),
].join('\n\n') + '\n';

/** Twenty sections, each with a subsection, about 1.8 sheets apiece, under
 *  a title: 36 sheets and 41 marks, a heading at or near the top of most
 *  sheets. */
const LONG = (() => {
  const parts = ['#set heading(numbering: "1.")', '#align(center, text(size: 1.55em, weight: 700)[A Long Paper])'];
  for (let k = 1; k <= 20; k++) parts.push(`= Section number ${k}`, para(4), para(5), para(3), `== Part ${k}.1 of the section`, para(5), para(4), para(4));
  return parts.join('\n\n') + '\n';
})();

/** One Letter sheet: it runs past the panel at any usual window size. */
const NOTE = '= Notes\n\nA short note, one page.\n';
/** A note on a 3 in page, drawn 366 px tall at 1100 and 507 at 1500:
 *  it fits an 800 px window's 748 px panel. */
const SHORT = '#set page(width: 8.5in, height: 3in, margin: 0.5in)\n\n= Notes\n\nA short note on a short page.\n';

async function openTyp(page: Page, text: string, name = 'rail.typ') {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean((window as unknown as Hooks).__fm && (window as unknown as Hooks).view));
  await page.evaluate(async ({ text, name }) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
    await (window as unknown as Hooks).__fm.loadHandle(h);
  }, { text, name });
  await settleLocal(page);
}

/** The frame's state: the gutter, the panel's box, the page's scale. */
const frame = (page: Page) =>
  page.evaluate(() => {
    const panel = document.getElementById('scroll')!.getBoundingClientRect();
    const stack = document.getElementById('stack')!;
    const hud = document.getElementById('hud')!.getBoundingClientRect();
    return {
      gutter: document.documentElement.classList.contains('has-rail'),
      railShown: getComputedStyle(document.getElementById('scrollrail')!).display !== 'none',
      panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom, width: panel.width },
      scale: stack.getBoundingClientRect().width / stack.offsetWidth,
      hudRight: hud.right,
      window: { width: innerWidth, height: innerHeight },
    };
  });

/** Where things should be on the rail, from the DOM (the layout's own
 *  offsets: drawn rects over the scale, relative to the stack), and where
 *  the rail drew them, in track px. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const stack = document.getElementById('stack')!;
    const s = stack.getBoundingClientRect();
    const scale = s.width / stack.offsetWidth;
    const docH = stack.offsetHeight;
    const track = document.querySelector('#scrollrail .sr-track')!.getBoundingClientRect();
    const toTrack = (y: number) => (y / docH) * track.height;
    const at = (el: Element, padded = false) =>
      (el.getBoundingClientRect().top - s.top) / scale + (padded ? parseFloat(getComputedStyle(el).paddingTop) : 0);
    const want = (selector: string, padded = false) =>
      [...document.querySelectorAll(`.ProseMirror ${selector}`)].map((el) => toTrack(at(el, padded)));
    const drawn = (selector: string) =>
      [...document.querySelectorAll(`#scrollrail ${selector}`)].map((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2 - track.top;
      });
    const boxes = [...document.querySelectorAll('.page-box')].map((el) => el.getBoundingClientRect());
    const gaps = boxes.slice(1).map((box, k) => toTrack(((boxes[k].bottom + box.top) / 2 - s.top) / scale));
    return {
      track: { top: track.top, height: track.height, left: track.left, right: track.right },
      scale,
      docH,
      pages: boxes.length,
      sheetTops: boxes.map((b) => (b.top - s.top) / scale),
      want: {
        title: want('.ts-doctitle', true),
        section: want('h1', true),
        subsection: want('h2, h3, h4, h5, h6', true),
        figure: want('figure'),
        table: want('table'),
        gaps,
      },
      drawn: {
        title: drawn('.sr-title'),
        section: drawn('.sr-section'),
        subsection: drawn('.sr-subsection'),
        figure: drawn('.sr-figure'),
        table: drawn('.sr-table'),
        gaps: drawn('.sr-break:not(.first)'),
      },
      /** Every target's y in track px, for finding a quiet place. */
      targets: [...document.querySelectorAll('#scrollrail .sr-mark, #scrollrail .sr-break:not(.first)')].map((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2 - track.top;
      }),
    };
  });

const scroller = (page: Page) =>
  page.evaluate(() => {
    const p = document.getElementById('scroll')!;
    return { top: p.scrollTop, height: p.scrollHeight, client: p.clientHeight };
  });

const label = (page: Page) =>
  page.evaluate(() => {
    const el = document.getElementById('sr-label')!;
    const r = el.getBoundingClientRect();
    const part = (c: string) => el.querySelector(`.${c}`)?.textContent ?? null;
    return {
      shown: el.classList.contains('show'),
      quiet: el.classList.contains('quiet'),
      k: part('k'),
      t: part('t'),
      p: part('p'),
      box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    };
  });

test('the gutter and the rail are there while the paper runs past the panel, one sheet or many, never when it fits or in the source view', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  // A paper that fits the panel: the frame's 8 px edge, no rail, main's
  // scale.
  await openTyp(page, SHORT, 'short.typ');
  let f = await frame(page);
  expect(f.gutter).toBe(false);
  expect(f.railShown).toBe(false);
  expect(f.panel).toEqual({ left: RAIL, top: 44, right: 1100 - EDGE, bottom: 800 - EDGE, width: 1100 - RAIL - EDGE });
  expect(f.scale).toBeCloseTo((1100 - RAIL - EDGE) / PAGE_W, 5);

  // A one-page note runs past the panel (its sheet is drawn 1341 px
  // tall): the gutter, as for any paper that does.
  await openTyp(page, NOTE, 'note.typ');
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  f = await frame(page);
  expect(f.railShown).toBe(true);
  expect(f.panel.right).toBe(1100 - GUTTER);
  expect(f.scale).toBeCloseTo((1100 - RAIL - GUTTER) / PAGE_W, 5);

  // A six-sheet paper: the gutter, the rail in it, the panel 12 px
  // narrower; the left, top and bottom edges are where they were, and
  // the HUD keeps to the panel's corner.
  await openTyp(page, PAPER);
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  f = await frame(page);
  expect(f.railShown).toBe(true);
  expect(f.panel).toEqual({ left: RAIL, top: 44, right: 1100 - GUTTER, bottom: 800 - EDGE, width: 1100 - RAIL - GUTTER });
  expect(f.scale).toBeCloseTo((1100 - RAIL - GUTTER) / PAGE_W, 5);
  expect(f.hudRight).toBe(f.panel.right - 10);
  const g = await geometry(page);
  expect(g.track).toEqual({ top: 44, height: 800 - 44 - EDGE, left: 1100 - GUTTER, right: 1100 });

  // Print is the paper alone, as before: no rail, no gutter.
  await page.emulateMedia({ media: 'print' });
  expect(await page.evaluate(() => ({
    rail: getComputedStyle(document.getElementById('scrollrail')!).display,
    label: getComputedStyle(document.getElementById('sr-label')!).display,
    margin: getComputedStyle(document.getElementById('scroll')!).marginRight,
  }))).toEqual({ rail: 'none', label: 'none', margin: '0px' });
  await page.emulateMedia({ media: 'screen' });

  // The source view: no pages, no rail, the 8 px edge; back, and the rail
  // returns with the wake-up pass.
  await page.evaluate(() => (window as unknown as Hooks).__sourceView.enter());
  await expect.poll(async () => (await frame(page)).gutter).toBe(false);
  f = await frame(page);
  expect(f.railShown).toBe(false);
  expect(f.panel.right).toBe(1100 - EDGE);
  await page.evaluate(() => (window as unknown as Hooks).__sourceView.exit());
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  expect((await frame(page)).panel.right).toBe(1100 - GUTTER);
});

test('the panel and the paper\'s scale with the gutter and without, at 868, 880, 1100 and 1500', async ({ page }) => {
  test.setTimeout(150_000);
  // With the gutter the panel is W − 64 wide and the page is drawn at
  // (W − 64) / 816; without it, main's W − 52 and (W − 52) / 816. 880 is
  // the tests' window, where a paper with the gutter is drawn at 1:1.
  const sizes = [
    { width: 868, rail: 0.985294, bare: 1 },
    { width: 880, rail: 1, bare: 1.014706 },
    { width: 1100, rail: 1.269608, bare: 1.284314 },
    { width: 1500, rail: 1.759804, bare: 1.77451 },
  ];
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, PAPER);
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: 800 });
    // The panel first, then the page's scale (its observer, after layout).
    await expect.poll(async () => (await frame(page)).panel.width).toBe(size.width - RAIL - GUTTER);
    await expect.poll(async () => Math.abs((await frame(page)).scale - size.rail)).toBeLessThan(5e-6);
    const f = await frame(page);
    expect(f.gutter).toBe(true);
    expect(f.panel).toEqual({ left: RAIL, top: 44, right: size.width - GUTTER, bottom: 800 - EDGE, width: size.width - RAIL - GUTTER });
    expect(f.scale).toBeCloseTo(size.rail, 5);
  }
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, SHORT, 'short.typ');
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: 800 });
    await expect.poll(async () => (await frame(page)).panel.width).toBe(size.width - RAIL - EDGE);
    await expect.poll(async () => Math.abs((await frame(page)).scale - size.bare)).toBeLessThan(5e-6);
    const f = await frame(page);
    expect(f.gutter).toBe(false);
    expect(f.panel).toEqual({ left: RAIL, top: 44, right: size.width - EDGE, bottom: 800 - EDGE, width: size.width - RAIL - EDGE });
    expect(f.scale).toBeCloseTo(size.bare, 5);
  }
});

test('marks sit at the layout offsets of the headings, figures, tables and page gaps, and a resize moves none of them', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, PAPER);
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  const check = async () => {
    const g = await geometry(page);
    expect(g.pages).toBe(6);
    expect(g.want.title.length).toBe(1);
    expect(g.want.section.length).toBe(3);
    expect(g.want.subsection.length).toBe(2);
    expect(g.want.figure.length).toBe(1);
    expect(g.want.table.length).toBe(1);
    expect(g.want.gaps.length).toBe(5);
    for (const kind of ['title', 'section', 'subsection', 'figure', 'table', 'gaps'] as const) {
      expect(g.drawn[kind].length, kind).toBe(g.want[kind].length);
      g.want[kind].forEach((y, i) => expect(Math.abs(g.drawn[kind][i] - y), `${kind} ${i}: drawn ${g.drawn[kind][i]}, layout ${y}`).toBeLessThan(1));
    }
    return g;
  };
  const before = await check();
  // Wider: the page is drawn larger, the track is as tall, and the marks
  // are where they were (fractions of the same layout).
  await page.setViewportSize({ width: 1500, height: 800 });
  await expect.poll(async () => (await frame(page)).panel.width).toBe(1500 - RAIL - GUTTER);
  const after = await check();
  expect(after.drawn).toEqual(before.drawn);

  // The caret's bar follows a click in the text (a selection that moved
  // without an edit), at the caret's own offset.
  const caret = () =>
    page.evaluate(() => {
      const { view } = window as unknown as Hooks;
      const stack = document.getElementById('stack')!;
      const s = stack.getBoundingClientRect();
      const scale = s.width / stack.offsetWidth;
      const track = document.querySelector('#scrollrail .sr-track')!.getBoundingClientRect();
      const y = (view.coordsAtPos(view.state.selection.head).top - s.top) / scale;
      const bar = document.querySelector('#scrollrail .sr-caret')!.getBoundingClientRect();
      return { want: (y / stack.offsetHeight) * track.height, drawn: bar.top + bar.height / 2 - track.top };
    });
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.ProseMirror p')].at(-3)!;
    p.scrollIntoView({ block: 'center' });
  });
  const target = await page.evaluate(() => {
    const r = [...document.querySelectorAll('.ProseMirror p')].at(-3)!.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + 10 };
  });
  await page.mouse.click(target.x, target.y);
  await expect.poll(async () => {
    const c = await caret();
    return c.want > 0.5 * after.track.height && Math.abs(c.drawn - c.want) < 1;
  }).toBe(true);
});

test('the label names a heading, a page break and a place on empty track, and stays inside the window', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, PAPER);
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  const g = await geometry(page);
  const x = 1100 - GUTTER / 2;
  const pageAt = (y: number) => g.sheetTops.filter((top) => top <= y + 0.5).length;
  const inside = (box: { left: number; top: number; right: number; bottom: number }) => {
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(800);
    expect(box.left).toBeGreaterThanOrEqual(0);
    // To the rail's left, over the paper's margin, clear of the gutter.
    expect(box.right).toBeLessThanOrEqual(1100 - GUTTER);
  };

  // A section: its number, its words in the serif, its page.
  const method = g.drawn.section[1];
  await page.mouse.move(x, g.track.top + method);
  await expect.poll(async () => (await label(page)).shown).toBe(true);
  let l = await label(page);
  expect(l.quiet).toBe(false);
  expect({ k: l.k, t: l.t }).toEqual({ k: '2', t: 'Method' });
  expect(l.p).toBe(`p. ${pageAt((g.want.section[1] / g.track.height) * g.docH)}`);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#sr-label .t')!).fontFamily)).toMatch(/^"STIX Two Text"/);
  inside(l.box);

  // A page break with no mark near it: "Page n of 6".
  const quiet = (y: number) => g.targets.every((t) => Math.abs(t - y) > 9 || Math.abs(t - y) < 0.01);
  const k = g.drawn.gaps.findIndex((y) => quiet(y));
  expect(k).toBeGreaterThanOrEqual(0);
  await page.mouse.move(x, g.track.top + g.drawn.gaps[k]);
  await expect.poll(async () => (await label(page)).t).toBe(`Page ${k + 2}`);
  l = await label(page);
  expect(l).toMatchObject({ shown: true, quiet: true, p: 'of 6' });
  inside(l.box);

  // Empty track: a faint line, and the page a click there would show.
  let empty = -1;
  for (let y = 20; y < g.track.height - 20; y++) {
    if (g.targets.every((t) => Math.abs(t - y) > 10)) {
      empty = y;
      break;
    }
  }
  expect(empty).toBeGreaterThan(0);
  await page.mouse.move(x, g.track.top + empty);
  await expect.poll(async () => (await label(page)).t).toBe(`p. ${pageAt((empty / g.track.height) * g.docH)}`);
  l = await label(page);
  expect(l.quiet).toBe(true);
  expect(await page.evaluate(() => document.querySelector('#scrollrail .sr-ghost')!.classList.contains('show'))).toBe(true);
  inside(l.box);

  // At the track's very ends the label is held inside the window.
  for (const y of [0.5, g.track.height - 0.5]) {
    await page.mouse.move(x, g.track.top + y);
    await expect.poll(async () => (await label(page)).shown).toBe(true);
    inside((await label(page)).box);
  }

  // Leaving the gutter puts the label away.
  await page.mouse.move(600, 400);
  await expect.poll(async () => (await label(page)).shown).toBe(false);
});

test('a click on a break puts its sheet\'s top at the panel\'s top, a heading an eighth of the way down; a drag scrubs and jumps nothing; the wheel scrolls the paper', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, PAPER);
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  const g = await geometry(page);
  const x = 1100 - GUTTER / 2;
  const quiet = (y: number) => g.targets.every((t) => Math.abs(t - y) > 9 || Math.abs(t - y) < 0.01);

  // A break: the sheet below it, top at the panel's top.
  const k = g.drawn.gaps.findIndex((y, i) => i < 4 && quiet(y));
  expect(k).toBeGreaterThanOrEqual(0);
  await page.mouse.click(x, g.track.top + g.drawn.gaps[k]);
  const sheetTop = g.sheetTops[k + 1] * g.scale;
  await expect.poll(async () => Math.abs((await scroller(page)).top - sheetTop)).toBeLessThan(1.5);

  // A heading: an eighth of the way down the panel.
  const client = (await scroller(page)).client;
  const heading = (g.want.section[2] / g.track.height) * g.docH;
  await page.mouse.click(x, g.track.top + g.drawn.section[2]);
  await expect.poll(async () => Math.abs((await scroller(page)).top - (heading * g.scale - client / 8))).toBeLessThan(1.5);
  const landed = await page.evaluate(() => {
    const panel = document.getElementById('scroll')!.getBoundingClientRect();
    const h = document.querySelectorAll('.ProseMirror h1')[2];
    return h.getBoundingClientRect().top + parseFloat(getComputedStyle(h).paddingTop) * (panel.width / 816) - panel.top;
  });
  expect(Math.abs(landed - client / 8)).toBeLessThan(2);

  // A press on a mark that drags scrubs the band from where it was: 100 px
  // of drag is 100 / the track's height of the paper, and nothing jumps.
  await page.evaluate(() => (document.getElementById('scroll')!.scrollTop = 0));
  await page.waitForTimeout(100);
  const start = await scroller(page);
  const from = g.track.top + g.drawn.section[0];
  await page.mouse.move(x, from);
  await page.mouse.down();
  await page.mouse.move(x, from + 50, { steps: 5 });
  await page.mouse.move(x, from + 100, { steps: 5 });
  await page.mouse.up();
  const expected = start.top + (100 / g.track.height) * start.height;
  const dragged = (await scroller(page)).top;
  expect(Math.abs(dragged - expected)).toBeLessThan(2);
  await page.waitForTimeout(600);
  expect((await scroller(page)).top).toBe(dragged);

  // The wheel over the gutter scrolls the paper, which the gutter is not in.
  await page.mouse.move(x, g.track.top + 300);
  const before = (await scroller(page)).top;
  await page.mouse.wheel(0, 240);
  await expect.poll(async () => (await scroller(page)).top - before).toBe(240);
});

test('the band is the visible span: its top and height are the panel\'s scroll over the paper\'s height', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, PAPER);
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  const track = (await geometry(page)).track;
  for (const at of [0, 0.25, 0.6, 1]) {
    const s = await page.evaluate((at) => {
      const p = document.getElementById('scroll')!;
      p.scrollTop = (p.scrollHeight - p.clientHeight) * at;
      return { top: p.scrollTop, height: p.scrollHeight, client: p.clientHeight };
    }, at);
    const want = { top: (s.top / s.height) * track.height, height: Math.max(10, (s.client / s.height) * track.height) };
    await expect
      .poll(async () => {
        const band = await page.evaluate(() => document.querySelector('#scrollrail .sr-band')!.getBoundingClientRect());
        return Math.max(Math.abs(band.top - track.top - want.top), Math.abs(band.height - want.height));
      }, { message: `at ${at}` })
      .toBeLessThan(0.6);
  }
  // At the end the band's bottom is level with the panel's bottom.
  const band = await page.evaluate(() => document.querySelector('#scrollrail .sr-band')!.getBoundingClientRect());
  expect(Math.abs(band.bottom - (800 - EDGE))).toBeLessThan(0.6);
});

test('the keyboard: one tab stop, Up and Down between marks with the label following, Home and End, Return jumps', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, PAPER);
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  const marks = await page.evaluate(() => [...document.querySelectorAll('#scrollrail .sr-mark')].map((b) => ({ label: b.getAttribute('aria-label'), tab: (b as HTMLElement).tabIndex })));
  expect(marks.filter((m) => m.tab === 0).length).toBe(1);
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
  await page.locator('#scrollrail .sr-mark[tabindex="0"]').focus();
  expect(await focused()).toBe(marks[0].label);
  await expect.poll(async () => (await label(page)).shown).toBe(true);
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe(marks[1].label);
  await page.keyboard.press('End');
  expect(await focused()).toBe(marks.at(-1)!.label);
  expect((await label(page)).t).toBe('Results');
  await page.keyboard.press('Home');
  expect(await focused()).toBe(marks[0].label);
  // The roving stop follows the focus.
  expect(await page.evaluate(() => document.querySelectorAll('#scrollrail .sr-mark[tabindex="0"]').length)).toBe(1);
  // Down to "2 Method", then Return: an eighth of the way down the panel.
  for (let i = 0; i < marks.length && !(await focused())?.startsWith('2 Method'); i++) await page.keyboard.press('ArrowDown');
  expect(await focused()).toMatch(/^2 Method, page \d$/);
  expect(await label(page)).toMatchObject({ shown: true, k: '2', t: 'Method' });
  const target = await page.evaluate(() => {
    const stack = document.getElementById('stack')!;
    const scale = stack.getBoundingClientRect().width / stack.offsetWidth;
    const h = document.querySelectorAll('.ProseMirror h1')[1];
    const y = (h.getBoundingClientRect().top - stack.getBoundingClientRect().top) / scale + parseFloat(getComputedStyle(h).paddingTop);
    return y * scale - document.getElementById('scroll')!.clientHeight / 8;
  });
  await page.keyboard.press('Enter');
  await expect.poll(async () => Math.abs((await scroller(page)).top - target)).toBeLessThan(1.5);
  // Tab leaves the rail and the label goes.
  await page.keyboard.press('Shift+Tab');
  await expect.poll(async () => (await label(page)).shown).toBe(false);
});

test('nothing opens or grows while a mouse button is down: a selection dragged into the gutter, and a gutter due under a held button', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, PAPER);
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  const g = await geometry(page);
  const x = 1100 - GUTTER / 2;
  const rail = () =>
    page.evaluate(() => {
      const r = document.getElementById('scrollrail')!;
      return {
        awake: r.classList.contains('awake'),
        dragging: r.classList.contains('dragging'),
        hot: r.querySelectorAll('.hot').length,
        label: document.getElementById('sr-label')!.classList.contains('show'),
        ghost: r.querySelector('.sr-ghost')!.classList.contains('show'),
      };
    });

  // A selection from the text dragged out over a heading's mark.
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(900, 320, { steps: 6 });
  await page.mouse.move(x, g.track.top + g.drawn.section[0], { steps: 6 });
  await page.mouse.move(x, g.track.top + g.drawn.section[0] + 1, { steps: 2 });
  expect(await rail()).toEqual({ awake: false, dragging: false, hot: 0, label: false, ghost: false });
  await page.mouse.up();
  // Released there, a hover opens the label as usual.
  await page.mouse.move(x, g.track.top + g.drawn.section[0]);
  await expect.poll(async () => (await rail()).label).toBe(true);

  // A note that fits the panel and grows past it while a button is held
  // on its text: the gutter waits for the release, then comes.
  await openTyp(page, SHORT, 'grow.typ');
  expect((await frame(page)).gutter).toBe(false);
  await page.mouse.move(400, 200);
  await page.mouse.down();
  const before = await page.evaluate(() => (window as unknown as Hooks).__pagCount());
  await page.evaluate((text) => {
    const { view } = window as unknown as Hooks;
    const { state } = view;
    const paragraphs = Array.from({ length: 4 }, () => state.schema.nodes.paragraph.create(null, state.schema.text(text)));
    view.dispatch(state.tr.insert(state.doc.content.size, paragraphs));
  }, para(6));
  await settleLocal(page, before);
  expect(await page.evaluate(() => document.querySelectorAll('.page-box').length)).toBeGreaterThan(2);
  expect(await page.evaluate(() => document.getElementById('scroll')!.scrollHeight)).toBeGreaterThan(800);
  let f = await frame(page);
  expect(f.gutter).toBe(false);
  expect(f.panel.right).toBe(1100 - EDGE);
  await page.mouse.up();
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  f = await frame(page);
  expect(f.panel.right).toBe(1100 - GUTTER);
});

test('page numbers under the breaks thin on a thirty-page paper so the shown ones stay 16 px apart', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1100, height: 900 });
  await openTyp(page, Array.from({ length: 82 }, () => para(6)).join('\n\n') + '\n', 'thirty.typ');
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  const numbers = () =>
    page.evaluate(() => {
      const track = document.querySelector('#scrollrail .sr-track')!.getBoundingClientRect();
      return {
        trackH: track.height,
        pages: document.querySelectorAll('.page-box').length,
        shown: [...document.querySelectorAll<HTMLElement>('#scrollrail .sr-num')]
          .filter((n) => !n.hidden)
          .map((n) => ({ page: Number(n.textContent), y: n.getBoundingClientRect().top - track.top })),
      };
    });
  const strideFor = (perPage: number) => [1, 2, 5, 10, 20, 50, 100].find((s) => perPage * s >= 16)!;
  for (const height of [900, 500]) {
    await page.setViewportSize({ width: 1100, height });
    await expect.poll(async () => (await numbers()).trackH).toBe(height - 44 - EDGE);
    let n = await numbers();
    expect(n.pages).toBeGreaterThanOrEqual(28);
    expect(n.pages).toBeLessThanOrEqual(32);
    const stride = strideFor(n.trackH / n.pages);
    if (height === 500) expect(stride).toBeGreaterThan(1);
    else expect(stride).toBe(1);
    // No headings on this paper, so no mark takes a number's place. (The
    // rail re-thins in the frame after the resize.)
    const want = Array.from({ length: n.pages }, (_, i) => i + 1).filter((p) => (p - 1) % stride === 0);
    await expect.poll(async () => (await numbers()).shown.map((s) => s.page)).toEqual(want);
    n = await numbers();
    for (let i = 1; i < n.shown.length; i++) expect(n.shown[i].y - n.shown[i - 1].y).toBeGreaterThanOrEqual(16);
  }
});

test('a one-page note typed onto its second sheet keeps its gutter and its scale', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, NOTE, 'note.typ');
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  const before = await frame(page);
  await page.evaluate(() => {
    const w = window as unknown as { __flips: number };
    w.__flips = 0;
    let last = document.documentElement.classList.contains('has-rail');
    new MutationObserver(() => {
      const now = document.documentElement.classList.contains('has-rail');
      if (now !== last) w.__flips++;
      last = now;
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  });
  const passes = await page.evaluate(() => (window as unknown as Hooks).__pagCount());
  await page.evaluate((text) => {
    const { view } = window as unknown as Hooks;
    const { state } = view;
    const paragraphs = Array.from({ length: 8 }, () => state.schema.nodes.paragraph.create(null, state.schema.text(text)));
    view.dispatch(state.tr.insert(state.doc.content.size, paragraphs));
  }, para(3));
  await settleLocal(page, passes);
  expect(await page.evaluate(() => document.querySelectorAll('.page-box').length)).toBeGreaterThanOrEqual(2);
  const after = await frame(page);
  expect(after.gutter).toBe(true);
  expect(after.panel).toEqual(before.panel);
  expect(after.scale).toBe(before.scale);
  expect(await page.evaluate(() => (window as unknown as { __flips: number }).__flips)).toBe(0);
});

test('the band takes the new scale\'s height after a resize at the top of the paper, where nothing scrolls', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, PAPER);
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  // How far the band is from the visible span: its top from the scroll's
  // fraction of the track, its height from the panel's over the paper's.
  const off = () =>
    page.evaluate(() => {
      const p = document.getElementById('scroll')!;
      const t = document.querySelector('#scrollrail .sr-track')!.getBoundingClientRect();
      const b = document.querySelector('#scrollrail .sr-band')!.getBoundingClientRect();
      return Math.max(
        Math.abs(b.top - t.top - (p.scrollTop / p.scrollHeight) * t.height),
        Math.abs(b.height - Math.max(10, (p.clientHeight / p.scrollHeight) * t.height)),
      );
    });
  await expect.poll(off).toBeLessThan(0.6);
  expect(await page.evaluate(() => document.getElementById('scroll')!.scrollTop)).toBe(0);
  for (const size of [{ width: 1500, height: 800 }, { width: 868, height: 600 }, { width: 1100, height: 800 }]) {
    await page.setViewportSize(size);
    await expect.poll(async () => (await frame(page)).panel.width).toBe(size.width - RAIL - GUTTER);
    await expect.poll(off, { message: `at ${size.width} × ${size.height}` }).toBeLessThan(0.6);
  }
});

test('a scroll writes the band\'s span on the band, and marks only the marks and gaps that cross its edges', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, PAPER);
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  // Which marks and gaps carry `in`, against which lie inside the band's
  // span (their --f between the span's two fractions).
  const lit = () =>
    page.evaluate(() => {
      const p = document.getElementById('scroll')!;
      const f0 = p.scrollTop / p.scrollHeight;
      const f1 = (p.scrollTop + p.clientHeight) / p.scrollHeight;
      const items = [...document.querySelectorAll<HTMLElement>('#scrollrail .sr-mark, #scrollrail .sr-break')];
      const f = (el: HTMLElement) => parseFloat(el.style.getPropertyValue('--f'));
      return {
        wrong: items.filter((el) => Math.abs(f(el) - f0) > 1e-4 && Math.abs(f(el) - f1) > 1e-4 && (f(el) > f0 && f(el) < f1) !== el.classList.contains('in')).length,
        lit: items.filter((el) => el.classList.contains('in')).length,
        gapsLit: items.filter((el) => el.matches('.sr-break:not(.first).in')).length,
      };
    });
  await page.evaluate(() => {
    const w = window as unknown as { __rail: string[] };
    w.__rail = [];
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        w.__rail.push(`${el.id || el.className.replace(/ ?\b(in|hot|moving|awake)\b/g, '')}:${r.attributeName}`);
      }
    }).observe(document.getElementById('scrollrail')!, { subtree: true, attributes: true, attributeOldValue: true });
  });
  // Down the paper a step at a time: after each frame the `in` class is on
  // exactly the marks and gaps in the band, and a gap in view draws its
  // longer tick.
  const { height, client } = await scroller(page);
  let lit0 = 0;
  let gaps0 = 0;
  for (const at of [0.05, 0.1, 0.3, 0.55, 0.8, 1]) {
    await page.evaluate((top) => (document.getElementById('scroll')!.scrollTop = top), (height - client) * at);
    await expect.poll(async () => (await lit()).wrong, { message: `at ${at}` }).toBe(0);
    const l = await lit();
    lit0 += l.lit;
    gaps0 += l.gapsLit;
  }
  expect(lit0).toBeGreaterThan(0);
  expect(gaps0).toBeGreaterThan(0);
  await page.evaluate((top) => (document.getElementById('scroll')!.scrollTop = top), height / 2 - client / 2);
  await expect.poll(async () => (await lit()).wrong).toBe(0);
  // Nothing the scroll wrote was on the rail itself but its `moving` class
  // (a style written there is inherited by every mark): the band's style,
  // and the class of a mark or gap the band passed.
  const writes = await page.evaluate(() => [...new Set((window as unknown as { __rail: string[] }).__rail)]);
  expect(writes).toContain('sr-band:style');
  expect(writes.filter((w) => w !== 'sr-band:style' && w !== 'scrollrail:class' && !/^sr-(mark|break)\b.*:class$/.test(w))).toEqual([]);
  // A small scroll that moves no edge past a mark writes the band alone.
  await page.evaluate(() => ((window as unknown as { __rail: string[] }).__rail = []));
  const quietStep = await page.evaluate(() => {
    const p = document.getElementById('scroll')!;
    const fs = [...document.querySelectorAll<HTMLElement>('#scrollrail .sr-mark, #scrollrail .sr-break')].map((el) => parseFloat(el.style.getPropertyValue('--f')));
    for (let top = p.scrollTop; top < p.scrollHeight - p.clientHeight - 4; top += 2) {
      const a = top / p.scrollHeight;
      const b = (top + p.clientHeight) / p.scrollHeight;
      const a2 = (top + 3) / p.scrollHeight;
      const b2 = (top + 3 + p.clientHeight) / p.scrollHeight;
      if (fs.every((f) => (f > a && f < b) === (f > a2 && f < b2) && Math.abs(f - a) > 1e-4 && Math.abs(f - b) > 1e-4)) return top;
    }
    return -1;
  });
  expect(quietStep).toBeGreaterThanOrEqual(0);
  await page.evaluate((top) => (document.getElementById('scroll')!.scrollTop = top), quietStep);
  await expect.poll(async () => (await lit()).wrong).toBe(0);
  await page.evaluate(() => ((window as unknown as { __rail: string[] }).__rail = []));
  await page.evaluate((top) => (document.getElementById('scroll')!.scrollTop = top), quietStep + 3);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const quiet = await page.evaluate(() => [...new Set((window as unknown as { __rail: string[] }).__rail)]);
  expect(quiet.filter((w) => w !== 'scrollrail:class')).toEqual(['sr-band:style']);
});

test('on a long paper whose pages open with headings, the page numbers stay: moved off a mark in their place, page 1 among them, 16 px apart', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, LONG, 'long.typ');
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  const read = () =>
    page.evaluate(() => {
      const track = document.querySelector('#scrollrail .sr-track')!.getBoundingClientRect();
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { top: r.top - track.top, bottom: r.bottom - track.top };
      };
      const breaks = [...document.querySelectorAll<HTMLElement>('#scrollrail .sr-break')];
      return {
        pages: document.querySelectorAll('.page-box').length,
        hairlines: breaks.map((b) => box(b).top + 0.5),
        shown: breaks
          .map((b, i) => ({ page: i + 1, num: b.querySelector<HTMLElement>('.sr-num')! }))
          .filter((n) => !n.num.hidden)
          .map((n) => ({ page: n.page, ...box(n.num) })),
        marks: [...document.querySelectorAll('#scrollrail .sr-mark:not(.sr-caret)')].map(box),
      };
    });
  await expect.poll(async () => (await read()).shown.length).toBeGreaterThan(0);
  const n = await read();
  expect(n.pages).toBeGreaterThanOrEqual(30);
  expect(n.hairlines.length).toBe(n.pages);
  // Most sheets keep their number (the rule this replaces showed 6 of 36,
  // page 1 never), and page 1 is one of them.
  expect(n.shown.map((s) => s.page)).toContain(1);
  expect(n.shown.length).toBeGreaterThanOrEqual(Math.ceil(n.pages * 0.85));
  for (const [i, s] of n.shown.entries()) {
    // Under its own hairline and above the next one.
    expect(s.top).toBeGreaterThan(n.hairlines[s.page - 1]);
    expect(s.bottom).toBeLessThanOrEqual(s.page < n.pages ? n.hairlines[s.page] : 748);
    // Its digits clear of every heading's, figure's and table's mark (the
    // box's empty top and bottom may lie over a mark's edge).
    for (const m of n.marks) expect(Math.min(s.top + INK.bottom, m.bottom) - Math.max(s.top + INK.top, m.top), `page ${s.page}`).toBeLessThanOrEqual(0.1 - INK.clear);
    // 16 px from the one before.
    if (i > 0) expect(s.top - n.shown[i - 1].top).toBeGreaterThanOrEqual(15.9);
  }
});

test('the page numbers keep an even run at any window height: page 1, then every 1st, 2nd or 5th… page, 16 px apart, clear of the marks', async ({ page }) => {
  test.setTimeout(180_000);
  // The long paper at 1100 wide, from 748 px of track (20.8 px a sheet)
  // down to 348 (9.7). The rule before this showed 35, 17, 9, none and
  // none of its 36 page numbers at 800, 700, 600, 500 and 400 tall, in
  // runs like 1, 2, 3, 6, 8, 10, 13…: a number moved past a mark was
  // bounded by the next hairline and hid where it had no room, and the
  // next one hid where it came within 16 px of a moved one.
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTyp(page, LONG, 'long.typ');
  await expect.poll(async () => (await frame(page)).gutter).toBe(true);
  const read = () =>
    page.evaluate(() => {
      const track = document.querySelector('#scrollrail .sr-track')!.getBoundingClientRect();
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { top: r.top - track.top, bottom: r.bottom - track.top };
      };
      const breaks = [...document.querySelectorAll<HTMLElement>('#scrollrail .sr-break')];
      return {
        trackH: track.height,
        pages: document.querySelectorAll('.page-box').length,
        hairlines: breaks.map((b) => box(b).top),
        drawn: breaks.map((b) => getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)'),
        shown: breaks
          .map((b, i) => ({ page: i + 1, num: b.querySelector<HTMLElement>('.sr-num')! }))
          .filter((n) => !n.num.hidden)
          .map((n) => ({ page: n.page, ...box(n.num) })),
        marks: [...document.querySelectorAll('#scrollrail .sr-mark:not(.sr-caret)')].map(box),
      };
    });
  const STRIDES = [1, 2, 5, 10, 20, 50, 100];
  for (const height of [800, 700, 600, 500, 400]) {
    await page.setViewportSize({ width: 1100, height });
    await expect.poll(async () => (await read()).trackH).toBe(height - 44 - EDGE);
    // The rail lays its numbers out again in the frame after the resize.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const n = await read();
    expect(n.pages).toBe(36);
    const pages = n.shown.map((s) => s.page);
    const at = `${height} tall: ${pages.join(', ') || 'none'}`;
    // Page 1, and then every stride-th page to the end, the stride one of
    // the rail's steps and wide enough for 16 px between hairlines.
    expect(pages[0], at).toBe(1);
    const stride = pages[1] - pages[0];
    expect(STRIDES, at).toContain(stride);
    expect((n.trackH / n.pages) * stride, at).toBeGreaterThanOrEqual(16);
    expect(pages, at).toEqual(Array.from({ length: Math.ceil(n.pages / stride) }, (_, k) => 1 + k * stride));
    for (const [i, s] of n.shown.entries()) {
      const which = `${at}: page ${s.page}`;
      // Under its own hairline, never nearer than the lift (0.75 px), and
      // above the next shown number's.
      expect(s.top, which).toBeGreaterThanOrEqual(n.hairlines[s.page - 1] + 0.73);
      expect(s.bottom, which).toBeLessThanOrEqual(s.page + stride <= n.pages ? n.hairlines[s.page + stride - 1] + 0.05 : n.trackH);
      // 16 px from the one before (to layout's 1/64 px).
      if (i > 0) expect(s.top - n.shown[i - 1].top, `${at}: pages ${n.shown[i - 1].page} and ${s.page}`).toBeGreaterThanOrEqual(15.95);
      // No line drawn across its box, or between it and its own line: an
      // unnumbered hairline there gives way.
      for (let q = s.page + 1; q < s.page + stride && q <= n.pages; q++) {
        if (n.drawn[q - 1]) expect(n.hairlines[q - 1], `${which}, page ${q}'s line`).toBeGreaterThanOrEqual(s.bottom - 0.05);
      }
      // Its digits clear of every heading's, figure's and table's mark by
      // half a pixel. At 400 the marks are closer together than the digits
      // are tall (under 5 px between two, all down the rail): no place is
      // clear, and a number covers as little of a mark as its room allows.
      const gap = Math.min(...n.marks.map((m) => Math.max(m.top - (s.top + INK.bottom), s.top + INK.top - m.bottom)));
      expect(gap, which).toBeGreaterThanOrEqual(height > 400 ? INK.clear - 0.1 : -2);
    }
  }
});
