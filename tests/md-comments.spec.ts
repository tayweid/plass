import { readFileSync } from 'node:fs';
import { expect, test } from 'playwright/test';
import { settleLocal } from './settle';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';

// Editorial HTML comments and other HTML blocks in a .md file are Markdown
// the page cannot render. They go through the editor — the load, the
// edit-time normalizers (which turn a prose `--` into an en dash and would
// otherwise break `<!--`), the save — as islands shown as code blocks, and
// come back verbatim. MD_FILE=path runs the same check on a real file.
const FIXTURE = [
  '# Notes',
  '',
  '<!-- ED: MOVED IN from A3 (2026-09-01) -- pushed here to keep the closer pure — see chat. -->',
  '',
  ('We rely on others for most things. {++We left off with two questions.++} ' + FILLER.repeat(2)).trimEnd(),
  '',
  '<!-- ED: SEAM decision — the run lands on "we cannot compare"; your call. -->',
  '',
  '<div style="margin-top: -70px;"></div>',
  '',
  ('Well, shouldn’t it just go to the higher number? ~~Debated for centuries.~~ {++Stumped philosophers.++} ' + FILLER.repeat(2)).trimEnd(),
  '',
  ...Array.from({ length: 6 }, () => FILLER.repeat(5).trimEnd() + '\n'),
].join('\n');

test('Markdown islands survive the editor and show as code blocks', async ({ page }) => {
  test.setTimeout(90_000);
  const src = process.env.MD_FILE ? readFileSync(process.env.MD_FILE, 'utf8') : FIXTURE;
  await page.goto('/?new=1');
  const result = await page.evaluate(async (text) => {
    const { mdToDoc } = await import('/src/md-parser.ts');
    const { docToMd } = await import('/src/md-serializer.ts');
    const { doc } = mdToDoc(text);
    const { state } = window.view;
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content).setMeta('addToHistory', false));
    await new Promise((r) => setTimeout(r, 3000));
    const islands = [...document.querySelectorAll<HTMLElement>('.ProseMirror pre[data-params="md-raw"]')].map((el) => ({
      height: el.getBoundingClientRect().height,
      text: el.textContent ?? '',
    }));
    return { out: docToMd(window.view.state.doc), islands };
  }, src);
  const comments = src.match(/<!--[\s\S]*?-->/g) ?? [];
  const critic = src.match(/\{(\+\+|--|~~|==|>>)[\s\S]*?(\+\+|--|~~|==|<<)\}/g) ?? [];
  expect(comments.filter((c) => !result.out.includes(c))).toEqual([]);
  expect(critic.filter((c) => !result.out.includes(c))).toEqual([]);
  expect(result.islands.length).toBeGreaterThanOrEqual(Math.min(comments.length, 1));
  for (const island of result.islands) expect(island.height).toBeGreaterThan(0);
  for (const c of comments) expect(result.islands.some((i) => i.text === c || i.text.includes(c))).toBe(true);
  if (!process.env.MD_FILE) expect(result.out).toBe(src);

  // Pagination settles with islands in the flow.
  await expect
    .poll(() => page.evaluate(() => window.__pagLog().at(-1)?.startsWith('local[') ?? false), {
      timeout: 30_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(true);
});
