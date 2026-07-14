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
  page: number;
}

const MAX_RESULTS = 8;

export class PageOracle {
  private results = new Map<string, PageOracleEntry>();
  private pendingSig: string | null = null;
  private timer = 0;
  private inflight = false;
  private disposed = false;

  constructor(private onResults: () => void) {}

  get(sig: string): PageOracleEntry | undefined {
    return this.results.get(sig);
  }

  request(sig: string, doc: PMNode, settings: DocSettings, resolveAtom: AtomResolver) {
    if (this.disposed || this.results.has(sig) || this.pendingSig === sig) return;
    this.pendingSig = sig;
    this.payload = { doc, settings, resolveAtom };
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 350);
  }

  private payload: { doc: PMNode; settings: DocSettings; resolveAtom: AtomResolver } | null = null;

  clear() {
    this.results.clear();
    this.pendingSig = null;
  }

  destroy() {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  private async flush() {
    if (this.disposed || this.inflight || !this.pendingSig || !this.payload) return;
    const sig = this.pendingSig;
    const { doc, settings, resolveAtom } = this.payload;
    this.inflight = true;
    try {
      const { compileDocSvg } = await import('../pdf');
      const svg = await compileDocSvg(doc);
      if (this.disposed) return;
      const entry = svg ? analyze(svg, doc, settings, resolveAtom) : ({ status: 'fail', reason: 'compile failed' } as PageOracleEntry);
      this.results.set(sig, entry);
      if (this.results.size > MAX_RESULTS) {
        this.results.delete(this.results.keys().next().value!);
      }
    } catch (e) {
      console.warn('page oracle failed', e);
      this.results.set(sig, { status: 'fail', reason: String(e).slice(0, 120) });
    } finally {
      this.inflight = false;
      if (this.pendingSig === sig) this.pendingSig = null;
      // A newer request may have arrived while compiling.
      if (!this.disposed && this.pendingSig) {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.flush(), 60);
      }
    }
    if (!this.disposed) this.onResults();
  }
}

/** Per-page tsel lines from the multi-page SVG. The svg renders at an
 *  arbitrary scale — per-page y tolerance is derived from the page height. */
function extractPages(svg: string, yTolPt: number, pageHPt: number): PagedLine[] {
  const div = document.createElement('div');
  div.innerHTML = svg;
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
function buildUnits(doc: PMNode, resolveAtom: AtomResolver): Unit[] {
  const units: Unit[] = [];
  const push = (node: PMNode, pos: number, marker = false) => {
    if (node.type.name === 'paragraph' && node.content.size) {
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
        return { status: 'fail', reason: `unit@${unit.pos} (${unit.type}): ${res.entry.reason}` };
      }
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

  // Mid-opaque page splits can't be represented (editor blocks are atomic).
  for (const ps of pageStarts) {
    if (ps.line > 0 && ps.unit !== 'line') {
      return { status: 'fail', reason: `page splits inside atomic block @${ps.pos} (${ps.unit})` };
    }
  }

  return { status: 'ok', pageStarts, pageCount };
}