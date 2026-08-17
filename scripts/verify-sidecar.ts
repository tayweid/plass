import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

interface Provenance {
  schema: number;
  source: { cargoLockSha256: string; cargoTomlSha256: string; rustSourceSha256: string };
  toolchain: { cargo: string; rustc: string; wasmPack: string };
  build: {
    command: string;
    canonicalEnvironment: string;
    rustflags: string[];
    sourceDateEpoch: number;
    target: string;
  };
  artifacts: Record<string, string>;
}

const ROOT = process.cwd();
const SIDECAR = join(ROOT, 'sidecar');
const PKG = join(SIDECAR, 'pkg');
const EXPECTED_RUSTC = 'rustc 1.97.0 (2d8144b78 2026-07-07)';
const EXPECTED_CARGO = 'cargo 1.97.0 (c980f4866 2026-06-30)';
const EXPECTED_WASM_PACK = 'wasm-pack 0.15.0';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Sidecar verification failed: ${message}`);
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function sourceTreeSha256(): string {
  const sourceRoot = join(SIDECAR, 'src');
  const files: string[] = [];
  const walk = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  };
  walk(sourceRoot);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(file).update('\0').update(readFileSync(join(sourceRoot, file))).update('\0');
  }
  return hash.digest('hex');
}

const provenance = JSON.parse(readFileSync(join(PKG, 'PROVENANCE.json'), 'utf8')) as Provenance;
assert(provenance.schema === 1, 'unknown provenance schema');
assert(provenance.toolchain.rustc === EXPECTED_RUSTC, 'unexpected Rust compiler provenance');
assert(provenance.toolchain.cargo === EXPECTED_CARGO, 'unexpected Cargo provenance');
assert(provenance.toolchain.wasmPack === EXPECTED_WASM_PACK, 'unexpected wasm-pack provenance');
assert(
  provenance.build.command === 'wasm-pack build sidecar --target web --release -- --locked',
  'unexpected sidecar build command',
);
assert(
  provenance.build.canonicalEnvironment === 'clean GitHub Actions ubuntu-latest runner',
  'unexpected canonical sidecar build environment',
);
assert(
  JSON.stringify(provenance.build.rustflags) === JSON.stringify([
    '--remap-path-prefix=<home>=/buildroot',
    '--remap-path-prefix=<cargo-home>=/cargo',
    '--remap-path-prefix=<workspace>=/src/plass',
  ]),
  'unexpected sidecar path-remapping provenance',
);
assert(provenance.build.sourceDateEpoch === 0, 'unexpected sidecar SOURCE_DATE_EPOCH provenance');
assert(provenance.build.target === 'wasm32-unknown-unknown', 'unexpected build target');

const cargoToml = readFileSync(join(SIDECAR, 'Cargo.toml'));
const cargoLock = readFileSync(join(SIDECAR, 'Cargo.lock'));
assert(sha256(cargoToml) === provenance.source.cargoTomlSha256, 'Cargo.toml differs from the built source');
assert(sha256(cargoLock) === provenance.source.cargoLockSha256, 'Cargo.lock differs from the built source');
assert(sourceTreeSha256() === provenance.source.rustSourceSha256, 'sidecar/src differs from the built source');
const manifestText = cargoToml.toString('utf8');
const lockText = cargoLock.toString('utf8');
assert(/hypher\s*=\s*"=0\.1\.6"/.test(manifestText), 'Cargo.toml must pin hypher 0.1.6');
assert(/name = "hypher"\nversion = "0\.1\.6"/.test(lockText), 'Cargo.lock must resolve hypher 0.1.6');

const projectLicense = readFileSync(join(ROOT, 'LICENSE'));
assert(projectLicense.equals(readFileSync(join(SIDECAR, 'LICENSE'))), 'sidecar/LICENSE differs from the project license');
assert(projectLicense.equals(readFileSync(join(PKG, 'LICENSE'))), 'sidecar package LICENSE differs from the project license');

const packageJson = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as Record<string, unknown>;
assert(packageJson.private === true, 'generated sidecar package must be private');
assert(packageJson.license === 'MIT', 'generated sidecar package must declare MIT');
assert(
  readFileSync(join(PKG, '.gitignore'), 'utf8') === '*\n!.gitignore\n!LICENSE\n!PROVENANCE.json\n',
  'generated sidecar package has a non-canonical .gitignore',
);

for (const [name, expected] of Object.entries(provenance.artifacts)) {
  assert(sha256(readFileSync(join(PKG, name))) === expected, `${name} differs from PROVENANCE.json`);
}

const wasm = readFileSync(join(PKG, 'typeset_sidecar_bg.wasm'));
assert(WebAssembly.validate(wasm), 'typeset_sidecar_bg.wasm is not valid WebAssembly');
assert(wasm.includes(Buffer.from('hypher-0.1.6')), 'WASM does not identify compiler-matching hypher 0.1.6');
assert(!wasm.includes(Buffer.from('hypher-0.1.5')), 'WASM still identifies stale hypher 0.1.5');
for (const forbidden of [ROOT, homedirMarker(), '/Users/', '/private/', '/home/']) {
  assert(!wasm.includes(Buffer.from(forbidden)), `WASM leaks a host path containing ${forbidden}`);
}

console.log(`sidecar source, provenance, and WASM verified (${sha256(wasm)})`);

function homedirMarker(): string {
  const home = process.env.HOME;
  return home && home.length > 1 ? home : '__NO_HOME__';
}
