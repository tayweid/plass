// plass export — the export from the command line (Taylor, 2026-11-06).
// cli/plass.js is the command; this is what it runs.
//
//   plass export NOTES.md                    NOTES.pdf beside it
//   plass export NOTES.md -o out/notes.pdf   there
//   plass export NOTES.md -o notes.typ       the Typst source, not a PDF
//   plass export NOTES.md --values v3.json   values from that file
//
// One stem, many prints: a script writes a values file per version and
// runs the export on the same document for each, so a folder holds one
// Markdown file, not one per version. The document is read exactly as the
// app opens it (md-parser; a `bibliography:` sidecar read beside it), its
// values brought up to date from values.json beside it or `--values`, and
// the PDF is the app's own export compiled by the typst binary with Plass's
// bundled fonts: the command docs/MARKDOWN-FORMAT.md documents as exact on
// TYPST_EXACT_VERSION. A value the values file has no key for is refused by
// name (the file's last text would print, silently stale) unless
// `--allow-missing` says to print it. Figures are files beside the document
// (figures/plot.svg), read by typst from the document's folder.
//
// Runs from the checkout (cli/plass.js loads tsx, then this): `npm link`
// installs the command. typst comes from --typst, $TYPST or PATH, and must
// be 0.14.x or 0.15.x.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { applyValues, DataImageError, exportSource, openMarkdown, valueNames } from '../src/headless-export.ts';
import { ensureMathConverter, MathConvertError } from '../src/math-convert.ts';
import { pdfPageCount, twoUpSource } from '../src/pdf-sheets.ts';
import { DEFAULT_SETTINGS, pageSize } from '../src/settings.ts';
import { TYPST_EXACT_VERSION } from '../src/typst-config.ts';
import { VALUES_FILE } from '../src/values.ts';

const USAGE = `usage: plass export <document.md> [options]

  -o, --out <file>       the PDF to write (default: the document's name with
                         .pdf, beside it); a .typ path writes the Typst source
  --values <file>        the values file (default: values.json beside the
                         document, when there is one)
  --allow-missing        print a value the values file has no key for as the
                         document's last text (default: refuse, naming the keys)
  --per-sheet 2          two pages to a sheet, side by side (half letter on
                         landscape letter), as Export › PDF offers
  --typst <path>         the typst binary (default: $TYPST, then PATH)
  -q, --quiet            only errors
  -h, --help

The document is read as Plass opens it and compiled with Plass's fonts;
the PDF is exact on typst ${TYPST_EXACT_VERSION}.`;

class Usage extends Error {}
class Failure extends Error {}

