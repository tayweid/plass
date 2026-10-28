// `npm run ci`: what GitHub's deploy checks before it publishes (the verify
// and browser-suite jobs in .github/workflows/deploy.yml), run here, so a
// push is green the first time. It stops at the first failure. `--quick` is
// the pre-push subset (.githooks/pre-push, a minute or two): the checks that
// failed the deploy most often and cost least — the Claerbout tag, the
// Playwright image, npm audit, the third-party notices, the static checks
// and the unit suites.
//
// It checks the files as they are in this folder, uncommitted edits
// included. The browser suite runs on a free port of its own
// (PLASS_TEST_PORT, playwright.config.ts): a dev server already on 5199
// may be another checkout's code.
//
// Not covered: the macOS app job's packaging and smoke tests (`npm run
// app:build` installs the app, so they stay manual) and the sidecar job's
// rebuild comparison. A tool CI installs that is missing here (cargo-audit,
// pandoc) is reported, not failed, so the summary says what went unchecked.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname;
const quick = process.argv.includes('--quick');

type Step = {
  name: string;
  /** Run with PLASS_TEST_PORT set to a free port (the browser suite). */
  ownPort?: boolean;
  /** Why the step cannot run here, or null when it can. */
  missing?: () => string | null;
} & (
  | { cmd: string[]; check?: undefined }
  /** A check made in this process: why it fails, or null when it passes. */
  | { check: () => string | null; cmd?: undefined }
);

const runs = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'ignore' }).status === 0;

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

/** The shell tag the deploy's app job clones (deploy.yml's CLAERBOUT_TAG). */
function claerboutTag(): string {
  const tag = /CLAERBOUT_TAG:\s*(\S+)/.exec(workflow)?.[1];
  if (!tag) throw new Error('deploy.yml names no CLAERBOUT_TAG');
  return tag;
}

/** The Playwright version of the image the browser-suite job runs in. */
function playwrightImageVersion(): string {
  const version = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble/.exec(workflow)?.[1];
  if (!version) throw new Error('deploy.yml names no mcr.microsoft.com/playwright image');
  return version;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

const tag = claerboutTag();
const image = playwrightImageVersion();
const installedPlaywright: string = createRequire(import.meta.url)('playwright/package.json').version;
const steps: Step[] = [
  // The app job clones the shell at this tag: it must be on GitHub first
  // (tag claerbout, push the tag, then move CLAERBOUT_TAG).
  { name: `Claerbout ${tag} is on GitHub`, cmd: ['git', 'ls-remote', '--exit-code', '--tags', 'https://github.com/tayweid/claerbout', `refs/tags/${tag}`] },
  // The browser suite runs in Playwright's image, whose browsers are that
  // version's: a Playwright bump moves the image tag and its digest too.
  {
    name: `Playwright image v${image} is the installed Playwright`,
    check: () =>
      image === installedPlaywright
        ? null
        : `deploy.yml runs the browser suite in Playwright's v${image} image, but the installed playwright is ${installedPlaywright}: move the image tag and its digest in .github/workflows/deploy.yml`,
  },
  { name: 'npm audit', cmd: ['npm', 'audit', '--audit-level=moderate'] },
  ...(quick
    ? []
    : [
        {
          name: 'cargo audit (sidecar)',
          cmd: ['cargo', 'audit', '--file', 'sidecar/Cargo.lock'],
          missing: () => (runs('cargo', ['audit', '--version']) ? null : 'cargo-audit is not installed (CI pins it: cargo install cargo-audit --locked --version 0.22.2)'),
        },
      ]),
  { name: 'third-party notices', cmd: ['npm', 'run', 'verify:licenses'] },
  ...(quick
    ? [
        { name: 'unused code', cmd: ['npm', 'run', 'check:unused'] },
        { name: 'unused exports', cmd: ['npm', 'run', 'check:exports'] },
        { name: 'import cycles', cmd: ['npm', 'run', 'check:cycles'] },
        { name: 'types', cmd: ['npx', 'tsc', '--noEmit'] },
      ]
    : [
        { name: 'build', cmd: ['npm', 'run', 'build'] },
        { name: 'production checks', cmd: ['npm', 'run', 'verify:production'] },
      ]),
  { name: 'unit suites', cmd: ['npm', 'test'] },
  ...(quick
    ? []
    : [
        { name: 'sidecar tests', cmd: ['cargo', 'test', '--locked', '--manifest-path', 'sidecar/Cargo.toml'] },
        { name: 'layout port', cmd: ['npm', 'run', 'test:layout'] },
        { name: 'browser suite', cmd: ['npm', 'run', 'test:browser'], ownPort: true },
      ]),
];

const notes: string[] = [];
if (!runs('pandoc', ['--version'])) notes.push('pandoc is not installed: the Markdown referee (md-parity) skipped; CI runs it with pandoc 3.4');

const results: Array<{ name: string; seconds: number; status: 'ok' | 'failed' | 'skipped' }> = [];
let failed: string | null = null;
for (const step of steps) {
  const missing = step.missing?.() ?? null;
  if (missing) {
    notes.push(missing);
    results.push({ name: step.name, seconds: 0, status: 'skipped' });
    continue;
  }
  const env = step.ownPort ? { ...process.env, PLASS_TEST_PORT: String(await freePort()) } : process.env;
  console.log(`\n── ${step.name} ──`);
  const start = Date.now();
  let ok: boolean;
  if (step.check) {
    const problem = step.check();
    if (problem) console.log(problem);
    ok = problem === null;
  } else {
    ok = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: ROOT, stdio: 'inherit', env }).status === 0;
  }
  const seconds = (Date.now() - start) / 1000;
  results.push({ name: step.name, seconds, status: ok ? 'ok' : 'failed' });
  if (!ok) {
    failed = step.name;
    break;
  }
}

console.log(`\n${quick ? 'npm run ci -- --quick' : 'npm run ci'}:`);
for (const r of results) console.log(`  ${r.status === 'ok' ? '✓' : r.status === 'skipped' ? '–' : '✗'} ${r.name}${r.status === 'skipped' ? ' (skipped)' : ` ${r.seconds.toFixed(0)}s`}`);
for (const note of notes) console.log(`  note: ${note}`);
if (failed) {
  console.log(`\nFailed at: ${failed}. GitHub would fail here too.`);
  process.exit(1);
}
console.log(`\nAll ${results.filter((r) => r.status === 'ok').length} checks passed.`);
