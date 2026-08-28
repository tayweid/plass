// In-app PDF export: compile the document with Typst (WASM) in the browser.
//
// Untrusted Typst evaluation runs in a dedicated worker with input/output
// budgets and a main-thread watchdog. The compiler, bundled fonts, and mitex
// package load lazily there and are cached until the worker is idle or must be
// terminated. Embedded images are decoded into its virtual filesystem and
// markup is rewritten to reference them, so figures compile properly.

import type { Node as PMNode } from 'prosemirror-model';
import { docToTyp } from './typ-serializer';
import { loadRemoteImage, remoteImageStatus, sanitizeSvgImage } from './remote-images';
import { FONT_FALLBACK } from './typst-config';
import {
  runCoordinatedCompilerTask,
  runFinalCompilerTask,
  type CompilerValue,
  type CoordinatedCompileRequest,
} from './compiler/coordinated-compiler';
import {
  COMPILER_DEADLINES,
  COMPILER_LIMITS,
  isValidAssetPath,
  type CompilerAsset,
  type CompilerTask,
} from './typst-worker-protocol';
import { resetCompilerCircuit } from './compiler-circuit';
import { documentTypstEmbedImagePaths } from './typst-embed-assets';
import type { TypstDocumentSvgPublication } from './typst-document-publication';

export { FONT_FALLBACK } from './typst-config';
type Asset = CompilerAsset;
class AssetLimitError extends Error {}

interface PreparedDocumentCompileInput {
  source: string;
  assets: Asset[];
  missing: number;
  blockedRemote: number;
}

/** Reads project-relative asset paths (set by the app's FileManager). */
let assetReader: ((path: string, maxBytes: number) => Promise<Uint8Array | null>) | null = null;

export function setAssetReader(fn: (path: string, maxBytes: number) => Promise<Uint8Array | null>) {
  assetReader = fn;
}