interface Args {
  input: string;
  out: string | null;
  values: string | null;
  allowMissing: boolean;
  perSheet: 1 | 2;
  typst: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') throw new Usage(USAGE);
  if (argv[0] !== 'export') throw new Usage(`plass: unknown command ${JSON.stringify(argv[0])}\n\n${USAGE}`);
  const args: Args = { input: '', out: null, values: null, allowMissing: false, perSheet: 1, typst: process.env.TYPST || 'typst', quiet: false };
  const rest = argv.slice(1);
  const value = (flag: string, i: number): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('-')) throw new Usage(`plass: ${flag} needs a value\n\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') throw new Usage(USAGE);
    else if (a === '-o' || a === '--out') args.out = value(a, i++);
    else if (a === '--values') args.values = value(a, i++);
    else if (a === '--allow-missing') args.allowMissing = true;
    else if (a === '--per-sheet') {
      const n = value(a, i++);
      if (n !== '1' && n !== '2') throw new Usage(`plass: --per-sheet is 1 or 2, not ${JSON.stringify(n)}`);
      args.perSheet = n === '2' ? 2 : 1;
    } else if (a === '--typst') args.typst = value(a, i++);
    else if (a === '-q' || a === '--quiet') args.quiet = true;
    else if (a.startsWith('-')) throw new Usage(`plass: unknown option ${a}\n\n${USAGE}`);
    else if (args.input) throw new Usage(`plass: one document at a time (${args.input} and ${a})\n\n${USAGE}`);
    else args.input = a;
  }
  if (!args.input) throw new Usage(`plass: no document named\n\n${USAGE}`);
  if (extname(args.input).toLowerCase() !== '.md') throw new Usage(`plass: ${args.input} is not a .md file (a legacy .typ is not exported from the command line)`);
  return args;
}

/** The typst binary's version, or why it cannot be used. */
function typstVersion(typst: string): string {
  const probe = spawnSync(typst, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Failure(`typst was not found (${typst}): install it (brew install typst), or name it with --typst or $TYPST`);
  }
  const version = /\b(\d+\.\d+\.\d+)\b/.exec(probe.stdout)?.[1] ?? probe.stdout.trim();
  if (!/^0\.1[45]\./.test(version)) throw new Failure(`typst ${version}: the export compiles on 0.14.x and 0.15.x (exact on ${TYPST_EXACT_VERSION})`);
  return version;
}

const FONTS = fileURLToPath(new URL('../public/fonts', import.meta.url));

/** Compile `source` with Plass's fonts only, from `cwd` (relative image
 *  paths resolve there; stdin's root is the working directory), with an
 *  empty package cache and path: the export imports nothing, and a
 *  download would mean it did. */
function compile(typst: string, source: string, cwd: string, out: string, scratch: string): void {
  const noPackages = join(scratch, 'no-packages');
  mkdirSync(noPackages, { recursive: true });
  const run = spawnSync(
    typst,
    ['compile', '--diagnostic-format', 'short', '--ignore-system-fonts', '--ignore-embedded-fonts', '--font-path', FONTS, '-', out],
    {
      cwd,
      input: source,
      encoding: 'utf8',
      env: { ...process.env, TYPST_PACKAGE_CACHE_PATH: noPackages, TYPST_PACKAGE_PATH: noPackages },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  if (run.error) throw new Failure(`typst could not run: ${run.error.message}`);
  if (run.status !== 0) throw new Failure(`typst compile failed:\n${output || `exit ${run.status}`}`);
  if (output) console.error(output);
}

/** `plass export …`: exit 0 on a write, 1 on a failure, 2 on usage. */
export async function main(argv: string[]): Promise<number> {
  try {
    await exportCommand(argv);
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      console.error(e.message);
      return 2;
    }
    console.error(e instanceof Failure ? `plass: ${e.message}` : e);
    return 1;
  }
}

async function exportCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const say = (m: string) => {
    if (!args.quiet) console.error(m);
  };
  const input = resolve(args.input);
  if (!existsSync(input)) throw new Failure(`${args.input}: no such file`);
  const folder = dirname(input);
  const stem = basename(input, extname(input));
  const out = args.out ? resolve(args.out) : join(folder, `${stem}.pdf`);
  const wantTyp = extname(out).toLowerCase() === '.typ';
  if (!wantTyp && extname(out).toLowerCase() !== '.pdf') throw new Usage(`plass: --out is a .pdf or a .typ path, not ${basename(out)}`);
  if (wantTyp && args.perSheet === 2) throw new Usage('plass: --per-sheet 2 makes a PDF; it has no .typ form');

  const text = readFileSync(input, 'utf8');
  const opened = openMarkdown(text, (path) => {
    const p = isAbsolute(path) ? path : join(folder, path);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  });
  for (const w of opened.warnings) say(`warning: ${w}`);
  let doc = opened.doc;

  // Values: the named file, else values.json beside the document when the
  // document names a value. Named and absent is a failure; the default
  // file's absence is one only when the document needs it.
  const names = valueNames(doc);
  const valuesPath = args.values ? resolve(args.values) : join(folder, VALUES_FILE);
  if (args.values && !existsSync(valuesPath)) throw new Failure(`${args.values}: no such file`);
  if (existsSync(valuesPath)) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(valuesPath, 'utf8'));
    } catch (e) {
      throw new Failure(`${valuesPath} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const applied = applyValues(doc, data);
    doc = applied.doc;
    if (applied.missing.length) {
      const list = applied.missing.join(', ');
      if (!args.allowMissing) throw new Failure(`${basename(valuesPath)} has no value for ${list}; the document's last text would print. Add the keys, or pass --allow-missing.`);
      say(`warning: ${basename(valuesPath)} has no value for ${list}; the document's last text is printed`);
    }
    say(`values from ${valuesPath}${names.length ? ` (${names.length} key${names.length === 1 ? '' : 's'})` : ''}`);
  } else if (names.length) {
    if (!args.allowMissing) throw new Failure(`the document names ${names.length} value${names.length === 1 ? '' : 's'} (${names.join(', ')}) and there is no ${VALUES_FILE} beside it; name one with --values, or pass --allow-missing to print the document's text`);
    say(`warning: no ${VALUES_FILE}; the document's text is printed for ${names.join(', ')}`);
  }

  // The math converter must be up before the source is built: a formula
  // the converter rejects fails the export by name.
  await ensureMathConverter();
  let source: string;
  try {
    source = exportSource(doc);
  } catch (e) {
    if (e instanceof DataImageError || e instanceof MathConvertError) throw new Failure(e.message);
    throw e;
  }

  mkdirSync(dirname(out), { recursive: true });
  if (wantTyp) {
    writeFileSync(out, source);
    say(`wrote ${out}`);
    return;
  }

  const version = typstVersion(args.typst);
  if (version !== TYPST_EXACT_VERSION) say(`note: typst ${version}; the export is exact on ${TYPST_EXACT_VERSION}`);
  const scratch = mkdtempSync(join(tmpdir(), 'plass-export-'));
  try {
    if (args.perSheet === 1) {
      compile(args.typst, source, folder, out, scratch);
    } else {
      const single = join(scratch, 'document.pdf');
      compile(args.typst, source, folder, single, scratch);
      const pages = pdfPageCount(new Uint8Array(readFileSync(single)));
      if (!pages) throw new Failure('could not count the pages to put two to a sheet');
      const size = pageSize(doc.attrs.settings ?? DEFAULT_SETTINGS);
      compile(args.typst, twoUpSource('document.pdf', pages, size.w / 96, size.h / 96), scratch, out, scratch);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  say(`wrote ${out}`);
}
