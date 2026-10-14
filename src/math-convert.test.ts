// Native-Typst math: the vendored converter, the prelude, the print form.
// Run: npx tsx src/math-convert.test.ts
//
// The identity of every formula's ink with the old `#mi`/`#mitex` form is
// proved outside the unit run (typst 0.14.2 binary, the step-15 A/B: every
// formula of the demo, the fixtures and the course folders, plain and
// bold); this suite pins the pieces that proof rests on.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  convertMath,
  displayEquation,
  ensureMathConverter,
  inlineEquation,
  MathConvertError,
  mathConverterReady,
  MITEX_WASM_SHA256,
} from './math-convert';
import { MATH_HANDLE_NAMES, mathPrelude } from './typst-math-prelude';
import { docToTyp } from './typ-serializer';
import { inkTypst } from './math-ink';
import { schema } from './schema';
import { MITEX_IMPORT } from './typst-config';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}
const throws = (fn: () => unknown, test: (e: unknown) => boolean) => {
  try {
    fn();
    return false;
  } catch (e) {
    return test(e);
  }
};

const n = schema.nodes;
const mathDoc = n.doc.create(null, [
  n.paragraph.create(null, [schema.text('Half '), n.math_inline.create({ src: '\\frac{1}{2}' }), schema.text('; done.')]),
  n.math_display.create({ src: 'E = mc^2', label: 'eq:e' }),
]);

console.log('before the converter loads');
check('it is not ready', !mathConverterReady());
check('convertMath says to load it', throws(() => convertMath('x'), (e) => e instanceof Error && /ensureMathConverter/.test(e.message)));
check('a print of math says to load it', throws(() => docToTyp(mathDoc, { islands: 'print' }), (e) => e instanceof Error && /ensureMathConverter/.test(e.message)));
check('a print without math needs no converter', docToTyp(n.doc.create(null, n.paragraph.create(null, schema.text('Plain.'))), { islands: 'print' }).includes('Plain.'));
check('the working file needs no converter', docToTyp(mathDoc).includes(`\n${MITEX_IMPORT}\n`));

console.log('the vendored wasm');
const wasm = readFileSync(new URL('./mitex/mitex.wasm', import.meta.url));
check('it is the pinned mitex 0.2.7 build', createHash('sha256').update(wasm).digest('hex') === MITEX_WASM_SHA256);
await ensureMathConverter();
check('it loads', mathConverterReady());
await ensureMathConverter();
check('loading again is a no-op', mathConverterReady());

console.log('conversion');
check('a fraction', convertMath('\\frac{1}{2}') === 'frac(1 ,2 )', convertMath('\\frac{1}{2}'));
check('a superscript', convertMath('x^2') === 'x ^(2 )');
check('display LaTeX keeps its newlines', convertMath('\nx^2\n') === '\nx ^(2 )\n', JSON.stringify(convertMath('\nx^2\n')));
check('\\set (a Typst keyword) calls mitexset', convertMath('\\set{a}') === 'mitexset(a )' && convertMath('x \\set y') === 'x  mitexset(y )');
check('a text-mode "set(" is left alone', convertMath('\\text{set(x)}') === '#textmath[set\\(x\\)];');
check(
  'an unknown command is refused, by name',
  throws(() => convertMath('\\hfill'), (e) => e instanceof MathConvertError && /unknown command: \\hfill/.test(e.message)),
);
check('the refusal is cached', throws(() => convertMath('\\hfill'), (e) => e instanceof MathConvertError));
check('the converter still works after a refusal', convertMath('y') === 'y ');
check('a backtick is refused', throws(() => convertMath('a ` b'), (e) => e instanceof MathConvertError && /backtick/.test(e.message)));

console.log('equations');
check('inline is $…$ without leading space', inlineEquation(' x  ') === '$x  $');
check('an empty inline equation', inlineEquation('') === '$$');
check('display keeps its own surrounding whitespace', displayEquation('\nx\n') === '$\nx\n$');
check('display pads what it lacks', displayEquation('x') === '$ x $' && displayEquation('x\n') === '$ x\n$');
check('an empty display stays an empty block', displayEquation('') === '$ #none $' && displayEquation('\n\n') === '$ #none $');

