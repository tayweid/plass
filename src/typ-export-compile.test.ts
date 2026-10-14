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
// CLI's own copy. The export's math is native Typst with its handles
// defined in the header, so it needs no package: the compile runs with an
// empty package cache and package path, and must not download anything.
//
// The demo is extended first with what the print form exists for, which
// the starter document does not hold: a raw-Typst island and an inline
// Typst span that would stop the compile (`#panic`) if they ran, a Markdown
// island, an editorial comment that must not be printed, a plain code
// block, a grid and a page break.
//
// Self-skipping: typst comes from $TYPST or PATH; absent, or a version other
// than 0.14.x (exact) or 0.15.x (compiles), it prints why and passes.
// pdf.ts and figures.ts do not load under node (a ?worker import,
// a .css import), so the image is decoded here by its own few lines.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Node as PMNode } from 'prosemirror-model';
import { demoDoc } from './demo-doc.ts';
import { schema } from './schema.ts';
import { docToTyp } from './typ-serializer.ts';
import { TYPST_EXACT_VERSION } from './typst-config.ts';
import { ensureMathConverter } from './math-convert.ts';

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
// The CLI's package cache and local package path, both empty: a package
// the export needed could come only from a download, which fails the run.
mkdirSync(join(work, 'no-packages'));
const noPackages = { ...process.env, TYPST_PACKAGE_CACHE_PATH: join(work, 'no-packages'), TYPST_PACKAGE_PATH: join(work, 'no-packages') };
await ensureMathConverter();

// The app writes each distinct data: image once and links it by path
// (figures.ts dataUrlBytes + projectImagePath); this names them image-N.
const written = new Map<string, string>();
function resolveImage(src: string): string {
  const known = written.get(src);
  if (known) return known;
  const m = /^data:image\/(png|jpe?g|gif|svg\+xml)((?:;[^;,]*)*),(.*)$/is.exec(src);
  if (!m) return src;
  const type = m[1].toLowerCase();
  const ext = type === 'svg+xml' ? 'svg' : type === 'jpeg' ? 'jpg' : type;
  // Base64, or percent-encoded text (the demo's SVG is the latter).
  const bytes = /(?:^|;)base64(?:;|$)/i.test(m[2])
    ? Buffer.from(m[3], 'base64')
    : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  const path = `figures/image-${written.size + 1}.${ext}`;
  writeFileSync(join(work, path), bytes);
  written.set(src, path);
  return path;
}

// The demo with the print-form cases placed before its bibliography.
function exportedDoc(): PMNode {
  const demo = demoDoc();
  const n = schema.nodes;
  const para = (...content: PMNode[]) => n.paragraph.create(null, content);
  const extra = [
    n.editor_comment.create(null, schema.text('Check the sign before posting. #panic("an editorial comment printed")')),
    n.code_block.create(
      { params: 'typst-raw' },
      schema.text('#let width = 3cm\n#panic("a raw-Typst island ran")\n```inner fence```'),
    ),
    para(
      schema.text('An inline span stays code: '),
      n.typst_inline.create({ src: '#panic("an inline Typst span ran")' }),
      schema.text('.'),
    ),
    n.code_block.create({ params: 'md-raw' }, schema.text('<div class="note">\n<!-- a remark kept as code -->\n</div>')),
    n.code_block.create({ params: 'python' }, schema.text('print("a plain code block")')),
    n.grid.create({ columns: [1, 2], gutter: 1 }, [
      n.grid_row.create(null, [
        n.grid_cell.create(null, [para(schema.text('Left cell.'))]),
        n.grid_cell.create(null, [para(schema.text('Right cell, twice as wide.'))]),
      ]),
    ]),
    n.page_break.create(),
    para(schema.text('After the page break.')),
  ];
  const blocks: PMNode[] = [];
  demo.forEach((child) => blocks.push(child));
  const bibliography = blocks.pop()!;
  const doc = demo.type.create(demo.attrs, [...blocks, ...extra, bibliography]);
  doc.check();
  return doc;
}

const source = docToTyp(exportedDoc(), { islands: 'print', resolveImage });
writeFileSync(join(work, 'demo.typ'), source);

check('the demo export carries an embedded image to write out', written.size > 0);
check('no data: image is left in the export', !/image\("data:/.test(source));
check('the editorial comment is left out', !source.includes('plass:comment') && !source.includes('Check the sign'));
check('the raw-Typst island prints as code', /\n(`{3,})\n#let width = 3cm\n#panic\("a raw-Typst island ran"\)\n```inner fence```\n\1\n/.test(source));
check('the inline Typst span prints as inline raw', source.includes('#raw("#panic(\\"an inline Typst span ran\\")")'));
check('the Markdown island prints as code', source.includes('```\n<div class="note">\n<!-- a remark kept as code -->\n</div>\n```'));
check('the grid and the page break are in the export', source.includes('#grid(') && source.includes('#pagebreak()'));
check(
  'the math is native Typst: no package import, no #mi/#mitex call',
  !source.includes('#import') && !/#mi(?:tex)?\(/.test(source) && /\$e \^\(i pi \) \+  1  =  0 \$/.test(source),
);
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
    { cwd: work, encoding: 'utf8', env: noPackages },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  check(`${label}: nothing is downloaded`, !/download/i.test(output), output);
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
