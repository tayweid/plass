// Content parity: pandoc is the referee (docs/MARKDOWN-SOURCE-PLAN.md,
// step 10). Every tests/fixtures/md/*.md is read twice, by Plass
// (`mdToDoc`) and by pandoc (`pandoc -f markdown-smart -t json`); both
// readings are reduced by md-skeleton.ts to the same records (block kinds
// and order, printed text, math sources, labels and reference targets,
// which text is a comment, image sources, table shape) and compared. A
// file fails on its first divergence that is not one of md-skeleton's
// ACCEPTED_DIVERGENCES, with both skeletons printed around it. It is not a
// rendering comparison, and pandoc never renders anything here.
//
// The accepted list is short, and each entry says why no spelling of the
// file can heal it. An entry no fixture needs fails too, so a divergence
// that a reader fix heals leaves the list. A comment on the line directly
// after paragraph text is not on it: Plass's reader takes that comment
// into the paragraph and hoists it, as pandoc does (checked below).
//
// Self-skipping, like typ-export-compile: pandoc is $PANDOC, `pandoc` on
// PATH, or Quarto's bundled binary (scripts/pandoc-parity.ts, which runs
// the same comparison on a course folder). With none, this prints
// `md-parity: skipped (pandoc not found)` and passes; a pandoc whose JSON
// is not pandoc-types 1.23 (the AST the skeleton reads) is skipped with a
// notice the same way. PANDOC_REQUIRED=1 (`npm run test:parity`) turns
// either skip into a failure. CI installs pandoc 3.4 before `npm test`.
//
// Run: npm test, or npm run test:parity
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { findPandoc, pandocApiVersion, pandocVersion, referee, type Refereed } from '../scripts/pandoc-parity.ts';
import { ACCEPTED_DIVERGENCES, showDivergence } from './md-skeleton.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? '\n' + detail : ''}`);
  }
}

const required = process.env.PANDOC_REQUIRED === '1';
function skip(why: string): never {
  if (required) {
    console.error(`FAIL  md-parity: ${why}, and PANDOC_REQUIRED=1 asks for the referee`);
    process.exit(1);
  }
  console.log(`md-parity: skipped (${why})`);
  process.exit(0);
}

const bin = findPandoc() ?? skip('pandoc not found');
const api = pandocApiVersion(bin);
if (!api || api[0] !== 1 || api[1] !== 23) {
  skip(`${pandocVersion(bin)} at ${bin} writes pandoc-api-version ${api?.join('.') ?? '(unreadable)'}; the skeleton reads 1.23`);
}
console.log(`md-parity: ${pandocVersion(bin)} (pandoc-types ${api.join('.')}) at ${bin}`);

/** The first divergence, both skeletons around it. */
const detail = (r: Refereed) =>
  r.at < 0 ? '' : `  first divergence at record ${r.at} (Plass ${r.plass.length} records, pandoc ${r.pandoc.length}):\n${showDivergence(r.plass, r.pandoc, r.at)}`;

// ------------------------------------------------------------ the fixtures
const dir = new URL('../tests/fixtures/md/', import.meta.url);
const names = readdirSync(dir)
  .filter((n) => n.endsWith('.md'))
  .sort();
check(`the fixtures are there (${names.length})`, names.length > 0);
const needed = new Map<string, string[]>();
for (const name of names) {
  const r = referee(bin, readFileSync(new URL(name, dir), 'utf8'));
  const counts = new Map<string, number>();
  for (const { id } of r.accepted) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of counts.keys()) needed.set(id, [...(needed.get(id) ?? []), name]);
  const note = counts.size ? ` (accepted: ${[...counts].map(([id, n]) => `${id} ×${n}`).join(', ')})` : '';
  check(`${name}: Plass and pandoc agree${note}`, r.at < 0, detail(r));
}
for (const { id, why } of ACCEPTED_DIVERGENCES) {
  check(`accepted divergence "${id}" is still needed (${needed.get(id)?.join(', ') ?? 'by no fixture'})`, needed.has(id), `  ${why}\n  No fixture diverges this way any more: remove the entry.`);
}

// -------------------------------------------------- what is not accepted
// A comment on the line directly after paragraph text is an inline raw
// to pandoc and was a block to markdown-it; the reader now reads it the
// pandoc way (the paragraph stays whole, the comment is hoisted after it),
// so the two agree with nothing accepted, also with text after the
// comment and inside a list item.
for (const [shape, md] of [
  ['after a paragraph line', 'A paragraph line.\n<!-- ED: right after it -->\n\nNext.\n'],
  ['with text after it', 'A paragraph line.\n<!-- ED: right after it -->\nmore text.\n\nNext.\n'],
  ['in a list item', '- An item line.\n  <!-- ED: right after it -->\n- Second item.\n'],
]) {
  const r = referee(bin, md);
  check(`a comment on the line directly after paragraph text, ${shape}: agree, nothing accepted`, r.at < 0 && !r.accepted.length, detail(r));
}

// A hand-written `H~2~O` / `x^2^` is pandoc's subscript and superscript,
// and text to Plass, which has neither (the save escapes the marks, and
// MARKDOWN-FORMAT.md pitfall 6 says to use math): a REPORTED divergence.
{
  const r = referee(bin, 'Water is H~2~O and the square is x^2^.\n');
  check(
    'a hand-written H~2~O and x^2^ is reported, not accepted',
    r.at === 0 && !r.accepted.length && r.plass[0]?.text === 'Water is H~2~O and the square is x^2^.' && r.pandoc[0]?.text === 'Water is H2O and the square is x2.',
    detail(r) || JSON.stringify([r.plass, r.pandoc]),
  );
}

if (failures) {
  console.error(`\nmd-parity: ${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('all md-parity checks passed');
