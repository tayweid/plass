import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Two pages side by side (src/paper-scale.ts spread): the layout stays
// stacked and every measure reads it so; the drawing puts page k's sheet at
// row ⌊k/2⌋, side k mod 2, and the editor's columns put page k's text on it.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

async function halfSheets(page: Page, paragraphs = 16) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate((n) => {
    try {
      localStorage.removeItem('plass-spread');
    } catch {
      /* none */
    }
    const { state } = window.view;
    const s = state.schema;
    const words = 'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing. ';
    const paras = Array.from({ length: n }, (_, i) => s.nodes.paragraph.create(null, s.text(`P${i + 1}. ${words.repeat(3)}`)));
    const tr = state.tr.replaceWith(0, state.doc.content.size, paras);
    tr.setDocAttribute('settings', { ...state.doc.attrs.settings, page: 'half-letter' });
    window.view.dispatch(tr);
  }, paragraphs);
  await settleLocal(page);
}

async function toggleSpread(page: Page) {
  await page.locator('#rail-drawer').click();
  await expect(page.locator('html')).toHaveClass(/\brail-open\b/);
  await page.locator('#rail').getByRole('button', { name: 'Two pages side by side', exact: true }).click();
  await page.locator('#rail-drawer').click();
  await expect(page.locator('html')).not.toHaveClass(/\brail-open\b/);
  await settleLocal(page);
}

/** Each sheet's box, and the box of the first and last line of text that
 *  the layout put on it (by the pages' gaps). */
const sheetsAndText = (page: Page) =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#pages .page-box:not(.page-ghost)')].map((b) => b.getBoundingClientRect());
    // Every text line's box, by walking the text nodes' client rects.
    const lines: DOMRect[] = [];
    const walker = document.createTreeWalker(window.view.dom, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) lines.push(r);
    }
    const inside = (r: DOMRect, b: DOMRect) => r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5;
    return {
      boxes: boxes.map((b) => [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]),
      stray: lines.filter((r) => !boxes.some((b) => inside(r, b))).length,
      perSheet: boxes.map((b) => lines.filter((r) => inside(r, b)).length),
    };
  });

test('two pages side by side: the sheets in rows of two, every line of text on a sheet', async ({ page }) => {
  await halfSheets(page);
  const stacked = await sheetsAndText(page);
  expect(stacked.boxes.length).toBeGreaterThanOrEqual(3);
  expect(stacked.stray).toBe(0);
  await toggleSpread(page);
  await page.screenshot({ path: process.env.SPREAD_SHOT ?? 'test-results/spread.png' });
  const spread = await sheetsAndText(page);
  // Same sheets, now pairs: page 2 beside page 1, page 3 under page 1.
  expect(spread.boxes.length).toBe(stacked.boxes.length);
  const [a, b, c] = spread.boxes;
  expect(b[1]).toBe(a[1]);
  expect(b[0]).toBeGreaterThan(a[0] + a[2] - 1);
  expect(c[0]).toBe(a[0]);
  expect(c[1]).toBeGreaterThan(a[1] + a[3] - 1);
  // Every line is on a sheet, and each sheet holds the lines it held stacked.
  expect(spread.stray).toBe(0);
  expect(spread.perSheet).toEqual(stacked.perSheet);
});

/** The caret's sheet: the index of the page box its box is on. */
const caretSheet = (page: Page) =>
  page.evaluate(() => {
    const c = window.view.coordsAtPos(window.view.state.selection.head);
    return [...document.querySelectorAll('#pages .page-box:not(.page-ghost)')].findIndex((b) => {
      const r = b.getBoundingClientRect();
      return c.left >= r.left && c.left <= r.right && c.top >= r.top && c.top <= r.bottom;
    });
  });

test('↓ from a page\'s last line goes to the head of the page beside it, then the row below; ↑ comes back', async ({ page }) => {
  await halfSheets(page);
  await toggleSpread(page);
  // The caret on page 1's last line: the last text position whose box is
  // on sheet 0.
  await page.evaluate(() => {
    const view = window.view;
    const sheet = document.querySelector('#pages .page-box:not(.page-ghost)')!.getBoundingClientRect();
    let last = 1;
    view.state.doc.descendants((n, pos) => {
      if (!n.isText) return true;
      for (let p = pos; p <= pos + n.nodeSize; p += 4) {
        const c = view.coordsAtPos(p);
        if (c.left >= sheet.left && c.left <= sheet.right && c.top >= sheet.top && c.bottom <= sheet.bottom) last = p;
      }
      return false;
    });
    const Sel = view.state.selection.constructor as unknown as { near: (p: unknown) => import('prosemirror-state').Selection };
    view.focus();
    view.dispatch(view.state.tr.setSelection(Sel.near(view.state.doc.resolve(last))));
  });
  expect(await caretSheet(page)).toBe(0);
  await page.keyboard.press('ArrowDown');
  expect(await caretSheet(page)).toBe(1);
  await page.keyboard.press('ArrowUp');
  expect(await caretSheet(page)).toBe(0);
  // Down through page 2 to page 3, under page 1.
  for (let i = 0; i < 60 && (await caretSheet(page)) < 2; i++) await page.keyboard.press('ArrowDown');
  expect(await caretSheet(page)).toBe(2);
});

