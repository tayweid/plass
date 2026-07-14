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
// Scheduling (spec §3.6): edits render immediately with browser layout (the
// optimistic echo — stale decorations are mapped forward, so the paragraph
// keeps its last typeset shape); the oracle re-runs on the next animation
// frame. Each run is two dispatches in one task (no intermediate paint):
// first the line layout, then — after measuring the resulting natural
// geometry — the page-break spacers.
//
// Pagination model: the document stays one continuous editable flow; page
// boxes are painted behind it (see #pages in main.ts), and exact-height
// spacers push content past each page boundary. Between blocks the spacer is
// an ordinary div; inside a paragraph it is a block-in-inline div sitting at
// an oracle-chosen line break (the div itself forces the break, so it simply
// replaces the <br> widget). Print needs no JS: print CSS zeroes the spacer
// heights (line breaks survive, gaps vanish) and @page takes over.

import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { Measurer } from './layout/measure';
import { layoutBlock, type LineLayout } from './layout/paragraph';
import { buildSpec, TypstOracle, type AtomResolver, type SpecKind } from './layout/typst-oracle';
import { portBreaks } from './layout/port/adapter';
import { loadPrimitives, primitives } from './layout/primitives';
import { PageOracle } from './layout/page-oracle';
import { getSettings, PAGE_GAP, pageSize, parseMathMacros } from './settings';
import { docToTyp, escapeTyp, expandMacrosWith, pageTopAdjustEm } from './typ-serializer';
import { FONT_FALLBACK } from './pdf';
import { citeOrder } from './citations';
import { eqKey } from './equations';

/** Phase-3 flag (PORT.md): drive live typing with the ported Typst
 * breaker. Console: __usePort(false) to A/B against the legacy path;
 * __portStats() reports how often each path ran. */
let USE_PORT = true;
let portHits = 0;
let legacyHits = 0;
let adapterNulls = 0;
let partitionMisses = 0;
if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __usePort: (v: boolean) => void;
    __portStats: () => { port: number; legacy: number };
  };
  w.__usePort = (v) => {
    USE_PORT = v;
  };
  w.__portStats = () => ({ port: portHits, legacy: legacyHits, adapterNulls, partitionMisses });
}

/** Fonts with editor↔Typst parity; the oracle only runs for these. */
const ORACLE_FONTS = new Set(['New Computer Modern', 'STIX Two Text', 'Libertinus Serif']);

export interface TypesetStats {
  ms: number;
  paragraphs: number;
  lines: number;
}

