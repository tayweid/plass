// Export → Typst compiles outside Plass. Run: npm test
//
// The demo document is exported the way the Export menu does it
// (`docToTyp(doc, {islands: 'print', resolveImage})`, file-manager.ts
// exportCopy), its embedded image written to figures/ beside the .typ, and
// compiled by the typst command line with Plass's fonts. Exit 0 and not one
// warning or error, twice: with the CLI's bundled fonts allowed (the
// command the plan names) and with Plass's fonts only, `--ignore-embedded-
// fonts`, the command docs/MARKDOWN-FORMAT.md documents as exact, so a family
// the serializer emits that public/fonts lacks cannot pass by borrowing the
// CLI's own copy. This is the guard on the mitex pin: a typst release that
// breaks the pinned package fails here.
//
// Self-skipping: typst comes from $TYPST or PATH; absent, or a version other
// than 0.14.x (exact) or 0.15.x (compiles), it prints why and passes. So
// does a machine that cannot download the mitex package (offline, nothing
// cached). pdf.ts and figures.ts do not load under node (a ?worker import,
// a .css import), so the image is decoded here by its own few lines.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { demoDoc } from './demo-doc.ts';
import { docToTyp } from './typ-serializer.ts';
import { TYPST_EXACT_VERSION } from './typst-config.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? '\n' + detail : ''}`);
  }
}

const skip = (why: string): never => {
  console.log(`typ-export: skipped (${why})`);
  process.exit(0);
};

const typst = process.env.TYPST || 'typst';
const probe = spawnSync(typst, ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) skip('typst not found');
const version = /\b(\d+\.\d+\.\d+)\b/.exec(probe.stdout)?.[1] ?? probe.stdout.trim();
if (!/^0\.1[45]\./.test(version)) skip(`typst ${version}; the export is checked on 0.14.x and 0.15.x`);
console.log(`typ-export: typst ${version} (the export is exact on ${TYPST_EXACT_VERSION})`);

const fonts = fileURLToPath(new URL('../public/fonts', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'plass-typ-export-'));
mkdirSync(join(work, 'figures'));

// The app writes each distinct data: image once and links it by path
// (figures.ts dataUrlBytes + projectImagePath); this names them image-N.
const written = new Map<string, string>();
function resolveImage(src: string): string {
  const known = written.get(src);
  if (known) return known;
  const m = /^data:image\/(png|jpe?g|gif|svg\+xml)((?:;[^;,]*)*),(.*)$/is.exec(src);
  if (!m) return src;
  const ext = m[1] === 'svg+xml' ? 'svg' : m[1] === 'jpeg' ? 'jpg' : m[1];
  // Base64, or percent-encoded text (the demo's SVG is the latter).
  const bytes = /(?:^|;)base64(?:;|$)/i.test(m[2])
    ? Buffer.from(m[3], 'base64')
    : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  const path = `figures/image-${written.size + 1}.${ext}`;
  writeFileSync(join(work, path), bytes);
  written.set(src, path);
  return path;
}

const source = docToTyp(demoDoc(), { islands: 'print', resolveImage });
writeFileSync(join(work, 'demo.typ'), source);

check('the demo export carries an embedded image to write out', written.size > 0);
check('no data: image is left in the export', !/image\("data:/.test(source));
check(
  'the header names the version the export is exact on',
  source.startsWith(`// Exported from Plass — exact on typst ${TYPST_EXACT_VERSION}\n`),
  source.split('\n')[0],
);

const compile = (label: string, extra: string[]) => {
  const pdf = `demo-${label}.pdf`;
  const run = spawnSync(
    typst,
    ['compile', '--diagnostic-format', 'short', '--ignore-system-fonts', ...extra, '--font-path', fonts, 'demo.typ', pdf],
    { cwd: work, encoding: 'utf8' },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  if (!failures && /failed to download package/.test(output)) {
    rmSync(work, { recursive: true, force: true });
    skip(`could not download a package: ${output.split('\n')[0]}`);
  }
  const diagnostics = output.split('\n').filter((line) => /\b(warning|error):/.test(line));
  check(`${label}: typst compile exits 0`, run.status === 0, output);
  check(`${label}: no warning or error`, diagnostics.length === 0, diagnostics.join('\n'));
  let size = 0;
  try {
    size = statSync(join(work, pdf)).size;
  } catch {
    /* reported below */
  }
  check(`${label}: a PDF is written`, size > 0);
};

compile('bundled-fonts', []);
compile('plass-fonts-only', ['--ignore-embedded-fonts']);

if (failures) {
  console.error(`\n${failures} failure(s); the export is kept in ${work}`);
  process.exitCode = 1;
} else {
  rmSync(work, { recursive: true, force: true });
  console.log('\nall typ-export tests passed');
}
