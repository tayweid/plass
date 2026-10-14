import { isPortableCitationKey, parseBibTeX } from './bibtex';
import { schema } from './schema';
import { docToTyp, textSetLine } from './typ-serializer';
import { isRemoteSource, remoteImageStatus } from './remote-images';
import { contentSecurityPolicy } from './security-policy';
import { readFileSync } from 'node:fs';
import { MITEX_IMPORT } from './typst-config';
import { convertMath, ensureMathConverter, MathConvertError } from './math-convert';
import { COMPILER_LIMITS, validateCompilerTask } from './typst-worker-protocol';
import { INPUT_LIMITS, inputSizeError, textSizeError } from './input-limits';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings';
import { parseTable, typToDoc } from './typ-parser';

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log('  ok ', name);
  else {
    console.error(' FAIL', name);
    failed++;
  }
}

console.log('security boundaries');

check('ordinary citation key accepted', isPortableCitationKey('smith-2026:paper.v2'));
check('HTML citation key rejected', !isPortableCitationKey('<img/src=x/onerror=alert(1)>'));
check('whitespace citation key rejected', !isPortableCitationKey('smith 2026'));
check('empty citation key rejected', !isPortableCitationKey(''));
check('overlong citation key rejected', !isPortableCitationKey('a'.repeat(129)));

const hostileBib = '@article{<img/src=x/onerror=alert(1)>, title={Preserved}}';
const hostileEntry = parseBibTeX(hostileBib)[0];
check('non-portable bibliography entry is preserved', hostileEntry?.key === '<img/src=x/onerror=alert(1)>');
check('non-portable bibliography entry remains unavailable for citation', !isPortableCitationKey(hostileEntry?.key ?? ''));

const badKey = '<img/src=x/onerror=alert(1)>';
const doc = schema.nodes.doc.create(null, [
  schema.nodes.paragraph.create(null, [schema.nodes.citation.create({ key: badKey })]),
]);
const typ = docToTyp(doc);
check('invalid stored citation is escaped as visible Typst text', typ.includes('\\@\\<img/src=x/onerror=alert(1)\\>'));
check('invalid stored citation is never emitted as active @key syntax', !typ.includes(`\n@${badKey}`));

check('HTTPS image URL is recognized as remote', isRemoteSource('https://images.example/paper.png'));
check('project image path is not treated as remote', !isRemoteSource('figures/paper.png'));
check(
  'remote image needs explicit permission by default',
  remoteImageStatus('https://images.example/paper.png')?.allowed === false,
);
check(
  'insecure remote image is rejected',
  remoteImageStatus('http://images.example/paper.png')?.reason === 'Remote images must use HTTPS',
);
check(
  'loopback image target is rejected',
  remoteImageStatus('https://127.0.0.1/paper.png')?.reason === 'Local and private-network image hosts are blocked',
);
check(
  'credential-bearing image URL is rejected',
  remoteImageStatus('https://user:secret@images.example/paper.png')?.reason ===
    'Remote image URLs cannot contain credentials',
);

check(
  'oversized Typst source is rejected before reaching a worker',
  validateCompilerTask({ kind: 'svg', source: 'x'.repeat(COMPILER_LIMITS.sourceBytes + 1) }) ===
    'Typst source exceeds the 4 MiB compilation limit',
);
check(
  'compiler asset traversal is rejected',
  validateCompilerTask({
    kind: 'document-svg',
    source: 'safe',
    assets: [{ path: '/../private.png', data: new Uint8Array(1) }],
  }) === 'Document contains an invalid compiler asset path',
);
check(
  'oversized compiler asset is rejected',
  validateCompilerTask({
    kind: 'pdf',
    source: 'safe',
    assets: [{ path: '/large.png', data: new Uint8Array(COMPILER_LIMITS.assetBytes + 1) }],
  }) === 'A compiler asset exceeds the 20 MiB limit',
);

check(
  'document files are rejected from metadata before being read',
  inputSizeError(INPUT_LIMITS.documentBytes + 1, INPUT_LIMITS.documentBytes, 'large.typ') ===
    "large.typ is larger than Plass's 32 MiB limit",
);
check('UTF-8 byte limits count multibyte text', !!textSizeError('éé', 3, 'Text'));
check(
  'oversized bibliographies fail closed inside the parser',
  parseBibTeX('@article{safe,title={Safe}}' + ' '.repeat(INPUT_LIMITS.bibliographyBytes)).length === 0,
);

