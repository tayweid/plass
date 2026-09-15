import { expect, test, type Page } from 'playwright/test';
import { settleLocal } from './settle';

declare global {
  interface Window { __tableProofSvg: () => Promise<string | null> }
}

async function install(page: Page, columns: string[], rows = 3, insetPt = 9, fontSize = '') {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  await page.evaluate(({ columns, rows, insetPt, fontSize }) => {
    const { state } = window.view;
    const s = state.schema;
    const p = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const cell = (text: string, i: number, header = false) => (header ? s.nodes.table_header : s.nodes.table_cell).create(
      { align: i === 1 ? 'left' : 'center', valign: i === 2 ? 'bottom' : 'middle', fill: header ? 'gray-dark' : null },
      header && i === 1 ? [p(text), p('Second line'), p('Third line')] : p(text),
    );
    const table = s.nodes.table.create({ style: 'grid', columnWidths: columns, insetPt, fontSize }, [
      s.nodes.table_row.create(null, ['Code', 'Skill', 'Practice'].map((t, i) => cell(t, i, true))),
      ...Array.from({ length: rows - 1 }, (_, r) => s.nodes.table_row.create(null,
        [`B${r + 1}.1`, 'Efficiency and total surplus', 'Exercise B1 · Vignette B1 · HW B1'].map((t, i) => cell(t, i)),
      )),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, table).setMeta('addToHistory', false));
  }, { columns, rows, insetPt, fontSize });
  await settleLocal(page);
}

test('repeated headers retain middle and bottom alignment beside taller cells', async ({ page }) => {
  await install(page, ['auto', '1fr', 'auto'], 45);
  const offsets = await page.evaluate(() => {
    const table = document.querySelector('.ProseMirror table')!;
    const originals = [...table.querySelectorAll('th')];
    const copies = [...table.querySelectorAll('.ts-table-break')][0].querySelectorAll('.ts-table-hdr');
    const offset = (el: Element) => el.querySelector('p')!.getBoundingClientRect().top - el.getBoundingClientRect().top;
    return originals.map((el, i) => ({ original: offset(el), copy: offset(copies[i]) }));
  });
  for (const pair of offsets) expect(Math.abs(pair.original - pair.copy), JSON.stringify(offsets)).toBeLessThan(0.1);
});

for (const { columns, inset, fontSize = '' } of [
  { columns: ['auto', '1fr', 'auto'], inset: 9 },
  { columns: ['50pt', '1fr', '2fr'], inset: 5 },
  { columns: ['auto', 'auto', 'auto'], inset: 2.5 },
  { columns: ['120pt', 'auto', '1fr'], inset: 12 },
  { columns: ['auto', '1fr', 'auto'], inset: 0, fontSize: '0.85em' },
]) test(`column widths ${columns.join('/')} and ${inset}pt padding ${fontSize} match Typst geometry`, async ({ page }) => {
  test.setTimeout(90_000);
  await install(page, columns, 3, inset, fontSize);
  const result = await page.evaluate(async () => {
    const svg = await window.__tableProofSvg();
    if (!svg) throw new Error('Missing table proof');
    const parsed = new DOMParser().parseFromString(svg, 'text/html');
    const rules = [...parsed.querySelectorAll('.typst-shape')].filter(el => /^M 0 0 L 0 [\d.]+$/.test(el.getAttribute('d') ?? ''));
    const coordinate = (el: Element, index: number) => {
      let result = 0;
      for (let current: Element | null = el; current; current = current.parentElement) {
        const match = /^translate\(([-\d.]+),([-\d.]+)\)$/.exec(current.getAttribute('transform') ?? '');
        if (match) result += Number(match[index]);
      }
      return result;
    };
    const boundaries = [...new Set(rules.map(el => coordinate(el, 1)))].sort((a, b) => a - b);
    const compiled = boundaries.slice(1).map((right, i) => right - boundaries[i]);
    const horizontal = [...parsed.querySelectorAll('.typst-shape')].filter(el => /^M 0 0 L [\d.]+ 0$/.test(el.getAttribute('d') ?? ''));
    const ys = horizontal.map(el => coordinate(el, 2));
    const cells = [...document.querySelectorAll('.ProseMirror th')];
    return {
      compiled, native: cells.map(el => el.getBoundingClientRect().width * 0.75),
      nativeHeight: document.querySelector('.ProseMirror table')!.getBoundingClientRect().height * 0.75,
      compiledHeight: Math.max(...ys) - Math.min(...ys),
    };
  });
  expect(result.compiled, JSON.stringify(result)).toHaveLength(3);
  result.native.forEach((width, i) => expect(Math.abs(width - result.compiled[i]), JSON.stringify(result)).toBeLessThan(0.15));
  expect(Math.abs(result.nativeHeight - result.compiledHeight), JSON.stringify(result)).toBeLessThan(0.3);
});
