// `npm test`: every src/**/*.test.ts suite, found by existing, run one at a
// time with tsx in sorted order, stopping at the first failure (the same
// semantics as the hand-maintained `&&` chain this replaced). A new suite
// registers by being created; no package.json edit, so parallel branches
// adding suites never conflict on one line. The four layout-port suites
// stay under `npm run test:layout`.
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname;
const LAYOUT_ONLY = new Set([
  'src/layout/port/port-smoke.test.ts',
  'src/layout/port/shape-cache.test.ts',
  'src/layout/port/incremental-linebreak.test.ts',
  'src/layout/font-certification.test.ts',
]);

const suites: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.test.ts')) suites.push(relative(ROOT, p));
  }
};
walk(join(ROOT, 'src'));
suites.sort();

for (const suite of suites) {
  if (LAYOUT_ONLY.has(suite)) continue;
  console.log(`\n== ${suite}`);
  const r = spawnSync('npx', ['tsx', suite], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n${suite} failed (exit ${r.status ?? 'signal'})`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\nall ${suites.length - LAYOUT_ONLY.size} unit suites passed`);
