import { expect, test, type Page } from 'playwright/test';
import { settleLocal } from './settle';

// Editorial comments (editor-comments.ts): notes between blocks that the
// page shows and the printer never does. Adding them must not move a single
// printed line or page start; each displayed sheet grows by exactly the
// notes it holds; the file keeps them; the compile omits them.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> };
    __pagLog: () => string[];
    __pagCount: () => number;
    __audit: () => Promise<{
      blocks: Array<{ status: string }>;
      chrome: unknown[];
      pages: { agree: boolean; local: unknown[]; typst: unknown[]; firstDiff: unknown };
      summary: { pagesAgree: boolean; match: number; mismatch: number; chromeMismatch: number };
    } | null>;
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';
const HEAD =
  '#set page(paper: "us-letter", margin: 1.25in, numbering: "1", number-align: center, header: context if(counter(page).get().first() > 1) { align(right)[Notes · #context { let hs = query(selector(heading.where(level: 1)).before(here())); if hs.len() > 0 { hs.last().body } }] })\n' +
  '#set par(justify: true, leading: 10.215pt, spacing: 21.465pt, first-line-indent: 1.5em)\n' +
  '#set text(font: "New Computer Modern", size: 12.5pt)\n\n';
const paras = (n: number, k: number) => Array.from({ length: n }, () => FILLER.repeat(k).trimEnd()).join('\n\n');
const frame = (t: string) => '// plass:comment\n' + t.split('\n').map((l) => '// | ' + l).join('\n') + '\n// /plass:comment';
const NOTES = [
  'Leading note: could this open with the library scene?',
  'Mid note between paragraphs.\nSecond line of the note.\n\nA blank line above.',
  'Before the heading.',
  'After the explicit page break.',
  'Trailing note at the very end.',
];
const body = (withNotes: boolean) =>
  [
    withNotes ? frame(NOTES[0]) : '',
    '= Introduction',
    paras(2, 3),
    withNotes ? frame(NOTES[1]) : '',
    paras(2, 3),
    'A sentence with a footnote#footnote[The footnote body, which is long enough to wrap onto a second line of the entry at the bottom of the page.] in it. ' +
      FILLER.repeat(2).trimEnd(),
    withNotes ? frame(NOTES[2]) : '',
    '= Supply and demand',
    paras(3, 3),
    '- first item\n- second item\n- third item',
    paras(4, 3),
    '#pagebreak()',
    withNotes ? frame(NOTES[3]) : '',
    paras(3, 3),
    withNotes ? frame(NOTES[4]) : '',
  ]
    .filter(Boolean)
    .join('\n\n') + '\n';

async function openTyp(page: Page, name: string, text: string) {
  await page.evaluate(
    async ({ name, text }) => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      await window.__fm.loadHandle(h);
    },
    { name, text },
  );
  await settleLocal(page);
}

interface Snapshot {
  spacers: string[];
  boxes: Array<{ top: number; height: number }>;
  notes: number[];
  chrome: Array<{ page: number; edge: string; top: number; text: string }>;
  footnotes: number[];
  words: string;
  stackHeight: number;
}

/** The installed pagination in print vocabulary: every spacer as
 *  (printed child index, offset within it, height), where a spacer that
 *  sits on a note is read at the next printed child (print starts there). */
const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => {
    const doc = window.view.state.doc;
    const entry = window.__pagLog().at(-1) ?? '';
    const spacers = entry
      .split(':')
      .slice(1)
      .join(':')
      .split(',')
      .filter(Boolean)
      .map((s) => ({ pos: +s.split('@')[0], h: +s.split('@')[1] }));
    const kids: Array<{ name: string; off: number; end: number }> = [];
    doc.forEach((n, off) => kids.push({ name: n.type.name, off, end: off + n.nodeSize }));
    const printed = kids.filter((k) => k.name !== 'editor_comment');
    const mapped = spacers.map((sp) => {
      let pos = sp.pos;
      for (const k of kids) if (k.name === 'editor_comment' && pos >= k.off && pos < k.end) pos = k.end;
      let idx = -1;
      for (let i = 0; i < printed.length; i++) if (pos >= printed[i].off && pos < printed[i].end) idx = i;
      if (idx < 0) idx = printed.findIndex((k) => k.off >= pos);
      return `${idx}+${pos - printed[idx].off}@${sp.h}`;
    });
    const stack = document.getElementById('stack')!;
    return {
      spacers: mapped,
      boxes: [...document.querySelectorAll<HTMLElement>('.page-box')].map((b) => ({ top: parseFloat(b.style.top), height: b.getBoundingClientRect().height })),
      notes: [...document.querySelectorAll<HTMLElement>('.ProseMirror .editor-comment')].map((n) => n.getBoundingClientRect().height),
      chrome: [...document.querySelectorAll<HTMLElement>('#pages .page-num')].map((el) => ({
        page: Number(el.dataset.page),
        edge: el.classList.contains('page-header') ? 'header' : 'footer',
        top: parseFloat(el.style.top),
        text: el.textContent ?? '',
      })),
      footnotes: [...document.querySelectorAll<HTMLElement>('.fn-body')].map((f) => parseFloat(f.style.top)),
      words: document.getElementById('hud')!.textContent ?? '',
      stackHeight: parseFloat(stack.style.height),
    };
  });

