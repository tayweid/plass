import { expect, test } from 'playwright/test';

// SOURCE-VIEW.md: the source view is a second editor for the same rails.
// Entering serializes the document in its own format, leaving parses the
// text back as ONE transaction, and while it is open the text is the truth
// (saved verbatim, restored unparsed, exported by parsing on demand). Every
// test drives the app's own instances through the DEV hooks (`window.view`,
// `__fm`, `__sourceView`, `__loadDemo`) — never a dynamic import of app
// modules (CLAUDE.md, testing gotchas).

interface SourceViewHook {
  enter(): Promise<boolean>;
  exit(): Promise<boolean>;
  isActive(): boolean;
  text(): string | null;
  setText(text: string): void;
  caret(): number;
  setCaret(offset: number): void;
}

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __sourceView: SourceViewHook;
    __loadDemo: () => void;
    __fm: {
      name: string;
      format: '.md' | '.typ';
      dirty: boolean;
      handle: FileSystemFileHandle | null;
      dir: FileSystemDirectoryHandle | null;
      loadHandle(handle: FileSystemFileHandle, dir: FileSystemDirectoryHandle): Promise<boolean>;
    };
    __pagLog: () => string[];
    __pagCount: () => number;
    __layoutDispatchStats: (reset?: boolean) => { lines: number; pageMarks: number };
    __compilerLifecycleStats: () => Promise<{ tasksPosted: number; active: boolean; queued: number }>;
  }
}

type Page = import('playwright/test').Page;

async function boot(page: Page): Promise<void> {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.__sourceView && !!window.__fm);
}

async function loadDemo(page: Page): Promise<void> {
  await boot(page);
  await page.evaluate(() => window.__loadDemo());
  await expect.poll(() => page.evaluate(() => window.view.state.doc.childCount)).toBeGreaterThan(10);
}

const docJson = (page: Page) => page.evaluate(() => JSON.stringify(window.view.state.doc.toJSON()));

/** Where two document JSONs first differ, by top-level block — a readable
 *  failure instead of two 30 KB strings. */
function firstDifference(a: string, b: string): string | null {
  if (a === b) return null;
  const A = JSON.parse(a) as { attrs: unknown; content: unknown[] };
  const B = JSON.parse(b) as { attrs: unknown; content: unknown[] };
  if (JSON.stringify(A.attrs) !== JSON.stringify(B.attrs)) {
    return `attrs: ${JSON.stringify(A.attrs)} vs ${JSON.stringify(B.attrs)}`;
  }
  for (let i = 0; i < Math.max(A.content.length, B.content.length); i++) {
    const x = JSON.stringify(A.content[i]);
    const y = JSON.stringify(B.content[i]);
    if (x !== y) return `block ${i}: ${x?.slice(0, 400)} vs ${y?.slice(0, 400)}`;
  }
  return 'differs outside blocks and attrs';
}
const enter = (page: Page) => page.evaluate(() => window.__sourceView.enter());
const exit = (page: Page) => page.evaluate(() => window.__sourceView.exit());
const sourceText = (page: Page) => page.evaluate(() => window.__sourceView.text());

/** Seed an OPFS project folder with one file and open it in the app. */
async function openSeeded(page: Page, fileName: string, contents: string): Promise<void> {
  await page.evaluate(
    async ({ fileName, contents }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(`sv-${Math.random().toString(36).slice(2)}`, { create: true });
      const handle = await dir.getFileHandle(fileName, { create: true });
      const w = await handle.createWritable();
      await w.write(contents);
      await w.close();
      await window.__fm.loadHandle(handle, dir);
    },
    { fileName, contents },
  );
}

const onDisk = (page: Page) => page.evaluate(() => window.__fm.handle!.getFile().then((f) => f.text()));

test('toggling in and out of the source leaves the demo document identical', async ({ page }) => {
  await loadDemo(page);
  const before = await docJson(page);
  expect(await enter(page)).toBe(true);
  expect(await page.evaluate(() => window.__sourceView.isActive())).toBe(true);
  await expect(page.locator('#source .cm-content')).toBeVisible();
  await expect(page.locator('#editor')).toBeHidden();
  const text = await sourceText(page);
  expect(text).toContain('\n= Plass\n');
  expect(text).toContain('#footnote[');
  expect(await exit(page)).toBe(true);
  await expect(page.locator('#source')).toHaveCount(0);
  await expect(page.locator('#editor')).toBeVisible();
  expect(firstDifference(before, await docJson(page))).toBeNull();
  // An untouched round trip installs nothing: still clean.
  expect(await page.evaluate(() => window.__fm.dirty)).toBe(false);
});

