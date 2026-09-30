// Run Plass.app from the checkout: the Claerbout shell on app/plass.json,
// serving dist/ (build it first: npx vite build). A document path opens it.
//
//   npm run app                    # a new window
//   npm run app -- ~/notes.typ     # opened on that file
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, electron, repo, shell } from './shell-path.mjs';

if (!existsSync(path.join(repo, 'dist', 'index.html'))) {
  console.error('no dist/index.html — run: npx vite build');
  process.exit(1);
}
const files = process.argv.slice(2).map((file) => path.resolve(file));
const child = spawn(electron, [shell, ...files], {
  stdio: 'inherit',
  env: { ...process.env, CLAERBOUT_APP: config },
});
child.on('exit', (code) => process.exit(code ?? 0));
