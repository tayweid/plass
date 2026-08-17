import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const SIDECAR = join(ROOT, 'sidecar');
const PKG = join(SIDECAR, 'pkg');
const EXPECTED_RUSTC = 'rustc 1.97.0 (2d8144b78 2026-07-07)';
const EXPECTED_CARGO = 'cargo 1.97.0 (c980f4866 2026-06-30)';
const EXPECTED_WASM_PACK = 'wasm-pack 0.15.0';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Sidecar build failed: ${message}`);
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

function version(command: string): string {
  const result = spawnSync(command, ['--version'], { cwd: ROOT, encoding: 'utf8' });
  assert(result.status === 0, result.stderr.trim() || `${command} --version failed`);
  return result.stdout.trim();
}

const rustc = version('rustc');
const cargo = version('cargo');
const wasmPack = version('wasm-pack');
assert(rustc === EXPECTED_RUSTC, `expected ${EXPECTED_RUSTC}, got ${rustc}`);
assert(cargo === EXPECTED_CARGO, `expected ${EXPECTED_CARGO}, got ${cargo}`);
assert(wasmPack === EXPECTED_WASM_PACK, `expected ${EXPECTED_WASM_PACK}, got ${wasmPack}`);

const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
// rustc applies the last matching remap. Put broad roots first and the
// workspace last so a checkout below $HOME is always /src/plass on macOS and
// Linux; give a custom Cargo cache its own stable root as well.
const encodedRustflags = [
  `--remap-path-prefix=${homedir()}=/buildroot`,
  `--remap-path-prefix=${cargoHome}=/cargo`,
  `--remap-path-prefix=${ROOT}=/src/plass`,
].join('\x1f');
const buildEnv = {
  ...process.env,
  CARGO_ENCODED_RUSTFLAGS: encodedRustflags,
  SOURCE_DATE_EPOCH: '0',
};
// Do not let a caller silently change code generation while the provenance
// record continues to name the PATH toolchain above. A clean CI runner is the
// canonical environment; these removals make ordinary local rebuilds agree
// with it instead of inheriting common Cargo/rustc overrides.
for (const key of Object.keys(buildEnv)) {
  if (
    key === 'RUSTFLAGS' ||
    key === 'RUSTDOCFLAGS' ||
    key === 'CARGO_ENCODED_RUSTDOCFLAGS' ||
    key === 'RUSTC' ||
    key === 'RUSTC_WRAPPER' ||
    key === 'RUSTC_WORKSPACE_WRAPPER' ||
    key === 'RUSTDOC' ||
    key === 'CARGO_BUILD_RUSTC' ||
    key === 'CARGO_BUILD_RUSTC_WRAPPER' ||
    key === 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER' ||
    key === 'CARGO_BUILD_RUSTDOC' ||
    key === 'CARGO_BUILD_TARGET' ||
    key === 'CARGO_TARGET_DIR' ||
    key === 'CARGO_INCREMENTAL' ||
    key === 'CC' ||
    key === 'CFLAGS' ||
    key === 'AR' ||
    key === 'RANLIB' ||
    key.startsWith('CARGO_PROFILE_') ||
    /^CARGO_TARGET_.*_(?:RUSTFLAGS|LINKER|RUNNER)$/.test(key) ||
    key.startsWith('WASM_BINDGEN_')
  ) delete buildEnv[key];
}
buildEnv.CARGO_ENCODED_RUSTFLAGS = encodedRustflags;
buildEnv.SOURCE_DATE_EPOCH = '0';
const result = spawnSync(
  'wasm-pack',
  ['build', 'sidecar', '--target', 'web', '--release', '--', '--locked'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    env: buildEnv,
  },
);
assert(result.status === 0, 'wasm-pack build failed');

const projectLicense = readFileSync(join(ROOT, 'LICENSE'));
assert(projectLicense.equals(readFileSync(join(SIDECAR, 'LICENSE'))), 'sidecar/LICENSE differs from the project license');
writeFileSync(join(PKG, 'LICENSE'), projectLicense);

const packagePath = join(PKG, 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
assert(packageJson.name === 'typeset-sidecar', 'wasm-pack generated an unexpected package name');
assert(packageJson.version === '0.1.0', 'wasm-pack generated an unexpected package version');
assert(packageJson.license === 'MIT', 'wasm-pack did not preserve the MIT license');
packageJson.private = true;
const files = Array.isArray(packageJson.files) ? packageJson.files.filter((file): file is string => typeof file === 'string') : [];
for (const file of ['LICENSE', 'PROVENANCE.json']) if (!files.includes(file)) files.push(file);
packageJson.files = files;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(join(PKG, '.gitignore'), '*\n!.gitignore\n!LICENSE\n!PROVENANCE.json\n');

const artifactNames = [
  '.gitignore',
  'LICENSE',
  'package.json',
  'typeset_sidecar.d.ts',
  'typeset_sidecar.js',
  'typeset_sidecar_bg.wasm',
  'typeset_sidecar_bg.wasm.d.ts',
] as const;
const artifacts = Object.fromEntries(
  artifactNames.map((name) => [name, sha256(readFileSync(join(PKG, name)))]),
);
const provenance = {
  schema: 1,
  source: {
    cargoLockSha256: sha256(readFileSync(join(SIDECAR, 'Cargo.lock'))),
    cargoTomlSha256: sha256(readFileSync(join(SIDECAR, 'Cargo.toml'))),
    rustSourceSha256: sourceTreeSha256(),
  },
  toolchain: { cargo, rustc, wasmPack },
  build: {
    command: 'wasm-pack build sidecar --target web --release -- --locked',
    canonicalEnvironment: 'clean GitHub Actions ubuntu-latest runner',
    rustflags: [
      '--remap-path-prefix=<home>=/buildroot',
      '--remap-path-prefix=<cargo-home>=/cargo',
      '--remap-path-prefix=<workspace>=/src/plass',
    ],
    sourceDateEpoch: 0,
    target: 'wasm32-unknown-unknown',
  },
  artifacts,
};
writeFileSync(join(PKG, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`sidecar rebuilt: ${artifacts['typeset_sidecar_bg.wasm']}`);
