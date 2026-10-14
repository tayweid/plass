// Run Plass.app from the checkout: the Claerbout shell on app/plass.json,
// serving dist/ (build it first: npx vite build). A document path opens it.
//
//   npm run app                    # a new window
//   npm run app -- ~/notes.typ     # opened on that file
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, electron, repo, shell } from './shell-path.mjs';

if (!existsSync(path.join(repo, 'dist', 'index.html'))) {
  console.error('no dist/index.html — run: npx vite build');
  process.exit(1);
}
const files = process.argv.slice(2).map((file) => path.resolve(file));
// A checkout run keeps its own state folder and port, apart from the
// installed Plass.app: the shell's single-instance lock is keyed by the
// state folder, so a checkout launched into the installed app's folder
// would hand its documents to the installed app and quit, showing the old
// build. PLASS_CONFIG_DIR and PLASS_PORT override.
const devState = path.join(os.homedir(), 'Library', 'Application Support', 'Plass (checkout)');
const child = spawn(electron, [shell, ...files], {
  stdio: 'inherit',
  env: { PLASS_CONFIG_DIR: devState, PLASS_PORT: '5189', ...process.env, CLAERBOUT_APP: config },
});
child.on('exit', (code) => process.exit(code ?? 0));