function dataUrlToBytes(src: string): { data: Uint8Array; ext: string } | null {
  const m = /^data:image\/(png|jpe?g|gif|svg\+xml)((?:;[^;,]*)*),(.*)$/is.exec(src);
  if (!m) return null;
  const ext = m[1] === 'svg+xml' ? 'svg' : m[1] === 'jpeg' ? 'jpg' : m[1];
  const payload = m[3];
  if (/(?:^|;)base64(?:;|$)/i.test(m[2])) {
    // Reject before atob allocates a second, decoded copy. A few trailing
    // characters cover base64 padding; whitespace-heavy encodings may be
    // rejected conservatively instead of consuming unbounded memory.
    if (payload.length > Math.ceil(COMPILER_LIMITS.assetBytes / 3) * 4 + 4) {
      throw new AssetLimitError('Embedded image exceeds the 20 MiB compilation limit');
    }
    const bin = atob(payload);
    if (bin.length > COMPILER_LIMITS.assetBytes) {
      throw new AssetLimitError('Embedded image exceeds the 20 MiB compilation limit');
    }
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return { data: ext === 'svg' ? sanitizeSvgImage(data) : data, ext };
  }
  // A percent-encoded byte needs at most three source characters. Bound the
  // decode allocation before validating the exact UTF-8 result below.
  if (payload.length > COMPILER_LIMITS.assetBytes * 3) {
    throw new AssetLimitError('Embedded image exceeds the 20 MiB compilation limit');
  }
  const data = new TextEncoder().encode(decodeURIComponent(payload));
  if (data.byteLength > COMPILER_LIMITS.assetBytes) {
    throw new AssetLimitError('Embedded image exceeds the 20 MiB compilation limit');
  }
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
  let totalAssetBytes = 0;
  let missing = 0;
  let blockedRemote = 0;
  const srcs = new Set<string>();
  doc.descendants((node) => {
    if ((node.type.name === 'figure' || node.type.name === 'image') && node.attrs.src) {
      srcs.add(node.attrs.src as string);
      if (srcs.size > COMPILER_LIMITS.assetCount) {
        throw new AssetLimitError(`Document has more than ${COMPILER_LIMITS.assetCount} image assets`);
      }
    }
    return true;
  });
  // Executable embeds are arbitrary Typst rather than structured figure
  // nodes. Direct literal image paths are nevertheless statically knowable
  // and must enter the same VFS used by Proof/PDF and exact embed crops.
  for (const src of documentTypstEmbedImagePaths(doc)) {
    srcs.add(src);
    if (srcs.size > COMPILER_LIMITS.assetCount) {
      throw new AssetLimitError(`Document has more than ${COMPILER_LIMITS.assetCount} image assets`);
    }
  }

  const addAsset = (path: string, data: Uint8Array) => {
    if (assets.length >= COMPILER_LIMITS.assetCount) {
      throw new AssetLimitError(`Document has more than ${COMPILER_LIMITS.assetCount} compiler assets`);
    }
    if (data.byteLength > COMPILER_LIMITS.assetBytes) {
      throw new AssetLimitError('A compiler asset exceeds the 20 MiB limit');
    }
    totalAssetBytes += data.byteLength;
    if (totalAssetBytes > COMPILER_LIMITS.totalAssetBytes) {
      throw new AssetLimitError('Compiler assets exceed the 64 MiB document limit');
    }
    assets.push({ path, data });
  };

  let n = 0;
  for (const src of srcs) {
    let embedded: ReturnType<typeof dataUrlToBytes> = null;
    try {
      embedded = dataUrlToBytes(src);
    } catch (error) {
      if (error instanceof AssetLimitError) throw error;
      // Malformed encodings and invalid SVGs become inert placeholders.
    }
    if (embedded) {
      n++;
      const path = `/assets/img-${n}.${embedded.ext}`;
      map.set(src, path);
      addAsset(path, embedded.data);
      continue;
    }
    if (/^data:/i.test(src)) {
      n++;
      const path = `/assets/img-${n}.png`;
      map.set(src, path);
      addAsset(path, await missingPlaceholder());
      missing++;
      continue;
    }
    const remote = remoteImageStatus(src);
    if (remote) {
      if (!remote.allowed) {
        n++;
        const path = `/assets/img-${n}.png`;
        map.set(src, path);
        addAsset(path, await missingPlaceholder());
        blockedRemote++;
        continue;
      }
      try {
        const image = await loadRemoteImage(src);
        n++;
        const path = `/assets/img-${n}.${image.extension}`;
        map.set(src, path);
        addAsset(path, image.data);
      } catch (error) {
        if (error instanceof AssetLimitError) throw error;
        n++;
        const path = `/assets/img-${n}.png`;
        map.set(src, path);
        addAsset(path, await missingPlaceholder());
        missing++;
      }
      continue;
    }
    // Project-relative path: register at the same path in the VFS, so the
    // emitted image("figures/x.png") resolves against /main.typ untouched —
    // the exported file stays CLI-compilable.
    if (!src.startsWith('/') && assetReader) {
      // A reference that walks above the project folder ("../logo.png") has no
      // VFS location — Typst's own root rule forbids one just as the browser
      // forbids reading it — so it gets a flat placeholder path. Registering it
      // literally would produce "/../logo.png" and fail the whole compile, page
      // oracle included, over one unreachable image.
      const placeable = isValidAssetPath('/' + src);
      const data = placeable ? await assetReader(src, COMPILER_LIMITS.assetBytes) : null;
      if (data) {
        addAsset('/' + src, data);
      } else if (placeable) {
        // File deleted/renamed on disk: compile with a placeholder at the
        // same path instead of failing the whole export.
        addAsset('/' + src, await missingPlaceholder());
        missing++;
      } else {
        n++;
        const path = `/assets/img-${n}.png`;
        map.set(src, path);
        addAsset(path, await missingPlaceholder());
        missing++;
      }
    }
  }
  return { map, assets, missing, blockedRemote };
}

/** The single serialization/asset boundary for every whole-document output.
 * Exact proof SVG and exported PDF intentionally consume this same value so
 * neither surface can acquire a private serializer, fallback, or asset map. */
async function prepareDocumentCompileInput(
  doc: PMNode,
  instrumentEditorPublication = false,
): Promise<PreparedDocumentCompileInput> {
  const { map, assets, missing, blockedRemote } = await prepareAssets(doc);
  return {
    source: docToTyp(doc, {
      resolveImage: (src) => map.get(src) ?? src,
      fontFallback: FONT_FALLBACK,
      embedRegions: instrumentEditorPublication,
      layoutRegions: instrumentEditorPublication,
      inlineRegions: instrumentEditorPublication,
      previewRegions: instrumentEditorPublication,
    }),
    assets,
    missing,
    blockedRemote,
  };
}

function wholeDocumentTask(kind: 'document-svg' | 'document-svg-regions' | 'pdf', input: PreparedDocumentCompileInput) {
  return { kind, source: input.source, assets: input.assets } as const;
}

/** Keep direct/test callers behind the same lazy worker-client boundary as
 * coordinated product work. Product previews supply a coordinator request;
 * this fallback exists for low-level security tests and API compatibility. */
