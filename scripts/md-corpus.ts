// Round-trip a folder of Markdown files through the importer and the
// serializer (no editor, no normalizer) and say what changes: how many
// files come back byte-identical, and the first differing line of the
// rest, classified. The dogfood gate for Markdown fidelity (ROADMAP.md,
// "Next push"): the course-notes folder should report nothing but the
// decided normalizations.
//
//   node --import tsx scripts/md-corpus.ts <folder> [--show N]
//
// --show N prints the first N differing files' first diffs in full.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { mdToDoc } from '../src/md-parser';
import { docToMd } from '../src/md-serializer';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
if (!root) {
  console.error('usage: node --import tsx scripts/md-corpus.ts <folder> [--show N]');
  process.exit(2);
}
const showIdx = args.indexOf('--show');
const show = showIdx >= 0 ? Number(args[showIdx + 1] ?? '5') : 0;

const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.md')) files.push(p);
  }
};
walk(root);

const normalize = (s: string) => s.replace(/\r\n?/g, '\n');
const loose = (s: string) => normalize(s).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd();
const noBlank = (s: string) => loose(s).replace(/\n\n+/g, '\n');

type Kind =
  | 'hard-wrapped paragraph re-flowed'
  | 'smart quotes'
  | 'h4+ demoted'
  | 'task list'
  | 'list marker/indent'
  | 'emphasis form'
  | 'escaping'
  | 'table'
  | 'math'
  | 'link/image'
  | 'blank lines'
  | 'other';

function classify(a: string, b: string, nextA: string | undefined): Kind {
  if (/^#{4,6} /.test(a)) return 'h4+ demoted';
  if (/^\s*[-*] \[[ x]\]/.test(a)) return 'task list';
  if (/['"]/.test(a) && a.replace(/['"]/g, '') === b.replace(/[‘’“”′″]/g, '')) return 'smart quotes';
  if (nextA !== undefined && b.startsWith(a) && b.slice(a.length).trimStart().startsWith(nextA.trim().slice(0, 12))) return 'hard-wrapped paragraph re-flowed';
  if (/^\d+\. |^\s*[-*+] /.test(a) && /^\d+\. |^\s*[-*+] /.test(b)) return 'list marker/indent';
  if (/\\/.test(a) || /\\/.test(b)) return 'escaping';
  if (/\*\*|__|\*|_/.test(a)) return 'emphasis form';
  if (/^\|/.test(a)) return 'table';
  if (/\$/.test(a)) return 'math';
  if (/^!?\[/.test(a)) return 'link/image';
  if (a === '' || b === '') return 'blank lines';
  return 'other';
}

let identical = 0;
let whitespaceOnly = 0;
let blankLinesOnly = 0;
const byKind = new Map<Kind, number>();
const examples = new Map<Kind, string[]>();
let shown = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let out: string;
  try {
    out = docToMd(mdToDoc(src).doc);
  } catch (e) {
    byKind.set('other', (byKind.get('other') ?? 0) + 1);
    (examples.get('other') ?? examples.set('other', []).get('other')!).push(`${file}: threw ${(e as Error).message}`);
    continue;
  }
  if (normalize(src) === out) {
    identical++;
    continue;
  }
  if (loose(src) === loose(out)) {
    whitespaceOnly++;
    continue;
  }
  if (noBlank(src) === noBlank(out)) {
    blankLinesOnly++;
    continue;
  }
  const a = loose(src).split('\n');
  const b = loose(out).split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const kind = classify(a[i] ?? '', b[i] ?? '', a[i + 1]);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const rel = file.startsWith(root) ? file.slice(root.length + 1) : file;
    const ex = `${rel}:${i + 1}\n      in : ${(a[i] ?? '').slice(0, 110)}\n      out: ${(b[i] ?? '').slice(0, 110)}`;
    const list = examples.get(kind) ?? [];
    if (list.length < 2) list.push(ex);
    examples.set(kind, list);
    if (shown < show) {
      shown++;
      console.log(`--- ${ex}`);
    }
    break;
  }
}

const changed = files.length - identical - whitespaceOnly - blankLinesOnly;
console.log(`${files.length} files: ${identical} byte-identical, ${whitespaceOnly} trailing-whitespace only, ${blankLinesOnly} blank lines only, ${changed} changed`);
for (const [kind, n] of [...byKind.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${String(n).padStart(4)}  ${kind}`);
  for (const ex of examples.get(kind) ?? []) console.log(`        ${ex.replace(/\n/g, '\n        ')}`);
}
