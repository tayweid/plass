// Conservative eligibility and seed construction for restarting fallback
// pagination at an exact, mapped page boundary. This module deliberately has
// no DOM or ProseMirror-view dependencies: callers may compare an old exact
// document directly with the current document before doing any geometry work.

import type { Node as PMNode } from 'prosemirror-model';

/** A mapped exact page-start marker. `page` is the zero-based physical page
 * index: the first stored marker starts physical page two and has `page: 1`. */
export interface SuffixPageMarker {
  readonly pos: number;
  readonly line: number;
  readonly unit: string;
  readonly page: number;
}

/** A currently painted page gap. These are copied into an eligible seed so
 * the caller cannot mutate the DecorationSet-derived input during a pass. */
export interface SuffixPageSpacer {
  readonly pos: number;
  readonly height: number;
  readonly kind: 'line' | 'block';
}

export interface SuffixPaginationInput {
  /** Document revision for which the page markers were authoritative. */
  readonly basisDoc: PMNode;
  /** Current, possibly multiply edited, document revision. */
  readonly currentDoc: PMNode;
  readonly markers: readonly SuffixPageMarker[];
  readonly spacers: readonly SuffixPageSpacer[];
  /** Broad geometry/settings generations. Equality is a prerequisite; an
   * edit-only suffix must never bridge a global metric invalidation. */
  readonly basisEpoch: number;
  readonly currentEpoch: number;
}

export interface SuffixPaginationSeed {
  /** Current top-level paragraph boundary at which the suffix may restart. */
  readonly startPos: number;
  readonly startIndex: number;
  /** Earliest direct basis-to-current content difference. */
  readonly dirtyPos: number;
  readonly dirtyIndex: number;
  /** Zero-based physical page index at `startPos`. */
  readonly page: number;
  /** Sum of the copied prefix page gaps, in their existing addition order. */
  readonly shift: number;
  readonly prefixSpacers: readonly SuffixPageSpacer[];
}

export type SuffixPaginationRejectReason =
  | 'epoch-changed'
  | 'top-level-structure'
  | 'non-paragraph-document'
  | 'special-inline'
  | 'invalid-marker'
  | 'marker-order'
  | 'invalid-page-ordinal'
  | 'no-boundary-anchor'
  | 'mid-line-anchor'
  | 'anchor-unit'
  | 'anchor-boundary'
  | 'invalid-spacer'
  | 'prefix-spacer-mismatch';

export type SuffixPaginationDecision =
  | { readonly kind: 'seed'; readonly seed: SuffixPaginationSeed }
  | { readonly kind: 'none'; readonly reason: 'unchanged' }
  | { readonly kind: 'reject'; readonly reason: SuffixPaginationRejectReason };

interface TopLevelBlock {
  readonly node: PMNode;
  readonly pos: number;
  readonly index: number;
}

function topLevelBlocks(doc: PMNode): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  doc.forEach((node, pos, index) => blocks.push({ node, pos, index }));
  return blocks;
}

/** Suffix pagination is intentionally restricted to text (with optional
 * marks). Inline atoms and editable footnotes have independent geometry and
 * force the established whole-document path. */
function hasSpecialInline(node: PMNode): boolean {
  let special = false;
  node.descendants((child) => {
    if (!child.isText) {
      special = true;
      return false;
    }
    return true;
  });
  return special;
}

function markerIsNumeric(marker: SuffixPageMarker): boolean {
  return (
    Number.isInteger(marker.pos) &&
    marker.pos >= 0 &&
    Number.isInteger(marker.line) &&
    marker.line >= 0 &&
    Number.isInteger(marker.page) &&
    marker.page >= 1 &&
    typeof marker.unit === 'string' &&
    marker.unit.length > 0
  );
}

function spacerIsValid(spacer: SuffixPageSpacer): boolean {
  return (
    Number.isInteger(spacer.pos) &&
    spacer.pos >= 0 &&
    Number.isFinite(spacer.height) &&
    spacer.height > 0 &&
    (spacer.kind === 'line' || spacer.kind === 'block')
  );
}

function reject(reason: SuffixPaginationRejectReason): SuffixPaginationDecision {
  return { kind: 'reject', reason };
}

/**
 * Build a conservative restart seed for fallback pagination.
 *
 * The direct `basisDoc.content.findDiffStart(currentDoc.content)` comparison
 * is important: the basis remains the last exact revision, so several edits
 * accumulate into one earliest dirty point rather than overwriting a mutable
 * "last transaction" position. A rejection is expected and safe; the caller
 * simply retains the existing full-document pagination path.
 */
