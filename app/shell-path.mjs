// Where the Claerbout shell is (docs/CLAERBOUT-SHELL.md): the `claerbout`
// repository, a sibling of the main checkout (or CLAERBOUT_SHELL), until it
// is published and Plass depends on a tag of it through npm.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** The main checkout's folder, so a worktree finds the sibling too. */
function checkout() {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
    return path.dirname(gitDir);
  } catch {
    return repo;
  }
}
export const shell = path.resolve(process.env.CLAERBOUT_SHELL ?? path.join(checkout(), '..', 'claerbout'));
export const config = path.join(repo, 'app', 'plass.json');

if (!existsSync(path.join(shell, 'main.js'))) {
  console.error(`no Claerbout shell at ${shell} (set CLAERBOUT_SHELL to its folder, the one holding main.js)`);
  process.exit(1);
}
/** Electron, as the shell's own checkout installs it. */
export const electron = createRequire(path.join(shell, 'package.json'))('electron');
export const electronPackage = createRequire(path.join(shell, 'package.json'))('electron/package.json');
