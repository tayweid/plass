import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

interface LockedNpmPackage {
  integrity?: string;
  license?: string;
  resolved?: string;
  version?: string;
}

interface PackageLock {
  packages: Record<string, LockedNpmPackage>;
}

interface CargoDepKind {
  kind: 'dev' | 'build' | null;
}

interface CargoDependency {
  pkg: string;
  dep_kinds: CargoDepKind[];
}

interface CargoNode {
  id: string;
  dependencies: string[];
  deps: CargoDependency[];
  features: string[];
}

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  authors: string[];
  license: string | null;
  license_file: string | null;
  manifest_path: string;
  repository: string | null;
  source: string | null;
}

interface CargoMetadata {
  packages: CargoPackage[];
  resolve: { root: string | null; nodes: CargoNode[] } | null;
}

interface NpmPin {
  integrity: string;
  name: string;
  resolved: string;
  version: string;
  wasm?: { path: string; sha256: string };
}

interface WasmRoot {
  features: string[];
  manifest: string;
  packageName: string;
}

interface LicenseGroup {
  packages: Set<string>;
  sources: Set<string>;
  text: string;
}

interface PinnedArchive {
  commit: string;
  filename: string;
  repository: string;
  root: string;
  sha256: string;
  url: string;
}

interface PinnedLicenseFile {
  archive?: string;
  path?: string;
  raw?: string;
}

interface RepositoryLicenseFallback {
  archives: string[];
  files: PinnedLicenseFile[];
  note?: string;
  packages: string[];
}

const root = process.cwd();
const outputPath = join(root, 'public/TYPST_WASM_THIRD_PARTY_NOTICES.txt');
const target = 'wasm32-unknown-unknown';
const sourceProvenance = {
  archiveRoot: 'typst.ts-61cd6bdf5c08f508ce63406f58a92b0971ee84b8',
  archiveSha256: '3fd0d8c2a9905172e384d442c6fab8f59bfba018990527ece3a1bef34f068028',
  archiveUrl: 'https://codeload.github.com/Myriad-Dreamin/typst.ts/tar.gz/61cd6bdf5c08f508ce63406f58a92b0971ee84b8',
  cargoLockSha256: '4fc60dd9870345092d77720da8d1b767d1370e9c180771e46de30c02004dcd46',
  commit: '61cd6bdf5c08f508ce63406f58a92b0971ee84b8',
  repository: 'https://github.com/Myriad-Dreamin/typst.ts',
};
const npmPins: NpmPin[] = [
  {
    name: '@myriaddreamin/typst-ts-renderer',
    version: '0.7.0',
    resolved: 'https://registry.npmjs.org/@myriaddreamin/typst-ts-renderer/-/typst-ts-renderer-0.7.0.tgz',
    integrity: 'sha512-3sXIGxZn9MufPrPn6251DeuLf2FIEILYNzY5lX0XOJmaIYqgvQ3qpfqkCjgQD+splBvt5R1N3BuuNFrZKsHhMw==',
    wasm: {
      path: 'node_modules/@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm',
      sha256: '5a93d7a8b3b7b43b0e679f3dafed966f74fc1653cc7ed6623f04a8a6550da725',
    },
  },
  {
    name: '@myriaddreamin/typst-ts-web-compiler',
    version: '0.7.0',
    resolved: 'https://registry.npmjs.org/@myriaddreamin/typst-ts-web-compiler/-/typst-ts-web-compiler-0.7.0.tgz',
    integrity: 'sha512-nMwMcfOBy5pABPDuVM7/u8425SxhPUM+OJe6daqqgVOT3+neCTz4JKwx2L8XasfEHTNvd0cUI07LR9q5ADo7Gw==',
    wasm: {
      path: 'node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm',
      sha256: '1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd',
    },
  },
  {
    name: '@myriaddreamin/typst.ts',
    version: '0.7.0',
    resolved: 'https://registry.npmjs.org/@myriaddreamin/typst.ts/-/typst.ts-0.7.0.tgz',
    integrity: 'sha512-JtO5Td/1QesH1IBKAZtbayFNK8u2sl3iz18Y67uYqBEdcXiu3z+wpZcDDKlmVJvAcCgSjHTnuk6ZLfkYclrGGQ==',
  },
];
const wasmRoots: WasmRoot[] = [
  {
    packageName: 'typst-ts-web-compiler',
    manifest: 'packages/compiler/Cargo.toml',
    features: ['web', 'misc'],
  },
  {
    packageName: 'typst-ts-renderer',
    manifest: 'packages/renderer/Cargo.toml',
    features: ['web'],
  },
];

