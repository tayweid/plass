#!/usr/bin/env node
// The `plass` command (package.json "bin"; `npm link` puts it on PATH).
// The tool is TypeScript run from the checkout, so the command first
// registers the checkout's tsx loader in this process, then runs it.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('./export.ts');
process.exit(await main(process.argv.slice(2)));
