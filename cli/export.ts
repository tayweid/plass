// plass export — the export from the command line (Taylor, 2026-11-06).
// cli/plass.js is the command in a checkout, dist/cli/plass.mjs (built
// from cli/bundle.ts) the one inside Plass.app; this is what both run.
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
// the PDF is the app's own export: the same Typst source (docToTyp), the
// same compiler (typst.ts's wasm, src/typst-node.ts) and the same fonts
// Export › PDF uses, so the bytes are the app's. A value the values file
// has no key for is refused by name (the file's last text would print,
// silently stale) unless `--allow-missing` says to print it. Figures are
// files beside the document (figures/plot.svg), read into the compiler's
// filesystem at the same path, as the app reads them from its folder; one
// not there is refused by name (the app's export prints a placeholder and
// says so; a script cannot be told).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { applyValues, DataImageError, exportSource, openMarkdown, valueNames } from '../src/headless-export.ts';
import { ensureMathConverter, MathConvertError } from '../src/math-convert.ts';
import { pdfPageCount, twoUpSource } from '../src/pdf-sheets.ts';
import { DEFAULT_SETTINGS, pageSize } from '../src/settings.ts';
import { TYPST_EXACT_VERSION } from '../src/typst-config.ts';
import { type CompilerResources, compilePdf } from '../src/typst-node.ts';
import { COMPILER_LIMITS, type CompilerAsset, isValidAssetPath } from '../src/typst-worker-protocol.ts';
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
  -q, --quiet            only errors
  -h, --help

The document is read as Plass opens it and the PDF is the one Plass's
Export makes: its own compiler (typst ${TYPST_EXACT_VERSION}) and fonts.`;

class Usage extends Error {}
class Failure extends Error {}

/** The files the command compiles with: the compiler's, and the math
 *  converter's wasm (src/mitex/mitex.wasm, digest-checked on load). */
export interface CliResources extends CompilerResources {
  mitexWasm: string;
}

interface Args {
  input: string;
  out: string | null;
  values: string | null;
  allowMissing: boolean;
  perSheet: 1 | 2;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') throw new Usage(USAGE);
  if (argv[0] !== 'export') throw new Usage(`plass: unknown command ${JSON.stringify(argv[0])}\n\n${USAGE}`);
  const args: Args = { input: '', out: null, values: null, allowMissing: false, perSheet: 1, quiet: false };
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
    } else if (a === '-q' || a === '--quiet') args.quiet = true;
    else if (a.startsWith('-')) throw new Usage(`plass: unknown option ${a}\n\n${USAGE}`);
    else if (args.input) throw new Usage(`plass: one document at a time (${args.input} and ${a})\n\n${USAGE}`);
    else args.input = a;
  }
  if (!args.input) throw new Usage(`plass: no document named\n\n${USAGE}`);
  if (extname(args.input).toLowerCase() !== '.md') throw new Usage(`plass: ${args.input} is not a .md file (a legacy .typ is not exported from the command line)`);
  return args;
}

/** The document's images as the compiler's files, as pdf.ts prepares them
 *  for the app's export: a file beside the document at its own path, so
 *  the source's `image("figures/x.png")` is the same for the PDF and for
 *  `-o notes.typ`. What the app would print as a placeholder (a file not
 *  there, an image on the web it has not been told to load) is refused by
 *  name here, and an image kept inside the document (a `data:` URL, which
 *  a saved file never holds) by `exportSource`. */
function prepareAssets(doc: import('prosemirror-model').Node, folder: string): CompilerAsset[] {
  const srcs = new Set<string>();
  doc.descendants((node) => {
    if ((node.type.name === 'figure' || node.type.name === 'image') && node.attrs.src) srcs.add(node.attrs.src as string);
    return true;
  });
  const assets: CompilerAsset[] = [];
  let total = 0;
  for (const src of srcs) {
    if (/^data:/i.test(src)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) throw new Failure(`an image is on the web (${src}), not a file beside the document: save it beside the document and refer to it by its path`);
    if (!isValidAssetPath(`/${src}`)) throw new Failure(`an image's path leaves the document's folder (${src}): keep figures beside the document`);
    const file = join(folder, src);
    if (!existsSync(file)) throw new Failure(`${src}: no such image beside the document`);
    const data = new Uint8Array(readFileSync(file));
    if (data.byteLength > COMPILER_LIMITS.assetBytes) throw new Failure(`${src} exceeds the 20 MiB image limit`);
    total += data.byteLength;
    if (total > COMPILER_LIMITS.totalAssetBytes) throw new Failure('the document\'s images exceed the 64 MiB limit');
    assets.push({ path: `/${src}`, data });
    if (assets.length > COMPILER_LIMITS.assetCount) throw new Failure(`the document has more than ${COMPILER_LIMITS.assetCount} images`);
  }
  return assets;
}

/** `plass export …`: exit 0 on a write, 1 on a failure, 2 on usage. */
export async function main(argv: string[], resources: CliResources): Promise<number> {
  try {
    await exportCommand(argv, resources);
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

async function exportCommand(argv: string[], resources: CliResources): Promise<void> {
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
  await ensureMathConverter(async () => {
    const data = readFileSync(resources.mitexWasm);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  });
  let source: string;
  let assets: CompilerAsset[];
  try {
    assets = prepareAssets(doc, folder);
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

  let pdf: Uint8Array;
  try {
    pdf = await compilePdf(source, assets, resources);
    if (args.perSheet === 2) {
      const pages = pdfPageCount(pdf);
      if (!pages) throw new Failure('could not count the pages to put two to a sheet');
      const size = pageSize(doc.attrs.settings ?? DEFAULT_SETTINGS);
      pdf = await compilePdf(twoUpSource('/document.pdf', pages, size.w / 96, size.h / 96), [{ path: '/document.pdf', data: pdf }], resources);
    }
  } catch (e) {
    if (e instanceof Failure) throw e;
    throw new Failure(`the compile failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  writeFileSync(out, pdf);
  say(`wrote ${out}`);
}
