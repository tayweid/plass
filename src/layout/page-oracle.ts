// The sole product line-and-page oracle: Typst decides; the editor obeys.
//
// The per-editor publication broker compiles one prepared whole document for
// each immutable ProseMirror document plus asset epoch. The multi-page SVG's
// text-selection layer gives physical lines, while compile-only contextual
// regions delimit figure captions and footnote bodies. Exact token matching
// maps those lines back to blocks; anchored resynchronization crosses opaque
// equations, figures, native tables, and executable Typst embeds. The result
// is one immutable LayoutSnapshot of body/context breaks and page starts.
// Forced-line translation and page spacers project that answer into the native
// editable DOM without running browser fit rules or a second page planner.
//
// A mismatch withholds the page-start map while retaining every line-exact
// block matched before it. The editor stays continuous/native for pagination
// in that revision and self-heals on the next successful document snapshot.

import type { Node as PMNode } from 'prosemirror-model';
import {
  buildSpec,
  matchParagraph,
  selectionRunTolerance,
  type AtomResolver,
  type AtomLineBinding,
  type AtomLineBindings,
  type SvgLine,
  type ParagraphSpec,
} from './typst-oracle';
import { formatPageNumber, pageSize, type DocSettings } from '../settings';
import { parseTypstSvg } from '../safe-svg';
import {
  cancelCoordinatedCompilerTask,
  releaseCoordinatedCompilerKey,
  type CoordinatedCompileRequest,
} from '../compiler/coordinated-compiler';
import {
  createLayoutSnapshot,
  type LayoutSnapshot,
  type SnapshotBlockBreaks,
  type SnapshotPageStart,
} from './layout-snapshot';
import type { TypstDocumentSvgPublication } from '../typst-document-publication';
import type { TypstLayoutRegion, TypstLayoutRegionKind } from '../typst-layout-regions';
import {
  classifyTypstInline,
  typstInlineIndexFromLink,
} from '../typst-inline-regions';
import {
  typstPreviewInlineMathIndexFromLink,
  type TypstPreviewRegion,
} from '../typst-preview-regions';
import type { ForcedBreak } from './paragraph';

export type PageStart = SnapshotPageStart;

export interface PageOracleEntry {
  status: 'ok' | 'fail';
  /** Immutable line + page decisions from this one full-document compile. */
  snapshot?: LayoutSnapshot;
  /** Compatibility aliases while pagination consumers migrate to snapshot. */
  pageStarts?: PageStart[];
  pageCount?: number;
  reason?: string;
}

interface Unit {
  kind: 'exact' | 'opaque';
  pos: number;
  type: string;
  level?: number;
  spec?: ParagraphSpec;
  /** exact list-item paragraphs may carry a marker glyph on their first line. */
  marker?: boolean;
}

