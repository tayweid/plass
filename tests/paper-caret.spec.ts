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

type SourceHook = { text(): string | null; caret(): number };
const sourceText = (page: Page) => page.evaluate(() => (window as unknown as { __sourceView: SourceHook }).__sourceView.text());
const sourceCaret = (page: Page) => page.evaluate(() => (window as unknown as { __sourceView: SourceHook }).__sourceView.caret());
const sourceFocused = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('.cm-editor'));

test('in the plain-text view, a press on the sheet outside the text writes', async ({ page }) => {
  // CodeMirror's text is a measure in the middle of the sheet: its air
  // (the editor's padding, the sheet either side, #paper under a short
  // text) took the focus to the body as the page view's margins did.
  await blank(page);
  await page.keyboard.type('Hello');
  await page.getByRole('button', { name: 'Plain text view' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect.poll(() => sourceText(page)).toMatch(/^Hello\n*$/);
  const content = await box(page, '.cm-content');
  const editor = await box(page, '.cm-editor');
  const paper = await box(page, '#paper');
  const line = await box(page, '.cm-line');
  expect(editor.y).toBeLessThan(content.y - 40);
  expect(paper.bottom).toBeGreaterThan(editor.bottom + 40);
  const middle = line.y + line.height / 2;

  const press = async (where: string, x: number, y: number, caret: (text: string) => number, keys: string) => {
    await page.mouse.click(x, y);
    await expect.poll(() => sourceFocused(page), { message: where }).toBe(true);
    const before = (await sourceText(page))!;
    const at = caret(before);
    expect(await sourceCaret(page), where).toBe(at);
    await page.keyboard.type(keys);
    await expect.poll(() => sourceText(page), { message: where }).toBe(before.slice(0, at) + keys + before.slice(at));
  };
  const lineEnd = (text: string) => text.indexOf('\n') < 0 ? text.length : text.indexOf('\n');
  await press('the left margin beside the line', editor.x + 20, middle, () => 0, '>');
  await press('the right margin beside the line', editor.right - 20, middle, lineEnd, '<');
  await press('the top margin, over the line\'s start', content.x + 2, editor.y + 20, () => 0, '^');
  await press('the editor\'s padding below the text', content.x + 60, editor.bottom - 20, (t) => t.length, '!');
  await press('the sheet below the editor', content.x + 60, (editor.bottom + paper.bottom) / 2, (t) => t.length, '?');
  await expect.poll(() => sourceText(page)).toMatch(/^\^>Hello<\n*!\?$/);

  // A right-click on the sheet keeps the caret where it is.
  await page.mouse.click(editor.x + 20, middle, { button: 'right' });
  await expect.poll(() => page.evaluate(() => !!document.getSelection()!.anchorNode?.parentElement?.closest('.cm-content'))).toBe(true);
  await page.keyboard.type('.');
  await expect.poll(() => sourceText(page)).toMatch(/^\^>Hello<\n*!\?\.$/);
});

test('a press in the margin beside a narrow table goes in its row, never in the comment before it', async ({ page }) => {
  // A centered two-column table is narrower than the text column: a point
  // beside it is over nothing, and the text before the table was an
  // editorial comment, so a margin press wrote into the note.
  await blank(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('narrow-table.md', { create: true });
    const w = await h.createWritable();
    await w.write('First paragraph.\n\n<!-- plass:comment\nRemember to check this proof.\n-->\n\n| A | B |\n|---|---|\n| one | two |\n| three | four |\n\nLast paragraph.\n');
    await w.close();
    await (window as unknown as { __fm: { loadHandle(h: FileSystemFileHandle): Promise<unknown> } }).__fm.loadHandle(h);
  });
  await expect(page.locator('.ProseMirror table')).toBeVisible();
  await expect(page.locator('.editor-comment')).toBeVisible();
  const sheet = await box(page, '.page-box');
  const table = await box(page, '.ProseMirror table');
  const column = await box(page, '.ProseMirror');
  expect(table.width).toBeLessThan(column.width / 2);
  const cells = () => page.evaluate(() => {
    const out: string[] = [];
    window.view.state.doc.forEach((block) => {
      if (block.type.name === 'table') block.forEach((row) => row.forEach((cell) => out.push(cell.textContent)));
      else out.push(block.type.name + ':' + block.textContent);
    });
    return out;
  });
  const row = (i: number) => box(page, '.ProseMirror table tr', i);

  const header = await row(0);
  await pressAndType(page, sheet.x + 20, header.y + header.height / 2, '<');
  const last = await row(2);
  await pressAndType(page, sheet.x + 20, last.y + last.height / 2, '[');
  const middle = await row(1);
  await pressAndType(page, sheet.right - 20, middle.y + middle.height / 2, ']');
  await expect.poll(cells).toEqual([
    'paragraph:First paragraph.',
    'editor_comment:Remember to check this proof.',
    '<A', 'B', 'one', 'two]', '[three', 'four',
    'paragraph:Last paragraph.',
  ]);
});

test('a right-click on the paper and a press on a table toolbar\'s background keep the caret', async ({ page }) => {
  await blank(page);
  await page.evaluate(() => {
    const { state } = window.view;
    const { table, table_row, table_cell, paragraph } = state.schema.nodes;
    const cell = (text: string) => table_cell.create(null, paragraph.create(null, state.schema.text(text)));
    window.view.dispatch(state.tr.insert(state.doc.content.size, table.create(null, [table_row.create(null, [cell('A'), cell('B')])])));
  });
  await page.locator('.ProseMirror td').first().click();
  await page.keyboard.press('End');
  const toolbar = page.getByRole('toolbar', { name: 'Table controls' });
  await expect(toolbar).toBeVisible();
  // A point of the toolbar between its controls.
  const free = await toolbar.evaluate((root) => {
    const r = root.getBoundingClientRect();
    for (let y = r.top + 1; y < r.bottom; y += 2)
      for (let x = r.left + 1; x < r.right; x += 2) {
        const el = document.elementFromPoint(x, y);
        if (el && root.contains(el) && !el.closest('button, input, select, label')) return { x, y };
      }
    return null;
  });
  expect(free).not.toBeNull();
  await page.mouse.click(free!.x, free!.y);
  expect(await focused(page)).toBe(true);
  await page.keyboard.type('1');

  await page.evaluate(() => {
    (window as unknown as { menus: number }).menus = 0;
    document.addEventListener('contextmenu', () => (window as unknown as { menus: number }).menus++);
  });
  const sheet = await box(page, '.page-box');
  await page.mouse.click(sheet.x + 20, sheet.y + 300, { button: 'right' });
  expect(await page.evaluate(() => (window as unknown as { menus: number }).menus)).toBe(1);
  expect(await focused(page)).toBe(true);
  // The menu's word selection (a Mac's, off the text: the page number) is
  // given back to the editor.
  await expect.poll(() => page.evaluate(() => window.view.dom.contains(document.getSelection()!.anchorNode))).toBe(true);
  await page.keyboard.type('2');
  await expect.poll(() => page.evaluate(() => {
    let cell = '';
    window.view.state.doc.descendants((n) => { if (n.type.name === 'table_cell' && !cell) cell = n.textContent; });
    return cell;
  })).toBe('A12');
});
