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

export class Measurer {
  private probe: HTMLElement;
  private contexts = new Map<string, MarkContext>();
  private widthCache = new Map<string, number>();
  private range = document.createRange();

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

  /** Opaque measurement-context key for text carrying the given marks. */
  fontFor(marks: readonly Mark[]): string {
    return marks
      .map((m) => m.type.name)
      .filter((n) => MARK_TAG[n])
      .sort()
      .join(',');
  }

  private contextFor(key: string): MarkContext {
    let ctx = this.contexts.get(key);
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
    this.contexts.set(key, ctx);
    return ctx;
  }

  /**
   * Widths of contiguous segments tiling `text`, given the segments' end
   * offsets. Measured as prefix differences of Range rects over the whole
   * rendered run, so cross-boundary kerning lands in the segment widths
   * exactly as it will render.
   */
  segmentWidths(text: string, ends: number[], key: string): number[] {
    const ctx = this.contextFor(key);
    ctx.textNode.data = text;
    this.range.setStart(ctx.textNode, 0);
    const out: number[] = [];
    let prev = 0;
    for (const end of ends) {
      this.range.setEnd(ctx.textNode, end);
      const w = this.range.getBoundingClientRect().width;
      out.push(w - prev);
      prev = w;
    }
    ctx.textNode.data = '';
    return out;
  }

  width(text: string, key: string): number {
    const cacheKey = key + '\x1f' + text;
    let w = this.widthCache.get(cacheKey);
    if (w === undefined) {
      const ctx = this.contextFor(key);
      ctx.textNode.data = text;
      this.range.setStart(ctx.textNode, 0);
      this.range.setEnd(ctx.textNode, text.length);
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