// Some crates.io packages were cut from workspaces whose repository-root
// license files were omitted from the published crate archive. Each fallback
// below is tied to the exact VCS revision recorded in `.cargo_vcs_info.json`.
// The three repositories that omit license text even at that revision use
// canonical SPDX texts pinned to an immutable license-list-data commit.
const pinnedArchives: Record<string, PinnedArchive> = {
  codespan: {
    filename: 'codespan.tar.gz',
    repository: 'https://github.com/brendanzab/codespan',
    commit: 'fd389a13f5bb6d625b71e2e4694b26e127f393f9',
    url: 'https://codeload.github.com/brendanzab/codespan/tar.gz/fd389a13f5bb6d625b71e2e4694b26e127f393f9',
    sha256: '4a4a9377603e62d2c02d48f327fac178415723c69f1349767d32a4462865b5b4',
    root: 'codespan-fd389a13f5bb6d625b71e2e4694b26e127f393f9',
  },
  comemo: {
    filename: 'comemo.tar.gz',
    repository: 'https://github.com/typst/comemo',
    commit: '967dc012b5e0600b7841aa77ab2785ae70fca226',
    url: 'https://codeload.github.com/typst/comemo/tar.gz/967dc012b5e0600b7841aa77ab2785ae70fca226',
    sha256: 'dd26bac970be785a439f05cfccde09e15b4c5261b768427bbe2e825fe948e512',
    root: 'comemo-967dc012b5e0600b7841aa77ab2785ae70fca226',
  },
  fxhash: {
    filename: 'fxhash.tar.gz',
    repository: 'https://github.com/cbreeden/fxhash',
    commit: 'a03cbf42dde010250adef75908f109be197d982b',
    url: 'https://codeload.github.com/cbreeden/fxhash/tar.gz/a03cbf42dde010250adef75908f109be197d982b',
    sha256: '4dbf2beb2734c8fb05cfb21de325eb208614a1dde8ffcece80fc94b0f2775acf',
    root: 'fxhash-a03cbf42dde010250adef75908f109be197d982b',
  },
  glidesort: {
    filename: 'glidesort.tar.gz',
    repository: 'https://github.com/orlp/glidesort',
    commit: 'c4df9518ec23a424a867b3d50967f0aaafe3c0fd',
    url: 'https://codeload.github.com/orlp/glidesort/tar.gz/c4df9518ec23a424a867b3d50967f0aaafe3c0fd',
    sha256: 'f7b01ecb077689763d80ce6897b700b594a228d018f2734d95fe69098ff6fa1b',
    root: 'glidesort-c4df9518ec23a424a867b3d50967f0aaafe3c0fd',
  },
  hayro: {
    filename: 'hayro.tar.gz',
    repository: 'https://github.com/LaurenzV/hayro',
    commit: 'd0b540fc9ab8e18b4a7a000d1404139af8e9d023',
    url: 'https://codeload.github.com/LaurenzV/hayro/tar.gz/d0b540fc9ab8e18b4a7a000d1404139af8e9d023',
    sha256: '290df5bbcdfa5bc1b9d84a84c39a707c4d8d92220ed536f2f0d373181d637108',
    root: 'hayro-d0b540fc9ab8e18b4a7a000d1404139af8e9d023',
  },
  krilla: {
    filename: 'krilla.tar.gz',
    repository: 'https://github.com/LaurenzV/krilla',
    commit: 'f2a370f2f56d2ba3ccef549eba5d2327242a40fd',
    url: 'https://codeload.github.com/LaurenzV/krilla/tar.gz/f2a370f2f56d2ba3ccef549eba5d2327242a40fd',
    sha256: '78c8ff9e177ba2148cfc8eca36ae1513d04d27fd309c7ea4072d142a6d0e6e28',
    root: 'krilla-f2a370f2f56d2ba3ccef549eba5d2327242a40fd',
  },
  qcms: {
    filename: 'qcms.tar.gz',
    repository: 'https://github.com/FirefoxGraphics/qcms',
    commit: '5ba6ed804b59273afc37794d5b04d27fb8835e48',
    url: 'https://codeload.github.com/FirefoxGraphics/qcms/tar.gz/5ba6ed804b59273afc37794d5b04d27fb8835e48',
    sha256: 'c85de0457ba6d194c88457cf56cf7f1911bf1e4dda36160bf0b2f7123837b2d0',
    root: 'qcms-5ba6ed804b59273afc37794d5b04d27fb8835e48',
  },
  romanNumerals: {
    filename: 'roman-numerals.tar.gz',
    repository: 'https://github.com/AA-Turner/roman-numerals',
    commit: 'ec81337f99d8b557a6fce10f674c054050551444',
    url: 'https://codeload.github.com/AA-Turner/roman-numerals/tar.gz/ec81337f99d8b557a6fce10f674c054050551444',
    sha256: 'f522f42805cc961e2a8d92ef2497d9836282c709ca2eb348e196808dc4e3fdb9',
    root: 'roman-numerals-ec81337f99d8b557a6fce10f674c054050551444',
  },
  seahash: {
    filename: 'seahash.tar.gz',
    repository: 'https://gitlab.redox-os.org/redox-os/seahash',
    commit: '94b632aeac099031c373599313d5b5f0acbbaec0',
    url: 'https://gitlab.redox-os.org/redox-os/seahash/-/archive/94b632aeac099031c373599313d5b5f0acbbaec0/seahash-94b632aeac099031c373599313d5b5f0acbbaec0.tar.gz',
    sha256: 'c94a735407fa35d3b4c999c910f4a0532a7f00b405b38c78ce2eebc42aee47b7',
    root: 'seahash-94b632aeac099031c373599313d5b5f0acbbaec0',
  },
  wasmTools: {
    filename: 'wasm-tools.tar.gz',
    repository: 'https://github.com/bytecodealliance/wasm-tools',
    commit: 'e66235859a6ec0502bf6f9dcc358953eda4cafcc',
    url: 'https://codeload.github.com/bytecodealliance/wasm-tools/tar.gz/e66235859a6ec0502bf6f9dcc358953eda4cafcc',
    sha256: 'ceaf30057c40670b315e483940834d01dde9bd1a306b385b0b4fb34a327fb1a2',
    root: 'wasm-tools-e66235859a6ec0502bf6f9dcc358953eda4cafcc',
  },
  wasmi: {
    filename: 'wasmi.tar.gz',
    repository: 'https://github.com/wasmi-labs/wasmi',
    commit: '60505fb66822e9b2f28c9aa7031b8e74fec7c005',
    url: 'https://codeload.github.com/wasmi-labs/wasmi/tar.gz/60505fb66822e9b2f28c9aa7031b8e74fec7c005',
    sha256: '1e03dec7f5e8553d9b40410ce4204e9b6d9311db5e3b5bbead5cdaa67f7d5be2',
    root: 'wasmi-60505fb66822e9b2f28c9aa7031b8e74fec7c005',
  },
  zuneCore: {
    filename: 'zune-core.tar.gz',
    repository: 'https://github.com/etemesi254/zune-image',
    commit: 'f8fbb123d5ed04441e8324a555bfcda0cb1bd28f',
    url: 'https://codeload.github.com/etemesi254/zune-image/tar.gz/f8fbb123d5ed04441e8324a555bfcda0cb1bd28f',
    sha256: '40e5e8c59763841abb83c9c26c7bbe41c9674f93e381bfd5dd2c68b55f9d2b68',
    root: 'zune-image-f8fbb123d5ed04441e8324a555bfcda0cb1bd28f',
  },
};
const pinnedRawLicenseFiles = {
  spdxApache: {
    filename: 'SPDX-Apache-2.0.txt',
    source: 'SPDX license-list-data@5bf6d9610255540bfbee6890765a616042bf1e11/text/Apache-2.0.txt',
    url: 'https://raw.githubusercontent.com/spdx/license-list-data/5bf6d9610255540bfbee6890765a616042bf1e11/text/Apache-2.0.txt',
    sha256: '074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff',
  },
  spdxMit: {
    filename: 'SPDX-MIT.txt',
    source: 'SPDX license-list-data@5bf6d9610255540bfbee6890765a616042bf1e11/text/MIT.txt',
    url: 'https://raw.githubusercontent.com/spdx/license-list-data/5bf6d9610255540bfbee6890765a616042bf1e11/text/MIT.txt',
    sha256: 'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5',
  },
  zuneJpegLicense: {
    filename: 'zune-jpeg-LICENSE.md',
    source: 'zune-image@fa2c767a01d7d9373911d0bf63e0588553d67e0e/LICENSE.md',
    url: 'https://raw.githubusercontent.com/etemesi254/zune-image/fa2c767a01d7d9373911d0bf63e0588553d67e0e/LICENSE.md',
    sha256: 'c6dff146a9f31848ac296faa5a08a4253caf2c384c86f906dc99e7fc0a39cc8c',
  },
  zuneJpegZlib: {
    filename: 'zune-jpeg-LICENSE-ZLIB',
    source: 'zune-image@fa2c767a01d7d9373911d0bf63e0588553d67e0e/LICENSE-ZLIB',
    url: 'https://raw.githubusercontent.com/etemesi254/zune-image/fa2c767a01d7d9373911d0bf63e0588553d67e0e/LICENSE-ZLIB',
    sha256: '7fa429541e55b1509909e058f2d21a37467e4958ec713b357f6e0cf9dc4ee352',
  },
} as const;
const repositoryLicenseFallbacks: RepositoryLicenseFallback[] = [
  { packages: ['codespan-reporting@0.11.1'], archives: ['codespan'], files: [{ archive: 'codespan', path: 'LICENSE' }] },
  { packages: ['comemo-macros@0.5.0'], archives: ['comemo'], files: [{ archive: 'comemo', path: 'LICENSE-APACHE' }, { archive: 'comemo', path: 'LICENSE-MIT' }] },
  {
    packages: ['fxhash@0.2.1'],
    archives: ['fxhash'],
    files: [{ raw: 'spdxApache' }, { raw: 'spdxMit' }],
    note: 'The authenticated repository omits both declared standard license files, so canonical SPDX texts are included. The published crate also omits Cargo VCS metadata: the pinned repository revision is authenticated, but cannot be proven to be the publication revision.',
  },
  {
    packages: ['glidesort@0.1.2'],
    archives: ['glidesort'],
    files: [{ raw: 'spdxApache' }, { raw: 'spdxMit' }],
    note: 'The authenticated repository omits both declared standard license files; canonical SPDX texts are included.',
  },
  {
    packages: ['hayro@0.4.0', 'hayro-interpret@0.4.0', 'hayro-svg@0.2.0', 'hayro-write@0.3.0'],
    archives: ['hayro'],
    files: [{ archive: 'hayro', path: 'LICENSE_APACHE' }, { archive: 'hayro', path: 'NOTICE.md' }],
  },
  {
    packages: ['krilla@0.6.0', 'krilla-svg@0.3.0'],
    archives: ['krilla'],
    files: [{ archive: 'krilla', path: 'LICENSE_APACHE' }, { archive: 'krilla', path: 'LICENSE_MIT' }, { archive: 'krilla', path: 'NOTICE.md' }],
  },
  { packages: ['qcms@0.3.0'], archives: ['qcms'], files: [{ archive: 'qcms', path: 'COPYING' }] },
  { packages: ['roman-numerals-rs@3.1.0'], archives: ['romanNumerals'], files: [{ archive: 'romanNumerals', path: 'LICENCE.rst' }] },
  {
    packages: ['seahash@4.1.0'],
    archives: ['seahash'],
    files: [{ raw: 'spdxMit' }],
    note: 'The authenticated repository omits its declared MIT file; the canonical SPDX text is included.',
  },
  {
    packages: ['wasmi@0.51.5', 'wasmi_collections@0.51.5', 'wasmi_core@0.51.5', 'wasmi_ir@0.51.5'],
    archives: ['wasmi'],
    files: [{ archive: 'wasmi', path: 'LICENSE-APACHE' }, { archive: 'wasmi', path: 'LICENSE-MIT' }],
  },
  {
    packages: ['wasmparser@0.228.0'],
    archives: ['wasmTools'],
    files: [
      { archive: 'wasmTools', path: 'LICENSE-APACHE' },
      { archive: 'wasmTools', path: 'LICENSE-Apache-2.0_WITH_LLVM-exception' },
      { archive: 'wasmTools', path: 'LICENSE-MIT' },
    ],
  },
  {
    packages: ['zune-core@0.4.12'],
    archives: ['zuneCore'],
    files: [
      { archive: 'zuneCore', path: 'LICENSE.md' },
      { archive: 'zuneCore', path: 'LICENSE-ZLIB' },
      { raw: 'spdxApache' },
      { raw: 'spdxMit' },
    ],
    note: 'The repository attribution file links to, but omits, Apache-2.0 and MIT terms; canonical SPDX texts are included.',
  },
  {
    packages: ['zune-jpeg@0.4.21'],
    archives: [],
    files: [{ raw: 'zuneJpegLicense' }, { raw: 'zuneJpegZlib' }, { raw: 'spdxApache' }, { raw: 'spdxMit' }],
    note: 'The repository attribution file links to, but omits, Apache-2.0 and MIT terms; canonical SPDX texts are included.',
  },
];
const mplSourceAvailability = {
  package: 'option-ext@0.2.0',
  license: 'MPL-2.0',
  distributedPath: 'sources/option-ext-0.2.0.crate',
  archiveUrl: 'https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate',
  archiveSha256: '04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d',
  repository: 'https://github.com/soc/option-ext',
};

