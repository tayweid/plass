// Put the Mac app's pieces on the site (the last step of `npm run build`).
//
// plass.tayweid.io/install assembles Plass.app from dist/app: the shell
// program and icon committed in app/bin (the deploy runs on Linux, which
// cannot compile Swift), app/Info.plist, and web.tar.gz — this build's page,
// compiler and fonts. So every deploy is also the app's release, and
// nothing large is committed.
//
// app/bin must be compiled from the main.swift and icon in this checkout:
// app/build.sh records their hashes in app/bin/sources.sha256, and this
// refuses to publish a shell that no longer matches them.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const appDir = join(root, 'app');
const dist = join(root, 'dist');
const out = join(dist, 'app');

function fail(message: string): never {
  console.error(`pack-app: ${message}`);
  process.exit(1);
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

let recorded: string;
try {
  recorded = readFileSync(join(appDir, 'bin', 'sources.sha256'), 'utf8');
} catch {
  fail('app/bin/sources.sha256 is missing — run app/build.sh on a Mac and commit app/bin');
}
for (const line of recorded.split('\n').filter(Boolean)) {
  const [hash, file] = line.split(/\s+/);
  if (sha256(join(appDir, file)) !== hash) {
    fail(`app/bin was compiled from a different ${file.replace(/^\.\.\//, '')} — run app/build.sh on a Mac and commit app/bin`);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
copyFileSync(join(appDir, 'bin', 'Plass'), join(out, 'Plass'));
copyFileSync(join(appDir, 'bin', 'AppIcon.icns'), join(out, 'AppIcon.icns'));
copyFileSync(join(appDir, 'Info.plist'), join(out, 'Info.plist'));
// The page is everything the site serves except the installer and these.
const page = readdirSync(dist).filter((name) => name !== 'app' && name !== 'install');
execFileSync('tar', ['-czf', join(out, 'web.tar.gz'), '-C', dist, ...page]);
console.log('pack-app: dist/app holds the Mac app for plass.tayweid.io/install');
