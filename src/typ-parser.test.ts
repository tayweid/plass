// Round-trip and import tests for the .typ parser. Run: npm test
import { demoDoc } from './demo-doc.ts';
import { docToTyp } from './typ-serializer.ts';
import { migrateLegacyTableGeometry, typToDoc } from './typ-parser.ts';
import { schema } from './schema.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? '\n' + detail : ''}`);
  }
}

function firstDiff(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return `line ${i + 1}:\n  a: ${JSON.stringify(al[i])}\n  b: ${JSON.stringify(bl[i])}`;
  }
  return '';
}

// --- 1. our own output round-trips exactly: export -> import -> export ---
{
  const original = demoDoc();
  const t1 = docToTyp(original);
  const { doc, warnings } = typToDoc(t1);
  const t2 = docToTyp(doc);
  check('demo doc round-trips byte-identically', t1 === t2, firstDiff(t1, t2));
  check('demo document JSON survives unchanged', JSON.stringify(doc.toJSON()) === JSON.stringify(original.toJSON()));
  check('demo doc imports without warnings', warnings.length === 0, warnings.join('; '));
}

// --- 2. idempotence on a second cycle ---
{
  const t1 = docToTyp(demoDoc());
  const t2 = docToTyp(typToDoc(t1).doc);
  const t3 = docToTyp(typToDoc(t2).doc);
  check('import/export is idempotent', t2 === t3, firstDiff(t2, t3));
}

// --- 3. settings survive the round trip ---
{
  const src = docToTyp(demoDoc())
    .replace('paper: "us-letter"', 'paper: "a4"')
    .replace('margin: 1.25in', 'margin: 1in')
    .replace('size: 12.5pt', 'size: 11pt');
  const { doc } = typToDoc(src);
  const s = doc.attrs.settings;
  check('paper imported', s.page === 'a4');
  check('margin imported', s.marginTop === 1 && s.marginLeft === 1);
  check('size imported', s.sizePt === 11);
  const out = docToTyp(doc);
  check('modified settings re-export', out.includes('paper: "a4"') && out.includes('margin: 1in'));
}

// --- 3b. paper sizes and footnote options round-trip ---
{
  const half = docToTyp(demoDoc()).replace('paper: "us-letter"', 'width: 5.5in, height: 8.5in');
  const s1 = typToDoc(half).doc.attrs.settings;
  check('half letter imports by its dimensions', s1.page === 'half-letter');
  check('half letter re-exports as dimensions', docToTyp(typToDoc(half).doc).includes('width: 5.5in, height: 8.5in'));
  const custom = docToTyp(demoDoc()).replace('paper: "us-letter"', 'width: 148mm, height: 210mm');
  const s2 = typToDoc(custom).doc.attrs.settings;
  check('a metric custom size imports in inches', s2.page === 'custom' && Math.abs(s2.pageWidthIn - 5.83) < 0.01 && Math.abs(s2.pageHeightIn - 8.27) < 0.01);
  const a5 = docToTyp(demoDoc()).replace('paper: "us-letter"', 'paper: "a5"');
  check('a5 imports by name', typToDoc(a5).doc.attrs.settings.page === 'a5');
  const fn = docToTyp(demoDoc()).replace('#set text(', '#set footnote(numbering: "a")\n#set footnote.entry(separator: none)\n#set text(');
  const s3 = typToDoc(fn).doc.attrs.settings;
  check('footnote numbering and separator import', s3.footnoteNumbering === 'a' && s3.footnoteSeparator === 'none');
  const back = docToTyp(typToDoc(fn).doc);
  check('footnote options re-export', back.includes('#set footnote(numbering: "a")') && back.includes('#set footnote.entry(separator: none)'));
}

// --- 4. hand-written Typst: pragmatic subset + raw preservation ---
{
  const src = [
    '#let answer = 42',
    '#show heading: set text(blue)',
    '',
    '= Intro',
    '',
    'Some *bold*, _italic_, and `code` here. Math like $x^2 + 1$ inline.',
    'A second source line of the same paragraph.',
    '',
    '- first item',
    '- second item',
    '',
    'Escaped \\* star and \\@ at-sign.',
  ].join('\n');
  const { doc, warnings } = typToDoc(src);

  check('unknown directives kept as raw islands', warnings.length === 1, warnings.join('; '));
  const first = doc.child(0);
  check('raw island is code_block(typst-raw)', first.type.name === 'code_block' && first.attrs.params === 'typst-raw');
  check('raw island preserves both lines', first.textContent === '#let answer = 42\n#show heading: set text(blue)');

  check('heading parsed', doc.child(1).type.name === 'heading');
  const para = doc.child(2);
  let hasStrong = false;
  let hasEm = false;
  let hasCode = false;
  let mathSrc = '';
  para.descendants((n) => {
    for (const m of n.marks) {
      if (m.type.name === 'strong') hasStrong = true;
      if (m.type.name === 'em') hasEm = true;
      if (m.type.name === 'code') hasCode = true;
    }
    if (n.type.name === 'math_inline') mathSrc = n.attrs.src;
    return true;
  });
  check('bold/italic/code marks parsed', hasStrong && hasEm && hasCode);
  check('$…$ math parsed', mathSrc === 'x^2 + 1');
  check('source lines joined into one paragraph', para.textContent.includes('inline. A second source line'));

  check('bullet list parsed', doc.child(3).type.name === 'bullet_list' && doc.child(3).childCount === 2);
  check('escapes unescaped on import', doc.child(4).textContent === 'Escaped * star and @ at-sign.');

  // and the raw island survives a re-export verbatim
  const out = docToTyp(doc);
  check('raw island re-exports verbatim', out.includes('#let answer = 42\n#show heading: set text(blue)'));
}

// --- 5. labels and references survive ---
{
  const src = ['#mitex(`', 'a^2 + b^2 = c^2', '`) <eq:pyth>', '', 'See @eq:pyth. Done.'].join('\n');
  const { doc } = typToDoc(src);
  check('display math label imported', doc.child(0).attrs.label === 'eq:pyth');
  let refLabel = '';
  doc.descendants((n) => {
    if (n.type.name === 'eq_ref') refLabel = n.attrs.label;
    return true;
  });
  check('reference imported without trailing period', refLabel === 'eq:pyth');
}

// --- 6. figures round-trip and import ---
{
  const src = '#figure(image("chart.png"), caption: [The *elasticity* of demand [inelastic case]]) <fig:el>';
  // note: hand-written captions may contain brackets; ours are escaped
  const { doc } = typToDoc(src + '\n');
  const fig = doc.child(0);
  check('figure parsed', fig.type.name === 'figure');
  check('figure src imported', fig.attrs.src === 'chart.png');
  check('figure label imported', fig.attrs.label === 'fig:el');
  check('figure caption text', fig.textContent === 'The elasticity of demand [inelastic case]');
  let em = false;
  fig.descendants((n) => {
    if (n.marks.some((m) => m.type.name === 'strong')) em = true;
    return true;
  });
  check('caption marks parsed', em);
  const out = docToTyp(doc);
  check('figure re-exports with label', out.includes('caption: [The *elasticity* of demand \\[inelastic case\\]]) <fig:el>'));
  const again = docToTyp(typToDoc(out).doc);
  check('figure export is idempotent', out === again, firstDiff(out, again));
}

