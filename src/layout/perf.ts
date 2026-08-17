export interface LayoutPerfSample {
  totalMs: number;
  blockDiscoveryMs?: number;
  lineLayoutMs?: number;
  decorationMs?: number;
  paginationMs?: number;
  footnoteMs?: number;
  paragraphs?: number;
  lines?: number;
  changedBlocks?: number;
}

export interface LayoutPerfState {
  live: LayoutPerfSample | null;
  settle: LayoutPerfSample | null;
}

const state: LayoutPerfState = { live: null, settle: null };

/** Development/test telemetry. This is intentionally a last-value snapshot,
 * not an unbounded event log in a long-running editor. */
export function recordLayoutPerf(kind: keyof LayoutPerfState, sample: LayoutPerfSample) {
  if (!import.meta.env.DEV) return;
  state[kind] = { ...sample };
}

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as unknown as { __layoutPerf: () => LayoutPerfState }).__layoutPerf = () => ({
    live: state.live ? { ...state.live } : null,
    settle: state.settle ? { ...state.settle } : null,
  });
}

