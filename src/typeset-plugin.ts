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
import { getSettings, PAGE_GAP, PAGE_SIZES } from './settings';

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
  margin: number;
}

interface TypesetState {
  decos: DecorationSet;
  enabled: boolean;
}

type Meta = { type: 'decos'; decos: DecorationSet } | { type: 'toggle'; enabled: boolean };

interface Spacer {
  pos: number;
  height: number;
  kind: 'line' | 'block';
}

export const typesetKey = new PluginKey<TypesetState>('typeset');

export function isTypesetEnabled(state: EditorState): boolean {
  return typesetKey.getState(state)?.enabled ?? false;
}

/** Vertical gap between stacked footnote bodies / height of the separator zone (px). */
const FN_GAP = 6;
const FN_SEP = 18;

const viewRegistry = new WeakMap<EditorView, TypesetView>();

/** Request a re-typeset without a document change (e.g. an image loaded). */
export function scheduleTypeset(view: EditorView) {
  viewRegistry.get(view)?.requestRun();
}

export function toggleTypeset(view: EditorView) {
  const enabled = !isTypesetEnabled(view.state);
  view.dispatch(view.state.tr.setMeta(typesetKey, { type: 'toggle', enabled } satisfies Meta));
}

export function typesetPlugin(
  opts: { onStats?: (s: TypesetStats) => void; onPages?: (p: PageInfo | null) => void } = {},
) {
  return new Plugin<TypesetState>({
    key: typesetKey,
    state: {
      init: () => ({ decos: DecorationSet.empty, enabled: true }),
      apply(tr, val) {
        const meta = tr.getMeta(typesetKey) as Meta | undefined;
        if (meta?.type === 'decos') return { ...val, decos: meta.decos };
        if (meta?.type === 'toggle') {
          return { enabled: meta.enabled, decos: meta.enabled ? val.decos : DecorationSet.empty };
        }
        if (tr.docChanged) return { ...val, decos: val.decos.map(tr.mapping, tr.doc) };
        return val;
      },
    },
    props: {
      decorations(state) {
        const s = typesetKey.getState(state);
        return s?.enabled ? s.decos : null;
      },
    },
    view: (view) => new TypesetView(view, opts),
  });
}

interface CacheEntry {
  measure: number;
  lines: LineLayout[];
}

class TypesetView {
  private cache = new WeakMap<PMNode, CacheEntry>();
  private measurer: Measurer;
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private lastWidth = 0;
  private destroyed = false;

  constructor(
    private view: EditorView,
    private opts: { onStats?: (s: TypesetStats) => void; onPages?: (p: PageInfo | null) => void },
  ) {
    viewRegistry.set(view, this);
    this.measurer = new Measurer(view.dom);
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
    const enabled = typesetKey.getState(view.state)?.enabled;
    const wasEnabled = typesetKey.getState(prevState)?.enabled;
    if (!enabled) {
      if (wasEnabled) this.opts.onPages?.(null);
      return;
    }
    // Document settings (font, size, hyphenation, …) invalidate every metric.
    if (view.state.doc.attrs !== prevState.doc.attrs) {
      this.measurer.invalidate();
      this.cache = new WeakMap();
    }
    if (view.state.doc !== prevState.doc || !wasEnabled) this.schedule();
  }

  destroy() {
    this.destroyed = true;
    viewRegistry.delete(this.view);
    this.resizeObserver.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.measurer.destroy();
  }

