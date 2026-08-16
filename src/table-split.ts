// Table page-splitting: when a table crosses a page boundary, Typst decides
// where — never the editor.
//
// A paged mini-compile of the table alone reproduces the real document's
// constraints: same width, same page content height, and a leading #v()
// spacer standing in for everything above the table on its first page. Under
// identical constraints Typst makes identical decisions, so the fragment's
// page breaks — split row, repeated table.header, strokes at the cut, or
// "push the whole thing" for unbreakable content like captioned figures —
// are the document's own. The editor then shows the compile's pages as
// stacked crops of ONE rendered SVG with the page gap between (pure CSS,
// no per-fragment compiles).
//
// The paginator drives this: it computes the offset, requests a layout
// (async compile, cached), and applies {layout, gaps}. The table node view
// listens and re-renders. Nothing here decides WHERE to break; it only asks
// Typst and displays the answer.

import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { docToTyp } from './typ-serializer';
import { scheduleTypeset } from './typeset-plugin';
import { mountTypstSvg } from './safe-svg';

export const PX_PER_PT = 4 / 3;

/** Serialize a one-table document for preview/mini compiles. `pageSpec`
 *  replaces the exported #set page line (auto-height for the plain preview,
 *  real content height for the paged split compile). */
export function fragmentSource(view: EditorView, node: PMNode, widthPx: number, pageSpec?: string): string {
  const doc = schema.nodes.doc.create({ settings: view.state.doc.attrs.settings, bib: null }, [node]);
  let src = docToTyp(doc);
  src = src.replace(
    /#set page\((.*)\)/,
    pageSpec ?? `#set page(width: ${(widthPx * 0.75).toFixed(2)}pt, height: auto, margin: 0pt)`,
  );
  // Captioned tables are figures: preset the counter so "Table N" matches
  // this table's position in the document.
  if ((node.attrs.caption as string) || (node.attrs.label as string)) {
    let index = 0;
    let seen = 0;
    view.state.doc.descendants((n) => {
      if (n.type.name === 'table') {
        seen++;
        if (n === node) index = seen;
        return false;
      }
      return true;
    });
    src = src.replace(
      '\n\n#figure(',
      `\n\n#counter(figure.where(kind: table)).update(${Math.max(0, index - 1)})\n#figure(`,
    );
  }
  return src;
}

export interface TableFragment {
  /** Crop window top within the rendered SVG, px at display scale. */
  cropTopPx: number;
  /** Visible (ink) height of this fragment, px. */
  heightPx: number;
  /** Text-line count on this fragment's page (the oracle's metric). */
  lines: number;
}

export interface TableSplitLayout {
  /** One entry per page the table occupies. Length 1 = no visible split
   *  (fits, or Typst pushed it whole — see `pushed`). */
  fragments: TableFragment[];
  /** The compiled multi-page SVG the fragments crop. */
  svg: string;
  /** Rendered width of that SVG at display scale, px. */
  svgWidthPx: number;
  /** Typst placed nothing at the requested offset: the table starts on the
   *  next page (its natural block behavior, e.g. unbreakable figures). */
  pushed: boolean;
}

export interface SplitAssignment {
  layout: TableSplitLayout;
  /** Page-gap heights between consecutive fragments (paginator-computed). */
  gapsPx: number[];
  /** Continuous (unsplit) height at the time of application, px. */
  naturalPx: number;
}

// ---------- compile cache ----------

const cache = new Map<string, TableSplitLayout | 'pending' | 'failed'>();
const CACHE_MAX = 16;

function cacheKey(src: string, contentHPt: number, offsetPt: number, targetLines: number[] | null): string {
  // Tiny offset jitter (sub-0.05pt measurement noise) must not force
  // recompiles or, worse, oscillating layouts.
  return `${contentHPt.toFixed(1)}:${offsetPt.toFixed(1)}:${targetLines ? targetLines.join('/') : '-'}:${src}`;
}

/** Measure the multi-page SVG offscreen. The SVG stacks its pages
 *  gaplessly (height = N × page height), so page boundaries come from the
 *  KNOWN page height; the .typst-page groups' bounding rects are pure ink
 *  extents (a group's bbox hugs its children — leading #v space and page
 *  bottom whitespace are not part of it). */
