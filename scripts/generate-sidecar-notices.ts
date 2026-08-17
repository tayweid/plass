import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  license: string | null;
  manifest_path: string;
  source: string | null;
}

interface CargoNode {
  id: string;
  dependencies: string[];
}

interface CargoMetadata {
  packages: CargoPackage[];
  resolve: { root: string; nodes: CargoNode[] };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Sidecar notice generation failed: ${message}`);
}

const root = process.cwd();
const result = spawnSync(
  'cargo',
  ['metadata', '--manifest-path', 'sidecar/Cargo.toml', '--locked', '--format-version', '1'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);
assert(result.status === 0, result.stderr.trim() || 'cargo metadata failed');
const metadata = JSON.parse(result.stdout) as CargoMetadata;
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const reachable = new Set<string>();
const visit = (id: string) => {
  if (reachable.has(id)) return;
  reachable.add(id);
  for (const dependency of nodes.get(id)?.dependencies ?? []) visit(dependency);
};
visit(metadata.resolve.root);

const packages = metadata.packages
  .filter((pkg) => reachable.has(pkg.id) && pkg.source)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
assert(packages.length > 0, 'Cargo resolved no external sidecar crates');

const licenseNames = /^(?:licen[cs]e|copying|notice|unlicense)(?:[._-].*)?$/i;
const groups = new Map<string, { source: string; packages: string[] }>();
for (const pkg of packages) {
  assert(pkg.license, `${pkg.name}@${pkg.version} has no declared license`);
  const directory = dirname(pkg.manifest_path);
  const files = readdirSync(directory).filter((file) => licenseNames.test(file)).sort();
  assert(files.length > 0, `${pkg.name}@${pkg.version} has no distributable license text`);
  for (const file of files) {
    const license = readFileSync(join(directory, file), 'utf8')
      .replaceAll('\r\n', '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
    assert(license.length > 100, `${pkg.name}@${pkg.version}/${file} is implausibly short`);
    const label = `${pkg.name}@${pkg.version} (${pkg.license})`;
    const existing = groups.get(license);
    if (existing) {
      if (!existing.packages.includes(label)) existing.packages.push(label);
    } else {
      groups.set(license, { source: file, packages: [label] });
    }
  }
}

const divider = '='.repeat(78);
const sections = [...groups.entries()].map(([license, group]) => [
  divider,
  'Crates:',
  ...group.packages.sort().map((pkg) => `- ${pkg}`),
  `License text source: ${group.source}`,
  '',
  license,
].join('\n'));
const output = [
  'PLASS TYPESET SIDECAR THIRD-PARTY NOTICES',
  '',
  'This generated file contains the license and notice texts shipped by every',
  'external Rust crate reachable from sidecar/Cargo.lock. Regenerate it with',
  '`npm run generate:notices` after changing the sidecar dependency graph.',
  '',
  ...sections,
  '',
].join('\n');

const outputPath = join(root, 'public/SIDECAR_THIRD_PARTY_NOTICES.txt');
if (process.argv.includes('--check')) {
  const current = readFileSync(outputPath, 'utf8');
  assert(current === output, 'public/SIDECAR_THIRD_PARTY_NOTICES.txt is stale');
  console.log(`sidecar notices verified for ${packages.length} Rust crates`);
} else {
  writeFileSync(outputPath, output);
  console.log(`wrote sidecar notices for ${packages.length} Rust crates`);
}
