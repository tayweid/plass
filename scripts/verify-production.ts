import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentSecurityPolicy } from '../src/security-policy';
import { MITEX_WASM_SHA256 } from '../src/math-convert';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Production security verification failed: ${message}`);
}

const dist = join(process.cwd(), 'dist');
const requiredNotices = [
  'LICENSE.txt',
  'THIRD_PARTY_NOTICES.txt',
  'SIDECAR_THIRD_PARTY_NOTICES.txt',
  'TYPST_WASM_THIRD_PARTY_NOTICES.txt',
  'sources/option-ext-0.2.0.crate',
  'fonts/README.md',
  'fonts/licenses/DejaVu-LICENSE.txt',
  'fonts/licenses/Libertinus-OFL.txt',
  'fonts/licenses/NewComputerModern-License.txt',
  'fonts/licenses/STIXTwo-OFL.txt',
  'fonts/licenses/TeX-Gyre-GUST-FONT-LICENSE.txt',
];
for (const path of requiredNotices) {
  assert(statSync(join(dist, path)).size > 100, `${path} is missing or empty`);
}
const projectLicense = readFileSync(join(process.cwd(), 'LICENSE'));
assert(
  projectLicense.equals(readFileSync(join(process.cwd(), 'public/LICENSE.txt'))),
  'public/LICENSE.txt must be byte-identical to the project LICENSE',
);
assert(
  projectLicense.equals(readFileSync(join(dist, 'LICENSE.txt'))),
  'the built LICENSE.txt must be byte-identical to the project LICENSE',
);
const mplSource = readFileSync(join(process.cwd(), 'public/sources/option-ext-0.2.0.crate'));
assert(
  createHash('sha256').update(mplSource).digest('hex') ===
    '04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d',
  'the distributed option-ext source archive has an unexpected digest',
);
assert(
  mplSource.equals(readFileSync(join(dist, 'sources/option-ext-0.2.0.crate'))),
  'the built option-ext source archive differs from the verified public copy',
);
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>;
assert(manifest.id === './', 'PWA manifest must have a stable relative app identity');
assert(manifest.start_url === './', 'PWA start URL must remain host-independent');
assert(manifest.scope === './', 'PWA scope must remain host-independent');
assert(manifest.display === 'standalone', 'PWA must launch in standalone display mode');
const tags = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/gi)];
assert(tags.length === 1, 'index.html must contain exactly one CSP meta element');
const builtPolicy = tags[0][1].replaceAll('&#39;', "'").replaceAll('&amp;', '&');
assert(builtPolicy === contentSecurityPolicy(), 'built CSP differs from the production policy source');
assert((tags[0].index ?? Infinity) < html.indexOf('<script'), 'CSP must precede every script element');
assert(!builtPolicy.includes('ws:'), 'production CSP must not permit WebSockets');
assert(!builtPolicy.includes(" 'unsafe-eval'"), 'production CSP must not permit JavaScript eval');
assert(/<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/i.test(html), 'no-referrer meta policy is missing');
const assetReferences = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/gi)]
  .map((match) => match[1])
  .filter((reference) => reference.includes('assets/'));
assert(assetReferences.length > 0, 'built HTML does not reference its bundled assets');
assert(
  assetReferences.every((reference) => reference.startsWith('./assets/')),
  'bundled assets must use host-independent relative paths',
);

const workerName = readdirSync(join(dist, 'assets')).find((name) => /^typst-compiler\.worker-.*\.js$/.test(name));
assert(workerName, 'isolated Typst worker artifact is missing');
const worker = readFileSync(join(dist, 'assets', workerName), 'utf8');
assert(worker.includes('../fonts/'), 'worker font base does not escape the assets directory');
assert(!/mitex-[\d.]+\.tar\.gz/.test(worker), 'worker must not name a Typst package archive: the compiler resolves none');
assert(worker.includes('Dynamic JavaScript construction is disabled'), 'worker fail-closed Function shim is missing');

// The math converter is the vendored mitex wasm, served from the build.
const mitexName = readdirSync(join(dist, 'assets')).find((name) => /^mitex-.*\.wasm$/.test(name));
assert(mitexName, 'math converter WASM artifact is missing');
const mitexWasm = readFileSync(join(dist, 'assets', mitexName));
assert(
  createHash('sha256').update(mitexWasm).digest('hex') === MITEX_WASM_SHA256 &&
    mitexWasm.equals(readFileSync(join(process.cwd(), 'src/mitex/mitex.wasm'))),
  'built math converter WASM differs from the pinned vendored file',
);
assert(
  readFileSync(join(dist, 'THIRD_PARTY_NOTICES.txt'), 'utf8').includes('mitex@0.2.7 (Apache-2.0), vendored'),
  'the distributed notices do not list the vendored mitex converter',
);

const sidecarName = readdirSync(join(dist, 'assets')).find((name) => /^typeset_sidecar_bg-.*\.wasm$/.test(name));
assert(sidecarName, 'line-breaking sidecar WASM artifact is missing');
assert(
  readFileSync(join(dist, 'assets', sidecarName)).equals(
    readFileSync(join(process.cwd(), 'sidecar/pkg/typeset_sidecar_bg.wasm')),
  ),
  'built sidecar WASM differs from the provenance-checked source artifact',
);


// The `plass` command as Plass.app carries it (cli/bundle.ts → dist/cli/
// plass.mjs, vite.cli.config.ts): one file beside the page, run here as
// the app's Electron runs it as Node, on a document with a value and a
// formula, finding the compiler, the fonts and the math converter among
// the page's files. The PDF it writes is checked as a PDF.
const command = join(dist, 'cli', 'plass.mjs');
assert(statSync(command).size > 100_000, 'dist/cli/plass.mjs, the plass command, is missing or empty');
const commandDir = readdirSync(join(dist, 'cli'));
assert(commandDir.length === 1, `dist/cli holds more than the command: ${commandDir.join(', ')}`);
const scratch = mkdtempSync(join(tmpdir(), 'plass-verify-'));
try {
  writeFileSync(join(scratch, 'notes.md'), '# Verified\n\nThe price is [4.5]{.value name="price" digits=2} and $x^2$ holds.^[A note.]\n');
  writeFileSync(join(scratch, 'values.json'), '{"price": 7.25}\n');
  const run = spawnSync(process.execPath, [command, 'export', join(scratch, 'notes.md'), '-o', join(scratch, 'out', 'notes.pdf')], { encoding: 'utf8' });
  assert(run.status === 0, `the plass command failed (${run.status}): ${run.stdout}${run.stderr}`);
  const pdf = readFileSync(join(scratch, 'out', 'notes.pdf'));
  assert(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')), 'the plass command wrote no PDF');
  assert(/LibertinusSerif-Regular|NewCM10-Regular|STIXTwoText-Regular|texgyrepagella-regular/i.test(pdf.toString('latin1')), 'the plass command did not print with the bundled fonts');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('production security artifact verified');
