// Ordinary code and executable Typst are separate document concepts.
//
// Dedicated embeds stay native/editable, but their preview is never compiled
// as a synthetic fragment. One manager per EditorView compiles the prepared
// whole document (assets, prior definitions, counters, labels, and show/set
// rules included), then distributes exact physical crops to every embed.

import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { schema } from './schema';
import { mountTypstSvg } from './safe-svg';
import { normalizeSettings } from './settings';
import {
  acquireDocumentCompileBroker,
  DocumentCompileBroker,
  type DocumentCompileBrokerLease,
} from './document-compile-broker';
import type {
  TypstEmbedRegion,
} from './typst-embed-regions';
import type { TypstDocumentSvgPublication } from './typst-document-publication';
import type { TypstPreviewRegion } from './typst-preview-regions';
import {
  typstInlineIndexFromLink,
} from './typst-inline-regions';
import { typstPreviewInlineMathIndexFromLink } from './typst-preview-regions';
import { classifyTypstEmbed } from './typst-embed-policy';

const COMPILE_DELAY_MS = 160;
const ASSET_EVENT = 'typeset-assets-changed';

/** Dynamic boundary avoids a static typeset-plugin → inline view → preview
 * manager cycle while retaining the existing coalesced layout scheduler. */
function scheduleDocumentLayout(view: EditorView, failOpen = false, reason?: string): void {
  void import('./typeset-plugin').then(({ failOpenTypesetPublication, scheduleTypeset }) => {
    if (failOpen) failOpenTypesetPublication(view, reason);
    else scheduleTypeset(view);
  });
}

type PreviewState = 'idle' | 'pending' | 'ready' | 'empty' | 'proof' | 'error';

export interface TypstEmbedCompileRequest {
  key: string;
  revision: number;
  priority: 'foreground';
  signal: AbortSignal;
}

export type TypstEmbedCompiler = (
  doc: PMNode,
  onMessage: (message: string) => void,
  request: TypstEmbedCompileRequest,
) => Promise<TypstDocumentSvgPublication | null>;

/** Native editable code. This class exists only because main.ts currently
 * registers a code-block node view; the default PM DOM would be equivalent. */
export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  constructor(_node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.dom = document.createElement('pre');
    this.contentDOM = document.createElement('code');
    this.dom.appendChild(this.contentDOM);
  }

  update(node: PMNode): boolean {
    return node.type === schema.nodes.code_block;
  }

  ignoreMutation(mutation: MutationRecord | { type: 'selection' }): boolean {
    if (mutation.type === 'selection') return false;
    return !this.contentDOM.contains((mutation as MutationRecord).target);
  }
}

export interface ManagedDocumentPreviewView {
  pending(): void;
  applyDocumentPreview(result: TypstDocumentSvgPublication, doc: PMNode): boolean;
  compileError(message: string): void;
  needsDocumentPreview(): boolean;
  retainedDocumentPreview(): TypstDocumentSvgPublication | null;
}

/** Lifecycle of the geometry-carrying whole-document publication for one
 * immutable ProseMirror document. `pending` is the only state in which the
 * layout layer may temporarily retain mapped exact presentation. */
export interface ExactLayoutPublicationState {
  status: 'ready' | 'pending' | 'fail';
  reason: string | null;
}

export interface PreparedInlineRegion {
  readonly index: number;
  /** Whole-publication SVG user coordinates. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Paint crop may extend beyond the atom's advance box (rules/overhangs). */
  readonly cropX: number;
  readonly cropY: number;
  readonly cropWidth: number;
  readonly cropHeight: number;
}

export interface PreparedDocumentPublication {
  objectUrl: string;
  viewBox: readonly [number, number, number, number];
  pageY: readonly number[];
  inlineRegions: ReadonlyMap<number, PreparedInlineRegion>;
  mathInlineRegions: ReadonlyMap<number, PreparedInlineRegion>;
  embedRegions: ReadonlyMap<number, TypstEmbedRegion>;
  previewRegions: ReadonlyMap<number, TypstPreviewRegion>;
}

export type DocumentPreviewRegionChannel = 'embed' | 'inline' | 'preview';

