// The page-break oracle: Typst decides where pages break; the editor obeys.
//
// The full document (the byte-exact export, embedded assets and all)
// compiles in the background; the multi-page SVG's text-selection layer
// gives each page's lines. Matching those lines against the document's
// blocks — exact token matching for paragraphs and headings (the same
// machinery as the line-break oracle), anchored resync across opaque blocks
// (equations, figures, tables, raw), footnote-area lines filtered against
// the known footnote texts — yields the block (and line, for split
// paragraphs) that starts every page. The editor's paginator then places
// its page spacers exactly there instead of running its own fit rules.
//
// Any mismatch fails the whole result and the editor keeps its own
// pagination for that document state (graceful, self-healing on edit).

import type { Node as PMNode } from 'prosemirror-model';
import { buildSpec, matchParagraph, type AtomResolver, type SvgLine, type ParagraphSpec } from './typst-oracle';
import { formatPageNumber, pageSize, type DocSettings } from '../settings';
import { parseTypstSvg } from '../safe-svg';

export interface PageStart {
  /** Document position of the block that begins the page. */
  pos: number;
  /** Line index within the block for mid-paragraph splits (0 = block start). */
  line: number;
  /** Block type — the paginator applies a type-specific ink offset. */
  unit: string;
  level?: number;
}

export interface PageOracleEntry {
  status: 'ok' | 'fail';
  pageStarts?: PageStart[];
  pageCount?: number;
  reason?: string;
}

export interface Unit {
  kind: 'exact' | 'opaque';
  pos: number;
  type: string;
  level?: number;
  spec?: ParagraphSpec;
  /** exact list-item paragraphs may carry a marker glued onto their first
   * line: `true` for a bullet/quote marker glyph (stripped by the generic
   * MARKER pattern below) or the exact literal text Typst renders for an
   * ordered-list marker ("1.", "2.", …) — deterministic from the item's
   * position in its own list, so it is matched and stripped exactly rather
   * than guessed at. */
  marker?: boolean | string;
}

export interface PagedLine extends SvgLine {
  page: number;
}

const MAX_RESULTS = 8;

export class PageOracle {
  private results = new Map<string, PageOracleEntry>();
  private pendingSig: string | null = null;
  private timer = 0;
  private inflight = false;
  private disposed = false;
  /** Identifies the latest requested page layout. Page compiles cannot be
   * cancelled once running, so older completions must not publish. */
  private generation = 0;

  constructor(
    private onResults: (entry: PageOracleEntry) => void,
    private compileDocSvg: (doc: PMNode) => Promise<string | null> = async (doc) => {
      const { compileDocSvg } = await import('../pdf');
      return compileDocSvg(doc);
    },
  ) {}

  get(sig: string): PageOracleEntry | undefined {
    return this.results.get(sig);
  }

