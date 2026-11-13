import { expect, test, type Page } from './fixture';
import { settleLocal } from './settle';

// Code blocks on the page (src/code-block.ts, src/code-colors.ts): a block
// with a language is painted in the colors Typst prints it in, asked of
// the in-app compiler; the colors move nothing; the language is set in a
// field at the block's bottom-right corner, shown while the caret is in
// the block; and Enter on a fence (```python) makes the block.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle, dir?: FileSystemDirectoryHandle | null) => Promise<unknown>; dirty: boolean };
  }
}

const PYTHON = ['import numpy as np', '', 'def demand(p, a=10, b=2):', '    """Linear demand."""', '    return max(a - b * p, 0)  # quantity', '', 'print(f"Q = {demand(3):.2f}")'];

const SHEET = [
  '# Code',
  '',
  'A Python listing:',
  '',
  '```python',
  ...PYTHON,
  '```',
  '',
  'No language:',
  '',
  '```',
  'x <- c(1, 2, 3)',
  'mean(x)',
  '```',
  '',
  'R, with a long line that wraps at the measure, as raw text does: ',
  '',
  '```r',
  'fit <- lm(y ~ x + z + w + a_long_regressor + another_long_regressor + a_third_long_regressor, data = df)  # a comment',
  'summary(fit)',
  '```',
  '',
  'A language Typst does not know:',
  '',
  '```stata',
  'reg y x if z == 1 // c',
  'display "s"',
  '```',
  '',
  'After the code.',
  '',
].join('\n');

async function open(page: Page, text: string, name = 'code.md') {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(
    async ({ text, name }) => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      await window.__fm.loadHandle(h, root);
    },
    { text, name },
  );
  await settleLocal(page);
  await colored(page);
}

/** Every block's colors are in: none waits for the compiler. */
async function colored(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const plugin = window.view.state.plugins.find((p) => (p as unknown as { key: string }).key.startsWith('code-colors$'));
          return (plugin?.getState(window.view.state) as { waiting: boolean } | undefined)?.waiting;
        }),
      { timeout: 30_000 },
    )
    .toBe(false);
}

/** The colored runs of the `index`th code block, in order: text and the
 *  ink it is painted with (the highlight's name: a hex, `u-` before it
 *  when underlined). The colors are highlight ranges, not elements. */
const inks = (page: Page, index: number) =>
  page.evaluate((index) => {
    const pre = document.querySelectorAll('.ProseMirror pre')[index];
    const out: Array<{ at: number; run: string }> = [];
    for (const [name, highlight] of CSS.highlights) {
      if (!name.startsWith('plass-code-')) continue;
      for (const range of highlight) {
        if (!pre.contains(range.startContainer) || range.startContainer !== range.endContainer) continue;
        const text = (range.startContainer.textContent ?? '').slice(range.startOffset, range.endOffset);
        out.push({ at: range.startOffset, run: `${text}|${name.slice('plass-code-'.length)}` });
      }
    }
    return out.sort((a, b) => a.at - b.at).map((o) => o.run);
  }, index);

/** Every painted range on the page: how many, and how many point at text
 *  that is not code on the page any more. */
const ranges = (page: Page) =>
  page.evaluate(() => {
    let all = 0;
    let astray = 0;
    for (const [name, highlight] of CSS.highlights) {
      if (!name.startsWith('plass-code-')) continue;
      for (const range of highlight) {
        all++;
        const at = range.startContainer;
        if (!at.isConnected || !at.parentElement?.closest('.ProseMirror pre > code')) astray++;
      }
    }
    return { all, astray };
  });

/** Where everything is: each block's top and height, and each code line's
 *  top and right edge (so a glyph that moved sideways shows too). */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror')!;
    const blocks = [...pm.children].map((c) => {
      const r = c.getBoundingClientRect();
      return [c.tagName, r.top, r.height];
    });
    const lines = [...pm.querySelectorAll('pre > code')].map((code) => {
      const range = document.createRange();
      range.selectNodeContents(code);
      const rights = new Map<number, number>();
      for (const r of range.getClientRects()) rights.set(r.top, Math.max(rights.get(r.top) ?? 0, r.right));
      return [...rights.entries()].sort((a, b) => a[0] - b[0]);
    });
    return { blocks, lines };
  });