interface DocumentPreviewIndices {
  readonly embed: ReadonlyMap<number, number>;
  readonly inline: ReadonlyMap<number, number>;
  readonly preview: ReadonlyMap<number, number>;
  readonly blocker: string | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Sanitize and decode a whole-document publication exactly once. Embed
 * views then paint tiny SVG windows onto this shared inert image instead of
 * parsing and retaining the full multi-page SVG once per embed. */
async function prepareEmbedPublication(
  result: TypstDocumentSvgPublication,
): Promise<PreparedDocumentPublication | null> {
  const stage = document.createElement('div');
  stage.style.cssText = 'position:absolute;visibility:hidden;left:-99999px;top:0;pointer-events:none;';
  const svg = mountTypstSvg(stage, result.svg);
  if (!svg) return null;
  const rawViewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[ ,]+/).map(Number);
  if (
    rawViewBox.length !== 4 || !rawViewBox.every(Number.isFinite) ||
    !(rawViewBox[2] > 0) || !(rawViewBox[3] > 0)
  ) return null;
  svg.style.width = `${svg.getAttribute('width')}px`;
  svg.style.height = 'auto';
  document.body.appendChild(stage);
  const pageY = [...svg.querySelectorAll<SVGGElement>('.typst-page')].map(translateY);
  if (!pageY.length || pageY.some((value) => value === null)) {
    stage.remove();
    return null;
  }

  const inlineRegions = new Map<number, PreparedInlineRegion>();
  type RegionBounds = {
    left: number; right: number; top: number; bottom: number;
    paintLeft: number; paintRight: number; paintTop: number; paintBottom: number;
  };
  const inlineBounds = new Map<number, RegionBounds>();
  const ambiguousInlineRegions = new Set<number>();
  const mathInlineRegions = new Map<number, PreparedInlineRegion>();
  const mathInlineBounds = new Map<number, RegionBounds>();
  const ambiguousMathInlineRegions = new Set<number>();
  for (const anchor of svg.querySelectorAll<SVGAElement>('a')) {
    const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '';
    const inlineIndex = typstInlineIndexFromLink(href);
    const mathIndex = typstPreviewInlineMathIndexFromLink(href);
    if (inlineIndex === null && mathIndex === null) continue;
    const index = inlineIndex ?? mathIndex!;
    const bounds = inlineIndex === null ? mathInlineBounds : inlineBounds;
    const ambiguous = inlineIndex === null ? ambiguousMathInlineRegions : ambiguousInlineRegions;
    const rect = anchor.querySelector<SVGRectElement>('rect');
    const matrix = rect?.getCTM();
    if (!rect || !matrix) {
      ambiguous.add(index);
      anchor.remove();
      continue;
    }
    const x = Number(rect.getAttribute('x') ?? 0);
    const y = Number(rect.getAttribute('y') ?? 0);
    const width = Number(rect.getAttribute('width'));
    const height = Number(rect.getAttribute('height'));
    if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) {
      ambiguous.add(index);
      anchor.remove();
      continue;
    }
    const corners = [
      new DOMPoint(x, y).matrixTransform(matrix),
      new DOMPoint(x + width, y).matrixTransform(matrix),
      new DOMPoint(x, y + height).matrixTransform(matrix),
      new DOMPoint(x + width, y + height).matrixTransform(matrix),
    ];
    const left = Math.min(...corners.map((point) => point.x));
    const right = Math.max(...corners.map((point) => point.x));
    const top = Math.min(...corners.map((point) => point.y));
    const bottom = Math.max(...corners.map((point) => point.y));
    const paintOwner = anchor.parentElement as unknown as SVGGraphicsElement | null;
    const paintMatrix = paintOwner?.getCTM();
    let paintLeft = left;
    let paintRight = right;
    let paintTop = top;
    let paintBottom = bottom;
    if (paintOwner && paintMatrix) {
      try {
        const box = paintOwner.getBBox();
        const paintCorners = [
          new DOMPoint(box.x, box.y).matrixTransform(paintMatrix),
          new DOMPoint(box.x + box.width, box.y).matrixTransform(paintMatrix),
          new DOMPoint(box.x, box.y + box.height).matrixTransform(paintMatrix),
          new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(paintMatrix),
        ];
        paintLeft = Math.min(...paintCorners.map((point) => point.x));
        paintRight = Math.max(...paintCorners.map((point) => point.x));
        paintTop = Math.min(...paintCorners.map((point) => point.y));
        paintBottom = Math.max(...paintCorners.map((point) => point.y));
      } catch {
        // The transparent layout rectangle remains a sound crop fallback.
      }
    }
    // Typst can split one atomic link into multiple SVG hit rectangles (for
    // example, one per glyph run). The inline classifier forbids user links,
    // so every rectangle with this reserved index belongs to the one wrapper;
    // unioning them recovers its actual advance box without adding a baseline-
    // changing outer #box to the document.
    const previous = bounds.get(index);
    bounds.set(index, previous ? {
      left: Math.min(previous.left, left),
      right: Math.max(previous.right, right),
      top: Math.min(previous.top, top),
      bottom: Math.max(previous.bottom, bottom),
      paintLeft: Math.min(previous.paintLeft, paintLeft),
      paintRight: Math.max(previous.paintRight, paintRight),
      paintTop: Math.min(previous.paintTop, paintTop),
      paintBottom: Math.max(previous.paintBottom, paintBottom),
    } : { left, right, top, bottom, paintLeft, paintRight, paintTop, paintBottom });
    // The internal link is instrumentation, not document output. Its only
    // child is a transparent layout rectangle; removing it leaves the atom's
    // exact paint in the shared SVG while preventing an internal hyperlink.
    anchor.remove();
  }

  const finishRegions = (
    bounds: ReadonlyMap<number, RegionBounds>,
    ambiguous: ReadonlySet<number>,
    regions: Map<number, PreparedInlineRegion>,
  ) => {
    // getBBox excludes stroke width. The classifier rejects explicit paint
    // overhangs; one point still protects ordinary glyph bearings/hairlines.
    const paintPadding = 1;
    for (const [index, box] of bounds) {
      if (ambiguous.has(index)) continue;
      regions.set(index, {
        index,
        x: box.left,
        y: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top,
        cropX: box.paintLeft - paintPadding,
        cropY: box.paintTop - paintPadding,
        cropWidth: Math.max(0, box.paintRight - box.paintLeft) + paintPadding * 2,
        cropHeight: Math.max(0, box.paintBottom - box.paintTop) + paintPadding * 2,
      });
    }
  };
  finishRegions(inlineBounds, ambiguousInlineRegions, inlineRegions);
  finishRegions(mathInlineBounds, ambiguousMathInlineRegions, mathInlineRegions);

  svg.setAttribute('xmlns', SVG_NS);
  const serialized = new XMLSerializer().serializeToString(svg);
  stage.remove();
  const objectUrl = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
  const image = new Image();
  image.src = objectUrl;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(objectUrl);
    return null;
  }
  return {
    objectUrl,
    viewBox: rawViewBox as [number, number, number, number],
    pageY: pageY as number[],
    inlineRegions,
    mathInlineRegions,
    embedRegions: new Map(result.regions.map((region) => [region.index, region])),
    previewRegions: new Map((result.previewRegions ?? []).map((region) => [region.index, region])),
  };
}