  request(sig: string, doc: PMNode, settings: DocSettings, resolveAtom: AtomResolver) {
    if (this.disposed || this.results.has(sig) || this.pendingSig === sig) return;
    this.generation++;
    this.pendingSig = sig;
    this.payload = { doc, settings, resolveAtom };
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 350);
  }

  private payload: { doc: PMNode; settings: DocSettings; resolveAtom: AtomResolver } | null = null;

  clear() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = 0;
    this.results.clear();
    this.pendingSig = null;
    this.payload = null;
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
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
    let published: PageOracleEntry | undefined;
    try {
      if (this.disposed || generation !== this.generation) return;
      const svg = await this.compileDocSvg(doc);
      if (this.disposed || generation !== this.generation) return;
      const entry = svg ? analyze(svg, doc, settings, resolveAtom) : ({ status: 'fail', reason: 'compile failed' } as PageOracleEntry);
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
function extractPages(svg: string, yTolPt: number, pageHPt: number): PagedLine[] {
  const div = parseTypstSvg(svg);
  div.style.cssText = 'position:absolute;visibility:hidden;left:-99999px;top:0;';
  const svgEl = div.querySelector('svg');
  if (!svgEl) return [];
  svgEl.style.width = svgEl.getAttribute('width') + 'px';
  svgEl.style.height = 'auto';
  document.body.appendChild(div);
  const out: PagedLine[] = [];
  const pages = [...div.querySelectorAll('.typst-page')];
  pages.forEach((pageEl, page) => {
    const rect = pageEl.getBoundingClientRect();
    const yTol = (yTolPt * rect.height) / pageHPt;
    for (const el of pageEl.querySelectorAll('.tsel')) {
      const y = el.getBoundingClientRect().top - rect.top;
      const text = el.textContent ?? '';
      const last = out[out.length - 1];
      if (last && last.page === page && Math.abs(y - last.y) < yTol) last.text += text;
      else out.push({ text, y, page });
    }
  });
  // Record the page count on the array for the caller.
  (out as PagedLine[] & { pageCount?: number }).pageCount = pages.length;
  div.remove();
  return out;
}

/** Build the document's unit list (blocks in reading order). */
export function buildUnits(doc: PMNode, resolveAtom: AtomResolver): Unit[] {
  const units: Unit[] = [];
  const push = (node: PMNode, pos: number, marker: boolean | string = false) => {
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
      // Ordered markers are deterministic per item: Typst's default enum
      // numbering ("1.", "2.", …) restarts at 1 for every list (including a
      // nested one), regardless of the export's own item-`order` attr — the
      // exporter (typ-serializer's `+` items) never emits a start override,
      // so this counts along with what actually gets compiled. Only the
      // item's FIRST block carries the marker; a second paragraph or a
      // nested list inside the same list_item has none.
      const ordered = node.type.name === 'ordered_list';
      let itemIndex = 0;
      node.forEach((child, off) => {
        const childPos = pos + 1 + off;
        if (child.type.name === 'list_item') {
          itemIndex++;
          const itemMarker: boolean | string = ordered
            ? `${itemIndex}.`
            : node.type.name === 'bullet_list';
          child.forEach((g, goff) => push(g, childPos + 1 + goff, goff === 0 ? itemMarker : false));
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

const MARKER = /^[•‣–\-*]?\s*|^\d+[.)]\s*/;

/**
 * Strip a list-item's marker off the first line of its rendered text.
 * `marker === true` is a bullet/quote glyph (matched loosely — the exact
 * glyph varies by nesting depth and Typst's own default cycle); a string
 * is an ordered-list marker's exact predicted text ("1.", "2.", …), which
 * must match verbatim — left untouched otherwise, so a real mismatch
 * still surfaces as a token-mismatch failure downstream (fail closed,
 * never a fuzzy skip that could paper over a genuinely wrong layout).
 */
export function stripListMarker(text: string, marker: boolean | string | undefined): string {
  if (!marker) return text;
  if (typeof marker === 'string') return text.startsWith(marker) ? text.slice(marker.length) : text;
  return text.replace(MARKER, '');
}

/** The resync target when an opaque block hands off to the next exact unit:
 * that unit's first two words, plus its own marker (if any) — a list item
 * carries one, and Typst glues it onto the rendered line's front exactly
 * like it does for the exact-match branch above. */
export interface Anchor {
  text: string;
  marker?: boolean | string;
}

/**
 * Whether an opaque block's current SVG line is where the next exact unit
 * (the anchor) begins. The anchor's own marker must be stripped from the
 * candidate line first — Typst glues a list item's marker onto its first
 * line with no separating space, so an un-stripped comparison can never
 * satisfy `startsWith` and the opaque block would consume straight past
 * its real end into lines that belong to the marked item.
 */
export function matchesAnchor(lineText: string, anchor: Anchor | null): boolean {
  if (!anchor) return false;
  const text = stripListMarker(lineText.replace(/\s+/g, ' ').trim(), anchor.marker);
  return text === anchor.text || text.startsWith(anchor.text + ' ') || text.startsWith(anchor.text);
}

/** First words of every footnote body, in document order. */
export function footnoteHeads(doc: PMNode): string[] {
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
export function stripFootnoteLines(lines: PagedLine[], heads: string[]): PagedLine[] {
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

function analyze(svg: string, doc: PMNode, settings: DocSettings, resolveAtom: AtomResolver): PageOracleEntry {
  const pitch = settings.lineHeight * settings.sizePt;
  const pageHPt = pageSize(settings).h * 0.75;
  const raw = extractPages(svg, pitch / 2, pageHPt);
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
  const isFolio = (l: PagedLine) =>
    hasRestart
      ? folioPatterns.some((re) => re.test(l.text.trim()))
      : l.text.trim() === formatPageNumber(settings, l.page + 1, pageCount);
  const all = settings.pageNumShow ? raw.filter((l) => !isFolio(l)) : raw;

  const units = buildUnits(doc, resolveAtom);
  const lines = stripFootnoteLines(all, footnoteHeads(doc));

  const pageStarts: PageStart[] = [];
  let cursor = 0;
  let lastPage = 0;

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

  const anchorFor = (idx: number): Anchor | null => {
    for (let j = idx; j < units.length; j++) {
      const u = units[j];
      if (u.kind === 'exact' && u.spec) {
        const words = u.spec.tokens.filter((t) => t.text).slice(0, 2);
        if (words.length) return { text: words.map((t) => t.text).join(' '), marker: u.marker };
      }
    }
    return null;
  };

  for (let ui = 0; ui < units.length; ui++) {
    const unit = units[ui];
    if (cursor >= lines.length) break;
    if (unit.kind === 'exact' && unit.spec) {
      // List markers ride on the first line; strip before matching. An
      // ordered marker's exact text is known — require it verbatim (fail
      // closed on a mismatch instead of silently leaving it, which would
      // just surface as a token-mismatch failure downstream, exactly as it
      // should for a genuinely wrong layout).
      const slice = lines.slice(cursor).map((l, i) => (i === 0 ? { ...l, text: stripListMarker(l.text, unit.marker) } : l));
      const res = matchParagraph(unit.spec, slice, 0);
      if (res.status !== 'ok') {
        return { status: 'fail', reason: `unit@${unit.pos} (${unit.type}): ${res.entry.reason}` };
      }
      for (let k = 0; k < res.next; k++) notePage(cursor + k, unit, k);
      cursor += res.next;
    } else {
      // Opaque block: consume lines until the next exact unit's anchor.
      const anchor = anchorFor(ui + 1);
      let consumed = 0;
      while (cursor < lines.length) {
        if (matchesAnchor(lines[cursor].text, anchor)) break;
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

  // Mid-opaque page splits can't be represented (editor blocks are atomic)
  // — except tables, whose node view renders Typst's own split fragments
  // (typeset-plugin's forced paginator verifies the break count agrees).
  for (const ps of pageStarts) {
    if (ps.line > 0 && ps.unit !== 'line' && ps.unit !== 'table') {
      return { status: 'fail', reason: `page splits inside atomic block @${ps.pos} (${ps.unit})` };
    }
  }

  return { status: 'ok', pageStarts, pageCount };
}