// --- strikethrough round-trips and imports ---
{
  const src = 'Keep this, #strike[drop *this* part], continue.\n';
  const { doc, warnings } = typToDoc(src);
  let struck = '';
  let nested = false;
  doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'strike')) {
      struck += n.text;
      if (n.marks.some((m) => m.type.name === 'strong')) nested = true;
    }
    return true;
  });
  check('strike imports as a mark, not a raw island', struck === 'drop this part', JSON.stringify({ struck, warnings }));
  check('strike nests with strong', nested);
  const out = docToTyp(doc);
  check('strike re-exports as #strike', out.includes('#strike['), out);
  const again = docToTyp(typToDoc(out).doc);
  check('strike export is idempotent', out === again, firstDiff(out, again));
}

// --- 6b. block offsets: where each top-level block starts in the text ---
{
  const doc = demoDoc();
  const offsets: number[] = [];
  const typ = docToTyp(doc, { offsets });
  check('offsets do not change the output', typ === docToTyp(doc));
  check('one offset per top-level block', offsets.length === doc.childCount, `${offsets.length} vs ${doc.childCount}`);
  check('offsets are non-decreasing', offsets.every((o, i) => i === 0 || o >= offsets[i - 1]));
  let mismatches = '';
  doc.forEach((node, _o, i) => {
    const at = typ.slice(offsets[i], offsets[i] + 40);
    // Every block starts on its own line; a heading's line starts with its
    // markers. (A paragraph may start with inline markup, so only the line
    // boundary is checked for it.)
    const lineStart = offsets[i] === 0 || typ[offsets[i] - 1] === '\n';
    const want = node.type.name === 'heading' ? '='.repeat(node.attrs.level as number) + ' ' : '';
    if (!lineStart || !at.startsWith(want)) mismatches += `\n  block ${i} ${node.type.name}: ${JSON.stringify(at)}`;
  });
  check('each offset lands at a line start, headings on their markers', mismatches === '', mismatches);
}

// --- 7a. a source space before #footnote never prints, so import drops it ---
{
  const { doc } = typToDoc('Word #footnote[n] after.\n');
  let para: ReturnType<typeof doc.child> | null = null;
  doc.descendants((n) => {
    if (!para && n.type.name === 'paragraph') para = n;
    return !para;
  });
  const p = para!;
  check(
    'import drops the space before a footnote marker',
    p.child(0).text === 'Word' && p.child(1).type.name === 'footnote' && p.child(2).text === ' after.',
    JSON.stringify(p.toJSON()),
  );
}

// --- 7. footnotes round-trip and import ---
{
  const src = 'A claim#footnote[See *Smith 2020*, ch. 3 — and $x^2$ holds.] with a note.\n';
  const { doc } = typToDoc(src);
  const para = doc.child(0);
  let fnNode: typeof para | null = null;
  para.descendants((n) => {
    if (n.type.name === 'footnote') fnNode = n;
    return true;
  });
  check('footnote parsed', !!fnNode);
  if (!fnNode) throw new Error('no footnote node');
  const fn: typeof para = fnNode;
  check('footnote body text', fn.textContent === 'See Smith 2020, ch. 3 — and  holds.');
  let hasStrong = false;
  let hasMath = false;
  fn.descendants((n) => {
    if (n.marks.some((m) => m.type.name === 'strong')) hasStrong = true;
    if (n.type.name === 'math_inline') hasMath = true;
    return true;
  });
  check('footnote body keeps markup + math', hasStrong && hasMath);
  const out = docToTyp(doc);
  const again = docToTyp(typToDoc(out).doc);
  check('footnote export idempotent', out === again, firstDiff(out, again));
}

// --- 8. citations + embedded bibliography round-trip ---
{
  const bib = '@book{knuth86, title={The TeXbook}, author={Knuth, Donald E.}, year={1986}}';
  const src = ['See @knuth86 and @eq:foo for details.', '', `#bibliography(bytes(${JSON.stringify(bib)}), style: "ieee")`].join('\n');
  const { doc } = typToDoc(src);
  let citeKeyFound = '';
  let refLabel = '';
  let bibNode = false;
  doc.descendants((n) => {
    if (n.type.name === 'citation') citeKeyFound = n.attrs.key;
    if (n.type.name === 'eq_ref') refLabel = n.attrs.label;
    if (n.type.name === 'bibliography') bibNode = true;
    return true;
  });
  check('bib key becomes citation', citeKeyFound === 'knuth86');
  check('non-bib @label stays a reference', refLabel === 'eq:foo');
  check('bibliography node created', bibNode);
  check('bib content stored in doc attrs', doc.attrs.bib?.content === bib);
  const out = docToTyp(doc);
  check('bib re-embeds on export', out.includes('#bibliography(bytes(') && out.includes('knuth86'));
  const again = docToTyp(typToDoc(out).doc);
  check('citation export idempotent', out === again, firstDiff(out, again));
}

// --- 9. tables round-trip (header, merges) ---
{
  const src = [
    '#table(',
    '  columns: 3,',
    '  table.header([Model], [Coef.], [SE]),',
    '  [OLS], [0.42], [0.05],',
    '  table.cell(colspan: 2)[Fixed effects], [yes],',
    ')',
  ].join('\n');
  const { doc, warnings } = typToDoc(src + '\n');
  const tbl = doc.child(0);
  check('table parsed', tbl.type.name === 'table', warnings.join('; '));
  check('table has 3 rows', tbl.childCount === 3);
  check('header row typed', tbl.child(0).child(0).type.name === 'table_header');
  check('data cell typed', tbl.child(1).child(0).type.name === 'table_cell');
  check('colspan imported', tbl.child(2).child(0).attrs.colspan === 2);
  check('cell text', tbl.child(1).child(1).textContent === '0.42');
  const out = docToTyp(doc);
  const again = docToTyp(typToDoc(out).doc);
  check('table export idempotent', out === again, firstDiff(out, again));
  check('table re-exports header + colspan', out.includes('table.header(') && out.includes('table.cell(colspan: 2)'));
}

// --- 10. table styles + alignment round-trip ---
{
  const src = [
    '#table(',
    '  columns: 2,',
    '  align: (left, right),',
    '  stroke: none,',
    '  table.hline(stroke: 0.08em),',
    '  table.header([Variable], [Estimate]),',
    '  table.hline(stroke: 0.05em),',
    '  [Constant], [1.234],',
    '  [Slope], table.cell(align: center)[0.567],',
    '  table.hline(stroke: 0.08em),',
    ')',
  ].join('\n');
  const { doc } = typToDoc(src + '\n');
  const tbl = doc.child(0);
  check('booktabs style detected', tbl.attrs.style === 'booktabs');
  check('column align applied to cells', tbl.child(1).child(1).attrs.align === 'right');
  check('cell align override wins', tbl.child(2).child(1).attrs.align === 'center');
  const out = docToTyp(doc);
  check('re-export keeps stroke none + hlines', out.includes('stroke: none') && out.includes('table.hline('));
  check('re-export keeps align tuple', out.includes('align: (left, right)'));
  const again = docToTyp(typToDoc(out).doc);
  check('styled table export idempotent', out === again, firstDiff(out, again));
}

