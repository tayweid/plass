// Round-trip and import tests for the .typ parser. Run: npm test
import { demoDoc } from './demo-doc.ts';
import { docToTyp } from './typ-serializer.ts';
import { typToDoc } from './typ-parser.ts';

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
  const t1 = docToTyp(demoDoc());
  const { doc, warnings } = typToDoc(t1);
  const t2 = docToTyp(doc);
  check('demo doc round-trips byte-identically', t1 === t2, firstDiff(t1, t2));
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
  check('custom params captured', /inset: 6pt/.test(tbl.attrs.params) && /fill: \(x, y\)/.test(tbl.attrs.params));
  check('fractional columns captured', /columns: \(2fr, 1fr, 1fr\)/.test(tbl.attrs.params));
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
    '// Exported from Typeset',
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

// --- 14. paragraph starting with list-like character survives ---
{
  const src = docToTyp(typToDoc('\\- not a list, just a dash').doc);
  check('leading-dash paragraph stays a paragraph', src.includes('\\- not a list'));
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall typ-parser tests passed');
}
