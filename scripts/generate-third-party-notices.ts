import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

interface LockedPackage {
  version?: string;
  license?: string;
  dev?: boolean;
  optional?: boolean;
}

interface PackageLock {
  packages: Record<string, LockedPackage>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Third-party notice generation failed: ${message}`);
}

const root = process.cwd();
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as PackageLock;
const productionPackages = Object.entries(lock.packages)
  .filter(([path, entry]) => path.startsWith('node_modules/') && !entry.dev && !entry.optional)
  .map(([path, entry]) => ({ path, entry, name: path.slice('node_modules/'.length) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const groups = new Map<string, { source: string; packages: string[] }>();
for (const { path, entry, name } of productionPackages) {
  assert(entry.version, `${name} has no locked version`);
  assert(entry.license, `${name}@${entry.version} has no declared license`);
  const packageDir = join(root, path);
  let licenseFile = readdirSync(packageDir)
    .filter((file) => /^(?:licen[cs]e|copying|bsd)(?:[._-].*)?$/i.test(file))
    .sort((a, b) => (a === 'LICENSE' ? -1 : b === 'LICENSE' ? 1 : a.localeCompare(b)))[0];

  // The two wasm-only typst.ts packages are published from the same
  // Apache-2.0 repository but omit its license file from their npm tarballs.
  let licensePath = licenseFile ? join(packageDir, licenseFile) : '';
  if (!licensePath && name.startsWith('@myriaddreamin/typst-ts-')) {
    licensePath = join(root, 'node_modules/@myriaddreamin/typst.ts/LICENSE');
    licenseFile = '@myriaddreamin/typst.ts/LICENSE';
  }
  assert(licensePath, `${name}@${entry.version} has no distributable license text`);
  const text = readFileSync(licensePath, 'utf8')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  assert(text.length > 100, `${name}@${entry.version} has an empty or implausibly short license`);
  const existing = groups.get(text);
  const label = `${name}@${entry.version} (${entry.license})`;
  if (existing) existing.packages.push(label);
  else groups.set(text, { source: licenseFile || basename(licensePath), packages: [label] });
}

const divider = '='.repeat(78);
const sections = [...groups.entries()].map(([license, group]) => [
  divider,
  'Packages:',
  ...group.packages.map((pkg) => `- ${pkg}`),
  `License text source: ${group.source}`,
  '',
  license,
].join('\n'));
const output = [
  'PLASS THIRD-PARTY SOFTWARE NOTICES',
  '',
  'This generated file contains the license text shipped by every production',
  'npm package in package-lock.json. Regenerate it with `npm run generate:notices`.',
  'Bundled font licenses are kept separately under fonts/licenses/.',
  '',
  ...sections,
  '',
].join('\n');

const outputPath = join(root, 'public/THIRD_PARTY_NOTICES.txt');
if (process.argv.includes('--check')) {
  const current = readFileSync(outputPath, 'utf8');
  assert(current === output, 'public/THIRD_PARTY_NOTICES.txt is stale; run npm run generate:notices');
  console.log(`third-party notices verified for ${productionPackages.length} production packages`);
} else {
  writeFileSync(outputPath, output);
  console.log(`wrote notices for ${productionPackages.length} production packages`);
}
