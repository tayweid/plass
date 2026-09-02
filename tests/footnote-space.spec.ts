import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

// Regression: a plain space typed before a footnote marker never prints
// (Typst's footnote rule prefixes the superscript with a weak zero-width
// hole that eats adjacent markup spaces), and every width model already
// refused to charge it — but the DOM still painted it, so the marker's line
// overflowed its measure and soft-wrapped into a second line box. Every
// footnote-bearing paragraph then stood one line taller than its forced
// line count and the paginator broke pages early. The printed-form
// normalizer now drops that space on insertion; the paragraph's painted
// height must equal its forced line count at every marker position.
test('a footnote marker typed after a space does not inflate the paragraph', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const { view } = window;
    const words = (
      'The quarterly review committee reconvened to assess the shifting scope of the migration and ' +
      'nobody expected the second survey to contradict the first so completely while rain fell steadily ' +
      'against the tall windows of the archive as the clerks worked late into the evening on the ledgers'
    ).split(' ');
    const out: Array<{ k: number; lines: number; over: number; glued: boolean }> = [];
    for (let k = 3; k < words.length - 3; k += 2) {
      const { state } = view;
      const { schema } = state;
      const p = schema.nodes.paragraph.create(null, [
        schema.text(words.slice(0, k).join(' ') + ' '),
        schema.nodes.footnote.create(null, schema.text('Note body.')),
        schema.text(' ' + words.slice(k).join(' ')),
      ]);
      view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [p]));
      await new Promise((r) => setTimeout(r, 250));
      const para = view.state.doc.firstChild!;
      const glued = para.child(0).text === words.slice(0, k).join(' ') && para.child(1).type.name === 'footnote';
      const el = view.dom.querySelector('p')!;
      const pitch = parseFloat(getComputedStyle(el).lineHeight);
      const lines = el.querySelectorAll('br').length + 1;
      const over = el.getBoundingClientRect().height - lines * pitch;
      out.push({ k, lines, over, glued });
    }
    return out;
  });
  expect(result.length).toBeGreaterThan(10);
  for (const r of result) {
    expect(r.glued, `marker at word ${r.k}: space not dropped`).toBe(true);
    // Sub-pixel slack only: the superscript's own overhang, never a line box.
    expect(r.over, `marker at word ${r.k}: paragraph ${r.over.toFixed(2)}px taller than ${r.lines} lines`).toBeLessThan(2);
  }
});