interface PagedLine extends SvgLine {
  /** Stable extraction identity used to remove exact footnote-area lines. */
  id: number;
  page: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface PageBounds {
  page: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

type AtomLinkKey = `typst:${number}` | `math:${number}`;

interface ExtractedPages {
  lines: PagedLine[];
  pageCount: number;
  /** Unioned advance rectangles from reserved publication-only links. */
  atomBounds: Map<AtomLinkKey, PageBounds>;
  /** A malformed/duplicated rectangle can never authorize exact matching. */
  ambiguousAtoms: Set<AtomLinkKey>;
}

interface DocumentAtomRef {
  previewIndex: number;
  /** Null only for a supported selection-free atom with a queried baseline. */
  linkKey: AtomLinkKey | null;
  kind: 'typst-inline' | 'math-inline';
}

interface ContextTarget {
  index: number;
  kind: TypstLayoutRegionKind;
  pos: number;
  spec: ParagraphSpec | null;
}

export type PageOracleCompileResult = string | TypstDocumentSvgPublication;

const MAX_RESULTS = 8;
let nextPageOracleId = 1;

export class PageOracle {
  private results = new Map<string, PageOracleEntry>();
  private pendingSig: string | null = null;
  private timer = 0;
  private inflight = false;
  private disposed = false;
  /** Identifies the latest requested page layout. Abort stops asynchronous
   * asset preparation before admission and the coordinator terminates an
   * admitted obsolete worker task; generation remains the publication guard. */
  private generation = 0;
  private compileRevision = 0;
  private compileAbort: AbortController | null = null;
  private readonly compileKey = `layout:pages:${nextPageOracleId++}`;

  constructor(
    private onResults: (entry: PageOracleEntry) => void,
    private compileDocument: (
      doc: PMNode,
      coordinated?: CoordinatedCompileRequest,
      signal?: AbortSignal,
    ) => Promise<PageOracleCompileResult | null> = async (doc, coordinated, signal) => {
      const { compileDocSvgWithEmbedRegions } = await import('../pdf');
      return compileDocSvgWithEmbedRegions(doc, () => {}, coordinated, signal);
    },
  ) {}

  get(sig: string): PageOracleEntry | undefined {
    return this.results.get(sig);
  }

  request(sig: string, doc: PMNode, settings: DocSettings, resolveAtom: AtomResolver) {
    if (this.disposed || this.results.has(sig) || this.pendingSig === sig) return;
    this.generation++;
    this.compileAbort?.abort('newer-request');
    cancelCoordinatedCompilerTask(this.compileKey);
    this.pendingSig = sig;
    this.payload = { doc, settings, resolveAtom };
    clearTimeout(this.timer);
    // TypesetView has already waited for the edit quiet period. A second
    // long debounce only delays exactness and lets local fallback work race
    // the compiler; coalesce a same-frame burst, then compile the revision.
    this.timer = window.setTimeout(() => void this.flush(), 40);
  }

  private payload: { doc: PMNode; settings: DocSettings; resolveAtom: AtomResolver } | null = null;

  clear() {
    this.generation++;
    this.compileAbort?.abort('canceled');
    this.compileAbort = null;
    cancelCoordinatedCompilerTask(this.compileKey);
    clearTimeout(this.timer);
    this.timer = 0;
    this.results.clear();
    this.pendingSig = null;
    this.payload = null;
  }

  /** Supersede a pending or in-flight document compile while retaining exact
   * cached entries for undo/revisit. The post-await generation check occurs
   * before costly SVG parsing and DOM measurement. */
  cancelPending() {
    this.generation++;
    this.compileAbort?.abort('canceled');
    this.compileAbort = null;
    cancelCoordinatedCompilerTask(this.compileKey);
    clearTimeout(this.timer);
    this.timer = 0;
    this.pendingSig = null;
    this.payload = null;
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.compileAbort?.abort('canceled');
    this.compileAbort = null;
    releaseCoordinatedCompilerKey(this.compileKey);
    clearTimeout(this.timer);
    this.timer = 0;
    this.pendingSig = null;
    this.payload = null;
  }

  private async flush() {
    if (this.disposed || this.inflight || !this.pendingSig || !this.payload) return;
    const generation = this.generation;
    const sig = this.pendingSig;
    const { doc, settings, resolveAtom } = this.payload;
    this.inflight = true;
    const compileAbort = new AbortController();
    this.compileAbort = compileAbort;
    let published: PageOracleEntry | undefined;
    try {
      if (this.disposed || generation !== this.generation) return;
      const compileRevision = ++this.compileRevision;
      const compiled = await this.compileDocument(doc, {
        key: this.compileKey,
        revision: compileRevision,
        priority: 'layout',
      }, compileAbort.signal);
      if (this.disposed || generation !== this.generation) return;
      const publication = typeof compiled === 'string'
        ? { svg: compiled, regions: [] }
        : compiled;
      const entry = publication
        ? analyze(publication, doc, settings, resolveAtom, sig, compileRevision)
        : ({ status: 'fail', reason: 'compile failed' } as PageOracleEntry);
      this.results.set(sig, entry);
      published = entry;
      if (this.results.size > MAX_RESULTS) {
        this.results.delete(this.results.keys().next().value!);
      }
    } catch (e) {
      if (this.disposed || generation !== this.generation) return;
      console.warn('page oracle failed', e);
      published = { status: 'fail', reason: String(e).slice(0, 120) };
      this.results.set(sig, published);
    } finally {
      this.inflight = false;
      if (this.compileAbort === compileAbort) this.compileAbort = null;
      // A newer request may use the same signature after clear(). Only the
      // generation that started this compile may consume its pending state.
      if (generation === this.generation && this.pendingSig === sig) {
        this.pendingSig = null;
        this.payload = null;
      }
      // A newer request may have arrived while compiling.
      if (!this.disposed && this.pendingSig) {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.flush(), 60);
      }
    }
    if (!this.disposed && generation === this.generation && published) this.onResults(published);
  }
}

/** Per-page tsel lines from the multi-page SVG. The svg renders at an
 *  arbitrary scale — per-page y tolerance is derived from the page height. */
function extractPages(svg: string, yTolPt: number): ExtractedPages {
  const div = parseTypstSvg(svg);
  div.style.cssText = 'position:absolute;visibility:hidden;left:-99999px;top:0;';
  const svgEl = div.querySelector('svg');
  if (!svgEl) return { lines: [], pageCount: 0, atomBounds: new Map(), ambiguousAtoms: new Set() };
  svgEl.style.width = svgEl.getAttribute('width') + 'px';
  svgEl.style.height = 'auto';
  document.body.appendChild(div);
  const out: PagedLine[] = [];
  const atomBounds = new Map<AtomLinkKey, PageBounds>();
  const ambiguousAtoms = new Set<AtomLinkKey>();
  let nextLineId = 0;
  const pages = [...div.querySelectorAll('.typst-page')];
  pages.forEach((pageEl, page) => {
    // An SVG <g>'s client rect is the bounding box of its painted children,
    // not the physical page. Screen CTMs are not layout authority either:
    // they cross the SVG/CSS foreignObject boundary and may include platform
    // pixel snapping. Stay entirely in SVG user space so every fragment is
    // compared in the same physical Typst coordinate system as
    // `here().position()`.
    const matrix = (pageEl as SVGGElement).getCTM();
    if (!matrix) return;
    let inverse: DOMMatrix;
    try {
      inverse = matrix.inverse();
    } catch {
      return;
    }
    const transformedBounds = (
      x: number,
      y: number,
      width: number,
      height: number,
      ownerMatrix: DOMMatrix,
    ): Omit<PageBounds, 'page'> | null => {
      if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
      const point = (px: number, py: number) =>
        new DOMPoint(px, py).matrixTransform(ownerMatrix).matrixTransform(inverse);
      const points = [
        point(x, y),
        point(x + width, y),
        point(x, y + height),
        point(x + width, y + height),
      ];
      return {
        top: Math.min(...points.map((point) => point.y)),
        bottom: Math.max(...points.map((point) => point.y)),
        left: Math.min(...points.map((point) => point.x)),
        right: Math.max(...points.map((point) => point.x)),
      };
    };
    const localBounds = (element: Element) => {
      // Typst's selection text is HTML inside a fixed SVG foreignObject. Its
      // browser glyph box is not layout authority: on a cold Linux start it
      // can briefly use fallback-font metrics, and adjacent physical lines
      // can then merge before the webfont settles. The foreignObject already
      // carries the exact compiled x/y/width/height, so transform that SVG
      // rectangle into page coordinates without measuring its HTML child or
      // consulting any screen/CSS coordinate API. The geometry attributes
      // are expressed in the foreignObject parent's user space, so use that
      // parent's CTM rather than the element's screen matrix.
      const foreign = element.closest('foreignObject') as SVGForeignObjectElement | null;
      const coordinateOwner = foreign?.parentElement as SVGGraphicsElement | null;
      const selectionMatrix = coordinateOwner?.getCTM();
      if (!foreign || !coordinateOwner || !selectionMatrix) return null;
      const x = Number(foreign.getAttribute('x') ?? 0);
      const y = Number(foreign.getAttribute('y') ?? 0);
      const width = Number(foreign.getAttribute('width'));
      const height = Number(foreign.getAttribute('height'));
      return transformedBounds(x, y, width, height, selectionMatrix);
    };

    // The publication wraps every exact inline atom in a reserved transparent
    // link. Its rectangle is the authoritative advance box for both painted
    // and paint-only atoms. Union split link rectangles before classifying
    // selection runs; arbitrary user links never enter this namespace.
    const pageAtomBounds = new Map<AtomLinkKey, Omit<PageBounds, 'page'>>();
    for (const anchor of pageEl.querySelectorAll<SVGAElement>('a')) {
      const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '';
      const inlineIndex = typstInlineIndexFromLink(href);
      const mathIndex = typstPreviewInlineMathIndexFromLink(href);
      const key: AtomLinkKey | null = inlineIndex !== null
        ? `typst:${inlineIndex}`
        : mathIndex !== null
          ? `math:${mathIndex}`
          : null;
      if (!key) continue;
      const rect = anchor.querySelector<SVGRectElement>('rect');
      const rectMatrix = rect?.getCTM();
      const bounds = rect && rectMatrix
        ? transformedBounds(
            Number(rect.getAttribute('x') ?? 0),
            Number(rect.getAttribute('y') ?? 0),
            Number(rect.getAttribute('width')),
            Number(rect.getAttribute('height')),
            rectMatrix,
          )
        : null;
      if (!bounds) {
        ambiguousAtoms.add(key);
        continue;
      }
      const previous = pageAtomBounds.get(key);
      pageAtomBounds.set(key, previous ? {
        top: Math.min(previous.top, bounds.top),
        bottom: Math.max(previous.bottom, bounds.bottom),
        left: Math.min(previous.left, bounds.left),
        right: Math.max(previous.right, bounds.right),
      } : bounds);
    }
    for (const [key, bounds] of pageAtomBounds) {
      const previous = atomBounds.get(key);
      if (previous && previous.page !== page) {
        ambiguousAtoms.add(key);
        continue;
      }
      atomBounds.set(key, previous ? {
        page,
        top: Math.min(previous.top, bounds.top),
        bottom: Math.max(previous.bottom, bounds.bottom),
        left: Math.min(previous.left, bounds.left),
        right: Math.max(previous.right, bounds.right),
      } : { page, ...bounds });
    }

    const runs = [...pageEl.querySelectorAll('.tsel')].flatMap((el) => {
      const runRect = localBounds(el);
      if (!runRect) return [];
      // Typst splits selection fragments at link boundaries. A fragment's
      // center therefore has exactly one owner even when glyph bearings
      // extend beyond the atom's advance rectangle. Multiple owners indicate
      // damaged/overlapping instrumentation and fail that atom closed.
      const cx = (runRect.left + runRect.right) / 2;
      const cy = (runRect.top + runRect.bottom) / 2;
      // Tall math scripts can sit outside the link's advance-height rect.
      // Search no farther than half a line pitch, then require one uniquely
      // nearest vertical band. This keeps repeated x-ranges on adjacent
      // wrapped lines distinct; a tie or an extreme outlier fails closed.
      const candidates = [...pageAtomBounds]
        .filter(([, bounds]) => cx >= bounds.left - 1e-4 && cx <= bounds.right + 1e-4)
        .map(([key, bounds]) => ({
          key,
          bounds,
          distance: cy < bounds.top ? bounds.top - cy : cy > bounds.bottom ? cy - bounds.bottom : 0,
        }))
        .filter((candidate) => candidate.distance <= yTolPt + 1e-4)
        .sort((left, right) => left.distance - right.distance);
      const owners = candidates.length > 1 &&
        candidates[1].distance - candidates[0].distance <= 1e-4
        ? candidates.filter((candidate) => candidate.distance - candidates[0].distance <= 1e-4)
        : candidates.slice(0, 1);
      if (owners.length > 1) {
        for (const owner of owners) ambiguousAtoms.add(owner.key);
        return [{
          text: el.textContent ?? '',
          top: runRect.top,
          bottom: runRect.bottom,
          left: runRect.left,
          right: runRect.right,
        }];
      }
      if (owners.length === 1) return [];
      return [{
        text: el.textContent ?? '',
        top: runRect.top,
        bottom: runRect.bottom,
        left: runRect.left,
        right: runRect.right,
      }];
    });
    // Preserve Typst's run order while grouping scripts/formula fragments
    // into their surrounding line, then order the completed lines physically
    // for page and footnote traversal.
    const grouped: Array<Omit<PagedLine, 'id' | 'page'>> = [];
    for (const run of runs) {
      const last = grouped[grouped.length - 1];
      const overlapsBand = !!last && Math.min(last.bottom, run.bottom) > Math.max(last.top, run.top);
      if (last && (overlapsBand || Math.abs(run.top - last.y) < yTolPt)) {
        last.text += run.text;
        last.top = Math.min(last.top, run.top);
        last.bottom = Math.max(last.bottom, run.bottom);
        last.left = Math.min(last.left, run.left);
        last.right = Math.max(last.right, run.right);
      } else {
        grouped.push({
          text: run.text,
          y: run.top,
          top: run.top,
          bottom: run.bottom,
          left: run.left,
          right: run.right,
        });
      }
    }
    grouped.sort((left, right) => left.top - right.top || left.left - right.left);
    out.push(...grouped.map((line) => ({ ...line, id: nextLineId++, page })));
  });
  div.remove();
  for (const key of ambiguousAtoms) atomBounds.delete(key);
  return { lines: out, pageCount: pages.length, atomBounds, ambiguousAtoms };
}

/** Mirror the serializer's inline/preview preorder namespaces once per
 * immutable document. Absolute PM positions then bind ParagraphSpec atom
 * offsets to publication geometry without rescanning the tree per block. */
function documentAtomRefs(doc: PMNode): Map<number, DocumentAtomRef> {
  const refs = new Map<number, DocumentAtomRef>();
  let nextInline = 0;
  let nextPreview = 0;
  doc.descendants((node, pos) => {
    if (node.type.name === 'typst_inline') {
      const classification = classifyTypstInline(node.attrs.src as string);
      const inlineIndex = nextInline++;
      const previewIndex = nextPreview++;
      // Unsupported source is intentionally absent: buildSpec keeps its
      // paragraph native, and a future caller cannot accidentally treat a
      // marker with no bounded semantics as atom authority.
      if (classification.kind !== 'unsupported') {
        refs.set(pos, {
          previewIndex,
          linkKey: classification.kind === 'fixed' ? `typst:${inlineIndex}` : null,
          kind: 'typst-inline',
        });
      }
    } else if (node.type.name === 'math_inline') {
      const previewIndex = nextPreview++;
      refs.set(pos, {
        previewIndex,
        linkKey: `math:${previewIndex}`,
        kind: 'math-inline',
      });
    } else if (node.type.name === 'math_display' || node.type.name === 'bibliography') {
      nextPreview++;
    }
    return true;
  });
  return refs;
}

/** Add an empty physical line only when an atom is the sole selectable-free
 * content on that line. Existing prose lines win whenever the queried Typst
 * baseline lies in their compiled band. */
function bindAtomBaselines(
  extraction: ExtractedPages,
  previewRegions: readonly TypstPreviewRegion[] | undefined,
  refs: ReadonlyMap<number, DocumentAtomRef>,
  pitch: number,
): Map<number, number> {
  const byPreview = new Map<number, TypstPreviewRegion>();
  const duplicatePreview = new Set<number>();
  for (const region of previewRegions ?? []) {
    if (byPreview.has(region.index)) duplicatePreview.add(region.index);
    else byPreview.set(region.index, region);
  }
  for (const index of duplicatePreview) byPreview.delete(index);

  const lineIdByPreview = new Map<number, number>();
  let nextLineId = extraction.lines.reduce((largest, line) => Math.max(largest, line.id + 1), 0);
  // A compiled prose foreignObject contains its baseline. Keep the tolerance
  // well below the inter-line gap so an atom-only line is synthesized rather
  // than attached to an adjacent physical line.
  const tolerance = Math.max(1, pitch * 0.15);
  for (const ref of refs.values()) {
    if (lineIdByPreview.has(ref.previewIndex)) continue;
    if (ref.linkKey && extraction.ambiguousAtoms.has(ref.linkKey)) continue;
    const region = byPreview.get(ref.previewIndex);
    if (
      !region ||
      (region.kind !== 'typst-inline' && region.kind !== 'math-inline') ||
      region.kind !== ref.kind
    ) continue;

    const page = region.baseline.page - 1;
    const bounds = ref.linkKey
      ? extraction.atomBounds.get(ref.linkKey)
      : {
          page,
          top: region.baseline.y,
          bottom: region.baseline.y,
          left: region.baseline.x,
          right: region.baseline.x,
        };
    if (!bounds || bounds.page !== page) continue;
    const candidates = extraction.lines
      .map((line) => ({ line, distance: line.page === page
        ? distanceToBand(line, region.baseline.y)
        : Number.POSITIVE_INFINITY }))
      .filter((candidate) => candidate.distance <= tolerance)
      .sort((left, right) => left.distance - right.distance);
    let line: PagedLine | null = null;
    if (candidates.length === 1 || (
      candidates.length > 1 && candidates[1].distance - candidates[0].distance > 1e-4
    )) {
      line = candidates[0].line;
    } else if (!candidates.length) {
      // A tall atom can overlap a neighboring prose band even though its own
      // baseline is in the inter-line gap. In that case its reading-order
      // slot is ambiguous, so never manufacture one from the box's top edge.
      const overlapsLine = extraction.lines.some((candidate) =>
        candidate.page === page &&
        Math.min(candidate.bottom, bounds.bottom) > Math.max(candidate.top, bounds.top) + 1e-4,
      );
      if (overlapsLine) continue;
      line = {
        id: nextLineId++,
        page,
        text: '',
        // Baseline y is comparable with the signal that selected existing
        // lines above. Link-box top is not: ascenders and tall formula ink
        // can extend far above the atom's actual reading-order position.
        y: region.baseline.y,
        top: region.baseline.y,
        bottom: region.baseline.y,
        left: bounds.left,
        right: bounds.right,
      };
      extraction.lines.push(line);
    }
    if (line) lineIdByPreview.set(ref.previewIndex, line.id);
  }
  extraction.lines.sort((left, right) =>
    left.page - right.page || left.top - right.top || left.left - right.left);
  return lineIdByPreview;
}

interface BoundAtoms {
  bindings: AtomLineBindings;
  reason: string | null;
}

/** Convert absolute publication line identities into the local line indexes
 * consumed by one paragraph/context matcher invocation. */
function bindSpecAtoms(
  spec: ParagraphSpec,
  blockPos: number,
  refs: ReadonlyMap<number, DocumentAtomRef>,
  lineIdByPreview: ReadonlyMap<number, number>,
  lines: readonly PagedLine[],
): BoundAtoms {
  const indexByLineId = new Map(lines.map((line, index) => [line.id, index]));
  const bindings = new Map<number, AtomLineBinding>();
  for (let tokenIndex = 0; tokenIndex < spec.tokens.length; tokenIndex++) {
    const token = spec.tokens[tokenIndex];
    if (token.kind !== 'atom' || token.text !== undefined) continue;
    const absolutePos = blockPos + 1 + token.start;
    const ref = refs.get(absolutePos);
    if (!ref) return { bindings, reason: `atom@${tokenIndex} has no document identity` };
    const lineId = lineIdByPreview.get(ref.previewIndex);
    const lineIndex = lineId === undefined ? undefined : indexByLineId.get(lineId);
    if (lineIndex === undefined) {
      return { bindings, reason: `atom@${tokenIndex} has no unambiguous compiled baseline line` };
    }
    bindings.set(tokenIndex, lineIndex);
  }
  return { bindings, reason: null };
}

/** Build the document's unit list (blocks in reading order). */
function buildUnits(doc: PMNode, resolveAtom: AtomResolver): Unit[] {
  const units: Unit[] = [];
  const push = (node: PMNode, pos: number, marker = false) => {
    if (node.type.name === 'paragraph' && node.attrs.align) {
      // Aligned paragraphs are browser-laid (no line cache): opaque, so a
      // page can start AT them but a split inside one fails to fallback.
      units.push({ kind: 'opaque', pos, type: 'paragraph' });
    } else if (node.type.name === 'paragraph' && node.content.size) {
      const spec = buildSpec(node, resolveAtom);
      units.push(spec ? { kind: 'exact', pos, type: 'paragraph', spec, marker } : { kind: 'opaque', pos, type: 'paragraph' });
    } else if (node.type.name === 'heading') {
      const spec = buildSpec(node, resolveAtom);
      units.push(
        spec
          ? { kind: 'exact', pos, type: 'heading', level: node.attrs.level as number, spec, marker }
          : { kind: 'opaque', pos, type: 'heading', level: node.attrs.level as number },
      );
    } else if (node.type.name === 'doc_title' || node.type.name === 'doc_authors' || node.type.name === 'doc_date') {
      const spec = node.content.size ? buildSpec(node, resolveAtom) : null;
      units.push(spec ? { kind: 'exact', pos, type: node.type.name, spec, marker } : { kind: 'opaque', pos, type: node.type.name });
    } else if (node.type.name === 'abstract') {
      // The painted "Abstract" label line is emitted but not stored; an
      // opaque unit lets the matcher resync on the first body paragraph.
      units.push({ kind: 'opaque', pos, type: 'abstract-label' });
      node.forEach((child, off) => push(child, pos + 1 + off));
    } else if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list' || node.type.name === 'blockquote') {
      node.forEach((child, off) => {
        const childPos = pos + 1 + off;
        if (child.type.name === 'list_item') {
          child.forEach((g, goff) => push(g, childPos + 1 + goff, true));
        } else {
          push(child, childPos);
        }
      });
    } else {
      units.push({ kind: 'opaque', pos, type: node.type.name });
    }
  };
  doc.forEach((node, offset) => push(node, offset));
  return units;
}