export function planSuffixPagination(input: SuffixPaginationInput): SuffixPaginationDecision {
  const { basisDoc, currentDoc } = input;
  if (
    !Number.isInteger(input.basisEpoch) ||
    !Number.isInteger(input.currentEpoch) ||
    input.basisEpoch !== input.currentEpoch
  ) {
    return reject('epoch-changed');
  }

  if (!basisDoc.sameMarkup(currentDoc)) return reject('top-level-structure');
  const basisBlocks = topLevelBlocks(basisDoc);
  const currentBlocks = topLevelBlocks(currentDoc);
  if (basisBlocks.length !== currentBlocks.length) return reject('top-level-structure');

  for (let index = 0; index < basisBlocks.length; index++) {
    const basis = basisBlocks[index].node;
    const current = currentBlocks[index].node;
    if (basis.type !== current.type || !basis.sameMarkup(current)) return reject('top-level-structure');
    if (basis.type.name !== 'paragraph') return reject('non-paragraph-document');
    if (hasSpecialInline(basis) || hasSpecialInline(current)) return reject('special-inline');
  }

  const dirtyPos = basisDoc.content.findDiffStart(currentDoc.content);
  if (dirtyPos === null) return { kind: 'none', reason: 'unchanged' };

  // The first unequal corresponding paragraph is the current-document
  // boundary that owns findDiffStart. Child boundaries before it are equal,
  // even when multiple later edits changed subsequent node sizes.
  const dirtyIndex = basisBlocks.findIndex(
    (basis, index) => !basis.node.content.eq(currentBlocks[index].node.content),
  );
  if (dirtyIndex < 0) return reject('top-level-structure');
  const dirtyStart = currentBlocks[dirtyIndex].pos;

  let previousPos = -1;
  let previousLine = -1;
  for (let index = 0; index < input.markers.length; index++) {
    const marker = input.markers[index];
    if (!markerIsNumeric(marker)) return reject('invalid-marker');
    // Every physical page start is present, so exact marker ordinals are the
    // contiguous internal page indices 1, 2, ... .
    if (marker.page !== index + 1) return reject('invalid-page-ordinal');
    if (marker.pos < previousPos || (marker.pos === previousPos && marker.line <= previousLine)) {
      return reject('marker-order');
    }
    previousPos = marker.pos;
    previousLine = marker.line;
  }

  let anchorMarkerIndex = -1;
  for (let index = 0; index < input.markers.length; index++) {
    if (input.markers[index].pos <= dirtyStart) anchorMarkerIndex = index;
    else break;
  }
  if (anchorMarkerIndex < 0) return reject('no-boundary-anchor');

  const anchor = input.markers[anchorMarkerIndex];
  // Do not skip back past a later mid-paragraph start. The latest exact start
  // is the state entering the dirty paragraph; if it cannot seed at a block
  // boundary, a full pass is the only conservative option.
  if (anchor.line !== 0) return reject('mid-line-anchor');
  if (anchor.unit !== 'paragraph') return reject('anchor-unit');

  const boundaryByPos = new Map(currentBlocks.map((block) => [block.pos, block]));
  const anchorBlock = boundaryByPos.get(anchor.pos);
  if (!anchorBlock || anchorBlock.node.type.name !== 'paragraph') return reject('anchor-boundary');

  let previousSpacerPos = -1;
  for (const spacer of input.spacers) {
    if (!spacerIsValid(spacer)) return reject('invalid-spacer');
    if (spacer.pos < previousSpacerPos) return reject('invalid-spacer');
    previousSpacerPos = spacer.pos;
  }

  const prefixMarkers = input.markers.slice(0, anchorMarkerIndex + 1);
  const prefix = input.spacers.filter((spacer) => spacer.pos <= anchor.pos);
  if (prefix.length !== anchor.page || prefix.length !== prefixMarkers.length) {
    return reject('prefix-spacer-mismatch');
  }

  // Validate every preserved gap against its exact page marker. A block-start
  // marker shares its exact position with a block spacer. A mid-paragraph
  // marker retains its paragraph boundary while its line spacer lies strictly
  // inside that same paragraph.
  for (let index = 0; index < prefixMarkers.length; index++) {
    const marker = prefixMarkers[index];
    const spacer = prefix[index];
    const block = boundaryByPos.get(marker.pos);
    if (!block) return reject('prefix-spacer-mismatch');
    if (marker.line === 0) {
      if (marker.unit !== 'paragraph' || spacer.kind !== 'block' || spacer.pos !== marker.pos) {
        return reject('prefix-spacer-mismatch');
      }
    } else if (
      marker.unit !== 'line' ||
      spacer.kind !== 'line' ||
      spacer.pos <= marker.pos ||
      spacer.pos >= marker.pos + block.node.nodeSize
    ) {
      return reject('prefix-spacer-mismatch');
    }
  }

  if (prefix[prefix.length - 1]?.pos !== anchor.pos) return reject('prefix-spacer-mismatch');

  let shift = 0;
  const prefixSpacers = prefix.map((spacer) => {
    shift += spacer.height;
    return Object.freeze({ ...spacer });
  });
  const seed: SuffixPaginationSeed = Object.freeze({
    startPos: anchor.pos,
    startIndex: anchorBlock.index,
    dirtyPos,
    dirtyIndex,
    page: anchor.page,
    shift,
    prefixSpacers: Object.freeze(prefixSpacers),
  });
  return { kind: 'seed', seed };
}
