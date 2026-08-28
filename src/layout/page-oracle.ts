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
function extractPages(svg: string, yTolPt: number): PagedLine[] {
  const div = parseTypstSvg(svg);
  div.style.cssText = 'position:absolute;visibility:hidden;left:-99999px;top:0;';
  const svgEl = div.querySelector('svg');
  if (!svgEl) return [];
  svgEl.style.width = svgEl.getAttribute('width') + 'px';
  svgEl.style.height = 'auto';
  document.body.appendChild(div);
  const out: PagedLine[] = [];
  let nextLineId = 0;
  const pages = [...div.querySelectorAll('.typst-page')];
  pages.forEach((pageEl, page) => {
    // An SVG <g>'s client rect is the bounding box of its painted children,
    // not the physical page. Using it as the page origin silently shifts
    // every coordinate by the topmost ink (and changes that shift from page
    // to page). Transform screen-space foreignObject rectangles back through
    // the page group's actual CTM instead; the resulting user units are the
    // same physical Typst points returned by `here().position()`.
    const matrix = (pageEl as SVGGElement).getScreenCTM();
    if (!matrix) return;
    let inverse: DOMMatrix;
    try {
      inverse = matrix.inverse();
    } catch {
      return;
    }
    const localBounds = (element: Element) => {
      // Typst's selection text is HTML inside a fixed SVG foreignObject. Its
      // browser glyph box is not layout authority: on a cold Linux start it
      // can briefly use fallback-font metrics, and adjacent physical lines
      // can then merge before the webfont settles. The foreignObject already
      // carries the exact compiled x/y/width/height, so transform that SVG
      // rectangle into page coordinates without measuring its HTML child.
      const foreign = element.closest('foreignObject') as SVGForeignObjectElement | null;
      const selectionMatrix = foreign?.getScreenCTM();
      if (!foreign || !selectionMatrix) return null;
      const x = Number(foreign.getAttribute('x') ?? 0);
      const y = Number(foreign.getAttribute('y') ?? 0);
      const width = Number(foreign.getAttribute('width'));
      const height = Number(foreign.getAttribute('height'));
      if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
      const point = (px: number, py: number) =>
        new DOMPoint(px, py).matrixTransform(selectionMatrix).matrixTransform(inverse);
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
    const runs = [...pageEl.querySelectorAll('.tsel')].flatMap((el) => {
      const runRect = localBounds(el);
      return runRect ? [{
        text: el.textContent ?? '',
        top: runRect.top,
        bottom: runRect.bottom,
        left: runRect.left,
        right: runRect.right,
      }] : [];
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
  // Record the page count on the array for the caller.
  (out as PagedLine[] & { pageCount?: number }).pageCount = pages.length;
  div.remove();
  return out;
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
): ContextLineResult | null {
  const tokens = spec.tokens;
  let ti = initial.token;
  let pendingSuffix = initial.pendingSuffix;
  const breaks = initial.breaks.slice();
  let text = input.replace(/\s+/g, ' ').trim();
  const lineStartTi = ti;
  let brokeWithHyphen = false;

  while (text.length) {
    if (pendingSuffix) {
      if (!text.startsWith(pendingSuffix)) return null;
      text = text.slice(pendingSuffix.length).trimStart();
      pendingSuffix = null;
      continue;
    }
    if (ti >= tokens.length) return null;
    const token = tokens[ti];
    if (token.kind === 'hard') {
      ti++;
      continue;
    }
    if (token.text === undefined) {
      let nextIndex = ti + 1;
      while (
        nextIndex < tokens.length &&
        tokens[nextIndex].kind === 'atom' &&
        tokens[nextIndex].text === undefined
      ) nextIndex++;
      const next = nextIndex < tokens.length && tokens[nextIndex].kind !== 'hard'
        ? tokens[nextIndex]
        : null;
      if (!next || next.text === undefined) {
        text = '';
        ti = next ? ti + 1 : tokens.length;
        continue;
      }
      const needle = (next.spaceBefore ? ' ' : '') + next.text;
      const found = (text + ' ').indexOf(needle);
      if (found < 0) {
        text = '';
        ti++;
        continue;
      }
      text = text.slice(found).trimStart();
      ti++;
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
        brokeWithHyphen = true;
        continue;
      }
    }
    return null;
  }

  const more = ti < tokens.length || pendingSuffix !== null;
  if (more && !brokeWithHyphen) {
    if (ti === lineStartTi) return null;
    const previous = tokens[ti - 1];
    if (previous.kind !== 'hard') breaks.push({ at: previous.end, hyphen: false });
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
      consumed = consumeContextLine(spec, variant, state);
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
  const raw = extractPages(publication.svg, selectionRunTolerance(pitch));
  const pageCount = (raw as PagedLine[] & { pageCount?: number }).pageCount ?? 1;
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
      const match = target.spec && region && region.kind === target.kind
        ? matchContextRegion(target.spec, all, region, pitch)
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
      const res = matchParagraph(unit.spec, slice, 0);
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