/** Context targets use the same preorder in which docToTyp allocates its
 * zero-flow markers: a figure caption before its inline descendants, and
 * every non-empty footnote when encountered. */
export function buildContextTargets(doc: PMNode, resolveAtom: AtomResolver): ContextTarget[] {
  const targets: ContextTarget[] = [];
  let index = 0;
  doc.descendants((node, pos) => {
    const kind: TypstLayoutRegionKind | null =
      node.type.name === 'figure' && node.content.size
        ? 'figure-caption'
        : node.type.name === 'footnote' && node.content.size
          ? 'footnote'
          : null;
    if (kind) targets.push({ index: index++, kind, pos, spec: buildSpec(node, resolveAtom) });
    return true;
  });
  return targets;
}

const CONTEXT_HYPHENS = /[-‐‑\u00ad]+$/;

interface ContextLineState {
  token: number;
  pendingSuffix: string | null;
  breaks: ForcedBreak[];
}

interface ContextLineResult {
  state: ContextLineState;
  more: boolean;
}

/** Consume exactly one rendered line while retaining enough matcher state to
 * skip page-leading body text before a split footnote continuation. */
function consumeContextLine(
  spec: ParagraphSpec,
  input: string,
  initial: ContextLineState,
  lineIndex: number,
  atomLines: AtomLineBindings,
): ContextLineResult | null {
  const tokens = spec.tokens;
  let ti = initial.token;
  let pendingSuffix = initial.pendingSuffix;
  const breaks = initial.breaks.slice();
  let text = input.replace(/\s+/g, ' ').trim();
  let consumedOnLine = false;
  let brokeWithHyphen = false;

  while (text.length) {
    if (pendingSuffix) {
      if (!text.startsWith(pendingSuffix)) return null;
      text = text.slice(pendingSuffix.length).trimStart();
      pendingSuffix = null;
      consumedOnLine = true;
      continue;
    }
    if (ti >= tokens.length) return null;
    const token = tokens[ti];
    if (token.kind === 'hard') {
      return null;
    }
    if (token.text === undefined) {
      const binding = atomLines.get(ti);
      if (binding === undefined || binding !== lineIndex) return null;
      ti++;
      consumedOnLine = true;
      continue;
    }

    const word = token.text;
    if (text.startsWith(word)) {
      const after = text.slice(word.length);
      const glueNext = ti + 1 < tokens.length && !tokens[ti + 1].spaceBefore;
      if (after === '' || after.startsWith(' ') || glueNext) {
        text = after.trimStart() === after && after !== '' && !after.startsWith(' ')
          ? after
          : after.trimStart();
        ti++;
        consumedOnLine = true;
        continue;
      }
    }
    if (token.kind === 'word') {
      const bare = text.replace(CONTEXT_HYPHENS, '');
      if (
        text.length <= word.length + 1 &&
        bare.length > 0 &&
        bare.length < word.length &&
        word.startsWith(bare)
      ) {
        const dash = word[bare.length] === '-' ? 1 : 0;
        breaks.push({ at: token.start + bare.length + dash, hyphen: true });
        pendingSuffix = word.slice(bare.length + dash);
        ti++;
        text = '';
        consumedOnLine = true;
        brokeWithHyphen = true;
        continue;
      }
    }
    return null;
  }

  if (pendingSuffix === null) {
    while (ti < tokens.length) {
      const token = tokens[ti];
      if (token.kind !== 'atom' || token.text !== undefined) break;
      const binding = atomLines.get(ti);
      if (binding === undefined) return null;
      if (binding > lineIndex) break;
      if (binding < lineIndex) return null;
      ti++;
      consumedOnLine = true;
    }
  }

  let endedByHard = false;
  if (pendingSuffix === null && ti < tokens.length && tokens[ti].kind === 'hard') {
    if (!consumedOnLine) return null;
    ti++;
    endedByHard = true;
  }

  const more = ti < tokens.length || pendingSuffix !== null;
  if (more && !brokeWithHyphen && !endedByHard) {
    if (!consumedOnLine) return null;
    const previous = tokens[ti - 1];
    breaks.push({ at: previous.end, hyphen: false });
  }
  return { state: { token: ti, pendingSuffix, breaks }, more };
}