test('typing in the spread keeps every line on a sheet; stacked again, the same sheets', async ({ page }) => {
  await halfSheets(page, 10);
  const before = await sheetsAndText(page);
  await toggleSpread(page);
  await page.locator('.ProseMirror p', { hasText: 'P2.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More words typed while the pages are side by side, enough to wrap a line or two more than before.');
  await settleLocal(page);
  const typed = await sheetsAndText(page);
  expect(typed.stray).toBe(0);
  await toggleSpread(page);
  const stacked = await sheetsAndText(page);
  expect(stacked.stray).toBe(0);
  expect(stacked.perSheet).toEqual(typed.perSheet);
  // (The panel scrolled while typing: the sheet's size and left edge.)
  expect([stacked.boxes[0][0], stacked.boxes[0][2], stacked.boxes[0][3]]).toEqual([before.boxes[0][0], before.boxes[0][2], before.boxes[0][3]]);
});

test('editorial comments: a grown sheet keeps its length, the next row starts below the longest sheet', async ({ page }) => {
  await halfSheets(page);
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const note = (t: string) => s.nodes.editor_comment.create(null, s.text(t));
    // One note on page 1, a longer one further on.
    const tr = state.tr.insert(state.doc.child(0).nodeSize, note('A note to self.'));
    tr.insert(tr.doc.content.size - tr.doc.lastChild!.nodeSize, note('A longer note to self that runs over several lines of the comment strip, so its sheet grows more than the first one does. '.repeat(3)));
    // A footnote on a page after the first note: its body moves with the
    // breaks above it.
    let at = -1;
    tr.doc.descendants((n, pos) => {
      if (at < 0 && n.isTextblock && n.textContent.startsWith('P8.')) at = pos + n.nodeSize - 1;
      return at < 0;
    });
    tr.insert(at, s.nodes.footnote.create(null, s.text('A footnote further on.')));
    window.view.dispatch(tr);
  });
  await settleLocal(page);
  const stacked = await sheetsAndText(page);
  const heights = stacked.boxes.map((b) => b[3]);
  expect(new Set(heights).size).toBeGreaterThan(1);
  await toggleSpread(page);
  await page.screenshot({ path: process.env.SPREAD_SHOT3 ?? 'test-results/spread-comments.png' });
  const spread = await sheetsAndText(page);
  // Each sheet keeps its own length (drawn at the spread's scale: two
  // sheets share the panel's width).
  const ratio = (hs: number[]) => hs.map((h) => Math.round((h / Math.min(...hs)) * 100) / 100);
  const drawn = spread.boxes.map((b) => b[3]);
  expect(ratio(drawn)).toEqual(ratio(heights));
  // Every row starts the longest sheet and the gap below the one above.
  const scale = await page.evaluate(() => document.querySelector('#stack')!.getBoundingClientRect().width / (document.querySelector('#stack') as HTMLElement).offsetWidth);
  const longest = Math.max(...drawn);
  const rowTops = spread.boxes.filter((_, k) => k % 2 === 0).map((b) => b[1]);
  for (let r = 1; r < rowTops.length; r++) expect(Math.abs(rowTops[r] - rowTops[r - 1] - (longest + 6 * scale))).toBeLessThanOrEqual(1.5);
  // Pairs share a top; every line, the notes' included, on a sheet.
  expect(spread.boxes[1][1]).toBe(spread.boxes[0][1]);
  expect(spread.stray).toBe(0);
  expect(spread.perSheet).toEqual(stacked.perSheet);
  const notesOn = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#pages .page-box:not(.page-ghost)')].map((b) => b.getBoundingClientRect());
    const notes = [...document.querySelectorAll('.fn-body')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
    return notes.length > 0 && notes.every((r) => boxes.some((b) => r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1));
  });
  expect(notesOn).toBe(true);
});

