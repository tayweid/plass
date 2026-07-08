// In-app PDF export: compile the document with Typst (WASM) in the browser.
//
// The compiler, fonts (~4 MB, bundled locally: STIX Two Text, Libertinus
// Serif, New Computer Modern Math, DejaVu Sans Mono — all OFL), and the
// mitex package (fetched once from the Typst package registry) load lazily
// on first export and are cached for the session. Embedded images (data:
// URLs) are decoded into the compiler's virtual filesystem and the markup is
// rewritten to reference them, so figures compile properly.

import type { Node as PMNode } from 'prosemirror-model';
import { docToTyp } from './typ-serializer';

const FONT_FILES = [
  'NewCM10-Regular.otf',
  'NewCM10-Italic.otf',
  'NewCM10-Bold.otf',
  'NewCM10-BoldItalic.otf',
  'STIXTwoText-Regular.otf',
  'STIXTwoText-Italic.otf',
  'STIXTwoText-Bold.otf',
  'STIXTwoText-BoldItalic.otf',
  'LibertinusSerif-Regular.otf',
  'LibertinusSerif-Italic.otf',
  'LibertinusSerif-Bold.otf',
  'LibertinusSerif-BoldItalic.otf',
  'NewCMMath-Regular.otf',
  'DejaVuSansMono.ttf',
];

/** Fonts guaranteed to exist in the compiler; used as #set text fallback. */
export const FONT_FALLBACK = ['New Computer Modern', 'STIX Two Text', 'Libertinus Serif'];

interface TypstLike {
  addSource(path: string, content: string): Promise<void>;
  mapShadow(path: string, data: Uint8Array): Promise<void>;
  resetShadow(): Promise<void> | void;
  pdf(o: { mainFilePath: string }): Promise<Uint8Array | undefined>;
  svg(o: { mainContent: string }): Promise<string>;
  getCompiler(): Promise<{
    runWithWorld<T>(
      o: { mainFilePath: string },
      cb: (world: {
        compile(o?: object): Promise<unknown>;
        query<T2>(o: { selector: string }): Promise<T2>;
      }) => Promise<T>,
    ): Promise<T>;
  }>;
  setRendererInitOptions?(o: unknown): void;
}

let typstPromise: Promise<TypstLike> | null = null;
// The global $typst rejects repeated configuration; track what already ran so
// a failed init attempt (e.g. registry fetch offline) stays retryable.
let optionsSet = false;
let snippetUsed = false;

function loadTypst(onMsg: (m: string) => void): Promise<TypstLike> {
  if (!typstPromise) {
    typstPromise = (async () => {
      onMsg('Loading Typst compiler…');
      const [{ $typst, MemoryAccessModel }, { TypstSnippet }, wasm, rendererWasm] = await Promise.all([
        import('@myriaddreamin/typst.ts'),
        import('@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs'),
        import('@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url'),
        import('@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url'),
      ]);
      // $typst is a shared global; another module instance (Vite HMR gives
      // pdf.ts fresh ?t= URLs) may have configured it already. That state is
      // exactly what we would set — tolerate "already initialized".
      const tolerant = (fn: () => void) => {
        try {
          fn();
        } catch (e) {
          if (!/initialized|already prepare/i.test(String(e))) throw e;
        }
      };
      if (!optionsSet) {
        tolerant(() => $typst.setCompilerInitOptions({ getModule: () => wasm.default }));
        tolerant(() => $typst.setRendererInitOptions({ getModule: () => rendererWasm.default }));
        optionsSet = true;
      }
      if (!snippetUsed) {
        const base = import.meta.env.BASE_URL + 'fonts/';
        // Explicit access model + package registry (for mitex); bundled fonts.
        const accessModel = new MemoryAccessModel();
        const registry = await TypstSnippet.fetchPackageRegistry(accessModel);
        tolerant(() =>
          $typst.use(
            TypstSnippet.withAccessModel(accessModel),
            registry,
            TypstSnippet.preloadFonts(FONT_FILES.map((f) => base + f)),
          ),
        );
        snippetUsed = true;
      }
      return $typst as unknown as TypstLike;
    })().catch((e) => {
      typstPromise = null; // allow retry
      throw e;
    });
  }
  return typstPromise;
}

// The compiler shares one virtual filesystem — interleaved resetShadow/
// addSource from concurrent callers (oracle queries, previews, exports)
// would corrupt each other. Serialize all API use.
let apiChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = apiChain.then(fn, fn);
  apiChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface Asset {
  path: string;
  data: Uint8Array;
}

function dataUrlToBytes(src: string): { data: Uint8Array; ext: string } | null {
  const m = /^data:image\/(png|jpe?g|gif|svg\+xml)((?:;[a-z0-9-]+)*),(.*)$/is.exec(src);
  if (!m) return null;
  const ext = m[1] === 'svg+xml' ? 'svg' : m[1] === 'jpeg' ? 'jpg' : m[1];
  const payload = m[3];
  if (m[2].includes('base64')) {
    const bin = atob(payload);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return { data, ext };
  }
  return { data: new TextEncoder().encode(decodeURIComponent(payload)), ext };
}

