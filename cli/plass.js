#!/usr/bin/env node
// The `plass` command in a checkout (package.json "bin"; `npm link` puts it
// on PATH). The tool is TypeScript run from the checkout, so the command
// first registers the checkout's tsx loader in this process, then runs
// cli/export.ts with the checkout's own compiler files: the typst.ts wasm
// in node_modules, public/fonts, and the vendored mitex wasm. Inside
// Plass.app the same export runs bundled (cli/bundle.ts → dist/cli/
// plass.mjs) on the app's copies of the same files.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();
const require = createRequire(import.meta.url);
const { main } = await import('./export.ts');
process.exit(
  await main(process.argv.slice(2), {
    compilerWasm: require.resolve('@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm'),
    fontsDir: fileURLToPath(new URL('../public/fonts/', import.meta.url)),
    mitexWasm: fileURLToPath(new URL('../src/mitex/mitex.wasm', import.meta.url)),
  }),
);