export interface PageInfo {
  count: number;
  pageW: number;
  pageH: number;
  gap: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

interface TypesetState {
  decos: DecorationSet;
  /** Zero-width markers at the last oracle page starts — PM maps them
   *  through every edit, giving stale-but-stable pagination while the
   *  page oracle recompiles. Never rendered. */
  pageMarks: DecorationSet;
}

type Meta =
  | { type: 'decos'; decos: DecorationSet; pageMarks?: DecorationSet }
  | { type: 'pageMarks'; pageMarks: DecorationSet };

interface Spacer {
  pos: number;
  height: number;
  kind: 'line' | 'block';
}

export const typesetKey = new PluginKey<TypesetState>('typeset');

/** Vertical gap between stacked footnote bodies / height of the separator zone (px). */
const FN_GAP = 6;
const FN_SEP = 30;

const viewRegistry = new WeakMap<EditorView, TypesetView>();

/** keyTag for the compare hook, matching layoutInto's scheme. */
function indentedTag(settings: { parIndent: boolean }, doc: PMNode, pos: number): string {
  return settings.parIndent && consecutivePara(doc, pos) ? 'pi' : 'p';
}

/** Whether the paragraph at pos directly follows a sibling paragraph
 * (Typst's condition for the first-line indent in classic mode). */
function consecutivePara(doc: PMNode, pos: number): boolean {
  const $pos = doc.resolve(pos);
  const idx = $pos.index();
  return idx > 0 && $pos.parent.child(idx - 1).type.name === 'paragraph';
}

/** Bounding rect of the node at a position, if it has a DOM element. */
function rectOfNode(view: EditorView, pos: number): DOMRect | null {
  const el = view.nodeDOM(pos);
  return el instanceof HTMLElement ? el.getBoundingClientRect() : null;
}

/** Canvas text width at an exact CSS font (for painted-prefix modeling). */
const measureCtx = document.createElement('canvas').getContext('2d')!;
function textWidth(text: string, font: string): number {
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

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
      init: () => ({ decos: DecorationSet.empty, pageMarks: DecorationSet.empty }),
      apply(tr, val) {
        const meta = tr.getMeta(typesetKey) as Meta | undefined;
        if (meta?.type === 'decos') {
          return { decos: meta.decos, pageMarks: meta.pageMarks ?? val.pageMarks.map(tr.mapping, tr.doc) };
        }
        if (meta?.type === 'pageMarks') return { decos: val.decos, pageMarks: meta.pageMarks };
        if (tr.docChanged) {
          return { decos: val.decos.map(tr.mapping, tr.doc), pageMarks: val.pageMarks.map(tr.mapping, tr.doc) };
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

interface CacheEntry {
  measure: number;
  lines: LineLayout[];
  /** Which oracle state produced these lines ('none' = JS Knuth-Plass). */
  oracle: 'none' | 'ok' | 'fail';
  /** Painted-prefix indent + em scale the lines were computed with (captions,
   *  footnote bodies) — early runs can measure these before widgets paint. */
  indent: number;
  scale: number;
}

class TypesetView {
  private cache = new WeakMap<PMNode, CacheEntry>();
  private docSig = new WeakMap<PMNode, string>();
  private measurer: Measurer;
  private oracle: TypstOracle;
  private pageOracle: PageOracle;
  private raf = 0;
  private liveRaf = 0;
  /** Signature of the last dispatched decoration set: identical layouts are
   *  never re-dispatched, so no-op runs cause zero paints. */
  private lastDecoSig = '';
  private lastLiveDoc: PMNode | null = null;
  private editTimer = 0;
  private lastPageCount = 0;
  private pendingPageMarks: DecorationSet | null = null;
  private resizeObserver: ResizeObserver;
  private lastWidth = 0;
  private destroyed = false;

  constructor(
    private view: EditorView,
    private opts: { onStats?: (s: TypesetStats) => void; onPages?: (p: PageInfo) => void },
  ) {
    viewRegistry.set(view, this);
    this.measurer = new Measurer(view.dom);
    // The ported Typst line breaker (PORT.md): loads the sidecar WASM +
    // fonts in the background; until ready, liveRun uses the legacy path.
    loadPrimitives().catch((e) => console.warn('sidecar primitives failed to load', e));
    this.oracle = new TypstOracle(() => {
      if (!this.destroyed) this.schedule();
    }, FONT_FALLBACK);
    this.pageOracle = new PageOracle(() => {
      if (!this.destroyed) this.schedule();
    });
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __oracle?: TypstOracle;
        __pageOracle?: PageOracle;
        __breakSig?: () => string;
      };
      w.__oracle = this.oracle;
      w.__pageOracle = this.pageOracle;
      (w as unknown as { __comparePort: () => unknown }).__comparePort = () => {
        const state = this.view.state;
        const settings = getSettings(state);
        const resolveAtom = this.atomResolver();
        const settingsSig = `${settings.font}|${settings.sizePt}|${settings.lineHeight}|${settings.hyphenate}|${settings.parIndent}`;
        const out: unknown[] = [];
        state.doc.descendants((node, pos) => {
          if (!node.isTextblock || node.type.name !== 'paragraph') return true;
          const el = this.view.nodeDOM(pos);
          if (!(el instanceof HTMLElement)) return false;
          const cs = getComputedStyle(el);
          const measure = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          const spec = buildSpec(node, resolveAtom);
          if (!spec) return false;
          const okey = `${settingsSig}|${indentedTag(settings, state.doc, pos)}|w${measure.toFixed(1)}|${spec.key}`;
          const oentry = this.oracle.get(okey);
          const atomWidth = (offset: number, child: PMNode) => {
            const dom = this.view.nodeDOM(pos + 1 + offset);
            return dom instanceof HTMLElement ? dom.getBoundingClientRect().width : child.nodeSize * 8;
          };
          const indented = settings.parIndent && consecutivePara(state.doc, pos);
          const port = portBreaks(node, measure, atomWidth, {
            sizePt: settings.sizePt,
            hyphenate: settings.hyphenate,
            firstLineIndentPx: indented ? 1.5 * this.bodyPx() : undefined,
            atomWidthPt: this.typstAtomWidthPt(),
          });
          const fmt = (b: { at: number; hyphen: boolean }[] | null | undefined) =>
            b ? b.map((x) => (x.hyphen ? 'hy' : 'br') + x.at).join(',') : String(b);
          if (oentry?.status === 'ok' && port && fmt(oentry.breaks) !== fmt(port)) {
            out.push({ pos, text: node.textContent.slice(0, 40), oracle: fmt(oentry.breaks), port: fmt(port) });
          }
          return false;
        });
        return out;
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
    }
    this.resizeObserver = new ResizeObserver(() => {
      const w = this.view.dom.clientWidth;
      if (Math.abs(w - this.lastWidth) > 0.5) {
        this.lastWidth = w;
        this.schedule();
      }
    });
    this.resizeObserver.observe(view.dom);
    this.lastWidth = view.dom.clientWidth;

    // Web fonts arriving change every metric: flush and re-run.
    document.fonts?.ready.then(() => {
      if (this.destroyed) return;
      this.measurer.invalidate();
      this.cache = new WeakMap();
      this.schedule();
    });

    this.schedule();
  }

  update(view: EditorView, prevState: EditorState) {
    // Document settings (font, size, hyphenation, …) invalidate every metric.
    if (view.state.doc.attrs !== prevState.doc.attrs) {
      this.measurer.invalidate();
      this.cache = new WeakMap();
      this.oracle.clear();
      this.pageOracle.clear();
    }
    if (view.state.doc !== prevState.doc) {
      this.scheduleLive();
      this.scheduleAfterEdit();
    }
  }

  /** Re-typeset just the edited blocks with the JS Knuth-Plass breaker IN
   *  THE SAME PAINT as the keystroke (microtask: after ProseMirror's DOM
   *  update, before the browser renders). The corruption once blamed on
   *  this timing was the frozen-prefix bug, since identified and fixed. */
  private scheduleLive() {
    if (this.liveRaf) return;
    this.liveRaf = 1;
    queueMicrotask(() => {
      this.liveRaf = 0;
      this.liveRun();
    });
  }

  private liveRun() {
    if (this.destroyed) return;
    const state = this.view.state;
    const prev = this.lastLiveDoc;
    this.lastLiveDoc = state.doc;
    if (!prev || prev === state.doc) return;
    // The doc changed: no previously-dispatched layout may be considered
    // current, whatever path we take out of here.
    this.lastDecoSig = '';
    const start = prev.content.findDiffStart(state.doc.content);
    if (start == null) return;
    const endDiff = prev.content.findDiffEnd(state.doc.content);
    const from = Math.min(start, state.doc.content.size);
    const to = Math.min(Math.max(endDiff ? endDiff.b : start, from), state.doc.content.size);

    const settings = getSettings(state);
    const blocks: Array<{ node: PMNode; pos: number; para: boolean }> = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'table') return false;
      if (node.isTextblock) {
        blocks.push({ node, pos, para: node.type.name === 'paragraph' });
        return false;
      }
      return true;
    });
    // Edits inside a footnote body: the body block is nested inline content.
    const $from = state.doc.resolve(from);
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'footnote') {
        blocks.push({ node: $from.node(d), pos: $from.before(d), para: false });
        break;
      }
    }
    if (!blocks.length) return;

    let decos = typesetKey.getState(state)?.decos ?? DecorationSet.empty;
    const fresh: Decoration[] = [];
    for (const b of blocks) {
      const blockTo = b.pos + 1 + b.node.content.size;
      // Footnote bodies are DOM-nested inside the paragraph: their break +
      // justification decorations must survive the strip, or the footnote
      // visibly re-wraps on every keystroke in its anchor paragraph.
      const fnSpans: Array<[number, number]> = [];
      if (b.para) {
        b.node.forEach((child, offset) => {
          if (child.type.name === 'footnote') {
            fnSpans.push([b.pos + 1 + offset, b.pos + 1 + offset + child.nodeSize]);
          }
        });
      }
      const stale = decos
        .find(b.pos, blockTo, (spec) => {
          const key = (spec as { key?: string } | null)?.key;
          return !key || /^(br|hy):/.test(key);
        })
        .filter((d) => !fnSpans.some(([a, z]) => d.from >= a && d.from < z));
      // remove() nulls out entries of the array it's given — pass a copy,
      // stale is read again below for the frozen prefix.
      if (stale.length) decos = decos.remove(stale.slice());
      // Non-paragraph blocks (captions, footnote bodies) fall back to CSS
      // justification while live; paragraphs get instant KP.
      if (!b.para || b.node.content.size === 0) continue;
      const liveIndent =
        settings.parIndent && consecutivePara(state.doc, b.pos) ? 1.5 * this.bodyPx() : undefined;
      const el = this.view.nodeDOM(b.pos);
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      const measure = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (!(measure > 60)) continue;
      const atomWidth = (offset: number, child: PMNode) => {
        const dom = this.view.nodeDOM(b.pos + 1 + offset);
        if (dom instanceof HTMLElement) return dom.getBoundingClientRect().width;
        return child.nodeSize * 8;
      };
      // The ported Typst breaker: full-paragraph, globally optimal, and
      // identical to what the oracle will confirm. Plain KP is the
      // degraded-mode fallback (sidecar not loaded, unmapped content).
      let lines: LineLayout[] | null = null;
      if (USE_PORT && primitives()) {
        try {
          const forced = portBreaks(b.node, measure, atomWidth, {
            sizePt: settings.sizePt,
            hyphenate: settings.hyphenate,
            firstLineIndentPx: liveIndent,
            atomWidthPt: this.typstAtomWidthPt(),
          });
          if (forced) {
            lines = layoutBlock(b.node, measure, this.measurer, atomWidth, {
              hyphenate: settings.hyphenate,
              firstLineIndent: liveIndent,
              forced,
            });
            if (lines) portHits++;
            else partitionMisses++;
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
          firstLineIndent: liveIndent,
        });
      }
      if (!lines) continue;
      const base = b.pos + 1;
      // Page spacers glued to mapped text positions break lines MID-LINE
      // once the paragraph re-wraps around an edit above them. Strip them
      // here and re-emit each at the nearest freshly-chosen break (same
      // height — geometry stays stale-but-stable until repagination).
      const pgStale = decos.find(b.pos, blockTo, (spec) => {
        const key = (spec as { key?: string } | null)?.key;
        return !!key && key.startsWith('pg:');
      });
      let pgList = pgStale.map((d) => ({
        from: d.from,
        h: (d.spec as { h?: number }).h ?? 0,
        hy: !!(d.spec as { hy?: boolean }).hy,
      }));
      if (pgStale.length) decos = decos.remove(pgStale.slice());
      const fnRanges: Array<[number, number]> = [];
      b.node.forEach((child, offset) => {
        if (child.type.name === 'footnote') fnRanges.push([offset, offset + child.nodeSize]);
      });
      for (const line of lines) {
        if (Math.abs(line.spacing) > 0.01 && line.to > line.from) {
          const style = `word-spacing:${line.spacing.toFixed(3)}px`;
          let cur = line.from;
          for (const [a2, b2] of fnRanges) {
            if (b2 <= cur || a2 >= line.to) continue;
            if (a2 > cur) fresh.push(Decoration.inline(base + cur, base + a2, { style }, { sig: style }));
            cur = Math.max(cur, b2);
          }
          if (cur < line.to) fresh.push(Decoration.inline(base + cur, base + line.to, { style }, { sig: style }));
        }
        if (line.breakPos !== null) {
          const at = base + line.breakPos;
          // A spacer whose text position falls on this line moves to the
          // line's break: pages only break at line boundaries.
          const spIdx = pgList.findIndex((sp) => sp.from > base + line.from - 1 && sp.from <= at + 2);
          if (spIdx >= 0) {
            const sp = pgList[spIdx];
            pgList = pgList.filter((_, i) => i !== spIdx);
            fresh.push(
              Decoration.widget(at, () => pageGapWidget(sp.h, line.hyphen), {
                side: -1,
                key: `pg:${at}:${Math.round(sp.h)}:${line.hyphen ? 'h' : ''}`,
                h: sp.h,
                hy: line.hyphen,
              }),
            );
          } else {
            fresh.push(
              Decoration.widget(at, line.hyphen ? hyphenWidget : brWidget, {
                side: -1,
                key: `${line.hyphen ? 'hy' : 'br'}:${at}`,
              }),
            );
          }
        }
      }
      // Spacers past the last chosen break (the page split the final line,
      // which has since re-wrapped): snap to the block boundary — pages
      // only break at line boundaries, and repagination corrects at settle.
      for (const sp of pgList) {
        const at = Math.min(sp.from, blockTo - 1) === sp.from && sp.from < blockTo ? blockTo - 1 : sp.from;
        fresh.push(
          Decoration.widget(at, () => pageGapWidget(sp.h, false), {
            side: -1,
            key: `pg:${at}:${Math.round(sp.h)}:`,
            h: sp.h,
            hy: false,
          }),
        );
      }
    }
    const set = fresh.length ? decos.add(state.doc, fresh) : decos;
    const tr = state.tr.setMeta(typesetKey, { type: 'decos', decos: set } satisfies Meta);
    tr.setMeta('addToHistory', false);
    this.view.dispatch(tr);
  }

  /** Doc edits settle after a pause: during a typing burst the existing
   *  decorations (line breaks, page spacers) map through each keystroke —
   *  stale but STABLE — instead of re-typesetting per key and ping-ponging
   *  between the JS fallback and the oracle. */
  private scheduleAfterEdit() {
    clearTimeout(this.editTimer);
    this.editTimer = window.setTimeout(() => {
      this.editTimer = 0;
      this.schedule();
    }, 250);
  }

  destroy() {
    this.destroyed = true;
    viewRegistry.delete(this.view);
    this.resizeObserver.disconnect();
    clearTimeout(this.editTimer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.oracle.destroy();
    this.pageOracle.destroy();
    this.measurer.destroy();
  }

  /** Drop cached page-break decisions (asset bytes changed under same sig). */
  invalidatePages() {
    this.pageOracle.clear();
  }

  requestRun() {
    this.schedule();
  }

  private schedule() {
    // Mid-burst triggers (oracle results, figure loads) coalesce into the
    // settle run — running them immediately would re-typeset under the
    // user's fingers.
    if (this.editTimer) return;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.run();
    });
  }

  /** The page spacers currently in the document, read back from the live
   *  decoration set (they carry their height in spec.h). */
  private currentSpacers(): { lineMap: Map<number, Spacer>; blocks: Spacer[]; sorted: Array<{ pos: number; height: number }> } {
    const set = typesetKey.getState(this.view.state)?.decos;
    const lineMap = new Map<number, Spacer>();
    const blocks: Spacer[] = [];
    const sorted: Array<{ pos: number; height: number }> = [];
    for (const d of set?.find(undefined, undefined, (spec) => {
      const k = (spec as { key?: string } | null)?.key;
      return !!k && k.startsWith('pg');
    }) ?? []) {
      const spec = d.spec as { key?: string; h?: number };
      const h = spec.h ?? 0;
      if (!(h > 0)) continue;
      if (spec.key?.startsWith('pgb:')) blocks.push({ pos: d.from, height: h, kind: 'block' });
      else lineMap.set(d.from, { pos: d.from, height: h, kind: 'line' });
      sorted.push({ pos: d.from, height: h });
    }
    sorted.sort((a, b) => a.pos - b.pos);
    return { lineMap, blocks, sorted };
  }

  /** Cumulative existing-spacer height above a document position. */
  private static spacersAbove(sorted: Array<{ pos: number; height: number }>, pos: number): number {
    let h = 0;
    for (const sp of sorted) {
      if (sp.pos <= pos) h += sp.height;
      else break;
    }
    return h;
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
    this.lastLiveDoc = this.view.state.doc;

    const t0 = performance.now();
    this.applyTopAdjust();

    // Pass 1: line layout with the CURRENT page spacers kept in place — in
    // the quiescent case this set equals the live one and the signature
    // suppresses the dispatch entirely (zero DOM writes, zero reflows).
    // Pagination then measures through the spacers by subtracting them.
    const held = this.currentSpacers();
    const stats = this.dispatchDecos(held.lineMap, held.blocks);

    // Pass 2: measure natural geometry, compute page breaks, re-dispatch with
    // spacers. Both dispatches share one task, so nothing paints in between.
    const { spacers, count } = this.paginate();
    if (spacers.length) {
      const lineSpacers = new Map<number, Spacer>();
      const blockSpacers: Spacer[] = [];
      for (const sp of spacers) (sp.kind === 'line' ? lineSpacers.set(sp.pos, sp) : blockSpacers.push(sp));
      this.dispatchDecos(lineSpacers, blockSpacers);
    }

    // Single-page runs skip the second dispatch — flush pending markers.
    if (this.pendingPageMarks) {
      const set = this.pendingPageMarks;
      this.pendingPageMarks = null;
      const tr = this.view.state.tr.setMeta(typesetKey, { type: 'pageMarks', pageMarks: set } satisfies Meta);
      tr.setMeta('addToHistory', false);
      this.view.dispatch(tr);
    }

    this.placeFootnotes(count);

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
    this.opts.onStats?.({ ms: performance.now() - t0, paragraphs: stats.paragraphs, lines: stats.lines });
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
    let order: Map<string, number> | null = null;
    let labels: Map<string, string> | null = null;
    let fnNums: WeakMap<PMNode, number> | null = null;
    const upem = prim.upem('regular');
    const shapeW = (text: string, sizePt: number) => {
      let em = 0;
      for (const g of prim.shape('regular', text)) em += g.xAdvance / upem;
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
          const sup = prim.superscriptHeight('regular') || 0.6;
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
    const order = citeOrder(state.doc);
    const macros = parseMathMacros(getSettings(state).mathMacros);
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
          return { markup: '#mi(`' + expandMacrosWith(child.attrs.src as string, macros) + '`)' };
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
    const layoutOpts = { hyphenate: settings.hyphenate };
    const useOracle = ORACLE_FONTS.has(settings.font);
    const resolveAtom = useOracle ? this.atomResolver() : null;
    const settingsSig = `${settings.font}|${settings.sizePt}|${settings.lineHeight}|${settings.hyphenate}|${settings.parIndent}`;
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
      const atomWidth = (offset: number, child: PMNode) => {
        const dom = this.view.nodeDOM(pos + 1 + offset);
        if (dom instanceof HTMLElement) return dom.getBoundingClientRect().width;
        // Fallback estimate if the atom has no DOM yet.
        return child.nodeSize * 8;
      };

      // Ask the Typst oracle for this block's authoritative breaks.
      const spec = resolveAtom ? buildSpec(node, resolveAtom) : null;
      const okey = spec ? `${settingsSig}|${keyTag}|w${measure.toFixed(1)}|${spec.key}` : null;
      const oentry = okey ? this.oracle.get(okey) : undefined;
      if (spec && okey && !oentry) {
        const indented = skind.kind === 'body' && !!extra.firstLineIndent;
        this.oracle.request(okey, spec, measure, settings, skind, indented);
      }
      const ostatus = oentry?.status ?? 'none';

      const indent = extra.firstLineIndent ?? 0;
      const scale = extra.scale ?? 1;
      let entry = this.cache.get(node);
      if (
        !entry ||
        Math.abs(entry.measure - measure) > 0.5 ||
        entry.oracle !== ostatus ||
        Math.abs(entry.indent - indent) > 0.5 ||
        Math.abs(entry.scale - scale) > 0.01
      ) {
        let lines: LineLayout[] | null = null;
        if (oentry?.status === 'ok') {
          lines = layoutBlock(node, measure, this.measurer, atomWidth, {
            ...layoutOpts,
            ...extra,
            forced: oentry.breaks,
          });
        }
        // The ported Typst breaker stands in wherever the compiled oracle
        // has no answer (pending, failed to match, or its breaks don't
        // partition) — the port IS the same algorithm, computed locally.
        if (!lines && USE_PORT && primitives()) {
          try {
            const forced = portBreaks(node, measure, atomWidth, {
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
              lines = layoutBlock(node, measure, this.measurer, atomWidth, {
                ...layoutOpts,
                ...extra,
                forced,
              });
            }
          } catch (e) {
            if (import.meta.env.DEV) console.warn('port breaker (settle) failed', e);
          }
        }
        if (!lines) lines = layoutBlock(node, measure, this.measurer, atomWidth, { ...layoutOpts, ...extra })!;
        entry = { measure, lines, oracle: ostatus, indent, scale };
        this.cache.set(node, entry);
      }

      paragraphs++;
      lineCount += entry.lines.length;
      emitLines(node, pos, entry.lines);
    };

    /** Emit line decorations (spacing + break widgets), skipping footnote
     *  children — inline decos descend into nested editable content. */
    const emitLines = (node: PMNode, pos: number, lines: LineLayout[]) => {
      const base = pos + 1;
      const fnRanges: Array<[number, number]> = [];
      node.forEach((child, offset) => {
        if (child.type.name === 'footnote') fnRanges.push([offset, offset + child.nodeSize]);
      });
      const emitSpacing = (from: number, to: number, style: string) => {
        let cur = from;
        for (const [a, bEnd] of fnRanges) {
          if (bEnd <= cur || a >= to) continue;
          if (a > cur) decos.push(Decoration.inline(base + cur, base + a, { style }, { sig: style }));
          cur = Math.max(cur, bEnd);
        }
        if (cur < to) decos.push(Decoration.inline(base + cur, base + to, { style }, { sig: style }));
      };
      for (const line of lines) {
        if (Math.abs(line.spacing) > 0.01) {
          emitSpacing(line.from, line.to, `word-spacing:${line.spacing.toFixed(3)}px`);
        }
        if (line.breakPos !== null) {
          const at = base + line.breakPos;
          const spacer = lineSpacers.get(at);
          if (spacer) {
            decos.push(
              Decoration.widget(at, () => pageGapWidget(spacer.height, line.hyphen), {
                side: -1,
                key: `pg:${at}:${Math.round(spacer.height)}:${line.hyphen ? 'h' : ''}`,
                h: spacer.height,
                hy: line.hyphen,
              }),
            );
          } else {
            decos.push(
              Decoration.widget(at, line.hyphen ? hyphenWidget : brWidget, {
                side: -1,
                key: `${line.hyphen ? 'hy' : 'br'}:${at}`,
              }),
            );
          }
        }
      }
    };

    // Painted prefixes are DETERMINISTIC (the constants live in style.css:
    // .fn-body 0.85em/0.9em indent, .fn-num 0.72em/0.15em, .fig-num 0.32em).
    // Never measure them from the DOM: a run can land mid-update, before a
    // widget paints, and cache a zero-indent layout that never heals.
    const bodyPx = this.bodyPx();
    const font = `"${settings.font}", Georgia, serif`;
    const FN_SCALE = 0.85;
    const fnIndent = (n: number) => {
      const fnPx = FN_SCALE * bodyPx;
      const numPx = 0.72 * fnPx;
      return 0.9 * fnPx + textWidth(String(n), `${numPx}px ${font}`) + 0.15 * numPx;
    };
    const capIndent = (n: number) => textWidth(`Figure ${n}:`, `${bodyPx}px ${font}`) + 0.32 * bodyPx;

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
          { firstLineIndent: fnIndent(fnNo), scale: FN_SCALE },
          'fn',
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
          { firstLineIndent: capIndent(figNo) },
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
      const cs = getComputedStyle(el);
      const measure = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (!(measure > 60)) return false;

      // Classic mode: consecutive paragraphs carry a first-line indent
      // (Typst's first-line-indent default rule = CSS p + p).
      const indented = settings.parIndent && consecutivePara(state.doc, pos);
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
      decos.push(
        Decoration.widget(sp.pos, () => pageGapWidget(sp.height, false), {
          side: -1,
          key: `pgb:${sp.pos}:${Math.round(sp.height)}`,
          h: sp.height,
        }),
      );
    }

    const sig = decos
      .map((d) => `${d.from}:${d.to}:${((d.spec as { key?: string } | null)?.key ?? (d.spec as { sig?: string } | null)?.sig ?? '')}`)
      .join('|');
    if (sig === this.lastDecoSig && !this.pendingPageMarks) {
      return { paragraphs, lines: lineCount };
    }
    this.lastDecoSig = sig;
    const set = DecorationSet.create(state.doc, decos);
    const meta: Meta = { type: 'decos', decos: set };
    if (this.pendingPageMarks) {
      meta.pageMarks = this.pendingPageMarks;
      this.pendingPageMarks = null;
    }
    const tr = state.tr.setMeta(typesetKey, meta);
    tr.setMeta('addToHistory', false);
    this.view.dispatch(tr);
    return { paragraphs, lines: lineCount };
  }

  /**
   * Walk the naturally-laid-out document and decide where pages break.
   * Paragraphs split at oracle line boundaries; lists and blockquotes break
   * between children; everything else moves to the next page whole. Footnote
   * bodies reserve space at the bottom of the page their marker lands on, so
   * a unit fits only if unit + its footnotes fit above the footnote area.
   */
  private paginate(): { spacers: Spacer[]; count: number } {
    const view = this.view;
    const s = getSettings(view.state);
    const size = pageSize(s);
    const marginTop = s.marginTop * 96;
    const marginBottom = s.marginBottom * 96;
    const contentH = size.h - marginTop - marginBottom;
    if (contentH < 120) return { spacers: [], count: 1 };

    // Page-break oracle: when Typst has told us where its pages break for
    // exactly this document, obey; otherwise paginate ourselves and ask.
    if (ORACLE_FONTS.has(s.font)) {
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
        const entry = this.pageOracle.get(sig);
        if (!entry) this.pageOracle.request(sig, view.state.doc, s, this.atomResolver());
        if (entry?.status === 'ok' && entry.pageStarts) {
          const forced = this.paginateForced(entry.pageStarts, entry.pageCount ?? entry.pageStarts.length + 1);
          if (forced) {
            // Persist the starts as mapped markers for the next edit burst.
            this.lastPageCount = entry.pageCount ?? entry.pageStarts.length + 1;
            this.pendingPageMarks = DecorationSet.create(
              view.state.doc,
              entry.pageStarts.map((ps) =>
                Decoration.widget(ps.pos, () => document.createElement('span'), {
                  psLine: ps.line,
                  psUnit: ps.unit,
                }),
              ),
            );
            return forced;
          }
        }
        // Oracle still compiling for this revision: reuse the LAST starts,
        // mapped through the edits — pages hold still instead of falling
        // back to a local guess that disagrees by a line. Only while
        // PENDING: a failed match must not hold stale geometry forever.
        const marks =
          entry?.status === 'fail' ? [] : (typesetKey.getState(view.state)?.pageMarks.find() ?? []);
        if (marks.length) {
          const stale = marks
            .map((m) => ({
              pos: m.from,
              line: (m.spec as { psLine: number }).psLine,
              unit: (m.spec as { psUnit: string }).psUnit,
            }))
            .sort((a, b) => a.pos - b.pos);
          const forced = this.paginateForced(stale, this.lastPageCount || stale.length + 1, true);
          if (forced) return forced;
        }
      }
    }

    // Origin: the stack top. view.dom (.ProseMirror) sits inside #editor's
    // page-margin padding, so anchor to its parent, whose top is the top of
    // the first painted page.
    const host = view.dom.parentElement ?? view.dom;
    const stackTop = host.getBoundingClientRect().top;
    // Measurements run with the current spacers still in the DOM: convert
    // to NATURAL (continuous) geometry by subtracting the spacers above.
    const existing = this.currentSpacers().sorted;
    const stackY = (clientTop: number, pos: number) =>
      clientTop - stackTop - TypesetView.spacersAbove(existing, pos);

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
    const peekFnH = (endPos: number) => {
      let h = 0;
      for (let j = fnIdx; j < fnList.length && fnList[j].pos < endPos; j++) h += fnList[j].height + FN_GAP;
      return h;
    };
    const takeFnH = (endPos: number) => {
      let h = 0;
      while (fnIdx < fnList.length && fnList[fnIdx].pos < endPos) {
        h += fnList[fnIdx].height + FN_GAP;
        fnIdx++;
      }
      return h;
    };

    const spacers: Spacer[] = [];
    let shift = 0;
    let page = 0;
    let pageFnH = 0;
    const bottomFor = (extraFnH: number) => {
      const total = pageFnH + extraFnH;
      return page * (size.h + PAGE_GAP) + size.h - marginBottom - (total > 0 ? total + FN_SEP : 0);
    };
    // The same page-top ink adjustment paginateForced applies: fallback
    // pagination must land units at identical offsets, or an oracle miss
    // visibly shifts the whole page rhythm by the adjustment.
    const F = this.bodyPx();
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
    const breakStart = (pos: number, y: number) => {
      const a = sticky ?? { pos, y };
      breakBefore(a.pos, a.y, 'block');
    };

    const atomic = (pos: number, node: PMNode) => {
      const endPos = pos + node.nodeSize;
      const r = rectOf(pos);
      if (!r || r.height === 0) {
        pageFnH += takeFnH(endPos);
        return;
      }
      const y = stackY(r.top, pos);
      const ufH = takeFnH(endPos);
      if (y + shift + r.height > bottomFor(ufH) + 0.5 && r.height <= contentH) {
        breakStart(pos, y);
      }
      pageFnH += ufH;
    };

    const paragraph = (pos: number, node: PMNode) => {
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
      if (!entry || entry.lines.length < 2) return atomic(pos, node);

      const el = view.nodeDOM(pos) as HTMLElement;
      const lineH = parseFloat(getComputedStyle(el).lineHeight) || 24;
      const base = pos + 1;
      const lineTops = entry.lines.map((line) => {
        const c = view.coordsAtPos(base + line.from);
        // coordsAtPos returns the caret box; back off half-leading to
        // approximate the line-box top.
        return { pos: base + line.from, y: stackY(c.top, base + line.from) - Math.max(0, (lineH - (c.bottom - c.top)) / 2) };
      });

      const n = lineTops.length;
      // Index of the first line on the current page (for orphan/widow rules
      // across multi-page paragraphs).
      let segStart = 0;
      for (let k = 0; k < n; k++) {
        const y = lineTops[k].y;
        const h = k + 1 < n ? lineTops[k + 1].y - y : yTop + r.height - y;
        const lineEnd = k + 1 < n ? base + entry.lines[k + 1].from : endPos;
        const ufH = takeFnH(lineEnd);
        if (y + shift + h <= bottomFor(ufH) + 0.5) {
          pageFnH += ufH;
          continue;
        }

        if (k === 0) {
          // First line doesn't fit: the paragraph starts on the next page.
          breakStart(pos, yTop);
          pageFnH += ufH;
          continue;
        }
        // A line already at a page top that still overflows is taller than
        // the page — let it overflow rather than breaking at its own start.
        if (k === segStart) {
          pageFnH += ufH;
          continue;
        }

        let kb = k;
        // Widow control: never strand the paragraph's last line alone at the
        // top of a page — break one line earlier so two lines move together.
        if (n - kb === 1 && kb - 1 > segStart) kb = k - 1;
        // Orphan control: never leave fewer than two lines at the bottom of
        // the page where the paragraph starts — move the whole paragraph
        // instead (unless it is taller than a page and must split somewhere).
        if (segStart === 0 && kb < 2) {
          if (r.height <= contentH) {
            breakStart(pos, yTop);
            pageFnH += ufH;
            continue;
          }
          kb = Math.max(kb, 1);
        }

        breakBefore(lineTops[kb].pos, lineTops[kb].y, 'line');
        segStart = kb;
        pageFnH += ufH;
      }
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
      node.forEach((child, offset) => {
        const childPos = pos + 1 + offset;
        const childEnd = childPos + child.nodeSize;
        const cr = rectOf(childPos);
        if (!cr || cr.height === 0) {
          pageFnH += takeFnH(childEnd);
          return;
        }
        const y = stackY(cr.top, childPos);
        const ufH = takeFnH(childEnd);
        if (y + shift + cr.height > bottomFor(ufH) + 0.5 && cr.height <= contentH) {
          breakBefore(childPos, y, 'block');
        }
        pageFnH += ufH;
      });
      pageFnH += takeFnH(endPos);
    };

    view.state.doc.forEach((node, offset) => {
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

    return { spacers, count: page + 1 };
  }

  /** Apply Typst's page starts verbatim (with per-unit ink offsets). */
  private paginateForced(
    pageStarts: Array<{ pos: number; line: number; unit: string }>,
    pageCount: number,
    /** Mapped-through-edits starts (not a fresh oracle answer): bail when
     * the hold would leave an implausibly large gap. */
    stale = false,
  ): { spacers: Spacer[]; count: number } | null {
    const view = this.view;
    const s = getSettings(view.state);
    const size = pageSize(s);
    const marginTop = s.marginTop * 96;
    const F = this.bodyPx();
    const host = view.dom.parentElement ?? view.dom;
    const stackTop = host.getBoundingClientRect().top;
    const existing = this.currentSpacers().sorted;
    const natural = (clientTop: number, pos: number) =>
      clientTop - stackTop - TypesetView.spacersAbove(existing, pos);

    const spacers: Spacer[] = [];
    let shift = 0;
    let page = 0;
    for (const ps of pageStarts) {
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
        // manufacture empty space. A hold is only plausible while the gap
        // could not fit the unit it pushes down (widow/orphan groups and
        // footnote reservations included, generously). Beyond that, the
        // break must move up — bail to live pagination.
        const lineH = F * s.lineHeight;
        const unitH =
          kind === 'line'
            ? lineH
            : (rectOfNode(view, ps.pos)?.height ?? lineH);
        if (delta > unitH + 3 * lineH + 80) return null;
      }
      if (delta > 0) {
        spacers.push({ pos, height: delta, kind });
        shift += delta;
      } else if (delta < -2) {
        // Content has outgrown this break (edits added lines above it):
        // these starts are stale — let live pagination move the break NOW.
        return null;
      }
    }
    return { spacers, count: Math.max(pageCount, page + 1) };
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

function brWidget() {
  const br = document.createElement('br');
  br.className = 'ts-br';
  br.setAttribute('aria-hidden', 'true');
  return br;
}

function hyphenWidget() {
  const s = document.createElement('span');
  s.className = 'ts-hyphen';
  s.setAttribute('aria-hidden', 'true');
  s.contentEditable = 'false';
  s.append('‐');
  s.appendChild(document.createElement('br'));
  return s;
}

/**
 * A page-break spacer. The div is block-level; inside a paragraph's inline
 * content it forms a block-in-inline split, which both forces the line break
 * and inserts exactly `height` px of vertical space (print CSS zeroes it).
 */
function pageGapWidget(height: number, hyphen: boolean) {
  const gap = document.createElement('div');
  gap.className = 'ts-pagegap';
  gap.style.height = `${height.toFixed(2)}px`;
  gap.setAttribute('aria-hidden', 'true');
  gap.contentEditable = 'false';
  if (!hyphen) return gap;
  const wrap = document.createElement('span');
  wrap.style.display = 'contents';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.contentEditable = 'false';
  const hy = document.createElement('span');
  hy.className = 'ts-hyphen';
  hy.textContent = '‐';
  wrap.append(hy, gap);
  return wrap;
}
