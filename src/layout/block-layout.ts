// Shared, behavior-preserving support for laying out ProseMirror textblocks.
//
// This module deliberately owns no scheduling and chooses no line breaks. It
// only centralizes the cache contract, stable keys, DOM atom measurement, and
// deterministic painted-prefix measurements used by the layout coordinator.

import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { cssFontStack, effectiveFont } from '../font-registry';
import { getInk, inkKey } from '../math-ink';
import type { DocSettings } from '../settings';
import type { LineLayout } from './paragraph';

export type BlockLayoutOracleState = 'none' | 'ok' | 'fail';

/** Cached browser line layout for one persistent ProseMirror node. */
export interface BlockLayoutEntry {
  measure: number;
  lines: LineLayout[];
  /** State of the compiled Typst oracle when these lines were produced. */
  oracle: BlockLayoutOracleState;
  /**
   * Oracle/content key used for the layout. Resolved atom text lives in this
   * key, so a citation or reference repaint invalidates an otherwise-identical
   * PM node.
   */
  key: string | null;
  /** Painted prefix and content scale used by captions and footnote bodies. */
  indent: number;
  scale: number;
}

/** The fields that decide whether an existing entry remains reusable. */
export interface BlockLayoutCacheKey {
  measure: number;
  oracle: BlockLayoutOracleState;
  key: string | null;
  indent: number;
  scale: number;
}

/** Preserve the coordinator's existing sub-pixel cache tolerances exactly. */
export function blockLayoutEntryMatches(entry: BlockLayoutEntry, expected: BlockLayoutCacheKey): boolean {
  return !(
    Math.abs(entry.measure - expected.measure) > 0.5 ||
    entry.oracle !== expected.oracle ||
    entry.key !== expected.key ||
    Math.abs(entry.indent - expected.indent) > 0.5 ||
    Math.abs(entry.scale - expected.scale) > 0.01
  );
}

/** Weak node-identity cache; unchanged PM subtrees remain reusable after edits. */
export class BlockLayoutCache {
  private entries = new WeakMap<PMNode, BlockLayoutEntry>();

  get(node: PMNode): BlockLayoutEntry | undefined {
    return this.entries.get(node);
  }

  getMatching(node: PMNode, expected: BlockLayoutCacheKey): BlockLayoutEntry | undefined {
    const entry = this.entries.get(node);
    return entry && blockLayoutEntryMatches(entry, expected) ? entry : undefined;
  }

  set(node: PMNode, entry: BlockLayoutEntry): BlockLayoutEntry {
    this.entries.set(node, entry);
    return entry;
  }

  clear() {
    this.entries = new WeakMap();
  }
}

export type BlockLayoutSettings = Pick<
  DocSettings,
  'font' | 'sizePt' | 'lineHeight' | 'hyphenate' | 'parIndent'
>;

/** Stable font-and-paragraph settings component of every block oracle key. */
export function blockLayoutSettingsKey(settings: BlockLayoutSettings): string {
  const font = effectiveFont(settings.font);
  return `${font.id}|${settings.sizePt}|${settings.lineHeight}|${settings.hyphenate}|${settings.parIndent}`;
}

/** Complete oracle key, including context, rounded browser measure, and text. */
export function blockOracleKey(settingsKey: string, keyTag: string, measure: number, specKey: string): string {
  return `${settingsKey}|${keyTag}|w${measure.toFixed(1)}|${specKey}`;
}

/** Whether the paragraph at `pos` directly follows a sibling paragraph. */
export function consecutiveParagraph(doc: PMNode, pos: number): boolean {
  const $pos = doc.resolve(pos);
  const index = $pos.index();
  return index > 0 && $pos.parent.child(index - 1).type.name === 'paragraph';
}

/** Body-paragraph context tag used by the compiled-oracle cache. */
export function paragraphKeyTag(settings: Pick<DocSettings, 'parIndent'>, doc: PMNode, pos: number): 'p' | 'pi' {
  return settings.parIndent && consecutiveParagraph(doc, pos) ? 'pi' : 'p';
}

export type AtomWidth = (offset: number, child: PMNode) => number;

/**
 * Atom advance for browser line layout. Math uses cached Typst ink because
 * its DOM rect includes hover-box padding; other atoms use their rendered DOM
 * width. The node-size fallback is intentionally unchanged.
 */
export function makeAtomWidth(view: EditorView, settings: DocSettings, pos: number): AtomWidth {
  return (offset, child) => {
    if (child.type.name === 'math_inline') {
      const ink = getInk(inkKey(child.attrs.src as string, false, settings));
      if (ink) return ink.widthPx;
    }
    const dom = view.nodeDOM(pos + 1 + offset);
    if (dom instanceof HTMLElement) return dom.getBoundingClientRect().width;
    return child.nodeSize * 8;
  };
}

/** Mirrors `.fn-body { font-size: 0.85em }` in style.css. */
export const FOOTNOTE_SCALE = 0.85;

export interface PaintedPrefixMeasurements {
  footnoteScale: typeof FOOTNOTE_SCALE;
  footnoteIndent(number: number): number;
  captionIndent(number: number): number;
}

let measureContext: CanvasRenderingContext2D | null = null;

/** Canvas text width at an exact, bundled CSS font stack. */
function textWidth(text: string, font: string): number {
  measureContext ??= document.createElement('canvas').getContext('2d');
  if (!measureContext) throw new Error('2D canvas context unavailable');
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * Deterministic widths for prefixes painted outside document content. These
 * constants mirror style.css and must not be replaced with live widget reads:
 * a layout run can occur before a widget has painted.
 */
export function createPaintedPrefixMeasurements(
  fontName: string,
  bodyPx: number,
): PaintedPrefixMeasurements {
  const fontStack = cssFontStack(fontName);
  return {
    footnoteScale: FOOTNOTE_SCALE,
    footnoteIndent(number) {
      const footnotePx = FOOTNOTE_SCALE * bodyPx;
      const numberPx = 0.72 * footnotePx;
      return (
        0.9 * footnotePx +
        textWidth(String(number), `${numberPx}px ${fontStack}`) +
        0.15 * numberPx
      );
    },
    captionIndent(number) {
      return textWidth(`Figure ${number}:`, `${bodyPx}px ${fontStack}`) + 0.32 * bodyPx;
    },
  };
}