function prefixVariants(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const variants = [normalized];
  // Typst emits a footnote entry number and its first body run as adjacent
  // selection-layer fragments (`1Body`), even though they are visually
  // separated by the hanging indent. The marker is not PM content.
  const withoutFootnoteNumber = normalized.replace(/^\d+[.)]?\s*/, '');
  if (withoutFootnoteNumber !== normalized) variants.push(withoutFootnoteNumber);
  // Prefixes are normally short ("Figure 12: ", "12 "). Trying bounded
  // suffixes avoids language/supplement assumptions and remains safe because
  // the complete PM token stream and end marker must still match.
  const limit = Math.min(normalized.length, 160);
  for (let offset = 1; offset < limit; offset++) {
    const previous = normalized[offset - 1];
    if (/\s|[:.)\]—–-]/.test(previous)) variants.push(normalized.slice(offset).trimStart());
  }
  return [...new Set(variants)];
}

function distanceToBand(line: PagedLine, y: number): number {
  if (y < line.top) return line.top - y;
  if (y > line.bottom) return y - line.bottom;
  return 0;
}

function nearestLine(lines: readonly PagedLine[], page: number, y: number, tolerance: number): number {
  let best = -1;
  let distance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].page !== page) continue;
    const next = distanceToBand(lines[i], y);
    if (next < distance) {
      best = i;
      distance = next;
    }
  }
  return distance <= tolerance ? best : -1;
}

