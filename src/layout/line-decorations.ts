// Presentation-only decorations for imposing an authoritative line layout
// on ProseMirror. These widgets never enter the document model: clipboard,
// undo, serialization, accessibility, and exported content remain clean.

import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, type DecorationSet } from 'prosemirror-view';
import type { LineLayout } from './paragraph';
import { applyFill } from '../inline-raw';

/** Semantic roles owned by the typesetting layer. These tags are deliberately
 * independent of widget keys: callers can select layout decorations without
 * inferring their meaning from a key prefix. */
export type TypesetDecorationKind =
  | 'word-spacing'
  | 'line-break'
  | 'hyphen-break'
  | 'no-spell'
  | 'line-page-gap'
  | 'block-page-gap';

export interface TypesetDecorationSpec {
  tsKind: TypesetDecorationKind;
  key?: string;
  sig?: string;
  h?: number;
  hy?: boolean;
}

/** A current, mapped ProseMirror node range. Ownership is range-based rather
 * than stored as an absolute position in a decoration spec: specs are not
 * remapped when edits before a block move it. `to` is exclusive. */
export interface BlockDecorationScope {
  from: number;
  to: number;
  /** Nested editable blocks (currently footnote bodies) own their own line
   * decorations and can be excluded from an outer block replacement. */
  exclude?: readonly DecorationRange[];
}

export interface DecorationRange {
  from: number;
  to: number;
}

export interface BlockDecorationRebuild {
  decos: DecorationSet;
  changed: boolean;
  digest: string;
  removed: number;
  added: number;
}

const BLOCK_DECORATION_KINDS = new Set<TypesetDecorationKind>([
  'word-spacing',
  'line-break',
  'hyphen-break',
  'no-spell',
  'line-page-gap',
]);

function typesetKind(spec: unknown): TypesetDecorationKind | null {
  if (!spec || typeof spec !== 'object') return null;
  const kind = (spec as { tsKind?: unknown }).tsKind;
  return typeof kind === 'string' &&
    (BLOCK_DECORATION_KINDS.has(kind as TypesetDecorationKind) || kind === 'block-page-gap')
    ? (kind as TypesetDecorationKind)
    : null;
}

function isBlockDecorationSpec(spec: unknown): boolean {
  const kind = typesetKind(spec);
  return kind !== null && BLOCK_DECORATION_KINDS.has(kind);
}

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
  return Decoration.inline(
    base + a,
    base + b,
    { spellcheck: 'false' },
    { sig: 'nospell', tsKind: 'no-spell' } satisfies TypesetDecorationSpec,
  );
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
export function pageGapWidget(height: number, hyphen: boolean, key?: string) {
  const gap = document.createElement('div');
  gap.className = 'ts-pagegap';
  gap.style.height = `${height.toFixed(2)}px`;
  if (key) gap.dataset.tsGapKey = key;
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
  return Decoration.widget(pos, () => pageGapWidget(height, hyphen, key), {
    side: -1,
    key,
    h: height,
    hy: hyphen,
    tsKind: 'line-page-gap',
  });
}

/** A spacer between whole blocks rather than at a paragraph line break. */
export function blockSpacerDecoration(spacer: Spacer): Decoration {
  const key = `pgb:${spacer.pos}:${Math.round(spacer.height)}`;
  return Decoration.widget(spacer.pos, () => pageGapWidget(spacer.height, false, key), {
    side: -1,
    key,
    h: spacer.height,
    tsKind: 'block-page-gap',
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
      if (a > cur) {
        target.push(
          Decoration.inline(
            base + cur,
            base + a,
            { style },
            { sig: style, tsKind: 'word-spacing' } satisfies TypesetDecorationSpec,
          ),
        );
      }
      cur = Math.max(cur, bEnd);
    }
    if (cur < to) {
      target.push(
        Decoration.inline(
          base + cur,
          base + to,
          { style },
          { sig: style, tsKind: 'word-spacing' } satisfies TypesetDecorationSpec,
        ),
      );
    }
  };

  for (const line of lines) {
    const spacing = wordSpacingValue(line.spacing);
    if (spacing) {
      emitSpacing(line.from, line.to, `word-spacing:${spacing}px`);
    }
    // Flexible (fr) inline atoms take the line's leftover space: layout
    // measured it, the atom's view paints it. Both layout paths land here,
    // so the assignment happens once, wherever the lines came from.
    if (line.fills) {
      for (const offset of line.fills.offsets) {
        const child = node.nodeAt(offset);
        if (child) applyFill(child, line.fills.width);
      }
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
          tsKind: line.hyphen ? 'hyphen-break' : 'line-break',
        }),
      );
    }
    if (line.hyphen) {
      const ns = noSpellDeco(node, base, line.breakPos);
      if (ns) target.push(ns);
    }
  }
}

interface DecorationSemanticEntry {
  from: number;
  to: number;
  kind: string;
  identity: string;
}

function semanticEntry(decoration: Decoration, relativeTo: number): DecorationSemanticEntry {
  const spec = decoration.spec as Partial<TypesetDecorationSpec> | null;
  const kind = typesetKind(spec);
  let identity: string;
  switch (kind) {
    case 'line-break':
    case 'hyphen-break':
      // Absolute positions embedded in widget keys become stale when mapped;
      // current from/to plus the semantic kind are sufficient identity.
      identity = '';
      break;
    case 'line-page-gap':
      identity = `${spec?.h ?? ''}:${spec?.hy ? 'h' : ''}`;
      break;
    case 'block-page-gap':
      identity = String(spec?.h ?? '');
      break;
    case 'word-spacing':
    case 'no-spell':
      identity = spec?.sig ?? '';
      break;
    default:
      // Untagged decorations retain the historical compatibility behavior.
      identity = spec?.key ?? spec?.sig ?? '';
  }
  return {
    from: decoration.from - relativeTo,
    to: decoration.to - relativeTo,
    kind: kind ?? '',
    identity,
  };
}

