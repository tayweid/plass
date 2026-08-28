/// <reference lib="webworker" />

// All untrusted Typst evaluation lives in this worker. The UI owns the
// watchdog and can terminate this entire global (including its WASM memory)
// when a request exceeds its deadline.

import {
  isAllowedTypstPackage,
  sourceNeedsPinnedTypstPackage,
  TYPST_FONT_FILES,
  TYPST_FONT_LIMITS,
  TYPST_PACKAGE_POLICY,
} from './typst-config';
import {
  COMPILER_LIMITS,
  type CompilerAsset,
  type CompilerRequest,
  type CompilerResponse,
  type CompilerTask,
  utf8OutputSize,
  validateCompilerTask,
} from './typst-worker-protocol';
import {
  TYPST_EMBED_REGION_KIND,
  TYPST_EMBED_REGION_LABEL,
  type TypstEmbedRegion,
  type TypstPagePosition,
} from './typst-embed-regions';
import type { TypstDocumentSvgPublication } from './typst-document-publication';
import {
  TYPST_LAYOUT_REGION_LABEL,
  parseTypstLayoutRegions,
} from './typst-layout-regions';
import {
  parseTypstPreviewRegions,
  TYPST_PREVIEW_REGION_LABEL,
} from './typst-preview-regions';

interface TypstLike {
  addSource(path: string, content: string): Promise<void>;
  mapShadow(path: string, data: Uint8Array): Promise<void>;
  resetShadow(): Promise<void> | void;
  pdf(o: { mainFilePath: string }): Promise<Uint8Array | undefined>;
  svg(o: { mainContent: string } | { mainFilePath: string } | { vectorData: Uint8Array }): Promise<string>;
  getCompiler(): Promise<{
    runWithWorld<T>(
      o: { mainFilePath: string },
      cb: (world: {
        compile(o?: object): Promise<unknown>;
        vector(o?: object): Promise<{
          result?: Uint8Array;
          diagnostics?: Array<{ severity?: string }>;
        }>;
        query<T2>(o: { selector: string }): Promise<T2>;
      }) => Promise<T>,
    ): Promise<T>;
  }>;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

// wasm-bindgen's js-sys global() compatibility path uses
// Function("return this") even in browsers that have globalThis. Replace the
// worker-global constructor before loading Typst: preserve only that inert
// lookup and fail closed for every other attempt at dynamic JavaScript.
const safeFunctionConstructor = function (...args: string[]) {
  const body = args.at(-1)?.trim();
  if (args.length === 1 && body === 'return this') return () => scope;
  if (args.length === 1 && body === 'return 0') return () => 0;
  if (args.length === 1 && body === 'return true') return () => true;
  if (args.length === 2 && /^[A-Za-z_$][\w$]*$/.test(args[0]) && body === `return ${args[0]}`) {
    return (value: unknown) => value;
  }
  if (args.length === 1 && body === "throw new Error('Dummy AccessModel, please initialize compiler with withAccessModel()')") {
    return () => {
      throw new Error('Typst compiler access model is not initialized');
    };
  }
  if (args.length === 1 && body === "throw new Error('Dummy Registry, please initialize compiler with withPackageRegistry()')") {
    return () => {
      throw new Error('Typst compiler package registry is not initialized');
    };
  }
  throw new EvalError('Dynamic JavaScript construction is disabled in the Typst worker');
} as unknown as FunctionConstructor;
Object.defineProperty(scope, 'Function', {
  value: safeFunctionConstructor,
  writable: false,
  configurable: false,
});

let typstPromise: Promise<TypstLike> | null = null;
let pinnedPackageBytes: Uint8Array | null = null;
let pinnedPackagePromise: Promise<void> | null = null;

async function readBoundedResponse(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error(`${label} exceeds its byte limit`);
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`${label} exceeds its byte limit`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Fetch the one audited package asynchronously, with redirect, size, and
 * integrity checks, before synchronous Typst package resolution begins. */
function loadPinnedPackage(): Promise<void> {
  if (!pinnedPackagePromise) {
    pinnedPackagePromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TYPST_PACKAGE_POLICY.fetchTimeoutMs);
      try {
        const response = await fetch(TYPST_PACKAGE_POLICY.url, {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
          mode: 'cors',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Pinned Typst package returned HTTP ${response.status}`);
        const data = await readBoundedResponse(
          response,
          TYPST_PACKAGE_POLICY.maxBytes,
          'Pinned Typst package',
        );
        const digest = hex(await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer));
        if (digest !== TYPST_PACKAGE_POLICY.sha256) {
          throw new Error('Pinned Typst package failed its integrity check');
        }
        pinnedPackageBytes = data;
      } finally {
        clearTimeout(timer);
      }
    })();
  }
  return pinnedPackagePromise;
}

interface FontBuildContext {
  builder: { add_raw_font(data: Uint8Array): Promise<void> };
}

/** Avoid typst.ts's cross-platform font helper: it constructs JavaScript at
 * runtime to support Node, which is incompatible with a no-eval worker CSP. */
function pinnedFontProvider<T extends { preloadFonts(fonts: string[]): unknown }>(_TypstSnippet: T): ReturnType<T['preloadFonts']> {
  const loader = Object.assign(
    async (_mark: unknown, { builder }: FontBuildContext) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TYPST_FONT_LIMITS.fetchTimeoutMs);
      try {
        // The built worker lives in assets/, while public fonts are copied to
        // the deployment root. Resolving from the worker location keeps this
        // valid at both a custom-domain root and any future project subpath.
        const base = new URL('../fonts/', scope.location.href);
        if (base.origin !== scope.location.origin) throw new Error('Compiler font base must be same-origin');
        const fonts = await Promise.all(TYPST_FONT_FILES.map(async (file) => {
          const url = new URL(file, base);
          if (url.origin !== scope.location.origin) throw new Error('Compiler font URL must be same-origin');
          const response = await fetch(url, {
            credentials: 'same-origin',
            redirect: 'error',
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Compiler font returned HTTP ${response.status}`);
          return readBoundedResponse(response, TYPST_FONT_LIMITS.fileBytes, 'Compiler font');
        }));
        const total = fonts.reduce((sum, font) => sum + font.byteLength, 0);
        if (total > TYPST_FONT_LIMITS.totalBytes) throw new Error('Compiler fonts exceed their total byte limit');
        for (const font of fonts) await builder.add_raw_font(font);
      } finally {
        clearTimeout(timer);
      }
    },
    // These markers prevent TypstCompilerDriver from adding its default
    // network font loader and satisfy its required font-loader check.
    { _preloadRemoteFontOptions: { assets: false }, _kind: 'fontLoader' },
  );
  return {
    key: 'access-model',
    forRoles: ['compiler'],
    provides: [loader],
  } as ReturnType<T['preloadFonts']>;
}

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
      const registry = TypstSnippet.fetchPackageBy(accessModel, (spec, defaultUrl) => {
        if (!isAllowedTypstPackage(spec) || defaultUrl !== TYPST_PACKAGE_POLICY.url) return undefined;
        return pinnedPackageBytes ?? undefined;
      });
      $typst.use(
        TypstSnippet.withAccessModel(accessModel),
        registry,
        pinnedFontProvider(TypstSnippet),
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

function point(value: unknown): TypstPagePosition | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { page?: unknown; x?: unknown; y?: unknown };
  const length = (input: unknown): number => {
    if (typeof input !== 'string' || !/^-?\d+(?:\.\d+)?pt$/.test(input)) return Number.NaN;
    return Number(input.slice(0, -2));
  };
  const page = candidate.page;
  const x = length(candidate.x);
  const y = length(candidate.y);
  return Number.isSafeInteger(page) && (page as number) >= 1 && Number.isFinite(x) && Number.isFinite(y)
    ? { page: page as number, x, y }
    : null;
}

