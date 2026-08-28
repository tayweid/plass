// The layout translator (spec §3.5): reads the oracle's line layouts and
// imposes them on the editing surface as ProseMirror decorations.
//
//   - an inline decoration per justified line carrying exact word-spacing
//   - a <br> widget at each chosen break point
//   - a hyphen+<br> widget at hyphenation breaks
//   - page-gap widgets that push content past painted page boundaries
//
// Decorations are presentation-only: the document, the clipboard, and
// accessibility all see clean text. The DOM stays the editing surface —
// native selection, IME, and spell-check keep working (spec §1.3).
//
// Scheduling: the active block returns to native browser wrapping inside the
// edit transaction, so the keystroke can paint without waiting for global
// line breaking. Untouched blocks and page geometry retain their last settled
// layout. After the quiet period, one exact pass restores Typst-equivalent
// lines and pages for the committed revision.
//
// Pagination has one authority: a successful full-document Typst snapshot.
// Its page starts become exact-height spacers. Those exact starts may be
// mapped briefly while their replacement compiles, but only while validation
// succeeds. Any failure or invalidation removes every spacer and page claim;
// the editor then presents one honest continuous native surface until Typst
// produces a new exact snapshot.

import { Plugin, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { Measurer } from './layout/measure';
import {
  layoutBlock,
  type ForcedBreak,
  type LayoutOptions,
  type LineLayout,
} from './layout/paragraph';
import { buildSpec, type AtomResolver, type SpecKind } from './layout/typst-oracle';
import type { PageOracle } from './layout/page-oracle';
import { getSettings, PAGE_GAP, pageSize, parseMathMacros, type DocSettings } from './settings';
import { docToTyp, escapeTyp, expandMacrosWith, pageTopAdjustEm } from './typ-serializer';
import { citeOrder } from './citations';
import { eqKey } from './equations';
import { isFlexibleAtom } from './inline-raw';
import { classifyTypstInline } from './typst-inline-regions';
import { inlineMathToTypst } from './math-typst';
import { recordLayoutPerf } from './layout/perf';
import { effectiveFont } from './font-registry';
import {
  appendLineDecorations,
  blockSpacerDecoration,
  decorationSetDigest,
  decorationSignature,
  stripActiveLineDecorations,
  type Spacer,
  type TypesetDecorationSpec,
} from './layout/line-decorations';
import {
  BlockLayoutCache,
  consecutiveParagraph,
  createPaintedPrefixMeasurements,
  forcedBreakSignature,
  makeAtomWidth,
  type AtomWidth,
  type BlockLayoutCacheKey,
} from './layout/block-layout';
import {
  typesetKey,
  type PageInfo,
  type TypesetMeta,
  type ExactPageBasis,
  type TypesetState,
  type TypesetStats,
} from './layout/typeset-state';
import { LayoutScheduler } from './layout/layout-scheduler';
import { OracleCoordinator } from './layout/oracle-coordinator';
import { snapshotBreaksFor } from './layout/layout-snapshot';
import {
  acquireDocumentCompileBroker,
  type DocumentCompileBrokerLease,
} from './document-compile-broker';
import { documentPreviewManagerFor } from './raw-preview';
import {
  HeightIndex,
  createPaginationSnapshot,
  type PaginationSnapshot as HeightSnapshot,
} from './layout/pagination-snapshot';
import { layoutForcedBlock } from './layout/forced-layout';
import {
  ForcedLayoutAuditor,
  type ForcedLayoutAuditReport,
} from './layout/forced-layout-audit';

export { typesetKey };
export type { PageInfo, TypesetMeta, TypesetState, TypesetStats };

let forcedFastHits = 0;
let forcedFallbacks = 0;
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  const w = window as unknown as {
    __forcedPathStats: () => { fast: number; fallback: number };
  };
  w.__forcedPathStats = () => ({ fast: forcedFastHits, fallback: forcedFallbacks });
}

/** Vertical gap between stacked footnote bodies / height of the separator zone (px). */
const FN_GAP = 6;

type CurrentSpacers = {
  lineMap: Map<number, Spacer>;
  blocks: Spacer[];
  sorted: Array<{ pos: number; height: number }>;
};

interface PaginationGeometrySnapshot {
  settings: DocSettings;
  size: { w: number; h: number };
  marginTop: number;
  marginBottom: number;
  stackTop: number;
  bodyPx: number;
  spacers: CurrentSpacers;
  heights: HeightSnapshot;
  spacerHeights: HeightIndex;
}

interface PaginationPassResult {
  spacers: Spacer[];
  count: number;
}

const viewRegistry = new WeakMap<EditorView, TypesetView>();

/** Request a re-typeset without a document change (e.g. an image loaded). */
export function scheduleTypeset(view: EditorView) {
  viewRegistry.get(view)?.requestRun();
}

/** An asset changed on disk (image rewritten): page geometry may have moved
 *  even though the document — and so the page-oracle signature — did not. */
export function invalidatePageLayout(view: EditorView) {
  const tv = viewRegistry.get(view);
  if (!tv) return;
  tv.invalidatePages();
  tv.requestRun();
}