// --- 11. custom #table arguments round-trip verbatim (full-control hatch) ---
{
  const src = [
    '#table(',
    '  columns: (2fr, 1fr, 1fr),',
    '  inset: 6pt,',
    '  fill: (x, y) => if calc.odd(y) { luma(245) },',
    '  table.header([A], [B], [C]),',
    '  [1], [2], [3],',
    ')',
  ].join('\n');
  const { doc, warnings } = typToDoc(src + '\n');
  const tbl = doc.child(0);
  check('custom-arg table still parses as a table', tbl.type.name === 'table', warnings.join('; '));
  check('supported inset is typed and unknown fill remains preserved', tbl.attrs.insetPt === 6 && /fill: \(x, y\)/.test(tbl.attrs.params));
  check('fractional columns captured as typed widths', JSON.stringify(tbl.attrs.columnWidths) === '["2fr","1fr","1fr"]');
  const out = docToTyp(doc);
  check('custom params re-emitted', out.includes('inset: 6pt,') && out.includes('columns: (2fr, 1fr, 1fr)'));
  check('no duplicate columns arg', (out.match(/columns\s*:/g) ?? []).length === 1);
  check('no preset stroke with custom params', !out.includes('table.hline('));
  const again = docToTyp(typToDoc(out).doc);
  check('custom-table export idempotent', out === again, firstDiff(out, again));
}

// --- 12. polish bundle: page numbering, sections, macros, heading labels ---
{
  const src = [
    '// Exported from Plass',
    '#set page(paper: "us-letter", margin: 1.25in, numbering: "— 1 —", number-align: right)',
    '#set par(justify: true)',
    '#set text(size: 12.5pt, font: "New Computer Modern", hyphenate: true)',
    '#set math.equation(numbering: "(1)")',
    '#set heading(numbering: "1.1")',
    '#counter(page).update(3)',
    '// typeset:math-macros "\\\\E = \\\\mathbb{E}"',
    '#import "@preview/mitex:0.2.5": mi, mitex',
    '',
    '= Introduction <sec:intro>',
    '',
    'See @sec:intro and the mean #mi(`\\E[X]`).',
  ].join('\n');
  const { doc } = typToDoc(src + '\n');
  const s = doc.attrs.settings;
  check('page number format imported', s.pageNumFormat === '— 1 —' && s.pageNumShow === true);
  check('page number align imported', s.pageNumAlign === 'right');
  check('page start imported', s.pageNumStart === 3);
  check('section numbering imported', s.numberSections === true);
  check('macros imported', s.mathMacros === '\\E = \\mathbb{E}');
  check('font default is New Computer Modern', s.font === 'New Computer Modern');
  check('heading label imported', doc.child(0).attrs.label === 'sec:intro');
  let refLabel = '';
  doc.descendants((n) => {
    if (n.type.name === 'eq_ref') refLabel = n.attrs.label;
    return true;
  });
  check('heading ref imported', refLabel === 'sec:intro');
  const out = docToTyp(doc);
  check('macros expand on export', out.includes('\\mathbb{E}[X]') && !out.includes('#mi(`\\E[X]`)'));
  check('macros directive re-emitted', out.includes('// typeset:math-macros'));
  const again = docToTyp(typToDoc(out).doc);
  check('polish round-trip idempotent', out === again, firstDiff(out, again));
}

// --- 13. page numbers hidden round-trips ---
{
  const { doc } = typToDoc('#set page(paper: "us-letter", margin: 1in)\n\nHello.\n');
  check('no numbering param → page numbers off', doc.attrs.settings.pageNumShow === false);
  const out = docToTyp(doc);
  check('re-export omits numbering', !out.includes('numbering: "1"') || out.includes('math.equation'));
}

// --- 13b. captioned table (figure) round-trips with number/label/midrule ---
{
  const src = [
    '#set page(paper: "us-letter", margin: 1.25in)',
    '',
    '#figure(',
    '  table(',
    '    columns: 2,',
    '    stroke: none,',
    '    table.hline(stroke: 0.08em),',
    '    table.header([A], [B]),',
    '    table.hline(stroke: 0.05em),',
    '    [1], [2],',
    '    table.hline(stroke: 0.08em),',
    '  ),',
    '  caption: [Results of the thing],',
    ') <tab:results>',
  ].join('\n');
  const { doc } = typToDoc(src + '\n');
  let table: import('prosemirror-model').Node | null = null;
  doc.descendants((n) => {
    if (!table && n.type.name === 'table') table = n;
    return !table;
  });
  const tAttrs = (table as import('prosemirror-model').Node | null)?.attrs;
  check('captioned table parsed', !!table);
  check('caption imported', tAttrs?.caption === 'Results of the thing');
  check('table label imported', tAttrs?.label === 'tab:results');
  const out = docToTyp(doc);
  check('figure re-emitted', out.includes('#figure(') && out.includes('caption: [Results of the thing]') && out.includes('<tab:results>'));
  const again = docToTyp(typToDoc(out).doc);
  check('captioned table idempotent', out === again, firstDiff(out, again));
}

// --- 13c. decimal-aligned column splits on export and fuses on import ---
{
  const { table, table_row, table_cell, table_header, paragraph, doc: docType } = schema.nodes;
  const mk = (text: string, header = false, align: string | null = null) =>
    (header ? table_header : table_cell).create({ align }, [paragraph.create(null, text ? [schema.text(text)] : [])]);
  const t = table.create({ style: 'booktabs' }, [
    table_row.create(null, [mk('Item', true), mk('Price', true, 'decimal')]),
    table_row.create(null, [mk('Apples'), mk('12.5', false, 'decimal')]),
    table_row.create(null, [mk('Pears'), mk('3.75', false, 'decimal')]),
    table_row.create(null, [mk('Total'), mk('16', false, 'decimal')]),
  ]);
  const d = docType.create(null, [t]);
  const out = docToTyp(d);
  check('decimal directive emitted', out.includes('// typeset:decimal-columns 1'));
  check('decimal split emitted', out.includes('inset: (right: 0pt))[12]') && out.includes('inset: (left: 0pt))[.5]'));
  check('decimal header spans', out.includes('colspan: 2, align: center)[Price]'));
  const back = typToDoc(out);
  let t2: import('prosemirror-model').Node | null = null;
  back.doc.descendants((n) => {
    if (!t2 && n.type.name === 'table') t2 = n;
    return !t2;
  });
  const t2n = t2 as import('prosemirror-model').Node | null;
  check('fused back to 2 columns', t2n?.child(1)?.childCount === 2);
  check('decimal align restored', t2n?.child(1)?.child(1)?.attrs.align === 'decimal');
  check('cell text rejoined', t2n?.child(1)?.child(1)?.textContent === '12.5');
  const again = docToTyp(back.doc);
  check('decimal round-trip idempotent', out === again, firstDiff(out, again));
  const sized = t.type.create({ ...t.attrs, columnWidths: ['2fr', '1fr'], insetPt: 9 }, t.content);
  const sizedOut = docToTyp(docType.create(null, sized));
  const sizedBack = typToDoc(sizedOut).doc.firstChild!;
  check('decimal split fuses typed widths back to logical columns', JSON.stringify(sizedBack.attrs.columnWidths) === '["2fr","1fr"]');
  check('decimal typed widths round-trip stably', docToTyp(docType.create(null, sizedBack)) === sizedOut);
}