/** The print page each note sits on, by the sheet boxes. */
const notePages = (page: Page) =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll<HTMLElement>('.page-box')].map((b) => b.getBoundingClientRect());
    return [...document.querySelectorAll<HTMLElement>('.ProseMirror .editor-comment')].map((n) => {
      const r = n.getBoundingClientRect();
      return boxes.findIndex((b) => r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5);
    });
  });

/** Put the caret in the index-th note: at its end, its start, or over
 *  all of its text (`where: 'all'`). */
const caretIntoNote = (page: Page, index: number, where: 'end' | 'start' | 'all' = 'end') =>
  page.evaluate(
    ({ index, where }) => {
      const { state } = window.view;
      let target: { off: number; size: number } | null = null;
      let i = 0;
      state.doc.forEach((n, off) => {
        if (n.type.name === 'editor_comment' && i++ === index) target = { off, size: n.content.size };
      });
      if (!target) throw new Error('no such note');
      const t = target as { off: number; size: number };
      const Sel = state.selection.constructor as unknown as { create: (doc: unknown, anchor: number, head?: number) => unknown };
      const sel = where === 'all' ? Sel.create(state.doc, t.off + 1, t.off + 1 + t.size) : Sel.create(state.doc, t.off + 1 + (where === 'end' ? t.size : 0));
      window.view.dispatch(state.tr.setSelection(sel as never).scrollIntoView());
      window.view.focus();
    },
    { index, where },
  );

const caretParent = (page: Page) =>
  page.evaluate(() => {
    const $f = window.view.state.selection.$from;
    return { parent: $f.depth ? $f.node(1).type.name : 'doc', index: $f.index(0), offset: $f.parentOffset, text: $f.depth ? $f.node(1).textContent : '' };
  });

