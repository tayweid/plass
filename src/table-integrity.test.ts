// Focused P0 regressions for table-cell preservation. Run with:
//   npx tsx src/table-integrity.test.ts
import { schema } from './schema.ts';
import { extractTableSourceParts, parseTable, typToDoc } from './typ-parser.ts';
import { docToTyp } from './typ-serializer.ts';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n${detail}` : ''}`);
  }
}

function expectThrow(name: string, fn: () => unknown, pattern: RegExp) {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, pattern.test(message), message);
  }
}

function firstDiff(a: string, b: string): string {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) return `line ${i + 1}:\n  a: ${JSON.stringify(left[i])}\n  b: ${JSON.stringify(right[i])}`;
  }
  return '';
}

const { doc: docType, table, table_row, table_cell, paragraph, bibliography, bullet_list, list_item } = schema.nodes;
const bib = '@book{knuth86, title={The TeXbook}, author={Knuth, Donald E.}, year={1986}}';
const richCell = table_cell.create(null, [
  paragraph.create(null, [
    schema.text('Marked', [schema.marks.strong.create()]),
    schema.text(' math '),
    schema.nodes.math_inline.create({ src: '\\sqrt[3]{x}' }),
    schema.text(' cite '),
    schema.nodes.citation.create({ key: 'knuth86' }),
    schema.text(' and an unmatched ('),
  ]),
  paragraph.create(null, [schema.text('Second paragraph', [schema.marks.em.create()])]),
]);
const richTable = table.create(
  { style: 'booktabs', caption: 'Rich results', label: 'tab:rich' },
  [table_row.create(null, [richCell])],
);

// Marks, inline math, citations, and paragraph boundaries survive the
// serializer/importer round trip. The bibliography disambiguates @knuth86.
{
  const doc = docType.create({ bib: { name: 'references.bib', content: bib } }, [richTable, bibliography.create()]);
  const emitted = docToTyp(doc);
  const imported = typToDoc(emitted);
  let backTable: import('prosemirror-model').Node | null = null;
  imported.doc.descendants((node) => {
    if (!backTable && node.type.name === 'table') backTable = node;
    return !backTable;
  });
  const backCell = (backTable as import('prosemirror-model').Node | null)?.child(0).child(0);
  check('rich table imports as structured table', !!backCell, imported.warnings.join('; '));
  check('multiple table-cell paragraphs survive', backCell?.childCount === 2, String(backCell?.childCount));
  check('rich table-cell JSON survives', JSON.stringify(backCell?.toJSON()) === JSON.stringify(richCell.toJSON()), JSON.stringify(backCell?.toJSON()));
  const emittedAgain = docToTyp(imported.doc);
  check('rich table export is idempotent', emittedAgain === emitted, firstDiff(emitted, emittedAgain));
}

// The generated-source inspector must extract the balanced table(...) call,
// not slice through the surrounding captioned figure(...).
{
  const emitted = docToTyp(
    docType.create({ bib: { name: 'references.bib', content: bib } }, [richTable, bibliography.create()]),
  );
  const parts = extractTableSourceParts(emitted);
  check('captioned table call is extracted', !!parts);
  check('caption wrapper is excluded from table args', !parts?.args.join('\n').includes('caption:') && !parts?.args.join('\n').includes('figure('));
  const reconstructed = parts
    ? `#table(\n${parts.args.map((arg) => `${arg},`).join('\n')}\n${parts.rows.map((row) => `${row},`).join('\n')}\n)`
    : '';
  const parsed = reconstructed ? parseTable(reconstructed) : null;
  check('extracted captioned table source reparses', !!parsed);
  check('balanced extraction tolerates unmatched cell parens', parsed?.child(0).child(0).textContent.includes('unmatched (') === true);
}

// Hand-written paragraph-only cells are supported; unsupported block
// constructs reject the table so typToDoc can retain it as raw Typst.
{
  const parsed = parseTable('#table(columns: 1, [First paragraph\n\nSecond paragraph])');
  check('hand-written multi-paragraph cell parses', parsed?.child(0).child(0).childCount === 2);
  const raw = typToDoc('#table(columns: 1, [- list content])\n');
  check(
    'unsupported hand-written cell block is preserved as raw',
    raw.doc.child(0).type.name === 'typst_embed',
    raw.warnings.join('; '),
  );
}

// A flat Typst cell stream can advance through a row that is entirely covered
// by a prior rowspan. The structured subset has no lossless representation for
// that empty logical row, so it must preserve the whole table as executable
// source rather than returning a prefix and dropping later cells.
{
  const source = '#table(columns: 1, table.cell(rowspan: 2)[A], [B])';
  check('fully rowspan-covered table row fails closed', parseTable(source) === null);
  const imported = typToDoc(source + '\n');
  check(
    'rowspan topology with trailing cells is preserved verbatim',
    imported.doc.firstChild?.type.name === 'typst_embed' && imported.doc.firstChild.textContent === source,
    JSON.stringify(imported.doc.firstChild?.toJSON()),
  );
}

// PM permits arbitrary block+ in a cell. Until those blocks have a faithful
// Typst mapping, export must stop explicitly instead of dropping them.
{
  const item = list_item.create(null, [paragraph.create(null, [schema.text('Kept list content')])]);
  const unsupportedCell = table_cell.create(null, [bullet_list.create(null, [item])]);
  const unsupported = table.create(null, [table_row.create(null, [unsupportedCell])]);
  expectThrow(
    'unsupported table-cell block fails without silent loss',
    () => docToTyp(docType.create(null, [unsupported])),
    /unsupported bullet_list block; content was not discarded/,
  );

  const linked = paragraph.create(null, [schema.text('linked', [schema.marks.link.create({ href: 'https://example.test' })])]);
  const linkedTable = table.create(null, [table_row.create(null, [table_cell.create(null, [linked])])]);
  expectThrow(
    'unsupported table-cell mark fails without silent loss',
    () => docToTyp(docType.create(null, [linkedTable])),
    /unsupported link mark; content was not discarded/,
  );

  const rawInline = paragraph.create(null, [schema.nodes.typst_inline.create({ src: '#h(1em)' })]);
  const rawInlineTable = table.create(null, [table_row.create(null, [table_cell.create(null, [rawInline])])]);
  expectThrow(
    'source-backed inline Typst is explicitly outside structured cell export',
    () => docToTyp(docType.create(null, [rawInlineTable])),
    /unsupported inline typst_inline; content was not discarded/,
  );

  expectThrow(
    'table citation without bibliography fails instead of changing node kind',
    () => docToTyp(docType.create(null, [richTable])),
    /citation "knuth86" has no portable bibliography entry/,
  );

  const unsafeLabel = table.create(
    { ...richTable.attrs, label: 'tab:results> #panic' },
    richTable.content,
  );
  expectThrow(
    'unsafe table label fails before it can become executable Typst',
    () => docToTyp(docType.create({ bib: { name: 'references.bib', content: bib } }, [unsafeLabel])),
    /reference label.*is not portable Typst syntax/,
  );
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall table-integrity tests passed');
}
