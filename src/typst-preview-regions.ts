import type { Node as PMNode } from 'prosemirror-model';
import type { TypstPagePosition } from './typst-embed-regions';

/** Reserved Typst plumbing for paint crops extracted from the exact shared
 * whole-document publication. Normal .typ, Proof, and PDF output never
 * contains these identifiers. */
export const TYPST_PREVIEW_REGION_STATE = 'typeset-plass:preview-regions:v1';
export const TYPST_PREVIEW_REGION_LABEL = 'typeset-plass-internal-preview-regions-v1';
export const TYPST_PREVIEW_REGION_KIND = 'typeset-plass-preview-regions-v1';
export const TYPST_PREVIEW_REGION_MARKER = '__typeset_plass_preview_region_marker_v1';

/** Transparent SVG links are geometry metadata, not navigable document
 * content. HTTPS keeps them valid in Typst while the reserved origin makes
 * them unambiguous and easy to strip from the sanitized preview asset. */
export const TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX =
  'https://plass.invalid/.well-known/preview-region/math-inline/';

export type TypstPreviewRegionKind = 'typst-inline' | 'math-inline' | 'math-display' | 'bibliography';

export interface TypstInlineMathPreviewRegion {
  index: number;
  kind: 'typst-inline' | 'math-inline';
  baseline: TypstPagePosition;
}

export interface TypstBoundedPreviewRegion {
  index: number;
  kind: 'math-display' | 'bibliography';
  start: TypstPagePosition;
  end: TypstPagePosition;
}

export type TypstPreviewRegion = TypstInlineMathPreviewRegion | TypstBoundedPreviewRegion;

type TypstPreviewRegionEdge = 'baseline' | 'start' | 'end';

interface RegionParts {
  kind?: TypstPreviewRegionKind;
  baseline?: TypstPagePosition;
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

function isKind(value: unknown): value is TypstPreviewRegionKind {
  return value === 'typst-inline' || value === 'math-inline' ||
    value === 'math-display' || value === 'bibliography';
}

function isEdge(value: unknown): value is TypstPreviewRegionEdge {
  return value === 'baseline' || value === 'start' || value === 'end';
}

/**
 * Parse exactly one reserved metadata payload. Foreign query results are
 * ignored, but a duplicated reserved payload is an authority collision and
 * fails closed. Within a valid payload, ambiguity invalidates only its own
 * preorder index so one damaged crop cannot poison every other preview.
 */
export function parseTypstPreviewRegions(query: unknown): TypstPreviewRegion[] {
  if (!Array.isArray(query)) return [];
  const reserved = query
    .map((item) => item && typeof item === 'object' ? (item as { value?: unknown }).value : null)
    .filter((value): value is { kind?: unknown; regions?: unknown } => !!value && typeof value === 'object')
    .filter((value) => value.kind === TYPST_PREVIEW_REGION_KIND);
  if (reserved.length !== 1 || !Array.isArray(reserved[0].regions)) return [];

  const partsByIndex = new Map<number, RegionParts>();
  for (const raw of reserved[0].regions) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as { index?: unknown; kind?: unknown; edge?: unknown; pos?: unknown };
    if (!Number.isSafeInteger(candidate.index) || (candidate.index as number) < 0) continue;
    const index = candidate.index as number;
    const parts = partsByIndex.get(index) ?? {};
    partsByIndex.set(index, parts);

    if (!isKind(candidate.kind)) {
      parts.invalid = true;
      continue;
    }
    if (parts.kind && parts.kind !== candidate.kind) {
      parts.invalid = true;
      continue;
    }
    parts.kind = candidate.kind;

    if (!isEdge(candidate.edge)) {
      parts.invalid = true;
      continue;
    }
    const validEdge = candidate.kind === 'math-inline' || candidate.kind === 'typst-inline'
      ? candidate.edge === 'baseline'
      : candidate.edge === 'start' || candidate.edge === 'end';
    const parsedPoint = point(candidate.pos);
    if (!validEdge || !parsedPoint || parts[candidate.edge]) {
      parts.invalid = true;
      continue;
    }
    parts[candidate.edge] = parsedPoint;
  }

  const regions: TypstPreviewRegion[] = [];
  for (const [index, parts] of [...partsByIndex.entries()].sort((left, right) => left[0] - right[0])) {
    if (parts.invalid || !parts.kind) continue;
    if (parts.kind === 'math-inline' || parts.kind === 'typst-inline') {
      if (parts.baseline && !parts.start && !parts.end) {
        regions.push({ index, kind: parts.kind, baseline: parts.baseline });
      }
    } else if (parts.start && parts.end && !parts.baseline) {
      regions.push({ index, kind: parts.kind, start: parts.start, end: parts.end });
    }
  }
  return regions;
}

export function typstPreviewInlineMathLink(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError('Typst preview region index must be a non-negative safe integer');
  }
  return `${TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX}${index}`;
}

export function typstPreviewInlineMathIndexFromLink(value: unknown): number | null {
  if (typeof value !== 'string' || !value.startsWith(TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX)) return null;
  const suffix = value.slice(TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX.length);
  if (!/^(?:0|[1-9]\d*)$/.test(suffix)) return null;
  const index = Number(suffix);
  return Number.isSafeInteger(index) ? index : null;
}

const PREVIEW_NODE_NAMES = new Set(['typst_inline', 'math_inline', 'math_display', 'bibliography']);

/** Return the shared preview preorder index for the node that begins exactly
 * at `pos`. Empty math/bibliography nodes count: serialization allocates an
 * index from document structure, never from whether there happens to be ink. */
export function typstPreviewRegionIndexAt(doc: PMNode, pos: number): number | null {
  if (!Number.isSafeInteger(pos) || pos < 0 || pos > doc.content.size) return null;
  let nextIndex = 0;
  let result: number | null = null;
  doc.descendants((node, nodePos) => {
    if (result !== null) return false;
    if (!PREVIEW_NODE_NAMES.has(node.type.name)) return true;
    if (nodePos === pos) {
      result = nextIndex;
      return false;
    }
    nextIndex++;
    return false;
  });
  return result;
}