  requestRun() {
    this.schedule();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.run();
    });
  }

  private run() {
    if (this.destroyed) return;
    if (!typesetKey.getState(this.view.state)?.enabled) return;

    const t0 = performance.now();

    // Pass 1: line layout, no page spacers. Applying it synchronously gives
    // us the document's natural (continuous) geometry to paginate against.
    const stats = this.dispatchDecos(new Map(), []);

    // Pass 2: measure natural geometry, compute page breaks, re-dispatch with
    // spacers. Both dispatches share one task, so nothing paints in between.
    const { spacers, count } = this.paginate();
    if (spacers.length) {
      const lineSpacers = new Map<number, Spacer>();
      const blockSpacers: Spacer[] = [];
      for (const sp of spacers) (sp.kind === 'line' ? lineSpacers.set(sp.pos, sp) : blockSpacers.push(sp));
      this.dispatchDecos(lineSpacers, blockSpacers);
    }

    this.placeFootnotes(count);

    const s = getSettings(this.view.state);
    const size = PAGE_SIZES[s.page];
    this.opts.onPages?.({ count, pageW: size.w, pageH: size.h, gap: PAGE_GAP, margin: s.marginIn * 96 });
    this.opts.onStats?.({ ms: performance.now() - t0, paragraphs: stats.paragraphs, lines: stats.lines });
  }

  /** Build the full decoration set (lines + spacers) and dispatch it. */
  private dispatchDecos(lineSpacers: Map<number, Spacer>, blockSpacers: Spacer[]) {
    const { state } = this.view;
    const decos: Decoration[] = [];
    const layoutOpts = { hyphenate: getSettings(state).hyphenate };
    let paragraphs = 0;
    let lineCount = 0;

    state.doc.descendants((node, pos) => {
      // Table cells keep browser layout (narrow measures justify badly).
      if (node.type.name === 'table') return false;
      if (!node.isTextblock) return true;
      // Only body paragraphs are justified; headings and code stay ragged.
      if (node.type.name !== 'paragraph') return false;
      if (node.content.size === 0) return false;

      const el = this.view.nodeDOM(pos);
      if (!(el instanceof HTMLElement)) return false;
      const cs = getComputedStyle(el);
      const measure = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (!(measure > 60)) return false;

      let entry = this.cache.get(node);
      if (!entry || Math.abs(entry.measure - measure) > 0.5) {
        const lines = layoutBlock(
          node,
          measure,
          this.measurer,
          (offset, child) => {
            const dom = this.view.nodeDOM(pos + 1 + offset);
            if (dom instanceof HTMLElement) return dom.getBoundingClientRect().width;
            // Fallback estimate if the atom has no DOM yet.
            return child.nodeSize * 8;
          },
          layoutOpts,
        );
        entry = { measure, lines };
        this.cache.set(node, entry);
      }

      paragraphs++;
      lineCount += entry.lines.length;
      const base = pos + 1;
      for (const line of entry.lines) {
        if (Math.abs(line.spacing) > 0.01) {
          decos.push(
            Decoration.inline(base + line.from, base + line.to, {
              style: `word-spacing:${line.spacing.toFixed(3)}px`,
            }),
          );
        }
        if (line.breakPos !== null) {
          const at = base + line.breakPos;
          const spacer = lineSpacers.get(at);
          if (spacer) {
            decos.push(
              Decoration.widget(at, () => pageGapWidget(spacer.height, line.hyphen), {
                side: -1,
                key: `pg:${at}:${Math.round(spacer.height)}:${line.hyphen ? 'h' : ''}`,
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
      return false;
    });

    for (const sp of blockSpacers) {
      decos.push(
        Decoration.widget(sp.pos, () => pageGapWidget(sp.height, false), {
          side: -1,
          key: `pgb:${sp.pos}:${Math.round(sp.height)}`,
        }),
      );
    }

    const set = DecorationSet.create(state.doc, decos);
    const tr = state.tr.setMeta(typesetKey, { type: 'decos', decos: set } satisfies Meta);
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
    const size = PAGE_SIZES[s.page];
    const margin = s.marginIn * 96;
    const contentH = size.h - 2 * margin;
    if (contentH < 120) return { spacers: [], count: 1 };

    // Origin: the stack top. view.dom (.ProseMirror) sits inside #editor's
    // page-margin padding, so anchor to its parent, whose top is the top of
    // the first painted page.
    const host = view.dom.parentElement ?? view.dom;
    const stackTop = host.getBoundingClientRect().top;
    const stackY = (clientTop: number) => clientTop - stackTop;

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
      return page * (size.h + PAGE_GAP) + size.h - margin - (total > 0 ? total + FN_SEP : 0);
    };
    const breakBefore = (pos: number, y: number, kind: Spacer['kind']) => {
      const delta = (page + 1) * (size.h + PAGE_GAP) + margin - (y + shift);
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

    const atomic = (pos: number, node: PMNode) => {
      const endPos = pos + node.nodeSize;
      const r = rectOf(pos);
      if (!r || r.height === 0) {
        pageFnH += takeFnH(endPos);
        return;
      }
      const y = stackY(r.top);
      const ufH = takeFnH(endPos);
      if (y + shift + r.height > bottomFor(ufH) + 0.5 && r.height <= contentH) {
        breakBefore(pos, y, 'block');
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
      const yTop = stackY(r.top);
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
        return { pos: base + line.from, y: stackY(c.top) - Math.max(0, (lineH - (c.bottom - c.top)) / 2) };
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
          breakBefore(pos, yTop, 'block');
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
            breakBefore(pos, yTop, 'block');
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
      if (stackY(r.top) + shift + r.height <= bottomFor(peekFnH(endPos)) + 0.5) {
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
        const y = stackY(cr.top);
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
        case 'paragraph':
          paragraph(offset, node);
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
    });

    return { spacers, count: page + 1 };
  }

  /**
   * Position footnote bodies at the bottom of the page their marker landed
   * on (final geometry, after spacers). Presentation-only DOM styling; the
   * node views ignore these attribute mutations.
   */
  private placeFootnotes(count: number) {
    const view = this.view;
    const s = getSettings(view.state);
    const size = PAGE_SIZES[s.page];
    const margin = s.marginIn * 96;
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

    for (const [page, list] of groups) {
      const bottomLimit = page * (size.h + PAGE_GAP) + size.h - margin;
      const total = list.reduce((sum, f) => sum + f.height, 0) + FN_GAP * (list.length - 1);
      // .ProseMirror sits one margin below the stack top.
      let y = bottomLimit - total - margin;
      list.forEach((f, i) => {
        f.el.style.top = `${y.toFixed(1)}px`;
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
