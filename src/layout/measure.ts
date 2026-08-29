// Text measurement for the layout oracle.
//
// Measurement happens in the DOM itself: a hidden probe element carrying the
// editor's own classes (so every CSS rule resolves identically), measured
// with Range rects at sub-pixel precision. The measuring engine IS the
// rendering engine — shaping, kerning (including kern pairs against spaces,
// which canvas measureText ignores), ligatures, and font fallback all match
// the rendered text exactly, eliminating the measurement-circularity problem
// of spec §4.1 by construction.

import type { Mark } from 'prosemirror-model';

const MARK_TAG: Record<string, string> = {
  strong: 'strong',
  em: 'em',
  code: 'code',
};

interface MarkContext {
  /** The text node inside the nested mark elements; set its data, then measure. */
  textNode: Text;
}

/** A JS-code-unit range inside one rendered text run. */
export interface TextMeasureInterval {
  start: number;
  end: number;
}

/** One styled run whose interval widths a batch measurement should produce. */
export interface RunMeasureRequest {
  text: string;
  intervals: readonly TextMeasureInterval[];
  key: string;
}

export interface MeasurementStats {
  /** Layout-triggering Range.getBoundingClientRect calls. */
  rangeReads: number;
  /** Times a hidden styled text node was populated for a measurement batch. */
  probePopulations: number;
}

export class Measurer {
  private probe: HTMLElement;
  private contexts = new Map<string, MarkContext>();
  private widthCache = new Map<string, number>();
  private range = document.createRange();
  private measurementStats: MeasurementStats = { rangeReads: 0, probePopulations: 0 };

  /**
   * @param editorDom the ProseMirror root element; the probe copies its
   * classes so CSS rules resolve identically.
   */
  constructor(editorDom: HTMLElement) {
    this.probe = document.createElement('div');
    this.probe.className = editorDom.className + ' ts-measure-probe';
    this.probe.setAttribute('aria-hidden', 'true');
    this.probe.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;left:-99999px;top:0;' +
      'width:max-content;white-space:pre;word-spacing:normal;letter-spacing:normal;';
    (editorDom.parentElement ?? document.body).appendChild(this.probe);
  }

  destroy() {
    this.probe.remove();
    this.contexts.clear();
  }

  /** Drop caches (fonts finished loading, stylesheet changed, …). */
  invalidate() {
    this.widthCache.clear();
    this.contexts.clear();
    this.probe.replaceChildren();
  }

  /** Cumulative counters for differential/performance tests. */
  stats(): Readonly<MeasurementStats> {
    return { ...this.measurementStats };
  }

  resetStats(): void {
    this.measurementStats = { rangeReads: 0, probePopulations: 0 };
  }

  /** Opaque measurement-context key for text carrying the given marks. */
  fontFor(marks: readonly Mark[]): string {
    return marks
      .map((m) => m.type.name)
      .filter((n) => MARK_TAG[n])
      .sort()
      .join(',');
  }

  /**
   * @param ordinal pool slot: a batch measuring several runs with the same
   * mark key needs one populated text node per run, all live at once.
   */
  private contextFor(key: string, ordinal = 0): MarkContext {
    const mapKey = ordinal ? `${key}\x1e${ordinal}` : key;
    let ctx = this.contexts.get(mapKey);
    if (ctx) return ctx;
    const p = document.createElement('p');
    let cur: HTMLElement = p;
    for (const name of key ? key.split(',') : []) {
      const el = document.createElement(MARK_TAG[name]);
      cur.appendChild(el);
      cur = el;
    }
    const textNode = document.createTextNode('');
    cur.appendChild(textNode);
    this.probe.appendChild(p);
    ctx = { textNode };
    this.contexts.set(mapKey, ctx);
    return ctx;
  }

  /**
   * Measure full-run prefixes in one probe population. Duplicate offsets cost
   * no extra Range reads; results retain the caller's ordering.
   *
   * Prefix measurement is intentional. Subtracting two full-run prefixes
   * preserves the same telescoping allocation of cross-boundary kerning that
   * segmentWidths has always used, whereas measuring an isolated Range can
   * reshape its boundary.
   */
  prefixWidths(text: string, offsets: readonly number[], key: string): number[] {
    if (!offsets.length) return [];
    const prefixes = this.measurePrefixes(text, offsets, key);
    return offsets.map((offset) => prefixes.get(offset)!);
  }

  /**
   * Widths of arbitrary subranges of one styled run. All unique starts and
   * ends are measured as full-run prefixes during a single probe population,
   * then differenced. A forced-break renderer can therefore request only its
   * authoritative line/style boundaries instead of every syllable boundary.
   */
  intervalWidths(text: string, intervals: readonly TextMeasureInterval[], key: string): number[] {
    if (!intervals.length) return [];
    return this.intervalWidthsBatch([{ text, intervals, key }])[0];
  }

