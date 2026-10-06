// The content referee (docs/MARKDOWN-SOURCE-PLAN.md, step 10) on a file
// or a folder: every `.md` read by Plass (`mdToDoc`) and by pandoc
// (`pandoc -f markdown-smart -t json`), both reduced by md-skeleton.ts and
// compared record by record, the accepted divergences
// (`ACCEPTED_DIVERGENCES`) set aside. The same comparison as
// src/md-parity.test.ts, which runs it on tests/fixtures/md and imports
// the pandoc plumbing from here; this is the course-corpus gate (the
// plan's "Corpus"): the folder should report no divergence beyond the
// accepted ones.
//
//   node --import tsx scripts/pandoc-parity.ts <file-or-folder> [--show N] [--skip N] [--limit N]
//
// --show N prints the first N diverging files with both skeletons around
//   the divergence.
// --skip N / --limit N take a slice of the sorted file list, so a long
//   folder can be checked in batches.
//
// pandoc is $PANDOC, else `pandoc` on PATH, else Quarto's bundled binary.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { mdToDoc } from '../src/md-parser';
import { docSkeleton, pandocSkeleton, refereeCompare, showDivergence, type PandocDoc, type SkeletonRecord } from '../src/md-skeleton';

/** Quarto ships pandoc; its two Mac builds. */
const QUARTO_PANDOC = ['/Applications/quarto/bin/tools/aarch64/pandoc', '/Applications/quarto/bin/tools/x86_64/pandoc'];

/** The first pandoc that runs: `$PANDOC` (an explicit choice), `pandoc`
 *  on PATH, then Quarto's binaries. Null when there is none. */
export function findPandoc(): string | null {
  const candidates = [process.env.PANDOC, 'pandoc', ...QUARTO_PANDOC].filter((c): c is string => Boolean(c));
  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}

/** pandoc's first `--version` line (`pandoc 3.4`). */
export function pandocVersion(bin: string): string {
  return spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0].trim();
}

/** The pandoc-types version its JSON carries (`[1, 23, 1]`), or null. The
 *  skeleton reads the 1.23 AST. */
