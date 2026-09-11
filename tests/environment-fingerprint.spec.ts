import { test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
    __pageParityStats: (reset?: boolean) => { predictions: number; agreements: number; disagreements: number; byCause: Record<string, number>; last: unknown };
  }
}

// Never fails. Prints what this browser measures for the bundled fonts and
// the editor's blocks, so a run on another OS (CI's Linux Chromium) can be
// compared line by line with a run here. Vertical parity rests on these
// numbers: a glyph advance or a line box that differs by a fraction of a
// pixel moves a page break somewhere in a long document.
test('environment fingerprint (diagnostic, never fails)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?new=1');
  await page.waitForTimeout(2_000);
  const report = await page.evaluate(async () => {
    const { state } = window.view;
    const { schema } = state;
    const sentence = 'The committee reconvened after lunch to weigh the revised proposal against the earlier draft. ';
    const doc = schema.nodes.doc.create(state.doc.attrs, [
      schema.nodes.heading.create({ level: 1 }, schema.text('Fingerprint')),
      schema.nodes.paragraph.create(null, schema.text(sentence.repeat(6).trim())),
      schema.nodes.heading.create({ level: 2 }, schema.text('Second level')),
      schema.nodes.heading.create({ level: 3 }, schema.text('Third level')),
      schema.nodes.blockquote.create(null, schema.nodes.paragraph.create(null, schema.text(sentence.trim()))),
      schema.nodes.code_block.create(null, schema.text('print("hi")\nx = 1')),
      schema.nodes.paragraph.create(null, [schema.text('Inline '), schema.text('code', [schema.marks.code.create()]), schema.text(' and text.')]),
      ...Array.from({ length: 30 }, () => schema.nodes.paragraph.create(null, schema.text(sentence.repeat(5).trim()))),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
    window.__pageParityStats(true);
    await new Promise((r) => setTimeout(r, 12_000));

    const measure = (el: Element | null) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { font: cs.fontFamily, size: cs.fontSize, lineHeight: cs.lineHeight, h: +r.height.toFixed(4), w: +r.width.toFixed(4), padTop: cs.paddingTop, mb: cs.marginBottom };
    };
    const probe = (text: string, font: string, size: string) => {
      const span = document.createElement('span');
      span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${font};font-size:${size}`;
      span.textContent = text;
      document.body.appendChild(span);
      const w = span.getBoundingClientRect().width;
      span.remove();
      return +w.toFixed(4);
    };
    const pm = document.querySelector('.ProseMirror')!;
    return {
      ua: navigator.userAgent,
      dpr: devicePixelRatio,
      platform: navigator.platform,
      fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight} ${f.style}`),
      advances: {
        ncmSentence: probe(sentence.trim(), '"New Computer Modern"', '16.6667px'),
        ncmAlphabet: probe('abcdefghijklmnopqrstuvwxyz', '"New Computer Modern"', '16.6667px'),
        ncmBoldAlphabet: probe('abcdefghijklmnopqrstuvwxyz', '"New Computer Modern"', '31.6667px'),
        monoAlphabet: probe('abcdefghijklmnopqrstuvwxyz', '"DejaVu Sans Mono"', '13.3333px'),
      },
      blocks: {
        h1: measure(pm.querySelector('h1')),
        p: measure(pm.querySelector('p')),
        h2: measure(pm.querySelector('h2')),
        h3: measure(pm.querySelector('h3')),
        blockquote: measure(pm.querySelector('blockquote')),
        pre: measure(pm.querySelector('pre')),
        code: measure(pm.querySelector('p code')),
      },
      lines: [...pm.querySelectorAll('p')].slice(0, 3).map((p) => Math.round(p.getBoundingClientRect().height / 25)),
      pagLog: window.__pagLog().slice(-3),
      parity: window.__pageParityStats(),
    };
  });
  console.log('ENVIRONMENT FINGERPRINT ' + JSON.stringify(report, null, 1));
});