/** Binary code-unit order: only equality of the joined canonical string
 * matters, and locale collation can rank distinct strings equal (and is far
 * slower), so it must not decide the canonical order. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSemanticEntries(a: DecorationSemanticEntry, b: DecorationSemanticEntry): number {
  return (
    a.from - b.from ||
    a.to - b.to ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.identity, b.identity)
  );
}

function canonicalEntries(entries: DecorationSemanticEntry[]): string {
  return entries
    .sort(compareSemanticEntries)
    .map(({ from, to, kind, identity }) => `${from}:${to}:${kind}:${identity}`)
    .join('|');
}

/** Stable, order-independent identity for a decoration list. DOM factories
 * are intentionally excluded. Tagged widgets use their current position and
 * visible payload rather than absolute-position keys that mapping leaves
 * untouched. `relativeTo` produces a block-relative digest without mutating
 * or reordering the caller's array. */
export function decorationSignature(decorations: readonly Decoration[], relativeTo = 0): string {
  return canonicalEntries(decorations.map((decoration) => semanticEntry(decoration, relativeTo)));
}

/** Canonical semantic digest of a complete persistent DecorationSet. */
export function decorationSetDigest(decos: DecorationSet): string {
  return decorationSignature(decos.find());
}

function assertRange(range: DecorationRange, label: string): void {
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 0 || range.to < range.from) {
    throw new RangeError(`${label} must be a non-negative, ordered ProseMirror range`);
  }
}

/** Whether a decoration belongs wholly to a half-open current block range.
 * Widgets at `to` belong to the following block, avoiding shared-boundary
 * removals. */
function containedBy(decoration: Decoration, range: DecorationRange): boolean {
  return decoration.from === decoration.to
    ? decoration.from >= range.from && decoration.from < range.to
    : decoration.from >= range.from && decoration.to <= range.to;
}

function inExcludedRange(decoration: Decoration, scope: BlockDecorationScope): boolean {
  return scope.exclude?.some((range) => containedBy(decoration, range)) ?? false;
}

/** Return the current mapped line-layout decorations owned by a block. Page
 * spacers between whole blocks are deliberately not block-owned. */
export function decorationsOwnedByBlock(
  decos: DecorationSet,
  scope: BlockDecorationScope,
): Decoration[] {
  assertRange(scope, 'block decoration scope');
  for (const range of scope.exclude ?? []) assertRange(range, 'excluded decoration range');
  return decos
    .find(scope.from, scope.to, isBlockDecorationSpec)
    .filter((decoration) => containedBy(decoration, scope) && !inExcludedRange(decoration, scope));
}

function blockDecorationsSignature(decorations: readonly Decoration[], relativeTo: number): string {
  return canonicalEntries(decorations.map((decoration) => semanticEntry(decoration, relativeTo)));
}

/** Block-relative semantic digest suitable for comparing freshly-built line
 * decorations with their already-mapped counterparts. */
export function blockDecorationDigest(decos: DecorationSet, scope: BlockDecorationScope): string {
  return blockDecorationsSignature(decorationsOwnedByBlock(decos, scope), scope.from);
}

/** Remove every explicitly tagged decoration owned by the current block,
 * leaving nested exclusions, other blocks, and block-level page gaps intact. */
export function removeDecorationsOwnedByBlock(
  decos: DecorationSet,
  scope: BlockDecorationScope,
): DecorationSet {
  const owned = decorationsOwnedByBlock(decos, scope);
  return owned.length ? decos.remove(owned.slice()) : decos;
}

/** Atomically replace one block's owned decorations. An equal semantic digest
 * returns the original persistent set, allowing live/settled no-op dispatches
 * to be skipped. Input arrays are never consumed by DecorationSet.add/remove. */
export function rebuildDecorationsOwnedByBlock(
  decos: DecorationSet,
  doc: PMNode,
  scope: BlockDecorationScope,
  replacements: readonly Decoration[],
): BlockDecorationRebuild {
  assertRange(scope, 'block decoration scope');
  for (const decoration of replacements) {
    if (!isBlockDecorationSpec(decoration.spec)) {
      throw new TypeError('replacement contains a decoration that is not block-owned');
    }
    if (!containedBy(decoration, scope) || inExcludedRange(decoration, scope)) {
      throw new RangeError('replacement decoration lies outside its block ownership scope');
    }
  }

  const existing = decorationsOwnedByBlock(decos, scope);
  const digest = blockDecorationsSignature(replacements, scope.from);
  if (blockDecorationsSignature(existing, scope.from) === digest) {
    return { decos, changed: false, digest, removed: 0, added: 0 };
  }

  let rebuilt = existing.length ? decos.remove(existing.slice()) : decos;
  if (replacements.length) rebuilt = rebuilt.add(doc, replacements.slice());
  return {
    decos: rebuilt,
    changed: true,
    digest,
    removed: existing.length,
    added: replacements.length,
  };
}
