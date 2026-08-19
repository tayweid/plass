import type { KnipConfig } from 'knip';

export default {
  // Vite (index.html -> src/main.ts) is auto-detected; differ.html's entry
  // and everything only ever invoked directly via `tsx`/`playwright test`
  // need to be listed explicitly.
  entry: [
    'src/differ.ts',
    'scripts/*.ts',
    'src/**/*.test.ts',
    'tests/*.spec.ts',
  ],
  project: ['src/**/*.ts', 'scripts/*.ts', 'tests/*.spec.ts'],
  // sidecar/pkg is generated wasm glue, not source we own.
  ignore: ['sidecar/pkg/**'],
  ignoreExportsUsedInFile: true,
  // Playwright's page.evaluate() runs in the browser, where Vite serves
  // modules from the site root, so tests dynamically import '/src/x.ts'
  // instead of a relative path. Map that back to src/ so knip can resolve
  // it and see those exports as used, same as any other import.
  paths: { '/src/*': ['src/*'] },
  ignoreIssues: {
    // Frozen, byte-for-byte reference ports (see CONTRIBUTING.md) — never edited.
    'src/layout/knuth-plass.ts': ['exports', 'types'],
    'src/layout/port/linebreak.ts': ['exports', 'types'],
    // TypesetMeta is used in-file (as/satisfies positions) but knip's
    // in-file ref tracking misses those forms for this re-exported type.
    'src/typeset-plugin.ts': ['types'],
  },
} satisfies KnipConfig;
