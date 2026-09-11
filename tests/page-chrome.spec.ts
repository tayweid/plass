import { expect, test, type Page } from 'playwright/test';
import { settleLocal } from './settle';

// Page chrome: the running header and footer, the automatic page number
// and where it goes, {page} in the document's format, {section} as the
// level-1 heading in force at the top of the page. The editor paints
// them; the port audit measures them against Typst's margins.

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> };
    __pagLog: () => string[];
    __pagCount: () => number;
    __audit: () => Promise<{ chrome: unknown[]; summary: { chromeMismatch: number; pagesAgree: boolean } } | null>;
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';
const HEAD = (page: string) =>
  `#set page(${page})\n#set par(justify: true, leading: 10.215pt, spacing: 21.465pt)\n#set text(font: "New Computer Modern", size: 12.5pt)\n\n`;
const SECTION = '#context { let hs = query(selector(heading.where(level: 1)).before(here())); if hs.len() > 0 { hs.last().body } }';
const PAGE = '#context counter(page).display()';

async function openTyp(page: Page, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(
    async ({ text }) => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle('chrome.typ', { create: true });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      await window.__fm.loadHandle(h);
    },
    { text },
  );
  await settleLocal(page);
}

const chromeOf = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#pages .page-num')].map((el) => ({
      page: Number(el.dataset.page),
      edge: el.classList.contains('page-header') ? 'header' : 'footer',
      align: el.style.textAlign,
      text: el.textContent,
    })),
  );

test('running header and footer: section and page substitutions, first page off, agree with Typst', async ({ page }) => {
  test.setTimeout(90_000);
  const body =
    '= Introduction\n\n' +
    Array.from({ length: 5 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
    '\n\n= Supply and demand\n\n' +
    Array.from({ length: 6 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
    '\n\n= Elasticity\n\n' +
    Array.from({ length: 7 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
    '\n';
  await openTyp(
    page,
    HEAD(
      'paper: "us-letter", margin: 1.25in, numbering: "— 1 —", number-align: center, ' +
        `header: context if(counter(page).get().first() > 1) { align(right)[Notes · ${SECTION} · ${PAGE}] }, ` +
        `footer: context if(counter(page).get().first() > 1) { align(center)[Econ 0100 · ${PAGE}] }`,
    ) + body,
  );
  const settings = await page.evaluate(() => window.view.state.doc.attrs.settings as Record<string, unknown>);
  expect(settings).toMatchObject({
    headerText: 'Notes · {section} · {page}',
    headerAlign: 'right',
    headerFirstPage: false,
    footerText: 'Econ 0100 · {page}',
    footerAlign: 'center',
    footerFirstPage: false,
    pageNumShow: true,
    pageNumFormat: '— 1 —',
    pageNumPlace: 'bottom',
  });
  const chrome = await chromeOf(page);
  const pages = await page.evaluate(() => window.__pagCount() && document.querySelectorAll('.page-box').length);
  expect(pages).toBeGreaterThanOrEqual(4);
  // Page 1: nothing (both off on the first page; the footer text replaces
  // the automatic number, so no folio either).
  expect(chrome.filter((c) => c.page === 0)).toEqual([]);
  // Page 2: the header names the section in force at its top — the last
  // level-1 heading on an earlier page — and the page in the document's
  // format; the footer likewise.
  const p2 = chrome.filter((c) => c.page === 1);
  expect(p2.map((c) => [c.edge, c.align, c.text])).toEqual([
    ['header', 'right', 'Notes · Introduction · — 2 —'],
    ['footer', 'center', 'Econ 0100 · — 2 —'],
  ]);
  // Each later page carries the last heading that started before it.
  const sectionOf = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll<HTMLElement>('.page-box')].map((b) => b.getBoundingClientRect());
    const out: Array<{ page: number; text: string }> = [];
    for (const h of document.querySelectorAll<HTMLElement>('.ProseMirror h1')) {
      const top = h.getBoundingClientRect().top;
      out.push({ page: boxes.findIndex((b) => top >= b.top && top < b.bottom), text: h.textContent ?? '' });
    }
    return out;
  });
  for (let k = 1; k < pages; k++) {
    let want = '';
    for (const h of sectionOf) if (h.page < k) want = h.text;
    const header = chrome.find((c) => c.page === k && c.edge === 'header');
    expect(header?.text, `page ${k + 1}`).toBe(`Notes · ${want} · — ${k + 1} —`);
  }
  // Typst sets the same margins.
  const report = await page.evaluate(() => window.__audit());
  expect(report).not.toBeNull();
  expect(report!.chrome, 'chrome differs from Typst').toEqual([]);
  expect(report!.summary.pagesAgree).toBe(true);
  // The settings write back the same page line.
  const typ = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return docToTyp(window.view.state.doc);
  });
  expect(typ).toContain(
    `numbering: "— 1 —", number-align: center, header: context if(counter(page).get().first() > 1) { align(right)[Notes · ${SECTION} · ${PAGE}] }, footer: context if(counter(page).get().first() > 1) { align(center)[Econ 0100 · ${PAGE}] })`,
  );
});

test('the automatic number moves into the header, and a footer {page} shows a two-number format as the counter alone', async ({ page }) => {
  test.setTimeout(90_000);
  await openTyp(
    page,
    HEAD(`paper: "us-letter", margin: 1.25in, numbering: "1 / 1", number-align: top + right, footer: align(center)[Page ${PAGE}]`) +
      '= Numbers\n\n' +
      Array.from({ length: 12 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      '\n',
  );
  const settings = await page.evaluate(() => window.view.state.doc.attrs.settings as Record<string, unknown>);
  expect(settings).toMatchObject({ pageNumPlace: 'top', pageNumAlign: 'right', pageNumFormat: '1 / 1', footerText: 'Page {page}', footerFirstPage: true, headerText: '' });
  const chrome = await chromeOf(page);
  const pages = await page.evaluate(() => document.querySelectorAll('.page-box').length);
  expect(pages).toBeGreaterThanOrEqual(3);
  for (let k = 0; k < pages; k++) {
    expect(chrome.filter((c) => c.page === k).map((c) => [c.edge, c.align, c.text])).toEqual([
      ['header', 'right', `${k + 1} / ${pages}`],
      ['footer', 'center', `Page ${k + 1}`],
    ]);
  }
  const report = await page.evaluate(() => window.__audit());
  expect(report).not.toBeNull();
  expect(report!.chrome, 'chrome differs from Typst').toEqual([]);
  // Number position round-trips as Typst's alignment.
  const typ = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return docToTyp(window.view.state.doc);
  });
  expect(typ).toContain('numbering: "1 / 1", number-align: top + right, footer: align(center)[Page #context counter(page).display()])');
});
