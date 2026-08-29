import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { contentSecurityPolicy } from '../src/security-policy';
import { TYPST_PACKAGE_POLICY } from '../src/typst-config';

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
assert(worker.includes(TYPST_PACKAGE_POLICY.url), 'worker does not contain the exact pinned package URL');
assert(worker.includes(TYPST_PACKAGE_POLICY.sha256), 'worker does not contain the pinned package digest');
assert(worker.includes('Dynamic JavaScript construction is disabled'), 'worker fail-closed Function shim is missing');

const sidecarName = readdirSync(join(dist, 'assets')).find((name) => /^typeset_sidecar_bg-.*\.wasm$/.test(name));
assert(sidecarName, 'line-breaking sidecar WASM artifact is missing');
assert(
  readFileSync(join(dist, 'assets', sidecarName)).equals(
    readFileSync(join(process.cwd(), 'sidecar/pkg/typeset_sidecar_bg.wasm')),
  ),
  'built sidecar WASM differs from the provenance-checked source artifact',
);

console.log('production security artifact verified');