async function runDirectCompilerTask<T extends CompilerValue>(
  task: CompilerTask,
  options: { timeoutMs: number; onMessage?: (message: string) => void },
): Promise<T> {
  const { runCompilerTask } = await import('./typst-worker-client');
  return runCompilerTask<T>(task, options);
}

/**
 * Compile the full document (with embedded assets) to a multi-page SVG —
 * the page-break oracle's channel. Returns null on failure.
 */
export function compileDocSvg(
  doc: PMNode,
  onMsg: (m: string) => void = () => {},
  coordinated?: CoordinatedCompileRequest,
  signal?: AbortSignal,
): Promise<string | null> {
  return (async () => {
    try {
      if (signal?.aborted) return null;
      const input = await prepareDocumentCompileInput(doc);
      // Asset readers and approved remote images are asynchronous. A view can
      // disappear before this work reaches the coordinator, where cancel(key)
      // cannot see it yet. Do not admit that now-invisible compile afterward.
      if (signal?.aborted) return null;
      const task = wholeDocumentTask('document-svg', input);
      return coordinated
        ? await runCoordinatedCompilerTask<string>(task, {
            ...coordinated,
            timeoutMs: COMPILER_DEADLINES.documentMs,
            onMessage: onMsg,
          })
        : await runDirectCompilerTask<string>(
            task,
            { timeoutMs: COMPILER_DEADLINES.documentMs, onMessage: onMsg },
          );
    } catch (error) {
      console.warn('doc svg compile failed', error);
      return null;
    }
  })();
}

/** Compile the exact prepared whole document and return physical start/end
 * positions for every dedicated Typst embed. One caller can distribute this
 * result to all node views; no embed receives a synthetic or assetless world. */
export function compileDocSvgWithEmbedRegions(
  doc: PMNode,
  onMsg: (m: string) => void = () => {},
  coordinated?: CoordinatedCompileRequest,
  signal?: AbortSignal,
): Promise<TypstDocumentSvgPublication | null> {
  return (async () => {
    try {
      if (signal?.aborted) return null;
      const input = await prepareDocumentCompileInput(doc, true);
      if (signal?.aborted) return null;
      const task = wholeDocumentTask('document-svg-regions', input);
      return coordinated
        ? await runCoordinatedCompilerTask<TypstDocumentSvgPublication>(task, {
            ...coordinated,
            timeoutMs: COMPILER_DEADLINES.documentMs,
            onMessage: onMsg,
          })
        : await runDirectCompilerTask<TypstDocumentSvgPublication>(
            task,
            { timeoutMs: COMPILER_DEADLINES.documentMs, onMessage: onMsg },
          );
    } catch (error) {
      console.warn('embed document svg compile failed', error);
      return null;
    }
  })();
}

/** Compile the deliberate read-only proof through the protected final lane.
 * Asset preparation is shared with PDF export and remains cancelable before
 * admission; once admitted, the user-owned proof cannot be evicted or aborted
 * by preview churn. Like export, opening Proof is a trusted retry boundary
 * after an earlier background timeout opened the compiler circuit. */
export async function compileDocProofSvg(
  doc: PMNode,
  onMsg: (m: string) => void = () => {},
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null;
  resetCompilerCircuit();
  const input = await prepareDocumentCompileInput(doc);
  if (signal?.aborted) return null;
  return runFinalCompilerTask<string>(
    wholeDocumentTask('document-svg', input),
    { timeoutMs: COMPILER_DEADLINES.documentMs, onMessage: onMsg },
  );
}

export interface CompiledDocumentPdf {
  data: Uint8Array;
  missing: number;
  blockedRemote: number;
}

/** Compile the same prepared whole-document input used by exact proof. */
export async function compileDocPdf(
  doc: PMNode,
  onMsg: (m: string) => void = () => {},
): Promise<CompiledDocumentPdf> {
  const input = await prepareDocumentCompileInput(doc);
  const data = await runFinalCompilerTask<Uint8Array>(
    wholeDocumentTask('pdf', input),
    { timeoutMs: COMPILER_DEADLINES.exportMs, onMessage: onMsg },
  );
  return {
    data,
    missing: input.missing,
    blockedRemote: input.blockedRemote,
  };
}

export async function exportPdf(doc: PMNode, baseName: string, onMsg: (m: string) => void): Promise<void> {
  // Export is an explicit user action, so it may make one fresh attempt after
  // a background timeout. Another timeout reopens the circuit immediately.
  resetCompilerCircuit();
  try {
    onMsg('Preparing document…');
    onMsg('Typesetting with Typst…');
    const t0 = performance.now();
    const { data, missing, blockedRemote } = await compileDocPdf(doc, onMsg);

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
