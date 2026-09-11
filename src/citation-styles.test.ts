// The APA formatter against what Typst's hayagriva printed for these very
// entries (probed through the in-app compiler on 2026-09-11), plus IEEE.
// Run: npx tsx src/citation-styles.test.ts
import { parseBibTeX } from './bibtex';
import { bibSurnames, citationLabels } from './citation-styles';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const BIB = `@article{one, author = {Knuth, Donald E.}, title = {A}, year = {1981}}
@article{two, author = {Knuth, Donald E. and Plass, Michael F.}, title = {B}, year = {1981}}
@article{three, author = {Knuth, Donald E. and Plass, Michael F. and Lamport, Leslie}, title = {C}, year = {1982}}
@article{corp, author = {{World Bank}}, title = {D}, year = {2020}}
@article{noyear, author = {Doe, Jane}, title = {E}}
@article{samea, author = {Smith, Ann}, title = {F}, year = {2001}}
@article{sameb, author = {Smith, Ann}, title = {G}, year = {2001}}
@article{vonn, author = {van der Berg, Hans and O'Neil, Kate}, title = {H}, year = {1999}}
@book{editors, editor = {Green, Sam}, title = {I}, year = {2010}}
@article{firstlast, author = {Jane Q. Public and John Doe}, title = {J}, year = {2015}}`;
const TYPST_APA: Record<string, string> = {
  one: '(Knuth, 1981)',
  two: '(Knuth & Plass, 1981)',
  three: '(Knuth et al., 1982)',
  corp: '(World Bank, 2020)',
  noyear: '(Doe, n.d.)',
  samea: '(Smith, 2001a)',
  sameb: '(Smith, 2001b)',
  vonn: "(Berg & O'Neil, 1999)",
  editors: '(Green, 2010)',
  firstlast: '(Public & Doe, 2015)',
};

console.log('citation styles:');
const entries = parseBibTeX(BIB);
const order = new Map(Object.keys(TYPST_APA).map((k, i) => [k, i + 1] as [string, number]));
const apa = citationLabels('apa', order, entries);
for (const [key, want] of Object.entries(TYPST_APA)) check(`apa ${key} = ${want}`, apa.get(key) === want, JSON.stringify(apa.get(key)));
const ieee = citationLabels('ieee', order, entries);
check('ieee numbers in first-use order', ieee.get('one') === '[1]' && ieee.get('firstlast') === '[10]', JSON.stringify([...ieee]));
check('unknown keys get the style placeholder', citationLabels('apa', new Map([['nope', 1]]), entries).get('nope') === '(?)' && citationLabels('ieee', new Map([['nope', 1]]), entries).get('nope') === '[?]');
check('surnames drop particles and keep corporate names', JSON.stringify(bibSurnames(entries[7])) === '["Berg","O\'Neil"]' && JSON.stringify(bibSurnames(entries[3])) === '["World Bank"]', JSON.stringify([bibSurnames(entries[7]), bibSurnames(entries[3])]));

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('all citation-style tests passed');