/** One keyed, debounced whole-document publication for every embed node view
 * in an editor. Exported for deterministic integration tests. */
export class TypstEmbedPreviewManager {
  private readonly listeners = new Set<ManagedDocumentPreviewView>();
  private readonly broker: DocumentCompileBroker;
  private readonly brokerLease: DocumentCompileBrokerLease | null;
  private timer = 0;
  private inspectorFrame = 0;
  private generation = 0;
  private compileAbort: AbortController | null = null;
  private pendingDoc: PMNode | null = null;
  private lastDoc: PMNode | null = null;
  private lastResult: TypstDocumentSvgPublication | null = null;
  /** Invalidation generation that produced `lastResult`. Asset-only changes
   * keep the same PM document identity, so object equality alone cannot make
   * a stale crop/page publication current. */
  private lastResultGeneration = -1;
  /** Terminal failure for the current invalidation generation. A new
   * invalidation clears it; merely waiting longer must not turn a failed
   * compile/crop application back into a "pending" publication. */
  private publicationFailure: {
    doc: PMNode;
    generation: number;
    reason: string;
  } | null = null;
  private indexedDoc: PMNode | null = null;
  private documentIndices: DocumentPreviewIndices | null = null;
  private readonly prepared = new Map<TypstDocumentSvgPublication, PreparedDocumentPublication>();
  private destroyed = false;
  private requests = 0;
  private publications = 0;
  private readonly onAssets = () => this.invalidate(this.view.state.doc, true);
  private readonly onResize = () => this.scheduleInspectorLayout();

  constructor(
    private readonly view: EditorView,
    compiler?: TypstEmbedCompiler,
  ) {
    if (compiler) {
      // An explicitly injected compiler is a deterministic test seam. Keep it
      // isolated from the product broker already owned by this EditorView.
      this.brokerLease = null;
      this.broker = new DocumentCompileBroker(view, (doc, onMessage, request) =>
        compiler(doc, onMessage, { ...request, priority: 'foreground' }));
    } else {
      this.brokerLease = acquireDocumentCompileBroker(view);
      this.broker = this.brokerLease.broker;
    }
    window.addEventListener(ASSET_EVENT, this.onAssets);
    window.addEventListener('resize', this.onResize);
  }