interface ContextMatch {
  breaks: ForcedBreak[];
  lineIds: number[];
}

/** Match one physical marker range independently of document reading order.
 * A split footnote may continue at the bottom of later pages; body/header
 * lines before that page's first matching continuation are the only lines
 * permitted to be skipped. */
export function matchContextRegion(
  spec: ParagraphSpec,
  allLines: readonly PagedLine[],
  region: TypstLayoutRegion,
  pitch: number,
  atomLinesInAll: AtomLineBindings = new Map(),
): ContextMatch | null {
  const startPage = region.start.page - 1;
  const endPage = region.end.page - 1;
  if (startPage < 0 || endPage < startPage) return null;
  const tolerance = Math.max(pitch * 1.25, 8);
  const start = nearestLine(allLines, startPage, region.start.y, tolerance);
  const end = nearestLine(allLines, endPage, region.end.y, tolerance);
  if (start < 0 || end < 0) return null;

  const candidates = allLines.filter((line, index) => {
    if (line.page < startPage || line.page > endPage) return false;
    if (line.page === startPage && index < start) return false;
    if (line.page === endPage && index > end) return false;
    return true;
  });
  if (!candidates.length) return null;

  const candidateIndexById = new Map(candidates.map((line, index) => [line.id, index]));
  const atomLines = new Map<number, AtomLineBinding>();
  for (const [token, binding] of atomLinesInAll) {
    const line = allLines[binding];
    const candidateIndex = line ? candidateIndexById.get(line.id) : undefined;
    if (candidateIndex === undefined) return null;
    atomLines.set(token, candidateIndex);
  }

  let state: ContextLineState = { token: 0, pendingSuffix: null, breaks: [] };
  const used: PagedLine[] = [];
  let page = -1;
  let matchedOnPage = false;
  for (const line of candidates) {
    if (line.page !== page) {
      page = line.page;
      matchedOnPage = false;
    }
    const mayStripPrefix = used.length === 0 || (region.kind === 'footnote' && !matchedOnPage);
    const variants = mayStripPrefix ? prefixVariants(line.text) : [line.text];
    let consumed: ContextLineResult | null = null;
    for (const variant of variants) {
      consumed = consumeContextLine(
        spec,
        variant,
        state,
        candidateIndexById.get(line.id)!,
        atomLines,
      );
      if (consumed) break;
    }
    if (!consumed) {
      // Only a page-leading search for a split footnote is skippable. Once
      // its continuation starts, unrelated text would make the mapping
      // ambiguous and this block falls back to native wrapping.
      if (region.kind === 'footnote' && !matchedOnPage && line.page > startPage) continue;
      return null;
    }
    state = consumed.state;
    used.push(line);
    matchedOnPage = true;
    if (!consumed.more) break;
  }
  if (!used.length || state.token < spec.tokens.length || state.pendingSuffix) return null;
  const first = used[0];
  const last = used[used.length - 1];
  if (
    first.page !== startPage ||
    last.page !== endPage ||
    distanceToBand(first, region.start.y) > tolerance ||
    distanceToBand(last, region.end.y) > tolerance
  ) return null;
  return { breaks: state.breaks, lineIds: used.map((line) => line.id) };
}