export function pandocApiVersion(bin: string): number[] | null {
  try {
    const v = (JSON.parse(pandocJson(bin, '')) as PandocDoc)['pandoc-api-version'];
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function pandocJson(bin: string, src: string): string {
  const r = spawnSync(bin, ['-f', 'markdown-smart', '-t', 'json'], { input: src, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`pandoc exited ${r.status}: ${r.stderr.trim().split('\n')[0]}`);
  return r.stdout;
}

export interface Refereed {
  plass: SkeletonRecord[];
  pandoc: SkeletonRecord[];
  /** The first divergence no accepted entry covers, -1 when none. */
  at: number;
  accepted: Array<{ at: number; id: string }>;
}

/** One file's text through both readers and the comparison. */
export function referee(bin: string, src: string): Refereed {
  const pandoc = pandocSkeleton(JSON.parse(pandocJson(bin, src)) as PandocDoc);
  const plass = docSkeleton(mdToDoc(src).doc);
  return { plass, pandoc, ...refereeCompare(plass, pandoc) };
}

/** The diverging field names of two records, sorted. */
function fieldsDiffering(a: SkeletonRecord, b: SkeletonRecord): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  return [...keys].filter((k) => JSON.stringify(ra[k]) !== JSON.stringify(rb[k])).sort();
}

/** A marker pandoc's `fancy_lists` reads and Plass does not: `a.`, `a)`,
 *  `(a)`, `iv.`, `(1)`, `#.`, `(@)` (MARKDOWN-FORMAT.md pitfall 19). */
const FANCY_MARKER = /^\(?(?:[a-zA-Z]|[ivxlcdm]+|[IVXLCDM]+|\d+|#|@\w*)[.)] /;

/** A divergence named by its cause when the cause is one the format
 *  documents, else by what differs: a record only one side has, the block
 *  kinds, or the fields of one kind. */
function divergenceKind(plass: SkeletonRecord[], pandoc: SkeletonRecord[], at: number): string {
  const a = plass[at];
  const b = pandoc[at];
  if (!a) return `pandoc reads a ${b.kind} more`;
  if (!b) return `Plass reads a ${a.kind} more`;
  const at1 = plass[at + 1]?.kind;
  if (a.kind === 'paragraph' && b.kind === 'list' && FANCY_MARKER.test(a.text ?? '')) return 'a), a. or i. marker: a list to pandoc, text to Plass (pitfall 19)';
  if (a.kind === 'paragraph' && b.kind === 'hr' && /^_{3,}$/.test(a.text ?? '')) return 'a line of underscores: a rule to pandoc, a blank to fill to Plass';
  if (a.kind === 'paragraph' && b.kind === 'paragraph' && (at1 === 'list' || at1 === 'quote' || at1 === 'table') && b.text?.startsWith(`${a.text} `)) {
    return `a ${at1} right after paragraph text: a block to Plass, more text to pandoc`;
  }
  if (a.kind !== b.kind) return `${a.kind} (Plass) / ${b.kind} (pandoc)`;
  const fields = fieldsDiffering(a, b);
  if (fields.join() === 'text' && a.text !== undefined && b.text !== undefined) {
    // pandoc's subscript and superscript: `H~2~O`, `x^2^` (pitfall 6).
    if (a.text.replace(/([~^])(\S+?)\1/g, '$2') === b.text) return "~sub~ or ^super^: pandoc's subscript or superscript, text to Plass (pitfall 6)";
    // pandoc's `task_lists`: `- [ ]` and `- [x]` print a box.
    if (a.text.replace(/^\[ \]/, '☐').replace(/^\[[xX]\]/, '☒') === b.text) return 'a task-list box: ☐ or ☒ to pandoc, [ ] or [x] to Plass';
  }
  return `${a.kind} ${fields.join('+')}`;
}

function collect(target: string): string[] {
  const root = resolve(target);
  if (statSync(root).isFile()) return [root];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

function main(argv: string[]): number {
  const target = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (!target) {
    console.error('usage: node --import tsx scripts/pandoc-parity.ts <file-or-folder> [--show N] [--skip N] [--limit N]');
    return 2;
  }
  const flag = (name: string, dflt: number) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1]) : dflt;
  };
  const show = flag('--show', 0);
  const skip = flag('--skip', 0);
  const limit = flag('--limit', Infinity);

  const bin = findPandoc();
  if (!bin) {
    console.error('pandoc not found: set $PANDOC, put pandoc on PATH, or install Quarto');
    return 2;
  }
  const api = pandocApiVersion(bin);
  console.log(`${pandocVersion(bin)} (pandoc-types ${api?.join('.') ?? '?'}) at ${bin}`);
  if (!api || api[0] !== 1 || api[1] !== 23) console.log('warning: the skeleton reads pandoc-types 1.23; expect spurious divergences');

  const all = collect(target);
  const files = all.slice(skip, skip + limit);
  const base = statSync(resolve(target)).isFile() ? resolve(target, '..') : resolve(target);
  let agree = 0;
  let acceptedOnly = 0;
  const failed: string[] = [];
  const acceptedFiles = new Map<string, number>();
  const kinds = new Map<string, string[]>();
  let shown = 0;
  files.forEach((file, n) => {
    if (n && n % 50 === 0) console.log(`  … ${n} of ${files.length}`);
    const rel = relative(base, file) || file;
    let r: Refereed;
    try {
      r = referee(bin, readFileSync(file, 'utf8'));
    } catch (e) {
      failed.push(`${rel}: ${(e as Error).message.split('\n')[0]}`);
      return;
    }
    for (const id of new Set(r.accepted.map((x) => x.id))) acceptedFiles.set(id, (acceptedFiles.get(id) ?? 0) + 1);
    if (r.at < 0) {
      if (r.accepted.length) acceptedOnly++;
      else agree++;
      return;
    }
    const kind = divergenceKind(r.plass, r.pandoc, r.at);
    const list = kinds.get(kind) ?? [];
    list.push(`${rel} @${r.at}`);
    kinds.set(kind, list);
    if (shown < show) {
      shown++;
      console.log(`--- ${rel}: ${kind}\n${showDivergence(r.plass, r.pandoc, r.at, 1, 240)}`);
    }
  });

  const diverge = files.length - agree - acceptedOnly - failed.length;
  const slice = files.length < all.length ? ` (files ${skip + 1}–${skip + files.length} of ${all.length})` : '';
  console.log(`${files.length} files${slice}: ${agree} agree, ${acceptedOnly} agree but for accepted divergences, ${diverge} diverge, ${failed.length} unread`);
  for (const [id, count] of acceptedFiles) console.log(`  accepted  ${id}: ${count} file(s)`);
  for (const [kind, list] of [...kinds.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))) {
    console.log(`  ${String(list.length).padStart(4)}  ${kind}`);
    for (const ex of list.slice(0, 3)) console.log(`          ${ex}`);
  }
  for (const f of failed) console.log(`  unread  ${f}`);
  return diverge || failed.length ? 1 : 0;
}

// Run as a script, not when md-parity.test.ts imports the plumbing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
