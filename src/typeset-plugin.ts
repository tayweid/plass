// The layout translator (spec §3.5): reads the port's line layouts and
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
// only the affected blocks in the same task. The settled pass re-lays the
// document and only dispatches when semantics differ. Pagination may add a
// second synchronous update in the same task, after measuring the exact
// line layout, so no intermediate state paints. One renderer: nothing here
// compiles; Typst measures the result on demand (the port audit, `audit()`).
//
// Pagination model: the document stays one continuous editable flow; page
// boxes are painted behind it (see #pages in main.ts), and exact-height
// spacers push content past each page boundary. Between blocks the spacer is
// an ordinary div; inside a paragraph it is a block-in-inline div sitting at
// a port-chosen line break (the div itself forces the break, so it simply
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
import { buildSpec, type AtomResolver, type SpecKind } from './layout/typst-oracle';
import { portBreaks, shapedWidthPt } from './layout/port/adapter';
import { loadPrimitives, primitives } from './layout/primitives';
import { PROBE_TEXT, judgeEnvironment, measureBrowserRun, type EnvironmentVerdict } from './environment-check';
import { getSettings, PAGE_GAP, pageSize, parseMathMacros, type DocSettings } from './settings';
import { escapeTyp, expandMacrosWith, headingScale, pageBottomInsetEm, pageTopAdjustEm, tableMarginsEm } from './typ-serializer';
import {
  containerPageTopDropEm,
  footnoteEmptyFrameAction,
  footnoteEntryCost,
  footnoteEntryFit,
  footnoteHeadReservePx,
  footnotePositions,
  freshStickyState,
  lineNeeds,
  settleFootnoteCarry,
  stickyFinish,
  stickyFrame,
  stickyRelayoutCheckpoint,
  type FootnoteCarryItem,
  type StickyState,
} from './layout/flow-rules';
import { citationLabelMap } from './citations';
import { eqKey } from './equations';
import { getInk, inkKey } from './math-ink';
import { parseTypstSvg } from './safe-svg';
import { recordLayoutPerf } from './layout/perf';
import { COMMON_PORT_KEYS, effectiveFont, parityMetrics, cssFontStack, footnoteFrameInsetsEm } from './font-registry';
import {
  appendLineDecorations,
  blockSpacerDecoration,
  decorationSetDigest,
  decorationSignature,
  decorationsOwnedByBlock,
  pageGapWidget,
  pageSpacerDecoration,
  rebuildDecorationsOwnedByBlock,
  rowSpacerDecoration,
  type Spacer,
  type TypesetDecorationSpec,
} from './layout/line-decorations';
import {
  planTableRowBreaks,
  tableRowModel,
  type MeasuredRow,
} from './layout/table-rows';
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
import type { PageStartEntry } from './layout/page-parity';
import { buildPortAudit, type PortAuditReport } from './layout/port-audit';

/** Islands never flex: nothing in the document takes a line's slack. */
const noFill = () => false;

/** Slack allowed when a frame is tested against the page bottom, in px.
 * Typst allows none (`Abs::fits` is exact to 1e-6pt); the browser's layout
 * is exact to 1/64 px, so this only absorbs that quantization — a looser
 * value placed lines Typst rejects by half a point. */
const FIT_TOLERANCE_PX = 0.1;

/** The widths of a block's inline atoms, as the port will receive them,
 * folded into its layout cache key: a formula's compiled ink arrives after
 * the block was first laid out with a placeholder, and a layout reused
 * across that arrival would keep the placeholder's breaks. */
function atomWidthSignature(node: PMNode, atomWidth: AtomWidth): string {
  let sig = '';
  node.forEach((child, offset) => {
    if (child.isText) return;
    sig += `|${atomWidth(offset, child).toFixed(2)}`;
  });
  return sig;
}

/** Typst's second-level list marker "‣" (U+2023) is not in the bundled body
 * faces; the compiler shapes it from its fallback face at this advance
 * (measured: 4.69pt at 12.5pt). The port's shaper would report .notdef. */
const LIST_TRIANGLE_EM = 0.375;

export { typesetKey };
export type { PageInfo, TypesetMeta, TypesetState, TypesetStats };

/** Phase-3 flag (PORT.md): drive live typing with the ported Typst
 * breaker. Console: __usePort(false) to A/B against the legacy path;
 * __portStats() reports how often each path ran. */
let USE_PORT = true;
/** The startup probe's verdict (environment-check.ts), for the dev hook. */
let environmentVerdict: EnvironmentVerdict | null = null;
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