function measurePages(
  svgText: string,
  pageHPx: number,
): { pages: Array<{ top: number; height: number; inkTop: number; inkBottom: number; lines: number }>; widthPx: number } | null {
  const div = document.createElement('div');
  div.style.cssText = 'position:absolute;visibility:hidden;left:-99999px;top:0;';
  const svgEl = mountTypstSvg(div, svgText);
  if (!svgEl) return null;
  const widthPx = parseFloat(svgEl.getAttribute('width') ?? '0') * PX_PER_PT;
  svgEl.style.width = `${widthPx}px`;
  svgEl.style.height = 'auto';
  document.body.appendChild(div);
  const svgTop = svgEl.getBoundingClientRect().top;
  const pages: Array<{ top: number; height: number; inkTop: number; inkBottom: number; lines: number }> = [];
  const groups = [...div.querySelectorAll('.typst-page')];
  groups.forEach((g, i) => {
    const r = g.getBoundingClientRect();
    const empty = r.height <= 0.5;
    // Text-line count per page, clustered by y — the same integer metric
    // the page oracle extracts from the full-document compile, so the
    // two can be compared page-for-page.
    const ys: number[] = [];
    for (const t of g.querySelectorAll('.tsel')) {
      const tr = t.getBoundingClientRect();
      if (tr.height > 0) ys.push(tr.top);
    }
    ys.sort((a, b) => a - b);
    let lines = 0;
    let lastY = -1e9;
    for (const y of ys) {
      if (y - lastY > 6) {
        lines++;
        lastY = y;
      }
    }
    pages.push({
      top: i * pageHPx,
      height: pageHPx,
      inkTop: empty ? NaN : r.top - svgTop,
      inkBottom: empty ? NaN : r.bottom - svgTop,
      lines,
    });
  });
  div.remove();
  return { pages, widthPx };
}

async function compileSplit(
  view: EditorView,
  node: PMNode,
  widthPx: number,
  contentHPt: number,
  offsetPt: number,
  targetLines: number[] | null,
): Promise<TableSplitLayout | null> {
  const { compileSvg } = await import('./pdf');
  const pageSpec = `#set page(width: ${(widthPx * 0.75).toFixed(2)}pt, height: ${contentHPt.toFixed(2)}pt, margin: 0pt)`;
  const base = fragmentSource(view, node, widthPx, pageSpec);
  // The #v stands in for the content above the table on its starting page.
  // Two corrections converge it: the ink must land at the requested offset
  // (adjacent weak block spacing can interact with the #v), and — when the
  // page oracle supplied per-page line counts from the full-document
  // compile — the fragments must reproduce those counts exactly. The
  // oracle's answer is the PDF's, so a sub-row offset delta between editor
  // and Typst geometry must never flip the split row.
  let v = offsetPt;
  for (let attempt = 0; attempt < 4; attempt++) {
    const src = v > 0.05 ? base.replace('\n\n', `\n\n#v(${v.toFixed(2)}pt)\n`) : base;
    const svg = await compileSvg(src);
    if (!svg) return null;
    const measured = measurePages(svg, contentHPt * PX_PER_PT);
    if (!measured || !measured.pages.length) return null;
    const { pages, widthPx: svgWidthPx } = measured;
    const firstInk = pages.findIndex((p) => !Number.isNaN(p.inkTop));
    if (firstInk < 0) return null;
    if (firstInk === 0 && offsetPt > 0.05 && !targetLines) {
      // Rendered px → pt is /PX_PER_PT (pages render at display scale).
      const gotPt = (pages[0].inkTop - pages[0].top) / PX_PER_PT;
      if (Math.abs(gotPt - offsetPt) > 0.5 && attempt === 0) {
        v = v + (offsetPt - gotPt);
        continue;
      }
    }
    const inked = pages.slice(firstInk).filter((p) => !Number.isNaN(p.inkTop));
    if (!inked.length) return null;
    const fragments: TableFragment[] = inked.map((p) => ({ cropTopPx: p.inkTop, heightPx: p.inkBottom - p.inkTop, lines: p.lines }));
    const layout: TableSplitLayout = { fragments, svg, svgWidthPx, pushed: firstInk > 0 };
    if (!targetLines) return layout;
    // Align to the oracle: every boundary's line count must agree.
    const boundaries = Math.min(targetLines.length, inked.length - 1);
    if (inked.length - 1 === targetLines.length && targetLines.every((t, i) => inked[i].lines === t)) {
      return layout;
    }
    if (boundaries < 1 || firstInk > 0) return null;
    // Nudge the offset by the first page's line surplus (deficit) — one
    // line's pitch per line of disagreement, measured from the render.
    const p0 = inked[0];
    const pitch = p0.lines > 1 ? (p0.inkBottom - p0.inkTop) / PX_PER_PT / (p0.lines - 1) : 12;
    const diff = p0.lines - targetLines[0];
    if (diff === 0) return null; // later boundary disagrees: offset can't fix it
    v += diff * pitch;
    if (v < 0) return null;
  }
  return null;
}

