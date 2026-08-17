// Presentation-only decorations for imposing an authoritative line layout
// on ProseMirror. These widgets never enter the document model: clipboard,
// undo, serialization, accessibility, and exported content remain clean.

import type { Node as PMNode } from 'prosemirror-model';
import { Decoration } from 'prosemirror-view';
import type { LineLayout } from './paragraph';

export interface Spacer {
  pos: number;
  height: number;
  kind: 'line' | 'block';
}

/** The two DOM halves of a hyphenated word read as separate words to the
 * browser spellchecker, which flags the tail ("ically"). Wrap the whole
 * word in spellcheck="false" — the split is presentation, not content. */
export function noSpellDeco(node: PMNode, base: number, breakPos: number): Decoration | null {
  const text = node.textBetween(0, node.content.size, '\u0000', '\u0000');
  const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}\u2019'-]/u.test(ch);
  let a = breakPos;
  while (a > 0 && isWordChar(text[a - 1])) a--;
  let b = breakPos;
  while (b < text.length && isWordChar(text[b])) b++;
  if (a >= b) return null;
  return Decoration.inline(base + a, base + b, { spellcheck: 'false' }, { sig: 'nospell' });
}

export function brWidget() {
  const br = document.createElement('br');
  br.className = 'ts-br';
  br.setAttribute('aria-hidden', 'true');
  return br;
}

export function hyphenWidget() {
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
export function pageGapWidget(height: number, hyphen: boolean) {
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

/** A line-position page spacer. `key` is accepted for mapped-decoration
 * revival, where the original identity must survive even if its position
 * was re-anchored by a transaction. */
export function pageSpacerDecoration(
  pos: number,
  height: number,
  hyphen: boolean,
  key = `pg:${pos}:${Math.round(height)}:${hyphen ? 'h' : ''}`,
): Decoration {
  return Decoration.widget(pos, () => pageGapWidget(height, hyphen), {
    side: -1,
    key,
    h: height,
    hy: hyphen,
  });
}

/** A spacer between whole blocks rather than at a paragraph line break. */
export function blockSpacerDecoration(spacer: Spacer): Decoration {
  return Decoration.widget(spacer.pos, () => pageGapWidget(spacer.height, false), {
    side: -1,
    key: `pgb:${spacer.pos}:${Math.round(spacer.height)}`,
    h: spacer.height,
  });
}

export type LineSpacerResolver = (line: LineLayout, pos: number) => Spacer | undefined;

/** Stable CSS precision for computed word spacing. Equivalent prefix sums
 * can differ by a few floating-point ulps depending on how intervals were
 * grouped; normalize exact half-thousandths explicitly so that arithmetic
 * grouping cannot change the painted value. */
export function wordSpacingValue(spacing: number): string {
  if (Math.abs(spacing) <= 0.01) return '';
  const rounded = Math.sign(spacing) * Math.round((Math.abs(spacing) + 1e-9) * 1000) / 1000;
  return rounded.toFixed(3);
}

/** Append justification, break, optional page-gap, and spellcheck
 * decorations for a block. Inline spacing skips nested footnote bodies,
 * whose editable content owns its own line decorations. */
export function appendLineDecorations(
  target: Decoration[],
  node: PMNode,
  pos: number,
  lines: readonly LineLayout[],
  spacerAt?: LineSpacerResolver,
) {
  const base = pos + 1;
  const fnRanges: Array<[number, number]> = [];
  node.forEach((child, offset) => {
    if (child.type.name === 'footnote') fnRanges.push([offset, offset + child.nodeSize]);
  });

  const emitSpacing = (from: number, to: number, style: string) => {
    let cur = from;
    for (const [a, bEnd] of fnRanges) {
      if (bEnd <= cur || a >= to) continue;
      if (a > cur) target.push(Decoration.inline(base + cur, base + a, { style }, { sig: style }));
      cur = Math.max(cur, bEnd);
    }
    if (cur < to) target.push(Decoration.inline(base + cur, base + to, { style }, { sig: style }));
  };

  for (const line of lines) {
    const spacing = wordSpacingValue(line.spacing);
    if (spacing) {
      emitSpacing(line.from, line.to, `word-spacing:${spacing}px`);
    }
    if (line.breakPos === null) continue;

    const at = base + line.breakPos;
    const spacer = spacerAt?.(line, at);
    if (spacer) {
      target.push(pageSpacerDecoration(at, spacer.height, line.hyphen));
    } else {
      target.push(
        Decoration.widget(at, line.hyphen ? hyphenWidget : brWidget, {
          side: -1,
          key: `${line.hyphen ? 'hy' : 'br'}:${at}`,
        }),
      );
    }
    if (line.hyphen) {
      const ns = noSpellDeco(node, base, line.breakPos);
      if (ns) target.push(ns);
    }
  }
}

/** Stable identity for a complete decoration list. DOM factories are
 * intentionally excluded; their key/sig specs contain the semantic state. */
export function decorationSignature(decorations: readonly Decoration[]): string {
  return decorations
    .map(
      (d) =>
        `${d.from}:${d.to}:${
          (d.spec as { key?: string } | null)?.key ?? (d.spec as { sig?: string } | null)?.sig ?? ''
        }`,
    )
    .join('|');
}