test('a source-side edit is one undo step', async ({ page }) => {
  await loadDemo(page);
  const before = await docJson(page);
  await enter(page);
  await page.evaluate(() => {
    const sv = window.__sourceView;
    sv.setText(sv.text()!.trimEnd() + '\n\nA paragraph written in the source.\n');
  });
  await exit(page);
  const after = await docJson(page);
  expect(after).not.toBe(before);
  expect(await page.evaluate(() => window.view.state.doc.lastChild!.textContent)).toBe(
    'A paragraph written in the source.',
  );
  await page.keyboard.press('ControlOrMeta+z');
  expect(await docJson(page)).toBe(before);
  // One step, not two: a second undo has nothing of ours left to revert.
  await page.keyboard.press('ControlOrMeta+z');
  expect(await docJson(page)).toBe(before);
});

test('headings, paragraphs and footnotes typed in the source appear in the page', async ({ page }) => {
  await loadDemo(page);
  await enter(page);
  await page.evaluate(() => {
    const sv = window.__sourceView;
    sv.setText(sv.text()!.trimEnd() + '\n\n== Written as text\n\nA new paragraph with a note.#footnote[From the source.]\n');
  });
  await exit(page);
  const tail = await page.evaluate(() => {
    const { doc } = window.view.state;
    const heading = doc.child(doc.childCount - 2);
    const para = doc.lastChild!;
    let note = '';
    para.descendants((n) => {
      if (n.type.name === 'footnote') note = n.textContent;
      return !note;
    });
    return { heading: heading.type.name, level: heading.attrs.level, headingText: heading.textContent, para: para.type.name, note };
  });
  expect(tail).toEqual({ heading: 'heading', level: 2, headingText: 'Written as text', para: 'paragraph', note: 'From the source.' });
  await expect(page.locator('.ProseMirror h2', { hasText: 'Written as text' })).toBeVisible();
});

test('autosave in the source writes the typed bytes verbatim', async ({ page }) => {
  await boot(page);
  await openSeeded(page, 'Notes.md', '# Notes\n\nFirst thought.\n');
  await enter(page);
  expect(await sourceText(page)).toContain('# Notes');
  // Real keystrokes, including a double space the page view would collapse.
  await page.locator('#source .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nSecond  thought,  untouched.');
  await expect.poll(() => onDisk(page), { timeout: 5_000 }).toContain('Second  thought,  untouched.');
  expect(await onDisk(page)).toBe(await sourceText(page));
  expect(await page.evaluate(() => window.__fm.dirty)).toBe(false);
});

test('a reload while in the source restores the same unparsed text and mode', async ({ page }) => {
  await loadDemo(page);
  await enter(page);
  const typed = (await sourceText(page))!.trimEnd() + '\n\nKept   exactly   as   typed.\n';
  await page.evaluate((t) => window.__sourceView.setText(t), typed);
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForFunction(() => !!window.__sourceView);
  await expect.poll(() => page.evaluate(() => window.__sourceView.isActive())).toBe(true);
  expect(await sourceText(page)).toBe(typed);
  await expect(page.locator('#editor')).toBeHidden();
  await expect(page.locator('.tb-source')).toHaveAttribute('aria-pressed', 'true');
  // Leaving parses the restored text: the page shows the paragraph, spaces collapsed.
  await exit(page);
  expect(await page.evaluate(() => window.view.state.doc.lastChild!.textContent)).toBe('Kept exactly as typed.');
});