test('notes leave every printed break and page start where it was; sheets grow by exactly their notes', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await openTyp(page, 'plain.typ', HEAD + body(false));
  const plain = await snapshot(page);
  expect(plain.notes).toEqual([]);
  expect(plain.boxes.length).toBeGreaterThanOrEqual(4);
  const pageH = plain.boxes[0].height;
  const gap = plain.boxes[1].top - plain.boxes[0].height;

  await openTyp(page, 'notes.typ', HEAD + body(true));
  const notes = await snapshot(page);
  // The document holds the five notes, verbatim.
  const noteTexts = await page.evaluate(() => {
    const out: string[] = [];
    window.view.state.doc.forEach((n) => {
      if (n.type.name === 'editor_comment') out.push(n.textContent);
    });
    return out;
  });
  expect(noteTexts).toEqual(NOTES);
  // Identical breaks and page starts (print vocabulary), same page count.
  expect(notes.spacers).toEqual(plain.spacers);
  expect(notes.boxes.length).toBe(plain.boxes.length);
  expect(notes.words).toBe(plain.words);
  // Each sheet is the print page plus its notes; every later sheet moves
  // down by the cumulative amount; nothing else changes the print height.
  const pages = await notePages(page);
  expect(pages.every((p) => p >= 0)).toBe(true);
  const extras = new Array<number>(plain.boxes.length).fill(0);
  notes.notes.forEach((h, i) => (extras[pages[i]] += h));
  let top = 0;
  for (let k = 0; k < notes.boxes.length; k++) {
    expect(Math.abs(notes.boxes[k].top - top)).toBeLessThan(0.1);
    expect(Math.abs(notes.boxes[k].height - (pageH + extras[k]))).toBeLessThan(0.1);
    top += pageH + extras[k] + gap;
  }
  expect(Math.abs(notes.stackHeight - (top - gap))).toBeLessThan(0.1);
  // Folios, running headers, and footnotes follow their sheet's edges.
  const shiftOf = (k: number) => extras.slice(0, k).reduce((a, b) => a + b, 0);
  expect(notes.chrome.map((c) => [c.page, c.edge, c.text])).toEqual(plain.chrome.map((c) => [c.page, c.edge, c.text]));
  for (let i = 0; i < plain.chrome.length; i++) {
    const c = plain.chrome[i];
    const shift = c.edge === 'header' ? shiftOf(c.page) : shiftOf(c.page + 1);
    expect(Math.abs(notes.chrome[i].top - (c.top + shift)), `${c.edge} of page ${c.page}`).toBeLessThan(0.1);
  }
  expect(notes.footnotes.length).toBe(plain.footnotes.length);
  expect(notes.footnotes.length).toBe(1);
  expect(Math.abs(notes.footnotes[0] - (plain.footnotes[0] + shiftOf(1)))).toBeLessThan(0.75);

  // Typst agrees: the compile omits the notes, so every block's breaks and
  // every page start match the paginator's, and the chrome too.
  const report = await page.evaluate(() => window.__audit());
  expect(report).not.toBeNull();
  expect(report!.summary.mismatch).toBe(0);
  expect(report!.summary.chromeMismatch).toBe(0);
  expect(report!.pages, JSON.stringify(report!.pages.firstDiff)).toMatchObject({ agree: true });

  // The file keeps the notes; the print compile and the TeX export do not.
  const exports = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    const { docToTex } = await import('/src/tex-serializer.ts');
    const doc = window.view.state.doc;
    const stripped = doc.type.create(doc.attrs, doc.content.content.filter((n) => n.type.name !== 'editor_comment'));
    return {
      file: docToTyp(doc),
      print: docToTyp(doc, { islands: 'print' }),
      printPlain: docToTyp(stripped, { islands: 'print' }),
      tex: docToTex(doc),
      texPlain: docToTex(stripped),
    };
  });
  for (const t of NOTES) expect(exports.file).toContain(frame(t));
  expect(exports.print).toBe(exports.printPlain);
  expect(exports.tex).toBe(exports.texPlain);
  expect(exports.print).not.toContain('plass:comment');

  // A narrower window: the sheet is a fixed-width page, so nothing
  // re-lays; the relationship simply holds.
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(600);
  const narrow = await snapshot(page);
  expect(narrow.spacers).toEqual(plain.spacers);
  const narrowPages = await notePages(page);
  const narrowExtras = new Array<number>(narrow.boxes.length).fill(0);
  narrow.notes.forEach((h, i) => (narrowExtras[narrowPages[i]] += h));
  narrow.boxes.forEach((b, k) => expect(Math.abs(b.height - (pageH + narrowExtras[k]))).toBeLessThan(0.1));
});

