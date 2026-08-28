import type { ForcedBreak } from './paragraph';

/** A page boundary reported by the exact full-document Typst compile. */
export interface SnapshotPageStart {
  readonly pos: number;
  readonly line: number;
  readonly unit: string;
  readonly level?: number;
}

/** Exact line boundaries for one ProseMirror block in the compiled document. */
export interface SnapshotBlockBreaks {
  readonly pos: number;
  readonly type: string;
  /** buildSpec's content signature guards against position reuse. */
  readonly contentKey: string;
  readonly breaks: readonly ForcedBreak[];
}

/**
 * The only settled layout publication consumed by the editing surface.
 *
 * A snapshot is derived from one full-document Typst SVG and is immutable.
 * Line matching may succeed even when an opaque block prevents page-start
 * mapping, so pageStarts is null for a line-exact/page-unknown snapshot.
 */
export interface LayoutSnapshot {
  /** Monotonic compiler request revision for this layout consumer. */
  readonly revision: number;
  readonly documentKey: string;
  readonly pageCount: number;
  readonly pageStarts: readonly SnapshotPageStart[] | null;
  readonly blocks: readonly SnapshotBlockBreaks[];
}

const breakIndexes = new WeakMap<LayoutSnapshot, ReadonlyMap<string, readonly ForcedBreak[]>>();

export function snapshotBlockKey(pos: number, contentKey: string): string {
  return `${pos}:${contentKey}`;
}

export function createLayoutSnapshot(input: {
  revision: number;
  documentKey: string;
  pageCount: number;
  pageStarts: readonly SnapshotPageStart[] | null;
  blocks: readonly SnapshotBlockBreaks[];
}): LayoutSnapshot {
  const pageStarts = input.pageStarts?.map((start) => Object.freeze({ ...start })) ?? null;
  const blocks = input.blocks.map((block) => Object.freeze({
    ...block,
    breaks: Object.freeze(block.breaks.map((item) => Object.freeze({ ...item }))),
  }));
  return Object.freeze({
    revision: input.revision,
    documentKey: input.documentKey,
    pageCount: input.pageCount,
    pageStarts: pageStarts ? Object.freeze(pageStarts) : null,
    blocks: Object.freeze(blocks),
  });
}

/** O(1) lookup after a snapshot's first read, without exposing a mutable Map. */
export function snapshotBreaksFor(
  snapshot: LayoutSnapshot | undefined,
  pos: number,
  contentKey: string,
): readonly ForcedBreak[] | undefined {
  if (!snapshot) return undefined;
  let index = breakIndexes.get(snapshot);
  if (!index) {
    index = new Map(
      snapshot.blocks.map((block) => [snapshotBlockKey(block.pos, block.contentKey), block.breaks]),
    );
    breakIndexes.set(snapshot, index);
  }
  return index.get(snapshotBlockKey(pos, contentKey));
}
