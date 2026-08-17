/** A measured height attached to a ProseMirror document position. */
export interface PaginationHeightSample {
  readonly pos: number;
  readonly height: number;
}

/** Inputs captured once before a pagination pass. `spacers` is the single
 * DecorationSet-ordered stream containing both line and block page gaps;
 * keeping it combined preserves legacy floating-point addition order when
 * two decorations share a position. Table extras are appended afterward,
 * just as they were for the former linear scan. */
export interface PaginationHeightSources {
  readonly spacers: Iterable<PaginationHeightSample>;
  readonly tableExtras: Iterable<PaginationHeightSample>;
}

/** Immutable geometry used throughout one pagination pass. The source lists
 * are copied so a later decoration or table update cannot change a pass that
 * is already in progress. */
export interface PaginationSnapshot {
  readonly spacers: readonly PaginationHeightSample[];
  readonly tableExtras: readonly PaginationHeightSample[];
  readonly heights: HeightIndex;
}

function finiteSample(sample: PaginationHeightSample): PaginationHeightSample | null {
  if (!Number.isFinite(sample.pos) || !Number.isFinite(sample.height)) return null;
  return Object.freeze({ pos: sample.pos, height: sample.height });
}

function snapshotSamples(
  samples: Iterable<PaginationHeightSample>,
  positiveOnly: boolean,
): readonly PaginationHeightSample[] {
  const captured: PaginationHeightSample[] = [];
  for (const sample of samples) {
    const copy = finiteSample(sample);
    if (copy && (!positiveOnly || copy.height > 0)) captured.push(copy);
  }
  return Object.freeze(captured);
}

/** Sorted prefix-sum index for translating painted DOM coordinates back to
 * natural document geometry. Duplicate positions deliberately remain as
 * separate samples: upper-bound lookup includes every sample at the queried
 * position, with the same stable addition order as the former linear scan. */
export class HeightIndex {
  readonly size: number;
  readonly totalHeight: number;

  private readonly positions: Float64Array;
  private readonly cumulativeHeights: Float64Array;

  constructor(samples: Iterable<PaginationHeightSample>) {
    const sorted: PaginationHeightSample[] = [];
    for (const sample of samples) {
      if (Number.isFinite(sample.pos) && Number.isFinite(sample.height)) {
        sorted.push({ pos: sample.pos, height: sample.height });
      }
    }
    sorted.sort((a, b) => a.pos - b.pos);

    this.size = sorted.length;
    this.positions = new Float64Array(this.size);
    this.cumulativeHeights = new Float64Array(this.size);
    let cumulative = 0;
    for (let index = 0; index < sorted.length; index++) {
      const sample = sorted[index];
      cumulative += sample.height;
      this.positions[index] = sample.pos;
      this.cumulativeHeights[index] = cumulative;
    }
    this.totalHeight = cumulative;
  }

  /** Sum every indexed height whose document position is at or before `pos`.
   * This matches the old `sample.pos <= pos` loop. In particular, querying
   * positive Infinity returns the total and querying NaN returns zero. */
  heightAbove(pos: number): number {
    if (Number.isNaN(pos) || this.size === 0) return 0;
    let low = 0;
    let high = this.size;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.positions[middle] <= pos) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? 0 : this.cumulativeHeights[low - 1];
  }
}

/** Capture one internally consistent set of pagination heights. Invalid
 * numeric samples are ignored. Page gaps preserve their established positive
 * only contract; signed table extras are retained byte-for-byte, including
 * zero and negative values. */
export function createPaginationSnapshot(sources: PaginationHeightSources): PaginationSnapshot {
  const spacers = snapshotSamples(sources.spacers, true);
  const tableExtras = snapshotSamples(sources.tableExtras, false);
  const heights = new HeightIndex([...spacers, ...tableExtras]);
  return Object.freeze({ spacers, tableExtras, heights });
}
