// A press anywhere on the paper outside the text puts the caret in the
// text, and the keys write (src/paper-caret.ts). Taylor, 2026-10-06: "on a
// blank page i can lose the cursor by clicking on the page. and nothing
// writes when i keyboard. the only way back is command r." The text column
// of a blank page is one empty line at the top margin; a press anywhere
// else on the sheet (a margin, the white below the line, the frame under
// a short paper) took the focus off the editor and left the keys going
// nowhere. Real mouse presses at screen points, then real keys.
import { expect, test, type Page } from './fixture';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };

const box = (page: Page, selector: string, index = 0) =>
  page.evaluate(([selector, index]) => {
    const el = document.querySelectorAll(selector)[index as number];
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } as Box;
  }, [selector, index] as const);

const text = (page: Page) => page.evaluate(() => {
  const out: string[] = [];
  window.view.state.doc.forEach((block) => out.push(block.textContent));
  return out;
});

const focused = (page: Page) => page.evaluate(() => window.view.hasFocus());

async function blank(page: Page) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view && window.view.hasFocus());
  await expect(page.locator('.page-box').first()).toBeVisible();
}

/** Press at a point, then type: the keys must reach the document. */
async function pressAndType(page: Page, x: number, y: number, keys: string) {
  await page.mouse.click(x, y);
  await expect.poll(() => focused(page)).toBe(true);
  await page.keyboard.type(keys);
}

test('every press on a blank page leaves a caret that writes', async ({ page }) => {
  await blank(page);
  const line = await box(page, '.ProseMirror > p');
  const sheet = await box(page, '.page-box');
  const panel = await box(page, '#scroll');
  const bottom = Math.min(sheet.bottom, panel.bottom) - 12;
  const points: Array<[string, number, number]> = [
    ['below the empty line, in the text column', line.x + 60, line.bottom + 30],
    ['the middle of the sheet', line.x + line.width / 2, (line.bottom + bottom) / 2],
    ['the left margin', sheet.x + 20, line.y + line.height / 2],
    ['the right margin', sheet.right - 20, line.bottom + 80],
    ['the top margin', sheet.x + sheet.width / 2, sheet.y + 20],
    ['the bottom of the sheet in view', line.x + 40, bottom],
  ];
  let expected = '';
  for (const [where, x, y] of points) {
    // Each press is from a caret that is already there: the bug left the
    // editor focused until the press, then nothing.
    await pressAndType(page, x, y, 'ab');
    expected += 'ab';
    await expect.poll(() => text(page), { message: where }).toEqual([expected]);
  }
});

test('a press below the last line puts the caret at the end; one beside a line, at its near end', async ({ page }) => {
  await blank(page);
  await page.keyboard.type('First line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line');
  await expect.poll(() => text(page)).toEqual(['First line', 'Second line']);
  const second = await box(page, '.ProseMirror > p', 1);
  const first = await box(page, '.ProseMirror > p', 0);
  const sheet = await box(page, '.page-box');

  // Far below the last block, on the blank sheet, from a caret in the
  // first line: the end of the document.
  await page.mouse.click(first.x + 2, first.y + first.height / 2);
  await expect.poll(() => page.evaluate(() => window.view.state.selection.head)).toBeLessThan(4);
  await pressAndType(page, second.x + 40, second.bottom + 200, '!');
  await expect.poll(() => text(page)).toEqual(['First line', 'Second line!']);

  // The left margin beside the second line: its start.
  await pressAndType(page, sheet.x + 30, second.y + second.height / 2, '>');
  await expect.poll(() => text(page)).toEqual(['First line', '>Second line!']);

  // The right margin beside the first line: its end.
  await pressAndType(page, sheet.right - 30, first.y + first.height / 2, '.');
  await expect.poll(() => text(page)).toEqual(['First line.', '>Second line!']);
});