// This is the digest of the complete generated notice. Updating the pinned
// Typst distribution must deliberately update the provenance above, regenerate
// the notice from the authenticated source archive, and then update this pin.
const expectedNoticeSha256 = '9f62ea6f0c3e512d931f0d0098c51f620af5f788b289c4c4a986442350333eb6';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Typst WASM notice verification failed: ${message}`);
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function normalizeText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function repositoryUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value.replace(/^git\+/, '').replace(/\.git$/, '');
  if (value && typeof value === 'object' && 'url' in value && typeof value.url === 'string') {
    return value.url.replace(/^git\+/, '').replace(/\.git$/, '');
  }
  return undefined;
}

function verifyInstalledDistribution(): void {
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as PackageLock;
  for (const pin of npmPins) {
    assert(
      rootPackage.dependencies?.[pin.name] === pin.version,
      `${pin.name} must be pinned exactly to ${pin.version} in package.json`,
    );
    const lockPath = `node_modules/${pin.name}`;
    const locked = lock.packages[lockPath];
    assert(locked, `${pin.name} is absent from package-lock.json`);
    assert(locked.version === pin.version, `${pin.name} must remain locked at ${pin.version}`);
    assert(locked.resolved === pin.resolved, `${pin.name}@${pin.version} has an unexpected npm tarball URL`);
    assert(locked.integrity === pin.integrity, `${pin.name}@${pin.version} has an unexpected npm integrity`);
    assert(locked.license === 'Apache-2.0', `${pin.name}@${pin.version} must declare Apache-2.0`);

    const packagePath = join(root, lockPath, 'package.json');
    assert(existsSync(packagePath), `${pin.name}@${pin.version} is not installed`);
    const installed = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    assert(installed.name === pin.name, `${lockPath}/package.json has an unexpected package name`);
    assert(installed.version === pin.version, `${pin.name} installed version differs from package-lock.json`);
    assert(installed.license === 'Apache-2.0', `${pin.name} installed package must declare Apache-2.0`);
    assert(
      repositoryUrl(installed.repository) === sourceProvenance.repository,
      `${pin.name} installed package has an unexpected repository`,
    );
    if (pin.wasm) {
      const wasmPath = join(root, pin.wasm.path);
      assert(existsSync(wasmPath), `${pin.name} installed WASM is missing`);
      assert(sha256File(wasmPath) === pin.wasm.sha256, `${pin.name} installed WASM digest is unexpected`);
    }
  }
}

function verifyCheckedNotice(): void {
  assert(existsSync(outputPath), 'public/TYPST_WASM_THIRD_PARTY_NOTICES.txt is missing');
  const notice = readFileSync(outputPath, 'utf8');
  assert(notice.length > 100, 'public/TYPST_WASM_THIRD_PARTY_NOTICES.txt is empty');
  assert(
    expectedNoticeSha256 !== '__NOTICE_SHA256__',
    'the expected notice digest has not been initialized',
  );
  assert(
    sha256(notice) === expectedNoticeSha256,
    'public/TYPST_WASM_THIRD_PARTY_NOTICES.txt is stale or modified; regenerate it from the pinned source archive',
  );
}

function verifyDistributedMplSource(): void {
  const sourcePath = join(root, 'public', mplSourceAvailability.distributedPath);
  assert(existsSync(sourcePath), `${mplSourceAvailability.distributedPath} is missing`);
  assert(
    sha256File(sourcePath) === mplSourceAvailability.archiveSha256,
    `${mplSourceAvailability.distributedPath} has an unexpected digest`,
  );
}

function printSourceRequirements(): void {
  console.log('Typst.ts npm gitHead source archive:');
  console.log(`  URL: ${sourceProvenance.archiveUrl}`);
  console.log(`  Save as: typst-ts-npm-githead.tar.gz`);
  console.log(`  SHA-256: ${sourceProvenance.archiveSha256}`);
  console.log(`  Extracted root: ${sourceProvenance.archiveRoot}`);
  console.log('Repository-root license archives (save under TYPST_WASM_LICENSE_ARCHIVES):');
  for (const archive of Object.values(pinnedArchives).sort((a, b) => a.filename.localeCompare(b.filename))) {
    console.log(`  ${archive.filename}\n    ${archive.url}\n    SHA-256 ${archive.sha256}`);
  }
  console.log('Pinned raw license sources (save under TYPST_WASM_LICENSE_ARCHIVES):');
  for (const pin of Object.values(pinnedRawLicenseFiles).sort((a, b) => a.filename.localeCompare(b.filename))) {
    console.log(`  ${pin.filename}\n    ${pin.url}\n    SHA-256 ${pin.sha256}`);
  }
  console.log('Generation environment:');
  console.log('  TYPST_TS_SOURCE=/path/to/extracted/typst.ts-61cd6bdf5c08f508ce63406f58a92b0971ee84b8');
  console.log('  TYPST_TS_ARCHIVE=/path/to/typst-ts-npm-githead.tar.gz');
  console.log('  TYPST_WASM_LICENSE_ARCHIVES=/path/to/downloaded/license-sources');
  console.log('  CARGO_HOME=/path/to/a Cargo cache populated for the pinned Cargo.lock');
}

function archiveFile(archivePath: string, path: string): Buffer {
  const result = spawnSync('tar', ['-xOf', archivePath, `${sourceProvenance.archiveRoot}/${path}`], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(result.status === 0, result.stderr.toString().trim() || `could not read ${path} from the source archive`);
  return result.stdout;
}

function pinnedArchiveFile(archivePath: string, archive: PinnedArchive, path: string): Buffer {
  const result = spawnSync('tar', ['-xOf', archivePath, `${archive.root}/${path}`], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(
    result.status === 0,
    result.stderr.toString().trim() || `could not read ${path} from ${archive.filename}`,
  );
  return result.stdout;
}

function assertMatchesArchive(sourceRoot: string, archivePath: string, path: string): void {
  const sourceFile = join(sourceRoot, path);
  assert(existsSync(sourceFile), `${path} is missing from TYPST_TS_SOURCE`);
  assert(
    readFileSync(sourceFile).equals(archiveFile(archivePath, path)),
    `${path} in TYPST_TS_SOURCE differs from the authenticated source archive`,
  );
}

function cargoMetadata(sourceRoot: string, spec: WasmRoot): CargoMetadata {
  const result = spawnSync(
    'cargo',
    [
      'metadata',
      '--manifest-path',
      join(sourceRoot, spec.manifest),
      '--locked',
      '--offline',
      '--format-version',
      '1',
      '--filter-platform',
      target,
      '--no-default-features',
      '--features',
      spec.features.join(','),
    ],
    { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  assert(result.status === 0, result.stderr.trim() || `cargo metadata failed for ${spec.packageName}`);
  const metadata = JSON.parse(result.stdout) as CargoMetadata;
  assert(metadata.resolve?.root, `${spec.packageName} metadata has no resolved root`);
  const rootPackage = metadata.packages.find((pkg) => pkg.id === metadata.resolve?.root);
  assert(rootPackage?.name === spec.packageName, `${spec.manifest} resolved the wrong root package`);
  const rootNode = metadata.resolve.nodes.find((node) => node.id === metadata.resolve?.root);
  assert(rootNode, `${spec.packageName} is absent from its resolved dependency graph`);
  for (const feature of spec.features) {
    assert(rootNode.features.includes(feature), `${spec.packageName} did not enable the ${feature} feature`);
  }
  assert(!rootNode.features.includes('fonts'), `${spec.packageName} unexpectedly enabled bundled fonts`);
  return metadata;
}

function reachablePackages(metadata: CargoMetadata): CargoPackage[] {
  assert(metadata.resolve?.root, 'Cargo metadata has no dependency resolution');
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const reachable = new Set<string>();
  const pending = [metadata.resolve.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    const node = nodes.get(id);
    assert(node, `Cargo dependency node ${id} is missing`);
    for (const dependency of node.deps) {
      // `null` is a normal dependency. Build dependencies are included because
      // build scripts can contribute code or data to the resulting WASM.
      if (dependency.dep_kinds.some(({ kind }) => kind !== 'dev')) pending.push(dependency.pkg);
    }
  }
  return [...reachable].map((id) => {
    const pkg = packages.get(id);
    assert(pkg, `Cargo package ${id} is missing`);
    return pkg;
  });
}

function findGitRoot(path: string): string {
  const result = spawnSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert(result.status === 0, result.stderr.trim() || `could not locate Git root for ${path}`);
  return result.stdout.trim();
}

function licenseFiles(pkg: CargoPackage): Array<{ path: string; source: string }> {
  const packageDir = dirname(pkg.manifest_path);
  const directories = [packageDir];
  let gitRoot: string | undefined;
  if (pkg.source?.startsWith('git+')) {
    gitRoot = findGitRoot(packageDir);
    if (gitRoot !== packageDir) directories.push(gitRoot);
  }
  const matchesLicenseName = /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:$|[._-].*)/i;
  const paths = new Map<string, string>();
  if (pkg.license_file) {
    const path = isAbsolute(pkg.license_file) ? pkg.license_file : resolve(packageDir, pkg.license_file);
    assert(existsSync(path), `${pkg.name}@${pkg.version} declares a missing license file`);
    paths.set(path, gitRoot ? relative(gitRoot, path) : relative(packageDir, path));
  }
  const walkPackage = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walkPackage(path);
      else if (entry.isFile() && matchesLicenseName.test(entry.name)) {
        paths.set(path, relative(packageDir, path));
      }
    }
  };
  walkPackage(packageDir);
  // Git dependencies retain their checkout root, so also inherit conventional
  // repository-root notices without recursively sweeping unrelated packages.
  for (const directory of directories.slice(1)) {
    for (const file of readdirSync(directory).filter((name) => matchesLicenseName.test(name)).sort()) {
      const path = join(directory, file);
      if (statSync(path).isFile()) paths.set(path, relative(gitRoot ?? packageDir, path));
    }
  }
  return [...paths].map(([path, source]) => ({ path, source: source.split(sep).join('/') }));
}

function readRepositoryFallbacks(
  pkg: CargoPackage,
  licenseArchiveRoot: string,
  verifiedArchives: Set<string>,
): Array<{ source: string; text: string }> {
  const packageKey = `${pkg.name}@${pkg.version}`;
  const fallback = repositoryLicenseFallbacks.find(({ packages }) => packages.includes(packageKey));
  if (!fallback) return [];
  const results: Array<{ source: string; text: string }> = [];
  for (const archiveKey of fallback.archives) {
    const archive = pinnedArchives[archiveKey];
    assert(archive, `${packageKey} refers to unknown repository archive ${archiveKey}`);
    const path = join(licenseArchiveRoot, archive.filename);
    assert(existsSync(path), `${archive.filename} is missing; download ${archive.url}`);
    if (!verifiedArchives.has(archiveKey)) {
      assert(sha256File(path) === archive.sha256, `${archive.filename} has an unexpected digest`);
      verifiedArchives.add(archiveKey);
    }
  }
  for (const file of fallback.files) {
    if (file.archive) {
      const archive = pinnedArchives[file.archive];
      assert(archive && file.path, `${packageKey} has an invalid repository license source`);
      const text = normalizeText(
        pinnedArchiveFile(join(licenseArchiveRoot, archive.filename), archive, file.path).toString('utf8'),
      );
      results.push({
        text,
        source: `${archive.repository}@${archive.commit}/${file.path} (archive SHA-256 ${archive.sha256})`,
      });
    } else if (file.raw) {
      const pin = pinnedRawLicenseFiles[file.raw as keyof typeof pinnedRawLicenseFiles];
      assert(pin, `${packageKey} refers to unknown raw license source ${file.raw}`);
      const path = join(licenseArchiveRoot, pin.filename);
      assert(existsSync(path), `${pin.filename} is missing; download ${pin.url}`);
      assert(sha256File(path) === pin.sha256, `${pin.filename} has an unexpected digest`);
      results.push({ text: normalizeText(readFileSync(path, 'utf8')), source: `${pin.source} (SHA-256 ${pin.sha256})` });
    } else {
      assert(false, `${packageKey} has an empty repository license source`);
    }
  }
  if (fallback.note) {
    results.push({
      source: `Provenance note for ${packageKey}`,
      text: [
        fallback.note,
        `Declared license: ${pkg.license}`,
        `Cargo package authors: ${pkg.authors.length > 0 ? pkg.authors.join('; ') : '(not declared)'}`,
      ].join('\n'),
    });
  }
  return results;
}

function portableSource(source: string): string {
  if (source.startsWith('registry+')) return source.replace('registry+https://github.com/rust-lang/crates.io-index', 'crates.io');
  return source.replace(/^git\+/, '');
}

function verifyFallbackRevision(pkg: CargoPackage, fallback: RepositoryLicenseFallback): void {
  const vcsPath = join(dirname(pkg.manifest_path), '.cargo_vcs_info.json');
  if (!existsSync(vcsPath)) {
    assert(
      `${pkg.name}@${pkg.version}` === 'fxhash@0.2.1',
      `${pkg.name}@${pkg.version} needs repository-root notices but has no Cargo VCS provenance`,
    );
    return;
  }
  const vcs = JSON.parse(readFileSync(vcsPath, 'utf8')) as { git?: { sha1?: string } };
  const allowedCommits = fallback.archives.map((key) => pinnedArchives[key]?.commit).filter(Boolean);
  for (const file of fallback.files) {
    if (!file.raw) continue;
    const source = pinnedRawLicenseFiles[file.raw as keyof typeof pinnedRawLicenseFiles]?.source ?? '';
    const commit = source.match(/@([0-9a-f]{40})\//)?.[1];
    if (commit) allowedCommits.push(commit);
  }
  assert(vcs.git?.sha1, `${pkg.name}@${pkg.version} has malformed Cargo VCS provenance`);
  assert(
    allowedCommits.includes(vcs.git.sha1),
    `${pkg.name}@${pkg.version} repository license source is not pinned to its Cargo VCS revision`,
  );
}

function verifyMplSourceAvailability(externalPackages: CargoPackage[]): void {
  const pkg = externalPackages.find(({ name, version }) => `${name}@${version}` === mplSourceAvailability.package);
  assert(pkg, `${mplSourceAvailability.package} is absent from the resolved graph`);
  assert(pkg.license === mplSourceAvailability.license, `${mplSourceAvailability.package} changed its license`);
  const packageDir = dirname(pkg.manifest_path);
  const registryIndex = basename(dirname(packageDir));
  const registryRoot = dirname(dirname(dirname(packageDir)));
  const sourceArchive = join(registryRoot, 'cache', registryIndex, 'option-ext-0.2.0.crate');
  assert(existsSync(sourceArchive), `${mplSourceAvailability.package} source archive is absent from the Cargo cache`);
  assert(
    sha256File(sourceArchive) === mplSourceAvailability.archiveSha256,
    `${mplSourceAvailability.package} source archive differs from Cargo.lock`,
  );
}

function generateNotice(): string {
  const sourceEnv = process.env.TYPST_TS_SOURCE;
  const archiveEnv = process.env.TYPST_TS_ARCHIVE;
  const licenseArchiveEnv = process.env.TYPST_WASM_LICENSE_ARCHIVES;
  assert(sourceEnv, '--generate requires TYPST_TS_SOURCE to name the extracted npm gitHead source archive');
  assert(archiveEnv, '--generate requires TYPST_TS_ARCHIVE to name the downloaded npm gitHead source archive');
  assert(
    licenseArchiveEnv,
    '--generate requires TYPST_WASM_LICENSE_ARCHIVES to contain the pinned repository-license sources',
  );
  const sourceRoot = resolve(sourceEnv);
  const archivePath = resolve(archiveEnv);
  const licenseArchiveRoot = resolve(licenseArchiveEnv);
  assert(existsSync(sourceRoot), `TYPST_TS_SOURCE does not exist: ${sourceRoot}`);
  assert(existsSync(archivePath), `TYPST_TS_ARCHIVE does not exist: ${archivePath}`);
  assert(existsSync(licenseArchiveRoot), `TYPST_WASM_LICENSE_ARCHIVES does not exist: ${licenseArchiveRoot}`);
  assert(
    sha256File(archivePath) === sourceProvenance.archiveSha256,
    'TYPST_TS_ARCHIVE does not match the pinned npm gitHead source archive',
  );
  assertMatchesArchive(sourceRoot, archivePath, 'Cargo.toml');
  assertMatchesArchive(sourceRoot, archivePath, 'Cargo.lock');
  assertMatchesArchive(sourceRoot, archivePath, 'LICENSE');
  assert(
    sha256File(join(sourceRoot, 'Cargo.lock')) === sourceProvenance.cargoLockSha256,
    'Typst.ts Cargo.lock differs from the pinned npm gitHead lockfile',
  );

  const allPackages = new Map<string, CargoPackage>();
  for (const spec of wasmRoots) {
    const metadata = cargoMetadata(sourceRoot, spec);
    for (const pkg of reachablePackages(metadata)) allPackages.set(pkg.id, pkg);
  }
  const packages = [...allPackages.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.id.localeCompare(b.id),
  );
  const workspacePackages = packages.filter((pkg) => !pkg.source);
  const externalPackages = packages.filter((pkg): pkg is CargoPackage & { source: string } => Boolean(pkg.source));
  assert(workspacePackages.length > 0, 'the WASM graph has no Typst.ts workspace crates');
  assert(externalPackages.length > 0, 'the WASM graph has no external crates');
  verifyMplSourceAvailability(externalPackages);

  for (const pkg of workspacePackages) {
    assert(pkg.license === 'Apache-2.0', `${pkg.name}@${pkg.version} workspace crate must declare Apache-2.0`);
    const manifest = relative(sourceRoot, pkg.manifest_path).split(sep).join('/');
    assert(!manifest.startsWith('../'), `${pkg.name}@${pkg.version} has an unexpected local source path`);
    assertMatchesArchive(sourceRoot, archivePath, manifest);
  }

  const expectedFallbacks = new Set(repositoryLicenseFallbacks.flatMap(({ packages: names }) => names));
  const actualPackageKeys = new Set(externalPackages.map(({ name, version }) => `${name}@${version}`));
  for (const packageKey of expectedFallbacks) {
    assert(actualPackageKeys.has(packageKey), `pinned repository-license package ${packageKey} left the resolved graph`);
  }

  const groups = new Map<string, LicenseGroup>();
  const verifiedArchives = new Set<string>();
  for (const pkg of externalPackages) {
    assert(pkg.license, `${pkg.name}@${pkg.version} has no declared license expression`);
    const packageKey = `${pkg.name}@${pkg.version}`;
    const fallback = repositoryLicenseFallbacks.find(({ packages: names }) => names.includes(packageKey));
    if (fallback) verifyFallbackRevision(pkg, fallback);
    const files = licenseFiles(pkg).map((file) => ({
      text: normalizeText(readFileSync(file.path, 'utf8')),
      source: `${packageKey} package archive/${file.source}`,
    }));
    const inherited = readRepositoryFallbacks(pkg, licenseArchiveRoot, verifiedArchives);
    const notices = [...files, ...inherited];
    assert(notices.length > 0, `${packageKey} has no package, repository, or canonical license text`);
    const label = `${pkg.name}@${pkg.version} (${pkg.license}; ${portableSource(pkg.source)})`;
    for (const { source, text } of notices) {
      // Some crates intentionally ship a short SPDX-expression LICENSE stub
      // alongside the full per-license files. Retain the stub as part of the
      // complete notice inventory while still rejecting empty artifacts.
      assert(text.length >= 5, `${packageKey}/${source} is implausibly short`);
      const key = sha256(text);
      const group = groups.get(key) ?? { packages: new Set<string>(), sources: new Set<string>(), text };
      assert(group.text === text, `license digest collision for ${pkg.name}@${pkg.version}`);
      group.packages.add(label);
      group.sources.add(source);
      groups.set(key, group);
    }
  }

  const workspaceLicense = normalizeText(readFileSync(join(sourceRoot, 'LICENSE'), 'utf8'));
  assert(workspaceLicense.length >= 100, 'Typst.ts workspace license text is implausibly short');
  const graphManifest = externalPackages
    .map((pkg) => `${pkg.id}\t${pkg.license}\t${pkg.source}`)
    .sort()
    .join('\n');
  const divider = '='.repeat(78);
  const workspaceSection = [
    divider,
    'Typst.ts workspace crates:',
    ...workspacePackages.map((pkg) => `- ${pkg.name}@${pkg.version} (Apache-2.0)`).sort(),
    'License text source: typst.ts/LICENSE',
    '',
    workspaceLicense,
  ].join('\n');
  const licenseSections = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => [
      divider,
      'External crates:',
      ...[...group.packages].sort().map((pkg) => `- ${pkg}`),
      'License/notice text sources:',
      ...[...group.sources].sort().map((source) => `- ${source}`),
      '',
      group.text,
    ].join('\n'));
  return [
    'PLASS PRECOMPILED TYPST WASM THIRD-PARTY NOTICES',
    '',
    'This generated file inventories the Rust crates reachable from the exact',
    'compiler and renderer configurations used by the precompiled Typst.ts WASM',
    'distributed with Plass. Dev-only dependency edges are excluded; normal and',
    'build dependencies are included. Identical license texts are deduplicated.',
    '',
    'Authenticated upstream source:',
    `- Repository: ${sourceProvenance.repository}`,
    `- npm registry gitHead: ${sourceProvenance.commit}`,
    `- npm gitHead source archive SHA-256: ${sourceProvenance.archiveSha256}`,
    `- Cargo.lock SHA-256: ${sourceProvenance.cargoLockSha256}`,
    '',
    'SOURCE-TO-BINARY PROVENANCE LIMITATION:',
    'The npm registry reported the gitHead above, but the published npm tarballs',
    'do not embed a verifiable gitHead. Their exact SRI values and installed WASM',
    'SHA-256 values identify the shipped binaries, while the authenticated gitHead',
    'archive and Cargo.lock identify the reconstructed source graph. A reproducible',
    'source-to-WASM build comparison has not been demonstrated.',
    '',
    'Resolved build configurations:',
    `- Target: ${target}`,
    ...wasmRoots.map((spec) =>
      `- ${spec.packageName}: --no-default-features --features ${spec.features.join(',')}`,
    ),
    '',
    'Locked npm distributions:',
    ...npmPins.map((pin) => `- ${pin.name}@${pin.version}: ${pin.integrity}`),
    '',
    'Installed precompiled WASM:',
    ...npmPins.filter((pin) => pin.wasm).map((pin) => `- ${pin.name}: SHA-256 ${pin.wasm?.sha256}`),
    '',
    `Reachable Typst.ts workspace crates: ${workspacePackages.length}`,
    `Reachable external crates: ${externalPackages.length}`,
    `External dependency manifest SHA-256: ${sha256(graphManifest)}`,
    '',
    'MPL-2.0 SOURCE AVAILABILITY — RETAIN WITH DISTRIBUTED BINARIES:',
    `${mplSourceAvailability.package} is reachable in the reconstructed source/configuration graph.`,
    'Because exact source-to-binary reproduction is not demonstrated, Plass',
    'conservatively treats it as MPL-2.0-covered source in the WASM distribution.',
    `Distributed exact source archive: ${mplSourceAvailability.distributedPath}`,
    `Upstream source archive mirror: ${mplSourceAvailability.archiveUrl}`,
    `Source archive SHA-256: ${mplSourceAvailability.archiveSha256}`,
    `Official source repository: ${mplSourceAvailability.repository}`,
    'Recipients may obtain, inspect, and modify that exact covered source from the',
    'archive above. The reconstructed Cargo graph applies no local option-ext patch.',
    '',
    workspaceSection,
    ...licenseSections,
    '',
  ].join('\n');
}

const args = process.argv.slice(2);
assert(
  args.every((arg) => arg === '--check' || arg === '--generate' || arg === '--print-sources'),
  `unknown option: ${args.join(' ')}`,
);
assert(!(args.includes('--check') && args.includes('--generate')), '--check and --generate are mutually exclusive');
verifyInstalledDistribution();
verifyDistributedMplSource();
if (args.includes('--print-sources')) {
  assert(args.length === 1, '--print-sources cannot be combined with another option');
  printSourceRequirements();
} else if (args.includes('--generate')) {
  const notice = generateNotice();
  writeFileSync(outputPath, notice);
  const digest = sha256(notice);
  assert(
    expectedNoticeSha256 === '__NOTICE_SHA256__' || digest === expectedNoticeSha256,
    `generated notice SHA-256 is ${digest}, not the pinned ${expectedNoticeSha256}`,
  );
  console.log(`wrote Typst WASM notices (${digest})`);
} else {
  verifyCheckedNotice();
  console.log('Typst WASM distribution and notices verified');
}
