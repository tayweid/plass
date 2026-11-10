import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// A table inside an editorial comment (editor-comments.ts, Taylor
// 2026-11-09: "just add a table inside the comment"): the page's own table,
// drawn by the browser in the note, never printed, so every printed break
// stays where it was; the Table tool puts it inside the note at the caret;
// the .md keeps it inside the `<!-- -->` as a Markdown table and reads it
// back; what print counts (a footnote) is refused in it; Backspace under a
// table goes into it, and deleting the table joins the lines around it.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null) => Promise<unknown> };
    __pagLog: () => string[];
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';
const paras = (n: number, k: number) => Array.from({ length: n }, () => FILLER.repeat(k).trimEnd()).join('\n\n');
const NOTE = '<!--\nGrading notes:\n\n| Q | Points |\n|---|---|\n| 1 | 5 |\n| 2 | 3 |\n\nThen more.\n-->';
const SHEET = (note: string) => ['# Notes', paras(3, 3), note, paras(6, 3)].filter(Boolean).join('\n\n') + '\n';

async function openMd(page: Page, name: string, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(
    async ({ name, text }) => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      await window.__fm.loadHandle(h, root);
    },
    { name, text },
  );
  await settleLocal(page);
}

const fileText = (page: Page, name: string) =>
  page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getFileHandle(name)).getFile()).text();
  }, name);

/** Each note as its children: a line's text, or T(the table's text). */
const notes = (page: Page) =>
  page.evaluate(() => {
    const out: string[][] = [];
    window.view.state.doc.forEach((n) => {
      if (n.type.name !== 'editor_comment') return;
      const kids: string[] = [];
      n.forEach((c) => kids.push(c.type.name === 'table' ? `T(${c.textContent})` : c.textContent));
      out.push(kids);
    });
    return out;
  });

/** The installed pagination's spacers in print vocabulary: (printed child
 *  index, offset in it, height), a spacer on a note read at the next
 *  printed child. */
const printedSpacers = (page: Page) =>
  page.evaluate(() => {
    const doc = window.view.state.doc;
    const entry = window.__pagLog().at(-1) ?? '';
    const spacers = entry.split(':').slice(1).join(':').split(',').filter(Boolean).map((s) => ({ pos: +s.split('@')[0], h: +s.split('@')[1] }));
    const kids: Array<{ name: string; off: number; end: number }> = [];
    doc.forEach((n, off) => kids.push({ name: n.type.name, off, end: off + n.nodeSize }));
    const printed = kids.filter((k) => k.name !== 'editor_comment');
    return spacers.map((sp) => {
      let pos = sp.pos;
      for (const k of kids) if (k.name === 'editor_comment' && pos >= k.off && pos < k.end) pos = k.end;
      let idx = printed.findIndex((k) => pos >= k.off && pos < k.end);
      if (idx < 0) idx = printed.findIndex((k) => k.off >= pos);
      return `${idx}+${pos - printed[idx].off}@${sp.h}`;
    });
  });

/** The caret at the end (or start) of the note's line holding `text`. */
const caretInLine = (page: Page, text: string, where: 'start' | 'end' = 'end') =>
  page.evaluate(
    ({ text, where }) => {
      const view = window.view;
      let at = -1;
      view.state.doc.descendants((n, pos) => {
        if (at < 0 && n.type.name === 'comment_text' && n.textContent === text) at = pos + 1 + (where === 'end' ? n.content.size : 0);
        return at < 0;
      });
      const Sel = view.state.selection.constructor as unknown as { create: (doc: unknown, pos: number) => never };
      view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, at)));
      view.focus();
    },
    { text, where },
  );

test('a comment’s table is drawn in the note, never printed, and leaves every printed break where it was', async ({ page }) => {
  await openMd(page, 'plain.md', SHEET(''));
  const plain = await printedSpacers(page);
  expect(plain.length).toBeGreaterThan(0);

  await openMd(page, 'noted.md', SHEET(NOTE));
  expect(await notes(page)).toEqual([['Grading notes:', 'T(QPoints1523)', 'Then more.']]);
  await expect(page.locator('.ProseMirror .editor-comment .editor-comment-body table tr')).toHaveCount(3);
  // The table is the note's: no printed geometry moves.
  expect(await printedSpacers(page)).toEqual(plain);
  // The note's table is the browser's: no port breaks were laid on it.
  expect(await page.locator('.ProseMirror .editor-comment table .ts-br').count()).toBe(0);
});

test('the Table tool puts a table inside the comment at the caret; the .md keeps it inside the comment and reads it back', async ({ page }) => {
  await openMd(page, 'notes.md', '# Notes\n\nA paragraph.\n\n<!-- Grading notes: -->\n\nAfter.\n');
  await caretInLine(page, 'Grading notes:');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.keyboard.type('Q');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Points');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.type('1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('5');
  expect(await notes(page)).toEqual([['Grading notes:', 'T(QPoints15)', '']]);
  // Still one note, between the same two paragraphs.
  expect(await page.evaluate(() => window.view.state.doc.childCount)).toBe(4);

  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => fileText(page, 'notes.md')).toContain('<!--\nGrading notes:\n\n| Q | Points |');
  const saved = await fileText(page, 'notes.md');
  expect(saved).toContain('| 1 | 5 |');
  // The empty line under the table is the reader's to put back: not written.
  expect(saved).toMatch(/\|\n-->\n\nAfter\.\n$/);

  await openMd(page, 'notes.md', saved);
  expect(await notes(page)).toEqual([['Grading notes:', 'T(QPoints15)', '']]);
});

test('a comment refuses a footnote in its table; Backspace under a table goes into it; deleting the table joins the lines', async ({ page }) => {
  await openMd(page, 'refuse.md', '# Notes\n\nA paragraph.\n\n<!--\nBefore\n\n| A | B |\n|---|---|\n| x | y |\n\nAfter\n-->\n\nEnd.\n');
  expect(await notes(page)).toEqual([['Before', 'T(ABxy)', 'After']]);

  // A footnote is numbered in print: not in a note.
  await caretInLine(page, 'After', 'start');
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => window.view.state.selection.$from.node(-1).type.name)).toMatch(/^table_(cell|header)$/);
  expect(await page.evaluate(() => window.view.state.selection.$from.parent.textContent)).toBe('y');
  await page.keyboard.press('ControlOrMeta+Alt+f');
  await expect(page.locator('#toast')).toContainText('Not in a comment: a footnote');
  expect(await page.evaluate(() => {
    let n = 0;
    window.view.state.doc.descendants((node) => {
      if (node.type.name === 'footnote') n++;
      return true;
    });
    return n;
  })).toBe(0);

  // Escape selects the table, Backspace deletes it: the lines join.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  expect(await notes(page)).toEqual([['Before\nAfter']]);
});