function embedRegions(query: unknown): TypstEmbedRegion[] {
  const item = Array.isArray(query) && query.length === 1 ? query[0] : null;
  const value = item && typeof item === 'object'
    ? (item as { value?: unknown }).value
    : null;
  if (!value || typeof value !== 'object') throw new Error('Typst embed region metadata is missing');
  const payload = value as { kind?: unknown; regions?: unknown };
  if (payload.kind !== TYPST_EMBED_REGION_KIND || !Array.isArray(payload.regions)) {
    throw new Error('Typst embed region metadata is invalid');
  }

  const pairs = new Map<number, { start?: TypstPagePosition; end?: TypstPagePosition }>();
  for (const raw of payload.regions) {
    if (!raw || typeof raw !== 'object') throw new Error('Typst embed region entry is invalid');
    const candidate = raw as { index?: unknown; edge?: unknown; pos?: unknown };
    if (!Number.isSafeInteger(candidate.index) || (candidate.index as number) < 0) {
      throw new Error('Typst embed region index is invalid');
    }
    if (candidate.edge !== 'start' && candidate.edge !== 'end') {
      throw new Error('Typst embed region edge is invalid');
    }
    const pos = point(candidate.pos);
    if (!pos) throw new Error('Typst embed region position is invalid');
    const index = candidate.index as number;
    const pair = pairs.get(index) ?? {};
    if (pair[candidate.edge]) throw new Error('Typst embed region edge is duplicated');
    pair[candidate.edge] = pos;
    pairs.set(index, pair);
  }

  return [...pairs.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, pair]) => {
      if (!pair.start || !pair.end) throw new Error('Typst embed region is incomplete');
      return { index, start: pair.start, end: pair.end };
    });
}