export function typesetPlugin(
  opts: { onStats?: (s: TypesetStats) => void; onPages?: (p: PageInfo) => void } = {},
) {
  return new Plugin<TypesetState>({
    key: typesetKey,
    state: {
      init: () => ({
        decos: DecorationSet.empty,
        pageMarks: DecorationSet.empty,
        pageBasis: null,
      }),
      apply(tr, val) {
        const meta = tr.getMeta(typesetKey) as TypesetMeta | undefined;
        if (meta?.type === 'decos') {
          return {
            decos: meta.decos,
            pageMarks: meta.pageMarks ?? val.pageMarks.map(tr.mapping, tr.doc),
            pageBasis: meta.pageBasis === undefined ? val.pageBasis : meta.pageBasis,
          };
        }
        if (meta?.type === 'pageMarks') {
          return { decos: val.decos, pageMarks: meta.pageMarks, pageBasis: meta.pageBasis };
        }
        if (tr.docChanged) {
          // Remove the previous revision's forced lines before mapping the
          // decoration set. Long paragraphs can own thousands of inline
          // decorations; mapping all of them only to discard them made the
          // first key after a settle noticeably slower than following keys.
          const oldScopes = new Map<string, { from: number; to: number }>();
          const addOldScopeAt = (pos: number) => {
            const safe = Math.max(0, Math.min(pos, tr.before.content.size));
            const $pos = tr.before.resolve(safe);
            for (let depth = $pos.depth; depth > 0; depth--) {
              const node = $pos.node(depth);
              if (node.isTextblock || node.type.name === 'footnote') {
                const from = $pos.before(depth);
                const to = from + node.nodeSize;
                oldScopes.set(`${from}:${to}`, { from, to });
                return;
              }
            }
          };
          tr.mapping.maps.forEach((stepMap, index) => {
            stepMap.forEach((oldFrom, oldTo) => {
              let originalFrom = oldFrom;
              let originalTo = oldTo;
              for (let prior = index - 1; prior >= 0; prior--) {
                const inverse = tr.mapping.maps[prior].invert();
                originalFrom = inverse.map(originalFrom, -1);
                originalTo = inverse.map(originalTo, 1);
              }
              addOldScopeAt(originalFrom);
              addOldScopeAt(originalTo);
            });
          });
          let previousDecos = val.decos;
          for (const scope of oldScopes.values()) {
            previousDecos = stripActiveLineDecorations(previousDecos, scope);
          }

          let decos = previousDecos.map(tr.mapping, tr.doc);
          // Paint-first editing: mapped forced breaks belong to the previous
          // document. Remove them only from blocks touched by this transaction
          // so the browser can paint the new text immediately. Page gaps stay
          // mapped to preserve the last settled page geometry; the quiet pass
          // atomically publishes a new exact layout.
          const scopes = new Map<string, { from: number; to: number }>();
          const addScopeAt = (pos: number) => {
            const safe = Math.max(0, Math.min(pos, tr.doc.content.size));
            const $pos = tr.doc.resolve(safe);
            for (let depth = $pos.depth; depth > 0; depth--) {
              const node = $pos.node(depth);
              if (node.isTextblock || node.type.name === 'footnote') {
                const from = $pos.before(depth);
                const to = from + node.nodeSize;
                scopes.set(`${from}:${to}`, { from, to });
                return;
              }
            }
          };
          tr.mapping.maps.forEach((stepMap, index) => {
            const remaining = tr.mapping.slice(index + 1);
            stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
              const from = remaining.map(newFrom, -1);
              const to = remaining.map(newTo, 1);
              addScopeAt(from);
              addScopeAt(to);
              tr.doc.nodesBetween(
                Math.max(0, Math.min(from, tr.doc.content.size)),
                Math.max(0, Math.min(Math.max(to, from), tr.doc.content.size)),
                (node, pos) => {
                  if (node.isTextblock || node.type.name === 'footnote') {
                    scopes.set(`${pos}:${pos + node.nodeSize}`, { from: pos, to: pos + node.nodeSize });
                    return false;
                  }
                  return true;
                },
              );
            });
          });
          for (const scope of scopes.values()) {
            decos = stripActiveLineDecorations(decos, scope);
          }
          return {
            decos,
            pageMarks: val.pageMarks.map(tr.mapping, tr.doc),
            pageBasis: val.pageBasis,
          };
        }
        return val;
      },
    },
    props: {
      decorations(state) {
        return typesetKey.getState(state)?.decos ?? null;
      },
    },
    view: (view) => new TypesetView(view, opts),
  });
}

class TypesetView {
  private cache = new BlockLayoutCache();
  private docSig = new WeakMap<PMNode, string>();
  private measurer: Measurer;
  private oracles: OracleCoordinator;
  private documentCompilerLease: DocumentCompileBrokerLease;
  private scheduler!: LayoutScheduler;
  /** Signature of the last dispatched decoration set: identical layouts are
   *  never re-dispatched, so no-op runs cause zero paints. */
  private lastDecoSig = '';
  private pendingPageMarks: {
    marks: DecorationSet;
    basis: ExactPageBasis | null;
  } | null = null;
  /** Which source produced the last pagination (diagnostics). */
  private pagPath: 'exact' | 'held' | 'continuous' = 'continuous';
  private pagLog: string[] = [];
  private pagWhy = '';
  private forcedAuditor: ForcedLayoutAuditor | null = null;
  private lineDecorationDispatches = 0;
  private pageMarkDispatches = 0;
  private paginationSnapshotStats = { captures: 0, spacerScans: 0, heightQueries: 0 };
  private paginationGeometryEpoch = 0;
  private lastPaginationWidth = 0;
  private destroyed = false;