test('a Markdown document shows Markdown and a Typst document shows Typst', async ({ page }) => {
  await boot(page);
  await openSeeded(page, 'Outline.md', '# Outline\n\n## Part A\n\n- one\n- two\n');
  await enter(page);
  const md = await sourceText(page);
  expect(md).toMatch(/^# Outline/m);
  expect(md).toMatch(/^## Part A/m);
  expect(md).not.toContain('#set page');
  await expect(page.locator('#source .cm-content')).toHaveClass(/cm-content/);
  await exit(page);

  await openSeeded(page, 'Paper.typ', '= Paper\n\n== Part A\n\nBody.\n');
  await enter(page);
  const typ = await sourceText(page);
  expect(typ).toMatch(/^= Paper/m);
  expect(typ).toMatch(/^== Part A/m);
  expect(typ).toContain('#set page');
  await exit(page);
});

test('the toolbar button and the shortcut toggle from either view', async ({ page }) => {
  await loadDemo(page);
  const btn = page.locator('.tb-source');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#source .cm-content')).toBeFocused();
  // Formatting tools rest while the text is the truth.
  expect(await page.locator('.tb-tools button:disabled').count()).toBeGreaterThan(3);
  // The shortcut from inside CodeMirror (it must not swallow it).
  await page.keyboard.press('ControlOrMeta+/');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeFocused();
  expect(await page.locator('.tb-tools button:disabled').count()).toBe(0);
  // And from the page view.
  await page.keyboard.press('ControlOrMeta+/');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#hud')).not.toContainText(' p · ');
  await page.keyboard.press('ControlOrMeta+/');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
});

test('the layout sleeps in the source and wakes into exact pagination', async ({ page }) => {
  await boot(page);
  const sentence =
    'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';
  await page.evaluate((sentence) => {
    const { state } = window.view;
    const { schema } = state;
    const blocks = [];
    for (let i = 0; i < 14; i++) {
      blocks.push(schema.nodes.paragraph.create(null, schema.text(`Paragraph ${i + 1}. ` + sentence.repeat(8).trim())));
    }
    const doc = schema.nodes.doc.create(state.doc.attrs, blocks);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
  }, sentence);
  await expect
    .poll(() => page.evaluate(() => window.__pagLog().at(-1)?.startsWith('exact[') ?? false), {
      timeout: 30_000,
      intervals: [250, 500, 1_000],
    })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(async () => {
      const s = await window.__compilerLifecycleStats();
      return !s.active && s.queued === 0;
    }), { timeout: 20_000 })
    .toBe(true);
  await page.waitForTimeout(1_500);
  await page.evaluate(() => window.__layoutDispatchStats(true));

  await enter(page);
  const before = await page.evaluate(() => ({ passes: window.__pagCount(), log: window.__pagLog().length }));
  await page.locator('#source .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\nTyped while the page view slept.');
  await page.waitForTimeout(2_000);
  const during = await page.evaluate(() => ({
    passes: window.__pagCount(),
    log: window.__pagLog().length,
    dispatches: window.__layoutDispatchStats(),
  }));
  expect(during.passes).toBe(before.passes);
  expect(during.log).toBe(before.log);
  expect(during.dispatches).toEqual({ lines: 0, pageMarks: 0 });

  await exit(page);
  expect(await page.evaluate(() => window.view.state.doc.lastChild!.textContent)).toBe('Typed while the page view slept.');
  await expect
    .poll(
      () => page.evaluate((above) => window.__pagCount() > above && (window.__pagLog().at(-1)?.startsWith('exact[') ?? false), before.passes),
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true);
  expect((await page.evaluate(() => window.__layoutDispatchStats())).lines).toBeGreaterThan(0);
});

// ---------- step 3: mapping and feedback ----------

/** Index of the first top-level block whose text is `text`. */
const blockIndex = (page: Page, text: string) =>
  page.evaluate((text) => {
    const { doc } = window.view.state;
    for (let i = 0; i < doc.childCount; i++) if (doc.child(i).textContent === text) return i;
    return -1;
  }, text);

test('entering carries the caret to its block and scrolls there', async ({ page }) => {
  await loadDemo(page);
  const index = await blockIndex(page, 'How it works');
  expect(index).toBeGreaterThan(5);
  await page.evaluate((index) => {
    const { state } = window.view;
    let pos = 0;
    for (let i = 0; i < index; i++) pos += state.doc.child(i).nodeSize;
    window.view.dispatch(state.tr.setSelection(state.selection.constructor.near(state.doc.resolve(pos + 1))));
  }, index);
  await enter(page);
  const at = await page.evaluate(() => {
    const sv = window.__sourceView;
    return sv.text()!.slice(sv.caret(), sv.caret() + 15);
  });
  expect(at).toBe('== How it works');
  // Scroll follows the caret: the caret line is in the viewport, well
  // below the top of the sheet.
  await expect.poll(() => page.evaluate(() => document.getElementById('scroll')!.scrollTop)).toBeGreaterThan(200);
  const caretBox = await page.locator('#source .cm-cursor').first().boundingBox();
  expect(caretBox).not.toBeNull();
  expect(caretBox!.y).toBeGreaterThan(0);
  expect(caretBox!.y).toBeLessThan(page.viewportSize()!.height);
});

/** Whether the page caret sits inside the viewport. */
const caretOnScreen = (page: Page) =>
  page.evaluate(() => {
    const c = window.view.coordsAtPos(window.view.state.selection.from);
    return c.top >= 0 && c.bottom <= window.innerHeight;
  });

test('leaving puts the page caret in the block the text caret was in', async ({ page }) => {
  await loadDemo(page);
  await enter(page);
  // Untouched text: the mapping is exact.
  await page.evaluate(() => {
    const sv = window.__sourceView;
    sv.setCaret(sv.text()!.indexOf('== Tables') + 5);
  });
  await exit(page);
  expect(await page.evaluate(() => window.view.state.selection.$from.parent.textContent)).toBe('Tables');
  await expect.poll(() => caretOnScreen(page)).toBe(true);
  expect(await page.evaluate(() => document.getElementById('scroll')!.scrollTop)).toBeGreaterThan(200);

  // Edited text: an earlier paragraph rewritten and a block added before
  // the caret still land it in the right block.
  await enter(page);
  await page.evaluate(() => {
    const sv = window.__sourceView;
    const text = sv.text()!
      .replace('== Why this exists', '== Why  this   exists\n\nAn inserted paragraph with a -- dash.')
      .replace('== Figures', '== Figures, renamed');
    sv.setText(text);
    sv.setCaret(text.indexOf('== How it works') + 3);
  });
  await exit(page);
  expect(await page.evaluate(() => window.view.state.selection.$from.parent.textContent)).toBe('How it works');
  await expect.poll(() => caretOnScreen(page)).toBe(true);
});

test('an off-rails #let typed in the source returns as one raw island, announced', async ({ page }) => {
  await loadDemo(page);
  const islandsBefore = await page.evaluate(() => document.querySelectorAll('.ProseMirror pre').length);
  await enter(page);
  await page.evaluate(() => {
    const sv = window.__sourceView;
    sv.setText(sv.text()!.trimEnd() + '\n\n#let x = 1\n');
  });
  const toast = page.locator('#toast');
  await exit(page);
  await expect(toast).toHaveText('1 block kept as raw Typst');
  const islands = await page.evaluate(() => {
    let n = 0;
    window.view.state.doc.descendants((node) => {
      if (node.type.name === 'code_block' && node.attrs.params === 'typst-raw') n++;
      return true;
    });
    return n;
  });
  expect(islands).toBe(1);
  expect(await page.locator('.ProseMirror pre').count()).toBe(islandsBefore + 1);
  // Leaving again with nothing new says nothing.
  await page.evaluate(() => (document.getElementById('toast')!.textContent = ''));
  await enter(page);
  await exit(page);
  await page.waitForTimeout(300);
  await expect(toast).toHaveText('');
});

test('PDF export from the source runs on the parsed text', async ({ page }) => {
  await boot(page);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    window.__fm.dir = await root.getDirectoryHandle('source-export', { create: true });
  });
  await enter(page);
  await page.evaluate(() => {
    const sv = window.__sourceView;
    sv.setText(sv.text()!.trimEnd() + '\n\n= Written in the source\n\nA paragraph the page view never saw.\n');
  });
  const result = await page.evaluate(async () => {
    const toast = document.getElementById('toast')!;
    const messages: string[] = [];
    const observer = new MutationObserver(() => messages.push(toast.textContent ?? ''));
    observer.observe(toast, { childList: true, characterData: true, subtree: true });
    (document.querySelector('[title="Export — PDF, .typ, .tex"]') as HTMLElement).click();
    (document.querySelector('[title="Export PDF via Typst"]') as HTMLElement).click();
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !messages.some((m) => m.startsWith('Exported '))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    observer.disconnect();
    let header = '';
    let size = 0;
    try {
      const h = await window.__fm.dir!.getFileHandle(`${window.__fm.name}.pdf`);
      const bytes = new Uint8Array(await (await h.getFile()).arrayBuffer());
      header = new TextDecoder().decode(bytes.slice(0, 5));
      size = bytes.length;
    } catch {
      /* missing — asserted below */
    }
    return { messages, header, size, stillSource: window.__sourceView.isActive() };
  });
  expect(result.header).toBe('%PDF-');
  expect(result.size).toBeGreaterThan(1_000);
  expect(result.stillSource).toBe(true);
  expect(downloads).toBe(0);
  // The page document itself was never touched by the export.
  expect(await page.evaluate(() => window.view.state.doc.textContent)).not.toContain('Written in the source');
});
