// The YAML front matter of a Plass .md (md-frontmatter.ts): every document
// setting round-trips through pandoc's and Plass's keys, defaults write
// nothing, scalars are written with no backslash escaping (so LaTeX
// survives), YAML's own escapes are decoded as pandoc decodes them, unknown
// keys and comments are carried verbatim in order, and out-of-range values
// are reported, not silently clamped.
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
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('all front-matter tests passed');
