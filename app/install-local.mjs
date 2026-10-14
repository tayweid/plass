// Install the checkout's build as Plass.app on this Mac, the way the
// deploy's app job installs it on GitHub's (.github/workflows/deploy.yml),
// with no push and no download from the site: build the site (npx vite
// build), package the app for this Mac's processor into a scratch site
// folder (app/Plass-<arch>.zip and app/latest.json, as plass.tayweid.io
// serves them), and run the install line (public/install) against that
// folder. Electron comes the way it comes for anyone: cloned from the
// Plass this replaces or another Claerbout app on the same Electron, else
// Electron's release, downloaded once. The shell is the one
// app/shell-path.mjs finds (the sibling checkout, or CLAERBOUT_SHELL).
//
//   npm run install:local                       # into /Applications/Plass.app
//   npm run install:local -- ~/Desktop/P.app    # anywhere else
//
// `npm run app` runs the checkout; this installs the checkout's build as
// the app. Quit Plass first: the install line never replaces an open app.
// The build is the checkout's commit, with -dirty when the tree has
// changes, and the time it was built: the installed app's Check for
// Updates… later replaces it with the site's build, once the site's is the
// newer one (the next deploy). A shell up to v0.2.3 offers the site's
// build at once, being another build.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, repo, shell } from './shell-path.mjs';

const { name, envPrefix } = JSON.parse(readFileSync(config, 'utf8'));
const fail = (message) => {
  console.error(`install:local: ${message}`);
  process.exit(1);
};
if (process.platform !== 'darwin') fail(`${name}.app is for macOS`);
const targets = process.argv.slice(2);
if (targets.length > 1) fail(`one target at most: npm run install:local -- /path/to/${name}.app`);
// npm runs a script from the package's folder; a relative target means the
// folder it was typed in.
const app = targets[0] ? path.resolve(process.env.INIT_CWD ?? process.cwd(), targets[0]) : `/Applications/${name}.app`;
if (!app.endsWith('.app')) fail(`the target must end in .app (got ${app})`);

// The install line's own test for an open app (macOS may report a path
// under /private without that prefix), asked before the build too, so a
// refusal does not come a minute in.
const isOpen = () => {
  const plain = app.replace(/^\/private/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return spawnSync('pgrep', ['-f', `^(/private)?${plain}/Contents/MacOS/`]).status === 0;
};
const quit = `${name} is open (${app}). Quit it (${name} menu → Quit ${name}), then run npm run install:local again.`;
if (isOpen()) fail(quit);

const git = (cwd, ...args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const commit = git(repo, 'rev-parse', '--short', 'HEAD');
const build = commit ? `${commit}${git(repo, 'status', '--porcelain') ? '-dirty' : ''}` : 'local';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const site = mkdtempSync(path.join(os.tmpdir(), `${name.toLowerCase()}-site-`));
process.on('exit', () => rmSync(site, { recursive: true, force: true }));
const step = (command, args, env = {}) =>
  spawnSync(command, args, { cwd: repo, stdio: 'inherit', env: { ...process.env, ...env } }).status === 0;

console.log(`install:local: ${name} build ${build} for ${arch}, on the shell at ${shell} (${git(shell, 'describe', '--tags', '--always', '--dirty') || 'no git'})`);
if (!step('npx', ['vite', 'build'])) fail('the site did not build');
if (!step(process.execPath, ['app/build.mjs', '--web', 'dist', '--arch', arch, '--zip', path.join(site, 'app')], { CLAERBOUT_BUILD: build })) {
  fail('the app did not package');
}
if (!step('bash', ['public/install'], { [`${envPrefix}_SITE`]: site, [`${envPrefix}_APP`]: app })) {
  fail(isOpen() ? quit : 'the install line stopped (above)');
}
const stamp = JSON.parse(readFileSync(path.join(app, 'Contents', 'Resources', 'app', 'package.json'), 'utf8'));
console.log(`install:local: installed ${app}, build ${stamp.build} (${stamp.built}). Its Check for Updates… replaces it with the site's build once the site has a newer one.`);
