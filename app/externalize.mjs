// Keep the heavy runtime files out of Plass.app's zip (the knuth model).
//
//   node app/externalize.mjs <web root inside the bundle>
//
// The Typst compiler (27 MB) and the compile fonts (.otf/.ttf, ~8 MB) are
// removed from the bundle and listed in runtime.json beside it. The install
// line fetches them (`Plass --fetch-runtime`; the app's setup window when
// they are still missing at launch) and keeps them in
// ~/Library/Application Support/Plass/runtime/<sha256>. Sources:
//   - the compiler: its exact npm release tarball, checked against the
//     integrity package-lock.json records;
//   - a font: raw.githubusercontent.com on main, which is where the zip is
//     published too, so an install gets matching copies of both.
// Each file is also checked against the sha256 of the bytes built here: a
// font changed on main without a rebuilt zip fails the install, visibly.
//
// The files are copied into the runtime store on this Mac as well, so a
// local build never needs the network.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = process.argv[2];
if (!web || !existsSync(join(web, 'index.html'))) {
  console.error('externalize: pass the web root inside the bundle');
  process.exit(1);
}
const store = join(homedir(), 'Library/Application Support/Plass/runtime');
const GITHUB = 'https://raw.githubusercontent.com/tayweid/plass';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function die(message) {
  console.error(`externalize: ${message}`);
  process.exit(1);
}

const entries = [];

// The compiler: vite copies the package's wasm verbatim under a hashed name.
const compilerPkg = '@myriaddreamin/typst-ts-web-compiler';
const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
const locked = lock.packages[`node_modules/${compilerPkg}`];
if (!locked?.resolved || !locked?.integrity) die(`package-lock.json has no resolved tarball for ${compilerPkg}`);
const member = 'pkg/typst_ts_web_compiler_bg.wasm';
const npmCopy = join(repo, 'node_modules', compilerPkg, member);
const assets = join(web, 'assets');
const compiled = readdirSync(assets).filter((n) => /^typst_ts_web_compiler_bg-.*\.wasm$/.test(n));
if (compiled.length !== 1) die(`expected one compiler wasm in assets/, found ${compiled.length}`);
const compilerFile = join(assets, compiled[0]);
if (sha256(compilerFile) !== sha256(npmCopy)) die('the built compiler is not the npm package\'s bytes');
entries.push({
  path: `assets/${compiled[0]}`,
  source: { kind: 'npm', url: locked.resolved, integrity: locked.integrity, member: `package/${member}` },
});

// The compile fonts: public/fonts, copied verbatim. The small .woff2 faces
// the page paints with stay in the bundle.
if (git('status', '--porcelain', '--', 'public/fonts')) {
  die('public/fonts has uncommitted changes — commit them first: installs fetch the fonts from GitHub');
}
for (const name of readdirSync(join(web, 'fonts')).sort()) {
  if (!/\.(otf|ttf)$/i.test(name)) continue;
  entries.push({ path: `fonts/${name}`, source: { kind: 'url', url: `${GITHUB}/main/public/fonts/${encodeURIComponent(name)}` } });
}

mkdirSync(store, { recursive: true });
let bytes = 0;
for (const entry of entries) {
  const file = join(web, entry.path);
  entry.sha256 = sha256(file);
  entry.size = statSync(file).size;
  bytes += entry.size;
  const kept = join(store, entry.sha256);
  if (!existsSync(kept)) copyFileSync(file, kept);
  unlinkSync(file);
}
writeFileSync(join(web, '..', 'runtime.json'), JSON.stringify({ files: entries }, null, 1) + '\n');
console.log(`externalized ${entries.length} files (${(bytes / 1048576).toFixed(1)} MB) to first launch; seeded ${relative(homedir(), store)}`);