const normalized = normalizeSettings({
  font: 'bad\nfont',
  sizePt: Infinity,
  lineHeight: 100,
  marginLeft: 99,
  pageNumStart: 1_000_000_000,
  mathMacros: 'x'.repeat(INPUT_LIMITS.mathMacrosBytes + 1),
});
check(
  'hostile persisted settings fall back to bounded defaults',
  normalized.font === DEFAULT_SETTINGS.font &&
    normalized.sizePt === DEFAULT_SETTINGS.sizePt &&
    normalized.lineHeight === DEFAULT_SETTINGS.lineHeight &&
    normalized.marginLeft === DEFAULT_SETTINGS.marginLeft &&
    normalized.pageNumStart === DEFAULT_SETTINGS.pageNumStart &&
    normalized.mathMacros === DEFAULT_SETTINGS.mathMacros,
);
const hostileFontLine = textSetLine({ ...DEFAULT_SETTINGS, font: 'A"B' });
check(
  'untrusted font names never enter generated Typst source',
  hostileFontLine.includes('font: "New Computer Modern"') && !hostileFontLine.includes('A\\"B'),
);
check(
  'absurd table dimensions stay raw instead of allocating huge arrays',
  parseTable('#table(columns: 1000000000, [cell])') === null,
);

const malformedBibLine = '#bibliography(bytes("\\q"))';
const malformedBib = typToDoc(`${malformedBibLine}\n\nBody`);
check(
  'malformed embedded bibliography source is preserved verbatim',
  malformedBib.warnings.length > 0 &&
    malformedBib.doc.firstChild?.type.name === 'code_block' &&
    malformedBib.doc.firstChild.textContent === malformedBibLine &&
    docToTyp(malformedBib.doc).includes(malformedBibLine),
);

const productionCsp = contentSecurityPolicy();
check('production CSP defaults resources to same-origin', productionCsp.includes("default-src 'self'"));
check('production CSP blocks inline script attributes', productionCsp.includes("script-src-attr 'none'"));
check('production CSP allows WASM without allowing JavaScript eval',
  productionCsp.includes("'wasm-unsafe-eval'") && !productionCsp.includes(" 'unsafe-eval'"));
check('production CSP restricts workers to same-origin', productionCsp.includes("worker-src 'self'"));
check('production CSP does not permit development WebSockets', !productionCsp.includes('ws:'));
check('development CSP permits Vite HMR WebSockets', contentSecurityPolicy({ development: true }).includes('ws:'));
check(
  'response-header CSP includes clickjacking protection',
  contentSecurityPolicy({ responseHeader: true }).includes("frame-ancestors 'none'"),
);

// No package, ever: what Plass compiles has native math, and the compiler
// resolves no package, so it fetches nothing from a registry.
const workerSource = readFileSync(new URL('./typst-compiler.worker.ts', import.meta.url), 'utf8');
check(
  'the compiler worker resolves no package',
  /TypstSnippet\.fetchPackageBy\(accessModel, \(\) => undefined\)/.test(workerSource) &&
    !/packages\.typst\.org|TYPST_PACKAGE|pinnedPackage/.test(workerSource),
);
await ensureMathConverter();
const mathDoc = schema.nodes.doc.create(null, [
  schema.nodes.paragraph.create(null, [schema.text('Area '), schema.nodes.math_inline.create({ src: '\\frac{1}{2} b h' })]),
  schema.nodes.math_display.create({ src: '\\sqrt{x}' }),
]);
const printed = docToTyp(mathDoc, { islands: 'print' });
check('printed math imports no package', !printed.includes('#import') && printed.includes('$frac(1 ,2 ) b  h $'));
check('the working .typ file keeps the mitex form it reopens from', docToTyp(mathDoc).includes(`\n${MITEX_IMPORT}\n`));
// Converted math is inlined, no longer evaluated inside a string: a
// formula whose Typst would reach past its own equation is refused.
const contained = (latex: string) => {
  try {
    convertMath(latex);
    return false;
  } catch (error) {
    return error instanceof MathConvertError;
  }
};
check('a backtick in math is refused (it would open raw text past the equation)', contained('a ` b') && contained('x`) #panic("ran") $(`'));
const unescapedCode = (typ: string) => /(^|[^\\])#(?!textmath\[|math\.equation\()/.test(typ);
check(
  'code typed into a formula converts to escaped text',
  ['a $ #panic("ran") $ b', '#panic("x")', 'x" #panic("ran") "', '\\text{a #panic("ran") b}'].every((latex) => {
    try {
      return !unescapedCode(convertMath(latex));
    } catch (error) {
      return error instanceof MathConvertError;
    }
  }),
);
check('text-mode math stays balanced', convertMath('\\text{$}]#') === '#textmath[#math.equation(block: false, $$);];\\]\\#');

if (failed) {
  console.error(`\n${failed} security test(s) failed`);
  process.exit(1);
}
console.log('\nall security boundary tests passed');