/** Decode embedded/remote images into VFS assets; return a src → path map. */
async function prepareAssets(doc: PMNode): Promise<{ map: Map<string, string>; assets: Asset[]; missing: number }> {
  const map = new Map<string, string>();
  const assets: Asset[] = [];
  let missing = 0;
  const srcs: string[] = [];
  doc.descendants((node) => {
    if ((node.type.name === 'figure' || node.type.name === 'image') && node.attrs.src) {
      srcs.push(node.attrs.src as string);
    }
    return true;
  });

  let n = 0;
  for (const src of srcs) {
    if (map.has(src)) continue;
    const embedded = dataUrlToBytes(src);
    if (embedded) {
      n++;
      const path = `/assets/img-${n}.${embedded.ext}`;
      map.set(src, path);
      assets.push({ path, data: embedded.data });
      continue;
    }
    if (/^https?:/.test(src)) {
      try {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error(String(resp.status));
        const buf = new Uint8Array(await resp.arrayBuffer());
        const ext = /\.(png|jpe?g|gif|svg)(\?|$)/i.exec(src)?.[1]?.toLowerCase() ?? 'png';
        n++;
        const path = `/assets/img-${n}.${ext === 'jpeg' ? 'jpg' : ext}`;
        map.set(src, path);
        assets.push({ path, data: buf });
      } catch {
        missing++;
      }
    }
  }
  return { map, assets, missing };
}

/**
 * Compile a Typst fragment to SVG (content-hugging page). Used for in-editor
 * previews of blocks whose styling the DOM cannot reproduce.
 */
export function compileSvg(src: string, onMsg: (m: string) => void = () => {}): Promise<string | null> {
  return serialized(async () => {
    try {
      const typst = await loadTypst(onMsg);
      return await typst.svg({ mainContent: src });
    } catch (e) {
      console.warn('fragment compile failed', e);
      return null;
    }
  });
}

/** Query a compiled fragment (e.g. position probes). Returns null on failure. */
export function typstQuery<T = unknown>(
  src: string,
  selector: string,
  onMsg: (m: string) => void = () => {},
): Promise<T[] | null> {
  return serialized(async () => {
    try {
      const typst = await loadTypst(onMsg);
      await typst.resetShadow();
      await typst.addSource('/probe.typ', src);
      const compiler = await typst.getCompiler();
      // The driver's own query() forgets to compile the world first — do both.
      return await compiler.runWithWorld({ mainFilePath: '/probe.typ' }, async (world) => {
        const compiled = (await world.compile()) as
          | { diagnostics?: Array<{ severity?: string }> }
          | undefined;
        const errors = compiled?.diagnostics?.filter((d) => d.severity === 'error') ?? [];
        if (errors.length) {
          console.warn('probe compile errors ' + JSON.stringify(errors).slice(0, 1500));
          return null;
        }
        return world.query<T[]>({ selector });
      });
    } catch (e) {
      console.warn('typst query failed', e);
      return null;
    }
  });
}

/** Compile raw Typst source to PDF bytes (assets must already be mapped). */
export function compileTyp(src: string, onMsg: (m: string) => void = () => {}): Promise<Uint8Array | undefined> {
  return serialized(async () => {
    const typst = await loadTypst(onMsg);
    await typst.resetShadow();
    await typst.addSource('/main.typ', src);
    return typst.pdf({ mainFilePath: '/main.typ' });
  });
}

export async function exportPdf(doc: PMNode, baseName: string, onMsg: (m: string) => void): Promise<void> {
  try {
    const typst = await loadTypst(onMsg);
    onMsg('Preparing document…');
    const { map, assets, missing } = await prepareAssets(doc);
    const src = docToTyp(doc, {
      resolveImage: (s) => map.get(s) ?? s,
      fontFallback: FONT_FALLBACK,
    });

    onMsg('Typesetting with Typst…');
    const t0 = performance.now();
    const data = await serialized(async () => {
      await typst.resetShadow();
      for (const a of assets) await typst.mapShadow(a.path, a.data);
      await typst.addSource('/main.typ', src);
      return typst.pdf({ mainFilePath: '/main.typ' });
    });
    if (!data) throw new Error('the compiler returned no output (see console for diagnostics)');

    const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName}.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
    onMsg(
      `Exported ${a.download} in ${((performance.now() - t0) / 1000).toFixed(1)}s` +
        (missing ? ` — ${missing} remote image(s) could not be fetched` : ''),
    );
  } catch (e) {
    console.error('PDF export failed', e);
    onMsg(`PDF export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