  register(listener: ManagedDocumentPreviewView): void {
    if (this.destroyed) return;
    this.listeners.add(listener);
    this.scheduleInspectorLayout();
    if (this.lastDoc === this.view.state.doc && this.lastResultGeneration === this.generation && this.lastResult) {
      if (listener.applyDocumentPreview(this.lastResult, this.lastDoc)) scheduleDocumentLayout(this.view);
      this.updatePublicationApplicationState(this.lastDoc, this.lastResult);
      return;
    }
    this.invalidate(this.view.state.doc);
  }

  unregister(listener: ManagedDocumentPreviewView): void {
    this.listeners.delete(listener);
    this.scheduleInspectorLayout();
    this.prunePreparedPublications();
    if (this.listeners.size) return;
    clearTimeout(this.timer);
    this.timer = 0;
    this.compileAbort?.abort('canceled');
    this.compileAbort = null;
  }

  invalidate(doc: PMNode = this.view.state.doc, force = false): void {
    if (this.destroyed || !this.listeners.size) return;
    if (!force && doc === this.lastDoc && this.lastResultGeneration === this.generation && this.lastResult) {
      let geometryChanged = false;
      for (const listener of this.listeners) {
        geometryChanged = listener.applyDocumentPreview(this.lastResult, doc) || geometryChanged;
      }
      this.updatePublicationApplicationState(doc, this.lastResult);
      if (geometryChanged) scheduleDocumentLayout(this.view);
      return;
    }

    // Node views register/update independently during a large paste or state
    // replacement. One immutable PM document needs one scheduled/in-flight
    // publication; repeatedly aborting and walking the growing listener set
    // turns construction into quadratic work.
    if (!force && this.pendingDoc === doc && (this.timer !== 0 || this.compileAbort !== null)) {
      this.scheduleInspectorLayout();
      return;
    }

    this.pendingDoc = doc;
    this.generation++;
    this.publicationFailure = null;
    clearTimeout(this.timer);
    this.compileAbort?.abort('newer-request');
    this.compileAbort = null;
    for (const listener of this.listeners) if (listener.needsDocumentPreview()) listener.pending();
    this.scheduleInspectorLayout();

    // An editor containing only empty embeds has no executable result to
    // request. Their views already publish the explicit empty state.
    if (![...this.listeners].some((listener) => listener.needsDocumentPreview())) {
      this.lastDoc = doc;
      this.lastResult = null;
      this.prunePreparedPublications();
      return;
    }
    const generation = this.generation;
    this.timer = window.setTimeout(() => void this.compile(generation), COMPILE_DELAY_MS);
  }

  private async compile(generation: number): Promise<void> {
    const doc = this.pendingDoc;
    if (this.destroyed || generation !== this.generation || !doc) return;
    this.timer = 0;
    const abort = new AbortController();
    this.compileAbort = abort;
    const messages: string[] = [];
    this.requests++;
    try {
      const result = await this.broker.request(
        doc,
        {
          priority: 'foreground',
          signal: abort.signal,
          onMessage: (message) => messages.push(message),
        },
      );
      if (this.destroyed || generation !== this.generation || abort.signal.aborted) return;
      if (!result) {
        this.publishError(messages.at(-1) || 'Typst whole-document compilation failed.');
        return;
      }
      if (!this.prepared.has(result)) {
        const publication = await prepareEmbedPublication(result);
        if (!publication) {
          this.publishError('The compiler returned an invalid document preview.');
          return;
        }
        this.prepared.set(result, publication);
      }
      if (this.destroyed || generation !== this.generation || abort.signal.aborted) {
        this.prunePreparedPublications();
        return;
      }
      this.lastDoc = doc;
      this.lastResult = result;
      this.lastResultGeneration = generation;
      this.publications++;
      let geometryChanged = false;
      for (const listener of this.listeners) {
        geometryChanged = listener.applyDocumentPreview(result, doc) || geometryChanged;
      }
      this.updatePublicationApplicationState(doc, result);
      this.scheduleInspectorLayout();
      this.prunePreparedPublications();
      if (geometryChanged) scheduleDocumentLayout(this.view);
    } catch (error) {
      if (this.destroyed || generation !== this.generation || abort.signal.aborted) return;
      this.publishError(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.compileAbort === abort) this.compileAbort = null;
    }
  }

  private publishError(message: string): void {
    const doc = this.pendingDoc ?? this.view.state.doc;
    this.publicationFailure = { doc, generation: this.generation, reason: message };
    for (const listener of this.listeners) {
      if (listener.needsDocumentPreview()) listener.compileError(message);
    }
    // Page/line layout may currently be holding the previous exact revision.
    // A terminal compile failure must wake it so that hold is withdrawn.
    scheduleDocumentLayout(this.view, true, message);
  }

