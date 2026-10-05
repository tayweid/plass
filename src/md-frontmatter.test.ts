// The YAML front matter of a Plass .md (md-frontmatter.ts): every document
// setting round-trips through pandoc's and Plass's keys, defaults write
// nothing, scalars are written with no backslash escaping (so LaTeX
// survives), YAML's own escapes are decoded as pandoc decodes them, unknown
// keys and comments are carried verbatim in order, anchors and aliases are
// written back as they are (never expanded), and out-of-range values are
// reported, not silently clamped.
// Run: npx tsx src/md-frontmatter.test.ts
import { readFrontmatter, writeFrontmatter, type FrontmatterFields } from './md-frontmatter';
import { DEFAULT_SETTINGS, normalizeSettings, type DocSettings } from './settings';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}
const json = (v: unknown) => JSON.stringify(v);
/** Read a YAML body (no delimiters) as a document's front matter. */
const read = (yaml: string) => readFrontmatter(`---\n${yaml}\n---\n\nBody.\n`);
/** write → read → write: the second write must equal the first. */
const fixedPoint = (fm: FrontmatterFields): boolean => {
  const w1 = writeFrontmatter(fm);
  const w2 = writeFrontmatter(readFrontmatter(w1 + '\n'));
  return w1 === w2;
};
const BS = '\\';

// --- 1. every DocSettings field round-trips ---
console.log('every setting:');
const SAMPLE: { [K in keyof DocSettings]: DocSettings[K] } = {
  font: 'Libertinus Serif',
  sizePt: 11,
  lineHeight: 1.25,
  page: 'a4',
  pageWidthIn: 6.25,
  pageHeightIn: 9.5,
  landscape: true,
  marginTop: 1,
  marginRight: 0.75,
  marginBottom: 0.5,
  marginLeft: 2,
  hyphenate: false,
  parIndent: true,
  numberEquations: false,
  numberSections: true,
  pageNumShow: false,
  pageNumFormat: '— 1 —',
  pageNumAlign: 'right',
  pageNumPlace: 'top',
  pageNumStart: 3,
  headerText: '{section}',
  headerAlign: 'left',
  headerFirstPage: true,
  footerText: 'Econ 0100 · {page}',
  footerAlign: 'right',
  footerFirstPage: false,
  mathMacros: `${BS}R = ${BS}mathbb{R}\n${BS}E = ${BS}operatorname{E}`,
  citationStyle: 'apa',
  footnoteNumbering: '*',
  footnoteSeparator: 'full',
};
check(
  'the sample covers every DocSettings field',
  json(Object.keys(SAMPLE).sort()) === json(Object.keys(DEFAULT_SETTINGS).sort()),
  json(Object.keys(DEFAULT_SETTINGS).filter((k) => !(k in SAMPLE))),
);
for (const field of Object.keys(SAMPLE) as Array<keyof DocSettings>) {
  check(`${field}: the sample is not the default`, SAMPLE[field] !== DEFAULT_SETTINGS[field]);
  // The custom paper size only means something on a custom page.
  const custom = field === 'pageWidthIn' || field === 'pageHeightIn';
  const settings = { ...DEFAULT_SETTINGS, ...(custom ? { page: 'custom' as const } : {}), [field]: SAMPLE[field] };
  const written = writeFrontmatter({ settings });
  const back = readFrontmatter(written + '\n');
  const got = normalizeSettings(back.settings);
  check(
    `${field} round-trips`,
    json(got) === json(normalizeSettings(settings)) && back.warnings.length === 0,
    `${written} → ${json(back.settings)} ${json(back.warnings)}`,
  );
}
{
  const all = { ...SAMPLE, page: 'custom' as const };
  const written = writeFrontmatter({ settings: all, frontMatterRestart: true });
  const back = readFrontmatter(written + '\n');
  check('all settings at once round-trip', json(normalizeSettings(back.settings)) === json(normalizeSettings(all)) && back.frontMatterRestart, json(back.settings));
  // The plan's fixed order: pandoc's keys, then plass's.
  const golden = [
    '---',
    'margin: {top: 1in, right: 0.75in, bottom: 0.5in, left: 2in}',
    'fontsize: 11pt',
    'mainfont: Libertinus Serif',
    "section-numbering: '1.1'",
    'linestretch: 1.25',
    'indent: true',
    'bibliographystyle: apa',
    'plass:',
    '  page: {width: 6.25in, height: 9.5in}',
    '  landscape: true',
    '  hyphenate: false',
    '  number-equations: false',
    '  page-numbers: {show: false, format: — 1 —, align: right, place: top, start: 3, front-matter: roman}',
    "  header: {text: '{section}', align: left, first-page: true}",
    "  footer: {text: 'Econ 0100 · {page}', align: right, first-page: false}",
    "  footnotes: {numbering: '*', separator: full}",
    '  math-macros: |',
    `    ${BS}R = ${BS}mathbb{R}`,
    `    ${BS}E = ${BS}operatorname{E}`,
    '---',
  ].join('\n');
  check('the written order and forms are the plan’s', written === golden, '\n' + written);
  check('every setting at once is a fixed point', fixedPoint({ settings: all, frontMatterRestart: true }));
}
for (const page of ['letter', 'a4', 'legal', 'b5', 'a5', 'half-letter'] as const) {
  const back = readFrontmatter(writeFrontmatter({ settings: { ...DEFAULT_SETTINGS, page } }) + '\n');
  check(`paper ${page} round-trips`, normalizeSettings(back.settings).page === page, json(back.settings));
}

// --- 2. defaults write nothing ---
console.log('defaults:');
check('no fields write nothing', writeFrontmatter({}) === '');
check('the default settings write nothing', writeFrontmatter({ settings: DEFAULT_SETTINGS, frontMatterRestart: false, extra: '' }) === '');
check('a page-number setting writes only the field that differs', writeFrontmatter({ settings: { pageNumStart: 5 } }) === '---\nplass:\n  page-numbers: {start: 5}\n---');
check(
  'half letter writes no papersize',
  writeFrontmatter({ settings: { page: 'half-letter' } }) === '---\nplass:\n  page: half-letter\n---',
  writeFrontmatter({ settings: { page: 'half-letter' } }),
);
check('a4 writes papersize and no plass page', writeFrontmatter({ settings: { page: 'a4' } }) === '---\npapersize: a4\n---');
check('letter is the default and writes nothing', writeFrontmatter({ settings: { page: 'letter' } }) === '');
check(
  'the front-matter restart alone writes one page-numbers key',
  writeFrontmatter({ frontMatterRestart: true }) === '---\nplass:\n  page-numbers: {front-matter: roman}\n---',
  writeFrontmatter({ frontMatterRestart: true }),
);
check('a restart reads back', readFrontmatter(writeFrontmatter({ frontMatterRestart: true }) + '\n').frontMatterRestart === true);