  constructor(
    private view: EditorView,
    private opts: { onStats?: (s: TypesetStats) => void; onPages?: (p: PageInfo) => void },
  ) {
    viewRegistry.set(view, this);
    this.measurer = new Measurer(view.dom);
    this.documentCompilerLease = acquireDocumentCompileBroker(view);
    this.oracles = new OracleCoordinator({
      onPageResults: () => this.requestRun(),
      compileDocument: (doc, coordinated, signal) =>
        this.documentCompilerLease.broker.request(doc, {
          priority: coordinated?.priority ?? 'layout',
          signal,
        }),
    });
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __pageOracle?: PageOracle;
        __breakSig?: () => string;
        __forcedLayoutAudit?: {
          start: () => void;
          snapshot: () => ForcedLayoutAuditReport;
          stop: () => ForcedLayoutAuditReport;
        };
        __layoutDispatchStats?: (reset?: boolean) => { lines: number; pageMarks: number };
        __paginationSnapshotStats?: (reset?: boolean) => {
          captures: number;
          spacerScans: number;
          heightQueries: number;
        };
        __layoutSnapshotStats?: () => {
          status: 'ok' | 'fail' | 'pending';
          pages: number;
          blocks: number;
          revision: number;
          reason: string | null;
        };
      };
      w.__pageOracle = this.oracles.page;
      (w as unknown as { __pagLog: () => string[] }).__pagLog = () => this.pagLog;
      w.__breakSig = () => {
        const st = typesetKey.getState(this.view.state);
        if (!st) return '';
        const keys: string[] = [];
        st.decos.find(undefined, undefined, (spec) => {
          const k = (spec as { key?: string } | null)?.key;
          if (k && /^(br|hy):/.test(k)) keys.push(k);
          return false;
        });
        return keys.sort().join('|');
      };
      this.forcedAuditor = new ForcedLayoutAuditor(view.dom);
      w.__forcedLayoutAudit = {
        start: () => {
          this.forcedAuditor!.start();
          this.cache.clear();
          // This opt-in diagnostic must observe a fresh translation even
          // when the scheduler already owns a coalesced frame. Run it now;
          // the auditor is development-only and deliberately expensive.
          this.run();
        },
        snapshot: () => this.forcedAuditor!.snapshot(),
        stop: () => this.forcedAuditor!.stop(),
      };
      w.__layoutDispatchStats = (reset = false) => {
        const stats = {
          lines: this.lineDecorationDispatches,
          pageMarks: this.pageMarkDispatches,
        };
        if (reset) {
          this.lineDecorationDispatches = 0;
          this.pageMarkDispatches = 0;
        }
        return stats;
      };
      w.__paginationSnapshotStats = (reset = false) => {
        const stats = { ...this.paginationSnapshotStats };
        if (reset) {
          this.paginationSnapshotStats = { captures: 0, spacerScans: 0, heightQueries: 0 };
        }
        return stats;
      };
      w.__layoutSnapshotStats = () => {
        const entry = this.documentLayoutEntry(false);
        return {
          status: entry?.status ?? 'pending',
          pages: entry?.snapshot?.pageCount ?? 0,
          blocks: entry?.snapshot?.blocks.length ?? 0,
          revision: entry?.snapshot?.revision ?? 0,
          reason: entry?.reason ?? null,
        };
      };
    }
    this.scheduler = new LayoutScheduler(view.dom, {
      runSettled: () => this.run(),
      // Web fonts arriving change every browser metric. The Typst oracles
      // remain valid because their bundled font inputs did not change.
      invalidateMetrics: () => {
        this.paginationGeometryEpoch++;
        this.abandonPageBasis();
        this.measurer.invalidate();
        this.cache.clear();
      },
    });
  }

  /** Translate already-authoritative break offsets into browser line ranges.
   * The direct path performs no break search or syllabification; malformed or
   * unsupported input falls back to the general forced-break translator,
   * which still consumes the same compiled offsets and never chooses breaks. */
  private layoutAuthoritative(
    block: PMNode,
    measure: number,
    atomWidth: AtomWidth,
    opts: Omit<LayoutOptions, 'forced'> & { forced: ForcedBreak[] },
    auditId: string,
  ): LineLayout[] | null {
    const fast = layoutForcedBlock(block, measure, this.measurer, atomWidth, opts);
    if (fast) forcedFastHits++;
    else forcedFallbacks++;

    this.forcedAuditor?.record(auditId, block, measure, atomWidth, opts);

    return fast ?? layoutBlock(block, measure, this.measurer, atomWidth, opts);
  }

  update(view: EditorView, prevState: EditorState) {
    // Document settings (font, size, hyphenation, …) invalidate every metric.
    if (view.state.doc.attrs !== prevState.doc.attrs) {
      this.paginationGeometryEpoch++;
      this.abandonPageBasis();
      this.measurer.invalidate();
      this.cache.clear();
      this.oracles.clear();
    }
    if (view.state.doc !== prevState.doc) {
      // The plugin state's transaction hook has already mapped decorations
      // and stripped forced lines from every touched block. Synchronize the
      // no-op signature with that paint-first state so the pending compiler
      // pass does not dispatch an identical empty/native decoration set.
      this.lastDecoSig = decorationSetDigest(
        typesetKey.getState(view.state)?.decos ?? DecorationSet.empty,
      );
      // Results for the previous revision must not begin expensive SVG
      // analysis while the user is typing. Completed cache entries survive;
      // only queued/in-flight publication is superseded.
      this.oracles.cancelPending();
      // Exact paragraph optimization is intentionally absent from the
      // pre-paint path. The changed block is already native in plugin state;
      // the quiet-period pass publishes the next exact revision.
      this.scheduler.scheduleAfterEdit();
    }
  }

  destroy() {
    this.destroyed = true;
    viewRegistry.delete(this.view);
    this.scheduler.destroy();
    this.oracles.destroy();
    this.documentCompilerLease.release();
    this.measurer.destroy();
  }

  /** Drop cached page-break decisions (asset bytes changed under same sig). */
  invalidatePages() {
    this.paginationGeometryEpoch++;
    this.abandonPageBasis();
    this.oracles.clearPage();
  }

  requestRun() {
    this.scheduler?.scheduleSettled();
  }

  /** Return (and optionally request) the one full-document Typst snapshot
   * for the current revision. Both paragraph breaks and page starts come
   * from this entry, so settled layout has one compiler authority. */
  private documentLayoutEntry(request: boolean) {
    const state = this.view.state;
    const settings = getSettings(state);
    if (!effectiveFont(settings.font).exact) return undefined;
    let sig = this.docSig.get(state.doc);
    if (!sig) {
      try {
        sig = docToTyp(state.doc);
        this.docSig.set(state.doc, sig);
      } catch {
        return undefined;
      }
    }
    const entry = this.oracles.page.get(sig);
    if (!entry && request) {
      this.oracles.page.request(sig, state.doc, settings, this.atomResolver());
    }
    return entry;
  }

  /** The SVG snapshot and every geometry-carrying crop are one atomic visual
   * publication. The PageOracle may finish parsing first, but its lines/pages
   * are not exact in the editor until the shared preview manager has applied
   * that same result to all live nodes. */
  private documentPublicationReady(): boolean {
    return documentPreviewManagerFor(this.view).isReadyFor(this.view.state.doc);
  }

  private documentPublicationBlocker(): string | null {
    return documentPreviewManagerFor(this.view).exactLayoutBlockerFor(this.view.state.doc);
  }

  /** The page spacers currently in the document, read back from the live
   *  decoration set (they carry their height in spec.h). */
  private currentSpacers(): CurrentSpacers {
    const set = typesetKey.getState(this.view.state)?.decos;
    // CSS rounds a requested gap to hundredths and each browser then stores
    // that length in its own layout units. Natural-coordinate recovery must
    // subtract what the DOM actually painted, not the unrounded request in
    // the decoration spec, or a full pagination pass drifts on every rerun.
    const paintedHeights = new Map<string, number>();
    for (const gap of this.view.dom.querySelectorAll<HTMLElement>('.ts-pagegap[data-ts-gap-key]')) {
      const key = gap.dataset.tsGapKey;
      const height = gap.getBoundingClientRect().height;
      if (key && Number.isFinite(height) && height > 0) paintedHeights.set(key, height);
    }
    const lineMap = new Map<number, Spacer>();
    const blocks: Spacer[] = [];
    const sorted: Array<{ pos: number; height: number }> = [];
    for (const d of set?.find(undefined, undefined, (spec) => {
      const kind = (spec as Partial<TypesetDecorationSpec> | null)?.tsKind;
      return kind === 'line-page-gap' || kind === 'block-page-gap';
    }) ?? []) {
      const spec = d.spec as Partial<TypesetDecorationSpec>;
      const h = spec.h ?? 0;
      if (!(h > 0)) continue;
      if (spec.tsKind === 'block-page-gap') blocks.push({ pos: d.from, height: h, kind: 'block' });
      else lineMap.set(d.from, { pos: d.from, height: h, kind: 'line' });
      // lineMap/blocks retain the requested value so a validated held pass
      // can recreate the same decoration. The geometry index alone consumes
      // physical height because it is undoing physical DOM displacement.
      const painted = spec.key ? paintedHeights.get(spec.key) : undefined;
      sorted.push({ pos: d.from, height: painted ?? h });
    }
    sorted.sort((a, b) => a.pos - b.pos);
    return { lineMap, blocks, sorted };
  }

  /** Capture the complete height model once, after pass-one line decorations
   * have been installed. Exact and validated-held translation both read this
   * same immutable prefix index. */
  private capturePaginationSnapshot(): PaginationGeometrySnapshot {
    const host = this.view.dom.parentElement ?? this.view.dom;
    const width = this.view.dom.clientWidth;
    if (this.lastPaginationWidth && Math.abs(width - this.lastPaginationWidth) > 0.5) {
      this.paginationGeometryEpoch++;
    }
    this.lastPaginationWidth = width;
    const settings = getSettings(this.view.state);
    const size = pageSize(settings);
    const marginTop = settings.marginTop * 96;
    const marginBottom = settings.marginBottom * 96;
    const spacers = this.currentSpacers();
    const heights = createPaginationSnapshot({ spacers: spacers.sorted, tableExtras: [] });
    this.paginationSnapshotStats.captures++;
    this.paginationSnapshotStats.spacerScans++;
    return {
      settings,
      size,
      marginTop,
      marginBottom,
      stackTop: host.getBoundingClientRect().top,
      bodyPx: this.bodyPx(),
      spacers,
      heights,
      spacerHeights: new HeightIndex(heights.spacers),
    };
  }

  private heightAbove(snapshot: PaginationGeometrySnapshot, pos: number, spacersOnly = false): number {
    this.paginationSnapshotStats.heightQueries++;
    return (spacersOnly ? snapshot.spacerHeights : snapshot.heights.heights).heightAbove(pos);
  }

  /** Drop mapped exact provenance immediately. The empty marker publication
   * is batched with the next decoration pass, so old page starts cannot
   * reappear after a failure, resize, settings change, or rejected hold. */
  private abandonPageBasis(): void {
    this.oracles?.pageConfidence.abandon();
    this.pendingPageMarks = { marks: DecorationSet.empty, basis: null };
  }

  /** Font size in px (body em). */
  private bodyPx(): number {
    return parseFloat(getComputedStyle(this.view.dom).fontSize) || 16.67;
  }

  private unitKindOf(node: PMNode | null): 'paragraph' | 'h1' | 'h2' | 'h3' | null {
    if (!node) return null;
    if (node.type.name === 'heading') return `h${Math.min(3, node.attrs.level as number)}` as 'h1' | 'h2' | 'h3';
    if (node.type.name === 'paragraph') return 'paragraph';
    // Front-matter blocks are paragraph-class boxes (title's larger text
    // scales its ascender the same way Typst does).
    if (['doc_title', 'doc_authors', 'doc_date'].includes(node.type.name)) return 'paragraph';
    return null;
  }

  /** Align page-1 ink with the PDF: Typst's first baseline sits one
   *  ascender below the margin; CSS line boxes/padding sit lower. */
  private applyTopAdjust() {
    const host = this.view.dom.parentElement;
    if (!host) return;
    const s = getSettings(this.view.state);
    const kind = this.unitKindOf(this.view.state.doc.firstChild);
    const adj = kind ? pageTopAdjustEm(s, kind) * this.bodyPx() : 0;
    host.style.paddingTop = `${(s.marginTop * 96 + adj).toFixed(2)}px`;
  }

  private run() {
    if (this.destroyed) return;

    const t0 = performance.now();
    this.applyTopAdjust();
    // Start the authoritative document compile before any local geometry
    // work. Its immutable result drives both line and page decisions on the
    // next settled publication; revision guards prevent stale installation.
    this.documentLayoutEntry(true);

    // Pass 1: line layout with the CURRENT page spacers kept in place — in
    // the quiescent case this set equals the live one and the signature
    // suppresses the dispatch entirely (zero DOM writes, zero reflows).
    // Pagination then measures through the spacers by subtracting them.
    const held = this.currentSpacers();
    const lineStart = performance.now();
    const stats = this.dispatchDecos(held.lineMap, held.blocks);
    let lineLayoutMs = performance.now() - lineStart;

    // Pass 2: measure natural geometry, compute page breaks, re-dispatch with
    // spacers. Both dispatches share one task, so nothing paints in between.
    const snapshot = this.capturePaginationSnapshot();
    const paginationStart = performance.now();
    const { spacers, count } = this.paginate(snapshot);
    const paginationMs = performance.now() - paginationStart;
    this.pagLog.push(this.pagPath + '[' + this.pagWhy + ']:' + spacers.map((sp) => `${sp.pos}@${Math.round(sp.height)}`).join(','));
    if (this.pagLog.length > 40) this.pagLog.shift();
    if (spacers.length || held.lineMap.size || held.blocks.length) {
      const lineSpacers = new Map<number, Spacer>();
      const blockSpacers: Spacer[] = [];
      for (const sp of spacers) (sp.kind === 'line' ? lineSpacers.set(sp.pos, sp) : blockSpacers.push(sp));
      const secondLineStart = performance.now();
      this.dispatchDecos(lineSpacers, blockSpacers);
      lineLayoutMs += performance.now() - secondLineStart;
    }

    // Single-page runs skip the second dispatch — flush pending markers.
    if (this.pendingPageMarks) {
      const pending = this.pendingPageMarks;
      this.pendingPageMarks = null;
      const tr = this.view.state.tr.setMeta(typesetKey, {
        type: 'pageMarks',
        pageMarks: pending.marks,
        pageBasis: pending.basis,
      } satisfies TypesetMeta);
      tr.setMeta('addToHistory', false);
      this.pageMarkDispatches++;
      this.view.dispatch(tr);
    }

    const footnoteStart = performance.now();
    if (this.pagPath !== 'continuous') this.placeFootnotes(count);
    const footnoteMs = performance.now() - footnoteStart;

    const s = getSettings(this.view.state);
    const size = pageSize(s);
    this.opts.onPages?.({
      mode: this.pagPath,
      reason: this.pagWhy,
      count,
      pageW: size.w,
      pageH: size.h,
      gap: PAGE_GAP,
      marginBottom: s.marginBottom * 96,
      marginLeft: s.marginLeft * 96,
      marginRight: s.marginRight * 96,
    });
    const totalMs = performance.now() - t0;
    recordLayoutPerf('settle', {
      totalMs,
      lineLayoutMs,
      paginationMs,
      footnoteMs,
      paragraphs: stats.paragraphs,
      lines: stats.lines,
    });
    this.opts.onStats?.({ ms: totalMs, paragraphs: stats.paragraphs, lines: stats.lines });
  }

  /**
   * The oracle probe needs each inline atom rendered exactly as the PDF
   * will render it (same glyphs, same widths): citations as their painted
   * "[n]", references as "(1)", footnote markers as superscripts.
   */
  private atomResolver(): AtomResolver {
    const state = this.view.state;
    const labels = eqKey.getState(state)?.labels ?? new Map<string, string>();
    const order = citeOrder(state.doc);
    const settings = getSettings(state);
    const macros = parseMathMacros(settings.mathMacros);
    const fnNums = new Map<PMNode, number>();
    let fn = 0;
    state.doc.descendants((n) => {
      if (n.type.name === 'footnote') {
        fnNums.set(n, ++fn);
        return false;
      }
      return true;
    });
    return (child) => {
      switch (child.type.name) {
        case 'math_inline':
          return {
            markup: inlineMathToTypst(expandMacrosWith(child.attrs.src as string, macros)),
          };
        case 'typst_inline': {
          // Fixed atoms are recovered from the shared document crop;
          // canonical #h(1fr) receives compiled line slack. Arbitrary or
          // stateful source stays lossless but keeps this paragraph native.
          const source = child.attrs.src as string;
          return classifyTypstInline(source).kind === 'unsupported'
            ? null
            : { markup: source };
        }
        case 'citation': {
          const t = `[${order.get(child.attrs.key as string) ?? '?'}]`;
          return { markup: escapeTyp(t), text: t };
        }
        case 'eq_ref': {
          const t = (labels.get(child.attrs.label as string) as string) ?? '(?)';
          return { markup: escapeTyp(t), text: t };
        }
        case 'footnote': {
          // Real #footnote with the counter preset: the marker must have the
          // exact width the exported document will have (the body renders at
          // the compiled page's bottom, out of the line flow).
          const n = fnNums.get(child) ?? 1;
          return { markup: `#counter(footnote).update(${n - 1});#footnote[.]`, text: String(n) };
        }
        default:
          return null;
      }
    };
  }

  /** Build the full decoration set (lines + spacers) and dispatch it. */
  private dispatchDecos(lineSpacers: Map<number, Spacer>, blockSpacers: Spacer[]) {
    const { state } = this.view;
    const decos: Decoration[] = [];
    const settings = getSettings(state);
    const font = effectiveFont(settings.font);
    const layoutOpts = { hyphenate: settings.hyphenate, isFill: isFlexibleAtom };
    const useOracle = font.exact;
    const resolveAtom = useOracle ? this.atomResolver() : null;
    const documentSnapshot = this.documentPublicationReady()
      ? this.documentLayoutEntry(false)?.snapshot
      : undefined;
    let paragraphs = 0;
    let lineCount = 0;
    let figNo = 0;

    /** Lay one textblock (paragraph / caption / footnote body) and emit its
     *  spacing + break decorations. */
    const layoutInto = (
      node: PMNode,
      pos: number,
      measure: number,
      skind: SpecKind,
      extra: { firstLineIndent?: number; scale?: number },
    ) => {
      // Aligned paragraphs keep browser layout (CSS text-align centers or
      // right-sets each ragged line) — display lines, not justified prose.
      if (node.type.name === 'paragraph' && node.attrs.align) return;
      const atomWidth = makeAtomWidth(this.view, pos);

      // Every textblock reads from the same immutable whole-document
      // publication. A missing/malformed contextual region fails only that
      // caption or footnote back to native wrapping; it never launches a
      // second synthetic Typst world.
      const spec = resolveAtom ? buildSpec(node, resolveAtom) : null;
      const exactDocumentBreaks =
        spec
          ? snapshotBreaksFor(documentSnapshot, pos, spec.key)
          : undefined;
      const ostatus = exactDocumentBreaks !== undefined ? 'ok' : 'none';

      const indent = extra.firstLineIndent ?? 0;
      const scale = extra.scale ?? 1;
      const cacheKey: BlockLayoutCacheKey = {
        measure,
        oracle: ostatus,
        key: spec?.key ?? null,
        indent,
        scale,
      };
      const compiledBreaks = exactDocumentBreaks === undefined
        ? undefined
        : [...exactDocumentBreaks];
      let entry =
        ostatus === 'ok' && !compiledBreaks
          ? undefined
          : this.cache.getReusable(node, cacheKey, compiledBreaks);
      // Cache entries produced by the retired local deciders are never
      // allowed to become settled authority. Native browser wrapping is the
      // pending state; only a compiled Typst break set may force the DOM.
      if (entry?.authority !== 'compiled') entry = undefined;
      if (!entry) {
        let lines: LineLayout[] | null = null;
        let breakSignature: string | null = null;
        const auditId = `${skind.kind}@${pos}`;
        if (compiledBreaks) {
          lines = this.layoutAuthoritative(
            node,
            measure,
            atomWidth,
            { ...layoutOpts, ...extra, forced: compiledBreaks },
            auditId,
          );
          if (lines) {
            breakSignature = forcedBreakSignature(compiledBreaks);
          }
        }
        // While the exact snapshot is pending or a block cannot be matched,
        // leave it as ordinary editable DOM. Publishing an independent local
        // optimum here recreates the double-typesetter bug by definition.
        if (!lines) {
          paragraphs++;
          return;
        }
        entry = this.cache.set(node, {
          ...cacheKey,
          lines,
          authority: 'compiled',
          breakSignature,
        });
      }

      paragraphs++;
      lineCount += entry.lines.length;
      appendLineDecorations(decos, node, pos, entry.lines, (_line, at) => lineSpacers.get(at));
    };

    // Painted prefixes are DETERMINISTIC (the constants live in style.css:
    // .fn-body 0.85em/0.9em indent, .fn-num 0.72em/0.15em, .fig-num 0.32em).
    // Never measure them from the DOM: a run can land mid-update, before a
    // widget paints, and cache a zero-indent layout that never heals.
    const bodyPx = this.bodyPx();
    const prefixes = createPaintedPrefixMeasurements(settings.font, bodyPx);

    let fnNo = 0;
    const handleFootnotes = (node: PMNode, pos: number) => {
      node.forEach((child, offset) => {
        if (child.type.name !== 'footnote') return;
        fnNo++;
        if (child.content.size === 0) return;
        const fnPos = pos + 1 + offset;
        const wrap = this.view.nodeDOM(fnPos);
        const body = wrap instanceof HTMLElement ? wrap.querySelector('.fn-body') : null;
        if (!(body instanceof HTMLElement)) return;
        const bMeasure = body.clientWidth;
        if (!(bMeasure > 60)) return;
        layoutInto(
          child,
          fnPos,
          bMeasure,
          { kind: 'footnote' },
          {
            firstLineIndent: prefixes.footnoteIndent(fnNo),
            scale: prefixes.footnoteScale,
          },
        );
      });
    };

    state.doc.descendants((node, pos) => {
      // Table cells keep browser layout (narrow measures justify badly).
      if (node.type.name === 'table') return false;
      if (node.type.name === 'figure') {
        figNo++;
        if (node.content.size === 0) return false;
        const el = this.view.nodeDOM(pos);
        const cap = el instanceof HTMLElement ? el.querySelector('figcaption') : null;
        if (!(cap instanceof HTMLElement)) return false;
        const capMeasure = cap.clientWidth;
        if (!(capMeasure > 60)) return false;
        layoutInto(
          node,
          pos,
          capMeasure,
          { kind: 'caption', figNo },
          { firstLineIndent: prefixes.captionIndent(figNo) },
        );
        handleFootnotes(node, pos);
        return false;
      }
      if (!node.isTextblock) return true;
      // Only body paragraphs are justified; headings and code stay ragged.
      if (node.type.name !== 'paragraph') return false;
      if (node.content.size === 0) {
        handleFootnotes(node, pos);
        return false;
      }

      const el = this.view.nodeDOM(pos);
      if (!(el instanceof HTMLElement)) return false;
      const cs = getComputedStyle(el);
      const measure = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (!(measure > 60)) return false;

      // Classic mode: consecutive paragraphs carry a first-line indent
      // (Typst's first-line-indent default rule = CSS p + p).
      const indented = settings.parIndent && consecutiveParagraph(state.doc, pos);
      layoutInto(
        node,
        pos,
        measure,
        { kind: 'body' },
        indented ? { firstLineIndent: 1.5 * bodyPx } : {},
      );
      handleFootnotes(node, pos);
      return false;
    });

    for (const sp of blockSpacers) {
      decos.push(blockSpacerDecoration(sp));
    }

    const sig = decorationSignature(decos);
    // Page-start markers are state-only authority and are flushed separately
    // at the end of run(); they must not reinstall identical line DOM.
    if (sig === this.lastDecoSig) {
      return { paragraphs, lines: lineCount };
    }
    this.lastDecoSig = sig;
    const set = DecorationSet.create(state.doc, decos);
    const meta: TypesetMeta = { type: 'decos', decos: set };
    if (this.pendingPageMarks) {
      meta.pageMarks = this.pendingPageMarks.marks;
      meta.pageBasis = this.pendingPageMarks.basis;
      this.pendingPageMarks = null;
    }
    const tr = state.tr.setMeta(typesetKey, meta);
    tr.setMeta('addToHistory', false);
    this.lineDecorationDispatches++;
    this.view.dispatch(tr);
    return { paragraphs, lines: lineCount };
  }

  /**
   * Install page geometry only when it has explicit exact provenance.
   * A mapped basis is a temporary visual hold while the replacement compile
   * is pending; any failed validation drops straight to continuous mode.
   */
  private paginate(snapshot: PaginationGeometrySnapshot): PaginationPassResult {
    const { state } = this.view;
    const settings = snapshot.settings;
    const continuous = (reason: string, abandon = true): PaginationPassResult => {
      this.pagPath = 'continuous';
      this.pagWhy = reason;
      if (abandon) this.abandonPageBasis();
      return { spacers: [], count: 0 };
    };

    if (!effectiveFont(settings.font).exact) {
      return continuous('font has no exact Typst/browser metric contract');
    }

    let sig = this.docSig.get(state.doc);
    if (!sig) {
      try {
        sig = docToTyp(state.doc);
        this.docSig.set(state.doc, sig);
      } catch {
        return continuous('document cannot be serialized');
      }
    }

    const entry = this.oracles.page.get(sig);
    if (!entry) {
      this.oracles.page.request(sig, state.doc, settings, this.atomResolver());
    }

    const publicationBlocker = this.documentPublicationBlocker();
    const publicationReady = !publicationBlocker && this.documentPublicationReady();
    if (entry?.status === 'ok' && entry.pageStarts && publicationReady) {
      const forced = this.paginateForced(
        snapshot,
        entry.pageStarts,
        entry.pageCount ?? entry.pageStarts.length + 1,
      );
      if (!forced) {
        return continuous('fresh exact starts cannot be represented');
      }

      const basis: ExactPageBasis = {
        provenance: 'exact',
        pageCount: forced.count,
        geometryEpoch: this.paginationGeometryEpoch,
        editorWidth: this.view.dom.clientWidth,
      };
      this.pagPath = 'exact';
      this.pagWhy = 'fresh full-document Typst snapshot';
      this.pendingPageMarks = {
        basis,
        marks: DecorationSet.create(
          state.doc,
          entry.pageStarts.map((pageStart, index) =>
            Decoration.widget(pageStart.pos, () => document.createElement('span'), {
              psLine: pageStart.line,
              psUnit: pageStart.unit,
              psPage: index + 1,
              psProvenance: 'exact',
              psEpoch: basis.geometryEpoch,
            }),
          ),
        ),
      };
      return forced;
    }

    // A parsed PageOracle answer whose shared crops are still decoding is a
    // pending visual publication, not a fresh exact surface. Existing proven
    // markers may be held briefly through this state; new ones wait.
    const confidence = this.oracles.observePageEntry(publicationReady ? entry : undefined);
    const pluginState = typesetKey.getState(state);
    const basis = pluginState?.pageBasis;
    const marks = pluginState?.pageMarks.find() ?? [];
    const basisIsCurrent =
      basis?.provenance === 'exact' &&
      basis.geometryEpoch === this.paginationGeometryEpoch &&
      Math.abs(basis.editorWidth - this.view.dom.clientWidth) <= 0.5;

    // Holding is permitted only for an actually pending replacement and only
    // for markers emitted by the last exact compile. A failure is terminal for
    // this basis even if another request begins later.
    if (confidence.hold && !entry && basisIsCurrent && marks.length === basis.pageCount - 1) {
      const stale = marks
        .map((mark) => {
          const spec = mark.spec as {
            psLine?: number;
            psUnit?: string;
            psProvenance?: string;
            psEpoch?: number;
          };
          if (spec.psProvenance !== 'exact' || spec.psEpoch !== basis.geometryEpoch) return null;
          return {
            pos: mark.from,
            line: spec.psLine ?? Number.NaN,
            unit: spec.psUnit ?? '',
          };
        })
        .filter((pageStart): pageStart is { pos: number; line: number; unit: string } => pageStart !== null)
        .sort((a, b) => a.pos - b.pos);
      if (stale.length === marks.length) {
        const held = this.paginateForced(snapshot, stale, basis.pageCount, true);
        if (held) {
          this.pagPath = 'held';
          this.pagWhy = 'mapped exact starts; replacement pending';
          return held;
        }
      }
      return continuous('mapped exact starts failed validation');
    }

    return continuous(
      entry?.status === 'fail'
        ? `Typst page map unavailable: ${entry.reason ?? 'unknown failure'}`
        : publicationBlocker
          ? `${publicationBlocker}; open Proof for exact output`
        : entry?.status === 'ok' && !publicationReady
          ? 'applying exact document publication'
        : 'waiting for first exact page map',
      entry?.status === 'fail' || !!basis,
    );
  }

  /** Apply Typst's page starts verbatim (with per-unit ink offsets). */
  private paginateForced(
    snapshot: PaginationGeometrySnapshot,
    pageStarts: Array<{ pos: number; line: number; unit: string }>,
    pageCount: number,
    /** Mapped-through-edits starts (not a fresh oracle answer): bail when
     * the hold would leave an implausibly large gap. */
    stale = false,
  ): PaginationPassResult | null {
    const view = this.view;
    const s = snapshot.settings;
    const size = snapshot.size;
    const marginTop = snapshot.marginTop;
    const F = snapshot.bodyPx;
    const existing = snapshot.spacers.sorted;
    const natural = (clientTop: number, pos: number) =>
      clientTop - snapshot.stackTop - this.heightAbove(snapshot, pos);

    const spacers: Spacer[] = [];
    let shift = 0;
    let page = 0;
    for (let psi = 0; psi < pageStarts.length; psi++) {
      const ps = pageStarts[psi];
      // Defensive boundary: PageOracle normally withholds pageStarts for a
      // split native table, because editable structured content cannot accept
      // a synthetic mid-node spacer. If one arrives, keep the table atomic.
      if (ps.unit === 'table' && ps.line > 0) {
        return null;
      }
      page++;
      let pos = ps.pos;
      let y: number;
      let kind: Spacer['kind'] = 'block';
      let adjKind: 'paragraph' | 'line' | 'h1' | 'h2' | 'h3' = 'paragraph';
      if (ps.unit === 'line' && ps.line > 0) {
        const node = view.state.doc.nodeAt(ps.pos);
        const entry = node ? this.cache.get(node) : undefined;
        if (!node || !entry || ps.line >= entry.lines.length) return null;
        const base = ps.pos + 1;
        const el = view.nodeDOM(ps.pos);
        if (!(el instanceof HTMLElement)) return null;
        const lineH = parseFloat(getComputedStyle(el).lineHeight) || 24;
        const c = view.coordsAtPos(base + entry.lines[ps.line].from);
        pos = base + entry.lines[ps.line].from;
        y = natural(c.top, pos) - Math.max(0, (lineH - (c.bottom - c.top)) / 2);
        kind = 'line';
        adjKind = 'line';
      } else {
        const el = view.nodeDOM(ps.pos);
        if (!(el instanceof HTMLElement)) return null;
        y = natural(el.getBoundingClientRect().top, ps.pos);
        if (ps.unit === 'h1' || ps.unit === 'h2' || ps.unit === 'h3') adjKind = ps.unit;
        else adjKind = 'paragraph';
      }
      const adj = ps.unit === 'paragraph' || ps.unit === 'line' || ps.unit.startsWith('h')
        ? pageTopAdjustEm(s, adjKind) * F
        : 0;
      const delta = page * (size.h + PAGE_GAP) + marginTop + adj - (y + shift);
      if (stale && delta > 0) {
        // Content above SHRANK (deleted lines): holding this start would
        // manufacture empty space. Steady state recreates each existing
        // spacer at its own height, so the plausibility test is GROWTH
        // over the spacer this start had before (matched by ordinal —
        // page k's start owns the k-th spacer), not the absolute gap:
        // page gaps are routinely hundreds of px when a block moved whole.
        const lineH = F * s.lineHeight;
        const prevH = existing[page - 1]?.height ?? 0;
        if (delta - prevH > 3 * lineH + 80) return null;
      }
      if (delta > 0) {
        spacers.push({ pos, height: delta, kind });
        shift += delta;
      } else if (delta < -2) {
        // Content has outgrown this break (edits added lines above it):
        // these starts are stale — let live pagination move the break NOW.
        if (stale) this.pagWhy += ` bail@${pos}Δ${delta.toFixed(0)}`;
        return null;
      }
    }
    const count = Math.max(pageCount, page + 1);
    if (stale) {
      // Held marks must still COVER the document: content past the last
      // held start that overflows the final page needs a break no mark
      // describes — holding would break the text but paint no new sheet.
      // A small dip into the bottom margin is the designed tolerance.
      const docBottom =
        view.dom.getBoundingClientRect().bottom -
        snapshot.stackTop -
        this.heightAbove(snapshot, Infinity, true) +
        shift;
      const lastBottom = count * (size.h + PAGE_GAP) - PAGE_GAP - snapshot.marginBottom;
      if (docBottom > lastBottom + 2 * F * s.lineHeight) {
        this.pagWhy += ` bail-overflow(${(docBottom - lastBottom).toFixed(0)}px)`;
        return null;
      }
    }
    return { spacers, count };
  }

  /**
   * Position footnote bodies at the bottom of the page their marker landed
   * on (final geometry, after spacers). Presentation-only DOM styling; the
   * node views ignore these attribute mutations.
   */
  private placeFootnotes(count: number) {
    const view = this.view;
    const s = getSettings(view.state);
    const size = pageSize(s);
    const marginBottom = s.marginBottom * 96;
    const host = view.dom.parentElement ?? view.dom;
    const stackTop = host.getBoundingClientRect().top;

    const groups = new Map<number, Array<{ el: HTMLElement; height: number }>>();
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'footnote') return true;
      const dom = view.nodeDOM(pos);
      const body = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>('.fn-body') : null;
      if (body) {
        const c = view.coordsAtPos(pos, 1);
        const page = Math.min(count - 1, Math.max(0, Math.floor((c.top - stackTop) / (size.h + PAGE_GAP))));
        let list = groups.get(page);
        if (!list) groups.set(page, (list = []));
        list.push({ el: body, height: body.offsetHeight });
      }
      return false;
    });

    // The editor root's actual offset below the stack top (the page-top
    // ink adjustment shifts it away from exactly one margin).
    const pmOffset = view.dom.getBoundingClientRect().top - stackTop;
    for (const [page, list] of groups) {
      const bottomLimit = page * (size.h + PAGE_GAP) + size.h - marginBottom;
      const total = list.reduce((sum, f) => sum + f.height, 0) + FN_GAP * (list.length - 1);
      let y = bottomLimit - total - pmOffset;
      list.forEach((f, i) => {
        // Hysteresis: sub-pixel re-measurements must not nudge the body.
        const prev = parseFloat(f.el.style.top);
        if (!(Math.abs(prev - y) < 0.75)) f.el.style.top = `${y.toFixed(1)}px`;
        f.el.classList.toggle('fn-first', i === 0);
        f.el.style.visibility = 'visible';
        y += f.height + FN_GAP;
      });
    }
  }
}