test('editing a note: newlines, exit, live sheet growth, insert, delete, undo', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await openTyp(page, 'notes-edit.typ', HEAD + body(true));
  const before = await snapshot(page);
  const countBefore = await page.evaluate(() => window.__pagCount());

  // Enter is a newline inside the note, never a split; the sheet follows
  // the keystroke, and the settled pass confirms the same print geometry.
  await caretIntoNote(page, 1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed line one, long enough to wrap around the strip so the sheet must grow by another line of note text here.');
  await page.waitForTimeout(150);
  const live = await snapshot(page);
  const caret = await caretParent(page);
  expect(caret.parent).toBe('editor_comment');
  expect(caret.text).toBe(NOTES[1] + '\nTyped line one, long enough to wrap around the strip so the sheet must grow by another line of note text here.');
  const grown = live.notes[1] - before.notes[1];
  expect(grown).toBeGreaterThan(10);
  expect(Math.abs(live.boxes[0].height - (before.boxes[0].height + grown))).toBeLessThan(0.1);
  await settleLocal(page, countBefore);
  const settled = await snapshot(page);
  expect(settled.spacers.map((s) => s.split('@')[1])).toEqual(before.spacers.map((s) => s.split('@')[1]));
  expect(Math.abs(settled.boxes[0].height - live.boxes[0].height)).toBeLessThan(0.1);
  expect(settled.words).toBe(before.words);

  // Mod-Enter leaves the note for the next block; no page break appears.
  await page.keyboard.press('ControlOrMeta+Enter');
  const after = await caretParent(page);
  expect(after.parent).toBe('paragraph');
  expect(after.offset).toBe(0);
  const breaks = await page.evaluate(() => {
    let c = 0;
    window.view.state.doc.forEach((n) => {
      if (n.type.name === 'page_break') c++;
    });
    return c;
  });
  expect(breaks).toBe(1);

  // Insert from Extras with the caret at a paragraph's start: the note goes
  // BEFORE it, and the paragraph is untouched.
  const kidsBefore = await page.evaluate(() => {
    const k: string[] = [];
    window.view.state.doc.forEach((n) => k.push(n.type.name));
    return k;
  });
  await page.getByRole('button', { name: 'Extras' }).click();
  await page.getByRole('menuitem', { name: 'Comment' }).click();
  const inserted = await caretParent(page);
  expect(inserted.parent).toBe('editor_comment');
  expect(inserted.index).toBe(after.index);
  const kidsAfter = await page.evaluate(() => {
    const k: string[] = [];
    window.view.state.doc.forEach((n) => k.push(n.type.name));
    return k;
  });
  expect(kidsAfter).toEqual([...kidsBefore.slice(0, after.index), 'editor_comment', ...kidsBefore.slice(after.index)]);
  await page.keyboard.type('Fresh note from the toolbar.');
  // Nested insertion is refused: the command declines inside a note.
  await page.getByRole('button', { name: 'Extras' }).click();
  await expect(page.getByRole('menuitem', { name: 'Comment' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // The header's delete is one undoable step (a beat after typing, so the
  // history does not group the two).
  await page.waitForTimeout(700);
  const noteEls = page.locator('.ProseMirror .editor-comment');
  await noteEls.nth(2).locator('.editor-comment-delete').click();
  expect(await page.evaluate(() => window.view.state.doc.childCount)).toBe(kidsAfter.length - 1);
  await page.keyboard.press('ControlOrMeta+z');
  const restored = await page.evaluate(() => {
    const n = window.view.state.doc.child(5);
    return { type: n.type.name, text: n.textContent, count: window.view.state.doc.childCount };
  });
  expect(restored).toEqual({ type: 'editor_comment', text: 'Fresh note from the toolbar.', count: kidsAfter.length });

  // Backspace at the start of a filled note holds; an emptied note deletes.
  await caretIntoNote(page, 2, 'start');
  await page.keyboard.press('Backspace');
  expect((await caretParent(page)).text).toBe('Fresh note from the toolbar.');
  await caretIntoNote(page, 2, 'all');
  await page.keyboard.press('Backspace');
  expect((await caretParent(page)).text).toBe('');
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => window.view.state.doc.childCount)).toBe(kidsAfter.length - 1);

  // The page view's text normalizer leaves a note alone: two spaces and a
  // straight quote stay as typed.
  await caretIntoNote(page, 0);
  await page.keyboard.type("  it's -- 'raw'");
  expect((await caretParent(page)).text).toBe(NOTES[0] + "  it's -- 'raw'");

  // Browser print removes the notes and the space they took.
  await page.emulateMedia({ media: 'print' });
  const printed = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.ProseMirror .editor-comment')].map((n) => getComputedStyle(n).display));
  expect(printed.every((d) => d === 'none')).toBe(true);
  await page.emulateMedia({ media: null });
});

test('the source view round-trips notes and a .md file keeps them as tagged comments', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await openTyp(page, 'notes-src.typ', HEAD + body(true));
  const md = await page.evaluate(async () => {
    const { docToMd } = await import('/src/md-serializer.ts');
    const { mdToDoc } = await import('/src/md-parser.ts');
    const out = docToMd(window.view.state.doc);
    const back = mdToDoc(out).doc;
    const notes: string[] = [];
    back.forEach((n) => {
      if (n.type.name === 'editor_comment') notes.push(n.textContent);
    });
    return { out, notes };
  });
  expect(md.notes).toEqual(NOTES);
  expect(md.out).toContain('<!-- plass:comment\nBefore the heading.\n-->');
});