const MARKER = /^[•‣–\-*]?\s*|^\d+[.)]\s*/;

/** First words of every footnote body, in document order. */
function footnoteHeads(doc: PMNode): string[] {
  const heads: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'footnote') {
      heads.push(n.textContent.replace(/\s+/g, ' ').trim().slice(0, 24));
      return false;
    }
    return true;
  });
  return heads;
}

/** Remove per-page trailing footnote-area lines (matched against known texts). */
function stripFootnoteLines(lines: PagedLine[], heads: string[]): PagedLine[] {
  if (!heads.length) return lines;
  let hi = 0;
  const drop = new Set<number>();
  const byPage = new Map<number, number[]>();
  lines.forEach((l, i) => {
    let list = byPage.get(l.page);
    if (!list) byPage.set(l.page, (list = []));
    list.push(i);
  });
  for (const [, idxs] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    if (hi >= heads.length) break;
    // Find the first line on this page that starts the pending footnote body.
    for (let k = 0; k < idxs.length; k++) {
      const text = lines[idxs[k]].text.replace(/\s+/g, ' ').trim().replace(/^\d+[.)]?\s*/, '');
      if (hi < heads.length && text.startsWith(heads[hi].slice(0, 12))) {
        // Everything from here to the end of the page is footnote area.
        for (let j = k; j < idxs.length; j++) drop.add(idxs[j]);
        // Consume as many queued footnotes as begin in this area.
        hi++;
        for (let j = k + 1; j < idxs.length && hi < heads.length; j++) {
          const t = lines[idxs[j]].text.replace(/\s+/g, ' ').trim().replace(/^\d+[.)]?\s*/, '');
          if (t.startsWith(heads[hi].slice(0, 12))) hi++;
        }
        break;
      }
    }
  }
  return lines.filter((_, i) => !drop.has(i));
}

