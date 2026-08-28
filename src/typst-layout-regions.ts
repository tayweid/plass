import type { TypstPagePosition } from './typst-embed-regions';

/** Reserved Typst plumbing for contextual lines extracted from the exact
 * whole-document compile. These identifiers never appear in a normal .typ
 * export; they are added only to the compiler's prepared source. */
export const TYPST_LAYOUT_REGION_STATE = 'typeset-plass:layout-regions:v1';
export const TYPST_LAYOUT_REGION_LABEL = 'typeset-plass-internal-layout-regions-v1';
export const TYPST_LAYOUT_REGION_KIND = 'typeset-plass-layout-regions-v1';
export const TYPST_LAYOUT_REGION_MARKER = '__typeset_plass_layout_region_marker_v1';

export type TypstLayoutRegionKind = 'figure-caption' | 'footnote';

export interface TypstLayoutRegion {
  /** Deterministic preorder among instrumented contextual nodes. */
  index: number;
  kind: TypstLayoutRegionKind;
  start: TypstPagePosition;
  end: TypstPagePosition;
}

interface RegionEdges {
  kind?: TypstLayoutRegionKind;
  start?: TypstPagePosition;
  end?: TypstPagePosition;
  invalid?: boolean;
}

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

/**
 * Parse the internal query without allowing one malformed/duplicated context
 * to poison the shared SVG publication. Ambiguous indices are omitted; the
 * PageOracle knows the expected targets and fails only those blocks closed.
 */
export function parseTypstLayoutRegions(query: unknown): TypstLayoutRegion[] {
  const items = Array.isArray(query) ? query : [];
  const payloads = items
    .map((item) => item && typeof item === 'object' ? (item as { value?: unknown }).value : null)
    .filter((value): value is { kind?: unknown; regions?: unknown } => !!value && typeof value === 'object')
    .filter((value) => value.kind === TYPST_LAYOUT_REGION_KIND && Array.isArray(value.regions));
  // A second internal payload can only be user collision or duplicated
  // evaluation. Neither is a trustworthy authority for any contextual line.
  if (payloads.length !== 1) return [];

  const pairs = new Map<number, RegionEdges>();
  for (const raw of payloads[0].regions as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as { index?: unknown; kind?: unknown; edge?: unknown; pos?: unknown };
    if (!Number.isSafeInteger(candidate.index) || (candidate.index as number) < 0) continue;
    const index = candidate.index as number;
    const pair = pairs.get(index) ?? {};
    pairs.set(index, pair);
    if (candidate.kind !== 'figure-caption' && candidate.kind !== 'footnote') {
      pair.invalid = true;
      continue;
    }
    if (pair.kind && pair.kind !== candidate.kind) {
      pair.invalid = true;
      continue;
    }
    pair.kind = candidate.kind;
    if (candidate.edge !== 'start' && candidate.edge !== 'end') {
      pair.invalid = true;
      continue;
    }
    const pos = point(candidate.pos);
    if (!pos || pair[candidate.edge]) {
      pair.invalid = true;
      continue;
    }
    pair[candidate.edge] = pos;
  }

  const regions: TypstLayoutRegion[] = [];
  for (const [index, pair] of [...pairs.entries()].sort((left, right) => left[0] - right[0])) {
    if (pair.invalid || !pair.kind || !pair.start || !pair.end) continue;
    regions.push({ index, kind: pair.kind, start: pair.start, end: pair.end });
  }
  return regions;
}