/** The caret at the end of the `index`th top-level block, the editor focused. */
const caretAtEndOf = (page: Page, index: number) =>
  page.evaluate((index) => {
    const view = window.view;
    let pos = 0;
    for (let i = 0; i < index; i++) pos += view.state.doc.child(i).nodeSize;
    const Sel = view.state.selection.constructor as unknown as { create(doc: unknown, pos: number): never };
    view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, pos + view.state.doc.child(index).nodeSize - 1)));
    view.focus();
  }, index);

const RED = 'd73948'; // keywords, operators
const BLUE = '4b69c6'; // names
const GREEN = '198810'; // strings
const GREY = '74747c'; // comments
const PINK = 'b60157'; // constants

test('a block with a language is painted in the colors Typst prints', async ({ page }) => {
  await open(page, SHEET);
  const python = await inks(page, 0);
  // Typst's own theme, as the PDF of this block shows it.
  for (const piece of [`import|${RED}`, `def|${RED}`, `demand|${BLUE}`, `10|${PINK}`, `return|${RED}`, `max|${BLUE}`, `# quantity|${GREY}`, `print|${BLUE}`]) {
    expect(python).toContain(piece);
  }
  expect(python.some((p) => p.endsWith(GREEN))).toBe(true);
  // Plain text has no ink.
  expect(python.some((p) => p.startsWith('numpy|') || p.startsWith('np|'))).toBe(false);
  // The colors are painted, not built: the code is still one text node.
  expect(await page.evaluate(() => [...document.querySelectorAll('.ProseMirror pre > code')].map((c) => c.childElementCount))).toEqual([0, 0, 0, 0]);
  expect((await ranges(page)).astray).toBe(0);

  // No language, no color; a language Typst does not know, none either
  // (the print is plain too).
  expect(await inks(page, 1)).toEqual([]);
  expect(await inks(page, 3)).toEqual([]);
  expect((await inks(page, 2)).slice(0, 2)).toEqual([`<-|${RED}`, `lm|${BLUE}`]);

  // The export tags the block with the same language, so the compiler
  // that answered is the one that prints.
  const typ = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts' as string);
    return docToTyp(window.view.state.doc, { islands: 'print' }) as string;
  });
  expect(typ).toContain('```python\nimport numpy as np');
  expect(typ).toContain('```stata\nreg y x');
  // Painting is not an edit.
  expect(await page.evaluate(() => window.__fm.dirty)).toBe(false);
});

test('colors and the language field move nothing', async ({ page }) => {
  await open(page, SHEET);
  const withColors = await geometry(page);

  // The caret in a colored block: its field shows, and nothing moves.
  await caretAtEndOf(page, 2);
  await expect(page.locator('.ProseMirror pre.code-active .code-lang')).toBeVisible();
  expect(await geometry(page)).toEqual(withColors);
  await caretAtEndOf(page, 1);
  await expect(page.locator('.ProseMirror pre .code-lang').first()).toBeHidden();

  // The same code in no language: every block and every code line where
  // it was.
  const before = await page.evaluate(() => window.__pagCount());
  await page.evaluate(() => {
    const view = window.view;
    let tr = view.state.tr;
    view.state.doc.forEach((node, pos) => {
      if (node.type.name === 'code_block') tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, params: '' });
    });
    view.dispatch(tr);
  });
  await settleLocal(page, before);
  await colored(page);
  expect(await ranges(page)).toEqual({ all: 0, astray: 0 });
  expect(await geometry(page)).toEqual(withColors);
});