function analyze(
  publication: TypstDocumentSvgPublication,
  doc: PMNode,
  settings: DocSettings,
  resolveAtom: AtomResolver,
  documentKey: string,
  revision: number,
): PageOracleEntry {
  const pitch = settings.lineHeight * settings.sizePt;
  const page = pageSize(settings);
  const pageHPt = page.h * 0.75;
  const extraction = extractPages(publication.svg, selectionRunTolerance(pitch));
  const atomRefs = documentAtomRefs(doc);
  const atomLineIds = bindAtomBaselines(extraction, publication.previewRegions, atomRefs, pitch);
  const raw = extraction.lines;
  const pageCount = extraction.pageCount || 1;
  if (!raw.length) return { status: 'fail', reason: 'no text layer' };

  // Page numbers render in the footer and reach the text layer too. A
  // numbering-restart marker makes folio values non-sequential (roman
  // front matter, body restarting at 1), so match folio PATTERNS for the
  // formats in play rather than one exact per-page value.
  let hasRestart = false;
  doc.forEach((n) => {
    if (n.type.name === 'numbering_restart') hasRestart = true;
  });
  const folioRe = (fmt: DocSettings['pageNumFormat']): RegExp =>
    fmt === '1'
      ? /^\d+$/
      : fmt === '— 1 —'
        ? /^— \d+ —$/
        : fmt === 'i'
          ? /^[ivxlcdm]+$/
          : /^\d+ \/ \d+$/;
  const folioPatterns = hasRestart
    ? [folioRe(settings.pageNumFormat), folioRe('i')]
    : [folioRe(settings.pageNumFormat)];
  const footerTop = pageHPt - settings.marginBottom * 72;
  const isFolio = (l: PagedLine) => {
    // A numeric caption or footnote body is content, not a folio. Typst's
    // page number sits outside the body margin, so require both the emitted
    // value and the physical footer band.
    if (l.top < footerTop) return false;
    return hasRestart
      ? folioPatterns.some((re) => re.test(l.text.trim()))
      : l.text.trim() === formatPageNumber(settings, l.page + 1, pageCount);
  };
  const all = settings.pageNumShow ? raw.filter((l) => !isFolio(l)) : raw;

  const units = buildUnits(doc, resolveAtom);
  const pageStarts: PageStart[] = [];
  const blockBreaks: SnapshotBlockBreaks[] = [];
  const targets = buildContextTargets(doc, resolveAtom);
  const footnoteLineIds = new Set<number>();
  let contextPageFailure: string | null = null;

  if (publication.layoutRegions) {
    const regions = new Map(publication.layoutRegions.map((region) => [region.index, region]));
    for (const target of targets) {
      const region = regions.get(target.index);
      const bound = target.spec
        ? bindSpecAtoms(target.spec, target.pos, atomRefs, atomLineIds, all)
        : null;
      const match = target.spec && bound && !bound.reason && region && region.kind === target.kind
        ? matchContextRegion(target.spec, all, region, pitch, bound.bindings)
        : null;
      if (!match || !target.spec) {
        // Captions do not participate in body reading order, so their own
        // native fallback is isolated. An unidentified footnote area can
        // contaminate page mapping and therefore withholds pageStarts.
        if (target.kind === 'footnote' && !contextPageFailure) {
          contextPageFailure = `footnote context @${target.pos} did not match its compiled region`;
        }
        continue;
      }
      blockBreaks.push({
        pos: target.pos,
        type: target.kind,
        contentKey: target.spec.key,
        breaks: match.breaks,
      });
      if (target.kind === 'footnote') {
        for (const id of match.lineIds) footnoteLineIds.add(id);
      }
    }
  }

  // Older/injected publications have no region field. Preserve their
  // existing body-page behavior for focused lifecycle tests; the product
  // worker always emits layoutRegions and therefore never uses text-head
  // guessing as contextual line authority.
  const lines = publication.layoutRegions === undefined
    ? stripFootnoteLines(all, footnoteHeads(doc))
    : all.filter((line) => !footnoteLineIds.has(line.id));

  let cursor = 0;
  let lastPage = 0;

  const result = (reason?: string): PageOracleEntry => {
    const exactPages = reason ? null : pageStarts;
    const snapshot = createLayoutSnapshot({
      revision,
      documentKey,
      pageCount,
      pageStarts: exactPages,
      blocks: [...blockBreaks].sort((left, right) => left.pos - right.pos),
    });
    return reason
      ? { status: 'fail', reason, pageCount, snapshot }
      : { status: 'ok', pageStarts, pageCount, snapshot };
  };

  const notePage = (line: number, unit: Unit, lineInUnit: number) => {
    const page = lines[line].page;
    while (lastPage < page) {
      lastPage++;
      pageStarts.push({
        pos: unit.pos,
        line: lineInUnit,
        // 'line' (a mid-paragraph split the paginator can apply) only for
        // exact-matched paragraphs. A split inside an opaque block keeps
        // its own type so the atomic-block guard below fails the result —
        // never a fake 'line' unit pointing at a node with no line cache.
        unit:
          unit.type === 'heading'
            ? `h${Math.min(3, unit.level ?? 1)}`
            : lineInUnit > 0 && unit.kind === 'exact'
              ? 'line'
              : unit.type,
        level: unit.level,
      });
    }
  };

  const anchorFor = (idx: number): { text: string } | null => {
    for (let j = idx; j < units.length; j++) {
      const u = units[j];
      if (u.kind === 'exact' && u.spec) {
        const words = u.spec.tokens.filter((t) => t.text).slice(0, 2);
        if (words.length) return { text: words.map((t) => t.text).join(' ') };
      }
    }
    return null;
  };

  for (let ui = 0; ui < units.length; ui++) {
    const unit = units[ui];
    if (cursor >= lines.length) break;
    if (unit.kind === 'exact' && unit.spec) {
      // List markers ride on the first line; strip before matching.
      const slice = lines.slice(cursor).map((l, i) => ({
        ...l,
        text: i === 0 && unit.marker ? l.text.replace(MARKER, '') : l.text,
      }));
      const bound = bindSpecAtoms(unit.spec, unit.pos, atomRefs, atomLineIds, slice);
      if (bound.reason) return result(`unit@${unit.pos} (${unit.type}): ${bound.reason}`);
      const res = matchParagraph(unit.spec, slice, 0, undefined, bound.bindings);
      if (res.status !== 'ok') {
        return result(`unit@${unit.pos} (${unit.type}): ${res.entry.reason}`);
      }
      blockBreaks.push({
        pos: unit.pos,
        type: unit.type,
        contentKey: unit.spec.key,
        breaks: res.entry.breaks ?? [],
      });
      for (let k = 0; k < res.next; k++) notePage(cursor + k, unit, k);
      cursor += res.next;
    } else {
      // Opaque block: consume lines until the next exact unit's anchor.
      const anchor = anchorFor(ui + 1);
      let consumed = 0;
      while (cursor < lines.length) {
        const text = lines[cursor].text.replace(/\s+/g, ' ').trim();
        if (anchor && (text === anchor.text || text.startsWith(anchor.text + ' ') || text.startsWith(anchor.text))) break;
        notePage(cursor, unit, consumed === 0 ? 0 : consumed);
        cursor++;
        consumed++;
      }
      if (!anchor) {
        // Trailing opaque content (bibliography etc.) owns the rest.
        for (; cursor < lines.length; cursor++) notePage(cursor, unit, 1);
        break;
      }
    }
  }

  // Mid-opaque page splits cannot be represented in the editable projection:
  // native tables deliberately remain one continuous structured surface.
  // Preserve the exact block-line snapshot but publish pageStarts: null; the
  // explicit proof remains the exact view of Typst's cross-page table.
  for (const ps of pageStarts) {
    if (ps.line > 0 && ps.unit !== 'line') {
      return result(`page splits inside atomic block @${ps.pos} (${ps.unit})`);
    }
  }

  if (contextPageFailure) return result(contextPageFailure);

  // A page containing only opaque visual output (for example a trailing
  // Typst embed that draws a rect after #pagebreak()) has no .tsel line from
  // which notePage() can infer its start. Never publish an incomplete map as
  // exact: doing so would leave the editable projection on the prior page
  // while Proof/PDF correctly contains another one.
  const expectedPageStarts = Math.max(0, pageCount - 1);
  if (pageStarts.length !== expectedPageStarts) {
    return result(`mapped ${pageStarts.length} of ${expectedPageStarts} page boundaries`);
  }

  return result();
}
