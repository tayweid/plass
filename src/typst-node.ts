// The app's compiler under Node (Taylor, 2026-11-06, for the `plass`
// command): the same typst.ts wasm, fonts and providers the worker loads
// (typst-compiler.worker.ts), called directly. The worker's protocol is the
// browser's isolation (a watchdog that can terminate the global); a
// command-line process is its own isolation, so the compiler is driven in
// process. Nothing is fetched: the wasm and the fonts are files beside the
// command (the checkout's node_modules and public/fonts, or the app's own
// dist), and the package registry resolves nothing, as in the worker.
//
// Verified 2026-11-06: the wasm-bindgen web-target module instantiates from
// its bytes under Node 22 and Electron 44's Node (ELECTRON_RUN_AS_NODE), and
// the same source compiles to byte-identical PDFs under both, and under
// the app's worker.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TYPST_FONT_FILES, TYPST_FONT_LIMITS } from './typst-config';
import { COMPILER_LIMITS, type CompilerAsset, validateCompilerTask } from './typst-worker-protocol';

/** Where the compiler's files are. */
export interface CompilerResources {
  /** typst_ts_web_compiler_bg.wasm */
  compilerWasm: string;
  /** The folder holding TYPST_FONT_FILES. */
  fontsDir: string;
}

interface TypstLike {
  addSource(path: string, content: string): Promise<void>;
  mapShadow(path: string, data: Uint8Array): Promise<void>;
  resetShadow(): Promise<void> | void;
  pdf(o: { mainFilePath: string }): Promise<Uint8Array | undefined>;
  getCompiler(): Promise<unknown>;
}

interface FontBuildContext {
  builder: { add_raw_font(data: Uint8Array): Promise<void> };
}

let loaded: Promise<TypstLike> | null = null;

/** The compiler, loaded once per process. */
function loadCompiler(resources: CompilerResources): Promise<TypstLike> {
  if (!loaded) {
    loaded = (async () => {
      const [{ $typst, MemoryAccessModel }, { TypstSnippet }, wasm] = await Promise.all([
        import('@myriaddreamin/typst.ts'),
        import('@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs'),
        readFile(resources.compilerWasm),
      ]);
      $typst.setCompilerInitOptions({ getModule: () => ({ module_or_path: wasm }) });
      const accessModel = new MemoryAccessModel();
      // No package is ever resolved: the export imports nothing.
      const registry = TypstSnippet.fetchPackageBy(accessModel, () => undefined);
      // The fonts the worker preloads, in its order, under its limits.
      const loader = Object.assign(
        async (_mark: unknown, { builder }: FontBuildContext) => {
          let total = 0;
          for (const file of TYPST_FONT_FILES) {
            const font = new Uint8Array(await readFile(join(resources.fontsDir, file)));
            if (font.byteLength > TYPST_FONT_LIMITS.fileBytes) throw new Error(`${file} exceeds the compiler font byte limit`);
            total += font.byteLength;
            if (total > TYPST_FONT_LIMITS.totalBytes) throw new Error('the compiler fonts exceed their total byte limit');
            await builder.add_raw_font(font);
          }
        },
        { _preloadRemoteFontOptions: { assets: false }, _kind: 'fontLoader' },
      );
      $typst.use(
        TypstSnippet.withAccessModel(accessModel),
        registry,
        { key: 'access-model', forRoles: ['compiler'], provides: [loader] } as unknown as ReturnType<typeof TypstSnippet.preloadFonts>,
      );
      const typst = $typst as unknown as TypstLike;
      await typst.getCompiler();
      return typst;
    })().catch((error: unknown) => {
      loaded = null;
      throw error;
    });
  }
  return loaded;
}

/** What typst.ts rejects a failed compile with, readable: its diagnostics
 *  come as one Debug-printed string (`[SourceDiagnostic { severity: Error,
 *  …, message: "panicked with: \"no\"", … }]`), so the messages are taken
 *  out of it, one line each; anything else as it is. */
function compileFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const messages = [...text.matchAll(/\bmessage: "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  return messages.length ? messages.join('\n') : text;
}

/** `source` compiled to a PDF with `assets` in the compiler's filesystem
 *  (paths from `/`, as pdf.ts maps them), under the worker's own limits. */
export async function compilePdf(source: string, assets: CompilerAsset[], resources: CompilerResources): Promise<Uint8Array> {
  const invalid = validateCompilerTask({ kind: 'pdf', source, assets });
  if (invalid) throw new Error(invalid);
  const typst = await loadCompiler(resources);
  await typst.resetShadow();
  for (const asset of assets) await typst.mapShadow(asset.path, asset.data);
  await typst.addSource('/main.typ', source);
  let pdf: Uint8Array | undefined;
  try {
    pdf = await typst.pdf({ mainFilePath: '/main.typ' });
  } catch (error) {
    throw new Error(compileFailure(error));
  }
  if (!pdf) throw new Error('the compiler returned no PDF');
  if (pdf.byteLength > COMPILER_LIMITS.pdfOutputBytes) throw new Error('the PDF exceeds the 64 MiB output limit');
  return pdf;
}
