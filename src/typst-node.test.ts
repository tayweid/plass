// The app's compiler under Node (typst-node.ts): the checkout's wasm and
// fonts compile a source to a PDF in the bundled faces, the same bytes
// twice but for the stamps, and the two-up source places that PDF's
// pages. Run: npx tsx src/typst-node.test.ts
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pdfPageCount, pdfStampsBlanked, twoUpSource } from './pdf-sheets';
import { compilePdf } from './typst-node';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const resources = {
  compilerWasm: createRequire(import.meta.url).resolve('@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm'),
  fontsDir: fileURLToPath(new URL('../public/fonts/', import.meta.url)),
};
const source = '#set page(width: 5.5in, height: 8.5in)\n#set text(font: "Libertinus Serif")\n= Hello\nSome text $x^2 + y_1$ and `code`.\n#pagebreak()\nPage two.\n';

const first = await compilePdf(source, [], resources);
check('a PDF', String.fromCharCode(...first.subarray(0, 5)) === '%PDF-', String.fromCharCode(...first.subarray(0, 8)));
const text = Buffer.from(first).toString('latin1');
check('the bundled faces, subset', /LibertinusSerif-Regular/.test(text) && /NewCMMath-Regular/.test(text) && /DejaVuSansMono/.test(text));
check('two pages', pdfPageCount(first) === 2, String(pdfPageCount(first)));
const second = await compilePdf(source, [], resources);
check('the same bytes twice, but for the stamps', pdfStampsBlanked(first) === pdfStampsBlanked(second));
check('the stamps are blanked', !/D:\d{14}Z/.test(pdfStampsBlanked(first)) && pdfStampsBlanked(first).includes('/ID []'));

const twoUp = await compilePdf(twoUpSource('/document.pdf', 2, 5.5, 8.5), [{ path: '/document.pdf', data: first }], resources);
check('two to a sheet: one sheet', pdfPageCount(twoUp) === 1, String(pdfPageCount(twoUp)));

try {
  await compilePdf('#panic("no")', [], resources);
  check('a failing source throws', false, 'it compiled');
} catch (e) {
  check('a failing source throws, its diagnostics readable', e instanceof Error && e.message === 'panicked with: "no"', String(e));
}

console.log(failures ? `typst-node: ${failures} failure(s)` : 'typst-node: ok');
process.exit(failures ? 1 : 0);
