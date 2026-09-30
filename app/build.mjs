// Build Plass.app with the Claerbout shell's packager on app/plass.json,
// from dist/ (npx vite build first). Every option is the packager's:
//
//   npm run app:build                          # your own copy, into Applications
//   npm run app:build -- --install ~/P.app     # anywhere else
//   npm run app:build -- --zip out --arch arm64,x64   # the deploy's zips
//   npm run app:install-script                 # renders public/install
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config, shell } from './shell-path.mjs';

// The packager resolves --web against the config's folder; here it is
// named from the checkout (`--web dist`), so it is made absolute first.
const args = process.argv.slice(2);
const web = args.indexOf('--web');
if (web !== -1 && args[web + 1]) args[web + 1] = path.resolve(args[web + 1]);
const { status } = spawnSync(process.execPath, [path.join(shell, 'package.mjs'), '--config', config, ...args], { stdio: 'inherit' });
process.exit(status ?? 1);