test('the field sets the language: a list to pick from, any word allowed', async ({ page }) => {
  await open(page, SHEET);
  await caretAtEndOf(page, 2);
  const field = page.locator('.ProseMirror pre.code-active .code-lang-field');
  await expect(field).toHaveValue('python');

  // A press takes the whole word and opens the list.
  await field.click();
  await expect(page.locator('.code-lang-menu .ref-menu-item').first()).toHaveText(/Python/);
  await page.keyboard.type('ju');
  await expect(page.locator('.code-lang-menu .ref-menu-item.selected')).toHaveText(/Julia/);
  await page.keyboard.press('Enter');
  // The block is Julia, the caret is back in the code, the list is gone.
  await expect(page.locator('.code-lang-menu')).toHaveCount(0);
  expect(await page.evaluate(() => [window.view.state.doc.child(2).attrs.params, window.view.hasFocus(), window.view.state.selection.$from.parent.type.name])).toEqual(['julia', true, 'code_block']);
  await colored(page);
  // Julia's reading of the text: `import` and `return` are its keywords, `def` is not.
  const julia = await inks(page, 0);
  expect(julia).toContain(`import|${RED}`);
  expect(julia).not.toContain(`def|${RED}`);

  // Escape leaves the language as it was. The open list stays under its
  // field while the paper scrolls.
  await field.click();
  await page.keyboard.type('rust');
  const under = () =>
    page.evaluate(() => {
      const menu = document.querySelector('.code-lang-menu')!.getBoundingClientRect();
      const at = document.querySelector('.ProseMirror pre.code-active .code-lang-field')!.getBoundingClientRect();
      return Math.round(menu.top - at.bottom);
    });
  expect(await under()).toBe(4);
  const top = await field.evaluate((el) => el.getBoundingClientRect().top);
  await page.evaluate(() => document.getElementById('scroll')!.scrollBy(0, 30));
  await expect.poll(() => field.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(top - 20);
  await expect.poll(under).toBe(4);
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('julia');
  expect(await page.evaluate(() => window.view.state.doc.child(2).attrs.params)).toBe('julia');

  // A word the list does not hold is taken as typed (and printed plain).
  await field.click();
  await page.keyboard.type('stata');
  await expect(page.locator('.code-lang-menu .ref-menu-item')).toHaveText(['stataas typed']);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.view.state.doc.child(2).attrs.params)).toBe('stata');
  await colored(page);
  expect(await inks(page, 0)).toEqual([]);

  // An emptied field clears the language; leaving the field keeps what was typed.
  await field.click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.view.state.doc.child(2).attrs.params)).toBe('');
  await expect(field).toHaveAttribute('placeholder', 'language');
  await field.click();
  await page.keyboard.type('py');
  await page.locator('.ProseMirror h1').click();
  expect(await page.evaluate(() => window.view.state.doc.child(2).attrs.params)).toBe('py');

  // The file holds the fence as Markdown writes it. (A read that lands
  // while the autosave swaps the file in finds no file: asked again.)
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        try {
          const root = await navigator.storage.getDirectory();
          return await (await (await root.getFileHandle('code.md')).getFile()).text();
        } catch {
          return '';
        }
      }),
    )
    .toContain('```py\nimport numpy as np');
  // `py` is Python to Typst (a file extension), and to the page.
  await colored(page);
  expect(await inks(page, 0)).toContain(`def|${RED}`);
});

test('Enter on a fence makes the block; what is typed in it is colored', async ({ page }) => {
  await open(page, 'A line.\n\nAnother.\n');
  await caretAtEndOf(page, 1);
  await page.keyboard.press('Enter');
  // The third backtick no longer makes the block: the language comes first.
  await page.keyboard.type('```');
  expect(await page.evaluate(() => window.view.state.selection.$from.parent.type.name)).toBe('paragraph');
  await page.keyboard.type('python');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => [window.view.state.doc.child(2).type.name, window.view.state.doc.child(2).attrs.params])).toEqual(['code_block', 'python']);
  await expect(page.locator('.ProseMirror pre.code-active .code-lang-field')).toHaveValue('python');

  await page.keyboard.type('def f(x):');
  await page.keyboard.press('Enter');
  await page.keyboard.type('    return "s"  # c');
  await expect.poll(() => inks(page, 0)).toEqual([`def|${RED}`, `f|${BLUE}`, `return|${RED}`, `"s"|${GREEN}`, `# c|${GREY}`]);
  expect(await page.evaluate(() => window.view.state.doc.child(2).textContent)).toBe('def f(x):\n    return "s"  # c');

  // A bare fence is a block in no language.
  await page.evaluate(() => {
    const view = window.view;
    const end = view.state.doc.content.size;
    const tr = view.state.tr.insert(end, view.state.schema.nodes.paragraph.create());
    const Sel = view.state.selection.constructor as unknown as { create(doc: unknown, pos: number): never };
    view.dispatch(tr.setSelection(Sel.create(tr.doc, end + 1)));
  });
  await page.keyboard.type('```');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => [window.view.state.doc.lastChild!.type.name, window.view.state.doc.lastChild!.attrs.params])).toEqual(['code_block', '']);
});

