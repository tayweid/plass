/// <reference lib="webworker" />

// All untrusted Typst evaluation lives in this worker. The UI owns the
// watchdog and can terminate this entire global (including its WASM memory)
// when a request exceeds its deadline.

import { TYPST_FONT_FILES } from './typst-config';
import {
  COMPILER_LIMITS,
  type CompilerAsset,
  type CompilerRequest,
  type CompilerResponse,
  type CompilerTask,
  utf8OutputSize,
  validateCompilerTask,
} from './typst-worker-protocol';

interface TypstLike {
  addSource(path: string, content: string): Promise<void>;
  mapShadow(path: string, data: Uint8Array): Promise<void>;
  resetShadow(): Promise<void> | void;
  pdf(o: { mainFilePath: string }): Promise<Uint8Array | undefined>;
  svg(o: { mainContent: string } | { mainFilePath: string }): Promise<string>;
  getCompiler(): Promise<{
    runWithWorld<T>(
      o: { mainFilePath: string },
      cb: (world: {
        compile(o?: object): Promise<unknown>;
        query<T2>(o: { selector: string }): Promise<T2>;
      }) => Promise<T>,
    ): Promise<T>;
  }>;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
let typstPromise: Promise<TypstLike> | null = null;

function loadTypst(): Promise<TypstLike> {
  if (!typstPromise) {
    typstPromise = (async () => {
      const [{ $typst, MemoryAccessModel }, { TypstSnippet }, wasm, rendererWasm] = await Promise.all([
        import('@myriaddreamin/typst.ts'),
        import('@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs'),
        import('@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url'),
        import('@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url'),
      ]);
      $typst.setCompilerInitOptions({ getModule: () => wasm.default });
      $typst.setRendererInitOptions({ getModule: () => rendererWasm.default });
      const accessModel = new MemoryAccessModel();
      const registry = await TypstSnippet.fetchPackageRegistry(accessModel);
      const base = import.meta.env.BASE_URL + 'fonts/';
      $typst.use(
        TypstSnippet.withAccessModel(accessModel),
        registry,
        TypstSnippet.preloadFonts(TYPST_FONT_FILES.map((file) => base + file)),
      );
      return $typst as unknown as TypstLike;
    })().catch((error) => {
      typstPromise = null;
      throw error;
    });
  }
  return typstPromise;
}

async function installWorld(typst: TypstLike, source: string, assets: CompilerAsset[]) {
  await typst.resetShadow();
  for (const asset of assets) await typst.mapShadow(asset.path, asset.data);
  await typst.addSource('/main.typ', source);
}

function boundedSvg(svg: string): string {
  if (svg.length > COMPILER_LIMITS.svgOutputBytes || utf8OutputSize(svg) > COMPILER_LIMITS.svgOutputBytes) {
    throw new OutputLimitError('Compiled SVG exceeds the 32 MiB output limit');
  }
  return svg;
}

class OutputLimitError extends Error {}

async function runTask(task: CompilerTask): Promise<string | Uint8Array | unknown[] | null> {
  if (task.kind === 'test-busy') {
    if (!import.meta.env.DEV) throw new Error('Unsupported compiler task');
    const end = performance.now() + task.milliseconds;
    while (performance.now() < end) {
      // Deliberately occupy only the worker thread for the watchdog test.
    }
    return null;
  }

  const typst = await loadTypst();
  if (task.kind === 'svg') {
    await typst.resetShadow();
    return boundedSvg(await typst.svg({ mainContent: task.source }));
  }
  if (task.kind === 'query') {
    await typst.resetShadow();
    await typst.addSource('/probe.typ', task.source);
    const compiler = await typst.getCompiler();
    const value = await compiler.runWithWorld({ mainFilePath: '/probe.typ' }, async (world) => {
      const compiled = (await world.compile()) as
        | { diagnostics?: Array<{ severity?: string }> }
        | undefined;
      const errors = compiled?.diagnostics?.filter((diagnostic) => diagnostic.severity === 'error') ?? [];
      if (errors.length) return null;
      return world.query<unknown[]>({ selector: task.selector });
    });
    const json = JSON.stringify(value);
    if (utf8OutputSize(json) > COMPILER_LIMITS.queryOutputBytes) {
      throw new OutputLimitError('Typst query exceeds the 2 MiB output limit');
    }
    return JSON.parse(json) as unknown[] | null;
  }

  await installWorld(typst, task.source, task.assets);
  if (task.kind === 'document-svg') {
    return boundedSvg(await typst.svg({ mainFilePath: '/main.typ' }));
  }
  const pdf = await typst.pdf({ mainFilePath: '/main.typ' });
  if (!pdf) throw new Error('The compiler returned no PDF output');
  if (pdf.byteLength > COMPILER_LIMITS.pdfOutputBytes) {
    throw new OutputLimitError('Compiled PDF exceeds the 64 MiB output limit');
  }
  return pdf;
}

async function handleRequest(request: CompilerRequest) {
  const invalid = validateCompilerTask(request.task);
  if (invalid) {
    const response: CompilerResponse = { id: request.id, ok: false, code: 'invalid', message: invalid };
    scope.postMessage(response);
    return;
  }
  try {
    const value = await runTask(request.task);
    const response: CompilerResponse = { id: request.id, ok: true, value };
    if (value instanceof Uint8Array) scope.postMessage(response, [value.buffer]);
    else scope.postMessage(response);
  } catch (error) {
    const response: CompilerResponse = {
      id: request.id,
      ok: false,
      code: error instanceof OutputLimitError ? 'output-limit' : 'compile',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
    scope.postMessage(response);
  }
}

// Serialize even if a future client accidentally posts more than one task.
let taskChain: Promise<void> = Promise.resolve();
scope.onmessage = (event: MessageEvent<CompilerRequest>) => {
  taskChain = taskChain.then(() => handleRequest(event.data), () => handleRequest(event.data));
};