// --- 3. margins and units ---
console.log('margins and units:');
{
  const r = read('margin: 1in');
  check('a scalar margin sets all four sides', json([r.settings.marginTop, r.settings.marginRight, r.settings.marginBottom, r.settings.marginLeft]) === json([1, 1, 1, 1]), json(r.settings));
  const mm = read('margin: 25.4mm\nfontsize: 0.5cm');
  check('mm and cm convert', mm.settings.marginLeft === 1 && Math.abs((mm.settings.sizePt ?? 0) - (0.5 / 2.54) * 72) < 1e-9, json(mm.settings));
  const xy = read('margin: {x: 1in, y: 72pt, left: 2in}');
  check('a dict reads x, y and a side over them', json([xy.settings.marginTop, xy.settings.marginRight, xy.settings.marginBottom, xy.settings.marginLeft]) === json([1, 1, 1, 2]), json(xy.settings));
  const block = read('margin:\n  top: 0.5in\n  bottom: 0.75in');
  check('a block-map margin reads', block.settings.marginTop === 0.5 && block.settings.marginBottom === 0.75 && block.settings.marginLeft === undefined, json(block.settings));
  check('a margin is written as the dict', writeFrontmatter({ settings: { marginTop: 2 } }) === '---\nmargin: {top: 2in, right: 1.25in, bottom: 1.25in, left: 1.25in}\n---');
  const bare = read('fontsize: 12');
  check('a length with no unit warns and is ignored', bare.settings.sizePt === undefined && /needs a unit/.test(bare.warnings[0] ?? ''), json(bare.warnings));
}

// --- 4. title, author, date, abstract: raw Markdown ---
console.log('text fields:');
{
  const r = read('title: The *first* $x^2$ [@key]\nauthor: Taylor J. Weidman\ndate: 2026-10-04');
  check('title is raw Markdown', r.titleMd === 'The *first* $x^2$ [@key]', json(r.titleMd));
  check('a date is text', r.dateMd === '2026-10-04');
  check('nothing absent is invented', r.abstractMd === null && r.bibliography === undefined && r.extra === '' && r.warnings.length === 0);
  for (const [name, yaml] of [
    ['a block list', 'author:\n  - Ada Lovelace\n  - Charles Babbage'],
    ['a compact list', 'author:\n- Ada Lovelace\n- Charles Babbage'],
    ['a flow list', 'author: [Ada Lovelace, "Charles Babbage"]'],
  ] as const) {
    const a = read(yaml);
    check(`an author list (${name}) is joined with ", "`, a.authorsMd === 'Ada Lovelace, Charles Babbage' && a.warnings.length === 0, json(a));
  }
  const maps = read('author:\n  - name: Ada Lovelace\n    affiliation: Analytical\n  - Charles Babbage');
  check('author maps give their names, with a warning', maps.authorsMd === 'Ada Lovelace, Charles Babbage' && maps.warnings.length === 1, json(maps));
  check('an author list is written back as one string', writeFrontmatter(maps) === '---\nauthor: Ada Lovelace, Charles Babbage\n---');
  const apostrophe = read(`author: Taylor's -- draft`);
  check('an apostrophe and -- are left for the body reader', apostrophe.authorsMd === `Taylor's -- draft`);
  const multi = read('title: A long title\n  continued here\n\n  and a new line');
  check('a multi-line plain title folds as YAML does', multi.titleMd === 'A long title continued here\nand a new line', json(multi.titleMd));
  const quotedMulti = read('title: "A long\n  quoted title"');
  check('a multi-line quoted title folds', quotedMulti.titleMd === 'A long quoted title', json(quotedMulti.titleMd));
  const empty = read("title: ''\ndate:");
  check('an empty title is "" and an empty date is absent', empty.titleMd === '' && empty.dateMd === null, json(empty));
  check("an empty title is written as ''", writeFrontmatter({ titleMd: '' }) === "---\ntitle: ''\n---");
}

// --- 5. scalars: escapes and the no-escape writer ---
console.log('scalars:');
{
  const dq = read('title: "She said \\"hi\\" \\\\ left"');
  check('\\" and \\\\ in a double-quoted scalar decode', dq.titleMd === 'She said "hi" \\ left' && dq.warnings.length === 0, json(dq));
  const w = writeFrontmatter(dq);
  check('… and are written back with no backslash escaping', w === '---\ntitle: She said "hi" \\ left\n---', w);
  check('… and re-read to the identical bytes', readFrontmatter(w + '\n').titleMd === dq.titleMd);
  check('… and the written form is a fixed point', fixedPoint(dq));
  const lead = read('title: "\\"Quoted\\" title"');
  check('a value opening with a quote is single-quoted', writeFrontmatter(lead) === `---\ntitle: '"Quoted" title'\n---`, writeFrontmatter(lead));

  const latex = `Effect of $${BS}beta$ on $${BS}frac{a}{b}$ and ${BS}$5`;
  const wl = writeFrontmatter({ titleMd: latex });
  check('a scalar holding \\beta is written as is', wl === `---\ntitle: ${latex}\n---`, wl);
  check('… and survives the round trip', readFrontmatter(wl + '\n').titleMd === latex);
  check('\\beta in a single-quoted scalar is kept', read(`title: 'Effect of $${BS}beta$'`).titleMd === `Effect of $${BS}beta$`);
  check('\\\\beta in double quotes decodes to \\beta', read(`title: "Effect of $${BS}${BS}beta$"`).titleMd === `Effect of $${BS}beta$`);

  // YAML (and pandoc) read "\b" in double quotes as a backspace: Plass reads
  // it the same way, and says why the title looks wrong.
  const trap = read(`title: "Effect of $${BS}beta$"`);
  check('"$\\beta$" decodes as pandoc decodes it', trap.titleMd === `Effect of $${String.fromCharCode(8)}eta$`, json(trap.titleMd));
  check('… with a warning that names \\beta', trap.warnings.length === 1 && trap.warnings[0].includes(`${BS}beta`), json(trap.warnings));
  const unknown = read(`title: "Effect of $${BS}gamma$"`);
  check('an unknown escape (\\g, pandoc rejects the file) keeps the backslash', unknown.titleMd === `Effect of $${BS}gamma$` && unknown.warnings.length === 1, json(unknown));
  check('… and is written in a form pandoc reads', writeFrontmatter(unknown) === `---\ntitle: Effect of $${BS}gamma$\n---`);
  check('\\u, \\x and \\U escapes decode', read('title: "\\u00e9\\x41\\U0001F600"').titleMd === 'éA' + String.fromCodePoint(0x1f600));

  // Values YAML would not read back as the same string are quoted.
  for (const v of ['true', 'no', '1.5', '12', '0x1F', 'null', '~', '- x', '#x', 'a: b', 'a #b', '@key', '`code`', "'q'", '"q"', ' lead', 'trail ', '*emph*', '{section}', '[x]', '| bar', '> quote', '%x', '---', '...']) {
    const wv = writeFrontmatter({ titleMd: v });
    const back = readFrontmatter(wv + '\n');
    check(`${json(v)} is quoted and round-trips`, wv.startsWith("---\ntitle: '") && back.titleMd === v && back.warnings.length === 0, wv);
  }
  for (const v of ['2026-10-04', 'Vignette B3 | Solutions', 'C# and F#', 'http://example.com', 'Taylor’s notes', 'a:b', 'O’Brien — “quoted”']) {
    const wv = writeFrontmatter({ titleMd: v });
    check(`${json(v)} is written plain`, wv === `---\ntitle: ${v}\n---` && readFrontmatter(wv + '\n').titleMd === v, wv);
  }
  const nl = 'Line one' + String.fromCharCode(10) + 'Line two';
  const wnl = writeFrontmatter({ titleMd: 'x', settings: { headerText: nl } });
  check('a value with a line break is double-quoted with \\u escapes only', wnl.includes(`text: "Line one${BS}u000aLine two"`) && readFrontmatter(wnl + '\n').settings.headerText === nl, wnl);
}

