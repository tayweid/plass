// Structured-clone-only protocol shared by the UI and compiler worker.

export const COMPILER_LIMITS = {
  sourceBytes: 4 * 1024 * 1024,
  assetBytes: 20 * 1024 * 1024,
  totalAssetBytes: 64 * 1024 * 1024,
  assetCount: 256,
  svgOutputBytes: 32 * 1024 * 1024,
  pdfOutputBytes: 64 * 1024 * 1024,
  queryOutputBytes: 2 * 1024 * 1024,
  selectorCharacters: 256,
  assetPathCharacters: 1024,
  // Queue depth is a buffer, not a quota: a table-heavy document legitimately
  // asks for hundreds of fragment previews at once, and a dropped request is a
  // permanently blank table. What actually costs memory is the bytes those
  // requests hold, so that is what the ceiling measures; the count only stops
  // a runaway producer from growing the array without bound.
  pendingRequests: 512,
  pendingRequestBytes: 64 * 1024 * 1024,
} as const;

export const COMPILER_DEADLINES = {
  previewMs: 20_000,
  documentMs: 30_000,
  exportMs: 60_000,
} as const;

export interface CompilerAsset {
  path: string;
  data: Uint8Array;
}

export type CompilerTask =
  | { kind: 'svg'; source: string }
  | { kind: 'query'; source: string; selector: string }
  | { kind: 'document-svg'; source: string; assets: CompilerAsset[] }
  | { kind: 'pdf'; source: string; assets: CompilerAsset[] }
  // Development-only deterministic watchdog probe. The production worker
  // rejects it and Vite folds away its implementation.
  | { kind: 'test-busy'; milliseconds: number };

export interface CompilerRequest {
  id: number;
  task: CompilerTask;
}

export type CompilerResponse =
  | { id: number; ok: true; value: string | Uint8Array | unknown[] | null }
  | { id: number; ok: false; code: 'invalid' | 'compile' | 'output-limit'; message: string };

function utf8Size(value: string, limit: number): number {
  // UTF-8 is never smaller than one byte per UTF-16 code unit for ordinary
  // source text. Avoid allocating a second huge buffer for obvious rejects.
  if (value.length > limit) return value.length;
  return new TextEncoder().encode(value).byteLength;
}

/** The VFS path rule. Exported so asset preparation can divert a document
 * reference the compiler would reject, instead of failing the whole compile. */
export function isValidAssetPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    path.length <= COMPILER_LIMITS.assetPathCharacters &&
    !path.includes('\0') &&
    !path.split('/').includes('..')
  );
}

/** Returns a user-safe validation failure, or null when the request is in budget. */
export function validateCompilerTask(task: CompilerTask): string | null {
  if (task.kind === 'test-busy') {
    return Number.isFinite(task.milliseconds) && task.milliseconds > 0 && task.milliseconds <= 10_000
      ? null
      : 'Invalid watchdog probe';
  }
  if (utf8Size(task.source, COMPILER_LIMITS.sourceBytes) > COMPILER_LIMITS.sourceBytes) {
    return 'Typst source exceeds the 4 MiB compilation limit';
  }
  if (task.kind === 'query' && task.selector.length > COMPILER_LIMITS.selectorCharacters) {
    return 'Typst query selector is too long';
  }
  if (task.kind !== 'document-svg' && task.kind !== 'pdf') return null;
  if (task.assets.length > COMPILER_LIMITS.assetCount) {
    return `Document has more than ${COMPILER_LIMITS.assetCount} compiler assets`;
  }
  let total = 0;
  for (const asset of task.assets) {
    if (!isValidAssetPath(asset.path)) return 'Document contains an invalid compiler asset path';
    if (!(asset.data instanceof Uint8Array)) return 'Document contains an invalid compiler asset';
    if (asset.data.byteLength > COMPILER_LIMITS.assetBytes) {
      return 'A compiler asset exceeds the 20 MiB limit';
    }
    total += asset.data.byteLength;
    if (total > COMPILER_LIMITS.totalAssetBytes) {
      return 'Compiler assets exceed the 64 MiB document limit';
    }
  }
  return null;
}

export function utf8OutputSize(value: string): number {
  return utf8Size(value, Number.MAX_SAFE_INTEGER);
}

/** Bytes a queued task holds alive while it waits for the single worker.
 * The queue's ceiling is expressed in these, not in request count, because
 * memory is the resource the buffer actually spends. */
export function compilerTaskBytes(task: CompilerTask): number {
  if (task.kind === 'test-busy') return 0;
  let bytes = task.source.length;
  if (task.kind === 'document-svg' || task.kind === 'pdf') {
    for (const asset of task.assets) bytes += asset.data.byteLength;
  }
  return bytes;
}
