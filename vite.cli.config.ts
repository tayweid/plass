// The `plass` command as Plass.app carries it: cli/bundle.ts and everything
// it imports (the Markdown reader, the serializer, typst.ts's JavaScript)
// built into one file for Node, dist/cli/plass.mjs, beside the page. The
// app's Electron runs it as Node (the shell's bin script; docs/
// CLAERBOUT-SHELL.md), and it finds the compiler's wasm, the fonts and the
// math converter's wasm among the page's own files, so nothing is carried
// twice. `npm run build` runs this after the page's build; in a checkout
// cli/plass.js runs the same code through tsx instead.
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'cli/bundle.ts',
    outDir: 'dist/cli',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'plass.mjs', format: 'es', codeSplitting: false } },
  },
  // Everything in the file: the app's node_modules are not in the bundle.
  ssr: { noExternal: true, target: 'node' },
  // The page's public files (fonts, notices) are the page's: not copied
  // here again. The `?url` branches the command never takes still name
  // the page's assets, relative like the page's.
  publicDir: false,
  base: './',
  logLevel: 'warn',
});