// --- 6. {section} and {page} ---
console.log('running texts:');
{
  const w = writeFrontmatter({ settings: { headerText: '{section}', footerText: 'p. {page} of notes' } });
  check('{section} is quoted', w.includes("header: {text: '{section}'}"), w);
  check('a footer with {page} is quoted', w.includes("footer: {text: 'p. {page} of notes'}"), w);
  const back = readFrontmatter(w + '\n');
  check('both read back', back.settings.headerText === '{section}' && back.settings.footerText === 'p. {page} of notes', json(back.settings));
  const colon = writeFrontmatter({ settings: { headerText: 'Ch. 1:2' } });
  check('a colon in a flow value is quoted (pandoc rejects it plain)', colon.includes("header: {text: 'Ch. 1:2'}"), colon);
  const unquoted = read('plass:\n  header: {text: {section}}');
  check('an unquoted {section} is a map: warned and ignored', unquoted.settings.headerText === undefined && /plass\.header\.text: expected text/.test(unquoted.warnings[0] ?? ''), json(unquoted.warnings));
  const block = read('plass:\n  header:\n    text: "{section}"\n    align: left');
  check('a block-map header reads', block.settings.headerText === '{section}' && block.settings.headerAlign === 'left', json(block.settings));
}

// --- 7. unknown keys and comments survive in order ---
console.log('unknown keys and comments:');
{
  const yaml = [
    '# Course metadata',
    'stem: "demo-z-potions-trade"',
    'title: Potions',
    'skill: "A3.1"   # the skill code',
    '',
    '# Sources',
    'sources:',
    '  - 24F Demos/Demo_Z.pdf',
    '  - "Q1"',
    'papersize: a4',
    'note: |',
    '  first line',
    '',
    '  after a blank line',
    'plass:',
    '  # page setup',
    '  landscape: true',
    '  future-key: {a: 1}',
    'lang: en-US',
  ].join('\n');
  const r = read(yaml);
  const extra = [
    '# Course metadata',
    'stem: "demo-z-potions-trade"',
    'skill: "A3.1"   # the skill code',
    '',
    '# Sources',
    'sources:',
    '  - 24F Demos/Demo_Z.pdf',
    '  - "Q1"',
    'note: |',
    '  first line',
    '',
    '  after a blank line',
    'plass:',
    '  # page setup',
    '  future-key: {a: 1}',
    'lang: en-US',
  ].join('\n');
  check('unknown keys and comments are kept verbatim, in order', r.extra === extra, '\n' + r.extra);
  check('known keys among them are read', r.titleMd === 'Potions' && r.settings.page === 'a4' && r.settings.landscape === true, json(r));
  check('an unknown plass key warns', r.warnings.length === 1 && r.warnings[0].includes('plass.future-key'), json(r.warnings));
  const w = writeFrontmatter(r);
  const expected = [
    '---',
    'title: Potions',
    'papersize: a4',
    'plass:',
    '  landscape: true',
    '  # page setup',
    '  future-key: {a: 1}',
    '# Course metadata',
    'stem: "demo-z-potions-trade"',
    'skill: "A3.1"   # the skill code',
    '',
    '# Sources',
    'sources:',
    '  - 24F Demos/Demo_Z.pdf',
    '  - "Q1"',
    'note: |',
    '  first line',
    '',
    '  after a blank line',
    'lang: en-US',
    '---',
  ].join('\n');
  check('known keys are written first, then the kept ones', w === expected, '\n' + w);
  check('the kept front matter is a fixed point', fixedPoint(r));

  // A course file (every key unknown) comes back byte for byte.
  const course = [
    '---',
    'stem: "government-cheese"',
    'skill: "C1.2"',
    'origin: "demo"',
    "note: \"real-world scenario; source has 'purchases', kept as written\"",
    '---',
  ].join('\n');
  check('a front matter of unknown keys is written back byte for byte', writeFrontmatter(readFrontmatter(course + '\n\n# Title\n')) === course);

  const flowPlass = read('plass: {landscape: true, future: [1, two], hyphenate: false}');
  check('a flow plass map keeps its unknown child', flowPlass.extra === 'plass:\n  future: [1, two]' && flowPlass.settings.hyphenate === false, json(flowPlass));
  check('… inside the written plass block', writeFrontmatter(flowPlass) === '---\nplass:\n  landscape: true\n  hyphenate: false\n  future: [1, two]\n---', writeFrontmatter(flowPlass));
  const deep = read('plass:\n    landscape: true\n    # deep comment\n    other: x');
  check('plass children at any indent are re-indented to two spaces', deep.extra === 'plass:\n  # deep comment\n  other: x', json(deep.extra));

  const oldWarnings: string[] = [];
  const old = writeFrontmatter({ titleMd: 'New', extra: 'title: "Old"\nfoo: 1' }, (m) => oldWarnings.push(m));
  check('an extra key the document writes is replaced, with a warning', old === '---\ntitle: New\nfoo: 1\n---' && oldWarnings.length === 1, old);
  const kept = writeFrontmatter({ extra: 'author:\n  - A\n  - B' });
  check('an extra known key the document does not write is kept', kept === '---\nauthor:\n  - A\n  - B\n---');
  const delimWarnings: string[] = [];
  const delim = writeFrontmatter({ extra: 'foo: 1\n---\nbar: 2\n...' }, (m) => delimWarnings.push(m));
  check('a --- or ... line in extra is dropped, never ending the block early', delim === '---\nfoo: 1\nbar: 2\n---' && delimWarnings.length === 2, delim);
}

// --- 8. out-of-range and invalid values warn ---
console.log('invalid values:');
for (const [yaml, field] of [
  ['fontsize: 200pt', 'sizePt'],
  ['linestretch: 9', 'lineHeight'],
  ['margin: 5in', 'marginTop'],
  ['papersize: tabloid', 'page'],
  ['bibliographystyle: mla', 'citationStyle'],
  ['indent: yes', 'parIndent'],
  ['plass:\n  landscape: maybe', 'landscape'],
  ['plass:\n  page-numbers: {start: 0}', 'pageNumStart'],
  ['plass:\n  page-numbers: {format: "1."}', 'pageNumFormat'],
  ['plass:\n  page: {width: 1in, height: 9in}', 'pageWidthIn'],
  ['plass:\n  footnotes: {numbering: "A"}', 'footnoteNumbering'],
  ['plass:\n  header: {align: middle}', 'headerAlign'],
  [`mainfont: "bad${BS}u0007font"`, 'font'],
] as const) {
  const r = read(yaml);
  check(`${json(yaml)} warns and keeps the default`, r.warnings.length >= 1 && r.settings[field] === undefined, `${json(r.settings)} ${json(r.warnings)}`);
}
{
  const r = read('fontsize: 200pt');
  check('the warning names the key, the value and the default', r.warnings[0] === 'fontsize: 200pt is out of range — the default 12.5pt is kept', r.warnings[0]);
  const partial = read('plass:\n  page-numbers: {show: false, align: middle, start: 4}');
  check('one bad field leaves its siblings', partial.settings.pageNumShow === false && partial.settings.pageNumStart === 4 && partial.settings.pageNumAlign === undefined, json(partial.settings));
  const unknownSub = read('plass:\n  footnotes: {numbering: a, colour: red}');
  check('an unknown field of a known map warns', unknownSub.settings.footnoteNumbering === 'a' && unknownSub.warnings.length === 1, json(unknownSub.warnings));
  const sec = read('section-numbering: "1.a"');
  check('a section-numbering pattern other than 1.1 numbers sections, with a warning', sec.settings.numberSections === true && sec.warnings.length === 1, json(sec));
  check('section-numbering: false is off', read('section-numbering: false').settings.numberSections === false);
  const both = read('papersize: a4\nplass:\n  page: half-letter');
  check('plass.page wins over papersize, with a warning', both.settings.page === 'half-letter' && both.warnings.length === 1, json(both));
}