test('code that stops being code loses its colors', async ({ page }) => {
  await open(page, SHEET);
  expect((await inks(page, 0)).length).toBeGreaterThan(5);

  // The block turned into a paragraph (the rail's Code block tile).
  await page.evaluate(() => {
    const view = window.view;
    const pos = view.state.doc.child(0).nodeSize + view.state.doc.child(1).nodeSize;
    view.dispatch(view.state.tr.setBlockType(pos + 1, pos + 1, view.state.schema.nodes.paragraph));
  });
  expect(await page.evaluate(() => window.view.state.doc.child(2).type.name)).toBe('paragraph');
  expect((await ranges(page)).astray).toBe(0);
  expect(await inks(page, 0)).not.toContain(`def|${RED}`);
  // Undo: the block and its colors are back.
  await page.evaluate(() => window.view.focus());
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => window.view.state.doc.child(2).type.name)).toBe('code_block');
  await colored(page);
  expect(await inks(page, 0)).toContain(`def|${RED}`);

  // Backspace at the head of the R block joins its code into the line above.
  await page.evaluate(() => {
    const view = window.view;
    let pos = 0;
    for (let i = 0; i < 6; i++) pos += view.state.doc.child(i).nodeSize;
    const Sel = view.state.selection.constructor as unknown as { create(doc: unknown, pos: number): never };
    view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, pos + 1)));
    view.focus();
  });
  expect(await page.evaluate(() => window.view.state.selection.$from.parent.attrs.params)).toBe('r');
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => window.view.state.selection.$from.parent.type.name)).toBe('paragraph');
  const after = await ranges(page);
  expect(after.astray).toBe(0);
  expect(after.all).toBeGreaterThan(5);
});

// One line per offered language that its syntax colors: a string, a
// comment or a keyword. A language the pinned compiler stopped knowing
// would be offered and then printed plain.
const SAMPLES: Record<string, string> = {
  python: 'x = "s"  # c',
  r: 'x <- "s" # c',
  julia: 'x = "s" # c',
  matlab: "x = 's'; % c",
  sql: 'SELECT a FROM b -- c',
  bash: 'echo "s" # c',
  latex: '\\section{A} % c',
  bibtex: '@book{k, title = {T}, year = 2020}',
  markdown: '# Head *it*',
  typ: '#let x = 1 // c',
  json: '{"a": 1}',
  yaml: 'a: "b" # c',
  toml: 'a = "b" # c',
  csv: 'a = "b" # c',
  xml: '<a b="c">d</a>',
  html: '<p class="x">hi</p>',
  css: '.a { color: red; } /* c */',
  javascript: 'const a = "b"; // c',
  typescript: 'const a = "b"; // c',
  c: 'int a = 1; // c',
  cpp: 'int a = 1; // c',
  cs: 'int a = 1; // c',
  java: 'int a = 1; // c',
  rust: 'let a = "b"; // c',
  go: 'var a = "b" // c',
  swift: 'let a = "b" // c',
  kotlin: 'val a = "b" // c',
  scala: 'val a = "b" // c',
  haskell: 'a = "b" -- c',
  ocaml: 'let a = "b" (* c *)',
  ruby: 'a = "b" # c',
  php: '<?php echo "a"; // c ?>',
  perl: 'my $a = "b"; # c',
  lua: 'local a = "b" -- c',
  f90: 'integer :: i ! c',
  makefile: 'a: b # c',
  dockerfile: 'FROM alpine:3 AS base',
  diff: '+++ b',
};

test('every language the field offers is one the compiler colors', async ({ page }) => {
  const tags = await (async () => {
    await page.goto('/?new=1');
    return page.evaluate(async () => {
      const { CODE_LANGUAGES } = await import('/src/code-language.ts' as string);
      return (CODE_LANGUAGES as Array<{ tag: string }>).map((l) => l.tag);
    });
  })();
  expect(tags.filter((t) => !(t in SAMPLES))).toEqual([]);
  await open(page, tags.map((t) => '```' + t + '\n' + SAMPLES[t] + '\n```\n').join('\nBetween.\n\n'), 'languages.md');
  const plain = await page.evaluate(() => {
    const inked = new Set<Element>();
    for (const [name, highlight] of CSS.highlights) {
      if (!name.startsWith('plass-code-')) continue;
      for (const range of highlight) {
        const pre = range.startContainer.parentElement?.closest('pre');
        if (pre) inked.add(pre);
      }
    }
    return [...document.querySelectorAll('.ProseMirror pre')].filter((pre) => !inked.has(pre)).map((pre) => pre.getAttribute('data-params'));
  });
  expect(plain).toEqual([]);
});