// --- 13d. table font size + vlines round-trip ---
{
  const { table, table_row, table_cell, table_header, paragraph, doc: docType } = schema.nodes;
  const mk2 = (text: string, header = false) =>
    (header ? table_header : table_cell).create(null, [paragraph.create(null, text ? [schema.text(text)] : [])]);
  const t = table.create(
    { style: 'booktabs', fontSize: '0.85em', params: 'table.vline(x: 1, stroke: 0.05em)', caption: 'Sized', label: 'tab:sized' },
    [
      table_row.create(null, [mk2('A', true), mk2('B', true)]),
      table_row.create(null, [mk2('1'), mk2('2')]),
    ],
  );
  const d2 = docType.create(null, [t]);
  const out = docToTyp(d2);
  check('size wrapper emitted', out.includes('text(size: 0.85em, table('));
  check('kind marker emitted', out.includes('kind: table'));
  check('vline emitted', out.includes('table.vline(x: 1'));
  const back = typToDoc(out);
  let t3: import('prosemirror-model').Node | null = null;
  back.doc.descendants((n) => {
    if (!t3 && n.type.name === 'table') t3 = n;
    return !t3;
  });
  const t3n = t3 as import('prosemirror-model').Node | null;
  check('fontSize imported', t3n?.attrs.fontSize === '0.85em');
  check('vline preserved', (t3n?.attrs.params as string)?.includes('table.vline(x: 1'));
  const again = docToTyp(back.doc);
  check('sized table idempotent', out === again, firstDiff(out, again));
}

// --- 13e. front matter (title/authors/date/abstract) round-trips ---
{
  const { doc_title, doc_authors, doc_date, abstract, paragraph, doc: docType } = schema.nodes;
  const d3 = docType.create(null, [
    doc_title.create(null, [schema.text('On Widgets')]),
    doc_authors.create(null, [schema.text('T. Weidman and A. Nother')]),
    doc_date.create(null, [schema.text('July 8, 2026')]),
    abstract.create(null, [paragraph.create(null, [schema.text('We study widgets carefully.')])]),
    paragraph.create(null, [schema.text('Body starts here.')]),
  ]);
  const out = docToTyp(d3);
  check('title emitted', out.includes('#align(center, text(size: 1.55em, weight: 700)[On Widgets])'));
  check('abstract emitted', out.includes('#align(center, text(weight: 600)[Abstract])') && out.includes('#pad(x: 1.8em)['));
  const back = typToDoc(out);
  const names: string[] = [];
  back.doc.forEach((n) => names.push(n.type.name));
  check('front matter reimported', JSON.stringify(names) === JSON.stringify(['doc_title', 'doc_authors', 'doc_date', 'abstract', 'paragraph']), JSON.stringify(names));
  const again = docToTyp(back.doc);
  check('front matter idempotent', out === again, firstDiff(out, again));
}

// --- 13f. empty paragraphs are blank lines in both worlds ---
{
  const { paragraph, doc: docType } = schema.nodes;
  const d4 = docType.create(null, [
    paragraph.create(null, [schema.text('Above.')]),
    paragraph.create(),
    paragraph.create(),
    paragraph.create(null, [schema.text('Below.')]),
  ]);
  const out = docToTyp(d4);
  check('empty paragraphs emit ~', /Above\.\n\n~\n\n~\n\nBelow\./.test(out));
  const back = typToDoc(out);
  const kinds: string[] = [];
  back.doc.forEach((n) => kinds.push(n.type.name + ':' + n.content.size));
  check('empty paragraphs reimported', JSON.stringify(kinds) === JSON.stringify(['paragraph:6', 'paragraph:0', 'paragraph:0', 'paragraph:6']), JSON.stringify(kinds));
  const again = docToTyp(back.doc);
  check('empty paragraph idempotent', out === again, firstDiff(out, again));
}

// --- 14. paragraph starting with list-like character survives ---
{
  const src = docToTyp(typToDoc('\\- not a list, just a dash').doc);
  check('leading-dash paragraph stays a paragraph', src.includes('\\- not a list'));
}

// --- 15. space semantics: Typst collapse, ~ as nbsp, literal tilde ---
{
  const doc = typToDoc('word  gap   here').doc;
  check('markup space runs collapse', doc.textContent === 'word gap here', JSON.stringify(doc.textContent));
  const doc2 = typToDoc('to~resolve ties').doc;
  check('inline ~ imports as nbsp', doc2.textContent === 'to\u00a0resolve ties', JSON.stringify(doc2.textContent));
  const out2 = docToTyp(doc2);
  check('nbsp exports as ~', out2.includes('to~resolve'), out2.slice(0, 120));
  const doc3 = typToDoc('approx \\~ tilde').doc;
  check('escaped tilde stays literal', doc3.textContent === 'approx ~ tilde', JSON.stringify(doc3.textContent));
  const out3 = docToTyp(doc3);
  check('literal tilde re-escapes', out3.includes('approx \\~ tilde'), out3.slice(0, 120));
}

// --- 16. Typst dash shorthands: document holds the printed glyphs ---
{
  const t = (src: string) => typToDoc(src).doc.textContent;
  check('em dash imports', t('a --- b') === 'a \u2014 b', JSON.stringify(t('a --- b')));
  check('en dash imports', t('a--b') === 'a\u2013b', JSON.stringify(t('a--b')));
  check('minus before digit imports', t('B = -1, C') === 'B = \u22121, C', JSON.stringify(t('B = -1, C')));
  check('hyphen mid-word stays', t('x-1 and 3-4') === 'x-1 and 3-4', JSON.stringify(t('x-1 and 3-4')));
  check('hyphen after paren stays', t('(-1)') === '(-1)', JSON.stringify(t('(-1)')));
  check('... imports as an ellipsis', t('wait... go') === 'wait\u2026 go', JSON.stringify(t('wait... go')));
  const rt = docToTyp(typToDoc('B = -1 and a --- b').doc);
  check('printed glyphs export literally', rt.includes('B = \u22121 and a \u2014 b'), rt.slice(0, 140));
  const again = docToTyp(typToDoc(rt).doc);
  check('dash round-trip idempotent', rt === again, firstDiff(rt, again));
}

// --- 17. mixed nbsp+space runs collapse (browser artifacts); pure nbsp stays ---
{
  const t = (src: string) => typToDoc(src).doc.textContent;
  check('mixed nbsp run collapses', t('a~ ~b') === 'a b', JSON.stringify(t('a~ ~b')));
  check('pure nbsp run survives', t('a~~b') === 'a\u00a0\u00a0b', JSON.stringify(t('a~~b')));
}

