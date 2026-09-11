// Merge-on-cite and the raw entry text it copies.
// Run: npx tsx src/library-bib.test.ts
import { parseBibTeX } from './bibtex';
import { mergeEntryIntoBib } from './library-bib';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const LIB = `@comment{a library}

@article{knuth86,
  author = {Knuth, Donald E. and Plass, Michael F.},
  title = {Breaking Paragraphs into Lines},
  journal = {Software: Practice and Experience},
  year = {1981},
}

@book{lamport94, author = {Lamport, Leslie}, title = {{LaTeX}: A Document Preparation System}, year = {1994}}
`;

console.log('library bib:');
const entries = parseBibTeX(LIB);
check('entries carry their raw source', entries.length === 2 && entries[0].raw.startsWith('@article{knuth86,') && entries[0].raw.trim().endsWith('}') && entries[1].raw === '@book{lamport94, author = {Lamport, Leslie}, title = {{LaTeX}: A Document Preparation System}, year = {1994}}', JSON.stringify(entries.map((e) => e.raw)));
const empty = mergeEntryIntoBib(null, entries[0]);
check('citing into a document without a bibliography creates one', empty.name === 'references.bib' && empty.content === entries[0].raw + '\n', JSON.stringify(empty));
const merged = mergeEntryIntoBib({ name: 'refs.bib', content: '@misc{a, title={A}}\n' }, entries[1]);
check('an entry is appended after a blank line', merged.name === 'refs.bib' && merged.content === '@misc{a, title={A}}\n\n' + entries[1].raw + '\n', JSON.stringify(merged));
const again = mergeEntryIntoBib(merged, entries[1]);
check('an entry already present is not duplicated', again.content === merged.content, again.content);
check('the merged text parses to both entries', parseBibTeX(merged.content).map((e) => e.key).join(',') === 'a,lamport94');

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('all library-bib tests passed');