  /** Retention equality, rather than applyDocumentPreview's geometry-change
   * return value, proves that every required view accepted this publication.
   * A view may validly return false when geometry did not change. */
  private updatePublicationApplicationState(
    doc: PMNode,
    result: TypstDocumentSvgPublication,
  ): void {
    const rejected = [...this.listeners].some(
      (listener) =>
        listener.needsDocumentPreview() && listener.retainedDocumentPreview() !== result,
    );
    if (rejected) {
      const reason = 'A compiled document preview could not be applied to every geometry consumer.';
      this.publicationFailure = {
        doc,
        generation: this.generation,
        reason,
      };
      scheduleDocumentLayout(this.view, true, reason);
    } else if (
      this.publicationFailure?.doc === doc &&
      this.publicationFailure.generation === this.generation
    ) {
      this.publicationFailure = null;
    }
  }

  publicationFor(result: TypstDocumentSvgPublication): PreparedDocumentPublication | null {
    return this.prepared.get(result) ?? null;
  }

  /** O(1) lookup into the serializer's three preorder namespaces. The maps
   * are built together in one document traversal and reused by every view in
   * the publication, avoiding an N-node rescan for each of N compiled atoms. */
  regionIndexAt(doc: PMNode, pos: number, channel: DocumentPreviewRegionChannel): number | null {
    if (!Number.isSafeInteger(pos) || pos < 0 || pos > doc.content.size) return null;
    return this.indicesFor(doc)[channel].get(pos) ?? null;
  }

  exactLayoutBlockerFor(doc: PMNode): string | null {
    return this.indicesFor(doc).blocker;
  }

  private indicesFor(doc: PMNode): DocumentPreviewIndices {
    if (this.indexedDoc === doc && this.documentIndices) return this.documentIndices;
    const embed = new Map<number, number>();
    const inline = new Map<number, number>();
    const preview = new Map<number, number>();
    let nextEmbed = 0;
    let nextInline = 0;
    let nextPreview = 0;
    let blocker: string | null = null;
    doc.descendants((node, pos) => {
      if (node.type.name === 'typst_embed') {
        embed.set(pos, nextEmbed++);
        if (!blocker) {
          const policy = classifyTypstEmbed(node.textContent);
          if (policy.mode === 'proof') blocker = `Typst embed uses ${policy.reason}`;
        }
      }
      if (node.type.name === 'typst_inline') {
        inline.set(pos, nextInline++);
        preview.set(pos, nextPreview++);
      } else if (
        node.type.name === 'math_inline' ||
        node.type.name === 'math_display' ||
        node.type.name === 'bibliography'
      ) {
        preview.set(pos, nextPreview++);
      }
      return true;
    });
    this.indexedDoc = doc;
    this.documentIndices = { embed, inline, preview, blocker };
    return this.documentIndices;
  }

  /** Explicit publication lifecycle for the layout layer. A failure is not
   * conflated with pending work: old exact chrome must fail open once the
   * replacement is known to be impossible. */
  exactLayoutStatusFor(doc: PMNode): ExactLayoutPublicationState {
    if (this.destroyed) return { status: 'fail', reason: 'Document preview manager was destroyed.' };
    const blocker = this.exactLayoutBlockerFor(doc);
    if (blocker) return { status: 'fail', reason: blocker };
    const required = [...this.listeners].filter((listener) => listener.needsDocumentPreview());
    if (!required.length) return { status: 'ready', reason: null };
    if (
      this.lastDoc === doc &&
      this.lastResultGeneration === this.generation &&
      this.lastResult &&
      required.every((listener) => listener.retainedDocumentPreview() === this.lastResult)
    ) {
      return { status: 'ready', reason: null };
    }
    if (
      this.publicationFailure?.doc === doc &&
      this.publicationFailure.generation === this.generation
    ) {
      return { status: 'fail', reason: this.publicationFailure.reason };
    }
    return { status: 'pending', reason: null };
  }

  /** Compatibility convenience for node views and diagnostics. */
  isReadyFor(doc: PMNode): boolean {
    return this.exactLayoutStatusFor(doc).status === 'ready';
  }

  private prunePreparedPublications(): void {
    const retained = new Set<TypstDocumentSvgPublication>();
    if (this.lastResult) retained.add(this.lastResult);
    for (const listener of this.listeners) {
      const result = listener.retainedDocumentPreview();
      if (result) retained.add(result);
    }
    for (const [result, publication] of this.prepared) {
      if (retained.has(result)) continue;
      URL.revokeObjectURL(publication.objectUrl);
      this.prepared.delete(result);
    }
  }

