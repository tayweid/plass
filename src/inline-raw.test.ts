import { inlineRawPreamble } from './inline-raw';
import { DEFAULT_SETTINGS } from './settings';
import { classifyTypstInline, typstInlineLink } from './typst-inline-regions';
import { schema } from './schema';
import { docToTyp } from './typ-serializer';

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

const legacy = inlineRawPreamble({ ...DEFAULT_SETTINGS, font: 'STIX Two Text' });
check('inline raw resolves uncertified fonts exactly like whole-document output',
  legacy.includes('font: "New Computer Modern"') && !legacy.includes('STIX Two Text'));

const hostile = inlineRawPreamble({ ...DEFAULT_SETTINGS, font: 'A"B' });
check('inline raw never interpolates a stored font name into Typst source',
  hostile.includes('font: "New Computer Modern"') && !hostile.includes('A\\"B'));

for (const source of [
  '#box[#circle(radius: 3pt)]',
  '#box(width: 2em)[safe #strong[content]]',
  '#box[#text("stroke: 12pt is data")]',
  '#sym.arrow.r',
  '#emoji.face.smile',
  '#h(1em)',
  '$x^2 + y^2$',
]) {
  check(`atomic source is supported: ${source}`, classifyTypstInline(source).kind === 'fixed');
}

check('canonical one-fraction horizontal space is flexible',
  classifyTypstInline('#h(1fr)').kind === 'flexible');

for (const source of [
  '#h(2fr)',
  '#circle(radius: 3pt)',
  '#text("a potentially breakable text run")',
  '#box(width: 100%)[context-dependent]',
  '$ x^2 + y^2 $',
  '#circle(radius: 2pt) trailing prose',
  '#circle(radius: 2pt); #circle(radius: 3pt)',
  '#box[#pagebreak()]',
  '#box[#rect(width: 10pt, stroke: 12pt)]',
  '#box(outset: 4pt)[paint]',
  '#context counter(page).display()',
  '#include "other.typ"',
  '#circle(radius: 2pt',
  'plain source',
]) {
  check(`unsafe/non-atomic source stays lossless but unsupported: ${source}`,
    classifyTypstInline(source).kind === 'unsupported');
}

{
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text('A '),
    schema.nodes.typst_inline.create({ src: '#box[#circle(radius: 2pt)]' }),
    schema.text(' B '),
    schema.nodes.typst_inline.create({ src: '#pagebreak()' }),
    schema.text(' C '),
    schema.nodes.typst_inline.create({ src: '#sym.arrow.r' }),
  ]);
  const document = schema.nodes.doc.create(null, [paragraph]);
  const normal = docToTyp(document);
  const instrumented = docToTyp(document, { inlineRegions: true });
  check('normal Typst export keeps every inline source verbatim and unlinked',
    normal.includes('#box[#circle(radius: 2pt)]') && normal.includes('#pagebreak()') &&
      normal.includes('#sym.arrow.r') && !normal.includes('plass.invalid'));
  check('editor publication wraps only conservative atoms and preserves preorder indices',
    instrumented.includes(typstInlineLink(0)) &&
      !instrumented.includes(typstInlineLink(1)) &&
      instrumented.includes(typstInlineLink(2)) &&
      instrumented.includes('#pagebreak()'));
}

console.log('\nall inline raw tests passed');