test('a footnote, a split table and a solution block in the spread: all on their sheets', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.view));
  await page.evaluate(() => {
    try {
      localStorage.removeItem('plass-spread');
    } catch {
      /* none */
    }
    const { state } = window.view;
    const s = state.schema;
    const words = 'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings. ';
    const p = (t: string, extra: import('prosemirror-model').Node[] = []) => s.nodes.paragraph.create(null, [s.text(t), ...extra]);
    const cell = (t: string) => s.nodes.table_cell.create(null, s.nodes.paragraph.create(null, s.text(t)));
    const rows = Array.from({ length: 24 }, (_, i) => s.nodes.table_row.create(null, [cell(`Row ${i + 1}`), cell(`${i * 3}`)]));
    const blocks = [
      p(words.repeat(3), [s.nodes.footnote.create(null, s.text('A footnote on the first page.'))]),
      p(words.repeat(2)),
      s.nodes.table.create({ style: 'booktabs' }, rows),
      s.nodes.blockquote.create({ kind: 'solution' }, [p(words.repeat(6)), p(words.repeat(4))]),
      p(words.repeat(3)),
    ];
    const tr = state.tr.replaceWith(0, state.doc.content.size, blocks);
    tr.setDocAttribute('settings', { ...state.doc.attrs.settings, page: 'half-letter' });
    window.view.dispatch(tr);
  });
  await settleLocal(page);
  const stacked = await sheetsAndText(page);
  await toggleSpread(page);
  await page.screenshot({ path: process.env.SPREAD_SHOT2 ?? 'test-results/spread-rich.png', fullPage: false });
  const spread = await sheetsAndText(page);
  expect(spread.stray).toBe(0);
  expect(spread.perSheet).toEqual(stacked.perSheet);
  // The footnote's body and every solution-rule segment are on a sheet.
  const onSheets = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#pages .page-box:not(.page-ghost)')].map((b) => b.getBoundingClientRect());
    const on = (r: DOMRect) => boxes.some((b) => r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1);
    const notes = [...document.querySelectorAll('.fn-body')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
    const rules = [...document.querySelectorAll('.ts-solution-rules > div')].map((e) => e.getBoundingClientRect());
    return { notes: notes.length, notesOn: notes.every(on), rules: rules.length, rulesOn: rules.every(on) };
  });
  expect(onSheets.notes).toBeGreaterThan(0);
  expect(onSheets.notesOn).toBe(true);
  expect(onSheets.rules).toBeGreaterThan(0);
  expect(onSheets.rulesOn).toBe(true);
});

test('the paper ends with the last row of sheets: no strip of white under them', async ({ page }) => {
  await halfSheets(page, 1);
  await toggleSpread(page);
  const ends = await page.evaluate(() => {
    const paper = document.querySelector('#paper')!.getBoundingClientRect();
    // Every sheet drawn, the blank ones that carry it to the foot included.
    const sheets = [...document.querySelectorAll('#pages .page-box')].map((b) => b.getBoundingClientRect());
    return { paper: paper.bottom, sheets: Math.max(...sheets.map((r) => r.bottom)) };
  });
  expect(Math.abs(ends.paper - ends.sheets)).toBeLessThan(0.5);
});

test('an odd last page has a greyed blank sheet beside it; stacked, none', async ({ page }) => {
  await halfSheets(page, 1);
  await toggleSpread(page);
  const ghost = page.locator('#pages .page-ghost');
  // The blank beside page 1 is the first (a pair below may follow it).
  await expect(ghost.first()).toBeAttached();
  const [sheet, blank] = await page.evaluate(() => [document.querySelector('#pages .page-box:not(.page-ghost)')!, document.querySelector('#pages .page-ghost')!].map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, opacity: getComputedStyle(el).opacity };
  }));
  expect(blank.top).toBeCloseTo(sheet.top, 0);
  expect(blank.left).toBeGreaterThan(sheet.left + sheet.width - 1);
  expect(blank.width).toBeCloseTo(sheet.width, 0);
  expect(Number(blank.opacity)).toBeLessThan(1);
  // A press on the blank sheet puts the caret in the text, not nowhere.
  await page.mouse.click(blank.left + blank.width / 2, blank.top + blank.height / 2);
  expect(await page.evaluate(() => window.view.hasFocus() && window.view.state.selection.$head.parent.isTextblock)).toBe(true);
  // Stacked: no blank sheet.
  await toggleSpread(page);
  await expect(ghost).toHaveCount(0);
});

test('a short spread runs to the panel’s foot with greyed pairs, as the stacked pages do', async ({ page }) => {
  await halfSheets(page, 1);
  await toggleSpread(page);
  const foot = await page.evaluate(() => {
    const panel = document.querySelector('#scroll')!.getBoundingClientRect();
    const paper = document.querySelector('#paper')!.getBoundingClientRect();
    return { panel: panel.bottom, paper: paper.bottom, ghosts: document.querySelectorAll('#pages .page-ghost').length };
  });
  // The paper reaches the panel's foot: no band of frame under it.
  expect(foot.paper).toBeGreaterThanOrEqual(foot.panel - 0.5);
  // The blank beside page 1, and at least one blank pair below.
  expect(foot.ghosts).toBeGreaterThanOrEqual(3);
});
