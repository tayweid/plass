// The APA and Chicago formatters against what Typst's hayagriva printed for
// these very entries (probed through the in-app compiler on 2026-09-11).
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
@article{four, author = {Aa, A and Bb, B and Cc, C and Dd, D}, title = {C4}, year = {1983}}
@article{corp, author = {{World Bank}}, title = {D}, year = {2020}}
@article{noyear, author = {Doe, Jane}, title = {E}}
@article{samea, author = {Smith, Ann}, title = {F}, year = {2001}}
@article{sameb, author = {Smith, Ann}, title = {G}, year = {2001}}
@article{vonn, author = {van der Berg, Hans and O'Neil, Kate}, title = {H}, year = {1999}}
@book{editors, editor = {Green, Sam}, title = {I}, year = {2010}}
@book{twoeditors, editor = {Green, Sam and Brown, Pat}, title = {I2}, year = {2011}}
@book{threeed, editor = {Green, Sam and Brown, Pat and White, Lee}, title = {I3}, year = {2012}}
@book{corped, editor = {{Oxford Press}}, title = {I4}, year = {2013}}
@book{edparticle, editor = {van der Berg, Hans}, title = {I5}, year = {2014}}
@book{edfirstlast, editor = {Sam Green}, title = {I6}, year = {2015}}
@article{firstlast, author = {Jane Q. Public and John Doe}, title = {J}, year = {2015}}
@misc{noauthor, title = {Untitled Report on Things}, year = {2012}}
@misc{nda, author = {Roe, Rich}, title = {N1}}
@misc{ndb, author = {Roe, Rich}, title = {N2}}
@article{jr, author = {King, Jr., Martin Luther}, title = {K}, year = {1963}}
@article{hyphen, author = {Smith-Jones, Ann}, title = {L}, year = {2005}}
@article{datefield, author = {Lee, Kim}, title = {M}, date = {2019-05-01}}
@techreport{org, institution = {UNESCO}, title = {O}, year = {2018}}
@article{initials, author = {A. B. Cee}, title = {P}, year = {2021}}
@article{brand, author = {{van Rossum}, Guido}, title = {Q}, year = {1991}}
@misc{notitlenoyear, note = {nothing}}
@misc{titlenoyear, title = {Only A Title}}
@misc{longtitle, title = {A Rather Long Title That Goes On And On For A While}, year = {2000}}
@article{sy1, author = {Lee, Kim}, title = {S1}, year = {2003}}
@article{sy2, author = {Lee, Kim}, title = {S2}, year = {2003}}
@article{sy3, author = {Lee, Kim}, title = {S3}, year = {2003}}`;

const TYPST: Record<'apa' | 'chicago-author-date', Record<string, string>> = {
  apa: {
    one: '(Knuth, 1981)', two: '(Knuth & Plass, 1981)', three: '(Knuth et al., 1982)', four: '(Aa et al., 1983)',
    corp: '(World Bank, 2020)', noyear: '(Doe, n.d.)', samea: '(Smith, 2001a)', sameb: '(Smith, 2001b)',
    vonn: "(Berg & O'Neil, 1999)", editors: '(Green, 2010)', twoeditors: '(Green & Brown, 2011)', threeed: '(Green et al., 2012)',
    corped: '(Oxford Press, 2013)', edparticle: '(Berg, 2014)', edfirstlast: '(Green, 2015)', firstlast: '(Public & Doe, 2015)',
    noauthor: '(Untitled Report on Things, 2012)', nda: '(Roe, n.d.-a)', ndb: '(Roe, n.d.-b)', jr: '(King, 1963)',
    hyphen: '(Smith-Jones, 2005)', datefield: '(Lee, 2019)', org: '(O, 2018)', initials: '(Cee, 2021)', brand: '(van Rossum, 1991)',
    notitlenoyear: '(n.d.)', titlenoyear: '(Only a Title, n.d.)', longtitle: '(A Rather Long Title That Goes on and on for a While, 2000)',
    sy1: '(Lee, 2003a)', sy2: '(Lee, 2003b)', sy3: '(Lee, 2003c)',
  },
  'chicago-author-date': {
    one: '(Knuth 1981)', two: '(Knuth and Plass 1981)', three: '(Knuth et al. 1982)', four: '(Aa et al. 1983)',
    corp: '(World Bank 2020)', noyear: '(Doe, n.d.)', samea: '(Smith 2001a)', sameb: '(Smith 2001b)',
    vonn: "(Berg and O'Neil 1999)", editors: '(Sam Green 2010)', twoeditors: '(Sam Green, Pat Brown 2011)', threeed: '(Sam Green et al. 2012)',
    corped: '(Oxford Press 2013)', edparticle: '(Hans van der Berg 2014)', edfirstlast: '(Sam Green 2015)', firstlast: '(Public and Doe 2015)',
    noauthor: '(“Untitled Report on Things” 2012)', nda: '(Roe, n.d.-a)', ndb: '(Roe, n.d.-b)', jr: '(King 1963)',
    hyphen: '(Smith-Jones 2005)', datefield: '(Lee 2019)', org: '(O 2018)', initials: '(Cee 2021)', brand: '(van Rossum 1991)',
    notitlenoyear: '(n.d.)', titlenoyear: '(“Only a Title,” n.d.)', longtitle: '(“A Rather Long Title That Goes on and on for a While” 2000)',
    sy1: '(Lee 2003a)', sy2: '(Lee 2003b)', sy3: '(Lee 2003c)',
  },
};

console.log('citation styles:');
const entries = parseBibTeX(BIB);
const order = new Map(Object.keys(TYPST.apa).map((k, i) => [k, i + 1] as [string, number]));
for (const style of ['apa', 'chicago-author-date'] as const) {
  const labels = citationLabels(style, order, entries);
  for (const [key, want] of Object.entries(TYPST[style])) check(`${style} ${key} = ${want}`, labels.get(key) === want, JSON.stringify(labels.get(key)));
}
const ieee = citationLabels('ieee', order, entries);
check('ieee numbers in first-use order', ieee.get('one') === '[1]' && ieee.get('sy3') === `[${order.size}]`, JSON.stringify([...ieee]));
check('unknown keys get the style placeholder', citationLabels('apa', new Map([['nope', 1]]), entries).get('nope') === '(?)' && citationLabels('ieee', new Map([['nope', 1]]), entries).get('nope') === '[?]');
check('surnames drop particles and keep corporate and braced names', JSON.stringify(bibSurnames(entries[8])) === '["Berg","O\'Neil"]' && JSON.stringify(bibSurnames(entries[4])) === '["World Bank"]' && JSON.stringify(bibSurnames(entries[24])) === '["van Rossum"]', JSON.stringify([bibSurnames(entries[8]), bibSurnames(entries[4]), bibSurnames(entries[24])]));

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('all citation-style tests passed');