  stats(): Readonly<{ requests: number; publications: number; views: number }> {
    return Object.freeze({
      requests: this.requests,
      publications: this.publications,
      views: this.listeners.size,
    });
  }

  /** Source inspectors are deliberately out of document flow. Lay their
   * collapsed cards into one collision-free gutter lane so consecutive
   * zero-output definitions remain individually editable without charging
   * fake height to the Typst page. Hover/focus expansion may overlay, but is
   * raised above every collapsed card and never changes document geometry. */
  private scheduleInspectorLayout(): void {
    if (this.destroyed || this.inspectorFrame) return;
    this.inspectorFrame = requestAnimationFrame(() => {
      this.inspectorFrame = 0;
      if (this.destroyed) return;
      let bottom = Number.NEGATIVE_INFINITY;
      const embeds = [...this.view.dom.querySelectorAll<HTMLElement>('.ts-typst-embed')];
      for (const embed of embeds) {
        const source = embed.querySelector<HTMLElement>('.ts-typst-source');
        if (!source) continue;
        const anchorTop = embed.getBoundingClientRect().top;
        const height = Math.max(28, Math.min(source.getBoundingClientRect().height, 64));
        const top = Math.max(anchorTop, bottom + 7);
        embed.style.setProperty('--typst-embed-inspector-offset', `${top - anchorTop}px`);
        bottom = top + height;
      }
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = 0;
    this.compileAbort?.abort('canceled');
    this.compileAbort = null;
    window.removeEventListener(ASSET_EVENT, this.onAssets);
    window.removeEventListener('resize', this.onResize);
    cancelAnimationFrame(this.inspectorFrame);
    this.inspectorFrame = 0;
    if (this.brokerLease) this.brokerLease.release();
    else this.broker.destroy();
    this.listeners.clear();
    for (const publication of this.prepared.values()) URL.revokeObjectURL(publication.objectUrl);
    this.prepared.clear();
    this.pendingDoc = null;
    this.lastDoc = null;
    this.lastResult = null;
    this.lastResultGeneration = -1;
    this.publicationFailure = null;
    this.indexedDoc = null;
    this.documentIndices = null;
  }
}

const managers = new WeakMap<EditorView, TypstEmbedPreviewManager>();
const previewPluginLifetimes = new WeakMap<EditorView, object>();

export function documentPreviewManagerFor(view: EditorView): TypstEmbedPreviewManager {
  let manager = managers.get(view);
  if (!manager) {
    manager = new TypstEmbedPreviewManager(view);
    managers.set(view, manager);
  }
  return manager;
}

/** Document-level invalidation is essential: a prior Typst definition,
 * heading counter, label, or project asset can change an unchanged later
 * embed. NodeView.update alone cannot observe those edits. */
export function typstEmbedPreviewPlugin(): Plugin {
  return new Plugin({
    view(view) {
      const lifetime = {};
      previewPluginLifetimes.set(view, lifetime);
      const manager = documentPreviewManagerFor(view);
      manager.invalidate(view.state.doc);
      return {
        update(next, previous) {
          if (next.state.doc !== previous.doc) manager.invalidate(next.state.doc);
        },
        destroy() {
          // ProseMirror rebuilds node views before replacing plugin views when
          // a file load installs a fresh EditorState. Defer teardown through
          // that synchronous reconfiguration window: the replacement plugin
          // claims a new lifetime token and keeps the exact same manager that
          // those new node views already acquired. A real EditorView destroy
          // has no successor and tears everything down in this microtask.
          queueMicrotask(() => {
            if (previewPluginLifetimes.get(view) !== lifetime) return;
            previewPluginLifetimes.delete(view);
            if (managers.get(view) === manager) managers.delete(view);
            manager.destroy();
          });
        },
      };
    },
  });
}

/** Development/test visibility into this manager only (not worker internals). */
export function typstEmbedPreviewStats(view: EditorView): Readonly<{
  requests: number;
  publications: number;
  views: number;
}> {
  return documentPreviewManagerFor(view).stats();
}

function translateY(page: SVGGElement): number | null {
  const transform = page.getAttribute('transform') ?? '';
  const match = /translate\(\s*[-+\d.eE]+(?:[ ,]+)([-+\d.eE]+)\s*\)/.exec(transform);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export class TypstEmbedView implements NodeView, ManagedDocumentPreviewView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  readonly sourceEl: HTMLElement;
  readonly previewEl: HTMLElement;
  readonly statusEl: HTMLElement;
  readonly renderEl: HTMLElement;

  private node: PMNode;
  private destroyed = false;
  private hasLastGood = false;
  private lastRegionKey = '';
  private lastPreviewResult: TypstDocumentSvgPublication | null = null;
  private renderedResult: TypstDocumentSvgPublication | null = null;
  private readonly manager: TypstEmbedPreviewManager;

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    manager?: TypstEmbedPreviewManager,
  ) {
    this.node = node;
    this.manager = manager ?? documentPreviewManagerFor(view);
    this.dom = document.createElement('div');
    this.dom.className = 'ts-typst-embed';
    this.dom.setAttribute('data-typst-embed', '');

    this.sourceEl = document.createElement('pre');
    this.sourceEl.className = 'ts-typst-source';
    this.contentDOM = document.createElement('code');
    this.contentDOM.setAttribute('data-typst-source', '');
    this.sourceEl.appendChild(this.contentDOM);

    this.previewEl = document.createElement('div');
    this.previewEl.className = 'ts-typst-preview';
    this.previewEl.setAttribute('data-typst-preview', '');
    this.previewEl.contentEditable = 'false';

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'ts-typst-preview-status';
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');

    this.renderEl = document.createElement('div');
    this.renderEl.className = 'ts-typst-preview-render';
    this.renderEl.contentEditable = 'false';
    this.previewEl.append(this.statusEl, this.renderEl);
    this.dom.append(this.sourceEl, this.previewEl);

    this.previewEl.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const pos = this.getPos();
      if (pos === undefined) return;
      const end = pos + this.node.nodeSize - 1;
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)));
      this.view.focus();
    });

    if (this.hasSource() && this.previewPolicy().mode === 'bounded') {
      this.setPreviewState('idle', 'Exact document preview has not compiled yet.');
    } else if (this.hasSource()) {
      this.publishProofOnly();
      scheduleDocumentLayout(this.view, true);
    } else {
      this.publishEmpty('No Typst source to preview.');
    }
    this.manager.register(this);
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.typst_embed) return false;
    const changed = !node.eq(this.node);
    this.node = node;
    if (!this.hasSource()) this.publishEmpty('No Typst source to preview.');
    else if (this.previewPolicy().mode === 'proof') {
      this.publishProofOnly();
      scheduleDocumentLayout(this.view, true);
    }
    if (changed) this.manager.invalidate(this.view.state.doc);
    return true;
  }

  hasSource(): boolean {
    return !!this.node.textContent.trim();
  }

  private previewPolicy() {
    return classifyTypstEmbed(this.node.textContent);
  }

  needsDocumentPreview(): boolean {
    return this.hasSource() && this.previewPolicy().mode === 'bounded';
  }

  retainedDocumentPreview(): TypstDocumentSvgPublication | null {
    return this.renderedResult;
  }

  pending(): void {
    if (this.destroyed || !this.needsDocumentPreview()) return;
    this.setPreviewState(
      'pending',
      this.hasLastGood
        ? 'Updating exact document preview — showing the last good result.'
        : 'Updating exact document preview…',
    );
  }

  applyDocumentPreview(result: TypstDocumentSvgPublication, doc: PMNode): boolean {
    if (this.destroyed || !this.needsDocumentPreview()) return false;
    const pos = this.getPos();
    const index = pos === undefined ? null : this.manager.regionIndexAt(doc, pos, 'embed');
    const publication = this.manager.publicationFor(result);
    const region = index === null ? null : publication?.embedRegions.get(index);
    if (!region) {
      this.compileError('The exact document compiled without a region for this embed.');
      return false;
    }
    return this.stageRegion(result, region);
  }

  private stageRegion(result: TypstDocumentSvgPublication, region: TypstEmbedRegion): boolean {
    const publication = this.manager.publicationFor(result);
    if (!publication) {
      this.compileError('The compiler returned an invalid document preview.');
      return false;
    }
    const startPageY = publication.pageY[region.start.page - 1];
    const endPageY = publication.pageY[region.end.page - 1];
    if (startPageY === undefined || endPageY === undefined) {
      this.compileError('The compiler returned document coordinates that could not be cropped.');
      return false;
    }

    const start = startPageY + region.start.y;
    const end = endPageY + region.end.y;
    const regionHeight = end - start;
    const settings = normalizeSettings(this.view.state.doc.attrs.settings);
    const viewBox = publication.viewBox;
    const pageWidth = viewBox[2];
    const cropX = Math.max(viewBox[0], Math.min(region.start.x, viewBox[0] + pageWidth));
    const right = Math.max(cropX + 1, viewBox[0] + pageWidth - settings.marginRight * 72);
    const cropWidth = right - cropX;
    const key = [region.index, start, end, cropX, cropWidth].join(':');
    // Geometry alone cannot identify the pixels: two successive SVGs can
    // have identical byte lengths and crop coordinates but different paint.
    // The manager publishes an immutable result object for each compile.
    if (result === this.lastPreviewResult && key === this.lastRegionKey) {
      this.setPreviewState('ready', 'Preview is current.');
      return false;
    }

    // A cross-page interval includes page remainders and may contain repeated
    // headers/folios. Painting that giant crop out of flow would cover later
    // editable content; charging it to flow would invent a second paginator.
    // Keep the source at its true zero-flow anchor and make Proof the explicit
    // exact surface for this exceptional multi-page construct.
    const samePage = region.start.page === region.end.page;
    const flowHeightPt = samePage && regionHeight > 0 ? regionHeight : 0;
    this.dom.style.setProperty('--typst-embed-flow-height', `${(flowHeightPt * 4) / 3}px`);
    this.dom.dataset.regionPages = `${region.start.page}-${region.end.page}`;

    if (!samePage) {
      this.lastPreviewResult = result;
      this.lastRegionKey = key;
      this.renderEl.replaceChildren();
      // Proof-only is the exact application state for an unrepresentable
      // cross-page atomic crop; retaining the publication also lets the page
      // translator distinguish it from a still-pending preview.
      this.renderedResult = result;
      this.hasLastGood = false;
      this.setPreviewState(
        'proof',
        `This embed spans ${region.end.page - region.start.page + 1} Typst pages — open Proof for the exact output.`,
      );
      return true;
    }

    if (!(regionHeight > 0.05)) {
      this.lastPreviewResult = result;
      this.lastRegionKey = key;
      this.publishEmpty('Compiled successfully; this embed has no in-flow visual output.');
      this.renderedResult = result;
      return true;
    }

    const svgEl = document.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('xmlns', SVG_NS);
    svgEl.setAttribute('viewBox', `${cropX} ${start} ${cropWidth} ${regionHeight}`);
    svgEl.setAttribute('width', String(cropWidth));
    svgEl.setAttribute('height', String(regionHeight));
    svgEl.style.width = `${(cropWidth * 4) / 3}px`;
    svgEl.style.height = `${(regionHeight * 4) / 3}px`;
    svgEl.style.display = 'block';
    const image = document.createElementNS(SVG_NS, 'image');
    image.setAttribute('href', publication.objectUrl);
    image.setAttribute('x', String(viewBox[0]));
    image.setAttribute('y', String(viewBox[1]));
    image.setAttribute('width', String(viewBox[2]));
    image.setAttribute('height', String(viewBox[3]));
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttribute('data-exact-document-publication', '');
    svgEl.appendChild(image);
    this.renderEl.replaceChildren(svgEl);
    this.lastPreviewResult = result;
    this.renderedResult = result;
    this.lastRegionKey = key;
    this.hasLastGood = true;
    this.setPreviewState('ready', 'Preview is current.');
    return true;
  }

  private publishEmpty(message: string): void {
    this.renderEl.replaceChildren();
    this.dom.style.setProperty('--typst-embed-flow-height', '0px');
    this.renderedResult = null;
    this.hasLastGood = false;
    this.setPreviewState('empty', message);
  }

  private publishProofOnly(): void {
    const policy = this.previewPolicy();
    if (policy.mode !== 'proof') return;
    this.renderEl.replaceChildren();
    this.dom.style.setProperty('--typst-embed-flow-height', '0px');
    this.lastPreviewResult = null;
    this.lastRegionKey = '';
    this.renderedResult = null;
    this.hasLastGood = false;
    this.setPreviewState(
      'proof',
      `Exact in Proof/PDF — this source uses ${policy.reason}, which can affect content outside its editable block.`,
    );
  }

  compileError(message: string): void {
    if (this.destroyed || !this.needsDocumentPreview()) return;
    const detail = message.replace(/\s+/g, ' ').trim().slice(0, 240) || 'Typst compilation failed.';
    this.setPreviewState(
      'error',
      this.hasLastGood
        ? `Preview failed — showing the last good result. ${detail}`
        : `Preview failed — source is unchanged. ${detail}`,
      detail,
    );
  }

  private setPreviewState(state: PreviewState, status: string, error = ''): void {
    this.dom.dataset.previewState = state;
    this.previewEl.dataset.previewState = state;
    this.previewEl.dataset.lastGood = String(this.hasLastGood);
    this.statusEl.textContent = status;
    if (error) this.previewEl.dataset.previewError = error;
    else delete this.previewEl.dataset.previewError;
  }

  ignoreMutation(mutation: MutationRecord | { type: 'selection' }): boolean {
    if (mutation.type === 'selection') return false;
    return !this.contentDOM.contains((mutation as MutationRecord).target);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.manager.unregister(this);
  }
}