interface PaginationPassResult {
  spacers: Spacer[];
  count: number;
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

/**
 * Put the page machinery to sleep while the editor is mounted but hidden
 * (SOURCE-VIEW.md, decision 6: the source view hides `#editor`/`#pages`).
 * Suspended, no pass measures the DOM, nothing dispatches, and no compile
 * launches; a hidden editor measures zero heights, and a snapshot taken
 * from it would poison pagination. Resuming runs exactly one full settled
 * pass — the same pass a freshly opened document gets — which re-requests
 * every oracle answer it lacks.
 */
export function setLayoutSuspended(view: EditorView, suspended: boolean) {
  viewRegistry.get(view)?.setSuspended(suspended);
}

export function isLayoutSuspended(view: EditorView): boolean {
  return viewRegistry.get(view)?.isSuspended() ?? false;
}

export function typesetPlugin(
  opts: { onStats?: (s: TypesetStats) => void; onPages?: (p: PageInfo) => void; onEnvironment?: (v: EnvironmentVerdict) => void } = {},
) {
  return new Plugin<TypesetState>({
    key: typesetKey,
    state: {
      init: () => ({ decos: DecorationSet.empty }),
      apply(tr, val) {
        const meta = tr.getMeta(typesetKey) as TypesetMeta | undefined;
        if (meta?.type === 'decos') return { decos: meta.decos };
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
            return kind === 'line-page-gap' || kind === 'block-page-gap' || kind === 'row-page-gap';
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
                const spec = d.spec as { key: string; h: number; hy?: boolean; hdr?: number };
                const pos = Math.min(tr.mapping.map(d.from, -1), tr.doc.content.size);
                if (spec.key.startsWith('pgr:')) {
                  return rowSpacerDecoration({ pos, height: spec.h, kind: 'row', hdr: spec.hdr ?? 0 });
                }
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
          return { decos };
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
  private measurer: Measurer;
  private scheduler!: LayoutScheduler;
  /** Signature of the last dispatched decoration set: identical layouts are
   *  never re-dispatched, so no-op runs cause zero paints. */
  private lastDecoSig = '';
  /** Set whose digest the live pass owes `lastDecoSig`. Digesting the whole
   *  set is O(document); the keystroke path defers it here and the settled
   *  run (already O(document)) computes it only when it needs the compare. */
  private lastDecoSigSource: DecorationSet | null = null;
  private lastLiveDoc: PMNode | null = null;
  /** Which source produced the last pagination (diagnostics). */
  private pagPath: 'local' = 'local';
  private pagLog: string[] = [];
  /**
   * Startup probe (environment-check.ts): the browser's width for a prose
   * run in the document's font and size against the port's shaped width.
   * A disagreement beyond the tolerance turns the exact path off for the
   * session — legacy breaker, oracles suspended — and tells the writer.
   * `simulateRatio` (dev/test) stands in for a hinting browser.
   */
  checkEnvironment(simulateRatio?: number): EnvironmentVerdict | null {
    const prim = primitives();
    if (!prim) return null;
    const s = getSettings(this.view.state);
    const font = effectiveFont(s.font);
    const sizePx = (s.sizePt * 4) / 3;
    const upem = prim.upem(font.portKeys.regular);
    let em = 0;
    for (const g of prim.shape(font.portKeys.regular, PROBE_TEXT)) em += g.xAdvance / upem;
    const portPx = em * sizePx;
    const host = this.view.dom.parentElement ?? document.body;
    const browserPx = measureBrowserRun(host, cssFontStack(s.font), sizePx) * (simulateRatio ?? 1);
    const verdict = judgeEnvironment(browserPx, portPx, font.label, sizePx);
    environmentVerdict = verdict;
    if (!verdict.certified && USE_PORT) {
      console.warn('exact layout is off: browser text metrics disagree with the compiler', verdict);
      USE_PORT = false;
      this.cache.clear();
      this.invalidatePages();
      this.opts.onEnvironment?.(verdict);
    }
    return verdict;
  }

  /** Total pagLog pushes ever. The log itself is a 40-entry ring, so length
   * deltas stop working once it fills; pollers must diff THIS counter. */
  private pagLogTotal = 0;
  private pagWhy = '';
  private forcedAuditor: ForcedLayoutAuditor | null = null;
  private lineDecorationDispatches = 0;
  private paginationSnapshotStats = { captures: 0, spacerScans: 0, heightQueries: 0 };
  private suffixPaginationStats = emptySuffixPaginationStats();
  private suffixControl = new SuffixPaginationControl();
  /** Monotone pagination-pass id: any later pass invalidates a pending
   * verification ticket (the installed geometry it describes is gone). */
  private paginationPassCounter = 0;
  private pendingSuffixVerification: SuffixVerificationTicket | null = null;
  private suffixVerifyScheduled = false;
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
  /** Asleep behind a hidden editor (setLayoutSuspended). The scheduler and
   * oracles hold the real gates; this mirror lets the two direct entry
   * points (liveRun/run) and the suffix-verification deferral — which
   * bypass the scheduler — refuse to touch the DOM. */
  private suspended = false;

  constructor(
    private view: EditorView,
    private opts: { onStats?: (s: TypesetStats) => void; onPages?: (p: PageInfo) => void; onEnvironment?: (v: EnvironmentVerdict) => void },
  ) {
    viewRegistry.set(view, this);
    this.measurer = new Measurer(view.dom);
    // The ported Typst line breaker (PORT.md): loads the sidecar WASM +
    // fonts in the background; until ready, liveRun uses the legacy path.
    loadPrimitives().then(
      () => {
        if (this.destroyed) return;
        this.checkEnvironment();
        this.requestRun();
      },
      (e) => console.warn('sidecar primitives failed to load', e),
    );
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __breakSig?: () => string;
        __forcedLayoutAudit?: {
          start: () => void;
          snapshot: () => ForcedLayoutAuditReport;
          stop: () => ForcedLayoutAuditReport;
        };
        __layoutDispatchStats?: (reset?: boolean) => { lines: number };
        __paginationSnapshotStats?: (reset?: boolean) => {
          captures: number;
          spacerScans: number;
          heightQueries: number;
        };
        __suffixPaginationStats?: (reset?: boolean) => SuffixPaginationStatsReport;
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
      (w as unknown as { __portAtoms: (pos: number) => unknown }).__portAtoms = (pos) => {
        const node = this.view.state.doc.nodeAt(pos);
        if (!node) return null;
        const st = getSettings(this.view.state);
        const px = makeAtomWidth(this.view, st, pos);
        const pt = this.typstAtomWidthPt();
        const out: unknown[] = [];
        node.forEach((child, offset) => {
          if (child.isText) return;
          out.push({ type: child.type.name, offset, domPt: px(offset, child) * 0.75, typstPt: pt(offset, child) });
        });
        return out;
      };
      (w as unknown as { __shapedWidthPt: (text: string, style?: 'regular' | 'bold' | 'italic') => number | null }).__shapedWidthPt = (text, style = 'regular') => {
        const st = getSettings(this.view.state);
        return shapedWidthPt(text, effectiveFont(st.font).portKeys[style], st.sizePt);
      };
      (w as unknown as { __audit: () => Promise<PortAuditReport | null> }).__audit = () => this.audit();
      (w as unknown as { __blockAuthority: (pos: number) => unknown }).__blockAuthority = (
        pos: number,
      ) => {
        const node = this.view.state.doc.nodeAt(pos);
        if (!node) return null;
        const entry = this.cache.get(node);
        return entry
          ? {
              authority: entry.authority ?? null,
              breakSignature: entry.breakSignature ?? null,
              lines: entry.lines.length,
            }
          : null;
      };
      (w as unknown as { __pagLog: () => string[] }).__pagLog = () => this.pagLog;
      (w as unknown as { __environment: () => EnvironmentVerdict | null }).__environment = () => environmentVerdict;
      (w as unknown as { __environmentSimulate: (ratio: number) => EnvironmentVerdict | null }).__environmentSimulate = (ratio) => {
        const v = this.checkEnvironment(ratio);
        this.requestRun();
        return v;
      };
      (w as unknown as { __pagCount: () => number }).__pagCount = () => this.pagLogTotal;
      (w as unknown as { __layoutSuspend: (suspended: boolean) => boolean }).__layoutSuspend = (
        suspended: boolean,
      ) => {
        setLayoutSuspended(this.view, suspended);
        return isLayoutSuspended(this.view);
      };
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
        const stats = { lines: this.lineDecorationDispatches };
        if (reset) this.lineDecorationDispatches = 0;
        return stats;
      };
      w.__paginationSnapshotStats = (reset = false) => {
        const stats = { ...this.paginationSnapshotStats };
        if (reset) {
          this.paginationSnapshotStats = { captures: 0, spacerScans: 0, heightQueries: 0 };
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
      // Web fonts arriving change every browser metric.
      invalidateMetrics: () => {
        this.paginationGeometryEpoch++;
        this.invalidateDomGeometry();
        this.clearFallbackPageBasis();
        this.measurer.invalidate();
        this.cache.clear();
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
      this.clearFallbackPageBasis();
      this.measurer.invalidate();
      this.cache.clear();
    }
    if (view.state.doc !== prevState.doc) {
      this.scheduler.scheduleLive();
      this.scheduler.scheduleAfterEdit();
    }
    // Geometry moved only when the document or the layout decorations did;
    // selection-only transactions skip the rect reads.
    if (
      view.state.doc !== prevState.doc ||
      typesetKey.getState(view.state)?.decos !== typesetKey.getState(prevState)?.decos
    ) {
      this.syncSolutionBars();
    }
  }

  /** Screen paint for solution blocks' left rules — a plugin-owned layer
   * beside `.ProseMirror` (never inside it: a style write on a node's own
   * element is a DOM mutation ProseMirror observes, and re-reading it from
   * `update` loops). */
  private solutionRules: HTMLElement | null = null;

  /**
   * Paint-only: a solution block's left rule must stop at the last line of
   * each page and resume at the first line of the next, as Typst's split
   * block frames do — never run through the page gap. One absolutely
   * positioned segment per page: the block's extent minus every page
   * spacer inside it (spacer top = the last line's bottom, spacer bottom =
   * the next page's first line top). Runs after each layout-bearing view
   * update (spacer installs and live re-layouts arrive as decoration
   * transactions; edits move blocks); a document with no solution block
   * pays one querySelector.
   */
  private syncSolutionBars(): void {
    const dom = this.view.dom;
    const blocks = dom.querySelectorAll<HTMLElement>('blockquote[data-kind="solution"]');
    if (!blocks.length) {
      this.solutionRules?.replaceChildren();
      return;
    }
    const host = dom.parentElement;
    if (!host) return;
    if (!this.solutionRules) {
      this.solutionRules = document.createElement('div');
      this.solutionRules.className = 'ts-solution-rules';
      this.solutionRules.setAttribute('aria-hidden', 'true');
      host.appendChild(this.solutionRules);
    }
    const origin = host.getBoundingClientRect();
    const frag = document.createDocumentFragment();
    for (const block of blocks) {
      const r = block.getBoundingClientRect();
      const cuts: Array<[number, number]> = [];
      for (const gap of block.querySelectorAll<HTMLElement>('.ts-pagegap')) {
        const g = gap.getBoundingClientRect();
        if (g.height > 0) cuts.push([g.top, g.bottom]);
      }
      cuts.sort((a, b) => a[0] - b[0]);
      let y = r.top;
      for (const [a, b] of [...cuts, [r.bottom, r.bottom] as [number, number]]) {
        if (a - y > 0.5) {
          const seg = document.createElement('div');
          seg.style.top = `${(y - origin.top).toFixed(2)}px`;
          seg.style.left = `${(r.left - origin.left).toFixed(2)}px`;
          seg.style.height = `${(a - y).toFixed(2)}px`;
          frag.appendChild(seg);
        }
        y = Math.max(y, b);
      }
    }
    this.solutionRules.replaceChildren(frag);
  }

  /** Re-typeset just the edited blocks with authoritative compiled/ported
   * breaks in the same paint as the keystroke. LayoutScheduler owns the
   * microtask. */
  private liveRun() {
    if (this.destroyed || this.suspended) return;
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
    type LiveBlockKind = 'body' | 'caption' | 'footnote' | 'heading';
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
      if (node.type.name === 'heading') {
        addBlock(node, pos, 'heading');
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
      const level = b.kind === 'heading' ? (b.node.attrs.level as number) || 1 : 0;
      const extra: { firstLineIndent?: number; scale?: number; baseStyle?: 'bold' } =
        b.kind === 'caption'
          ? { firstLineIndent: prefixes!.captionIndent(number) }
          : b.kind === 'footnote'
            ? { firstLineIndent: prefixes!.footnoteIndent(number), scale: prefixes!.footnoteScale }
            : b.kind === 'heading'
              ? { scale: headingScale(level), baseStyle: 'bold' }
              : settings.parIndent && consecutiveParagraph(state.doc, b.pos)
                ? { firstLineIndent: 1.5 * this.bodyPx() }
                : {};
      const keyTag =
        b.kind === 'caption'
          ? `cap${number}`
          : b.kind === 'footnote'
            ? `fn${number}`
            : b.kind === 'heading'
              ? `h${Math.min(3, level)}`
              : paragraphKeyTag(settings, state.doc, b.pos);
      const el = this.view.nodeDOM(b.pos);
      if (!(el instanceof HTMLElement)) continue;
      // A numbered heading keeps browser layout (see dispatchDecos).
      if (b.kind === 'heading' && el.dataset.secnum) continue;
      const target =
        b.kind === 'caption'
          ? el.querySelector('figcaption')
          : b.kind === 'footnote'
            ? el.querySelector('.fn-body')
            : el;
      if (!(target instanceof HTMLElement)) continue;
      const measure = this.blockMeasure(target, b.kind === 'body' || b.kind === 'heading');
      if (!(measure > 60)) continue;
      const atomWidth = makeAtomWidth(this.view, settings, b.pos);
      const spec = resolveAtom ? buildSpec(b.node, resolveAtom) : null;
      const okey = spec ? blockOracleKey(settingsSig, keyTag + atomWidthSignature(b.node, atomWidth), measure, spec.key) : null;
      // The ported Typst breaker: full-paragraph, globally optimal. Plain KP
      // is the degraded-mode fallback (sidecar not loaded, unmapped content).
      let lines: LineLayout[] | null = null;
      let authority: BlockLayoutAuthority = 'fallback';
      let breakSignature: string | null = null;
      const lineStart = performance.now();
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
            baseStyle: extra.baseStyle,
            atomWidthPt: this.typstAtomWidthPt(),
          });
          if (forced) {
            lines = this.layoutAuthoritative(
              b.node,
              measure,
              atomWidth,
              {
                hyphenate: settings.hyphenate,
                isFill: noFill,
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
          isFill: noFill,
          ...extra,
        });
        // The fallback's KP-chosen breaks get a real signature: the port
        // audit compares it with Typst's like any other.
        if (lines) breakSignature = lineBreakSignature(lines);
      }
      if (!lines) continue;
      this.cache.set(b.node, {
        measure,
        lines,
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
      return kind === 'line-page-gap' || kind === 'block-page-gap' || kind === 'row-page-gap';
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
        : spec.tsKind === 'row-page-gap'
          ? rowSpacerDecoration({ pos: next.from, height: newH, kind: 'row', hdr: spec.hdr ?? 0 })
          : pageSpacerDecoration(next.from, newH, !!spec.hy);
    return decos.remove([next]).add(state.doc, [replacement]);
  }

  destroy() {
    this.solutionRules?.remove();
    this.solutionRules = null;
    this.destroyed = true;
    viewRegistry.delete(this.view);
    this.scheduler.destroy();
    this.measurer.destroy();
  }

  /** Drop cached page-break decisions (asset bytes changed under same sig). */
  invalidatePages() {
    this.paginationGeometryEpoch++;
    this.invalidateDomGeometry();
    this.clearFallbackPageBasis();
  }

  requestRun() {
    this.scheduler?.scheduleSettled();
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Sleep or wake with the editor's visibility (setLayoutSuspended).
   *
   * Sleeping cancels every pending pass and compile launch and drops the
   * sampled suffix-verification ticket (its geometry premise cannot be
   * re-measured behind a hidden editor). In-flight compiles finish into the
   * oracle caches; their publication reaches the sleeping scheduler and
   * installs nothing.
   *
   * Waking discards every DOM-derived basis — geometry epoch, per-element
   * reads, the exact and fallback page bases — so the single settled pass
   * the scheduler runs is a full one from fresh measurements, not a suffix
   * repagination seeded from pre-sleep pixels (fonts and widths may have
   * changed while hidden). Oracle caches persist: an unchanged document
   * lands back on its exact answer in that one pass.
   */
  setSuspended(suspended: boolean) {
    if (this.destroyed || suspended === this.suspended) return;
    this.suspended = suspended;
    if (suspended) {
      this.scheduler.suspend();
      this.pendingSuffixVerification = null;
      return;
    }
    this.paginationGeometryEpoch++;
    this.invalidateDomGeometry();
    this.clearFallbackPageBasis();
    this.lastDecoSig = '';
    this.lastDecoSigSource = null;
    this.scheduler.resume();
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
      return kind === 'line-page-gap' || kind === 'block-page-gap' || kind === 'row-page-gap';
    }) ?? []) {
      const spec = d.spec as Partial<TypesetDecorationSpec>;
      const h = spec.h ?? 0;
      if (!(h > 0)) continue;
      if (spec.tsKind === 'block-page-gap') blocks.push({ pos: d.from, height: h, kind: 'block' });
      else if (spec.tsKind === 'row-page-gap') blocks.push({ pos: d.from, height: h, kind: 'row', hdr: spec.hdr ?? 0 });
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
    const heights = createPaginationSnapshot({ spacers: spacers.sorted, tableExtras: [] });
    this.paginationSnapshotStats.captures++;
    this.paginationSnapshotStats.spacerScans++;
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

  /**
   * Footnote SPILL vs. the suffix seed. A seeded pass assumes the boundary
   * page starts with an empty footnote carry: every entry whose marker sits
   * in the prefix was fully placed above the boundary. With spill ported
   * (PAGE-PORT.md Phase 4, flow/compose.rs `footnote_spill`) that assumption
   * can be false — a prefix entry that only partly fit beside its marker
   * carries onto the seed page and reserves space there.
   *
   * The v1 choice is to DECLINE eligibility rather than replay the carry:
   * reconstructing it would mean re-deciding the prefix's footnote fits from
   * painted geometry, which is exactly the work the seed exists to skip, and
   * a wrong reconstruction would install wrong pages. Declining only costs a
   * full pass.
   *
   * Conservative test: a spilling entry can reach at most
   * `1 + ceil(height / usable page)` pages, so any footnote marker inside
   * that many pages above the boundary makes the seed ineligible. For
   * ordinary (sub-page) entries that is exactly "a marker on the last prefix
   * page". Documents whose prefix has no footnotes at all are unaffected.
   */
  private footnoteCarryCrossesSeed(
    seed: SuffixPaginationSeed,
    snapshot: PaginationGeometrySnapshot,
  ): boolean {
    const doc = this.view.state.doc;
    const positions: number[] = [];
    let maxHeight = 0;
    doc.descendants((node, pos) => {
      if (pos >= seed.startPos) return false;
      if (node.type.name !== 'footnote') return true;
      const dom = this.view.nodeDOM(pos);
      const body = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>('.fn-body') : null;
      positions.push(pos);
      maxHeight = Math.max(maxHeight, body ? body.offsetHeight : 0);
      return false;
    });
    if (positions.length === 0) return false;
    const F = snapshot.bodyPx;
    const usable = Math.max(
      1,
      snapshot.contentHeight - footnoteHeadReservePx(F) - footnoteEntryCost(0, F),
    );
    const maxSpanPages = 1 + Math.ceil(maxHeight / usable);
    // prefixMarkers[i] starts page i + 1; the seed page is prefixMarkers.length.
    const cutoffPage = seed.page - maxSpanPages + 1;
    const cutoffPos =
      cutoffPage <= 0 ? 0 : (seed.prefixMarkers[cutoffPage - 1]?.pos ?? 0);
    return positions.some((pos) => pos >= cutoffPos);
  }

  private planPaginationSuffix(snapshot: PaginationGeometrySnapshot): PaginationSuffixPlan {
    // Session policy first: a tripped kill-switch (first verified mismatch)
    // or the forced-full measurement mode runs every pass full.
    const inactive = this.suffixControl.inactiveReason();
    if (inactive) return { kind: 'none', reason: inactive };
    const currentDoc = this.view.state.doc;
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
        if (!this.footnoteCarryCrossesSeed(decision.seed, snapshot)) {
          return { kind: 'seed', source: 'fallback', seed: decision.seed };
        }
        return { kind: 'none', reason: 'fallback-footnote-spill' };
      }
      return {
        kind: 'none',
        reason: decision.kind === 'none' ? 'fallback-unchanged' : `fallback-${decision.reason}`,
      };
    }

    return {
      kind: 'none',
      reason: 'no-page-basis',
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
      if (anchor.kind === 'row') {
        // A row break inside a top-level table: stored as the table's own
        // boundary plus the row index (the oracle's vocabulary).
        if ($pos.depth !== 1 || $pos.parent.type.name !== 'table' || $pos.index() < 1) {
          markers.length = 0;
          break;
        }
        markers.push({ childIndex, offset: 0, page: anchor.page, line: $pos.index(), unit: 'table' });
        continue;
      }
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
    const first = this.view.state.doc.firstChild;
    const kind = this.unitKindOf(first);
    const adj = kind
      ? pageTopAdjustEm(s, kind) * this.bodyPx()
      : first?.type.name === 'table'
        ? -tableMarginsEm(s).top * this.bodyPx()
        : 0;
    host.style.paddingTop = `${(s.marginTop * 96 + adj).toFixed(2)}px`;
  }

  /** Key of the last published geometry variables (null: never, or the
   *  port was not up yet and the list indents fell back to the CSS defaults). */
  private geometryVarsKey: string | null = null;

  /**
   * Publish the block geometry Typst decides from metrics the stylesheet
   * cannot know: list body indents (the marker column — the marker's shaped
   * width — plus Typst's 0.5em body-indent; "‣" is not in the body fonts,
   * so its width is the compiler's fallback face's, a constant), enum
   * indents by label digit count, and the table's block spacing (Typst's
   * Auto spacing = paragraph spacing, measured frame to frame; the editor's
   * box has the paragraph's descent below and cap slack above to absorb).
   * Idempotent per (font, size, spacing) key; the CSS carries fallbacks
   * until the port is up.
   */
  private publishGeometryVars(s: DocSettings) {
    const font = effectiveFont(s.font);
    const bullet = shapedWidthPt('•', font.portKeys.regular, s.sizePt);
    const key = `${s.font}|${s.sizePt}|${s.lineHeight}|${s.parIndent}|${bullet === null ? 'nopt' : 'pt'}`;
    if (key === this.geometryVarsKey) return;
    this.geometryVarsKey = key;
    const root = document.documentElement.style;
    const F = this.bodyPx();
    const px = (pt: number) => `${((pt * 4) / 3).toFixed(4)}px`;
    const bodyIndent = 0.5 * s.sizePt;
    if (bullet !== null) {
      root.setProperty('--list-indent-1', px(bullet + bodyIndent));
      root.setProperty('--list-indent-2', px(LIST_TRIANGLE_EM * s.sizePt + bodyIndent));
      root.setProperty('--list-indent-3', px((shapedWidthPt('–', font.portKeys.regular, s.sizePt) ?? 0.5 * s.sizePt) + bodyIndent));
      for (const digits of [1, 2, 3]) {
        const label = '1'.padEnd(digits, '0') + '.';
        root.setProperty(`--enum-indent-${digits}`, px((shapedWidthPt(label, font.portKeys.regular, s.sizePt) ?? 0) + bodyIndent));
      }
    }
    const table = tableMarginsEm(s);
    root.setProperty('--table-mt', `${(table.top * F).toFixed(4)}px`);
    root.setProperty('--table-mb', `${(table.bottom * F).toFixed(4)}px`);
  }

  private run() {
    if (this.destroyed || this.suspended) return;
    this.lastLiveDoc = this.view.state.doc;

    const t0 = performance.now();
    // The settled pass re-reads global geometry fresh once; its per-block
    // fresh reads below repopulate the per-element caches for the next
    // keystroke burst.
    this.syncDomGeometryWidth();
    this.bodyPxCache = null;
    this.publishGeometryVars(getSettings(this.view.state));
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
    this.pagLogTotal++;
    if (this.pagLog.length > 40) this.pagLog.shift();
    if (spacers.length || held.lineMap.size || held.blocks.length) {
      // A computed spacer that matches an installed one (same position and
      // kind, height within the sub-pixel tolerance) keeps the installed
      // height: the live pass already maintained the page invariant, and
      // reinstalling for noise would churn widget DOM without moving pixels.
      // When everything matches, the dispatch below becomes a signature no-op.
      const effective = spacers.map((sp) => {
        const installed =
          sp.kind === 'line'
            ? held.lineMap.get(sp.pos)
            : held.blocks.find((b) => b.pos === sp.pos && b.kind === sp.kind);
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
        if (ticket && !this.destroyed && !this.suspended) this.runSuffixVerification(ticket);
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
    const reference = runFallback();
    stats.fullRuns++;
    stats.fullUnits += reference.visitedUnits;
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
    let citeLabels: Map<string, string> | undefined;
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
          citeLabels ??= citationLabelMap(state);
          return shapeW(citeLabels.get(child.attrs.key as string) ?? '[?]', s.sizePt);
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
    const inkText = (src: string, bold: boolean): string | undefined => {
      const ink = getInk(inkKey(src, false, settings, bold));
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
    let citeLabels: Map<string, string> | undefined;
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
        case 'math_inline': {
          // Inside a strong span the formula compiles bold (wider) — the
          // same context the exporter's `*…*` run and the ink use.
          const bold = child.marks.some((m) => m.type.name === 'strong');
          const mi = '#mi(`' + expandMacrosWith(child.attrs.src as string, macros) + '`)';
          return { markup: bold ? `#strong[${mi}]` : mi, text: inkText(child.attrs.src as string, bold) };
        }
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
        // An inline island prints as inline raw — its own source, never run.
        case 'typst_inline': {
          const src = child.attrs.src as string;
          return { markup: `#raw(${JSON.stringify(src)})`, text: src };
        }
        case 'citation': {
          citeLabels ??= citationLabelMap(state);
          const t = citeLabels.get(child.attrs.key as string) ?? '[?]';
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
    const layoutOpts = { hyphenate: settings.hyphenate, isFill: noFill };
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
      extra: { firstLineIndent?: number; scale?: number; baseStyle?: 'bold' },
      keyTag: string,
    ) => {
      // Aligned paragraphs keep browser layout (CSS text-align centers or
      // right-sets each ragged line) — display lines, not justified prose.
      if (node.type.name === 'paragraph' && node.attrs.align) return;
      const atomWidth = makeAtomWidth(this.view, settings, pos);

      // One renderer: the port lays out every block; the key carries the
      // resolved atom text and widths so a repaint invalidates the layout.
      const spec = resolveAtom ? buildSpec(node, resolveAtom) : null;
      const okey = spec ? blockOracleKey(settingsSig, keyTag + atomWidthSignature(node, atomWidth), measure, spec.key) : null;

      const indent = extra.firstLineIndent ?? 0;
      const scale = extra.scale ?? 1;
      const cacheKey: BlockLayoutCacheKey = { measure, key: okey, indent, scale };
      let entry = this.cache.getReusable(node, cacheKey);
      if (!entry) {
        let lines: LineLayout[] | null = null;
        let authority: BlockLayoutAuthority = 'fallback';
        let breakSignature: string | null = null;
        const auditId = `${skind.kind}@${pos}`;
        // The ported Typst breaker — the same algorithm Typst runs,
        // computed locally. Plain KP is the degraded-mode fallback.
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
              baseStyle: extra.baseStyle,
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
      if (node.type.name === 'heading' && node.content.size) {
        // Typst justifies (and hyphenates) a heading with the document's
        // paragraph settings, bold at the level's size: the port lays it
        // out like a paragraph. A numbered heading keeps browser layout
        // for now — its painted number is not in the port's text.
        const el = this.view.nodeDOM(pos);
        if (!(el instanceof HTMLElement) || el.dataset.secnum) return false;
        const measure = this.blockMeasure(el, true, true);
        if (!(measure > 60)) return false;
        const level = (node.attrs.level as number) || 1;
        layoutInto(node, pos, measure, { kind: 'body' }, { scale: headingScale(level), baseStyle: 'bold' }, `h${Math.min(3, level)}`);
        return false;
      }
      // Code blocks stay ragged (Typst's raw block wraps nowhere).
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
      decos.push(sp.kind === 'row' ? rowSpacerDecoration(sp) : blockSpacerDecoration(sp));
    }

    const sig = decorationSignature(decos);
    // Settle the digest the live pass deferred (only positions the live pass
    // itself dispatched can still be current — any later edit cleared this).
    if (this.lastDecoSigSource) {
      this.lastDecoSig = decorationSetDigest(this.lastDecoSigSource);
      this.lastDecoSigSource = null;
    }
    if (sig === this.lastDecoSig) {
      return { paragraphs, lines: lineCount };
    }
    this.lastDecoSig = sig;
    const set = DecorationSet.create(state.doc, decos);
    const meta: TypesetMeta = { type: 'decos', decos: set };
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
      if (a.kind === 'row') {
        // A row break's `pos` is the position before the row; the oracle's
        // vocabulary is the table's position plus the row index.
        try {
          const $pos = doc.resolve(a.pos);
          if ($pos.parent.type.name === 'table') return { pos: $pos.before(), line: $pos.index(), unit: 'table' };
        } catch {
          /* fall through */
        }
        return { pos: a.pos, line: 0, unit: 'table' };
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

  /**
   * Port audit (tests/port-audit.spec.ts, `npm run audit`): compile the
   * document once with Typst and report where the port's line breaks and
   * the local paginator's page starts differ from it. The measurement
   * lives here, outside the edit loop: the editor itself never compiles.
   * Development only.
   */
  private async audit(): Promise<PortAuditReport | null> {
    const { compileDocSvg } = await import('./pdf');
    const { auditSvg } = await import('./layout/page-oracle');
    const state = this.view.state;
    const settings = getSettings(state);
    const t0 = performance.now();
    const svg = await compileDocSvg(state.doc);
    const compileMs = performance.now() - t0;
    if (!svg || state.doc !== this.view.state.doc) return null;
    const t1 = performance.now();
    const typst = auditSvg(svg, state.doc, settings, this.atomResolver());
    const analyzeMs = performance.now() - t1;
    // The local paginator's answer for the document as painted: a
    // prediction-only pass, identical to the one that installed the pages.
    const local = this.runFallbackPass(this.capturePaginationSnapshot());
    return buildPortAudit({
      doc: state.doc,
      typst,
      local: { starts: this.anchorsToPageStartEntries(local.anchors), count: local.count },
      entryFor: (node) => this.cache.get(node),
      domBreaksFor: (node, pos) => this.domBreakSignature(node, pos),
      compileMs,
      analyzeMs,
    });
  }

  /** The line breaks the browser painted for a text-only block (a heading),
   * read back as the oracle's break signature: a break sits before each
   * word that starts a new line box, at the end of the previous word. The
   * browser never hyphenates, so a hyphenated Typst line can only mismatch. */
  private domBreakSignature(node: PMNode, pos: number): string | null {
    if (!node.isTextblock) return null;
    let text = '';
    node.forEach((child) => {
      if (!child.isText) text = '\u0000';
      else text += child.text ?? '';
    });
    if (text.includes('\u0000')) return null;
    const el = this.view.nodeDOM(pos);
    if (!(el instanceof HTMLElement)) return null;
    const breaks: ForcedBreak[] = [];
    let lastTop: number | null = null;
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let coords: { top: number } | null = null;
      try {
        coords = this.view.coordsAtPos(pos + 1 + m.index, 1);
      } catch {
        return null;
      }
      if (lastTop !== null && Math.abs(coords.top - lastTop) > 2) {
        let at = m.index;
        while (at > 0 && /\s/.test(text[at - 1])) at--;
        breaks.push({ at, hyphen: false });
      }
      lastTop = coords.top;
    }
    return forcedBreakSignature(breaks);
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
    if (snapshot.contentHeight < 120) return { spacers: [], count: 1 };

    // One renderer: the local paginator is the authority. Typst's pages are
    // measured against it by the port audit (tests/port-audit.spec.ts),
    // never installed over it.
    this.pagPath = 'local';
    this.pagWhy = 'entry=local';
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
      const reference = full;
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
    // The same re-settle must also preserve the last suffix pass's
    // diagnostics: an eligible pass is the only writer of the position
    // fields, and an unchanged document keeps them true. `eligible`, not
    // `compared`, witnesses that pass — a promoted install defers its
    // comparison to the sampled idle verification, so `compared` may still
    // be zero while the diagnostics describe the live geometry.
    if (!suffixPlan.reason.endsWith('-unchanged') || this.suffixPaginationStats.eligible === 0) {
      this.suffixPaginationStats.lastReason = suffixPlan.reason;
      this.suffixPaginationStats.lastDifference = null;
      this.suffixPaginationStats.lastStartPos = null;
      this.suffixPaginationStats.lastAnchorPos = null;
    }
    this.rememberFallbackBasis(fallback);
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

    // Footnote bodies, in document order, consumed as units are placed. The
    // entry's own line height is measured here (same spirit as offsetHeight —
    // DOM-measured, never derived) so a spilled fragment can be quantized to
    // whole lines the way Typst's text layout produces them; a 'normal' or
    // unparseable computed line-height yields 0, which the split function
    // reads as "plain pixel clamp".
    // Heights are Typst FRAMES (footnoteFrameInsetsEm): the painted box less
    // its cap-top slack and last-line descent, so the reservation ends at
    // the last entry's baseline exactly as Typst's does.
    const fnInsets = footnoteFrameInsetsEm(s);
    const fnLeadingPx = fnInsets.leading * F;
    const fnList: Array<{ pos: number; height: number; lineHeight: number; leading: number }> = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'footnote') return true;
      const dom = view.nodeDOM(pos);
      const body = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>('.fn-body') : null;
      const lineHeight = body ? parseFloat(getComputedStyle(body).lineHeight) : NaN;
      fnList.push({
        pos,
        height: body && body.offsetHeight > 0 ? Math.max(0, body.offsetHeight - fnLeadingPx) : 0,
        lineHeight: Number.isFinite(lineHeight) ? lineHeight : 0,
        leading: fnLeadingPx,
      });
      return false;
    });
    let fnIdx = 0;
    // A seed restarts at a top-level page start: every block before it has
    // been fully placed, so its footnotes belong to earlier pages — exactly
    // the state the full pass reaches when it consumes footnotes per placed
    // unit and resets the page reservation at the seed's break. Under SPILL
    // that is only true when no prefix entry is still spilling across the
    // boundary; `planPaginationSuffix` declines eligibility in that case
    // (see `footnoteCarryCrossesSeed`), so the carry pool starts empty here.
    if (seed) {
      while (fnIdx < fnList.length && fnList[fnIdx].pos < seed.startPos) fnIdx++;
    }

    const spacers: Spacer[] = seed ? seed.prefixSpacers.map((spacer) => ({ ...spacer })) : [];
    const anchors: Array<{ pos: number; page: number; kind: Spacer['kind'] }> = [];
    let shift = seed?.shift ?? 0;
    let page = seed?.page ?? 0;
    let pageFnH = 0;
    let visitedUnits = 0;
    // Footnote content owed to later pages: entries whose first fragment was
    // committed at the marker (Typst's `footnote_spill`) and entries that
    // could not start at all (its `footnote_queue`). One ordered pool, since
    // Typst drains them in exactly this order and, while either is
    // outstanding, every further footnote on the page queues behind them
    // (flow/compose.rs:431-434).
    let fnCarry: FootnoteCarryItem[] = [];
    // pageFnH is the running sum of per-entry costs (footnoteEntryCost over
    // the fragment COMMITTED on this page, not the entry's full height) for
    // every footnote placed so far on this page; the once-per-page
    // clearance+separator head reservation is added on top exactly when that
    // running sum is nonzero — the same decomposition `footnoteAreaHeight`
    // uses, so this and `placeFootnotes` can't drift.
    //
    // Fit tests read the ALREADY-COMMITTED area only; a unit's own entries
    // are charged after it is placed. That is the single-pass equivalent of
    // Typst's whole-column relayout against a shrunken pod: content above
    // the marker keeps its spot, and the committed charge lowers the bottom
    // for everything after it (flow/compose.rs `Stop::Relayout` +
    // `column_insertions.height()`, compose.rs:181).
    //
    // `extraFnH` is the fast paths' conservative peek: charging a block's
    // uncommitted entries WHOLE (`peekFnH`) upper-bounds what commitment
    // can charge this page (a fragment never exceeds its entry; a queued
    // entry charges nothing), so a block that fits with that charge fits
    // after Typst's relayout too, and can be committed without the per-line
    // walk. A block that fails it falls through to the exact walk.
    const bottomFor = (extraFnH = 0) => {
      const total = pageFnH + extraFnH;
      return page * (size.h + PAGE_GAP) + size.h - marginBottom - (total > 0 ? total + footnoteHeadReservePx(F) : 0);
    };
    const peekFnH = (endPos: number) => {
      let h = 0;
      for (let j = fnIdx; j < fnList.length && fnList[j].pos < endPos; j++) h += footnoteEntryCost(fnList[j].height, F);
      return h;
    };
    // The position of the block (or line) that starts the current page —
    // Typst's `regions.may_progress()` is false exactly for the first frame
    // of a page with no insertions (`size.y == last`, regions.rs:133-138):
    // the pod is still the full region, so moving the frame can't help.
    let pageStartPos = seed?.startPos ?? 0;
    // Typst's `flow_need`: the in-flow content that holds the marker. For an
    // UNBREAKABLE frame — every paragraph line included (distribute.rs:247)
    // — it is the frame's full height, so the pod starts at the frame's
    // bottom; for a BREAKABLE one (a list/quote block) it is the marker's y
    // within the frame (flow/compose.rs:379-386), approximated here by the
    // marker's line top.
    // A commit site passes the absolute (shifted) y where the entry's pod
    // begins, or null when no geometry is available — then the entry is
    // charged in full, exactly as this ledger did before the spill port.
    type FlowNeedBottom = (fnPos: number) => number | null;
    /** Commit every footnote entry whose marker precedes `endPos`, charging
     *  this page for the fragment that fits and carrying the rest. Mirrors
     *  `Composer::footnote` per entry, including its sequential shrinking of
     *  `regions.size.y` (each entry sees the previous entry's charge). */
    const commitFootnotes = (endPos: number, needBottom: FlowNeedBottom) => {
      while (fnIdx < fnList.length && fnList[fnIdx].pos < endPos) {
        const item = fnList[fnIdx++];
        const carried: FootnoteCarryItem = { heightPx: item.height, lineHeightPx: item.lineHeight, leadingPx: item.leading };
        // A spill or queue is outstanding: order must not be disrupted, so
        // this entry queues whole (charging this page nothing).
        if (fnCarry.length > 0) {
          fnCarry.push(carried);
          continue;
        }
        const podStart = needBottom(item.pos);
        const avail = podStart === null ? Number.POSITIVE_INFINITY : bottomFor() - podStart;
        const fit = footnoteEntryFit(item.height, avail, pageFnH > 0, F, {
          lineHeightPx: item.lineHeight,
          leadingPx: item.leading,
        });
        if (fit.empty) {
          // Nothing fit. Migration (moving the whole origin frame) is decided
          // by the caller BEFORE placement — see `footnoteMigrates`; here the
          // remaining outcomes both amount to carrying the entry whole.
          fnCarry.push(carried);
          continue;
        }
        if (fit.remainder > 0) {
          fnCarry.push({ heightPx: fit.remainder, lineHeightPx: item.lineHeight, leadingPx: item.leading });
        }
        pageFnH += footnoteEntryCost(fit.fragment, F);
      }
    };
    /** Typst's migration rule (flow/compose.rs:494-496): the FIRST footnote
     *  of an UNBREAKABLE frame whose entry cannot take any space moves the
     *  whole frame to the next region, when progress is possible. `podStart`
     *  is the frame's bottom, `flowNeed` its height. `atPageTop` says the
     *  frame is the first thing on this page: `regions.may_progress()`
     *  (regions.rs:133-138) is false exactly then AND when nothing has been
     *  inserted on the page — with a settled carry the pod is already
     *  smaller than the full region, so Typst may (and does) migrate even a
     *  page's first frame. Position identity, not px: the page-top ink
     *  adjustment (`adjFor`) would otherwise read as consumed space. */
    const footnoteMigrates = (endPos: number, podStart: number, flowNeed: number, atPageTop: boolean): boolean => {
      if (fnCarry.length > 0) return false;
      const first = fnList[fnIdx];
      if (!first || first.pos >= endPos) return false;
      const fit = footnoteEntryFit(first.height, bottomFor() - podStart, pageFnH > 0, F, {
        lineHeightPx: first.lineHeight,
        leadingPx: first.leading,
      });
      if (!fit.empty) return false;
      const mayProgressNow = !atPageTop || pageFnH > 0;
      return footnoteEmptyFrameAction(true, mayProgressNow, flowNeed) === 'migrate';
    };
    /** Every page advance resets the page's footnote area and settles the
     *  carried pool onto the new page FIRST, before any of its own content or
     *  footnotes (`Composer::column`, flow/compose.rs ~167-198). Centralized
     *  so no page-advance site can forget it. */
    const startPageFootnotes = () => {
      pageFnH = 0;
      if (fnCarry.length === 0) return;
      const settled = settleFootnoteCarry(fnCarry, contentH, F);
      fnCarry = settled.carry;
      for (const fragment of settled.placed) pageFnH += footnoteEntryCost(fragment, F);
    };
    // The same page-top ink adjustment paginateForced applies: fallback
    // pagination must land units at identical offsets, or an oracle miss
    // visibly shifts the whole page rhythm by the adjustment.
    const adjFor = (pos: number, kind: Spacer['kind']): number => {
      if (kind === 'line') return pageTopAdjustEm(s, 'line') * F;
      // A table row at a page top has no calibrated ascent adjustment (the
      // grid places the row frame flush at the region top); the repeated
      // header's reservation is passed separately by the caller.
      if (kind === 'row') return 0;
      const n = view.state.doc.nodeAt(pos);
      if (n?.type.name === 'paragraph') return pageTopAdjustEm(s, 'paragraph') * F;
      if (n?.type.name === 'code_block') return pageTopAdjustEm(s, 'code') * F;
      if (n?.type.name === 'heading') {
        const lv = Math.min(3, (n.attrs.level as number) || 1);
        return pageTopAdjustEm(s, `h${lv}` as 'h1' | 'h2' | 'h3') * F;
      }
      // A table's spacing above is its margin-top (tableMarginsEm): weak,
      // dropped at a page top; the spacer lands the box on the margin.
      if (n?.type.name === 'table') return -tableMarginsEm(s).top * F;
      // Every other top-level block's own "above" spacing is weak in
      // Typst's model (Auto block spacing or `#quote`'s explicit default —
      // both weakness >= 1, src/layout/flow-rules.ts's SPACING_WEAKNESS),
      // so it drops unconditionally when the block starts a fresh region
      // (flow/distribute.rs::keep_spacing's region-top case). Paragraphs,
      // lines, and headings get a calibrated ascent-based landing spot via
      // pageTopAdjustEm above; the container kinds below have no such
      // calibration yet, so this only drops the certain part — the block's
      // own painted padding-top, which otherwise survives in full at a page
      // top even though Typst never charges it there.
      if (n) {
        const dropEm = containerPageTopDropEm(n.type.name, (n.attrs.kind as string | null) ?? null);
        if (dropEm) return -dropEm * F;
      }
      return 0;
    };
    /** The Typst frame ends ABOVE the painted box's bottom by this much
     *  (pageBottomInsetEm): the last line's descent and half-leading for
     *  text blocks, a container's last text block's, nothing for the kinds
     *  with no calibration (figures, display math, tables). Fit tests
     *  compare frame bottoms against the page bottom — the counterpart of
     *  adjFor, which lands frame TOPS at the page top. */
    const bottomInsetFor = (pos: number): number => {
      let n = view.state.doc.nodeAt(pos);
      // A container's frame ends where its last descendant block's does.
      while (n && !n.isTextblock && !n.isAtom && n.type.name !== 'table' && n.type.name !== 'figure' && n.lastChild) n = n.lastChild;
      if (!n) return 0;
      if (n.type.name === 'paragraph') return pageBottomInsetEm(s, 'paragraph') * F;
      if (n.type.name === 'code_block') return pageBottomInsetEm(s, 'code') * F;
      if (n.type.name === 'heading') {
        const lv = Math.min(3, (n.attrs.level as number) || 1);
        return pageBottomInsetEm(s, `h${lv}` as 'h1' | 'h2' | 'h3') * F;
      }
      return 0;
    };
    /** A paragraph line's frame TOP sits below its line-box top by the
     *  half-leading and the ascent above the cap height — exactly what
     *  adjFor lands at the page top, negated. Line fit tests start there. */
    const lineTop = -pageTopAdjustEm(s, 'line') * F;
    /** `hdr` (row breaks only): the repeated table header's height, laid at
     *  the new page's top ahead of the row, so the row lands below it. */
    const breakBefore = (pos: number, y: number, kind: Spacer['kind'], hdr = 0) => {
      const delta = (page + 1) * (size.h + PAGE_GAP) + marginTop + adjFor(pos, kind) + hdr - (y + shift);
      page++;
      anchors.push({ pos, page, kind });
      pageStartPos = pos;
      startPageFootnotes();
      // Every region gets a fresh distributor (distribute.rs:14-21): the
      // sticky checkpoint and the run's stickable verdict never cross a
      // page break. A migrated run re-enters at the new page top through
      // `regionFinish` below.
      stickyState = freshStickyState();
      if (delta > 0) {
        spacers.push(kind === 'row' ? { pos, height: delta, kind, hdr } : { pos, height: delta, kind });
        shift += delta;
      }
    };
    /** Typst's `regions.may_progress()` (regions.rs:109-111) for the frame
     *  starting at `pos`, by position identity rather than px: it is false
     *  exactly for the first frame of a page (`size.y == last`) unless
     *  footnote insertions already shrank the page (`pageFnH > 0`); the
     *  page-top ink adjustment (`adjFor`) would otherwise read as consumed
     *  space. */
    const mayProgressAt = (pos: number) => pos !== pageStartPos || pageFnH > 0;

    const rectOf = (pos: number): DOMRect | null => {
      const el = view.nodeDOM(pos);
      return el instanceof HTMLElement ? el.getBoundingClientRect() : null;
    };

    /** Flow need for a BREAKABLE frame: the top of the line the marker sits
     *  on, measured the way the paragraph splitter measures its line tops
     *  (caret box, backed off by half-leading when the enclosing block's line
     *  height is known). */
    const markerLineTop = (fnPos: number, blockEl: HTMLElement | null): number => {
      const c = view.coordsAtPos(fnPos);
      const lineH = blockEl ? this.blockLineHeight(blockEl) : 0;
      return stackY(c.top, fnPos) - Math.max(0, (lineH - (c.bottom - c.top)) / 2);
    };

    // Sticky blocks (src/layout/flow-rules.ts, ported from Typst's
    // `Distributor::frame`/`finalize`, distribute.rs:340-369 and :445-458):
    // a run of consecutive headings takes a checkpoint at its first block —
    // when `regions.may_progress()` holds there — and a page that ends
    // before a non-sticky frame anchors the run restores it, so the WHOLE
    // run migrates with the block that ended the page. Headings are sticky
    // by default (typst-library heading.rs:294); top-level headings are the
    // only sticky kind this schema produces. The state is per page (a fresh
    // distributor per region, distribute.rs:14-21), so a seeded pass — which
    // restarts at a page start — begins from the same fresh state the full
    // pass has there; nothing of the prefix needs replaying.
    type StickyCheckpoint = { pos: number; y: number };
    let stickyState: StickyState<StickyCheckpoint> = freshStickyState();
    /** `Distributor::frame`'s sticky step for a frame placed on this page,
     *  called BEFORE its footnotes are handled (distribute.rs:340-369, then
     *  :372). `pos` is the frame's page-top identity (the list item for an
     *  item's first block), `y` its natural top. */
    const stickyFrameAt = (isSticky: boolean, pos: number, y: number, empty = false) => {
      stickyFrame(stickyState, isSticky, empty, mayProgressAt(pos), () => ({ pos, y }));
    };
    /** A non-forced region finish (`Stop::Finish(false)` → `finalize`,
     *  distribute.rs:448-457) raised at the frame starting at `pos`: break
     *  before `restored` — the sticky run's first block — when a checkpoint
     *  is live, else before the frame itself. The migrated run is then the
     *  new page's first frame: a fresh distributor re-runs `frame()` for it
     *  (its verdict now taken at the page top, i.e. disabled unless carried
     *  footnotes shrank the page), so the same run cannot migrate twice. */
    const regionFinish = (restored: StickyCheckpoint | null, pos: number, y: number, kind: Spacer['kind']) => {
      const a = restored ?? { pos, y };
      breakBefore(a.pos, a.y, restored ? 'block' : kind);
      if (restored) stickyFrameAt(true, restored.pos, restored.y);
    };
    const finishBefore = (pos: number, y: number, kind: Spacer['kind']) => {
      regionFinish(stickyFinish(stickyState, false), pos, y, kind);
    };
    /** Bound on how often one frame/line may finish a region before it is
     *  placed regardless. Typst needs none — `may_progress` and a draining
     *  footnote carry bound its loop — but this ledger's carry settlement can
     *  stall on an entry taller than a page, so the guard stays. Two
     *  relocations are legitimate (a restored run migrates the frame, then
     *  the run at the new page top leaves it too little room and it breaks
     *  once more, alone); the third is the safety margin. */
    const MAX_RELOCATIONS = 3;

    /** `owner` is the enclosing list item, when this block is the first
     *  thing inside one: moving the block whole must move the bullet too.
     *  `isSticky`: a top-level heading (Typst's `single.sticky`). */
    const atomic = (pos: number, node: PMNode, owner?: { pos: number; y: number }, isSticky = false) => {
      const endPos = pos + node.nodeSize;
      const r = rectOf(pos);
      if (!r || r.height === 0) {
        // No geometry (unrendered/zero-height): charge the entries in full,
        // exactly as this ledger did before the spill port.
        commitFootnotes(endPos, () => null);
        return;
      }
      const y = stackY(r.top, pos);
      const frameBottom = y + r.height - bottomInsetFor(pos);
      const framePos = owner?.pos ?? pos;
      const frameY = owner?.y ?? y;
      // `Distributor::single` (distribute.rs:269-271): the block doesn't fit
      // and a following region may improve things → finish the region
      // (restoring a live sticky checkpoint). At a page top with nothing
      // inserted `may_progress` is false and the block is placed to
      // overflow — an oversize block therefore first moves to a fresh page
      // (from anywhere else, progress is possible) and overflows there.
      let relocations = 0;
      while (frameBottom + shift > bottomFor() + FIT_TOLERANCE_PX && mayProgressAt(framePos) && relocations < MAX_RELOCATIONS) {
        relocations++;
        finishBefore(framePos, frameY, 'block');
      }
      // `frame()` (distribute.rs:340-369): a heading starts or continues a
      // sticky run; any other block anchors one.
      stickyFrameAt(isSticky, framePos, frameY);
      if (footnoteMigrates(endPos, frameBottom + shift, r.height, !mayProgressAt(framePos))) {
        // The unit is unbreakable and its first entry cannot start here:
        // Typst migrates the whole origin frame rather than break the
        // marker/entry invariant (`footnotes()` raises the finish at
        // :372-378, after the sticky step). For a non-sticky block the
        // snapshot was just dropped (:367), so a heading directly above
        // stays behind; for a heading — a sticky frame — the run's
        // checkpoint is live and `finalize` restores it (:455-457).
        finishBefore(framePos, frameY, 'block');
      }
      // Unbreakable frame: flow need is the frame's FULL height, so the
      // entry's pod begins at the unit's bottom (flow/compose.rs:385, :450).
      commitFootnotes(endPos, () => frameBottom + shift);
    };

    const paragraph = (pos: number, node: PMNode, owner?: { pos: number; y: number }) => {
      const endPos = pos + node.nodeSize;
      const r = rectOf(pos);
      if (!r) {
        commitFootnotes(endPos, () => null);
        return;
      }
      const yTop = stackY(r.top, pos);
      // Every line of one paragraph has the SAME frame height to Typst: the
      // calibrated constant the exporter tells Typst to use for this body
      // text (`m.extent` — typ-serializer.ts's parityRules), in the px unit
      // of the fit-test geometry.
      const m = parityMetrics(s.font);
      const extentPx = m.extent * F;
      // Whole-paragraph fast path: the paragraph fits even with every one of
      // its entries charged whole (the conservative peek — see `bottomFor`),
      // so no line of it can finish the region at either stage below. Its
      // entries are then committed exactly as the per-line walk would: each
      // against the space below its own marker line's bottom (an unbreakable
      // line frame's flow need, distribute.rs:247 + compose.rs:385), spilling
      // onto following pages as needed.
      if (yTop + shift + r.height - bottomInsetFor(pos) <= bottomFor(peekFnH(endPos)) + FIT_TOLERANCE_PX) {
        // Its first line is a non-sticky frame: it anchors any heading run
        // above (distribute.rs:363-369).
        stickyFrameAt(false, owner?.pos ?? pos, owner?.y ?? yTop);
        const blockEl = view.nodeDOM(pos);
        commitFootnotes(endPos, (fnPos) =>
          markerLineTop(fnPos, blockEl instanceof HTMLElement ? blockEl : null) + lineTop + extentPx + shift,
        );
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
      // Collector::lines): every line's own frame height is `extentPx`, and
      // `leading` is the matching `#set par(leading: ...)` value in the same
      // px unit, so `need` composes with the geometry below exactly.
      const leadingPx = Math.max(0, (s.lineHeight - m.extent) * F);
      const heights = new Array<number>(n).fill(extentPx);
      const isEmptyLine = (i: number) => entry.lines[i].to <= entry.lines[i].from;
      const needs = lineNeeds(heights, leadingPx, { isEmpty: isEmptyLine });
      // Index of the first line on the current page (the orphan need only
      // ever applies at the paragraph's absolute start; the widow need
      // still applies to the final pair on a later continuation page — both
      // fall out of indexing `needs[]` by absolute line index, unchanged).
      let segStart = 0;
      for (let k = 0; k < n; k++) {
        const y = lineTops[k].y;
        const lineEnd = k + 1 < n ? base + entry.lines[k + 1].from : endPos;
        // A paragraph line is an UNBREAKABLE frame to Typst (distribute.rs:
        // 247 `frame(.., breakable: false)`), so its entries' pod starts at
        // the line frame's BOTTOM: `flow_need = frame.height()`
        // (distribute.rs:372-378; compose.rs:385 keeps it for unbreakable
        // frames; compose.rs:450 subtracts it from the pod).
        // Evaluated lazily — `shift` moves whenever a break is inserted.
        const lineBottom = () => y + lineTop + shift + heights[k];
        // One line's trip through Typst's flow, in Typst's order:
        //
        // STAGE 1 — pre-insertion (distribute.rs:226-248): own height and
        // `need` against the region as it stands, i.e. reduced only by the
        // entries ALREADY inserted on this page (compose.rs:180-181 shrinks
        // the pod by `column_insertions.height()`); this line's own notes
        // are not reserved yet. A failure is decisive: finish the region
        // when a RAW fresh page (regions.rs:133-138 — backlog/last are never
        // insertion-reduced) can hold the trigger, else place and overflow.
        //
        // MIGRATION (compose.rs:493-497): the line's FIRST note is laid into
        // the space below the line's bottom; if none of it fits and the
        // region may progress, the line finishes the region with NOTHING
        // inserted, so marker and entry share the next page. No sticky
        // restore here: `Distributor::frame` clears the sticky snapshot for
        // a non-sticky frame BEFORE it calls `footnotes()`
        // (distribute.rs:367, then :372-378), so a heading directly above
        // stays behind.
        //
        // INSERTION (compose.rs:414-539): each note's first fragment is
        // inserted below the line (`push_footnote`, its location recorded as
        // a skip), the remainder spills onto following pages — that is
        // `commitFootnotes`, which also queues whole behind an outstanding
        // spill/queue (compose.rs:431-434).
        //
        // STAGE 2 — post-insertion: Typst relayouts the column from its
        // region-start checkpoint against the shrunken pod (compose.rs:
        // 165-216) and re-runs stage 1 for every line. Because the pod is
        // `remaining − line height − separator − gap` (compose.rs:448-450),
        // a line's own fragment never reaches above its own bottom, so only
        // the NEED check can newly fail: the fragment ate the protected
        // partner's room. Then the region finishes with the inserted entries
        // left behind (skips: compose.rs:511, `work.extend_skips` at :681)
        // and the pair migrates to a raw fresh page, provided that page fits
        // the need — legitimately a body-empty page holding one entry. The
        // partner's OWN entries can never strand the pair: they sit below
        // the partner's bottom, which is exactly where the need ends. That
        // is why nothing here peeks or takes across the need span.
        //
        // `relocations`/`migrated`/`stranded` bound each line's relocations
        // (see MAX_RELOCATIONS; one migration, one strand), so this can
        // never loop; the oversize give-up stays raw (Phase 5 scope).
        let relocations = 0;
        let migrated = false;
        let stranded = false;
        // The line frame's page-top identity for `may_progress`: a block
        // break lands on the paragraph (or its owning list item), a line
        // break on the line itself.
        const framePos = k === 0 ? (owner?.pos ?? pos) : lineTops[k].pos;
        const frameY = k === 0 ? (owner?.y ?? yTop) : lineTops[k].y;
        loop: for (;;) {
          // STAGE 1 — pre-insertion: reservation only from entries already
          // committed on this page (pageFnH), none from this line yet.
          const bottomPre = bottomFor();
          const ownPre = y + lineTop + shift + heights[k] <= bottomPre + FIT_TOLERANCE_PX;
          const needPre = y + lineTop + shift + needs[k] <= bottomPre + FIT_TOLERANCE_PX;
          if (!ownPre || !needPre) {
            // `Distributor::line` (distribute.rs:226-245): own height
            // failing finishes the region iff `may_progress()`; need failing
            // (own height fits) finishes iff the NEXT raw region fits the
            // need. Pages are uniform, so when progress is impossible the
            // next region is this one and neither test can pass.
            const finish = mayProgressAt(framePos) && (!ownPre || needs[k] <= contentH + FIT_TOLERANCE_PX);
            if (!finish || migrated || stranded || relocations >= MAX_RELOCATIONS) {
              // Typst places the line and lets it overflow (a fresh page
              // can't help: at the page top, or oversize), or this ledger's
              // relocation budget is spent: insert its own notes below it
              // (a negative pod queues them whole).
              commitFootnotes(lineEnd, lineBottom);
              break loop;
            }
            relocations++;
            if (k === 0 && segStart === 0) {
              // The paragraph's absolute start doesn't fit (alone, or with
              // the orphan-protected partner it needs): the whole paragraph
              // moves to the next page, sticky heading run and all —
              // `line()` fails before `frame()` ever clears the sticky
              // snapshot, and `finalize` restores it (distribute.rs:453-457).
              finishBefore(framePos, frameY, 'block');
            } else {
              // Break exactly before line k: this defers it — and, when
              // `need` covers a partner beyond k (the widow pair), that
              // partner too — to a fresh page. No retroactive pull-back to
              // k-1 is needed: `need` already grouped the pair before
              // either line's placement was decided. No checkpoint can be
              // live here (line 0 anchored it), so this never restores.
              finishBefore(framePos, frameY, 'line');
              segStart = k;
            }
            continue loop;
          }
          // `frame()` (distribute.rs:363-369): a non-empty line anchors the
          // heading run above — BEFORE its footnotes are handled (:372).
          // The footnote relayout (compose.rs:165-216) re-runs the region
          // and would checkpoint that run afresh; remember it for STAGE 2.
          const relayoutRestore = stickyRelayoutCheckpoint(stickyState);
          stickyFrameAt(false, framePos, frameY, isEmptyLine(k));
          // MIGRATION — the first note's first frame would be empty here.
          if (!migrated && footnoteMigrates(lineEnd, lineBottom(), heights[k], !mayProgressAt(framePos))) {
            migrated = true;
            // Whole paragraph (or line k) onward, heading left behind: the
            // sticky snapshot was dropped for this non-sticky frame before
            // `footnotes()` raised the finish, so `finishBefore` has nothing
            // to restore — but a snapshot may be live for an empty line 0.
            if (k === 0 && segStart === 0) {
              finishBefore(framePos, frameY, 'block');
            } else {
              finishBefore(framePos, frameY, 'line');
              segStart = k;
            }
            continue loop;
          }
          // INSERTION — this line's entries, below its bottom.
          commitFootnotes(lineEnd, lineBottom);
          // STAGE 2 — post-insertion recheck: the relayout Typst performs
          // once the entries are in the region. Own height is re-checked
          // for robustness only; the pod arithmetic guarantees it.
          const bottomPost = bottomFor();
          const ownPost = y + lineTop + shift + heights[k] <= bottomPost + FIT_TOLERANCE_PX;
          const needPost = y + lineTop + shift + needs[k] <= bottomPost + FIT_TOLERANCE_PX;
          if (ownPost && needPost) break loop;
          const triggerPost = ownPost ? needs[k] : heights[k];
          if (stranded || (ownPost && triggerPost > contentH + FIT_TOLERANCE_PX)) {
            // The need can never fit any raw page (Typst places the line,
            // splitting the pair — distribute.rs:237-245's condition goes
            // false and falls through to frame()), or this line already
            // stranded once: it stays here, above its own entries.
            break loop;
          }
          // Strand: the entries stay committed on THIS page (breakBefore
          // resets pageFnH only after they were charged) while the line —
          // and its protected partner — migrate to a raw fresh page.
          stranded = true;
          if (k === 0 && segStart === 0) {
            // A strand at the paragraph's absolute start is a region finish
            // from `line()` in the RELAYOUT, before `frame()`: the fresh
            // distributor checkpointed the heading run sitting directly
            // above (with progress now possible — the insertions shrank the
            // pod — even when the run sits at the page top), so the run
            // migrates along with the paragraph (the entries stay).
            regionFinish(relayoutRestore, framePos, frameY, 'block');
          } else {
            regionFinish(null, framePos, frameY, 'line');
            segStart = k;
          }
          continue loop;
        }
      }
    };

    // Lists and blockquotes break between children (whole child moves).
    const container = (pos: number, node: PMNode) => {
      const endPos = pos + node.nodeSize;
      const r = rectOf(pos);
      if (!r) {
        commitFootnotes(endPos, () => null);
        return;
      }
      // A container is a breakable frame: each entry's flow need is its own
      // marker line, not the container's height. Both fast paths here use
      // the conservative whole-entry peek (see `bottomFor`) — a container
      // that fits with its entries charged whole fits after the relayout its
      // commitment implies; otherwise the per-child walk decides.
      const markerNeed = (fnPos: number) => markerLineTop(fnPos, null) + shift;
      const yTop = stackY(r.top, pos);
      if (yTop + shift + r.height - bottomInsetFor(pos) <= bottomFor(peekFnH(endPos)) + FIT_TOLERANCE_PX) {
        // The container's (only) frame is non-sticky and non-empty: it
        // anchors a heading run above (distribute.rs:363-369).
        stickyFrameAt(false, pos, yTop);
        commitFootnotes(endPos, markerNeed);
        return;
      }
      // A container is a breakable block (`Distributor::multi`,
      // distribute.rs:277-307). Its first frame is empty exactly when the
      // FIRST child cannot start on this page — then the whole child
      // finishes the region (:286-294) and a heading run above restores
      // with it. Once any child (or any line of one) is placed, that frame
      // anchored the run, and every later break inside the container leaves
      // the heading behind. The per-child walk below reproduces this
      // through the same `stickyFrameAt`/`finishBefore` calls the top-level
      // blocks make: no state reset is needed here.
      node.forEach((child, offset) => {
        const childPos = pos + 1 + offset;
        const childEnd = childPos + child.nodeSize;
        const cr = rectOf(childPos);
        if (!cr || cr.height === 0) {
          commitFootnotes(childEnd, () => null);
          return;
        }
        const y = stackY(cr.top, childPos);
        if (y + shift + cr.height - bottomInsetFor(childPos) <= bottomFor(peekFnH(childEnd)) + FIT_TOLERANCE_PX) {
          // A child placed whole is a non-empty frame of the container: it
          // anchors a heading run above, so a later child's break stays
          // inside the container (distribute.rs:363-369).
          stickyFrameAt(false, childPos, y);
          commitFootnotes(childEnd, markerNeed);
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
        // Anything the recursion did not consume (a child kind that returned
        // early without geometry) is charged in full, as before.
        commitFootnotes(childEnd, () => null);
      });
      commitFootnotes(endPos, () => null);
    };

    // ---- PAGE-PORT.md Phase 7: native tables break BETWEEN rows ----------
    /** A native table is one editable node that Typst's grid layouter breaks
     *  at row boundaries (never inside a row here — a cell split across
     *  regions is not mirrored, and the oracle fails closed on it). The pure
     *  walk lives in src/layout/table-rows.ts with its Typst citations; this
     *  closure only measures the rows (DOM heights, natural coordinates) and
     *  replays the plan through the same page-advance primitives every other
     *  unit uses. A 'row' spacer's widget carries the gap plus the repeated
     *  header copy (table-break-widget.ts). Fail open: a captioned table (a
     *  figure), a sub-header, or a rowspan across a boundary the walk would
     *  break at keeps today's atomic placement. */
    const table = (pos: number, node: PMNode) => {
      const endPos = pos + node.nodeSize;
      const r = rectOf(pos);
      if (!r || r.height === 0) {
        commitFootnotes(endPos, () => null);
        return;
      }
      const y = stackY(r.top, pos);
      // Whole-table fast path (conservative footnote peek, as for atoms):
      // one non-sticky, non-empty frame that anchors a heading run above.
      if (y + shift + r.height <= bottomFor(peekFnH(endPos)) + FIT_TOLERANCE_PX) {
        stickyFrameAt(false, pos, y);
        commitFootnotes(endPos, () => y + shift + r.height);
        return;
      }
      const model = tableRowModel(node);
      if (model.atomicReason) return atomic(pos, node);
      const rows: MeasuredRow[] = [];
      for (const off of model.rowOffsets) {
        const rr = rectOf(pos + off);
        if (!rr) return atomic(pos, node);
        rows.push({ top: stackY(rr.top, pos + off) - y, height: rr.height });
      }
      // Content capacity of the k-th continuation page: a pure replay of
      // the footnote-carry settling `startPageFootnotes` performs on each
      // page advance below, so the plan sees exactly the space the replay
      // will have (cells hold no footnote markers, so nothing else moves).
      const capacity = (k: number) => {
        let carry = fnCarry;
        let cost = 0;
        for (let i = 0; i < k; i++) {
          const settled = settleFootnoteCarry(carry, contentH, F);
          carry = settled.carry;
          cost = settled.placed.reduce((sum, fragment) => sum + footnoteEntryCost(fragment, F), 0);
        }
        return contentH - (cost > 0 ? cost + footnoteHeadReservePx(F) : 0);
      };
      const plan = planTableRowBreaks(model, rows, bottomFor() - (y + shift), capacity, mayProgressAt(pos), FIT_TOLERANCE_PX);
      if (plan.kind === 'atomic') return atomic(pos, node);
      let placedFirst = false;
      for (const brk of plan.breaks) {
        if (brk.kind === 'start') {
          // The table's first region frame would be empty: `Distributor::
          // multi` finishes the region before `frame()` ever runs
          // (flow/distribute.rs:286-294), so a live sticky checkpoint (a
          // heading run above) restores and migrates with the table.
          finishBefore(pos, y, 'block');
        } else {
          if (!placedFirst) {
            // Rows were placed on this page: the table's first frame is a
            // non-sticky, non-empty frame that anchors any heading run
            // above (distribute.rs:363-369) before the spill finishes the
            // region (:300-304) — the heading stays behind.
            stickyFrameAt(false, pos, y);
            placedFirst = true;
          }
          const rowPos = pos + model.rowOffsets[brk.row];
          breakBefore(rowPos, y + rows[brk.row].top, 'row', brk.headerHeight);
          // The continuation is the new page's first frame (`multi_spill`,
          // :310-330, non-sticky): a fresh distributor sees nothing to
          // anchor, and this keeps the state honest for what follows.
          stickyFrameAt(false, rowPos, y + rows[brk.row].top);
          placedFirst = true;
        }
      }
      if (!placedFirst) stickyFrameAt(false, pos, y);
      commitFootnotes(endPos, () => null);
    };
    // ---- end Phase 7 table branch ----------------------------------------

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
          table(pos, node);
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
          commitFootnotes(offset + node.nodeSize, () => null);
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
          table(offset, node);
          break;
        default:
          // Headings are sticky by default (heading.rs:294); only top-level
          // ones are modeled — a heading nested in a list item or quote
          // lives in a nested flow and fails open as an ordinary block.
          atomic(offset, node, undefined, node.type.name === 'heading');
          break;
      }
    });

    return { spacers, count: page + 1, visitedUnits, anchors };
  }





  /**
   * Position footnote bodies at the bottom of the page their marker landed
   * on (final geometry, after spacers). Presentation-only DOM styling; the
   * node views ignore these attribute mutations.
   *
   * KNOWN RESIDUE (footnote spill, PAGE-PORT.md Phase 4): the fallback
   * paginator's ledger now models Typst's entry SPILL — an entry that cannot
   * fit beside its marker charges only its first fragment to the marker's
   * page and carries the rest onto following pages. Painting is NOT split:
   * every `.fn-body` is still painted whole, grouped by its marker's page,
   * so on a page where an entry spilled the painted stack is taller than the
   * reserved area and rises above it. Page STARTS (the parity target) are
   * correct; the visual is not, until split painting lands.
   */
  private placeFootnotes(count: number) {
    const view = this.view;
    const s = getSettings(view.state);
    const size = pageSize(s);
    const marginBottom = s.marginBottom * 96;
    const host = view.dom.parentElement ?? view.dom;
    const stackTop = host.getBoundingClientRect().top;
    const F = this.bodyPx();

    // Frames, as the paginator reserved them (footnoteFrameInsetsEm): the
    // painted box is offset so its cap top lands on the frame top.
    const fnInsets = footnoteFrameInsetsEm(s);
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
        list.push({ el: body, height: Math.max(0, body.offsetHeight - fnInsets.leading * F) });
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
        const y = entryTops[i] - fnInsets.top * F - pmOffset;
        // Hysteresis: sub-pixel re-measurements must not nudge the body.
        const prev = parseFloat(f.el.style.top);
        if (!(Math.abs(prev - y) < 0.75)) f.el.style.top = `${y.toFixed(1)}px`;
        f.el.classList.toggle('fn-first', i === 0);
        f.el.style.visibility = 'visible';
      });
    }
  }
}
