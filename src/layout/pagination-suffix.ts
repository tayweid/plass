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
  readonly kind: 'line' | 'block' | 'row';
  readonly hdr?: number;
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
  /** Current top-level block boundary at which the suffix may restart. */
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
  /** The preserved page-start markers, one per prefix gap, ending at the
   * anchor. A caller holding an authoritative basis (exact Typst page starts)
   * can re-force exactly these breaks against the live document to rebuild
   * the prefix geometry independently of the stored spacer heights. */
  readonly prefixMarkers: readonly SuffixPageMarker[];
}

export type SuffixPaginationRejectReason =
  | 'epoch-changed'
  | 'doc-attrs'
  | 'table'
  | 'ineligible-block'
  | 'special-inline'
  | 'invalid-marker'
  | 'marker-order'
  | 'invalid-page-ordinal'
  | 'no-boundary-anchor'
  | 'mid-line-anchor'
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

/** Block node types the fallback paginator handles deterministically from the
 * painted DOM alone: paragraphs split at cached line boundaries, lists and
 * blockquotes break between (and inside) children, and everything else moves
 * whole. Both the seeded and the full pass read the same DOM at the same
 * instant, so async heights (figures, committed math, bibliographies) cannot
 * diverge between them. Tables are excluded: a table crossing a page bottom
 * launches a Typst mini-compile and stages table effects, which a seeded or
 * comparison pass cannot replay side-effect-free. */
const ELIGIBLE_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'code_block',
  'blockquote',
  'bullet_list',
  'ordered_list',
  'list_item',
  'figure',
  'math_display',
  'horizontal_rule',
  'page_break',
  'numbering_restart',
  'doc_title',
  'doc_authors',
  'doc_date',
  'abstract',
  'bibliography',
]);

/** Inline content the paginator never treats specially: it only ever measures
 * the enclosing line/block box. Footnote markers are eligible because the
 * seeded pass reserves footnote-body heights exactly like the full pass
 * (bodies before the restart boundary belong to already-settled pages). */
const ELIGIBLE_INLINE_TYPES = new Set([
  'hard_break',
  'image',
  'math_inline',
  'typst_inline',
  'citation',
  'eq_ref',
  'footnote',
]);

/** First hazard that forces the whole-document path, or null when every node
 * in the document is one the fallback paginator handles deterministically. */