// --- 9. block scalars ---
console.log('block scalars:');
{
  const abs = read('abstract: |\n  First paragraph with $' + BS + 'beta$\n  and a wrapped line.\n\n\n  Second *paragraph* [@key].\n\ntitle: T');
  check('an abstract block keeps its blank lines', abs.abstractMd === `First paragraph with $${BS}beta$\nand a wrapped line.\n\n\nSecond *paragraph* [@key].`, json(abs.abstractMd));
  const w = writeFrontmatter({ abstractMd: abs.abstractMd });
  check('an abstract is written as a literal block', w === `---\nabstract: |\n  First paragraph with $${BS}beta$\n  and a wrapped line.\n\n\n  Second *paragraph* [@key].\n---`, w);
  check('… and round-trips exactly', readFrontmatter(w + '\n').abstractMd === abs.abstractMd);
  check('a one-line abstract is still a block', writeFrontmatter({ abstractMd: 'Short.' }) === '---\nabstract: |\n  Short.\n---');
  check('a folded block folds', read('abstract: >\n  one\n  two\n\n  three\n').abstractMd === 'one two\nthree', json(read('abstract: >\n  one\n  two\n\n  three\n').abstractMd));
  check('strip chomping', read('title: |-\n  T\n').titleMd === 'T');
  check('an indentation indicator', read('abstract: |2\n    indented first\n  base').abstractMd === '  indented first\nbase', json(read('abstract: |2\n    indented first\n  base').abstractMd));
  const indented = writeFrontmatter({ abstractMd: '    code first\nthen text' });
  check('a first line with leading spaces gets an indicator', indented === '---\nabstract: |2\n      code first\n  then text\n---' && readFrontmatter(indented + '\n').abstractMd === '    code first\nthen text', indented);
  const macros = read('plass:\n  math-macros: |\n    ' + BS + 'R = ' + BS + 'mathbb{R}\n\n    ' + BS + 'N = ' + BS + 'mathbb{N}\n  hyphenate: false');
  check('math macros with a blank line read', macros.settings.mathMacros === `${BS}R = ${BS}mathbb{R}\n\n${BS}N = ${BS}mathbb{N}` && macros.settings.hyphenate === false, json(macros.settings));
  check('… and round-trip', fixedPoint({ settings: macros.settings }) && normalizeSettings(readFrontmatter(writeFrontmatter({ settings: macros.settings }) + '\n').settings).mathMacros === macros.settings.mathMacros);
  check('a one-line macro is a block too', writeFrontmatter({ settings: { mathMacros: `${BS}R = ${BS}mathbb{R}` } }) === `---\nplass:\n  math-macros: |\n    ${BS}R = ${BS}mathbb{R}\n---`);
}

// --- 10. the plan's example front matter ---
console.log('the plan’s example:');
{
  const example = [
    '---',
    'title: "Vignette B3 | Solutions"',
    'author: "Taylor J. Weidman"     # a YAML list is read too',
    'date: 2026-10-04',
    'abstract: |',
    `  Parsed as Markdown on both sides: $${BS}beta$, *emphasis*, [@key] all work.`,
    '',
    '  Paragraphs are separated by a blank line.',
    'margin: {top: 1in, right: 1in, bottom: 1in, left: 1in}   # written as the dict',
    'fontsize: 12.5pt',
    'mainfont: New Computer Modern',
    'section-numbering: "1.1"        # present = numberSections',
    'bibliography: references.bib    # read once from a sidecar',
    'linestretch: 1.5',
    'indent: true',
    'bibliographystyle: ieee',
    'plass:                          # only non-default values are written',
    '  page: half-letter             # or {width: 5.5in, height: 8.5in}',
    '  landscape: true',
    '  hyphenate: false',
    '  number-equations: false',
    '  page-numbers: {show: true, format: "1", align: center, place: bottom, start: 1, front-matter: roman}',
    '  header: {text: "{section}", align: right, first-page: false}',
    '  footer: {text: "Econ 0100 · {page}", align: center, first-page: true}',
    '  footnotes: {numbering: "1", separator: rule}',
    '  math-macros: |',
    `    ${BS}R = ${BS}mathbb{R}`,
    '...',
    '',
    '# Body',
  ].join('\n');
  const r = readFrontmatter(example);
  check('no warnings', r.warnings.length === 0, json(r.warnings));
  check('title, author and date', r.titleMd === 'Vignette B3 | Solutions' && r.authorsMd === 'Taylor J. Weidman' && r.dateMd === '2026-10-04');
  check('the abstract', r.abstractMd === `Parsed as Markdown on both sides: $${BS}beta$, *emphasis*, [@key] all work.\n\nParagraphs are separated by a blank line.`, json(r.abstractMd));
  check('the bibliography path', r.bibliography === 'references.bib');
  check('the restart', r.frontMatterRestart === true);
  check('the body after the ... closer', r.body === '\n# Body', json(r.body));
  const s = normalizeSettings(r.settings);
  check(
    'the settings',
    s.page === 'half-letter' && s.marginLeft === 1 && s.numberSections && s.parIndent && s.landscape && !s.hyphenate && !s.numberEquations &&
      s.headerText === '{section}' && s.footerText === 'Econ 0100 · {page}' && s.mathMacros === `${BS}R = ${BS}mathbb{R}`,
    json(r.settings),
  );
  const w = writeFrontmatter(r);
  check('bibliography: is never written', !/bibliography/.test(w), w);
  check('defaults among the given values are not written', !/fontsize|linestretch|mainfont|bibliographystyle|footnotes/.test(w), w);
  check('the example is a fixed point after one write', fixedPoint(r));
  // Comments beside known keys are carried, in order, as whole lines.
  const carried = [
    '# a YAML list is read too',
    '# written as the dict',
    '# present = numberSections',
    '# read once from a sidecar',
    'plass:',
    '  # only non-default values are written',
    '  # or {width: 5.5in, height: 8.5in}',
  ].join('\n');
  check('comments beside known keys are carried in order', r.extra === carried, json(r.extra));
  check('… and written after the known keys', w.endsWith('  # or {width: 5.5in, height: 8.5in}\n# a YAML list is read too\n# written as the dict\n# present = numberSections\n# read once from a sidecar\n---'), w);
  const list = read('bibliography:\n  - a.bib\n  - b.bib');
  check('a bibliography list reads its first file, with a warning', list.bibliography === 'a.bib' && list.warnings.length === 1);
  const bibWarnings: string[] = [];
  const fromExtra = writeFrontmatter({ extra: 'bibliography: refs.bib\nfoo: 1' }, (m) => bibWarnings.push(m));
  check('a bibliography: carried in extra is not written either', fromExtra === '---\nfoo: 1\n---' && bibWarnings.length === 1, fromExtra);
}