test('a drag from the margin selects the lines it crosses, and a shift-press extends', async ({ page }) => {
  await blank(page);
  await page.keyboard.type('First line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line');
  const first = await box(page, '.ProseMirror > p', 0);
  const second = await box(page, '.ProseMirror > p', 1);
  const sheet = await box(page, '.page-box');
  const selected = () => page.evaluate(() => {
    const { state } = window.view;
    return state.doc.textBetween(state.selection.from, state.selection.to, '|');
  });

  await page.mouse.move(sheet.x + 30, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(sheet.right - 30, second.y + second.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(selected).toBe('First line|Second line');
  expect(await focused(page)).toBe(true);

  // A press in the left margin beside the first line, then a shift-press
  // below the last line: the whole document.
  await page.waitForTimeout(400);
  await page.mouse.click(sheet.x + 30, first.y + first.height / 2);
  await page.keyboard.down('Shift');
  await page.mouse.click(second.x + 40, second.bottom + 120);
  await page.keyboard.up('Shift');
  await expect.poll(selected).toBe('First line|Second line');
});

test('a press below a document ending in an equation puts a caret in the text, never on the equation', async ({ page }) => {
  await blank(page);
  await page.keyboard.type('Before');
  await page.evaluate(() => {
    const { state } = window.view;
    const math = state.schema.nodes.math_display.create({ src: 'x^2' });
    window.view.dispatch(state.tr.insert(state.doc.content.size, math));
  });
  await expect(page.locator('.ProseMirror > *').last()).toBeVisible();
  const last = await box(page, '.ProseMirror > *', 1);
  await pressAndType(page, last.x + 40, last.bottom + 120, '!');
  await expect.poll(() => page.evaluate(() => {
    const out: string[] = [];
    window.view.state.doc.forEach((block) => out.push(block.type.name + ':' + block.textContent));
    return out;
  })).toEqual(['paragraph:Before!', 'math_display:']);
});

test('the frame under a short paper writes at the end; a press on the bare frame keeps the caret', async ({ page }) => {
  // A window taller than the drawn Letter page: the panel's frame shows
  // below the paper.
  await page.setViewportSize({ width: 700, height: 1300 });
  await blank(page);
  await page.keyboard.type('Short');
  const paper = await box(page, '#paper');
  const panel = await box(page, '#scroll');
  expect(panel.bottom - paper.bottom).toBeGreaterThan(80);
  await page.mouse.click(paper.x + 100, paper.y + 140);
  await pressAndType(page, paper.x + 100, paper.bottom + 40, '!');
  await expect.poll(() => text(page)).toEqual(['Short!']);

  // The window's bare edge below the panel, and the HUD's chip in the
  // panel's corner: no caret move, the focus stays.
  await page.mouse.click(paper.x + 100, panel.bottom + 3);
  expect(await focused(page)).toBe(true);
  await page.keyboard.type('?');
  await expect.poll(() => text(page)).toEqual(['Short!?']);
  await expect(page.locator('#hud')).toBeVisible();
  const hud = await box(page, '#hud');
  await page.mouse.click(hud.x + hud.width / 2, hud.y + hud.height / 2);
  expect(await focused(page)).toBe(true);
  await page.keyboard.type('#');
  await expect.poll(() => text(page)).toEqual(['Short!?#']);
});

test('a press on the margin of a page drawn larger than its layout writes', async ({ page }) => {
  // Plass.app's shape: the window is the paper, drawn at the panel's
  // width by a transform (src/paper-scale.ts).
  await page.setViewportSize({ width: 1300, height: 800 });
  await blank(page);
  await page.keyboard.type('Wide');
  const sheet = await box(page, '.page-box');
  expect(sheet.width).toBeGreaterThan(1000);
  const line = await box(page, '.ProseMirror > p');
  await pressAndType(page, sheet.x + 40, line.y + line.height / 2, '<');
  await pressAndType(page, line.x + 80, line.bottom + 300, '>');
  await expect.poll(() => text(page)).toEqual(['<Wide>']);
});
