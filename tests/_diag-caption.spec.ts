// TEMPORARY diagnostic for the long-caption-with-footnote calibration gap.
// Deleted before commit.
import { test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __breakSig: () => string;
    __blockAuthority: (pos: number) => unknown;
    __portWhy: () => string;
  }
}

type Scenario =
  | { kind: 'caption'; n: number; footnote: boolean }
  | { kind: 'body'; n: number; footnote: boolean };

const SENTENCE = 'A long figure caption exercises exact line selection while its editable text changes. ';

async function run(page: import('playwright/test').Page, sc: Scenario) {
  await page.goto('/?new=1');
  await page.evaluate((sc) => {
    const { schema, doc: current } = window.view.state;
    const sentence =
      'A long figure caption exercises exact line selection while its editable text changes. ';
    const text = sentence.repeat(sc.n);
    const note = sc.footnote
      ? schema.nodes.footnote.create(
          null,
          schema.text('A sufficiently long footnote body also wraps across several exact lines. '.repeat(5)),
        )
      : null;
    const inline = note ? [schema.text(text), note] : [schema.text(text)];
    const block =
      sc.kind === 'caption'
        ? schema.nodes.figure.create(
            {
              src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              label: '',
              name: '',
            },
            inline,
          )
        : schema.nodes.paragraph.create(null, inline);
    const doc = schema.nodes.doc.create(current.attrs, [block]);
    window.view.dispatch(window.view.state.tr.replaceWith(0, current.content.size, doc.content));
  }, sc);
  await page.waitForFunction(() => window.__breakSig().length > 0);
  const sig1 = await page.evaluate(() => window.__breakSig());
  const auth1 = await page.evaluate(() => window.__blockAuthority(0));
  const why1 = await page.evaluate(() => window.__portWhy());
  await page.waitForTimeout(1500);
  const sig2 = await page.evaluate(() => window.__breakSig());
  const auth2 = await page.evaluate(() => window.__blockAuthority(0));
  await page.waitForTimeout(1500);
  const sig3 = await page.evaluate(() => window.__breakSig());
  const label = `${sc.kind} n=${sc.n} fn=${sc.footnote}`;
  console.log(
    JSON.stringify({
      label,
      agree: sig1 === sig2,
      stable: sig2 === sig3,
      auth1,
      auth2,
      portWhy: why1,
      sig1,
      sig2,
    }),
  );
}

test('diag matrix', async ({ page }) => {
  test.setTimeout(180_000);
  const scenarios: Scenario[] = [
    { kind: 'caption', n: 3, footnote: true },
    { kind: 'caption', n: 4, footnote: true },
    { kind: 'caption', n: 6, footnote: true },
    { kind: 'caption', n: 4, footnote: false },
    { kind: 'caption', n: 6, footnote: false },
    { kind: 'body', n: 4, footnote: true },
    { kind: 'body', n: 6, footnote: true },
  ];
  for (const sc of scenarios) await run(page, sc);
});