async function runTask(task: CompilerTask): Promise<string | Uint8Array | unknown[] | TypstDocumentSvgPublication | null> {
  if (task.kind === 'test-busy') {
    if (!import.meta.env.DEV) throw new Error('Unsupported compiler task');
    const end = performance.now() + task.milliseconds;
    while (performance.now() < end) {
      // Deliberately occupy only the worker thread for the watchdog test.
    }
    return null;
  }

  if (import.meta.env.DEV && (task.kind === 'svg' || task.kind === 'query')) {
    if (sourceNeedsPinnedTypstPackage(task.source)) await loadPinnedPackage();
    const researchTypst = await loadTypst();
    if (task.kind === 'svg') {
      await researchTypst.resetShadow();
      return boundedSvg(await researchTypst.svg({ mainContent: task.source }));
    }
    await researchTypst.resetShadow();
    await researchTypst.addSource('/probe.typ', task.source);
    const compiler = await researchTypst.getCompiler();
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
  if (task.kind === 'svg' || task.kind === 'query') throw new Error('Unsupported compiler task');

  if (sourceNeedsPinnedTypstPackage(task.source)) await loadPinnedPackage();
  const typst = await loadTypst();

  await installWorld(typst, task.source, task.assets);
  if (task.kind === 'document-svg') {
    return boundedSvg(await typst.svg({ mainFilePath: '/main.typ' }));
  }
  if (task.kind === 'document-svg-regions') {
    const compiler = await typst.getCompiler();
    const { vector, queries } = await compiler.runWithWorld({ mainFilePath: '/main.typ' }, async (world) => {
      // `world.vector()` compiles this snapshot and returns its vector artifact.
      // Query the same live world before it is freed, then render that exact
      // artifact below. Calling the snippet's mainFilePath SVG helper here
      // would take a second snapshot and compile the document a second time.
      const compiled = await world.vector();
      const errors = compiled?.diagnostics?.filter((diagnostic) => diagnostic.severity === 'error') ?? [];
      if (errors.length) throw new Error('Typst document region query failed');
      if (!compiled?.result) throw new Error('The compiler returned no Typst vector artifact');
      const safeQuery = async (selector: string): Promise<unknown[] | null> => {
        try {
          return await world.query<unknown[]>({ selector });
        } catch {
          // Region metadata is auxiliary to the already-successful SVG. A
          // collision or malformed one must blank only that preview/layout
          // target, never pagination and every other shared consumer.
          return null;
        }
      };
      return {
        vector: compiled.result,
        queries: {
          embeds: await safeQuery(`<${TYPST_EMBED_REGION_LABEL}>`),
          layout: await safeQuery(`<${TYPST_LAYOUT_REGION_LABEL}>`),
          preview: await safeQuery(`<${TYPST_PREVIEW_REGION_LABEL}>`),
        },
      };
    });
    const svg = boundedSvg(await typst.svg({ vectorData: vector }));
    const queryJson = JSON.stringify(queries);
    if (utf8OutputSize(queryJson) > COMPILER_LIMITS.queryOutputBytes) {
      throw new OutputLimitError('Typst document region query exceeds the 2 MiB output limit');
    }
    let regions: TypstEmbedRegion[] = [];
    try {
      regions = embedRegions(queries.embeds);
    } catch {
      // See safeQuery above: exact page/line layout still consumes the SVG.
    }
    return {
      svg,
      regions,
      layoutRegions: parseTypstLayoutRegions(queries.layout),
      previewRegions: parseTypstPreviewRegions(queries.preview),
    };
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