// --- 11. finding the block ---
console.log('the block:');
{
  const plain = '# Title\n\nText.\n';
  const none = readFrontmatter(plain);
  check('no front matter: the body is the input', none.body === plain && none.extra === '' && none.titleMd === null);
  const rule = '---\n\ntitle: x\n---\n';
  check('a --- followed by a blank line is a rule, not metadata', readFrontmatter(rule).body === rule && readFrontmatter(rule).titleMd === null);
  check('an unclosed block is not metadata', readFrontmatter('---\ntitle: x\n\nText').titleMd === null);
  const crlf = readFrontmatter('---\r\ntitle: Win\r\n---\r\nBody\r\n');
  check('CRLF line ends', crlf.titleMd === 'Win' && crlf.body === 'Body\n', json(crlf));
  const bom = readFrontmatter(String.fromCharCode(0xfeff) + '---\ntitle: B\n---\n');
  check('a byte-order mark', bom.titleMd === 'B' && bom.body === '');
  check('closing --- with trailing spaces, at the end of the file', readFrontmatter('---\ntitle: E\n---   ').titleMd === 'E');
  check('an empty block', readFrontmatter('---\n---\nBody').body === 'Body');
}

// --- 12. YAML pandoc rejects, read for its intent ---
console.log('lenient reading:');
{
  const colon = read('title: Chapter 1: Intro');
  check('an unquoted ": " reads as text, with a warning', colon.titleMd === 'Chapter 1: Intro' && colon.warnings.length === 1, json(colon));
  check('… and is written quoted', writeFrontmatter(colon) === "---\ntitle: 'Chapter 1: Intro'\n---" && readFrontmatter(writeFrontmatter(colon) + '\n').warnings.length === 0);
  const star = read('title: *Emphasis* matters');
  check('a leading * (a YAML alias) reads as text, with a warning', star.titleMd === '*Emphasis* matters' && star.warnings.length === 1, json(star));
  check('… and is written quoted', writeFrontmatter(star) === "---\ntitle: '*Emphasis* matters'\n---");
  const comment = read('title: Notes #3');
  check('" #" starts a comment, as in YAML', comment.titleMd === 'Notes');
  // Pandoc reads past an anchor or a tag (verified on 3.4): so does Plass.
  for (const [yaml, want] of [
    ['title: !important note', 'note'],
    ['title: !!str 123', '123'],
    ['title: &a\n  long text', 'long text'],
    ['title: !x "quoted"', 'quoted'],
  ] as const) {
    const r = read(yaml);
    check(`${json(yaml)} reads ${json(want)}, as pandoc does`, r.titleMd === want && r.warnings.length === 1, json(r));
  }
  const tagged = read('plass:\n  header: !!map {text: !t, align: !t left}');
  check('properties inside a flow map are skipped too', tagged.settings.headerAlign === 'left' && tagged.warnings.length === 3, json(tagged));
  const bare = read('title: & more');
  check('a bare & (pandoc rejects it) reads as text, with a warning', bare.titleMd === '& more' && bare.warnings.length === 1, json(bare));
}

// --- 13. YAML the subset cannot read is kept as written ---
console.log('unreadable entries:');
{
  const bad = read('title: "unclosed\nfoo: 1');
  check('an unclosed quote is kept verbatim with a warning', bad.titleMd === null && bad.extra === 'title: "unclosed\nfoo: 1' && bad.warnings.length === 1, json(bad));
  const replaced: string[] = [];
  check('… and replaced when the document has a title', writeFrontmatter({ ...bad, titleMd: 'Fixed' }, (m) => replaced.push(m)) === '---\ntitle: Fixed\nfoo: 1\n---' && replaced.length === 1);
  check('… and kept when it does not', writeFrontmatter(bad) === '---\ntitle: "unclosed\nfoo: 1\n---');
  const shape = read('title:\n  a: 1');
  check('a title that is a map is kept verbatim', shape.titleMd === null && shape.extra === 'title:\n  a: 1' && shape.warnings.length === 1, json(shape));
  const badChild = read('plass:\n  landscape: true\n  header: {text: "x"\n  hyphenate: false');
  check('an unreadable plass child is kept, its siblings read', badChild.settings.landscape === true && badChild.settings.hyphenate === false && badChild.extra === 'plass:\n  header: {text: "x"' && badChild.warnings.length === 1, json(badChild));
  const twice = read('title: First\ntitle: Second');
  check('a key given twice: the last is read, with a warning (as pandoc)', twice.titleMd === 'Second' && twice.warnings.length === 1 && twice.extra === '', json(twice));
  const stray = read('  indented: x\ntitle: T');
  check('a stray line is kept with a warning', stray.titleMd === 'T' && stray.extra === '  indented: x' && stray.warnings.length === 1, json(stray));
  check('… written before the known keys, where it was read', writeFrontmatter(stray) === '---\n  indented: x\ntitle: T\n---' && fixedPoint(stray), writeFrontmatter(stray));
  const deep = read('title: ' + '['.repeat(5000) + ']'.repeat(5000));
  check('nesting deeper than the cap is kept as written, not a crash', deep.titleMd === null && deep.warnings.length === 1 && /nested/.test(deep.warnings[0]), json(deep.warnings));
}

