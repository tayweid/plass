// The export without the editor (headless-export.ts): a Markdown file
// opened as the app opens it, its values brought up to date, and the
// source the PDF compiles. Run: npx tsx src/headless-export.test.ts
import { applyValues, DataImageError, exportSource, openMarkdown, valueNames } from './headless-export';
import { ensureMathConverter } from './math-convert';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const md = `---
title: Checkpoint
bibliography: refs.bib
plass:
  page: half-letter
---

The price is [4.5]{.value name="price" digits=2} and the count is
[10]{.value name="qty"}, so $p \\cdot q$ matters [@knuth86].

<!-- an editorial note -->

::: solution
Revenue is [45]{.value name="rev" digits=1}.
:::
`;

const bib = '@book{knuth86, author={Donald Knuth}, title={The TeXbook}, year={1986}, publisher={Addison-Wesley}}\n';

{
  const sidecars: string[] = [];
  const opened = openMarkdown(md, (path) => {
    sidecars.push(path);
    return bib;
  });
  check('the bibliography: sidecar is read beside the document', sidecars.join() === 'refs.bib');
  check('the sidecar makes the document bibliography', JSON.stringify(opened.doc.attrs.bib ?? null).includes('knuth86'), JSON.stringify(opened.doc.attrs.bib));
  check('the page setting is read', opened.doc.attrs.settings?.page === 'half-letter', String(opened.doc.attrs.settings?.page));
  check('the value keys are named once each', valueNames(opened.doc).join() === 'price,qty,rev', valueNames(opened.doc).join());

  const missingSidecar = openMarkdown(md, () => null);
  check('a sidecar not found is a warning, not a failure', missingSidecar.warnings.some((w) => w.includes('refs.bib')), missingSidecar.warnings.join('\n'));

  const applied = applyValues(opened.doc, { price: 7.25, qty: 12, rev: 87 });
  const text = applied.doc.textContent;
  check('values are brought up to date, rounded as the mark says', text.includes('7.25') && text.includes('12') && text.includes('87.0'), text);
  check('nothing is missing', applied.missing.length === 0, applied.missing.join());

  const partial = applyValues(opened.doc, { price: 3 });
  check('keys the file lacks are named, their text kept', partial.missing.join() === 'qty,rev' && partial.doc.textContent.includes('10'), partial.missing.join());

  await ensureMathConverter();
  const source = exportSource(applied.doc);
  check('the source is the print form: comments out, values as text', !source.includes('editorial note') && source.includes('7.25') && source.includes('87.0'), source);
  check('math is native Typst', /\$p\s+dot\.c\s+q\s*\$/.test(source), source);
  check('the citation and bibliography are in it', source.includes('@knuth86') && source.includes('#bibliography'), source);
  check('the bundled faces are the fallbacks', /font: \("New Computer Modern", "STIX Two Text"/.test(source), source);
}

{
  const embedded = openMarkdown('![A plot](data:image/png;base64,iVBORw0KGgo=)\n', () => null);
  let error: unknown = null;
  try {
    exportSource(embedded.doc);
  } catch (e) {
    error = e;
  }
  check('an embedded image is refused by name', error instanceof DataImageError, String(error));
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('headless-export: all passed');
