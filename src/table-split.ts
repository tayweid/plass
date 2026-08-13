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

function cacheKey(src: string, contentHPt: number, offsetPt: number): string {
  // Tiny offset jitter (sub-0.05pt measurement noise) must not force
  // recompiles or, worse, oscillating layouts.
  return `${contentHPt.toFixed(1)}:${offsetPt.toFixed(1)}:${src}`;
}

/** Measure the multi-page SVG offscreen. The SVG stacks its pages
 *  gaplessly (height = N × page height), so page boundaries come from the
 *  KNOWN page height; the .typst-page groups' bounding rects are pure ink
 *  extents (a group's bbox hugs its children — leading #v space and page
 *  bottom whitespace are not part of it). */
function measurePages(
  svgText: string,
  pageHPx: number,
): { pages: Array<{ top: number; height: number; inkTop: number; inkBottom: number }>; widthPx: number } | null {
  const div = document.createElement('div');
  div.style.cssText = 'position:absolute;visibility:hidden;left:-99999px;top:0;';
  div.innerHTML = svgText;
  const svgEl = div.querySelector('svg');
  if (!svgEl) return null;
  const widthPx = parseFloat(svgEl.getAttribute('width') ?? '0') * PX_PER_PT;
  svgEl.style.width = `${widthPx}px`;
  svgEl.style.height = 'auto';
  document.body.appendChild(div);
  const svgTop = svgEl.getBoundingClientRect().top;
  const pages: Array<{ top: number; height: number; inkTop: number; inkBottom: number }> = [];
  const groups = [...div.querySelectorAll('.typst-page')];
  groups.forEach((g, i) => {
    const r = g.getBoundingClientRect();
    const empty = r.height <= 0.5;
    pages.push({
      top: i * pageHPx,
      height: pageHPx,
      inkTop: empty ? NaN : r.top - svgTop,
      inkBottom: empty ? NaN : r.bottom - svgTop,
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
): Promise<TableSplitLayout | null> {
  const { compileSvg } = await import('./pdf');
  const pageSpec = `#set page(width: ${(widthPx * 0.75).toFixed(2)}pt, height: ${contentHPt.toFixed(2)}pt, margin: 0pt)`;
  const base = fragmentSource(view, node, widthPx, pageSpec);
  // The #v stands in for the content above the table on its starting page.
  // Adjacent weak block spacing can collapse into it, so verify the ink
  // actually lands at the requested offset and correct once if not.
  let v = offsetPt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const src = v > 0.05 ? base.replace('\n\n', `\n\n#v(${v.toFixed(2)}pt)\n`) : base;
    const svg = await compileSvg(src);
    if (!svg) return null;
    const measured = measurePages(svg, contentHPt * PX_PER_PT);
    if (!measured || !measured.pages.length) return null;
    const { pages, widthPx: svgWidthPx } = measured;
    const firstInk = pages.findIndex((p) => !Number.isNaN(p.inkTop));
    if (firstInk < 0) return null;
    if (firstInk === 0 && offsetPt > 0.05) {
      // Rendered px → pt is /PX_PER_PT (pages render at display scale).
      // Adjacent weak block spacing can interact with the #v, so verify
      // the ink actually landed at the requested offset; correct once.
      const gotPt = (pages[0].inkTop - pages[0].top) / PX_PER_PT;
      if (Math.abs(gotPt - offsetPt) > 0.5 && attempt === 0) {
        v = v + (offsetPt - gotPt);
        continue;
      }
    }
    const fragments: TableFragment[] = [];
    for (let i = firstInk; i < pages.length; i++) {
      const p = pages[i];
      if (Number.isNaN(p.inkTop)) continue;
      fragments.push({ cropTopPx: p.inkTop, heightPx: p.inkBottom - p.inkTop });
    }
    if (!fragments.length) return null;
    return { fragments, svg, svgWidthPx, pushed: firstInk > 0 };
  }
  return null;
}

/** Ask for the split layout of a table starting `offsetPt` into a page of
 *  `contentHPt`. Returns the cached answer, or null while Typst is still
 *  compiling (a repagination is scheduled when it lands). */
export function requestTableSplit(
  view: EditorView,
  node: PMNode,
  widthPx: number,
  contentHPt: number,
  offsetPt: number,
): TableSplitLayout | null {
  const key = cacheKey(fragmentSource(view, node, widthPx), contentHPt, offsetPt);
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
  void compileSplit(view, node, widthPx, contentHPt, offsetPt)
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