// --- 14. comments are not content: inside and beside known keys ---
console.log('comments in known keys:');
{
  // A comment at the margin between items of a known key's value does not end it (pandoc reads past it).
  const author = read('author:\n  - Ada\n# - Removed\n  - Charles\ndate: 2026-10-04');
  check('a margin comment inside an author list', author.authorsMd === 'Ada, Charles' && author.dateMd === '2026-10-04' && author.warnings.length === 0, json(author));
  check('… is carried, and written where it cannot join a key', writeFrontmatter(author) === '---\nauthor: Ada, Charles\ndate: 2026-10-04\n# - Removed\n---', writeFrontmatter(author));
  const margin = read('title: T\nmargin:\n  top: 2in\n# c\n  bottom: 1in');
  check('a margin comment inside a margin map', margin.settings.marginTop === 2 && margin.settings.marginBottom === 1 && margin.warnings.length === 0, json(margin));
  check('… written as the dict, the comment after it', writeFrontmatter(margin) === '---\ntitle: T\nmargin: {top: 2in, right: 1.25in, bottom: 1in, left: 1.25in}\n# c\n---', writeFrontmatter(margin));
  const plassFirst = read('title: Notes\nplass:\n# page setup\n  landscape: true');
  check('a margin comment as the first line under plass:', plassFirst.settings.landscape === true && plassFirst.warnings.length === 0, json(plassFirst));
  check('… stays in the plass block', writeFrontmatter(plassFirst) === '---\ntitle: Notes\nplass:\n  landscape: true\n  # page setup\n---', writeFrontmatter(plassFirst));
  const compact = read('author:\n- Ada\n# - Removed\n- Charles');
  check('a margin comment inside a compact list', compact.authorsMd === 'Ada, Charles' && compact.extra === '# - Removed', json(compact));

  // Indented comments inside a known key's value move out of it, in order.
  const inMargin = read('margin:\n  # top is wider for binding\n  top: 2in\n  bottom: 1in');
  check('a comment inside a margin block is carried', inMargin.settings.marginTop === 2 && inMargin.extra === '# top is wider for binding', json(inMargin));
  const inAuthor = read('author:\n  # lead author\n  - Ada\n  # - Removed Person\n  - Charles');
  check('comments inside an author list are carried in order', inAuthor.authorsMd === 'Ada, Charles' && inAuthor.extra === '# lead author\n# - Removed Person', json(inAuthor));
  const inPageNumbers = read('plass:\n  page-numbers:\n    # roman front matter\n    front-matter: roman\n    start: 2');
  check('a comment inside a plass sub-map stays in the plass block', inPageNumbers.frontMatterRestart && inPageNumbers.settings.pageNumStart === 2 && inPageNumbers.extra === 'plass:\n  # roman front matter', json(inPageNumbers));
  const trailing = read('title: Hello # note\nfontsize: 11pt   # smaller\nabstract: | # the summary\n  Text.');
  check('comments beside known values are carried', trailing.titleMd === 'Hello' && trailing.extra === '# note\n# smaller\n# the summary' && trailing.warnings.length === 0, json(trailing));
  check('a # line inside block text is text, not a comment', read('abstract: |\n  # Not a comment\n  text').abstractMd === '# Not a comment\ntext');
  const after = read('abstract: |\n    text\n  # comment\ntitle: T');
  check('a comment after block text, less indented, is a comment', after.abstractMd === 'text' && after.titleMd === 'T' && after.extra === '# comment', json(after));

  // A kept comment goes to the margin, where it cannot join the entry written before it.
  const indented = read('  # note on sources\nsources: T\nauthor: Ada');
  const w1 = writeFrontmatter(indented);
  check('an indented comment is written at the margin', w1 === '---\nauthor: Ada\n# note on sources\nsources: T\n---', w1);
  check('… and the second save is the first', writeFrontmatter(readFrontmatter(w1 + '\n')) === w1);

  // write(read(write(read(x)))) === write(read(x)) on comment-bearing inputs.
  const inputs = [
    'author:\n  - Ada\n# - Removed\n  - Charles\ndate: 2026-10-04',
    'title: T\nmargin:\n  top: 2in\n# c\n  bottom: 1in',
    'title: Notes\nplass:\n# page setup\n  landscape: true',
    '  # note\nsources: T\nauthor: Ada',
    '# head\ntitle: T  # t\nplass:   # p\n  # a\n  landscape: true # l\n# b\n  hyphenate: false\n# tail',
    'stem: x\nplass:\n  landscape: true\n# between\n  future: 1\nlang: en',
    'sources:\n  - a\n# inside\n  - b\ntitle: T\n  # deeper after a known key\nnote: |\n  # text\n\n  more',
    'author:\n  - name: Ada\n# c\n    affiliation: X\n  - Bob',
    'plass:\n  page-numbers:\n# c1\n    start: 3\n  # c2\n    show: false\n  header: {text: "{section}"}  # c3',
    'margin: {top: 1in, # inside the flow map\n  left: 2in}\ndate: x',
  ];
  for (const yaml of inputs) {
    const once = writeFrontmatter(read(yaml));
    const twice = writeFrontmatter(readFrontmatter(once + '\n'));
    check(`a fixed point after one save: ${json(yaml.slice(0, 40))}`, once === twice, `\n${once}\n--\n${twice}`);
  }
  // A seeded sweep: comments at every indentation among known and unknown keys.
  let seed = 3;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  const comment = () => [' # c', '# c', '  # c', '    # c'][rand(4)].trimEnd();
  let bad = 0;
  for (let k = 0; k < 300; k++) {
    const lines: string[] = [];
    if (rand(3) === 0) lines.push(comment());
    lines.push('author:');
    for (const a of ['Ada', 'Bob'].slice(0, 1 + rand(2))) {
      if (rand(3) === 0) lines.push(comment());
      lines.push(`  - ${a}`);
    }
    if (rand(2)) lines.push('stem: x' + (rand(3) ? '' : '  # t'));
    lines.push('plass:' + (rand(3) ? '' : '  # p'));
    if (rand(3) === 0) lines.push(comment());
    lines.push('  landscape: true');
    if (rand(3) === 0) lines.push(comment());
    lines.push('  future: [1, 2]');
    if (rand(2)) lines.push('margin:', '  top: 2in', ...(rand(2) ? [comment()] : []), '  left: 1in');
    const r = read(lines.join('\n'));
    const once = writeFrontmatter(r);
    const again = readFrontmatter(once + '\n');
    const ok =
      writeFrontmatter(again) === once &&
      r.authorsMd !== null && r.authorsMd === again.authorsMd &&
      r.settings.landscape === true && again.settings.landscape === true &&
      json(normalizeSettings(r.settings)) === json(normalizeSettings(again.settings)) &&
      r.warnings.every((m) => m.includes('plass.future'));
    if (!ok && bad++ < 2) console.log(`    ${json(lines.join('\n'))}\n    ${json(once)} ${json(r.warnings)}`);
  }
  check('300 seeded comment placements read alike and save to a fixed point', bad === 0, `${bad} failed`);
}

// --- 15. time linear in the input ---
console.log('linear time:');
{
  const long = 200_000;
  const t0 = performance.now();
  const stray = read('title: T\na' + ' '.repeat(long) + 'b\nfontsize: ' + '1'.repeat(long) + 'x');
  writeFrontmatter(stray);
  read('linestretch: ' + '1'.repeat(long) + 'x\nmargin: ' + '2'.repeat(long) + ' x');
  read('plass:\n  header: {text: "a' + ' '.repeat(long) + 'b"}\n  math-macros: |\n    a\n' + '\n'.repeat(long) + '    b');
  read('author:\n  - A\n' + '# c\n'.repeat(long) + '  - B');
  const elapsed = performance.now() - t0;
  check('a 200k-character stray line, 200k-digit numbers and 200k blank or comment lines read in well under a second', elapsed < 1500 && stray.titleMd === 'T', `${elapsed.toFixed(0)} ms`);
  check('… with the warnings that say why', stray.warnings.length === 2 && stray.warnings.every((m) => m.length < 200), json(stray.warnings));
  const many = read('plass:\n  page-numbers: {' + Array.from({ length: 1000 }, (_, i) => `k${i}: 1`).join(', ') + '}');
  check('a crafted block lists 50 warnings and counts the rest', many.warnings.length === 51 && /950 more/.test(many.warnings[50]), many.warnings[50]);
}

