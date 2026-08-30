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
// Scheduling (spec §3.6): mapped decorations preserve the previous shape
// during the edit transaction, then an exact port-selected layout replaces
// only the affected blocks in the same task. The settled pass verifies those
// decisions against the compiled oracle and only dispatches when semantics
// differ. Pagination may add a second synchronous update in the same task,
// after measuring the exact line layout, so no intermediate state paints.
//
// Pagination model: the document stays one continuous editable flow; page
// boxes are painted behind it (see #pages in main.ts), and exact-height
// spacers push content past each page boundary. Between blocks the spacer is
// an ordinary div; inside a paragraph it is a block-in-inline div sitting at
// an oracle-chosen line break (the div itself forces the break, so it simply
// replaces the <br> widget). Print needs no JS: print CSS zeroes the spacer
// heights (line breaks survive, gaps vanish) and @page takes over.

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
import { buildSpec, type TypstOracle, type AtomResolver, type SpecKind } from './layout/typst-oracle';
import { portBreaks } from './layout/port/adapter';
import { loadPrimitives, primitives } from './layout/primitives';
import type { PageOracle, PageOracleEntry } from './layout/page-oracle';
import { getSettings, PAGE_GAP, pageSize, parseMathMacros, type DocSettings } from './settings';
import { docToTyp, escapeTyp, expandMacrosWith, pageTopAdjustEm } from './typ-serializer';
import { footnoteEntryCost, footnoteHeadReservePx, footnotePositions, lineNeeds, lineNeedSpans } from './layout/flow-rules';
import { FONT_FALLBACK } from './pdf';
import { citeOrder } from './citations';
import { eqKey } from './equations';
import { getInk, inkKey } from './math-ink';
import {
  applySplit,
  clearSplit,
  clearTableSplitCache,
  getSplit,
  onTableSplitReady,
  requestTableSplit,
  splitExtra,
  type TableSplitLayout,
} from './table-split';
import { isFlexibleAtom } from './inline-raw';
import { parseTypstSvg } from './safe-svg';
import { recordLayoutPerf } from './layout/perf';
import { COMMON_PORT_KEYS, effectiveFont, parityMetrics } from './font-registry';
import {
  appendLineDecorations,
  blockSpacerDecoration,
  decorationSetDigest,
  decorationSignature,
  decorationsOwnedByBlock,
  pageGapWidget,
  pageSpacerDecoration,
  rebuildDecorationsOwnedByBlock,
  type Spacer,
  type TypesetDecorationSpec,
} from './layout/line-decorations';
import {
  BlockLayoutCache,
  blockLayoutSettingsKey,
  blockOracleKey,
  consecutiveParagraph,
  createPaintedPrefixMeasurements,
  forcedBreakSignature,
  lineBreakSignature,
  makeAtomWidth,
  paragraphKeyTag,
  type AtomWidth,
  type BlockLayoutAuthority,
  type BlockLayoutCacheKey,
} from './layout/block-layout';
import {
  typesetKey,
  type PageInfo,
  type TypesetMeta,
  type TypesetState,
  type TypesetStats,
} from './layout/typeset-state';
import { LayoutScheduler } from './layout/layout-scheduler';
import { OracleCoordinator } from './layout/oracle-coordinator';
import {
  HeightIndex,
  createPaginationSnapshot,
  type PaginationSnapshot as HeightSnapshot,
} from './layout/pagination-snapshot';
import {
  planSuffixPagination,
  type SuffixPageMarker,
  type SuffixPageSpacer,
  type SuffixPaginationSeed,
} from './layout/pagination-suffix';
import {
  SuffixPaginationControl,
  type SuffixKillDetail,
  type SuffixPaginationMode,
} from './layout/pagination-suffix-control';
import { layoutForcedBlock } from './layout/forced-layout';
import {
  ForcedLayoutAuditor,
  type ForcedLayoutAuditReport,
} from './layout/forced-layout-audit';
import {
  diffPageStarts,
  emptyPageParityStats,
  recordParityDiff,
  type PageParityStats,
  type PageStartEntry,
} from './layout/page-parity';

export { typesetKey };
export type { PageInfo, TypesetMeta, TypesetState, TypesetStats };

/** Phase-3 flag (PORT.md): drive live typing with the ported Typst
 * breaker. Console: __usePort(false) to A/B against the legacy path;
 * __portStats() reports how often each path ran. */
let USE_PORT = true;
let portHits = 0;
let legacyHits = 0;
let adapterNulls = 0;
let partitionMisses = 0;
let forcedFastHits = 0;
let forcedFallbacks = 0;
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  const w = window as unknown as {
    __usePort: (v: boolean) => void;
    __portStats: () => { port: number; legacy: number };
    __forcedPathStats: () => { fast: number; fallback: number };
  };
  w.__usePort = (v) => {
    USE_PORT = v;
  };
  w.__portStats = () => ({ port: portHits, legacy: legacyHits, adapterNulls, partitionMisses });
  w.__forcedPathStats = () => ({ fast: forcedFastHits, fallback: forcedFallbacks });
}

/** A settled pagination whose spacer differs from the installed one by less
 * than this many px is measurement noise around a live-adjusted height, not a
 * new page decision: keep the installed height so the settle dispatch becomes
 * a signature no-op (zero spacer churn). Always compared against the freshly
 * computed absolute height, so the tolerance can never accumulate. */
const SPACER_REINSTALL_TOLERANCE_PX = 0.75;

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
  contentHeight: number;
  stackTop: number;
  bodyPx: number;
  spacers: CurrentSpacers;
  heights: HeightSnapshot;
  spacerHeights: HeightIndex;
}

type TableEffect =
  | { type: 'apply'; node: PMNode; layout: TableSplitLayout; gaps: number[]; naturalHeight: number }
  | { type: 'clear'; node: PMNode };

interface PaginationPassResult {
  spacers: Spacer[];
  count: number;
  tableEffects: TableEffect[];
}

interface PaginationFallbackSeed {
  startPos: number;
  page: number;
  shift: number;
  prefixSpacers: Spacer[];
}

interface PaginationFallbackResult extends PaginationPassResult {
  visitedUnits: number;
  anchors: Array<{ pos: number; page: number; kind: Spacer['kind'] }>;
}

interface FallbackBasisMarker {
  childIndex: number;
  /** Anchor position minus its top-level block's position (0 at the block
   * itself; positive for a boundary nested inside a list or blockquote). */
  offset: number;
  page: number;
  line: number;
  unit: string;
}

/** One planner outcome, structured enough to diagnose without a debugger:
 * why a pass was ineligible, what was installed, or where a compared pass
 * diverged. */
interface SuffixPaginationRun {
  eligible: boolean;
  /** Seed source when eligible; first ineligibility reason otherwise. */
  reason: string;
  matched: boolean | null;
  /** Zero-based physical page index of the first differing spacer. */
  mismatchPage: number | null;
  /** Height delta (suffix minus full) when the same spacer differs only in
   * height; null for structural differences (see lastDifference). */
  mismatchDelta: number | null;
}

/** Per-seed-source comparison tallies. `referenceBails` counts eligible exact
 * seeds whose live prefix re-force failed, so no comparison ran — neither a
 * match nor a mismatch, but a retention-staleness signal in its own right. */
interface SuffixSourceStats {
  eligible: number;
  compared: number;
  matches: number;
  mismatches: number;
  referenceBails: number;
}

interface SuffixPaginationStats {
  attempts: number;
  eligible: number;
  /** Suffix results installed as the live pagination (promoted path). */
  installs: number;
  /** Full fallback passes executed (ineligible installs, shadow-mode
   * references, and sampled-verification references). */
  fullRuns: number;
  /** Deferred verifications that completed a comparison. */
  sampledVerifications: number;
  /** Sampled tickets invalidated (doc/geometry moved) before the idle
   * verification could run soundly. */
  verificationsDropped: number;
  compared: number;
  matches: number;
  mismatches: number;
  fullUnits: number;
  suffixUnits: number;
  lastReason: string;
  lastDifference: string | null;
  lastStartPos: number | null;
  lastAnchorPos: number | null;
  /** Most recent installed suffix pass (cost diagnostics). */
  lastSuffixPass: { units: number; ms: number } | null;
  /** Most recent installed full pass (cost diagnostics). */
  lastFullPass: { units: number; ms: number } | null;
  /** Ineligibility-reason histogram over every attempted plan. */
  reasons: Record<string, number>;
  lastRun: SuffixPaginationRun | null;
  bySource: {
    exact: SuffixSourceStats;
    fallback: SuffixSourceStats;
  };
}

/** The DEV stats report: the mutable tallies plus the control's live state. */
interface SuffixPaginationStatsReport extends SuffixPaginationStats {
  killed: boolean;
  killDetail: SuffixKillDetail | null;
  mode: SuffixPaginationMode;
  verifyEvery: number;
}

const emptySuffixSourceStats = (): SuffixSourceStats => ({
  eligible: 0,
  compared: 0,
  matches: 0,
  mismatches: 0,
  referenceBails: 0,
});

const emptySuffixPaginationStats = (): SuffixPaginationStats => ({
  attempts: 0,
  eligible: 0,
  installs: 0,
  fullRuns: 0,
  sampledVerifications: 0,
  verificationsDropped: 0,
  compared: 0,
  matches: 0,
  mismatches: 0,
  fullUnits: 0,
  suffixUnits: 0,
  lastReason: 'not-considered',
  lastDifference: null,
  lastStartPos: null,
  lastAnchorPos: null,
  lastSuffixPass: null,
  lastFullPass: null,
  reasons: {},
  lastRun: null,
  bySource: { exact: emptySuffixSourceStats(), fallback: emptySuffixSourceStats() },
});

type PaginationSuffixPlan =
  | { kind: 'seed'; source: 'exact' | 'fallback'; seed: SuffixPaginationSeed }
  | { kind: 'none'; reason: string };

/** A sampled suffix install awaiting idle verification. Valid only while the
 * exact conditions of the install persist — the same document revision, the
 * same geometry epochs, the same width, and no later pagination pass. */
interface SuffixVerificationTicket {
  doc: PMNode;
  source: 'exact' | 'fallback';
  seed: SuffixPaginationSeed;
  result: PaginationFallbackResult;
  passId: number;
  pagEpoch: number;
  domEpoch: number;
  width: number;
}

const viewRegistry = new WeakMap<EditorView, TypesetView>();