// --- 18. solution block: the #block(stroke: (left: …)) preset round-trips as kind 'solution' ---
{
  const p = schema.nodes.paragraph;
  const doc = schema.nodes.doc.create(null, [
    p.create(null, schema.text('Problem 1. Show that the sum is finite.')),
    schema.nodes.blockquote.create({ kind: 'solution' }, [
      p.create(null, schema.text('Bound each term by a geometric series.')),
      p.create(null, schema.text('The partial sums are therefore Cauchy.')),
    ]),
    schema.nodes.blockquote.create(null, [p.create(null, schema.text('A plain quote stays a quote.'))]),
  ]);
  const t1 = docToTyp(doc);
  check('solution exports as a left-stroke block', /#block\(width: 100%, stroke: \(left: 2pt \+ rgb\("#c00000"\)\), inset: \(left: 1em\)\)\[\n  #set text\(fill: rgb\("#c00000"\)\)\n/.test(t1), t1);
  const { doc: back, warnings } = typToDoc(t1);
  check('solution imports without warnings', warnings.length === 0, warnings.join('; '));
  const kinds: Array<string | null> = [];
  back.forEach((n) => n.type.name === 'blockquote' && kinds.push((n.attrs.kind as string | null) ?? null));
  check('solution kind survives import', JSON.stringify(kinds) === JSON.stringify(['solution', null]), JSON.stringify(kinds));
  check('solution keeps both paragraphs', back.child(1).childCount === 2 && back.child(1).child(1).textContent === 'The partial sums are therefore Cauchy.');
  const t2 = docToTyp(back);
  check('solution round-trips byte-identically', t1 === t2, firstDiff(t1, t2));
}

// --- 19. inline math inside a mark keeps the span one run ---
{
  const rt = (src: string) => {
    const out = docToTyp(typToDoc(src + '\n').doc);
    return out.slice(out.lastIndexOf('\n\n', out.length - 3) + 2).trimEnd();
  };
  check('bold math exports inside the strong run', rt('Have *$2$ drinks* now.') === 'Have *#mi(`2`) drinks* now.', rt('Have *$2$ drinks* now.'));
  check('bold math import carries the strong mark', (() => {
    const p = typToDoc('Have *$2$ drinks* now.\n').doc.firstChild!;
    let ok = false;
    p.forEach((n) => { if (n.type.name === 'math_inline') ok = n.marks.some((m) => m.type.name === 'strong'); });
    return ok;
  })());
  check('emphasis and strike runs keep math inside', rt('Mix _a $x$ b_ and #strike[c $y$ d].') === 'Mix _a #mi(`x`) b_ and #strike[c #mi(`y`) d].', rt('Mix _a $x$ b_ and #strike[c $y$ d].'));
  check('a footnote still closes the run', rt('Bold *a#footnote[n] b* here.') === 'Bold *a*#footnote[n]* b* here.', rt('Bold *a#footnote[n] b* here.'));
  const once = docToTyp(typToDoc('Have *$2$ drinks* now.\n').doc);
  const twice = docToTyp(typToDoc(once).doc);
  check('bold math round-trip is idempotent', once === twice, firstDiff(once, twice));
}

// --- 19b. heading levels 4–6 ---
{
  const src = '==== Four\n\n====== Six\n';
  const { doc } = typToDoc(src);
  check('deep headings keep their level', doc.child(0).attrs.level === 4 && doc.child(1).attrs.level === 6, JSON.stringify([doc.child(0).attrs.level, doc.child(1).attrs.level]));
  const out = docToTyp(doc);
  check('deep headings export with their level', out.includes('\n==== Four\n') && out.includes('\n====== Six\n'), out);
  check('deep headings get show rules like level 3', out.includes('#show heading.where(level: 4): set text(size: 14.375pt)') && out.includes('#show heading.where(level: 6): set text(size: 14.375pt)'), out.slice(0, 900));
}

// --- 19c. table density presets: a uniform inset round-trips as the preset ---
{
  const src = '#align(center, table(\n  columns: 2,\n  inset: 3pt,\n  stroke: none,\n  table.hline(stroke: 0.08em),\n  table.header([A], [B]),\n  table.hline(stroke: 0.05em),\n  [1], [2],\n  table.hline(stroke: 0.08em),\n))\n';
  const { doc } = typToDoc(src);
  check('inset: 3pt imports as the compact preset', doc.child(0).type.name === 'table' && doc.child(0).attrs.density === 'compact' && !doc.child(0).attrs.params, JSON.stringify(doc.child(0).attrs));
  const out = docToTyp(doc);
  check('the compact preset exports inset: 3pt', out.includes('  inset: 3pt,'), out);
  check('a density table round-trips byte-identically', docToTyp(typToDoc(out).doc) === out, firstDiff(docToTyp(typToDoc(out).doc), out));
  const other = typToDoc(src.replace('inset: 3pt', 'inset: (x: 2pt, y: 1pt)')).doc;
  check('a non-uniform inset stays a custom parameter', other.child(0).attrs.density === '' && /inset/.test(other.child(0).attrs.params as string), JSON.stringify(other.child(0).attrs));
  const five = typToDoc(src.replace('inset: 3pt', 'inset: 5pt')).doc;
  check('inset: 5pt is the default and exports without an inset', five.child(0).attrs.density === '' && !docToTyp(five).includes('inset:'), docToTyp(five));
}

// --- 19d. row rule presets: table.hline(y:, stroke:) at a row boundary ---
{
  const src = '#align(center, table(\n  columns: 2,\n  stroke: none,\n  table.hline(y: 2, stroke: 0.05em),\n  table.hline(stroke: 0.08em),\n  table.header([A], [B]),\n  table.hline(stroke: 0.05em),\n  [1], [2],\n  [3], [4],\n  table.hline(stroke: 0.08em),\n))\n';
  const { doc } = typToDoc(src);
  const t = doc.child(0);
  check('a light rule under row 2 is the row preset', t.type.name === 'table' && t.child(1).attrs.rule === 'light' && !t.attrs.params, JSON.stringify([t.type.name, t.child(1).attrs, t.attrs.params]));
  const out = docToTyp(doc);
  check('the row rule exports at its boundary', out.includes('  table.hline(y: 2, stroke: 0.05em),'), out);
  check('a row-rule table round-trips byte-identically', docToTyp(typToDoc(out).doc) === out, firstDiff(docToTyp(typToDoc(out).doc), out));
  // The header row's rule set to none replaces the booktabs midrule.
  const none = '#align(center, table(\n  columns: 2,\n  stroke: none,\n  table.hline(y: 1, stroke: none),\n  table.hline(stroke: 0.08em),\n  table.header([A], [B]),\n  [1], [2],\n  table.hline(stroke: 0.08em),\n))\n';
  const nd = typToDoc(none).doc;
  check('a header rule of none imports as the row preset', nd.child(0).type.name === 'table' && nd.child(0).child(0).attrs.rule === 'none', JSON.stringify(nd.child(0).attrs));
  const nout = docToTyp(nd);
  check('the preset midrule yields to the none rule', nout.includes('table.hline(y: 1, stroke: none)') && !nout.includes('table.hline(stroke: 0.05em)'), nout);
  // A partial or oddly-weighted rule stays a custom parameter.
  const custom = typToDoc(src.replace('table.hline(y: 2, stroke: 0.05em)', 'table.hline(y: 2, stroke: 1pt)')).doc;
  check('an unrecognized weight stays custom', custom.child(0).child(1).attrs.rule === '' && /hline\(y: 2, stroke: 1pt\)/.test(custom.child(0).attrs.params as string), JSON.stringify(custom.child(0).attrs));
}

// --- 19e. cell fill presets ---
{
  const src = '#align(center, table(\n  columns: 2,\n  stroke: none,\n  table.hline(stroke: 0.08em),\n  table.header([A], [B]),\n  table.hline(stroke: 0.05em),\n  table.cell(fill: luma(240))[1], [2],\n  [3], table.cell(align: right, fill: rgb("#fff3b0"))[4],\n  table.hline(stroke: 0.08em),\n))\n';
  const { doc } = typToDoc(src);
  const t = doc.child(0);
  check('preset fills import onto the cells', t.type.name === 'table' && t.child(1).child(0).attrs.fill === 'gray' && t.child(2).child(1).attrs.fill === 'yellow' && t.child(2).child(1).attrs.align === 'right', JSON.stringify([t.type.name, t.child(1).child(0).attrs, t.child(2).child(1).attrs]));
  const out = docToTyp(doc);
  check('fills and selected-cell alignment export on their cells', out.includes('table.cell(fill: luma(240))[1]') && out.includes('table.cell(align: right, fill: rgb("#fff3b0"))[4]'), out);
  check('filled table retains default alignment attrs', JSON.stringify(typToDoc(out).doc.firstChild!.toJSON()) === JSON.stringify(t.toJSON()));
  check('a filled table round-trips byte-identically', docToTyp(typToDoc(out).doc) === out, firstDiff(docToTyp(typToDoc(out).doc), out));
  const other = typToDoc(src.replace('luma(240)', 'red')).doc;
  check('a non-preset fill keeps the table as a raw island', other.child(0).type.name === 'code_block' && other.child(0).attrs.params === 'typst-raw', other.child(0).type.name);
}

// --- 19f. the citation style rides on the bibliography line ---
{
  const bib = JSON.stringify('@article{k, author = {Knuth, Donald E.}, title = {A}, year = {1981}}');
  const src = `A claim @k.\n\n#bibliography(bytes(${bib}), title: "References", style: "apa")\n`;
  const { doc } = typToDoc(src);
  check('style: "apa" imports as the citation style setting', doc.attrs.settings.citationStyle === 'apa', JSON.stringify(doc.attrs.settings.citationStyle));
  const out = docToTyp(doc);
  check('the style exports back on the bibliography line', out.includes('title: "References", style: "apa")'), out);
  check('a style round-trip is idempotent', docToTyp(typToDoc(out).doc) === out, firstDiff(docToTyp(typToDoc(out).doc), out));
  const unknown = typToDoc(src.replace('"apa"', '"mla"')).doc;
  check('an unported style falls back to the default', unknown.attrs.settings.citationStyle === 'ieee', JSON.stringify(unknown.attrs.settings.citationStyle));
}

// --- 20. raw islands: a multi-line call survives a blank line inside it ---
{
  // A grid in the rail's form is native (grid-editor.ts): fraction or
  // counted columns, one gutter, content cells — a blank line inside a
  // cell is a second paragraph there. Anything else stays an island.
  const src = 'Intro.\n\n#grid(\n  columns: 2,\n  [first para\n\n  second para],\n  [b],\n)\n\nAfter.\n';
  const { doc, warnings } = typToDoc(src);
  const kinds: string[] = [];
  doc.forEach((n) => kinds.push(n.type.name + (n.attrs.params === 'typst-raw' ? ':raw' : '')));
  check('a two-column grid is native', JSON.stringify(kinds) === JSON.stringify(['paragraph', 'grid', 'paragraph']), JSON.stringify(kinds));
  const g = doc.child(1);
  check('counted columns are equal shares, gutter absent is 0', JSON.stringify(g.attrs) === JSON.stringify({ columns: [1, 1], gutter: 0 }), JSON.stringify(g.attrs));
  check('a blank line inside a cell is a second paragraph', g.child(0).child(0).childCount === 2 && g.child(0).child(0).child(1).textContent === 'second para' && g.child(0).child(1).textContent === 'b', JSON.stringify(g.toJSON()));
  check('no warning for a native grid', warnings.length === 0, warnings.join('; '));
  const out = docToTyp(doc);
  check('the grid exports in the rail form', out.includes('#grid(\n  columns: (1fr, 1fr),\n  gutter: 0em,\n  [\n    first para\n\n    second para\n  ],\n  [\n    b\n  ],\n)\n\nAfter.'), out);
  const again = docToTyp(typToDoc(out).doc);
  check('grid round-trip is idempotent', out === again, firstDiff(out, again));
  {
    // Off the rail: auto columns → island, whole call kept.
    const raw = 'Intro.\n\n#grid(\n  columns: (auto, 1fr),\n  [first para\n\n  second para],\n  [b],\n)\n\nAfter.\n';
    const r = typToDoc(raw);
    const k: string[] = [];
    r.doc.forEach((n) => k.push(n.type.name + (n.attrs.params === 'typst-raw' ? ':raw' : '')));
    check('grid with auto columns is one island', JSON.stringify(k) === JSON.stringify(['paragraph', 'code_block:raw', 'paragraph']), JSON.stringify(k));
    check('island keeps the whole call', r.doc.child(1).textContent.endsWith('[b],\n)'), JSON.stringify(r.doc.child(1).textContent));
    check('one island warning only', r.warnings.length === 1, r.warnings.join('; '));
    const o = docToTyp(r.doc);
    check('multi-line island round-trip is idempotent', o === docToTyp(typToDoc(o).doc), firstDiff(o, docToTyp(typToDoc(o).doc)));
  }
  {
    // The rail's richer content: three fraction columns, two rows, a list
    // and a table in cells, a heading in a cell.
    const rich = [
      '#grid(',
      '  columns: (2fr, 1fr, 1fr),',
      '  gutter: 1.5em,',
      '  [',
      '    == Left',
      '',
      '    Text on the left.',
      '',
      '    - one',
      '    - two',
      '  ],',
      '  [',
      '    #table(',
      '      columns: 2,',
      '      [a], [b],',
      '    )',
      '  ],',
      '  [],',
      '  [',
      '    Second row.',
      '  ],',
      '  [],',
      '  [],',
      ')',
      '',
    ].join('\n');
    const r = typToDoc(rich);
    const grid = r.doc.child(0);
    const cellKinds = (row: number) => {
      const out: string[] = [];
      grid.child(row).forEach((cell) => out.push(cell.child(0).type.name + (cell.childCount > 1 ? '+' : '')));
      return out;
    };
    check('three columns, two rows', grid.type.name === 'grid' && grid.childCount === 2 && JSON.stringify(grid.attrs.columns) === '[2,1,1]' && grid.attrs.gutter === 1.5, JSON.stringify(grid.attrs) + ' rows ' + grid.childCount);
    check('cells hold headings, lists, tables, empties', JSON.stringify(cellKinds(0)) === JSON.stringify(['heading+', 'table', 'paragraph']) && JSON.stringify(cellKinds(1)) === JSON.stringify(['paragraph', 'paragraph', 'paragraph']), JSON.stringify([cellKinds(0), cellKinds(1)]));
    const o = docToTyp(r.doc);
    check('rich grid round-trips byte for byte', o === docToTyp(typToDoc(o).doc), firstDiff(o, docToTyp(typToDoc(o).doc)));
    check('rich grid keeps the table native inside the cell', o.includes('  [\n    #align(center, table(\n'), o);
  }
  // Islands never run: the file keeps the Typst verbatim, the print is a
  // raw block of the same source (Typst on rails).
  const island = schema.nodes.code_block.create({ params: 'typst-raw' }, [schema.text('#grid(columns: 2, [a `x`], [b])')]);
  const inline = schema.nodes.paragraph.create(null, [schema.text('Fill '), schema.nodes.typst_inline.create({ src: '#h(1fr)' }), schema.text(' here.')]);
  const solo = schema.nodes.doc.create(null, [island, inline]);
  const file = docToTyp(solo);
  const print = docToTyp(solo, { islands: 'print' });
  check('the file keeps the island verbatim', file.includes('\n#grid(columns: 2, [a `x`], [b])\n') && file.includes('Fill #h(1fr) here.'), file);
  check('the print shows the island as a raw block', print.includes('\n``\`\n#grid(columns: 2, [a `x`], [b])\n``\`\n') && (print.match(/^#grid/gm) ?? []).length === (print.match(/```\n#grid/g) ?? []).length, print);
  check('the print shows an inline island as inline raw', print.includes('Fill #raw("#h(1fr)") here.'), print);
}

{
  // A loose list in Typst markup (blank lines between items) imports with
  // its pitch, exports as the set/restore pair around blank-lined items,
  // and the pair is consumed on the way back in. A tight one is untouched.
  const src = 'Intro.\n\n- one\n\n- two\n\n+ a\n+ b\n\nAfter.\n';
  const { doc } = typToDoc(src);
  const kinds: string[] = [];
  doc.forEach((n) => kinds.push(n.type.name + (n.attrs.tight === false ? ':loose' : n.attrs.tight === true ? ':tight' : '')));
  check('blank-lined items are one loose list; consecutive items a tight one', JSON.stringify(kinds) === JSON.stringify(['paragraph', 'bullet_list:loose', 'ordered_list:tight', 'paragraph']), JSON.stringify(kinds));
  const out = docToTyp(doc);
  check('the loose list exports as a set/restore pair', /#set list\(spacing: [\d.]+pt\)\n- one\n\n- two\n#set list\(spacing: [\d.]+pt\)\n\n\+ a\n\+ b\n/.test(out), out);
  const again = docToTyp(typToDoc(out).doc);
  check('loose and tight lists round-trip byte for byte', out === again, firstDiff(out, again));
  const nested = 'Intro.\n\n- outer\n\n  - inner\n\n  - inner two\n\n- outer two\n';
  const nd = typToDoc(nested).doc;
  const outer = nd.child(1);
  check('a nested loose list keeps its own pitch', outer.attrs.tight === false && outer.child(0).child(1).attrs.tight === false && outer.childCount === 2, JSON.stringify([outer.attrs, outer.childCount, outer.child(0).child(1)?.attrs]));
  const nOut = docToTyp(nd);
  check('nested loose lists round-trip', nOut === docToTyp(typToDoc(nOut).doc), firstDiff(nOut, docToTyp(typToDoc(nOut).doc)));
}

{
  // Page chrome: a running header and footer with {page}/{section}, the
  // number at the top of the page, and the first-page flags round-trip
  // through the page line.
  const SECTION = '#context { let hs = query(selector(heading.where(level: 1)).before(here())); if hs.len() > 0 { hs.last().body } }';
  const PAGE = '#context counter(page).display()';
  const src =
    `#set page(paper: "us-letter", margin: 1in, numbering: "— 1 —", number-align: top + right, header: context if(counter(page).get().first() > 1) { align(left)[Notes · ${SECTION} · ${PAGE}] }, footer: align(center)[Econ 0100 · ${PAGE}])\n` +
    '#set text(font: "New Computer Modern", size: 12.5pt)\n\n= Title\n\nBody.\n';
  const { doc } = typToDoc(src);
  const s = doc.attrs.settings as Record<string, unknown>;
  check(
    'header, footer, and number placement import',
    s.headerText === 'Notes · {section} · {page}' && s.headerAlign === 'left' && s.headerFirstPage === false &&
      s.footerText === 'Econ 0100 · {page}' && s.footerAlign === 'center' && s.footerFirstPage === true &&
      s.pageNumPlace === 'top' && s.pageNumAlign === 'right' && s.pageNumFormat === '— 1 —',
    JSON.stringify(s),
  );
  const out = docToTyp(doc);
  check('the page line is written back the same', out.includes(src.split('\n')[0]), out.split('\n')[1]);
  check('chrome round-trips byte for byte', out === docToTyp(typToDoc(out).doc), firstDiff(out, docToTyp(typToDoc(out).doc)));
}

// The Skillsheet's measured table controls are editable attributes, with no
// hidden source override that could win against later toolbar edits.
{
  const source = '#table(columns: (auto, 1fr, auto), inset: 9pt, align: (center + horizon, left + horizon, center + horizon), fill: (x, y) => if y == 0 { luma(220) }, table.header([Code], [Skill], [Practice]), [B1.1], [Demand], [Exercise B1])';
  const { doc } = typToDoc(source);
  const table = doc.firstChild!;
  check('Skillsheet widths and padding are editable attributes', table.type.name === 'table' && JSON.stringify(table.attrs.columnWidths) === '["auto","1fr","auto"]' && table.attrs.insetPt === 9 && table.attrs.params === '', JSON.stringify(table.attrs));
  check('Skillsheet alignments import by axis', table.child(1).child(0).attrs.align === 'center' && table.child(1).child(1).attrs.align === 'left' && table.child(1).child(2).attrs.valign === 'middle');
  check('Skillsheet header fill becomes explicit cells only on first row', table.child(0).child(0).attrs.fill === 'gray-dark' && table.child(0).child(2).attrs.fill === 'gray-dark' && table.child(1).child(0).attrs.fill === '');
  const output = docToTyp(doc);
  check('Skillsheet emits real widths padding and vertical alignment', output.includes('columns: (auto, 1fr, auto)') && output.includes('inset: 9pt') && output.includes('align: (center + horizon, left + horizon, center + horizon)') && output.includes('table.cell(fill: luma(220))') && !output.includes('(x, y) =>'));
  check('Skillsheet controls round-trip stably', docToTyp(typToDoc(output).doc) === output);
  const fixed = typToDoc(source.replace('(auto, 1fr, auto)', '(24pt, 2fr, 0pt)')).doc.firstChild!;
  check('fixed point widths import without approximation', JSON.stringify(fixed.attrs.columnWidths) === '["24pt","2fr","0pt"]');
  for (const unsupported of ['columns: (auto, calc.max(1fr, 2fr), auto)', 'inset: (x: 9pt, y: 5pt)', 'align: (x, y) => center', 'fill: (x, y) => if calc.odd(y) { luma(220) }']) {
    const custom = typToDoc(`#table(columns: 3, ${unsupported}, [A], [B], [C])`).doc.firstChild!;
    check(`unknown table expression is preserved: ${unsupported}`, String(custom.attrs.params).includes(unsupported));
  }
  const hex = typToDoc('#table(columns: 1, table.cell(fill: rgb("#dcdcdc"))[A])').doc.firstChild!;
  check('equivalent gray hex imports into the verified palette', hex.firstChild!.firstChild!.attrs.fill === 'gray-dark');
}

// Existing sessions may still hold these supported properties in params.
// Migrate attributes only, preserving arbitrary cell content and source.
{
  const rich = schema.nodes.paragraph.create(null, [schema.text('Untouched *text* ', [schema.marks.strong.create()]), schema.nodes.math_inline.create({ src: 'x^2' })]);
  const cell = (attrs = {}) => schema.nodes.table_cell.create(attrs, rich);
  const unknown = '\n  stroke: 0.8pt + rgb("#123456"),\n  fill-extra: (x, y) => if calc.odd(y) { [Keep, exactly] }';
  const legacy = schema.nodes.table.create({ caption: 'Keep caption', params: 'columns: (auto, 1fr), inset: 9pt, align: (center + horizon, left + bottom), fill: (x, y) => if y == 0 { luma(220) },' + unknown }, [
    schema.nodes.table_row.create({ rule: 'heavy' }, [cell({ align: 'right', fill: 'blue' }), cell()]),
    schema.nodes.table_row.create(null, [cell(), cell({ valign: 'top' })]),
  ]);
  const grid = schema.nodes.grid.create({ columns: [1, 1] }, schema.nodes.grid_row.create(null, [schema.nodes.grid_cell.create(null, legacy), schema.nodes.grid_cell.create(null, rich)]));
  const original = schema.nodes.doc.create(null, [grid, rich]);
  const migrated = migrateLegacyTableGeometry(original);
  const table = migrated.firstChild!.firstChild!.firstChild!.firstChild!;
  check('session migration reaches tables in grid cells', JSON.stringify(table.attrs.columnWidths) === '["auto","1fr"]' && table.attrs.insetPt === 9 && table.attrs.caption === 'Keep caption');
  check('session migration preserves unknown params exactly', table.attrs.params === unknown, JSON.stringify(table.attrs.params));
  check('session migration preserves explicit cell overrides', table.child(0).child(0).attrs.align === 'right' && table.child(0).child(0).attrs.fill === 'blue' && table.child(1).child(1).attrs.valign === 'top');
  check('session migration applies inherited alignment and header shading', table.child(0).child(1).attrs.fill === 'gray-dark' && table.child(1).child(0).attrs.align === 'center' && table.child(1).child(0).attrs.valign === 'middle' && table.child(0).child(1).attrs.valign === 'bottom');
  check('session migration preserves text math marks and row attrs by identity', table.child(0).child(0).firstChild === rich && table.child(1).child(1).firstChild === rich && table.child(0).attrs.rule === 'heavy' && migrated.child(1) === rich);
  check('session migration is idempotent by identity', migrateLegacyTableGeometry(migrated) === migrated);
  const unsupported = schema.nodes.table.create({ params: 'columns: (calc.max(1fr, 2fr), auto), inset: (x: 9pt), align: (x, y) => right, fill: (x, y) => if y > 0 { luma(220) }' }, legacy.content);
  check('unsupported session expressions leave the original table untouched', migrateLegacyTableGeometry(unsupported) === unsupported);
  const wrongWidth = schema.nodes.table.create({ params: 'columns: (1fr, 1fr, 1fr)' }, legacy.content);
  check('session migration preserves mismatched legacy column counts', migrateLegacyTableGeometry(wrongWidth) === wrongWidth);
  check('a document without legacy params remains identical', migrateLegacyTableGeometry(schema.nodes.doc.create(null, rich)).firstChild === rich);
}

// Default alignment is distinct from explicitly choosing left/top. Source
// view must retain both axes exactly, regardless of which cell comes first.
{
  const states = [null, 'left', 'center', 'right'].flatMap((align) =>
    [null, 'top', 'middle', 'bottom'].map((valign) => ({ align, valign })),
  );
  const mismatches: string[] = [];
  for (const first of states) {
    for (const second of states) {
      const cells = [first, second].map((attrs, index) =>
        schema.nodes.table_cell.create(attrs, schema.nodes.paragraph.create(null, schema.text(String(index)))),
      );
      const table = schema.nodes.table.create(null, cells.map((cell) => schema.nodes.table_row.create(null, cell)));
      const roundTrip = typToDoc(docToTyp(schema.nodes.doc.create(null, table))).doc.firstChild!;
      if (JSON.stringify(roundTrip.toJSON()) !== JSON.stringify(table.toJSON())) {
        mismatches.push(`${JSON.stringify(first)} then ${JSON.stringify(second)}`);
      }
    }
  }
  check('every pair of default and explicit cell alignments retains exact JSON', !mismatches.length, mismatches.join('\n'));

  const cells = [
    { text: 'Default', attrs: {} },
    { text: 'Explicit left', attrs: { align: 'left' } },
    { text: 'Explicit top', attrs: { valign: 'top' } },
  ].map(({ text, attrs }) => schema.nodes.table_row.create(null,
    schema.nodes.table_cell.create(attrs, schema.nodes.paragraph.create(null, schema.text(text))),
  ));
  const source = docToTyp(schema.nodes.doc.create(null, schema.nodes.table.create(null, cells)));
  check('implicit defaults print left while explicit left and top stay distinguishable',
    source.includes('align: (left /* typeset:default */,)') &&
    source.includes('table.cell(align: left)[Explicit left]') &&
    source.includes('table.cell(align: left /* typeset:default */ + top)[Explicit top]') &&
    !source.includes('align: auto'), source);
}

// Logical columns must account for both kinds of span when deciding which
// alignment may be shared without changing another cell's attributes.
{
  const cell = (text: string, attrs = {}) => schema.nodes.table_cell.create(attrs, schema.nodes.paragraph.create(null, schema.text(text)));
  const row = (...cells: import('prosemirror-model').Node[]) => schema.nodes.table_row.create(null, cells);
  const table = schema.nodes.table.create(null, [
    row(cell('Spanning heading', { colspan: 2, align: 'center', valign: 'middle' }), cell('Third', { align: 'right', valign: 'top' })),
    row(cell('Spanning rows', { rowspan: 2, align: 'left', valign: 'bottom' }), cell('Default'), cell('Centered', { align: 'center' })),
    row(cell('Right middle', { align: 'right', valign: 'middle' }), cell('Top', { valign: 'top' })),
  ]);
  const roundTrip = typToDoc(docToTyp(schema.nodes.doc.create(null, table))).doc.firstChild!;
  check('spanned cells retain exact alignment JSON', JSON.stringify(roundTrip.toJSON()) === JSON.stringify(table.toJSON()), JSON.stringify(roundTrip.toJSON()));
}

// Decimal splitting must leave neighboring default columns and nullable
// vertical alignment unchanged when the sub-columns are fused on import.
{
  const cell = (text: string, attrs = {}, header = false) =>
    (header ? schema.nodes.table_header : schema.nodes.table_cell).create(attrs, schema.nodes.paragraph.create(null, schema.text(text)));
  const row = (...cells: import('prosemirror-model').Node[]) => schema.nodes.table_row.create(null, cells);
  const table = schema.nodes.table.create({ style: 'booktabs', columnWidths: ['auto', '1fr', 'auto'], insetPt: 9 }, [
    row(cell('Item', {}, true), cell('Value', { align: 'decimal' }, true), cell('Notes', {}, true)),
    ...[null, 'top', 'middle', 'bottom'].map((valign, index) =>
      row(cell(`Item ${index}`), cell(`${index + 1}.25`, { align: 'decimal', valign }), cell('Unaligned')),
    ),
  ]);
  const roundTrip = typToDoc(docToTyp(schema.nodes.doc.create(null, table))).doc.firstChild!;
  check('decimal columns preserve adjacent defaults and exact vertical attrs', JSON.stringify(roundTrip.toJSON()) === JSON.stringify(table.toJSON()), JSON.stringify(roundTrip.toJSON()));
}

// Image resizing survives save/reopen, including inside grid cells.
{
  const source = '#grid(columns: (1fr, 1fr), gutter: 1em, [\n#image("axes.svg", width: 75%)\n], [\n#figure(image("curve.svg", width: 100%), caption: [A curve]) <fig:curve>\n])';
  const { doc } = typToDoc(source);
  const row = doc.firstChild!.firstChild!;
  check('inline image width imports inside a grid', row.child(0).firstChild!.firstChild!.attrs.widthPct === 75);
  check('figure width imports without losing its label or caption', row.child(1).firstChild!.attrs.widthPct === 100 && row.child(1).firstChild!.attrs.label === 'fig:curve' && row.child(1).firstChild!.textContent === 'A curve');
  const output = docToTyp(doc);
  check('image width exports on the image call', output.includes('#image("axes.svg", width: 75%)') && output.includes('image("curve.svg", width: 100%)'));
  check('sized grid images round-trip stably', docToTyp(typToDoc(output).doc) === output);
  const inline = typToDoc('Before #image("axes.svg", width: 50%) after.').doc.firstChild!;
  check('width imports on images surrounded by prose', inline.child(1).type.name === 'image' && inline.child(1).attrs.widthPct === 50);
  for (const expr of ['12pt', 'calc.max(20%, 30%)', '120%']) {
    const source = `#image("axes.svg", width: ${expr})`;
    const parsed = typToDoc(source).doc;
    check(`unsupported image width stays verbatim: ${expr}`, parsed.firstChild!.type.name === 'code_block' && parsed.firstChild!.textContent === source);
  }
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall typ-parser tests passed');
}