// --- 16. characters YAML does not allow as written ---
console.log('control characters:');
{
  const C1 = String.fromCharCode(0x92);
  const w = writeFrontmatter({ titleMd: `Taylor${C1}s notes` });
  check('a C1 control is written escaped (pandoc rejects it raw)', w === `---\ntitle: "Taylor${BS}u0092s notes"\n---` && readFrontmatter(w + '\n').titleMd === `Taylor${C1}s notes`, w);
  for (const [name, v] of [['U+0080', '\u0080'], ['U+FFFE', '\ufffe'], ['U+0085', '\u0085'], ['a tab', '\t']] as const) {
    const wv = writeFrontmatter({ settings: { headerText: `a${v}b` } });
    check(`${name} in a value is written as a \\u escape`, wv.includes(`${BS}u${v.charCodeAt(0).toString(16).padStart(4, '0')}`) && readFrontmatter(wv + '\n').settings.headerText === `a${v}b`, wv);
  }
  const abs = writeFrontmatter({ abstractMd: `para ${C1} one` });
  check('an abstract holding one is double-quoted, ending in a line break (pandoc reads it as blocks)', abs === `---\nabstract: "para ${BS}u0092 one${BS}u000a"\n---` && readFrontmatter(abs + '\n').abstractMd === `para ${C1} one`, abs);
  const raw = read(`title: Taylor${C1}s notes`);
  check('a raw C1 control in the file is read, with a warning', raw.titleMd === `Taylor${C1}s notes` && raw.warnings.length === 1 && raw.warnings[0].includes('U+0092'), json(raw.warnings));
  check('a lone surrogate is written as U+FFFD', writeFrontmatter({ titleMd: 'x\ud800y' }) === '---\ntitle: x\ufffdy\n---');
  check('a surrogate escape is not a YAML escape (pandoc rejects it)', read(`title: "x${BS}ud800y"`).warnings.length === 1);
  const beta = read(`title: "Effect of $${BS}beta$"`);
  check('the \\beta warning says the save keeps the control character', /a save keeps U\+0008, not \\beta/.test(beta.warnings[0] ?? ''), json(beta.warnings));
}

// --- 17. finding the block, as pandoc finds it ---
console.log('finding the block:');
{
  check('a block that is not a map is body text', readFrontmatter('---\nfoo\n---\n\nBody\n').body === '---\nfoo\n---\n\nBody\n' && readFrontmatter('---\nfoo\n---\n').titleMd === null);
  check('… a list too', readFrontmatter('---\n- a\n- b\n---\n').body === '---\n- a\n- b\n---\n');
  check('a block of comments alone is metadata', readFrontmatter('---\n# just a note\n---\nBody').body === 'Body');
  const flowRoot = read('{title: X, author: A,\n  plass: {landscape: true}}');
  check('a block written as one flow map is read', flowRoot.titleMd === 'X' && flowRoot.authorsMd === 'A' && flowRoot.settings.landscape === true && flowRoot.warnings.length === 0, json(flowRoot));
  check('… and written one key per line', writeFrontmatter(flowRoot) === '---\ntitle: X\nauthor: A\nplass:\n  landscape: true\n---', writeFrontmatter(flowRoot));
  const complex = read('? complex\n: v\ntitle: T');
  check('a block opening with a complex key is metadata, the key kept as written', complex.titleMd === 'T' && complex.extra === '? complex\n: v' && complex.warnings.length === 2, json(complex));
  const uniform = read('  title: X\n  author: A\n  stem: s\n  plass:\n    landscape: true');
  check('a uniformly indented block is a map', uniform.titleMd === 'X' && uniform.authorsMd === 'A' && uniform.settings.landscape === true && uniform.extra === 'stem: s' && uniform.warnings.length === 0, json(uniform));
  check('… written at the margin', writeFrontmatter(uniform) === '---\ntitle: X\nauthor: A\nplass:\n  landscape: true\nstem: s\n---', writeFrontmatter(uniform));
  const lead = readFrontmatter('\n  \n---\ntitle: X\n---\nBody');
  check('blank lines may come before the block', lead.titleMd === 'X' && lead.body === 'Body', json(lead));
  // pandoc expands tabs to four-column stops before it reads the YAML.
  const tabs = read('plass:\n\tlandscape: true\n\tfuture:\n\t\ta: 1');
  check('a tab-indented plass child is nested', tabs.settings.landscape === true && tabs.extra === 'plass:\n  future:\n      a: 1', json(tabs));
  check('… and written with spaces', writeFrontmatter(tabs) === '---\nplass:\n  landscape: true\n  future:\n      a: 1\n---', writeFrontmatter(tabs));
  check('a tab after two spaces is four columns', read('  author:\n  \t- Ada\n  \t- Bob\n  date: x').authorsMd === 'Ada, Bob');
  check('a kept entry keeps its tabs', read('sources:\n\t- a\ntitle: T').extra === 'sources:\n\t- a');
  // An alias of an earlier anchor is that anchor's value.
  const alias = read('x: &a T\ntitle: *a');
  check('an alias reads its anchor’s value', alias.titleMd === 'T' && alias.warnings.length === 0 && alias.extra === 'x: &a T', json(alias));
  check('… and the anchor stays on the kept entry', writeFrontmatter(alias) === '---\ntitle: T\nx: &a T\n---');
  const plassAlias = read('base: &b {landscape: true, hyphenate: false}\nplass: *b');
  check('plass: may be an alias of a map', plassAlias.settings.landscape === true && plassAlias.settings.hyphenate === false, json(plassAlias));
  const flowAlias = read('h: &h left\nplass:\n  header: {align: *h}');
  check('an alias inside a flow map', flowAlias.settings.headerAlign === 'left', json(flowAlias));
  const dangling = read('title: &t Notes\nsubtitle: *t');
  check('an anchor on a known key that a kept entry aliases is warned about', dangling.titleMd === 'Notes' && dangling.warnings.some((m) => /\*t in a kept entry names its anchor/.test(m)), json(dangling.warnings));
  check('… not when only known keys use it', !read('date: &d 2026\ntitle: *d').warnings.some((m) => /kept entry/.test(m)));
}

// --- 18. unknown plass children are kept as written ---
console.log('kept plass children:');
{
  const r = read('plass:\n  note: |\n    a\n\n\n    b\n      \n    c\n  landscape: true');
  check('blank-line runs and whitespace-only lines inside block text are kept', r.extra === 'plass:\n  note: |\n    a\n\n\n    b\n      \n    c', json(r.extra));
  check('… through a save', writeFrontmatter(r) === '---\nplass:\n  landscape: true\n  note: |\n    a\n\n\n    b\n      \n    c\n---', writeFrontmatter(r));
  const deep = read('plass:\n    note: |\n      a\n\n\n      b\n        \n      c');
  check('… and when re-indented to two spaces', deep.extra === 'plass:\n  note: |\n    a\n\n\n    b\n      \n    c', json(deep.extra));
}