console.log('the prelude');
// Every value mitex 0.2.7's mitex-scope holds (`set` as mitexset).
const SCOPE = `mitexcite mitexlabel mitexref mitexcaption miteximage negthinspace negthinmedspace negmedspace
negthickspace enspace phantom hphantom vphantom smash lvert rvert lVert rVert mitexdisplay mitexinline mitexscript
mitexsscript mitexbold mitexupright mitexitalic mitexsans mitexfrak mitexmono mitexcal mitexmathbf mathscr mathbin
mathclose mathinner mathop mathopen mathord mathpunct mathrel big Big bigg Bigg mitexcolor colortext mitexcolorbox frac
cfrac dfrac tfrac dbinom tbinom stackrel substack overset underset mitexnot xcancel bcancel sout mitexoverbrace
mitexunderbrace mitexoverbracket mitexunderbracket boxed ngeqq nleqslant nleqq nsubseteqq nsupseteqq arctg ch cth th
arcctg cosec cotg injlim mathclap mathring overgroup undergroup overleftharpoon overleftrightarrow overlinesegment
overrightharpoon underbar plim projlim raisebox sh smallint thickapprox thicksim varDelta varGamma varLambda varOmega
varPhi varPi varPsi varSigma varTheta varUpsilon varXi xleftarrow xrightarrow xLeftarrow xRightarrow xleftrightarrow
xLeftrightarrow xhookleftarrow xhookrightarrow xtwoheadleftarrow xtwoheadrightarrow xleftharpoonup xrightharpoonup
xleftharpoondown xrightharpoondown xleftrightharpoons xrightleftharpoons xtofrom xmapsto xlongequal pmod pod mitexset
Set bra Bra ket Ket braket Braket fbox hbox matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix smallmatrix mitexarray
aligned alignedat rcases KaTeX LaTeX TeX middle operatorname operatornamewithlimits vspace hspace textmath textmd
textnormal textbf textit textrm textup textsf texttt atop binom brace brack mitexsqrt`.split(/\s+/);
const names = new Set(MATH_HANDLE_NAMES);
check(
  `it defines every mitex-scope value (${SCOPE.length}) and nothing else`,
  SCOPE.length === 169 && names.size === SCOPE.length && SCOPE.every((name) => names.has(name)),
  [...SCOPE.filter((s) => !names.has(s)), '|', ...[...names].filter((s) => !SCOPE.includes(s))].join(' '),
);
check('no math, no prelude', mathPrelude(['x ^(2 )', '']) === '');
check('a handle brings its definition', mathPrelude(['frac(1 ,2 )']) === '#let frac = (num, den) => $(num)/(den)$\n');
const colour = mathPrelude(['#colortext(none, [red])[$x $]']);
check(
  'a handle brings its helpers first, once',
  colour.indexOf('#let mitex-color-map') === 0 &&
    colour.indexOf('#let get-tex-color') > 0 &&
    colour.indexOf('#let colortext') > colour.indexOf('#let get-tex-color') &&
    colour.split('#let mitex-color-map').length === 2,
  colour,
);
check('a name counts only as a whole word', mathPrelude(['afrac(1 )']) === '' && mathPrelude(['frac2']) === '');
check('mitexset is defined, set never is', /^#let mitexset = /.test(mathPrelude(['mitexset(a )'])) && !mathPrelude(SCOPE).includes('#let set '));

console.log('the print');
const print = docToTyp(mathDoc, { islands: 'print' });
check('it imports no package', !print.includes('#import') && !print.includes('#mi'));
check('it defines the handles its math names', print.includes('// LaTeX math handles, from mitex 0.2.7 (Apache-2.0)\n#let frac = '));
// (`#mi(…);` swallowed that semicolon: Typst ends an embedded expression
// at one. After `$…$` it is text.)
check('inline math is native, its semicolon printed', print.includes('Half $frac(1 ,2 )$; done.'), print);
check('display math is native, labelled', print.includes('\n$\nE  =  m c ^(2 )\n$ <eq:e>\n'), print);
const bold = docToTyp(
  n.doc.create(null, n.paragraph.create(null, [n.math_inline.create({ src: 'x' }, null, [schema.marks.strong.create()]), schema.text(' wins', [schema.marks.strong.create()])])),
  { islands: 'print' },
);
check('bold math prints inside its strong run', bold.includes('*$x $ wins*'), bold);
const cell = n.table_cell.create(null, n.paragraph.create(null, n.math_inline.create({ src: '\\frac{a}{b}' })));
const table = docToTyp(n.doc.create(null, n.table.create(null, n.table_row.create(null, [cell]))), { islands: 'print' });
check('a table cell holds native math', table.includes('[$frac(a ,b )$]'), table);
check(
  'a rejected formula fails the print, naming it',
  throws(
    () => docToTyp(n.doc.create(null, n.paragraph.create(null, n.math_inline.create({ src: 'a \\hfill b' }))), { islands: 'print' }),
    (e) => e instanceof MathConvertError && e.message.includes('a \\\\hfill b'),
  ),
);
check('the working file is unchanged', docToTyp(mathDoc).includes('#mi(`\\frac{1}{2}`)') && docToTyp(mathDoc).includes('#mitex(`\nE = mc^2\n`) <eq:e>'));

console.log('math ink');
const ink = inkTypst('\\frac{1}{2}', false, 12.5, false);
check(
  'inline ink: prelude, the equation and its width probe',
  ink ===
    '#set page(width: auto, height: auto, margin: 0pt)\n#set text(size: 12.5pt)\n#let frac = (num, den) => $(num)/(den)$\n\n' +
      '#($frac(1 ,2 )$)#context metadata((pos: here().position(), width: measure($frac(1 ,2 )$).width));#box()\n',
  ink,
);
check('bold ink compiles under strong', inkTypst('x', false, 11, true).includes('#(strong($x $))#context metadata((pos: here().position(), width: measure(strong($x $)).width))'));
check('display ink is the bare block', inkTypst('\nx\n', true, 10, false).endsWith('#set text(size: 10pt)\n\n$\nx \n$\n'), inkTypst('\nx\n', true, 10, false));

if (failures) {
  console.error(`\n${failures} math-convert test(s) failed`);
  process.exit(1);
}
console.log('\nall math-convert tests passed');