/** Ask for the split layout of a table starting `offsetPt` into a page of
 *  `contentHPt`. `targetLines` (per-page text-line counts from the page
 *  oracle's full-document compile) pins the split rows to the PDF's exact
 *  answer. Returns the cached layout, null while Typst is still compiling
 *  (a repagination is scheduled when it lands), or null permanently when
 *  the targets can't be met (the caller falls back gracefully). */
export function requestTableSplit(
  view: EditorView,
  node: PMNode,
  widthPx: number,
  contentHPt: number,
  offsetPt: number,
  targetLines: number[] | null = null,
): TableSplitLayout | null {
  const key = cacheKey(fragmentSource(view, node, widthPx), contentHPt, offsetPt, targetLines);
  const hit = cache.get(key);
  if (hit === 'pending') return null;
  if (hit === 'failed') return null;
  if (hit) return hit;
  cache.set(key, 'pending');
  if (cache.size > CACHE_MAX) {
    for (const k of cache.keys()) {
      if (cache.size <= CACHE_MAX) break;
      if (cache.get(k) !== 'pending') cache.delete(k);
    }
  }
  void compileSplit(view, node, widthPx, contentHPt, offsetPt, targetLines)
    .then((layout) => {
      cache.set(key, layout ?? 'failed');
      if (layout) scheduleTypeset(view);
    })
    .catch((e) => {
      console.warn('table split compile failed', e);
      cache.set(key, 'failed');
    });
  return null;
}

// ---------- applied splits (paginator → node views) ----------
//
// Keyed by the table's PMNode: node identity survives edits elsewhere in
// the document (ProseMirror trees are persistent), while document positions
// shift under every keystroke. Editing the table itself yields a new node —
// the old assignment simply becomes unreachable and the next pagination
// pass re-derives one from the fresh compile.

const assignments = new WeakMap<PMNode, SplitAssignment>();
const listeners = new Set<() => void>();
let notifyQueued = false;

function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const cb of listeners) cb();
  });
}

export function onSplitsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The table node renders `layout` with `gapsPx` between fragments. */
export function applySplit(node: PMNode, layout: TableSplitLayout, gapsPx: number[], naturalPx: number) {
  const prev = assignments.get(node);
  if (
    prev &&
    prev.layout === layout &&
    prev.gapsPx.length === gapsPx.length &&
    prev.gapsPx.every((g, i) => Math.abs(g - gapsPx[i]) < 0.5)
  ) {
    return;
  }
  assignments.set(node, { layout, gapsPx, naturalPx });
  notify();
}

export function clearSplit(node: PMNode) {
  if (assignments.has(node)) {
    assignments.delete(node);
    notify();
  }
}

export function getSplit(node: PMNode): SplitAssignment | undefined {
  return assignments.get(node);
}

/** Extra height (page gaps + repeated headers) an assignment adds over the
 *  continuous layout — the paginator subtracts it to recover natural
 *  geometry, exactly as it does for its own page spacers. */
export function splitExtra(a: SplitAssignment): number {
  const displayed = a.layout.fragments.reduce((s, f) => s + f.heightPx, 0) + a.gapsPx.reduce((s, g) => s + g, 0);
  return displayed - a.naturalPx;
}