// --- 19. an alias is never expanded on the way back out ---
console.log('anchors and aliases written as they are:');
{
  // Seven anchors, each a list of ten aliases of the one before: expanded,
  // the last is 10^7 values (32 MB written to disk; one level more ran Node
  // out of memory).
  const names = 'abcdefgh';
  const defs = (levels: number): string[] => {
    const out = [`a: &a [${Array(10).fill('x').join(', ')}]`];
    for (let i = 1; i < levels; i++) out.push(`${names[i]}: &${names[i]} [${Array(10).fill('*' + names[i - 1]).join(', ')}]`);
    return out;
  };
  const yaml = defs(7).join('\n') + '\nplass: {future: *g}';
  let t0 = performance.now();
  const laughs = read(yaml);
  const w = writeFrontmatter(laughs);
  let ms = performance.now() - t0;
  check('seven chained anchors under a flow plass: map read and save in milliseconds', ms < 200, `${ms.toFixed(0)} ms`);
  check('… the kept child is the alias, not its 10^7 values', laughs.extra.length < 2 * yaml.length && /\n {2}future: \*g$/.test(laughs.extra), `${laughs.extra.length} bytes`);
  check('… written after its anchor, a fixed point', w === `---\n${defs(7).join('\n')}\nplass:\n  future: *g\n---` && fixedPoint(laughs), w.slice(0, 200));
  const root = `{${defs(8).join(', ')}, z: *h}`;
  t0 = performance.now();
  const flowRoot = read(root);
  const wr = writeFrontmatter(flowRoot);
  ms = performance.now() - t0;
  check('eight chained anchors in a block written as one flow map: read and saved in milliseconds', ms < 200 && flowRoot.extra.length < 2 * root.length, `${ms.toFixed(0)} ms, ${flowRoot.extra.length} bytes`);
  check('… one entry per line, aliases as written', wr === `---\n${defs(8).join('\n')}\nz: *h\n---`, wr.slice(0, 200));
  // A chain of aliases restarts no depth count on the way out: 20000 links, no stack overflow.
  const chain = ['a0: &a0 x'];
  for (let i = 1; i <= 20000; i++) chain.push(`a${i}: &a${i} [*a${i - 1}]`);
  const chainYaml = chain.join('\n') + '\nplass: {future: *a20000}';
  t0 = performance.now();
  let linked: ReturnType<typeof read> | null = null;
  let thrown = '';
  try {
    linked = read(chainYaml);
    writeFrontmatter(linked);
  } catch (e) {
    thrown = String(e);
  }
  ms = performance.now() - t0;
  check('a 20000-long alias chain reads and saves without overflowing the stack', !thrown && ms < 1500, thrown || `${ms.toFixed(0)} ms`);
  check('… its extra no larger than the input', linked !== null && linked.extra.length <= chainYaml.length && linked.extra.endsWith('plass:\n  future: *a20000'), String(linked?.extra.length));

  const kept = read('plass: {future: &f [1, 2], other: *f, landscape: true}');
  check('a flow plass: map keeps its unknown children’s anchors and aliases', kept.settings.landscape === true && kept.extra === 'plass:\n  future: &f [1, 2]\n  other: *f' && kept.warnings.length === 2, json(kept));
  check('… with no warning that the anchor is lost', !kept.warnings.some((m) => /not written back/.test(m)));
  const empty = read('plass: {a: &x , b: *x}');
  check('an anchor on an empty value is an anchor (pandoc reads both as empty)', empty.extra === 'plass:\n  a: &x\n  b: *x' && fixedPoint(empty), json(empty));
  const dropped = read('plass: {header: {align: &f left}, future: *f}');
  check('an alias of an anchor in a rewritten child is still warned about', dropped.settings.headerAlign === 'left' && dropped.warnings.some((m) => /\*f in a kept entry names its anchor/.test(m)), json(dropped.warnings));
}

// --- 20. a key that is an Object.prototype name is no setting ---
console.log('keys named like Object.prototype members:');
{
  for (const [yaml, want] of [
    ['plass:\n  page-numbers: {hasOwnProperty: 1}', 'plass.page-numbers.hasOwnProperty is not a Plass setting'],
    ['plass:\n  footnotes:\n    valueOf: x', 'plass.footnotes.valueOf is not a Plass setting'],
    ['plass:\n  header: {toLocaleString: x}', 'plass.header.toLocaleString is not a Plass setting'],
    ['papersize: constructor', 'papersize: constructor is not one of'],
    ['plass:\n  page: __proto__', 'plass.page: __proto__ is not half-letter'],
    ['plass:\n  page: toString', 'plass.page: toString is not half-letter'],
  ] as const) {
    let r: ReturnType<typeof read> | null = null;
    let thrown = '';
    try {
      r = read(yaml);
    } catch (e) {
      thrown = String(e);
    }
    check(`${json(yaml)}: read, warned, nothing set`, !thrown && r !== null && json(r.settings) === '{}' && r.warnings.length === 1 && r.warnings[0].startsWith(want), thrown || json(r?.warnings));
  }
}

// --- 21. anchors across the plass block ---
console.log('anchors across the plass block:');
{
  // pandoc rejects an alias before its anchor ("Unknown alias"), so a kept
  // plass child that aliases a kept entry's anchor is written after it.
  const block = read('base: &b 1\nplass:\n  future: *b');
  check('a kept plass child aliasing a kept entry: the plass block is written after the anchor', writeFrontmatter(block) === '---\nbase: &b 1\nplass:\n  future: *b\n---' && fixedPoint(block), writeFrontmatter(block));
  const flow = read('base: &b x\nplass: {landscape: true, future: *b}\nnote: n');
  check('… with the known plass keys, from a flow map', writeFrontmatter(flow) === '---\nbase: &b x\nplass:\n  landscape: true\n  future: *b\nnote: n\n---' && fixedPoint(flow), writeFrontmatter(flow));
  check('… and with the known keys when nothing aliases', writeFrontmatter(read('base: &b 1\nplass:\n  future: 2\n  landscape: true')) === '---\nplass:\n  landscape: true\n  future: 2\nbase: &b 1\n---');
  // An unknown plass child is read for its anchors, as a top-level one is.
  const later = read('plass:\n  future: &f left\n  header: {align: *f}');
  check('a known plass child aliasing an unknown one reads its value', later.settings.headerAlign === 'left' && later.warnings.length === 1 && later.extra === 'plass:\n  future: &f left', json(later));
  check('… and the save keeps both', writeFrontmatter(later) === '---\nplass:\n  header: {align: left}\n  future: &f left\n---' && fixedPoint(later), writeFrontmatter(later));
  const top = read('plass:\n  future: &f Notes\ntitle: *f');
  check('a title aliasing an unknown plass child reads its value', top.titleMd === 'Notes' && top.warnings.length === 1, json(top));
  // A stray line under plass: (a tab is four columns, pandoc rejects the
  // block) stays a stray through a save: the writer reads kept children at
  // two spaces, not at their own least indentation.
  const stray = read('plass:\n\tlandscape: true\n  hyphenate: false');
  check('a stray plass line is kept, its sibling read', stray.settings.hyphenate === false && stray.settings.landscape === undefined && stray.extra === 'plass:\n    landscape: true' && stray.warnings.length === 1 && /kept as written/.test(stray.warnings[0]), json(stray));
  const once = writeFrontmatter(stray);
  const again = readFrontmatter(once + '\n');
  check('… and written as it was, not as a child', once === '---\nplass:\n    landscape: true\n  hyphenate: false\n---' && again.settings.landscape === undefined && json(again.warnings) === json(stray.warnings), once);
  check('… a fixed point', writeFrontmatter(again) === once);
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('all front-matter tests passed');
