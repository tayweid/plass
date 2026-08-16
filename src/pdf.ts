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
import { loadRemoteImage, remoteImageStatus, sanitizeSvgImage } from './remote-images';

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

/** Reads project-relative asset paths (set by the app's FileManager). */
let assetReader: ((path: string) => Promise<Uint8Array | null>) | null = null;

export function setAssetReader(fn: (path: string) => Promise<Uint8Array | null>) {
  assetReader = fn;
}

function dataUrlToBytes(src: string): { data: Uint8Array; ext: string } | null {
  const m = /^data:image\/(png|jpe?g|gif|svg\+xml)((?:;[^,]*)*),(.*)$/is.exec(src);
  if (!m) return null;
  const ext = m[1] === 'svg+xml' ? 'svg' : m[1] === 'jpeg' ? 'jpg' : m[1];
  const payload = m[3];
  if (/(?:^|;)base64(?:;|$)/i.test(m[2])) {
    const bin = atob(payload);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return { data: ext === 'svg' ? sanitizeSvgImage(data) : data, ext };
  }
  const data = new TextEncoder().encode(decodeURIComponent(payload));
  return { data: ext === 'svg' ? sanitizeSvgImage(data) : data, ext };
}

/** Decode embedded/approved-remote images into VFS assets; return a src →
 * path map. Remote URLs never leave the browser until the editor's explicit
 * per-origin load action has granted this shared session policy. */
/** A gray dashed "missing image" PNG, generated once — registered in place
 * of unreadable assets so exports and oracle compiles never hard-fail. */
let placeholderPng: Uint8Array | null = null;
async function missingPlaceholder(): Promise<Uint8Array> {
  if (placeholderPng) return placeholderPng;
  const cv = document.createElement('canvas');
  cv.width = 600;
  cv.height = 380;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#f0efec';
  g.fillRect(0, 0, 600, 380);
  g.strokeStyle = '#c9c7c1';
  g.lineWidth = 3;
  g.setLineDash([12, 10]);
  g.strokeRect(6, 6, 588, 368);
  g.fillStyle = '#8f8d87';
  g.font = '28px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('missing image', 300, 200);
  const blob: Blob = await new Promise((r) => cv.toBlob((b) => r(b!), 'image/png'));
  placeholderPng = new Uint8Array(await blob.arrayBuffer());
  return placeholderPng;
}

async function prepareAssets(doc: PMNode): Promise<{
  map: Map<string, string>;
  assets: Asset[];
  missing: number;
  blockedRemote: number;
}> {
  const map = new Map<string, string>();
  const assets: Asset[] = [];
  let missing = 0;
  let blockedRemote = 0;
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
    let embedded: ReturnType<typeof dataUrlToBytes> = null;
    try {
      embedded = dataUrlToBytes(src);
    } catch {
      // Malformed encodings and invalid SVGs become inert placeholders.
    }
    if (embedded) {
      n++;
      const path = `/assets/img-${n}.${embedded.ext}`;
      map.set(src, path);
      assets.push({ path, data: embedded.data });
      continue;
    }
    if (/^data:/i.test(src)) {
      n++;
      const path = `/assets/img-${n}.png`;
      map.set(src, path);
      assets.push({ path, data: await missingPlaceholder() });
      missing++;
      continue;
    }
    const remote = remoteImageStatus(src);
    if (remote) {
      if (!remote.allowed) {
        n++;
        const path = `/assets/img-${n}.png`;
        map.set(src, path);
        assets.push({ path, data: await missingPlaceholder() });
        blockedRemote++;
        continue;
      }
      try {
        const image = await loadRemoteImage(src);
        n++;
        const path = `/assets/img-${n}.${image.extension}`;
        map.set(src, path);
        assets.push({ path, data: image.data });
      } catch {
        n++;
        const path = `/assets/img-${n}.png`;
        map.set(src, path);
        assets.push({ path, data: await missingPlaceholder() });
        missing++;
      }
      continue;
    }
    // Project-relative path: register at the same path in the VFS, so the
    // emitted image("figures/x.png") resolves against /main.typ untouched —
    // the exported file stays CLI-compilable.
    if (!src.startsWith('/') && assetReader) {
      const data = await assetReader(src);
      if (data) {
        assets.push({ path: '/' + src, data });
      } else {
        // File deleted/renamed on disk: compile with a placeholder at the
        // same path instead of failing the whole export.
        assets.push({ path: '/' + src, data: await missingPlaceholder() });
        missing++;
      }
    }
  }
  return { map, assets, missing, blockedRemote };
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

/**
 * Compile the full document (with embedded assets) to a multi-page SVG —
 * the page-break oracle's channel. Returns null on failure.
 */
export function compileDocSvg(doc: PMNode, onMsg: (m: string) => void = () => {}): Promise<string | null> {
  return serialized(async () => {
    try {
      const typst = await loadTypst(onMsg);
      const { map, assets } = await prepareAssets(doc);
      const src = docToTyp(doc, { resolveImage: (s) => map.get(s) ?? s, fontFallback: FONT_FALLBACK });
      await typst.resetShadow();
      for (const a of assets) await typst.mapShadow(a.path, a.data);
      await typst.addSource('/main.typ', src);
      return await typst.svg({ mainFilePath: '/main.typ' } as unknown as { mainContent: string });
    } catch (e) {
      console.warn('doc svg compile failed', e);
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
    const { map, assets, missing, blockedRemote } = await prepareAssets(doc);
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
        (missing ? ` — ${missing} missing image(s) exported as placeholders` : '') +
        (blockedRemote
          ? ` — ${blockedRemote} remote image(s) blocked; use the image’s Load action before exporting to include them`
          : ''),
    );
  } catch (e) {
    console.error('PDF export failed', e);
    onMsg(`PDF export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
