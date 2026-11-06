// The `plass` command inside Plass.app: cli/export.ts bundled by Vite
// (vite.cli.config.ts) to dist/cli/plass.mjs, which the app carries beside
// its page (Resources/web/cli/plass.mjs) and runs on its own Electron as
// Node (the shell's bin script, docs/CLAERBOUT-SHELL.md). The compiler's
// files are the page's own, found beside this bundle: the typst.ts wasm
// and the math converter's wasm among the site's assets (hashed names;
// one of each), the fonts in fonts/. Nothing is carried twice, and
// nothing is installed: the app is the command.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './export.ts';

const web = fileURLToPath(new URL('../', import.meta.url));
const assets = join(web, 'assets');
function asset(pattern: RegExp, what: string): string {
  const name = readdirSync(assets).find((entry) => pattern.test(entry));
  if (!name) throw new Error(`plass: ${what} is not among ${assets}`);
  return join(assets, name);
}

process.exit(
  await main(process.argv.slice(2), {
    compilerWasm: asset(/^typst_ts_web_compiler_bg-.*\.wasm$/, 'the compiler'),
    fontsDir: join(web, 'fonts'),
    mitexWasm: asset(/^mitex-.*\.wasm$/, 'the math converter'),
  }),
);