/** Request a re-typeset without a document change (e.g. an image loaded). */
export function scheduleTypeset(view: EditorView) {
  const tv = viewRegistry.get(view);
  if (!tv) return;
  // Something painted outside the document flow (image decoded, math ink
  // arrived, preview swapped): per-element geometry caches may be stale.
  tv.invalidateDomGeometry();
  tv.requestRun();
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
      init: () => ({ decos: DecorationSet.empty, pageMarks: DecorationSet.empty }),
      apply(tr, val) {
        const meta = tr.getMeta(typesetKey) as TypesetMeta | undefined;
        if (meta?.type === 'decos') {
          return { decos: meta.decos, pageMarks: meta.pageMarks ?? val.pageMarks.map(tr.mapping, tr.doc) };
        }
        if (meta?.type === 'pageMarks') return { decos: val.decos, pageMarks: meta.pageMarks };
        if (tr.docChanged) {
          let decos = val.decos.map(tr.mapping, tr.doc);
          // A replace whose boundary coincides with a page spacer widget
          // (e.g. the table card swapping the block that ENDS at a page
          // start) silently drops the spacer, and the page below visibly
          // jumps until the settle run. Spacers are load-bearing geometry:
          // re-anchor any that mapping discarded. Mapping only discards
          // widgets inside REPLACED content, so the scan is bounded to the
          // deleted envelope — a plain insertion pays nothing, and scanning
          // the whole set on every keystroke is avoided.
          let delFrom = Infinity;
          let delTo = -Infinity;
          for (let i = 0; i < tr.steps.length; i++) {
            // Step ranges live in the doc before THAT step; express them in
            // the transaction-start doc `val.decos` is anchored to.
            const back = i ? tr.mapping.slice(0, i).invert() : null;
            tr.steps[i].getMap().forEach((oldStart, oldEnd) => {
              if (oldEnd <= oldStart) return;
              const from = back ? back.map(oldStart, -1) : oldStart;
              const to = back ? back.map(oldEnd, 1) : oldEnd;
              if (from < delFrom) delFrom = from;
              if (to > delTo) delTo = to;
            });
          }
          const isSpacer = (spec: unknown) => {
            const kind = (spec as Partial<TypesetDecorationSpec> | null)?.tsKind;
            return kind === 'line-page-gap' || kind === 'block-page-gap';
          };
          const scanFrom = Math.max(0, delFrom - 1);
          const scanTo = Math.min(tr.before.content.size, delTo + 1);
          const had = delTo >= delFrom ? val.decos.find(scanFrom, scanTo, isSpacer) : [];
          if (had.length) {
            const keptFrom = Math.max(0, tr.mapping.map(scanFrom, -1));
            const keptTo = Math.min(tr.doc.content.size, tr.mapping.map(scanTo, 1));
            const kept = new Set(
              decos.find(keptFrom, keptTo, isSpacer).map((d) => (d.spec as { key: string }).key),
            );
            const lost = had.filter((d) => !kept.has((d.spec as { key: string }).key));
            if (lost.length) {
              const revived = lost.map((d) => {
                const spec = d.spec as { key: string; h: number; hy?: boolean };
                const pos = Math.min(tr.mapping.map(d.from, -1), tr.doc.content.size);
                return Decoration.widget(pos, () => pageGapWidget(spec.h, !!spec.hy, spec.key), {
                  side: -1,
                  key: spec.key,
                  h: spec.h,
                  hy: spec.hy,
                  tsKind: spec.key.startsWith('pgb:') ? 'block-page-gap' : 'line-page-gap',
                });
              });
              decos = decos.add(tr.doc, revived);
            }
          }
          return { decos, pageMarks: val.pageMarks.map(tr.mapping, tr.doc) };
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
  private scheduler!: LayoutScheduler;
  /** Signature of the last dispatched decoration set: identical layouts are
   *  never re-dispatched, so no-op runs cause zero paints. */
  private lastDecoSig = '';
  /** Set whose digest the live pass owes `lastDecoSig`. Digesting the whole
   *  set is O(document); the keystroke path defers it here and the settled
   *  run (already O(document)) computes it only when it needs the compare. */
  private lastDecoSigSource: DecorationSet | null = null;
  private lastLiveDoc: PMNode | null = null;
  private lastPageCount = 0;
  private pendingPageMarks: DecorationSet | null = null;
  private stopTableSplitReady: (() => void) | null = null;
  /** Which source produced the last pagination (diagnostics). */
  private pagPath: 'exact' | 'held' | 'fallback' = 'exact';
  private pagLog: string[] = [];
  private pagWhy = '';
  private forcedAuditor: ForcedLayoutAuditor | null = null;
  private lineDecorationDispatches = 0;
  private pageMarkDispatches = 0;
  private paginationSnapshotStats = { captures: 0, spacerScans: 0, tableScans: 0, heightQueries: 0 };
  private suffixPaginationStats = emptySuffixPaginationStats();
  private suffixControl = new SuffixPaginationControl();
  /** PAGE-PORT.md Phase 0 (DEV only): parity telemetry between the local
   * fallback paginator's page starts and Typst's exact answer for the same
   * document revision. Never read outside `__pageParityStats`; every write
   * site is gated on `import.meta.env.DEV` so this costs nothing in
   * production. */
  private pageParityStats = emptyPageParityStats();
  /** The most recent local fallback prediction awaiting an exact answer for
   * the same doc signature (capture point (a): a fallback window). */
  private lastLocalPagePrediction: { sig: string; entries: PageStartEntry[] } | null = null;
  /** Doc signature of the last exact publication a shadow prediction ran
   * against — throttles capture point (b) to at most one shadow run per
   * settled exact publication. */
  private lastParityShadowSig: string | null = null;
  /** Monotone pagination-pass id: any later pass invalidates a pending
   * verification ticket (the installed geometry it describes is gone). */
  private paginationPassCounter = 0;
  private pendingSuffixVerification: SuffixVerificationTicket | null = null;
  private suffixVerifyScheduled = false;
  private exactPageBasisDoc: PMNode | null = null;
  private exactPageBasisEpoch = -1;
  private exactPageBasisWidth = 0;
  /** The exact publication in basis coordinates: Typst's page starts and the
   * spacer geometry installed for them. Retained across later edits and
   * fallback repaginations (the clean prefix keeps basis positions valid), so
   * an edit landing on an exactly paginated document — or on a burst that
   * began from one — seeds the suffix pass from Typst's settled page
   * starts instead of a prior local fallback snapshot. */
  private exactPageBasisMarkers: SuffixPageMarker[] = [];
  private exactPageBasisSpacers: SuffixPageSpacer[] = [];
  private fallbackPageBasisDoc: PMNode | null = null;
  private fallbackPageBasisEpoch = -1;
  private fallbackPageBasisWidth = 0;
  private fallbackPageBasisMarkers: FallbackBasisMarker[] = [];
  private paginationGeometryEpoch = 0;
  private lastPaginationWidth = 0;
  /**
   * Epoch for memoized per-element geometry reads (block measure widths,
   * line-heights, body font size). Bumped by every event that can move
   * column geometry: font arrival, settings/doc-attrs changes, asset
   * changes, external repaints (scheduleTypeset), and an observed editor
   * width change. Values served under an unchanged epoch are exactly what a
   * fresh read returned when the entry was populated.
   */
  private domGeometryEpoch = 0;
  private domGeometryWidth = -1;
  private bodyPxCache: number | null = null;
  private blockMeasureCache = new WeakMap<
    HTMLElement,
    { epoch: number; parent: Node | null; measure: number }
  >();
  private lineHeightCache = new WeakMap<
    HTMLElement,
    { epoch: number; parent: Node | null; value: number }
  >();
  private destroyed = false;

  constructor(
    private view: EditorView,
    private opts: { onStats?: (s: TypesetStats) => void; onPages?: (p: PageInfo) => void },
  ) {
    viewRegistry.set(view, this);
    this.measurer = new Measurer(view.dom);
    // The ported Typst line breaker (PORT.md): loads the sidecar WASM +
    // fonts in the background; until ready, liveRun uses the legacy path.
    loadPrimitives().then(
      () => {
        if (!this.destroyed) this.requestRun();
      },
      (e) => console.warn('sidecar primitives failed to load', e),
    );
    this.oracles = new OracleCoordinator({
      fontFallback: FONT_FALLBACK,
      onParagraphResults: () => this.requestRun(),
      onPageResults: () => this.requestRun(),
      // Paragraph compiles launch — and their results are parsed/measured —
      // only outside a typing burst. The scheduler owns the quiet-period
      // definition (EDIT_SETTLE_DELAY_MS). The scheduler is constructed a
      // few statements below; until then nothing is editing.
      isEditing: () => (this.scheduler as LayoutScheduler | undefined)?.isInEditWindow() ?? false,
    });
    this.stopTableSplitReady = onTableSplitReady((readyView) => {
      if (!this.destroyed && readyView === this.view) this.requestRun();
    });
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __oracle?: TypstOracle;
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
          tableScans: number;
          heightQueries: number;
        };
        __suffixPaginationStats?: (reset?: boolean) => SuffixPaginationStatsReport;
        __pageParityStats?: (reset?: boolean) => PageParityStats;
        __suffixPaginationControl?: (opts?: {
          mode?: SuffixPaginationMode;
          revive?: boolean;
          injectMismatch?: boolean;
        }) => {
          mode: SuffixPaginationMode;
          killed: boolean;
          killDetail: SuffixKillDetail | null;
          installs: number;
          verifyEvery: number;
        };
      };
      w.__oracle = this.oracles.paragraph;
      w.__pageOracle = this.oracles.page;
      (w as unknown as { __comparePort: () => unknown }).__comparePort = () => {
        const state = this.view.state;
        const settings = getSettings(state);
        const font = effectiveFont(settings.font);
        const resolveAtom = this.atomResolver();
        const settingsSig = blockLayoutSettingsKey(settings);
        const out: unknown[] = [];
        state.doc.descendants((node, pos) => {
          if (!node.isTextblock || node.type.name !== 'paragraph') return true;
          const el = this.view.nodeDOM(pos);
          if (!(el instanceof HTMLElement)) return false;
          const cs = getComputedStyle(el);
          const measure = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          const spec = buildSpec(node, resolveAtom);
          if (!spec) return false;
          const okey = blockOracleKey(
            settingsSig,
            paragraphKeyTag(settings, state.doc, pos),
            measure,
            spec.key,
          );
          const oentry = this.oracles.paragraph.get(okey);
          const atomWidth = makeAtomWidth(this.view, settings, pos);
          const indented = settings.parIndent && consecutiveParagraph(state.doc, pos);
          const port = portBreaks(node, measure, atomWidth, {
            fontKeys: font.portKeys,
            monoFontKey: COMMON_PORT_KEYS.mono,
            sizePt: settings.sizePt,
            hyphenate: settings.hyphenate,
            firstLineIndentPx: indented ? 1.5 * this.bodyPx() : undefined,
            atomWidthPt: this.typstAtomWidthPt(),
          });
          const fmt = (b: { at: number; hyphen: boolean }[] | null | undefined) =>
            b ? b.map((x) => (x.hyphen ? 'hy' : 'br') + x.at).join(',') : String(b);
          if (oentry?.status === 'ok' && port && fmt(oentry.breaks) !== fmt(port)) {
            out.push({ pos, text: node.textContent.slice(0, 40), oracle: fmt(oentry.breaks), port: fmt(port) });
          } else if (oentry && oentry.status !== 'ok') {
            out.push({ pos, text: node.textContent.slice(0, 40), status: oentry.status, reason: (oentry as { reason?: string }).reason?.slice(0, 200), port: fmt(port) });
          }
          return false;
        });
        return out;
      };
      (w as unknown as { __blockAuthority: (pos: number) => unknown }).__blockAuthority = (
        pos: number,
      ) => {
        const node = this.view.state.doc.nodeAt(pos);
        if (!node) return null;
        const entry = this.cache.get(node);
        return entry
          ? {
              authority: entry.authority ?? null,
              oracle: entry.oracle,
              breakSignature: entry.breakSignature ?? null,
              lines: entry.lines.length,
            }
          : null;
      };
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
          this.requestRun();
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
          this.paginationSnapshotStats = { captures: 0, spacerScans: 0, tableScans: 0, heightQueries: 0 };
        }
        return stats;
      };
      w.__suffixPaginationStats = (reset = false) => {
        const stats: SuffixPaginationStatsReport = {
          ...this.suffixPaginationStats,
          reasons: { ...this.suffixPaginationStats.reasons },
          lastRun: this.suffixPaginationStats.lastRun
            ? { ...this.suffixPaginationStats.lastRun }
            : null,
          lastSuffixPass: this.suffixPaginationStats.lastSuffixPass
            ? { ...this.suffixPaginationStats.lastSuffixPass }
            : null,
          lastFullPass: this.suffixPaginationStats.lastFullPass
            ? { ...this.suffixPaginationStats.lastFullPass }
            : null,
          bySource: {
            exact: { ...this.suffixPaginationStats.bySource.exact },
            fallback: { ...this.suffixPaginationStats.bySource.fallback },
          },
          killed: this.suffixControl.killed,
          killDetail: this.suffixControl.killDetail,
          mode: this.suffixControl.mode,
          verifyEvery: this.suffixControl.verifyEvery,
        };
        if (reset) {
          this.suffixPaginationStats = emptySuffixPaginationStats();
          // Restart the deterministic verification sample with the stats
          // window, so its first install is verified. Kill state persists.
          this.suffixControl.resetSampling();
        }
        return stats;
      };
      w.__pageParityStats = (reset = false) => {
        const stats: PageParityStats = {
          ...this.pageParityStats,
          byCause: { ...this.pageParityStats.byCause },
          skipped: { ...this.pageParityStats.skipped },
          last: this.pageParityStats.last ? { ...this.pageParityStats.last } : null,
        };
        if (reset) {
          this.pageParityStats = emptyPageParityStats();
          this.lastLocalPagePrediction = null;
          this.lastParityShadowSig = null;
        }
        return stats;
      };
      w.__suffixPaginationControl = (opts = {}) => {
        if (opts.mode) this.suffixControl.mode = opts.mode;
        if (opts.revive) this.suffixControl.revive();
        if (opts.injectMismatch) {
          // Exercise the REAL soundness path: kill, then a clean full-pass
          // takeover through the ordinary install machinery.
          this.suffixSoundnessEvent({ source: 'injected', summary: 'dev-injected mismatch' });
        }
        return {
          mode: this.suffixControl.mode,
          killed: this.suffixControl.killed,
          killDetail: this.suffixControl.killDetail,
          installs: this.suffixControl.installs,
          verifyEvery: this.suffixControl.verifyEvery,
        };
      };
    }
    this.scheduler = new LayoutScheduler(view.dom, {
      runLive: () => this.liveRun(),
      runSettled: () => this.run(),
      // Web fonts arriving change every browser metric. The Typst oracles
      // remain valid because their bundled font inputs did not change.
      invalidateMetrics: () => {
        this.paginationGeometryEpoch++;
        this.invalidateDomGeometry();
        this.clearExactPageBasis();
        this.clearFallbackPageBasis();
        this.measurer.invalidate();
        this.cache.clear();
        clearTableSplitCache();
      },
    });
  }

  /** Translate already-authoritative break offsets into browser line ranges.
   * The direct path performs no break search or syllabification; malformed or
   * unsupported input falls back to the established translator. */
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
      this.invalidateDomGeometry();
      this.clearExactPageBasis();
      this.clearFallbackPageBasis();
      this.measurer.invalidate();
      this.cache.clear();
      this.oracles.clear();
      clearTableSplitCache();
    }
    if (view.state.doc !== prevState.doc) {
      this.scheduler.scheduleLive();
      this.scheduler.scheduleAfterEdit();
    }
  }

  /** Re-typeset just the edited blocks with authoritative compiled/ported
   * breaks in the same paint as the keystroke. LayoutScheduler owns the
   * microtask. */
  private liveRun() {
    if (this.destroyed) return;
    const perfStart = performance.now();
    const state = this.view.state;
    const prev = this.lastLiveDoc;
    this.lastLiveDoc = state.doc;
    if (!prev || prev === state.doc) return;
    // The doc changed: no previously-dispatched layout may be considered
    // current, whatever path we take out of here.
    this.lastDecoSig = '';
    this.lastDecoSigSource = null;
    const start = prev.content.findDiffStart(state.doc.content);
    if (start == null) return;
    const endDiff = prev.content.findDiffEnd(state.doc.content);
    const from = Math.min(start, state.doc.content.size);
    const to = Math.min(Math.max(endDiff ? endDiff.b : start, from), state.doc.content.size);

    const settings = getSettings(state);
    const font = effectiveFont(settings.font);
    const resolveAtom = font.exact ? this.atomResolver() : null;
    const settingsSig = blockLayoutSettingsKey(settings);
    type LiveBlockKind = 'body' | 'caption' | 'footnote';
    const blocks: Array<{ node: PMNode; pos: number; kind: LiveBlockKind }> = [];
    const addBlock = (node: PMNode, pos: number, kind: LiveBlockKind) => {
      if (!blocks.some((block) => block.pos === pos && block.kind === kind)) blocks.push({ node, pos, kind });
    };
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'table') return false;
      if (node.type.name === 'paragraph') {
        addBlock(node, pos, 'body');
        return false;
      }
      if (node.type.name === 'figure') {
        addBlock(node, pos, 'caption');
        return false;
      }
      return true;
    });
    // Edits inside a footnote body: the body block is nested inline content.
    const $from = state.doc.resolve(from);
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'footnote') {
        addBlock($from.node(d), $from.before(d), 'footnote');
        break;
      }
    }
    if (!blocks.length) return;
    // One geometry read: an editor-width change no epoch event described
    // must not serve stale cached measures.
    this.syncDomGeometryWidth();

    const discoveredAt = performance.now();
    let lineLayoutMs = 0;
    const figNums = new Map<PMNode, number>();
    const fnNums = new Map<PMNode, number>();
    if (blocks.some((block) => block.kind !== 'body')) {
      let figNo = 0;
      let fnNo = 0;
      state.doc.descendants((node) => {
        if (node.type.name === 'figure') figNums.set(node, ++figNo);
        if (node.type.name === 'footnote') {
          fnNums.set(node, ++fnNo);
          return false;
        }
        return true;
      });
    }
    const prefixes = blocks.some((block) => block.kind !== 'body')
      ? createPaintedPrefixMeasurements(settings.font, this.bodyPx())
      : null;

    let decos = typesetKey.getState(state)?.decos ?? DecorationSet.empty;
    let changed = false;
    // Candidate for live page-invariant maintenance (see
    // adjustSpacerAfterLiveEdit): only an unambiguous single-body-block edit
    // qualifies; every other shape fails open to today's stale-height behavior.
    let liveAdjust: {
      pos: number;
      blockTo: number;
      el: HTMLElement;
      newLines: number;
      measure: number;
      indent: number;
      spacerInside: boolean;
    } | null = null;
    for (const b of blocks) {
      const blockTo = b.pos + b.node.nodeSize;
      // Footnote bodies are DOM-nested inside the paragraph: their break +
      // justification decorations must survive an outer-block replacement.
      const fnSpans: Array<{ from: number; to: number }> = [];
      if (b.kind !== 'footnote') {
        b.node.forEach((child, offset) => {
          if (child.type.name === 'footnote') {
            fnSpans.push({
              from: b.pos + 1 + offset,
              to: b.pos + 1 + offset + child.nodeSize,
            });
          }
        });
      }
      const scope = { from: b.pos, to: blockTo, exclude: fnSpans };
      if (b.node.content.size === 0 || (b.kind === 'body' && b.node.attrs.align)) {
        const rebuilt = rebuildDecorationsOwnedByBlock(decos, state.doc, scope, []);
        decos = rebuilt.decos;
        changed ||= rebuilt.changed;
        continue;
      }
      const number =
        b.kind === 'caption'
          ? (figNums.get(b.node) ?? 1)
          : b.kind === 'footnote'
            ? (fnNums.get(b.node) ?? 1)
            : 0;
      const extra: { firstLineIndent?: number; scale?: number } =
        b.kind === 'caption'
          ? { firstLineIndent: prefixes!.captionIndent(number) }
          : b.kind === 'footnote'
            ? { firstLineIndent: prefixes!.footnoteIndent(number), scale: prefixes!.footnoteScale }
            : settings.parIndent && consecutiveParagraph(state.doc, b.pos)
              ? { firstLineIndent: 1.5 * this.bodyPx() }
              : {};
      const keyTag =
        b.kind === 'caption'
          ? `cap${number}`
          : b.kind === 'footnote'
            ? `fn${number}`
            : paragraphKeyTag(settings, state.doc, b.pos);
      const el = this.view.nodeDOM(b.pos);
      if (!(el instanceof HTMLElement)) continue;
      const target =
        b.kind === 'caption'
          ? el.querySelector('figcaption')
          : b.kind === 'footnote'
            ? el.querySelector('.fn-body')
            : el;
      if (!(target instanceof HTMLElement)) continue;
      const measure = this.blockMeasure(target, b.kind === 'body');
      if (!(measure > 60)) continue;
      const atomWidth = makeAtomWidth(this.view, settings, b.pos);
      const spec = resolveAtom ? buildSpec(b.node, resolveAtom) : null;
      const okey = spec ? blockOracleKey(settingsSig, keyTag, measure, spec.key) : null;
      // Exact-path fast reuse only: the keystroke path never REQUESTS a
      // compile (it would launch one for nearly every intermediate paragraph
      // state). The settled pass — which only runs after the edit-settle
      // quiet period — requests the final spec instead.
      const oentry = okey ? this.oracles.paragraph.get(okey) : undefined;
      // The ported Typst breaker: full-paragraph, globally optimal, and
      // identical to what the oracle will confirm. Plain KP is the
      // degraded-mode fallback (sidecar not loaded, unmapped content).
      let lines: LineLayout[] | null = null;
      let authority: BlockLayoutAuthority = 'fallback';
      let breakSignature: string | null = null;
      const lineStart = performance.now();
      if (oentry?.status === 'ok' && oentry.breaks) {
        lines = this.layoutAuthoritative(
          b.node,
          measure,
          atomWidth,
          {
            hyphenate: settings.hyphenate,
            ...extra,
            forced: oentry.breaks,
          },
          `live@${b.pos}`,
        );
        if (lines) {
          authority = 'compiled';
          breakSignature = forcedBreakSignature(oentry.breaks);
        }
      }
      if (!lines && USE_PORT && primitives()) {
        try {
          const forced = portBreaks(b.node, measure, atomWidth, {
            fontKeys: font.portKeys,
            monoFontKey: COMMON_PORT_KEYS.mono,
            sizePt: settings.sizePt,
            hyphenate: settings.hyphenate,
            firstLineIndentPx: b.kind === 'caption' ? undefined : extra.firstLineIndent,
            prefixText: b.kind === 'caption' ? `Figure ${number}: ` : undefined,
            scale: extra.scale,
            atomWidthPt: this.typstAtomWidthPt(),
          });
          if (forced) {
            lines = this.layoutAuthoritative(
              b.node,
              measure,
              atomWidth,
              {
                hyphenate: settings.hyphenate,
                isFill: isFlexibleAtom,
                ...extra,
                forced,
              },
              `live@${b.pos}`,
            );
            if (lines) {
              portHits++;
              authority = 'port';
              breakSignature = forcedBreakSignature(forced);
            } else partitionMisses++;
          } else {
            adapterNulls++;
          }
        } catch (e) {
          if (import.meta.env.DEV) console.warn('port breaker failed, using legacy path', e);
        }
      }
      if (!lines) {
        legacyHits++;
        lines = layoutBlock(b.node, measure, this.measurer, atomWidth, {
          hyphenate: settings.hyphenate,
          isFill: isFlexibleAtom,
          ...extra,
        });
        // The fallback's KP-chosen breaks get a real signature: compiled
        // breaks that later confirm them reuse this entry (agreement is a
        // no-op on every path, never a rebuild).
        if (lines) breakSignature = lineBreakSignature(lines);
      }
      if (!lines) continue;
      this.cache.set(b.node, {
        measure,
        lines,
        oracle: oentry?.status ?? 'none',
        key: okey,
        indent: extra.firstLineIndent ?? 0,
        scale: extra.scale ?? 1,
        authority,
        breakSignature,
      });
      if (blocks.length === 1 && b.kind === 'body') {
        liveAdjust = {
          pos: b.pos,
          blockTo,
          el: target,
          newLines: lines.length,
          measure,
          indent: extra.firstLineIndent ?? 0,
          spacerInside: false, // set below once the block's spacers are known
        };
      }
      lineLayoutMs += performance.now() - lineStart;
      const base = b.pos + 1;
      // Page spacers glued to mapped text positions break lines MID-LINE
      // once the paragraph re-wraps around an edit above them. Strip them
      // here and re-emit each at the nearest freshly-chosen break (same
      // height — geometry stays stale-but-stable until repagination).
      const pgStale = decorationsOwnedByBlock(decos, scope).filter(
        (deco) => (deco.spec as Partial<TypesetDecorationSpec>).tsKind === 'line-page-gap',
      );
      if (liveAdjust && liveAdjust.pos === b.pos && pgStale.length) liveAdjust.spacerInside = true;
      let pgList = pgStale.map((d) => ({
        from: d.from,
        h: (d.spec as { h?: number }).h ?? 0,
        hy: !!(d.spec as { hy?: boolean }).hy,
      }));
      const fresh: Decoration[] = [];
      appendLineDecorations(fresh, b.node, b.pos, lines, (line, at) => {
        // A spacer whose text position falls on this line moves to the
        // line's break: pages only break at line boundaries.
        const spIdx = pgList.findIndex((sp) => sp.from > base + line.from - 1 && sp.from <= at + 2);
        if (spIdx < 0) return undefined;
        const sp = pgList[spIdx];
        pgList = pgList.filter((_, i) => i !== spIdx);
        return { pos: at, height: sp.h, kind: 'line' };
      });
      // Spacers past the last chosen break (the page split the final line,
      // which has since re-wrapped): snap to the block boundary — pages
      // only break at line boundaries, and repagination corrects at settle.
      for (const sp of pgList) {
        const at = Math.min(Math.max(sp.from, base), blockTo - 1);
        fresh.push(pageSpacerDecoration(at, sp.h, false));
      }
      const rebuilt = rebuildDecorationsOwnedByBlock(decos, state.doc, scope, fresh);
      decos = rebuilt.decos;
      changed ||= rebuilt.changed;
    }
    // The edit changed the block's height by a whole number of lines: restore
    // the page invariant NOW by resizing the next spacer, instead of letting
    // the settled pass correct a held-stale height 250ms later (the visible
    // "double-typesetter" jump). `from > pos` guarantees the pre-edit block
    // starts at the same position in the previous document.
    if (liveAdjust && !liveAdjust.spacerInside && liveAdjust.pos < from) {
      const adjusted = this.adjustSpacerAfterLiveEdit(state, prev, decos, settings, liveAdjust);
      if (adjusted) {
        decos = adjusted;
        changed = true;
      }
    }
    const decorationStart = performance.now();
    // Owed digest, not computed: enumerating every decoration is O(document)
    // and must not run on the keystroke path for an O(edit) change.
    this.lastDecoSigSource = decos;
    if (changed) {
      const tr = state.tr.setMeta(typesetKey, { type: 'decos', decos } satisfies TypesetMeta);
      tr.setMeta('addToHistory', false);
      this.lineDecorationDispatches++;
      this.view.dispatch(tr);
    }
    const perfEnd = performance.now();
    recordLayoutPerf('live', {
      totalMs: perfEnd - perfStart,
      blockDiscoveryMs: discoveredAt - perfStart,
      lineLayoutMs,
      decorationMs: perfEnd - decorationStart,
      changedBlocks: blocks.length,
    });
  }

  /**
   * Live page-invariant maintenance. For a fixed set of page starts, the
   * content between two spacers plus the FOLLOWING spacer's height is a
   * constant (they sum to one page). When a keystroke burst changes one body
   * paragraph's height by ΔH = Δlines × line-height, the spacer terminating
   * its page must shrink or grow by exactly -ΔH for the pages below to hold
   * still. Doing that here — instead of keeping the stale height and letting
   * the settled repagination move everything back — makes the settled pass a
   * confirmation (no-op) whenever the page-start set is unchanged.
   *
   * ΔH costs no new reflows: line counts come from the layout entries the
   * live pass just computed (and its predecessor cached), line-height from
   * the per-element geometry cache. Every ambiguous shape fails open to
   * today's behavior — multi-block edits, a spacer inside the edited block,
   * an unknown or differently-measured previous layout, a result outside the
   * representable spacer range. Only the provisional height changes; the
   * settled pass remains the sole authority and overwrites or confirms it,
   * whichever spacer set (exact, held, or fallback) is installed.
   */
  private adjustSpacerAfterLiveEdit(
    state: EditorState,
    prev: PMNode,
    decos: DecorationSet,
    settings: DocSettings,
    edit: {
      pos: number;
      blockTo: number;
      el: HTMLElement;
      newLines: number;
      measure: number;
      indent: number;
    },
  ): DecorationSet | null {
    // The corresponding pre-edit block: document content is identical before
    // the diff start, so the old block begins at this same position.
    if (edit.pos >= prev.content.size) return null;
    const oldNode = prev.nodeAt(edit.pos);
    if (!oldNode || oldNode.type !== state.doc.nodeAt(edit.pos)?.type) return null;
    const oldEntry = this.cache.get(oldNode);
    if (!oldEntry || oldEntry.measure !== edit.measure || oldEntry.indent !== edit.indent) return null;
    const deltaLines = edit.newLines - oldEntry.lines.length;
    if (!deltaLines) return null;
    const deltaH = deltaLines * this.blockLineHeight(edit.el);
    if (!Number.isFinite(deltaH)) return null;
    // Only the first spacer after the edited block terminates its page; the
    // invariant for every later page is untouched once this one absorbs ΔH.
    const isSpacer = (spec: unknown) => {
      const kind = (spec as Partial<TypesetDecorationSpec> | null)?.tsKind;
      return kind === 'line-page-gap' || kind === 'block-page-gap';
    };
    const following = decos.find(edit.blockTo, state.doc.content.size, isSpacer);
    if (!following.length) return null; // last page: nothing below to protect
    let next = following[0];
    for (const d of following) if (d.from < next.from) next = d;
    const spec = next.spec as Partial<TypesetDecorationSpec>;
    const oldH = spec.h ?? 0;
    const newH = oldH - deltaH;
    // A spacer spans at most a page of slack plus both margins and the
    // painted inter-page gap. Out of representable range means the
    // page-start set itself has to change — a decision that belongs to the
    // settled pass, so keep today's stale height and let it correct.
    if (!(oldH > 0) || !(newH > 0.5) || newH >= pageSize(settings).h + PAGE_GAP) return null;
    const replacement =
      spec.tsKind === 'block-page-gap'
        ? blockSpacerDecoration({ pos: next.from, height: newH, kind: 'block' })
        : pageSpacerDecoration(next.from, newH, !!spec.hy);
    return decos.remove([next]).add(state.doc, [replacement]);
  }

  destroy() {
    this.destroyed = true;
    viewRegistry.delete(this.view);
    this.scheduler.destroy();
    this.stopTableSplitReady?.();
    this.stopTableSplitReady = null;
    this.oracles.destroy();
    this.measurer.destroy();
  }

  /** Drop cached page-break decisions (asset bytes changed under same sig). */
  invalidatePages() {
    this.paginationGeometryEpoch++;
    this.invalidateDomGeometry();
    this.clearExactPageBasis();
    this.clearFallbackPageBasis();
    this.oracles.clearPage();
    clearTableSplitCache();
  }

  requestRun() {
    this.scheduler?.scheduleSettled();
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
      // lineMap/blocks retain the requested value so a held or suffix pass
      // can recreate the same decoration. The geometry index alone consumes
      // physical height because it is undoing physical DOM displacement.
      const painted = spec.key ? paintedHeights.get(spec.key) : undefined;
      sorted.push({ pos: d.from, height: painted ?? h });
    }
    sorted.sort((a, b) => a.pos - b.pos);
    return { lineMap, blocks, sorted };
  }

  /** Applied table-split extras (internal page gaps + repeated headers) as
   *  pseudo-spacer entries at each table's END — merged with the widget
   *  spacers when converting measured DOM geometry back to natural, so a
   *  split table reads as its continuous height to everything below it. */
  private tableExtras(): Array<{ pos: number; height: number }> {
    const out: Array<{ pos: number; height: number }> = [];
    this.view.state.doc.forEach((node, offset) => {
      if (node.type.name !== 'table') return;
      const a = getSplit(node);
      if (a) out.push({ pos: offset + node.nodeSize, height: splitExtra(a) });
    });
    return out;
  }

  /** Capture the complete height model once, after pass-one line decorations
   * have been installed. Every exact/held/fallback candidate in this run
   * reads this same immutable prefix index. */
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
    const tableExtras = this.tableExtras();
    const heights = createPaginationSnapshot({ spacers: spacers.sorted, tableExtras });
    this.paginationSnapshotStats.captures++;
    this.paginationSnapshotStats.spacerScans++;
    this.paginationSnapshotStats.tableScans++;
    return {
      settings,
      size,
      marginTop,
      marginBottom,
      contentHeight: size.h - marginTop - marginBottom,
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

  /** Table assignments are staged while candidates are evaluated. A failed
   * exact or held attempt must not contaminate the fallback that follows. */
  private applyTableEffects(effects: readonly TableEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'clear') clearSplit(effect.node);
      else applySplit(effect.node, effect.layout, effect.gaps, effect.naturalHeight);
    }
  }

  private suffixSpacers(snapshot: PaginationGeometrySnapshot): SuffixPageSpacer[] {
    return [...snapshot.spacers.lineMap.values(), ...snapshot.spacers.blocks]
      .map((spacer) => ({ ...spacer }))
      .sort((a, b) => a.pos - b.pos);
  }

  private fallbackSuffixMarkers(doc: PMNode): SuffixPageMarker[] {
    const positions: number[] = [];
    doc.forEach((_node, pos) => positions.push(pos));
    return this.fallbackPageBasisMarkers.map((marker) => ({
      pos:
        positions[marker.childIndex] !== undefined
          ? positions[marker.childIndex] + marker.offset
          : Number.NaN,
      line: marker.line,
      unit: marker.unit,
      page: marker.page,
    }));
  }

  private planPaginationSuffix(snapshot: PaginationGeometrySnapshot): PaginationSuffixPlan {
    // Session policy first: a tripped kill-switch (first verified mismatch)
    // or the forced-full measurement mode runs every pass full.
    const inactive = this.suffixControl.inactiveReason();
    if (inactive) return { kind: 'none', reason: inactive };
    const currentDoc = this.view.state.doc;
    let exactReason: string | null = null;

    // The exact basis outlives the 'exact' spacer authority: the settled
    // state of a healthy document is exact pagination, and the first edit of
    // a burst hands authority to the fallback engine without moving any page
    // start above the edit. Markers and spacers are the retained install-time
    // copies (basis coordinates — valid current positions across the clean
    // prefix), not the currently painted spacers, which belong to whichever
    // full fallback pass ran last.
    if (
      this.exactPageBasisDoc &&
      Math.abs(this.exactPageBasisWidth - this.view.dom.clientWidth) <= 0.5
    ) {
      const decision = planSuffixPagination({
        basisDoc: this.exactPageBasisDoc,
        currentDoc,
        markers: this.exactPageBasisMarkers,
        spacers: this.exactPageBasisSpacers,
        basisEpoch: this.exactPageBasisEpoch,
        currentEpoch: this.paginationGeometryEpoch,
      });
      if (decision.kind === 'seed') return { kind: 'seed', source: 'exact', seed: decision.seed };
      if (decision.kind === 'none') return { kind: 'none', reason: 'exact-unchanged' };
      exactReason = `exact-${decision.reason}`;
    }

    // The fallback basis: page starts the local engine itself installed last
    // time. Seeding from it holds local-rule output constant above the edit,
    // which the full local pass regenerates identically — so installing the
    // seeded suffix is indistinguishable from re-running the full pass.
    if (
      this.fallbackPageBasisDoc &&
      Math.abs(this.fallbackPageBasisWidth - this.view.dom.clientWidth) <= 0.5
    ) {
      const decision = planSuffixPagination({
        basisDoc: this.fallbackPageBasisDoc,
        currentDoc,
        markers: this.fallbackSuffixMarkers(currentDoc),
        spacers: this.suffixSpacers(snapshot),
        basisEpoch: this.fallbackPageBasisEpoch,
        currentEpoch: this.paginationGeometryEpoch,
      });
      if (decision.kind === 'seed') {
        return { kind: 'seed', source: 'fallback', seed: decision.seed };
      }
      return {
        kind: 'none',
        reason: decision.kind === 'none' ? 'fallback-unchanged' : `fallback-${decision.reason}`,
      };
    }

    return {
      kind: 'none',
      reason: exactReason ?? (this.exactPageBasisDoc ? 'exact-width-changed' : 'no-page-basis'),
    };
  }

  private rememberFallbackBasis(result: PaginationFallbackResult): void {
    const doc = this.view.state.doc;
    const markers: FallbackBasisMarker[] = [];
    for (const anchor of result.anchors) {
      if (anchor.pos < 0 || anchor.pos > doc.content.size) {
        markers.length = 0;
        break;
      }
      const $pos = doc.resolve(anchor.pos);
      const childIndex = $pos.index(0);
      const topPos = $pos.depth === 0 ? anchor.pos : $pos.before(1);
      if (anchor.kind === 'block') {
        // Block page starts sit at a block boundary: top-level, or a child
        // boundary inside a container (list item, blockquote child).
        const after = $pos.nodeAfter;
        if (!after || after.isInline) {
          markers.length = 0;
          break;
        }
        markers.push({
          childIndex,
          offset: anchor.pos - topPos,
          page: anchor.page,
          line: 0,
          unit: after.type.name,
        });
        continue;
      }
      // Line page starts live inside a textblock (possibly nested in a list
      // item or blockquote); the stored position is the textblock's own
      // boundary, plus the oracle line index of the split.
      if ($pos.depth === 0 || !$pos.parent.isTextblock) {
        markers.length = 0;
        break;
      }
      const textblock = $pos.parent;
      const textblockStart = $pos.start($pos.depth);
      const entry = this.cache.get(textblock);
      const line = entry?.lines.findIndex((_item, index) => {
        if (index === 0) return false;
        return textblockStart + entry.lines[index].from === anchor.pos;
      }) ?? -1;
      if (line < 1) {
        markers.length = 0;
        break;
      }
      markers.push({
        childIndex,
        offset: textblockStart - 1 - topPos,
        page: anchor.page,
        line,
        unit: 'line',
      });
    }
    this.fallbackPageBasisDoc = doc;
    this.fallbackPageBasisEpoch = this.paginationGeometryEpoch;
    this.fallbackPageBasisWidth = this.view.dom.clientWidth;
    this.fallbackPageBasisMarkers = markers;
  }

  /** Invalidate the retained exact basis. Called only for events that truly
   * invalidate Typst's settled page starts (geometry epoch bumps: metrics,
   * settings, assets) — never merely because a fallback pass ran: an edit
   * below the seed boundary leaves every retained start above it valid, and
   * structural damage above the boundary is detected per-attempt by the
   * planner's clean-prefix diff. A newer exact publication overwrites it. */
  private clearExactPageBasis(): void {
    this.exactPageBasisDoc = null;
    this.exactPageBasisEpoch = -1;
    this.exactPageBasisWidth = 0;
    this.exactPageBasisMarkers = [];
    this.exactPageBasisSpacers = [];
  }

  private clearFallbackPageBasis(): void {
    this.fallbackPageBasisDoc = null;
    this.fallbackPageBasisEpoch = -1;
    this.fallbackPageBasisWidth = 0;
    this.fallbackPageBasisMarkers = [];
  }

  /** Compare a reference and a seeded suffix pass. `page` is the zero-based
   * physical page index at the first differing spacer (spacer i starts page
   * i + 1); `delta` is the suffix-minus-full height difference when the same
   * spacer differs only in height. The summary is capped for stats storage. */
  private fallbackResultDifference(
    a: PaginationFallbackResult,
    b: PaginationFallbackResult,
  ): { summary: string; page: number | null; delta: number | null } | null {
    if (a.tableEffects.length || b.tableEffects.length) {
      return {
        summary: `table-effects ${a.tableEffects.length}/${b.tableEffects.length}`,
        page: null,
        delta: null,
      };
    }
    const spacerCount = Math.max(a.spacers.length, b.spacers.length);
    const differences: string[] = [];
    let firstPage: number | null = null;
    let firstDelta: number | null = null;
    for (let index = 0; index < spacerCount; index++) {
      const spacer = a.spacers[index];
      const other = b.spacers[index];
      const equal = (
        spacer &&
        other &&
        spacer.pos === other.pos &&
        spacer.kind === other.kind &&
        spacer.height.toFixed(2) === other.height.toFixed(2) &&
        Math.abs(spacer.height - other.height) < 0.005
      );
      if (equal) continue;
      if (firstPage === null) {
        firstPage = index + 1;
        firstDelta =
          spacer && other && spacer.pos === other.pos && spacer.kind === other.kind
            ? other.height - spacer.height
            : null;
      }
      if (differences.length < 5) {
        const format = (s?: Spacer) => (s ? `${s.kind}@${s.pos}:${s.height.toFixed(4)}` : 'none');
        differences.push(`${index}:${format(spacer)}!=${format(other)}`);
      }
    }
    if (a.count !== b.count) {
      return {
        summary: `page-count ${a.count} != ${b.count}; ${differences.join('; ')}`.slice(0, 400),
        page: firstPage ?? Math.min(a.count, b.count),
        delta: firstDelta,
      };
    }
    if (!differences.length) return null;
    return { summary: differences.join('; ').slice(0, 400), page: firstPage, delta: firstDelta };
  }

  /** Drop memoized per-element geometry reads (see domGeometryEpoch). */
  invalidateDomGeometry(): void {
    this.domGeometryEpoch++;
    this.bodyPxCache = null;
  }

  /** Detect a column-width change the epoch events did not describe (editor
   * resized between passes). One clientWidth read per layout pass. */
  private syncDomGeometryWidth(): void {
    const width = this.view.dom.clientWidth;
    if (Math.abs(width - this.domGeometryWidth) > 0.5) {
      this.domGeometryWidth = width;
      this.invalidateDomGeometry();
    }
  }

  /**
   * A textblock's measure. A block's width only changes with page geometry
   * (settings, fonts, editor width), never with typing inside it, so the
   * keystroke path reuses the last fresh read under an unchanged geometry
   * epoch and an unchanged parent (re-wrapping into e.g. a blockquote moves
   * the element). The settled pass reads fresh and repopulates the entry.
   */
  private blockMeasure(target: HTMLElement, padded: boolean, fresh = false): number {
    const cached = this.blockMeasureCache.get(target);
    if (
      !fresh &&
      cached &&
      cached.epoch === this.domGeometryEpoch &&
      cached.parent === target.parentNode
    ) {
      return cached.measure;
    }
    let measure: number;
    if (padded) {
      const cs = getComputedStyle(target);
      measure = target.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    } else {
      measure = target.clientWidth;
    }
    this.blockMeasureCache.set(target, {
      epoch: this.domGeometryEpoch,
      parent: target.parentNode,
      measure,
    });
    return measure;
  }

  /** A block's computed line-height in px, memoized per element + epoch
   * (line-height only moves with settings/fonts, both epoch events). */
  private blockLineHeight(el: HTMLElement): number {
    const cached = this.lineHeightCache.get(el);
    if (cached && cached.epoch === this.domGeometryEpoch && cached.parent === el.parentNode) {
      return cached.value;
    }
    const value = parseFloat(getComputedStyle(el).lineHeight) || 24;
    this.lineHeightCache.set(el, { epoch: this.domGeometryEpoch, parent: el.parentNode, value });
    return value;
  }

  /** Font size in px (body em). Memoized per geometry epoch; the settled
   * pass re-reads it fresh once per run. */
  private bodyPx(): number {
    return (this.bodyPxCache ??= parseFloat(getComputedStyle(this.view.dom).fontSize) || 16.67);
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
    this.lastLiveDoc = this.view.state.doc;

    const t0 = performance.now();
    // The settled pass re-reads global geometry fresh once; its per-block
    // fresh reads below repopulate the per-element caches for the next
    // keystroke burst.
    this.syncDomGeometryWidth();
    this.bodyPxCache = null;
    this.applyTopAdjust();

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
      // A computed spacer that matches an installed one (same position and
      // kind, height within the sub-pixel tolerance) keeps the installed
      // height: the live pass already maintained the page invariant, and
      // reinstalling for noise would churn widget DOM without moving pixels.
      // When everything matches, the dispatch below becomes a signature no-op.
      const effective = spacers.map((sp) => {
        const installed =
          sp.kind === 'line' ? held.lineMap.get(sp.pos) : held.blocks.find((b) => b.pos === sp.pos);
        return installed && Math.abs(installed.height - sp.height) < SPACER_REINSTALL_TOLERANCE_PX
          ? { ...sp, height: installed.height }
          : sp;
      });
      const lineSpacers = new Map<number, Spacer>();
      const blockSpacers: Spacer[] = [];
      for (const sp of effective) (sp.kind === 'line' ? lineSpacers.set(sp.pos, sp) : blockSpacers.push(sp));
      const secondLineStart = performance.now();
      this.dispatchDecos(lineSpacers, blockSpacers);
      lineLayoutMs += performance.now() - secondLineStart;
    }

    // Single-page runs skip the second dispatch — flush pending markers.
    if (this.pendingPageMarks) {
      const set = this.pendingPageMarks;
      this.pendingPageMarks = null;
      const tr = this.view.state.tr.setMeta(typesetKey, { type: 'pageMarks', pageMarks: set } satisfies TypesetMeta);
      tr.setMeta('addToHistory', false);
      this.pageMarkDispatches++;
      this.view.dispatch(tr);
    }

    const footnoteStart = performance.now();
    this.placeFootnotes(count);
    const footnoteMs = performance.now() - footnoteStart;

    const s = getSettings(this.view.state);
    const size = pageSize(s);
    this.opts.onPages?.({
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
    // A sampled suffix install verifies against its reference pass at idle,
    // after this result has painted — never blocking the install itself.
    this.scheduleSuffixVerification();
  }

  /** Low-priority deferral: after the installing frame paints, then a
   * macrotask. The scheduler has no idle queue of its own; this preserves
   * its contract (a verification never delays a live or settled run — any
   * such run simply invalidates the ticket first). */
  private scheduleSuffixVerification(): void {
    if (!this.pendingSuffixVerification || this.suffixVerifyScheduled) return;
    this.suffixVerifyScheduled = true;
    requestAnimationFrame(() => {
      setTimeout(() => {
        this.suffixVerifyScheduled = false;
        const ticket = this.pendingSuffixVerification;
        this.pendingSuffixVerification = null;
        if (ticket && !this.destroyed) this.runSuffixVerification(ticket);
      }, 0);
    });
  }

  /**
   * Sampled soundness check for an installed suffix result. The ticket is
   * honored only while the install's exact conditions persist — the same
   * document revision, geometry epochs, and width, and no later pagination
   * pass — because the reference must measure the same natural geometry the
   * suffix measured. The reference is source-appropriate: a fallback seed's
   * prefix is local-rule output the unseeded full pass regenerates
   * identically, while an exact seed's prefix was decided by Typst, so the
   * reference re-forces those breaks and runs the same seeded suffix below
   * them (comparing against the plain full pass would measure
   * prefix-authority differences, not suffix-runner bugs).
   */
  private runSuffixVerification(ticket: SuffixVerificationTicket): void {
    const stats = this.suffixPaginationStats;
    if (
      this.view.state.doc !== ticket.doc ||
      this.paginationPassCounter !== ticket.passId ||
      this.paginationGeometryEpoch !== ticket.pagEpoch ||
      this.domGeometryEpoch !== ticket.domEpoch ||
      Math.abs(this.view.dom.clientWidth - ticket.width) > 0.5
    ) {
      stats.verificationsDropped++;
      return;
    }
    const snapshot = this.capturePaginationSnapshot();
    const runFallback = (seed?: PaginationFallbackSeed) => this.runFallbackPass(snapshot, seed);
    const sourceStats = stats.bySource[ticket.source];
    let reference: PaginationFallbackResult | null;
    if (ticket.source === 'exact') {
      reference = this.exactSuffixReference(snapshot, ticket.seed, runFallback);
    } else {
      reference = runFallback();
      stats.fullRuns++;
      stats.fullUnits += reference.visitedUnits;
    }
    if (!reference) {
      // The retained exact geometry no longer re-forces cleanly: the
      // installed result's premise is stale. Not a runner mismatch — the
      // kill-switch stays untripped — but the display can no longer be
      // trusted either: drop both bases and repaginate full immediately.
      sourceStats.referenceBails++;
      stats.reasons['exact-reference-bail'] = (stats.reasons['exact-reference-bail'] ?? 0) + 1;
      stats.lastReason = 'exact-reference-bail';
      stats.lastDifference = null;
      stats.lastRun = {
        eligible: true,
        reason: 'exact-reference-bail',
        matched: null,
        mismatchPage: null,
        mismatchDelta: null,
      };
      this.clearExactPageBasis();
      this.clearFallbackPageBasis();
      this.run();
      return;
    }
    stats.sampledVerifications++;
    stats.compared++;
    sourceStats.compared++;
    const difference = this.fallbackResultDifference(reference, ticket.result);
    if (difference === null) {
      stats.matches++;
      sourceStats.matches++;
      stats.lastDifference = null;
      stats.lastReason = `verified-${ticket.source}`;
      stats.lastRun = {
        eligible: true,
        reason: `verified-${ticket.source}`,
        matched: true,
        mismatchPage: null,
        mismatchDelta: null,
      };
      return;
    }
    this.suffixSoundnessEvent(
      { source: ticket.source, summary: difference.summary },
      difference,
    );
  }

  /**
   * A verified mismatch (or a dev-injected one): correctness beats
   * stability. Trip the kill-switch — every later pass runs full for the
   * session — and repaginate full NOW so the corrected pages install
   * through the ordinary machinery, correcting visibly if they differ.
   */
  private suffixSoundnessEvent(
    detail: SuffixKillDetail,
    difference?: { summary: string; page: number | null; delta: number | null },
  ): void {
    const stats = this.suffixPaginationStats;
    stats.mismatches++;
    if (detail.source === 'exact' || detail.source === 'fallback') {
      stats.bySource[detail.source].mismatches++;
    }
    stats.lastReason = `mismatch-${detail.source}`;
    stats.lastDifference = detail.summary;
    stats.lastRun = {
      eligible: true,
      reason: `mismatch-${detail.source}`,
      matched: false,
      mismatchPage: difference?.page ?? null,
      mismatchDelta: difference?.delta ?? null,
    };
    this.suffixControl.recordMismatch(detail);
    this.pendingSuffixVerification = null;
    if (!this.destroyed) this.run();
  }

  /**
   * The oracle probe needs each inline atom rendered exactly as the PDF
   * will render it (same glyphs, same widths): citations as their painted
   * "[n]", references as "(1)", footnote markers as superscripts.
   */
  /** Typst-true inline atom widths in pt via the sidecar (footnote markers
   * at the font's OS/2 superscript scale, citations/refs as shaped text).
   * Returns null for atoms whose DOM width is already Typst's (math ink). */
  private typstAtomWidthPt(): (offset: number, child: PMNode) => number | null {
    const prim = primitives();
    if (!prim) return () => null;
    const state = this.view.state;
    const s = getSettings(state);
    const font = effectiveFont(s.font);
    const regularKey = font.portKeys.regular;
    let order: Map<string, number> | null = null;
    let labels: Map<string, string> | null = null;
    let fnNums: WeakMap<PMNode, number> | null = null;
    const upem = prim.upem(regularKey);
    const shapeW = (text: string, sizePt: number) => {
      let em = 0;
      for (const g of prim.shape(regularKey, text)) em += g.xAdvance / upem;
      return em * sizePt;
    };
    return (_offset, child) => {
      switch (child.type.name) {
        case 'citation': {
          order ??= citeOrder(state.doc);
          return shapeW('[' + (order.get(child.attrs.key as string) ?? '?') + ']', s.sizePt);
        }
        case 'eq_ref': {
          labels ??= eqKey.getState(state)?.labels ?? new Map<string, string>();
          return shapeW((labels.get(child.attrs.label as string) as string) ?? '(?)', s.sizePt);
        }
        case 'footnote': {
          if (!fnNums) {
            fnNums = new WeakMap();
            let fn = 0;
            state.doc.descendants((n) => {
              if (n.type.name === 'footnote') {
                fnNums!.set(n, ++fn);
                return false;
              }
              return true;
            });
          }
          const n = fnNums.get(child) ?? 1;
          const sup = prim.superscriptHeight(regularKey) || 0.6;
          return shapeW(String(n), sup * s.sizePt);
        }
        default:
          return null;
      }
    };
  }

  private atomResolver(): AtomResolver {
    const state = this.view.state;
    const labels = eqKey.getState(state)?.labels ?? new Map<string, string>();
    const settings = getSettings(state);
    const macros = parseMathMacros(settings.mathMacros);
    // The compiled document renders a formula as concrete glyph text
    // ("Π𝐴,𝐵,𝐶") that the oracle's line matcher must recognize. The math
    // ink cache holds Typst's own SVG for each formula — its text layer IS
    // that rendering. Absent ink (still compiling) falls back to the
    // unknown-atom heuristic.
    const inkText = (src: string): string | undefined => {
      const ink = getInk(inkKey(src, false, settings));
      if (!ink) return undefined;
      const div = parseTypstSvg(ink.svg);
      const text = [...div.querySelectorAll('.tsel')]
        .map((t) => t.textContent ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      return text || undefined;
    };
    // Citation order and footnote numbering are whole-document walks; a
    // live pass over an atom-free paragraph must not pay for them, so both
    // resolve lazily on the first atom that needs them.
    let order: Map<string, number> | null = null;
    let fnNums: Map<PMNode, number> | null = null;
    const footnoteNums = () => {
      if (!fnNums) {
        fnNums = new Map<PMNode, number>();
        let fn = 0;
        state.doc.descendants((n) => {
          if (n.type.name === 'footnote') {
            fnNums!.set(n, ++fn);
            return false;
          }
          return true;
        });
      }
      return fnNums;
    };
    return (child) => {
      switch (child.type.name) {
        case 'math_inline':
          return {
            markup: '#mi(`' + expandMacrosWith(child.attrs.src as string, macros) + '`)',
            text: inkText(child.attrs.src as string),
          };
        // Raw Typst passes through verbatim — it IS Typst markup. Its
        // printed text is unknown (usually none: rules, spacers), so the
        // matcher treats it as an unknown atom.
        //
        // A FLEXIBLE atom is unrepresentable: it prints no text and eats
        // the rest of the line, and the matcher reads that empty tail as a
        // second line — which then "fills" to the full measure. Returning
        // null drops the paragraph to the local breaker (which models fr
        // exactly), the documented fallback for content the spec can't
        // express. These lines are form blanks, not justified prose.
        case 'typst_inline':
          return isFlexibleAtom(child) ? null : { markup: child.attrs.src as string };
        case 'citation': {
          order ??= citeOrder(state.doc);
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
          // the compiled page's bottom, out of the line flow). Typst drops a
          // source space immediately before the mark rather than rendering
          // it — the mark glues to whatever precedes it even when the
          // document itself has a real space there.
          const n = footnoteNums().get(child) ?? 1;
          return { markup: `#counter(footnote).update(${n - 1});#footnote[.]`, text: String(n), glueLeft: true };
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
    const settingsSig = blockLayoutSettingsKey(settings);
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
      keyTag: string,
    ) => {
      // Aligned paragraphs keep browser layout (CSS text-align centers or
      // right-sets each ragged line) — display lines, not justified prose.
      if (node.type.name === 'paragraph' && node.attrs.align) return;
      const atomWidth = makeAtomWidth(this.view, settings, pos);

      // Ask the Typst oracle for this block's authoritative breaks.
      const spec = resolveAtom ? buildSpec(node, resolveAtom) : null;
      const okey = spec ? blockOracleKey(settingsSig, keyTag, measure, spec.key) : null;
      const oentry = okey ? this.oracles.paragraph.get(okey) : undefined;
      if (spec && okey && !oentry) {
        const indented = skind.kind === 'body' && !!extra.firstLineIndent;
        // The block identity lets a newer spec for the same block supersede
        // an older in-flight or queued compile (positions shifting between
        // passes only cost a wasted-compile worst case, never correctness).
        this.oracles.paragraph.request(okey, spec, measure, settings, skind, indented, `${skind.kind}@${pos}`);
      }
      const ostatus = oentry?.status ?? 'none';

      const indent = extra.firstLineIndent ?? 0;
      const scale = extra.scale ?? 1;
      const cacheKey: BlockLayoutCacheKey = { measure, oracle: ostatus, key: okey, indent, scale };
      const compiledBreaks = oentry?.status === 'ok' ? oentry.breaks : undefined;
      let entry =
        oentry?.status === 'ok' && !oentry.breaks
          ? undefined
          : this.cache.getReusable(node, cacheKey, compiledBreaks);
      if (!entry) {
        let lines: LineLayout[] | null = null;
        let authority: BlockLayoutAuthority = 'fallback';
        let breakSignature: string | null = null;
        const auditId = `${skind.kind}@${pos}`;
        if (oentry?.status === 'ok' && oentry.breaks) {
          lines = this.layoutAuthoritative(
            node,
            measure,
            atomWidth,
            { ...layoutOpts, ...extra, forced: oentry.breaks },
            auditId,
          );
          if (lines) {
            authority = 'compiled';
            breakSignature = forcedBreakSignature(oentry.breaks);
          }
        }
        // The ported Typst breaker stands in wherever the compiled oracle
        // has no answer (pending, failed to match, or its breaks don't
        // partition) — the port IS the same algorithm, computed locally.
        if (!lines && USE_PORT && primitives()) {
          try {
            const forced = portBreaks(node, measure, atomWidth, {
              fontKeys: font.portKeys,
              monoFontKey: COMMON_PORT_KEYS.mono,
              sizePt: settings.sizePt,
              hyphenate: settings.hyphenate,
              // Captions: the prefix is real text in Typst (proven exact by
              // the context differ); footnotes keep the indent model.
              firstLineIndentPx: skind.kind === 'caption' ? undefined : extra.firstLineIndent,
              prefixText: skind.kind === 'caption' ? `Figure ${skind.figNo}: ` : undefined,
              scale: extra.scale,
              atomWidthPt: this.typstAtomWidthPt(),
            });
            if (forced) {
              lines = this.layoutAuthoritative(
                node,
                measure,
                atomWidth,
                { ...layoutOpts, ...extra, forced },
                auditId,
              );
              if (lines) {
                authority = 'port';
                breakSignature = forcedBreakSignature(forced);
              }
            }
          } catch (e) {
            if (import.meta.env.DEV) console.warn('port breaker (settle) failed', e);
          }
        }
        if (!lines) {
          lines = layoutBlock(node, measure, this.measurer, atomWidth, { ...layoutOpts, ...extra })!;
          // Fallback breaks carry their semantic signature so identical
          // compiled breaks arriving later reuse this entry unchanged.
          breakSignature = lineBreakSignature(lines);
        }
        entry = this.cache.set(node, {
          ...cacheKey,
          lines,
          authority,
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
        const bMeasure = this.blockMeasure(body, false, true);
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
          `fn${fnNo}`,
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
        const capMeasure = this.blockMeasure(cap, false, true);
        if (!(capMeasure > 60)) return false;
        layoutInto(
          node,
          pos,
          capMeasure,
          { kind: 'caption', figNo },
          { firstLineIndent: prefixes.captionIndent(figNo) },
          `cap${figNo}`,
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
      const measure = this.blockMeasure(el, true, true);
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
        indented ? 'pi' : 'p',
      );
      handleFootnotes(node, pos);
      return false;
    });

    for (const sp of blockSpacers) {
      decos.push(blockSpacerDecoration(sp));
    }

    const sig = decorationSignature(decos);
    // Settle the digest the live pass deferred (only positions the live pass
    // itself dispatched can still be current — any later edit cleared this).
    if (this.lastDecoSigSource) {
      this.lastDecoSig = decorationSetDigest(this.lastDecoSigSource);
      this.lastDecoSigSource = null;
    }
    // Page-start markers are state-only authority and are flushed separately
    // at the end of run(); they must not reinstall identical line DOM.
    if (sig === this.lastDecoSig) {
      return { paragraphs, lines: lineCount };
    }
    this.lastDecoSig = sig;
    const set = DecorationSet.create(state.doc, decos);
    const meta: TypesetMeta = { type: 'decos', decos: set };
    if (this.pendingPageMarks) {
      meta.pageMarks = this.pendingPageMarks;
      this.pendingPageMarks = null;
    }
    const tr = state.tr.setMeta(typesetKey, meta);
    tr.setMeta('addToHistory', false);
    this.lineDecorationDispatches++;
    this.view.dispatch(tr);
    return { paragraphs, lines: lineCount };
  }

  /** PAGE-PORT.md Phase 0 (DEV only): normalize a local fallback pass's
   * `anchors` (`{pos, page, kind}`, `kind` only distinguishing `line` from
   * `block`) into the oracle's own `{pos, line, unit}` vocabulary, so a
   * local prediction and an exact answer can be diffed apples-to-apples.
   * A `line`-kind anchor's `pos` is already the resolved absolute position
   * of the line start (unlike the oracle's, which is the enclosing
   * paragraph's position plus a line index) — recovered here by resolving
   * the enclosing paragraph (which may be nested inside a list item or
   * blockquote, not necessarily a top-level block) and searching its cached
   * line layout, mirroring what `paginateForced` does in the opposite
   * direction. */
  private anchorsToPageStartEntries(
    anchors: Array<{ pos: number; page: number; kind: Spacer['kind'] }>,
  ): PageStartEntry[] {
    const doc = this.view.state.doc;
    return anchors.map((a): PageStartEntry => {
      if (a.kind === 'block') {
        const node = doc.nodeAt(a.pos);
        let unit = 'block';
        if (node?.type.name === 'heading') {
          unit = `h${Math.min(3, (node.attrs.level as number) || 1)}`;
        } else if (node?.type.name === 'table') {
          unit = 'table';
        } else if (node?.type.name === 'paragraph') {
          unit = 'paragraph';
        }
        return { pos: a.pos, line: 0, unit };
      }
      // kind === 'line': recover the enclosing paragraph's position and the
      // line index within its cached layout.
      try {
        const $pos = doc.resolve(a.pos);
        let paraPos: number | null = null;
        let node: PMNode | null = null;
        for (let d = $pos.depth; d >= 0; d--) {
          if ($pos.node(d).type.name === 'paragraph') {
            paraPos = $pos.before(d);
            node = $pos.node(d);
            break;
          }
        }
        if (paraPos === null || !node) return { pos: a.pos, line: 0, unit: 'line' };
        const entry = this.cache.get(node);
        if (!entry) return { pos: paraPos, line: 0, unit: 'line' };
        const base = paraPos + 1;
        const line = entry.lines.findIndex((l) => base + l.from === a.pos);
        return { pos: paraPos, line: line >= 0 ? line : 0, unit: 'line' };
      } catch {
        return { pos: a.pos, line: 0, unit: 'line' };
      }
    });
  }

  /** PAGE-PORT.md Phase 0 (DEV only), capture point (a): remember the local
   * fallback pass's page starts for the document revision it ran against, so
   * that if an exact answer for the SAME revision later arrives, it can be
   * diffed against what the local paginator predicted while Typst was still
   * compiling. A no-op outside DEV and whenever the document has no oracle
   * signature yet (nothing will ever arrive to compare against). */
  private recordLocalPagePrediction(
    anchors: Array<{ pos: number; page: number; kind: Spacer['kind'] }>,
  ): void {
    if (!import.meta.env.DEV) return;
    const sig = this.docSig.get(this.view.state.doc);
    if (!sig) return;
    this.lastLocalPagePrediction = { sig, entries: this.anchorsToPageStartEntries(anchors) };
  }

  /** PAGE-PORT.md Phase 0 (DEV only): fold one local-vs-exact page-start
   * comparison into `pageParityStats`, given entries already normalized to
   * the oracle's `{pos, line, unit}` vocabulary. */
  private recordPageParity(local: PageStartEntry[], exact: PageStartEntry[]): void {
    const diff = diffPageStarts(local, exact, { doc: this.view.state.doc });
    recordParityDiff(this.pageParityStats, diff);
  }

  /** PAGE-PORT.md Phase 0 (DEV only): called whenever a fresh Typst exact
   * page answer just installed for `sig`. Drives both telemetry capture
   * points:
   *  (a) fallback windows — if a local fallback prediction was captured for
   *      this same revision while the oracle was still compiling, diff it
   *      against the now-arrived exact answer.
   *  (b) predict-always shadow — on a healthy document the exact path
   *      installs directly and the local paginator never runs, so run it
   *      once per settled exact publication as a PREDICTION-ONLY pass
   *      purely to feed the same telemetry. Never installs its result: no
   *      spacers, dispatch, or table-split side effects reach the document.
   *      Skipped (and counted) for documents containing tables — a table
   *      crossing a page boundary would call `requestTableSplit`, which
   *      caches and kicks off a real compile — and for documents over ~50
   *      pages, to bound the cost of a shadow full pass. */
  private observeExactPageAnswer(
    sig: string,
    snapshot: PaginationGeometrySnapshot,
    entry: PageOracleEntry,
  ): void {
    if (!entry.pageStarts) return;
    const exactEntries: PageStartEntry[] = entry.pageStarts.map((ps) => ({
      pos: ps.pos,
      line: ps.line,
      unit: ps.unit,
    }));

    if (this.lastLocalPagePrediction && this.lastLocalPagePrediction.sig === sig) {
      this.recordPageParity(this.lastLocalPagePrediction.entries, exactEntries);
      this.lastLocalPagePrediction = null;
    }

    if (this.lastParityShadowSig === sig) return;
    this.lastParityShadowSig = sig;
    const pageCount = entry.pageCount ?? entry.pageStarts.length + 1;
    if (pageCount > 50) {
      this.pageParityStats.skipped.tooLarge++;
      return;
    }
    // A table may sit nested inside a list item or blockquote, not just at
    // the top level — descendants() is the only check that finds those too.
    let hasTable = false;
    this.view.state.doc.descendants((node) => {
      if (hasTable) return false;
      if (node.type.name === 'table') {
        hasTable = true;
        return false;
      }
      return true;
    });
    if (hasTable) {
      this.pageParityStats.skipped.tables++;
      return;
    }
    // Prediction-only: the return value is diffed and discarded. Verified
    // side-effect-free for a table-free document — see runFallbackPass's
    // tableCase, the only branch that reaches outside its own locals.
    const shadow = this.runFallbackPass(snapshot);
    this.recordPageParity(this.anchorsToPageStartEntries(shadow.anchors), exactEntries);
  }

  /**
   * Walk the naturally-laid-out document and decide where pages break.
   * Paragraphs split at oracle line boundaries; lists and blockquotes break
   * between children; everything else moves to the next page whole. Footnote
   * bodies reserve space at the bottom of the page their marker lands on, so
   * a unit fits only if unit + its footnotes fit above the footnote area.
   */
  private paginate(snapshot: PaginationGeometrySnapshot): { spacers: Spacer[]; count: number } {
    // Any pagination pass supersedes the geometry a pending verification
    // ticket describes; the stale ticket is dropped at verification time.
    this.paginationPassCounter++;
    const view = this.view;
    const s = snapshot.settings;
    if (snapshot.contentHeight < 120) return { spacers: [], count: 1 };

    // Page-break oracle: when Typst has told us where its pages break for
    // exactly this document, obey; otherwise paginate ourselves and ask.
    if (effectiveFont(s.font).exact) {
      let sig = this.docSig.get(view.state.doc);
      if (!sig) {
        try {
          sig = docToTyp(view.state.doc);
          this.docSig.set(view.state.doc, sig);
        } catch {
          sig = undefined;
        }
      }
      if (sig) {
        const entry = this.oracles.page.get(sig);
        if (!entry) this.oracles.page.request(sig, view.state.doc, s, this.atomResolver());
        if (entry?.status === 'ok' && entry.pageStarts) {
          const forced = this.paginateForced(
            snapshot,
            entry.pageStarts,
            entry.pageCount ?? entry.pageStarts.length + 1,
          );
          if (forced) {
            this.pagPath = 'exact';
            this.pagWhy = 'entry=exact';
            // Persist the starts as mapped markers for the next edit burst.
            this.lastPageCount = entry.pageCount ?? entry.pageStarts.length + 1;
            this.exactPageBasisDoc = view.state.doc;
            this.exactPageBasisEpoch = this.paginationGeometryEpoch;
            this.exactPageBasisWidth = view.dom.clientWidth;
            // Basis-coordinate copies for the suffix planner: page
            // ordinals are the contiguous marker indices, and the spacers are
            // the exact requested heights (not the painted, tolerance-held
            // ones), so a later re-force reproduces them bit-for-bit.
            this.exactPageBasisMarkers = entry.pageStarts.map((ps, index) => ({
              pos: ps.pos,
              line: ps.line,
              unit: ps.unit,
              page: index + 1,
            }));
            this.exactPageBasisSpacers = forced.spacers.map((sp) => ({ ...sp }));
            this.clearFallbackPageBasis();
            this.pendingPageMarks = DecorationSet.create(
              view.state.doc,
              entry.pageStarts.map((ps) =>
                Decoration.widget(ps.pos, () => document.createElement('span'), {
                  psLine: ps.line,
                  psUnit: ps.unit,
                }),
              ),
            );
            this.applyTableEffects(forced.tableEffects);
            if (import.meta.env.DEV) this.observeExactPageAnswer(sig, snapshot, entry);
            return { spacers: forced.spacers, count: forced.count };
          }
        }
        // Oracle still compiling for this revision: reuse the LAST starts,
        // mapped through the edits — pages hold still instead of falling
        // back to a local guess that disagrees by a line. Only while
        // PENDING: a failed match must not hold stale geometry forever.
        const confidence = this.oracles.observePageEntry(entry);
        const marks = confidence.hold
          ? (typesetKey.getState(view.state)?.pageMarks.find() ?? [])
          : [];
        this.pagWhy = `entry=${confidence.status} marks=${marks.length}` +
          (entry?.status === 'fail' ? ` streak=${confidence.failureStreak}` : '');
        if (marks.length) {
          const stale = marks
            .map((m) => ({
              pos: m.from,
              line: (m.spec as { psLine: number }).psLine,
              unit: (m.spec as { psUnit: string }).psUnit,
            }))
            .sort((a, b) => a.pos - b.pos);
          const forced = this.paginateForced(
            snapshot,
            stale,
            this.lastPageCount || stale.length + 1,
            true,
          );
          if (forced) {
            this.pagPath = 'held';
            this.applyTableEffects(forced.tableEffects);
            return { spacers: forced.spacers, count: forced.count };
          }
        }
      }
    }

    this.pagPath = 'fallback';
    // The exact-font branch rewrites pagWhy every pass; when it was skipped
    // (non-exact font, or an unserializable doc) reset the stale value so
    // the suffix-install annotation below cannot accumulate across passes.
    if (!effectiveFont(s.font).exact || !this.docSig.get(view.state.doc)) {
      this.pagWhy = 'entry=local';
    }
    const runFallback = (seed?: PaginationFallbackSeed) => this.runFallbackPass(snapshot, seed);

    this.suffixPaginationStats.attempts++;
    const suffixPlan = this.planPaginationSuffix(snapshot);
    if (suffixPlan.kind === 'seed') {
      const sourceStats = this.suffixPaginationStats.bySource[suffixPlan.source];
      this.suffixPaginationStats.eligible++;
      sourceStats.eligible++;
      this.suffixPaginationStats.lastStartPos = suffixPlan.seed.dirtyPos;
      this.suffixPaginationStats.lastAnchorPos = suffixPlan.seed.startPos;
      const suffixStart = performance.now();
      const suffix = runFallback({
        startPos: suffixPlan.seed.startPos,
        page: suffixPlan.seed.page,
        shift: suffixPlan.seed.shift,
        prefixSpacers: suffixPlan.seed.prefixSpacers.map((spacer) => ({ ...spacer })),
      });
      const suffixMs = performance.now() - suffixStart;
      this.suffixPaginationStats.suffixUnits += suffix.visitedUnits;

      if (this.suffixControl.installsSuffix) {
        // PROMOTED PATH: the suffix result IS the fallback pagination. It is
        // returned through the identical install machinery the full pass
        // uses (reinstall tolerance, dispatch, snapshot capture, footnotes),
        // and no full pass runs. Soundness rests on the shadow soaks'
        // 120/120 record plus the sampled verification below; the first
        // verified mismatch kills the suffix paginator for the session.
        this.suffixPaginationStats.installs++;
        this.suffixPaginationStats.lastSuffixPass = { units: suffix.visitedUnits, ms: suffixMs };
        this.suffixPaginationStats.lastReason = `installed-${suffixPlan.source}`;
        this.suffixPaginationStats.lastRun = {
          eligible: true,
          reason: `installed-${suffixPlan.source}`,
          matched: null,
          mismatchPage: null,
          mismatchDelta: null,
        };
        this.pagWhy += ` suffix=${suffixPlan.source}@${suffixPlan.seed.startPos} units=${suffix.visitedUnits}`;
        if (this.suffixControl.recordInstall()) {
          // Deterministic sample: stash a ticket for the idle verification
          // (scheduled by run() after this result has painted). The clone
          // freezes the installed answer against later reads.
          this.pendingSuffixVerification = {
            doc: this.view.state.doc,
            source: suffixPlan.source,
            seed: suffixPlan.seed,
            result: {
              spacers: suffix.spacers.map((spacer) => ({ ...spacer })),
              count: suffix.count,
              tableEffects: [],
              visitedUnits: suffix.visitedUnits,
              anchors: [],
            },
            passId: this.paginationPassCounter,
            pagEpoch: this.paginationGeometryEpoch,
            domEpoch: this.domGeometryEpoch,
            width: this.view.dom.clientWidth,
          };
        } else if (this.pendingSuffixVerification?.doc === this.view.state.doc) {
          // A re-settle of the same document reinstalled identical geometry
          // (same basis, same seed): keep the earlier sampled ticket alive
          // for its idle verification instead of orphaning it.
          this.pendingSuffixVerification.passId = this.paginationPassCounter;
        }
        // The next fallback basis is the installed pagination: the seed's
        // prefix pages (one anchor per preserved gap) plus the recomputed
        // suffix anchors. An eligible seed guarantees one gap per prefix
        // page, so the reconstruction is exact.
        const installedAnchors = [
          ...suffixPlan.seed.prefixSpacers.map((spacer, index) => ({
            pos: spacer.pos,
            page: index + 1,
            kind: spacer.kind,
          })),
          ...suffix.anchors,
        ];
        this.rememberFallbackBasis({ ...suffix, anchors: installedAnchors });
        // Eligibility excludes tables, so there are no table effects to
        // stage; apply defensively to keep the contract with the full path.
        this.applyTableEffects(suffix.tableEffects);
        if (import.meta.env.DEV) this.recordLocalPagePrediction(installedAnchors);
        return { spacers: suffix.spacers, count: suffix.count };
      }

      // DEV shadow-soak mode: the full pass runs and is installed; the
      // suffix result is compared always and affects telemetry only.
      const fullStart = performance.now();
      const full = runFallback();
      const fullMs = performance.now() - fullStart;
      this.suffixPaginationStats.fullRuns++;
      this.suffixPaginationStats.fullUnits += full.visitedUnits;
      this.suffixPaginationStats.lastFullPass = { units: full.visitedUnits, ms: fullMs };
      // The comparison reference must hold the same prefix constant as the
      // seed. A fallback seed's prefix IS local-rule output, so the
      // unseeded full pass regenerates it identically and doubles as the
      // reference. An exact seed's prefix was decided by TYPST — the local
      // full pass legitimately disagrees above the boundary, so comparing
      // against it would measure prefix-authority differences, not runner
      // bugs. Instead the reference re-forces the exact prefix breaks onto
      // the live document and runs the same seeded suffix below them.
      const reference =
        suffixPlan.source === 'exact'
          ? this.exactSuffixReference(snapshot, suffixPlan.seed, runFallback)
          : full;
      if (reference) {
        this.suffixPaginationStats.compared++;
        sourceStats.compared++;
        const difference = this.fallbackResultDifference(reference, suffix);
        const matches = difference === null;
        this.suffixPaginationStats.lastDifference = difference?.summary ?? null;
        if (matches) {
          this.suffixPaginationStats.matches++;
          sourceStats.matches++;
          this.suffixPaginationStats.lastReason = `matched-${suffixPlan.source}`;
        } else {
          this.suffixPaginationStats.mismatches++;
          sourceStats.mismatches++;
          this.suffixPaginationStats.lastReason = `mismatch-${suffixPlan.source}`;
        }
        this.suffixPaginationStats.lastRun = {
          eligible: true,
          reason: suffixPlan.source,
          matched: matches,
          mismatchPage: difference?.page ?? null,
          mismatchDelta: difference?.delta ?? null,
        };
      } else {
        // The retained exact geometry no longer re-forces cleanly (a prefix
        // block's live measure drifted, or a gap collapsed): the seed's
        // premise is stale. Tallied separately — it gates retention quality,
        // not runner correctness.
        sourceStats.referenceBails++;
        this.suffixPaginationStats.reasons['exact-reference-bail'] =
          (this.suffixPaginationStats.reasons['exact-reference-bail'] ?? 0) + 1;
        this.suffixPaginationStats.lastReason = 'exact-reference-bail';
        this.suffixPaginationStats.lastDifference = null;
        this.suffixPaginationStats.lastRun = {
          eligible: true,
          reason: 'exact-reference-bail',
          matched: null,
          mismatchPage: null,
          mismatchDelta: null,
        };
      }
      this.rememberFallbackBasis(full);
      // In shadow mode the full result is always installed; a mismatch can
      // affect telemetry, never page geometry. The exact basis is NOT
      // cleared: page starts above the seed boundary stay valid across
      // fallback repaginations of the suffix.
      this.applyTableEffects(full.tableEffects);
      if (import.meta.env.DEV) this.recordLocalPagePrediction(full.anchors);
      return { spacers: full.spacers, count: full.count };
    }

    const fullStart = performance.now();
    const fallback = runFallback();
    const fullMs = performance.now() - fullStart;
    this.suffixPaginationStats.fullRuns++;
    this.suffixPaginationStats.fullUnits += fallback.visitedUnits;
    this.suffixPaginationStats.lastFullPass = { units: fallback.visitedUnits, ms: fullMs };
    this.suffixPaginationStats.reasons[suffixPlan.reason] =
      (this.suffixPaginationStats.reasons[suffixPlan.reason] ?? 0) + 1;
    // An unchanged-document re-settle (oracle results arriving, images
    // decoding) reinstalls identical geometry, so a pending verification
    // ticket's premises still hold: keep it alive rather than letting the
    // pass counter orphan the sample before its idle slot arrives.
    if (
      this.pendingSuffixVerification &&
      suffixPlan.reason.endsWith('-unchanged') &&
      this.pendingSuffixVerification.doc === this.view.state.doc
    ) {
      this.pendingSuffixVerification.passId = this.paginationPassCounter;
    }
    this.suffixPaginationStats.lastRun = {
      eligible: false,
      reason: suffixPlan.reason,
      matched: null,
      mismatchPage: null,
      mismatchDelta: null,
    };
    if (!suffixPlan.reason.endsWith('-unchanged') || this.suffixPaginationStats.compared === 0) {
      this.suffixPaginationStats.lastReason = suffixPlan.reason;
      this.suffixPaginationStats.lastDifference = null;
      this.suffixPaginationStats.lastStartPos = null;
      this.suffixPaginationStats.lastAnchorPos = null;
    }
    this.rememberFallbackBasis(fallback);
    this.applyTableEffects(fallback.tableEffects);
    if (import.meta.env.DEV) this.recordLocalPagePrediction(fallback.anchors);
    return { spacers: fallback.spacers, count: fallback.count };
  }

  /** One local fallback pagination pass over the naturally-laid-out
   * document. With a seed, pagination restarts at the seed's top-level
   * boundary with its prefix pages held constant; without one, it walks
   * the whole document. Deterministic for a given snapshot + DOM instant:
   * a seeded pass and a full pass measuring the same DOM agree exactly
   * below the seed boundary. */
  private runFallbackPass(
    snapshot: PaginationGeometrySnapshot,
    seed?: PaginationFallbackSeed,
  ): PaginationFallbackResult {
    const view = this.view;
    const s = snapshot.settings;
    const size = snapshot.size;
    const marginTop = snapshot.marginTop;
    const marginBottom = snapshot.marginBottom;
    const contentH = snapshot.contentHeight;
    // Origin: the stack top. view.dom (.ProseMirror) sits inside #editor's
    // page-margin padding, so anchor to its parent, whose top is the top of
    // the first painted page.
    // Measurements run with the current spacers still in the DOM: convert
    // to NATURAL (continuous) geometry by subtracting the spacers above —
    // and the internal extras of any applied table splits.
    const stackY = (clientTop: number, pos: number) =>
      clientTop - snapshot.stackTop - this.heightAbove(snapshot, pos);

    // The same body font-size source used everywhere else in the paginator;
    // needed below too, for the footnote ledger's em-derived gap/clearance.
    const F = snapshot.bodyPx;

    // Footnote bodies, in document order, consumed as units are placed.
    const fnList: Array<{ pos: number; height: number }> = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'footnote') return true;
      const dom = view.nodeDOM(pos);
      const body = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>('.fn-body') : null;
      fnList.push({ pos, height: body ? body.offsetHeight : 0 });
      return false;
    });
    let fnIdx = 0;
    // A seed restarts at a top-level page start: every block before it has
    // been fully placed, so its footnotes belong to earlier pages — exactly
    // the state the full pass reaches when it consumes footnotes per placed
    // unit and resets the page reservation at the seed's break.
    if (seed) {
      while (fnIdx < fnList.length && fnList[fnIdx].pos < seed.startPos) fnIdx++;
    }
    // Per-entry ledger term (gap + height, Typst's `push_footnote`): a peek
    // doesn't commit fnIdx, a take does — both charge the identical
    // per-entry cost, so the fit test can never diverge from what's
    // actually consumed.
    const peekFnH = (endPos: number) => {
      let h = 0;
      for (let j = fnIdx; j < fnList.length && fnList[j].pos < endPos; j++) h += footnoteEntryCost(fnList[j].height, F);
      return h;
    };
    const takeFnH = (endPos: number) => {
      let h = 0;
      while (fnIdx < fnList.length && fnList[fnIdx].pos < endPos) {
        h += footnoteEntryCost(fnList[fnIdx].height, F);
        fnIdx++;
      }
      return h;
    };

    const spacers: Spacer[] = seed ? seed.prefixSpacers.map((spacer) => ({ ...spacer })) : [];
    const tableEffects: TableEffect[] = [];
    const anchors: Array<{ pos: number; page: number; kind: Spacer['kind'] }> = [];
    let shift = seed?.shift ?? 0;
    let page = seed?.page ?? 0;
    let pageFnH = 0;
    let visitedUnits = 0;
    // pageFnH (+ any peeked extraFnH) is the running sum of per-entry costs
    // (footnoteEntryCost) for every footnote consumed so far on this page;
    // the once-per-page clearance+separator head reservation is added on
    // top exactly when that running sum is nonzero — the same decomposition
    // `footnoteAreaHeight` uses, so this and `placeFootnotes` can't drift.
    const bottomFor = (extraFnH: number) => {
      const total = pageFnH + extraFnH;
      return page * (size.h + PAGE_GAP) + size.h - marginBottom - (total > 0 ? total + footnoteHeadReservePx(F) : 0);
    };
    // The same page-top ink adjustment paginateForced applies: fallback
    // pagination must land units at identical offsets, or an oracle miss
    // visibly shifts the whole page rhythm by the adjustment.
    const adjFor = (pos: number, kind: Spacer['kind']): number => {
      if (kind === 'line') return pageTopAdjustEm(s, 'line') * F;
      const n = view.state.doc.nodeAt(pos);
      if (n?.type.name === 'paragraph') return pageTopAdjustEm(s, 'paragraph') * F;
      if (n?.type.name === 'heading') {
        const lv = Math.min(3, (n.attrs.level as number) || 1);
        return pageTopAdjustEm(s, `h${lv}` as 'h1' | 'h2' | 'h3') * F;
      }
      return 0;
    };
    const breakBefore = (pos: number, y: number, kind: Spacer['kind']) => {
      const delta = (page + 1) * (size.h + PAGE_GAP) + marginTop + adjFor(pos, kind) - (y + shift);
      page++;
      anchors.push({ pos, page, kind });
      pageFnH = 0;
      if (delta > 0) {
        spacers.push({ pos, height: delta, kind });
        shift += delta;
      }
    };

    const rectOf = (pos: number): DOMRect | null => {
      const el = view.nodeDOM(pos);
      return el instanceof HTMLElement ? el.getBoundingClientRect() : null;
    };

    // Sticky anchor: a heading immediately above the current block — a break
    // at the block's start must carry the heading along (Typst headings are
    // sticky by default; the oracle already does this, the fallback must too).
    let sticky: { pos: number; y: number } | null = null;
    // A seeded pass must enter its first block with the same sticky state
    // the full pass has there: replay the heading/reset updates the skipped
    // prefix would have applied (only a heading run directly above the seed
    // boundary survives them).
    if (seed) {
      view.state.doc.forEach((node, offset) => {
        if (offset >= seed.startPos) return;
        if (node.type.name === 'heading') {
          const hr = rectOf(offset);
          sticky = sticky ?? (hr ? { pos: offset, y: stackY(hr.top, offset) } : null);
        } else {
          sticky = null;
        }
      });
    }
    const breakStart = (pos: number, y: number) => {
      const a = sticky ?? { pos, y };
      breakBefore(a.pos, a.y, 'block');
    };

    /** `owner` is the enclosing list item, when this block is the first
     *  thing inside one: moving the block whole must move the bullet too. */
    const atomic = (pos: number, node: PMNode, owner?: { pos: number; y: number }) => {
      const endPos = pos + node.nodeSize;
      const r = rectOf(pos);
      if (!r || r.height === 0) {
        pageFnH += takeFnH(endPos);
        return;
      }
      const y = stackY(r.top, pos);
      const ufH = takeFnH(endPos);
      if (y + shift + r.height > bottomFor(ufH) + 0.5 && r.height <= contentH) {
        breakStart(owner?.pos ?? pos, owner?.y ?? y);
      }
      pageFnH += ufH;
    };

    const paragraph = (pos: number, node: PMNode, owner?: { pos: number; y: number }) => {
      const endPos = pos + node.nodeSize;
      const r = rectOf(pos);
      if (!r) {
        pageFnH += takeFnH(endPos);
        return;
      }
      const yTop = stackY(r.top, pos);
      // Whole-paragraph fast path: fits together with its footnotes.
      if (yTop + shift + r.height <= bottomFor(peekFnH(endPos)) + 0.5) {
        pageFnH += takeFnH(endPos);
        return;
      }
      const entry = this.cache.get(node);
      if (!entry || entry.lines.length < 2) return atomic(pos, node, owner);

      const el = view.nodeDOM(pos) as HTMLElement;
      const lineH = this.blockLineHeight(el);
      const base = pos + 1;
      const lineTops = entry.lines.map((line) => {
        const c = view.coordsAtPos(base + line.from);
        // coordsAtPos returns the caret box; back off half-leading to
        // approximate the line-box top.
        return { pos: base + line.from, y: stackY(c.top, base + line.from) - Math.max(0, (lineH - (c.bottom - c.top)) / 2) };
      });

      const n = lineTops.length;
      // Widow/orphan "need" (src/layout/flow-rules.ts, ported from Typst's
      // Collector::lines). Typst lays out every line of one paragraph at
      // the same font/size, so every line's own frame height is the SAME
      // calibrated constant the exporter tells Typst to use for this body
      // text (`m.extent` — typ-serializer.ts's parityRules), and `leading`
      // is the matching `#set par(leading: ...)` value: both in the same px
      // unit as the fit-test geometry below, so `need` composes with it
      // exactly.
      const m = parityMetrics(s.font);
      const extentPx = m.extent * F;
      const leadingPx = Math.max(0, (s.lineHeight - m.extent) * F);
      const heights = new Array<number>(n).fill(extentPx);
      const isEmptyLine = (i: number) => entry.lines[i].to <= entry.lines[i].from;
      const needs = lineNeeds(heights, leadingPx, { isEmpty: isEmptyLine });
      // The last line covered by needs[i]'s pairing (i itself when line i
      // participates in no pairing) — lets the post-insertion recheck below
      // peek footnotes across a protected pair's whole span, not just line
      // k's own line (see the stage 2 comment further down).
      const spans = lineNeedSpans(n, { isEmpty: isEmptyLine });

      // Index of the first line on the current page (the orphan need only
      // ever applies at the paragraph's absolute start; the widow need
      // still applies to the final pair on a later continuation page — both
      // fall out of indexing `needs[]` by absolute line index, unchanged).
      let segStart = 0;
      for (let k = 0; k < n; k++) {
        const y = lineTops[k].y;
        const lineEnd = k + 1 < n ? base + entry.lines[k + 1].from : endPos;
        const spanEnd = spans[k] + 1 < n ? base + entry.lines[spans[k] + 1].from : endPos;
        // Typst's own decision is two separate checks, not one (distribute.rs:226-248):
        //
        // Stage 1 (pre-insertion) runs BEFORE this line's footnotes are
        // reserved at all — only entries already consumed earlier on this
        // page count. If the line (or its need span) doesn't fit even
        // ignoring its own notes, that's decisive: relocate or give up.
        //
        // Stage 2 (post-insertion) only runs once stage 1 passes. It
        // mirrors the relayout Typst performs after inserting the frame's
        // footnote entries into the region (compose.rs:165-216): now the
        // line's own notes are reserved too, and the check reruns. If it
        // still fails, Typst has already inserted those entries into this
        // region (compose.rs:511/681/424 record them as skips so they
        // don't repeat) — they stay behind on this page even though the
        // line(s) they annotate migrate to a fresh one, provided that fresh
        // page's RAW height (never insertion-reduced: regions.rs:133-138)
        // can hold the need. `takeFnH(spanEnd)` below claims the whole
        // span's entries up front, matching that trace: whichever of the
        // pair reaches stage 2's strand branch first drags the partner's
        // notes down with it, so the partner's own turn through this loop
        // finds nothing left to peek or take.
        //
        // `traveled`/`stranded` bound each line to at most one relocation
        // of each kind — a granted relocation always lands on a page
        // already verified to fit, so this can never loop.
        let traveled = false;
        let stranded = false;
        loop: for (;;) {
          // STAGE 1 — pre-insertion: reservation only from footnotes
          // already on the page (pageFnH), none from this line yet.
          const bottomPre = bottomFor(0);
          const ownPre = y + shift + heights[k] <= bottomPre + 0.5;
          const needPre = y + shift + needs[k] <= bottomPre + 0.5;
          if (!ownPre || !needPre) {
            // Whichever quantity actually failed decides whether a fresh
            // page would help: own height failing means the line itself
            // needs a clean start; need failing (while own height fits)
            // means it's the protected partner that doesn't fit here.
            const trigger = ownPre ? needs[k] : heights[k];
            if (traveled || stranded || trigger > contentH + 0.5) {
              // Already relocated once (of either kind), or even an empty
              // fresh page can't satisfy this (oversize): give up
              // relocating and let it overflow, consuming its own notes.
              pageFnH += takeFnH(lineEnd);
              break loop;
            }
            traveled = true;
            if (k === 0 && segStart === 0) {
              // The paragraph's absolute start doesn't fit (alone, or with
              // the orphan-protected partner it needs): the whole
              // paragraph moves to the next page, sticky heading and all.
              breakStart(owner?.pos ?? pos, owner?.y ?? yTop);
            } else {
              // Break exactly before line k: this defers it — and, when
              // `need` covers a partner beyond k (the widow pair), that
              // partner too — to a fresh page. No retroactive pull-back to
              // k-1 is needed: `need` already grouped the pair before
              // either line's placement was decided.
              breakBefore(lineTops[k].pos, lineTops[k].y, 'line');
              segStart = k;
            }
            continue loop;
          }
          // STAGE 2 — post-insertion recheck: the relayout Typst performs
          // once this need span's entries are inserted into the region.
          const bottomPost = bottomFor(peekFnH(spanEnd));
          const ownPost = y + shift + heights[k] <= bottomPost + 0.5;
          const needPost = y + shift + needs[k] <= bottomPost + 0.5;
          if (ownPost && needPost) {
            // Place; own notes (the partner's too, once reached) are
            // consumed.
            pageFnH += takeFnH(lineEnd);
            break loop;
          }
          const triggerPost = ownPost ? needs[k] : heights[k];
          if (stranded || (ownPost && triggerPost > contentH + 0.5)) {
            // The need can never fit any raw page (Typst places the line,
            // splitting the pair — distribute.rs:237-245's condition goes
            // false and falls through to frame()), or this line already
            // stranded once: place here, consuming its own notes.
            pageFnH += takeFnH(lineEnd);
            break loop;
          }
          // Typst strands the span's entries on THIS page (they were
          // inserted; the region finishes with those insertions as skips)
          // and migrates the line(s) to a fresh, raw next page:
          // ownPost failing finishes unconditionally (may_progress,
          // distribute.rs:229); needPost failing (own height still fits)
          // requires the raw next page to fit the need, already checked
          // via triggerPost above.
          stranded = true;
          pageFnH += takeFnH(spanEnd); // before the break — breakBefore resets pageFnH
          if (k === 0 && segStart === 0) {
            // A strand at the paragraph's absolute start is still a region
            // finish: Typst's sticky restore migrates a heading run sitting
            // directly above along with the paragraph (the entries stay).
            breakStart(owner?.pos ?? pos, owner?.y ?? yTop);
          } else {
            breakBefore(lineTops[k].pos, lineTops[k].y, 'line');
            segStart = k;
          }
          continue loop;
        }
      }
    };

    // Tables: Typst decides. A table crossing the page bottom is handed to
    // the paged mini-compile (table-split.ts), which reproduces the real
    // document's constraints — Typst answers with the same split rows,
    // repeated headers, or a whole-block push it would use in the PDF. The
    // node view renders the answer; page math advances per fragment.
    const tableCase = (pos: number, node: PMNode) => {
      const endPos = pos + node.nodeSize;
      const r = rectOf(pos);
      if (!r || r.height === 0) {
        pageFnH += takeFnH(endPos);
        return;
      }
      const assigned = getSplit(node);
      const naturalH = assigned ? assigned.naturalPx : r.height;
      const y = stackY(r.top, pos);
      const ufH = takeFnH(endPos);
      if (y + shift + naturalH <= bottomFor(ufH) + 0.5) {
        if (assigned) tableEffects.push({ type: 'clear', node });
        pageFnH += ufH;
        return;
      }
      const pageTopAbs = page * (size.h + PAGE_GAP) + marginTop;
      const offsetPt = Math.max(0, (y + shift - pageTopAbs) * 0.75);
      const fresh = requestTableSplit(view, node, view.dom.clientWidth || 576, contentH * 0.75, offsetPt);
      // While the compile is in flight, hold the current rendering steady
      // (stale split, or the plain atomic push) — the answer triggers a
      // repagination.
      const layout: TableSplitLayout | null = fresh ?? assigned?.layout ?? null;
      if (!layout) {
        if (naturalH <= contentH) breakStart(pos, y);
        pageFnH += ufH;
        return;
      }
      if (layout.pushed) breakStart(pos, y);
      if (layout.fragments.length <= 1) {
        // Whole on one page (unbreakable figure, or it fits after the push).
        tableEffects.push({ type: 'clear', node });
        if (!layout.pushed && naturalH <= contentH) breakStart(pos, y);
        pageFnH += ufH;
        return;
      }
      const gaps: number[] = [];
      let bottomAbs = y + shift + layout.fragments[0].heightPx;
      for (let i = 1; i < layout.fragments.length; i++) {
        page++;
        pageFnH = 0;
        const top = page * (size.h + PAGE_GAP) + marginTop;
        gaps.push(top - bottomAbs);
        bottomAbs = top + layout.fragments[i].heightPx;
      }
      tableEffects.push({ type: 'apply', node, layout, gaps, naturalHeight: naturalH });
      const displayed = layout.fragments.reduce((s2, f) => s2 + f.heightPx, 0) + gaps.reduce((s2, g) => s2 + g, 0);
      shift += displayed - naturalH;
      pageFnH += ufH;
    };

    // Lists and blockquotes break between children (whole child moves).
    const container = (pos: number, node: PMNode) => {
      const endPos = pos + node.nodeSize;
      const r = rectOf(pos);
      if (!r) {
        pageFnH += takeFnH(endPos);
        return;
      }
      if (stackY(r.top, pos) + shift + r.height <= bottomFor(peekFnH(endPos)) + 0.5) {
        pageFnH += takeFnH(endPos);
        return;
      }
      // Breaks found below are inside the container, so a heading sitting
      // above it is no longer the thing being pushed onto the next page.
      sticky = null;
      node.forEach((child, offset) => {
        const childPos = pos + 1 + offset;
        const childEnd = childPos + child.nodeSize;
        const cr = rectOf(childPos);
        if (!cr || cr.height === 0) {
          pageFnH += takeFnH(childEnd);
          return;
        }
        const y = stackY(cr.top, childPos);
        if (y + shift + cr.height <= bottomFor(peekFnH(childEnd)) + 0.5) {
          pageFnH += takeFnH(childEnd);
          return;
        }
        // The child overflows. A list item is NOT an atom: Typst breaks the
        // prose inside it across pages like any other text, so break inside
        // it too. Moving the whole item leaves the page short by the item's
        // entire height — and an item taller than a page used to get no
        // break at all, running straight off the bottom.
        //
        // Only the item's FIRST block carries the item as its owner: a break
        // there must take the bullet with it, while a break before a later
        // block genuinely belongs inside the item.
        if (child.type.name === 'list_item') {
          let owner: { pos: number; y: number } | undefined = { pos: childPos, y };
          child.forEach((grand, grandOffset) => {
            splitBlock(childPos + 1 + grandOffset, grand, owner);
            owner = undefined;
          });
        } else {
          splitBlock(childPos, child);
        }
        pageFnH += takeFnH(childEnd);
      });
      pageFnH += takeFnH(endPos);
    };

    /** Page-break one block wherever it sits — top level or nested in a
     *  list item or quote. Mirrors the document-level dispatch below. */
    const splitBlock = (pos: number, node: PMNode, owner?: { pos: number; y: number }) => {
      switch (node.type.name) {
        case 'paragraph':
          if (node.attrs.keep) atomic(pos, node, owner);
          else paragraph(pos, node, owner);
          break;
        case 'bullet_list':
        case 'ordered_list':
        case 'blockquote':
          container(pos, node);
          break;
        case 'table':
          tableCase(pos, node);
          break;
        default:
          atomic(pos, node, owner);
      }
    };

    view.state.doc.forEach((node, offset) => {
      if (offset < (seed?.startPos ?? 0)) return;
      visitedUnits++;
      switch (node.type.name) {
        case 'page_break':
        case 'numbering_restart': {
          const r = rectOf(offset);
          if (r) breakBefore(offset + node.nodeSize, stackY(r.bottom, offset), 'block');
          pageFnH += takeFnH(offset + node.nodeSize);
          break;
        }
        case 'paragraph':
          if (node.attrs.keep) atomic(offset, node);
          else paragraph(offset, node);
          break;
        case 'bullet_list':
        case 'ordered_list':
        case 'blockquote':
          container(offset, node);
          break;
        case 'table':
          tableCase(offset, node);
          break;
        default:
          atomic(offset, node);
          break;
      }
      if (node.type.name === 'heading') {
        const hr = rectOf(offset);
        sticky = sticky ?? (hr ? { pos: offset, y: stackY(hr.top, offset) } : null);
      } else {
        sticky = null;
      }
    });

    return { spacers, count: page + 1, tableEffects, visitedUnits, anchors };
  }

  /** Same-prefix reference pass for an exact-basis seed: re-force the
   * retained exact page starts of the prefix against the live document (the
   * routine that installed them), then run the identical seeded suffix below
   * them. On an unchanged prefix the re-forced gaps equal the stored ones
   * bit-for-bit, so a comparison difference means retained geometry drifted
   * or the suffix runner diverged — never that Typst and the local engine
   * disagree about the prefix. Null when the prefix no longer re-forces
   * one-gap-per-marker (the seed's premise is stale; tallied as a bail). */
  private exactSuffixReference(
    snapshot: PaginationGeometrySnapshot,
    seed: SuffixPaginationSeed,
    run: (seed?: PaginationFallbackSeed) => PaginationFallbackResult,
  ): PaginationFallbackResult | null {
    const forced = this.paginateForced(
      snapshot,
      seed.prefixMarkers.map((marker) => ({ pos: marker.pos, line: marker.line, unit: marker.unit })),
      seed.page + 1,
    );
    if (!forced || forced.tableEffects.length) return null;
    if (forced.spacers.length !== seed.prefixSpacers.length) return null;
    let shift = 0;
    for (const spacer of forced.spacers) shift += spacer.height;
    return run({
      startPos: seed.startPos,
      page: seed.page,
      shift,
      prefixSpacers: forced.spacers.map((spacer) => ({ ...spacer })),
    });
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
    const tableEffects: TableEffect[] = [];
    let shift = 0;
    let page = 0;
    for (let psi = 0; psi < pageStarts.length; psi++) {
      const ps = pageStarts[psi];
      // Page breaks INSIDE a table: rendered by the table view as split
      // fragments (no spacer widget). The paged mini-compile answers with
      // Typst's own fragments; the split must agree with the oracle's
      // break count or the whole result fails (graceful fallback).
      if (ps.unit === 'table' && ps.line > 0) {
        const node = view.state.doc.nodeAt(ps.pos);
        const el = view.nodeDOM(ps.pos);
        if (!node || node.type.name !== 'table' || !(el instanceof HTMLElement)) return null;
        let last = psi;
        while (
          last + 1 < pageStarts.length &&
          pageStarts[last + 1].pos === ps.pos &&
          pageStarts[last + 1].unit === 'table'
        ) {
          last++;
        }
        const breaks = last - psi + 1;
        const assigned = getSplit(node);
        const naturalH = assigned ? assigned.naturalPx : el.getBoundingClientRect().height;
        const yTop = natural(el.getBoundingClientRect().top, ps.pos);
        const pageTopAbs = page * (size.h + PAGE_GAP) + marginTop;
        const offsetPt = Math.max(0, (yTop + shift - pageTopAbs) * 0.75);
        const contentHPx = snapshot.contentHeight;
        // The oracle's line indices are cumulative within the table unit:
        // their diffs are the exact per-page line counts of the PDF, and
        // the mini-compile must reproduce them (it nudges its offset until
        // it does, so the split row IS the PDF's split row).
        const targetLines: number[] = [];
        for (let k = psi; k <= last; k++) {
          targetLines.push(pageStarts[k].line - (k > psi ? pageStarts[k - 1].line : 0));
        }
        const layout = requestTableSplit(view, node, view.dom.clientWidth || 576, contentHPx * 0.75, offsetPt, targetLines);
        if (!layout || layout.pushed || layout.fragments.length - 1 !== breaks) return null;
        const gaps: number[] = [];
        let bottomAbs = yTop + shift + layout.fragments[0].heightPx;
        for (let k = 1; k < layout.fragments.length; k++) {
          page++;
          const top = page * (size.h + PAGE_GAP) + marginTop;
          gaps.push(top - bottomAbs);
          bottomAbs = top + layout.fragments[k].heightPx;
        }
        tableEffects.push({ type: 'apply', node, layout, gaps, naturalHeight: naturalH });
        const displayed = layout.fragments.reduce((s2, f) => s2 + f.heightPx, 0) + gaps.reduce((s2, g) => s2 + g, 0);
        shift += displayed - naturalH;
        psi = last;
        continue;
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
        const lineH = this.blockLineHeight(el);
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
    return { spacers, count, tableEffects };
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
    const F = this.bodyPx();

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
      const bottomEdge = page * (size.h + PAGE_GAP) + size.h - marginBottom;
      // Same formula the fit test reserves against (footnoteAreaHeight):
      // clearance + separator once, then (gap + height) per entry — so the
      // painted stack can never drift from what pagination assumed fit.
      const { entryTops } = footnotePositions(
        list.map((f) => f.height),
        F,
        bottomEdge,
      );
      list.forEach((f, i) => {
        const y = entryTops[i] - pmOffset;
        // Hysteresis: sub-pixel re-measurements must not nudge the body.
        const prev = parseFloat(f.el.style.top);
        if (!(Math.abs(prev - y) < 0.75)) f.el.style.top = `${y.toFixed(1)}px`;
        f.el.classList.toggle('fn-first', i === 0);
        f.el.style.visibility = 'visible';
      });
    }
  }
}