  /**
   * intervalWidths for several styled runs, with every probe population
   * (DOM write) grouped before every Range read. A batch therefore forces a
   * single layout pass instead of one per run; each run still measures the
   * same full-run prefixes in its own text node, so the values are identical
   * to per-run intervalWidths calls.
   */
  intervalWidthsBatch(requests: readonly RunMeasureRequest[]): number[][] {
    // Validate everything up front so a malformed request writes nothing.
    const plans = requests.map(({ text, intervals, key }) => {
      const unique = new Set<number>();
      for (const { start, end } of intervals) {
        if (start > end) throw new RangeError(`text interval starts after it ends: ${start} > ${end}`);
        unique.add(start);
        unique.add(end);
      }
      for (const offset of unique) {
        if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
          throw new RangeError(`text measurement offset ${offset} is outside 0..${text.length}`);
        }
      }
      const prefixes = new Map<number, number>();
      prefixes.set(0, 0);
      return {
        text,
        intervals,
        key,
        prefixes,
        pending: [...unique].filter((offset) => offset !== 0).sort((a, b) => a - b),
        ctx: null as MarkContext | null,
      };
    });

    // Write phase: populate one pooled text node per measured run.
    const perKey = new Map<string, number>();
    for (const plan of plans) {
      if (!plan.pending.length) continue;
      const ordinal = perKey.get(plan.key) ?? 0;
      perKey.set(plan.key, ordinal + 1);
      plan.ctx = this.contextFor(plan.key, ordinal);
      plan.ctx.textNode.data = plan.text;
      this.measurementStats.probePopulations++;
    }
    // Read phase: one Range layout read per unique, non-zero prefix offset.
    try {
      for (const plan of plans) {
        if (!plan.ctx) continue;
        this.range.setStart(plan.ctx.textNode, 0);
        for (const offset of plan.pending) {
          this.range.setEnd(plan.ctx.textNode, offset);
          this.measurementStats.rangeReads++;
          plan.prefixes.set(offset, this.range.getBoundingClientRect().width);
        }
      }
    } finally {
      for (const plan of plans) {
        if (plan.ctx) plan.ctx.textNode.data = '';
      }
    }
    return plans.map((plan) =>
      plan.intervals.map(({ start, end }) => plan.prefixes.get(end)! - plan.prefixes.get(start)!),
    );
  }

  /** One Range layout read per unique, non-zero prefix offset. */
  private measurePrefixes(text: string, offsets: readonly number[], key: string): Map<number, number> {
    const unique = new Set<number>();
    for (const offset of offsets) {
      if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
        throw new RangeError(`text measurement offset ${offset} is outside 0..${text.length}`);
      }
      unique.add(offset);
    }

    const prefixes = new Map<number, number>();
    prefixes.set(0, 0);
    const pending = [...unique].filter((offset) => offset !== 0).sort((a, b) => a - b);
    if (!pending.length) return prefixes;

    const ctx = this.contextFor(key);
    ctx.textNode.data = text;
    this.measurementStats.probePopulations++;
    this.range.setStart(ctx.textNode, 0);
    try {
      for (const offset of pending) {
        this.range.setEnd(ctx.textNode, offset);
        this.measurementStats.rangeReads++;
        prefixes.set(offset, this.range.getBoundingClientRect().width);
      }
    } finally {
      ctx.textNode.data = '';
    }
    return prefixes;
  }

  /**
   * Widths of contiguous segments tiling `text`, given the segments' end
   * offsets. Measured as prefix differences of Range rects over the whole
   * rendered run, so cross-boundary kerning lands in the segment widths
   * exactly as it will render.
   */
  segmentWidths(text: string, ends: number[], key: string): number[] {
    const prefixes = this.prefixWidths(text, ends, key);
    const out: number[] = [];
    let prev = 0;
    for (const w of prefixes) {
      out.push(w - prev);
      prev = w;
    }
    return out;
  }

  width(text: string, key: string): number {
    const cacheKey = key + '\x1f' + text;
    let w = this.widthCache.get(cacheKey);
    if (w === undefined) {
      const ctx = this.contextFor(key);
      ctx.textNode.data = text;
      this.measurementStats.probePopulations++;
      this.range.setStart(ctx.textNode, 0);
      this.range.setEnd(ctx.textNode, text.length);
      this.measurementStats.rangeReads++;
      w = this.range.getBoundingClientRect().width;
      ctx.textNode.data = '';
      if (this.widthCache.size > 20000) this.widthCache.clear();
      this.widthCache.set(cacheKey, w);
    }
    return w;
  }

  spaceWidth(key: string): number {
    return this.width('x x', key) - this.width('xx', key);
  }

  /** Width of the hyphen glyph injected at hyphenation breaks (U+2010). */
  hyphenWidth(key: string): number {
    return this.width('‐', key);
  }
}