function contentIneligibility(doc: PMNode): SuffixPaginationRejectReason | null {
  let reason: SuffixPaginationRejectReason | null = null;
  doc.descendants((node) => {
    if (reason) return false;
    if (node.isText) return false;
    if (node.isInline) {
      if (!ELIGIBLE_INLINE_TYPES.has(node.type.name)) {
        reason = 'special-inline';
        return false;
      }
      return true;
    }
    if (node.type.name === 'table') {
      reason = 'table';
      return false;
    }
    if (!ELIGIBLE_BLOCK_TYPES.has(node.type.name)) {
      reason = 'ineligible-block';
      return false;
    }
    return true;
  });
  return reason;
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
    (spacer.kind === 'line' || spacer.kind === 'block' || spacer.kind === 'row')
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
 * "last transaction" position. Only the PREFIX — the top-level blocks that are
 * deeply equal between basis and current — must survive intact: everything at
 * or after the first differing block (splits, joins, insertions, removals) is
 * recomputed by the seeded pass, so top-level structure may change freely
 * there. A rejection is expected and safe; the caller simply retains the
 * existing full-document pagination path.
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

  // Document attributes carry settings (page geometry, fonts) and the
  // bibliography: any change there invalidates every stored page start.
  if (!basisDoc.sameMarkup(currentDoc)) return reject('doc-attrs');

  const ineligible = contentIneligibility(currentDoc);
  if (ineligible) return reject(ineligible);

  const dirtyPos = basisDoc.content.findDiffStart(currentDoc.content);
  if (dirtyPos === null) return { kind: 'none', reason: 'unchanged' };

  // The clean prefix: leading top-level blocks that are deeply equal (type,
  // attributes, marks, content). Positions inside it are identical in both
  // revisions, so basis markers there remain valid current positions.
  const basisBlocks = topLevelBlocks(basisDoc);
  const currentBlocks = topLevelBlocks(currentDoc);
  const shared = Math.min(basisBlocks.length, currentBlocks.length);
  let dirtyIndex = 0;
  while (dirtyIndex < shared && basisBlocks[dirtyIndex].node.eq(currentBlocks[dirtyIndex].node)) {
    dirtyIndex++;
  }
  const dirtyStart =
    dirtyIndex < currentBlocks.length ? currentBlocks[dirtyIndex].pos : currentDoc.content.size;

  // Validate the marker prefix while scanning to the dirty boundary. Markers
  // PAST the dirty boundary are recomputed by the seeded pass, so a stale or
  // unmappable trailing marker merely ends the scan instead of rejecting the
  // document.
  let scanEnd = -1;
  let previousPos = -1;
  let previousLine = -1;
  for (let index = 0; index < input.markers.length; index++) {
    const marker = input.markers[index];
    if (!markerIsNumeric(marker)) break;
    if (marker.pos > dirtyStart) break;
    // Every physical page start is present, so exact marker ordinals are the
    // contiguous internal page indices 1, 2, ... .
    if (marker.page !== index + 1) return reject('invalid-page-ordinal');
    if (marker.pos < previousPos || (marker.pos === previousPos && marker.line <= previousLine)) {
      return reject('marker-order');
    }
    // `line: 0` is a block start and `line > 0` a split inside a block; the
    // 'line' unit must agree or the marker's provenance is untrustworthy.
    if ((marker.line === 0) === (marker.unit === 'line')) return reject('invalid-marker');
    previousPos = marker.pos;
    previousLine = marker.line;
    scanEnd = index;
  }
  if (scanEnd < 0) return reject('no-boundary-anchor');

  // The anchor is the LATEST page start at or before the dirty boundary that
  // sits on a top-level block boundary. A later mid-block or container-nested
  // start cannot seed the runner, but skipping back past it is sound: it is
  // then part of the recomputed suffix, exactly like every start past the
  // dirty boundary — the trade is only a larger suffix, never correctness.
  let anchorMarkerIndex = -1;
  let $anchor: ReturnType<PMNode['resolve']> | null = null;
  for (let index = scanEnd; index >= 0; index--) {
    const marker = input.markers[index];
    if (marker.line !== 0) continue;
    const $pos = currentDoc.resolve(marker.pos);
    if ($pos.depth !== 0 || !$pos.nodeAfter) continue;
    anchorMarkerIndex = index;
    $anchor = $pos;
    break;
  }
  if (anchorMarkerIndex < 0 || !$anchor) {
    return reject(input.markers[scanEnd].line !== 0 ? 'mid-line-anchor' : 'anchor-boundary');
  }
  const anchor = input.markers[anchorMarkerIndex];

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
  // marker shares its exact position with a block spacer and must sit at a
  // block boundary (top-level, or a child boundary inside a container). A
  // mid-block marker retains its textblock's boundary while its line spacer
  // lies strictly inside that same textblock.
  for (let index = 0; index < prefixMarkers.length; index++) {
    const marker = prefixMarkers[index];
    const spacer = prefix[index];
    const target = currentDoc.resolve(marker.pos).nodeAfter;
    if (!target || target.isInline) return reject('prefix-spacer-mismatch');
    if (marker.line === 0) {
      if (spacer.kind !== 'block' || spacer.pos !== marker.pos) {
        return reject('prefix-spacer-mismatch');
      }
    } else if (
      !target.isTextblock ||
      spacer.kind !== 'line' ||
      spacer.pos <= marker.pos ||
      spacer.pos >= marker.pos + target.nodeSize
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
    startIndex: $anchor.index(0),
    dirtyPos,
    dirtyIndex,
    page: anchor.page,
    shift,
    prefixSpacers: Object.freeze(prefixSpacers),
    prefixMarkers: Object.freeze(prefixMarkers.map((marker) => Object.freeze({ ...marker }))),
  });
  return { kind: 'seed', seed };
}
