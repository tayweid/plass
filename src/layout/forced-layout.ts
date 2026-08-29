// Fast translation of authoritative Typst break offsets into browser line
// layouts. This module never chooses breaks: it validates the supplied
// ForcedBreak list, measures only the resulting line/style intervals, and
// applies the same word-spacing rules as layoutBlock(...forced).

import type { Node as PMNode } from 'prosemirror-model';
import type { AtomWidth } from './block-layout';
import type { Measurer, TextMeasureInterval } from './measure';
import { fitEps, lineWordSpacing, type ForcedBreak, type LineLayout } from './paragraph';

export type ForcedLayoutMeasurer = Pick<
  Measurer,
  'fontFor' | 'intervalWidthsBatch' | 'spaceWidth' | 'hyphenWidth'
>;

export interface ForcedLayoutOptions {
  /** Breaks selected by the port or compiled Typst oracle. */
  forced: readonly ForcedBreak[];
  /** Inline atoms whose width the line decides (raw Typst using `fr`). This
   *  path does not model them, so a block containing one declines to the
   *  translator, which does. */
  isFill?: (child: PMNode) => boolean;
  /** False rejects glyph-injecting hyphenation cuts (letter|letter);
   *  glyphless splits at existing dashes and punctuation stay valid —
   *  Typst breaks there regardless of the hyphenation setting. */
  hyphenate?: boolean;
  /** Width consumed by a painted prefix on the first line. */
  firstLineIndent?: number;
  /** Text/hyphen em scale. Atoms and the painted prefix are already scaled. */
  scale?: number;
}

interface TextRun {
  text: string;
  font: string;
  intervals: TextMeasureInterval[];
  widths: number[];
}

interface TextToken {
  kind: 'box' | 'space';
  from: number;
  to: number;
  run: TextRun;
  localFrom: number;
  localTo: number;
}

interface FixedBoxToken {
  kind: 'box';
  from: number;
  to: number;
  width: number;
}

interface HyphenToken {
  kind: 'hyphen';
  from: number;
  to: number;
  width: number;
  glyphless: boolean;
}

interface BoundaryToken {
  kind: 'nodebreak' | 'end';
  from: number;
  to: number;
}

type Token = TextToken | FixedBoxToken | HyphenToken | BoundaryToken;

interface MeasuredContribution {
  run: TextRun;
  interval: number;
}

interface LineDraft {
  from: number;
  to: number;
  spaces: number;
  contributions: Array<number | MeasuredContribution>;
  breakKind: Token['kind'];
  /** Start offset of the break token (LineLayout.oracleBreak's `at`). */
  breakAt: number;
  breakPos: number | null;
  hyphen: boolean;
  hyphenWidth: number;
}

function isTextToken(token: Token): token is TextToken {
  return (token.kind === 'box' || token.kind === 'space') && 'run' in token;
}

function isBox(token: Token): token is TextToken | FixedBoxToken {
  return token.kind === 'box';
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function adjacentCodePoints(text: string, offset: number): { before: string; after: string } {
  const before = [...text.slice(0, offset)].at(-1) ?? '';
  const after = [...text.slice(offset)][0] ?? '';
  return { before, after };
}

/**
 * Translate authoritative breaks without syllabification or KP items.
 *
 * Conservative null cases intentionally fall back to the existing forced
 * translator: malformed/unordered offsets, a normal break that is not the
 * start of a retained whitespace run, a break after a soft hyphen (SHY),
 * a hyphenation cut while hyphenation is disabled, a boundary between PM
 * text runs, or a UTF-16 surrogate split. Intra-token `hyphen` cuts whose
 * adjacency is not letter|letter translate as glyphless breaks (existing
 * dashes, em-dashes carried forward, link punctuation) — the legacy
 * partitioner has no item at most of those offsets, so this translator is
 * their only representation.
 *
 * Hard breaks are always partitioned, including after the last forced point.
 * This fixes the legacy forced translator's accidental final-segment merge;
 * empty hard-break segments still emit no LineLayout, matching its treatment
 * of boxless lines.
 */
export function layoutForcedBlock(
  block: PMNode,
  measure: number,
  measurer: ForcedLayoutMeasurer,
  atomWidth: AtomWidth,
  opts: ForcedLayoutOptions,
): LineLayout[] | null {
  const K = opts.scale ?? 1;
  // Flexible atoms need the slack arithmetic this path skips: decline, and
  // the established translator produces the line's fill widths.
  if (opts.isFill) {
    let flexible = false;
    block.forEach((child) => {
      if (!flexible && opts.isFill?.(child)) flexible = true;
    });
    if (flexible) return null;
  }
  // layoutBlock returns before inspecting forced points when construction
  // produced no box. Preserve that edge case (empty/whitespace/hard-only
  // blocks), including its treatment of otherwise malformed forced input.
  let hasPotentialBox = !!opts.firstLineIndent;
  block.forEach((child) => {
    if ((child.isText && !!child.text && /\S/.test(child.text)) ||
        (!child.isText && child.type.name !== 'hard_break')) {
      hasPotentialBox = true;
    }
  });
  if (!hasPotentialBox) return [];

  let previousAt = -1;
  for (const forced of opts.forced) {
    if (
      !Number.isSafeInteger(forced.at) ||
      forced.at < 0 ||
      forced.at > block.content.size ||
      forced.at <= previousAt
    ) {
      return null;
    }
    previousAt = forced.at;
  }

  const tokens: Token[] = [];
  const runs: TextRun[] = [];
  const consumedHyphens = new Set<number>();
  let invalid = false;

  if (opts.firstLineIndent) {
    tokens.push({ kind: 'box', from: 0, to: 0, width: opts.firstLineIndent });
  }

  const trimTrailingSpaces = () => {
    while (tokens.at(-1)?.kind === 'space') tokens.pop();
  };

  block.forEach((child, offset) => {
    if (invalid) return;
    if (child.isText && child.text) {
      const text = child.text;
      const font = measurer.fontFor(child.marks);
      const run: TextRun = { text, font, intervals: [], widths: [] };
      runs.push(run);

      const re = /\s+|\S+/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text))) {
        const localStart = match.index;
        const localEnd = localStart + match[0].length;
        if (/\s/.test(match[0][0])) {
          // Preserve layoutBlock's unusual-but-existing indent behavior: a
          // painted prefix makes an initial space non-leading.
          const previous = tokens.at(-1);
          if (!previous || previous.kind === 'nodebreak') continue;
          tokens.push({
            kind: 'space',
            from: offset + localStart,
            to: offset + localEnd,
            run,
            localFrom: localStart,
            localTo: localEnd,
          });
          continue;
        }

        const cuts: number[] = [];
        for (const forced of opts.forced) {
          if (!forced.hyphen) continue;
          const local = forced.at - offset;
          if (local <= localStart || local >= localEnd) continue;
          if (splitsSurrogatePair(text, local)) {
            invalid = true;
            return;
          }
          // A glyph is injected only for a real hyphenation point
          // (letter|letter, and only with hyphenation enabled). Every other
          // split — an existing dash, an em-dash carried to the next line, a
          // '/' or '.' boundary inside a link — breaks glyphlessly, exactly
          // as Typst renders a Normal breakpoint. SHY stays unrepresentable
          // (Typst paints a glyph the adjacency rule would drop): decline.
          const { before, after } = adjacentCodePoints(text, local);
          if (before === '\u00ad') {
            invalid = true;
            return;
          }
          const letterBoth = /^\p{L}$/u.test(before) && /^\p{L}$/u.test(after);
          if (letterBoth && opts.hyphenate === false) {
            invalid = true;
            return;
          }
          cuts.push(local);
          consumedHyphens.add(forced.at);
        }

        let partStart = localStart;
        for (const partEnd of [...cuts, localEnd]) {
          if (partStart !== localStart) {
            const { before, after } = adjacentCodePoints(text, partStart);
            const glyphless = !(/^\p{L}$/u.test(before) && /^\p{L}$/u.test(after));
            tokens.push({
              kind: 'hyphen',
              from: offset + partStart,
              to: offset + partStart,
              width: glyphless ? 0 : measurer.hyphenWidth(font) * K,
              glyphless,
            });
          }
          tokens.push({
            kind: 'box',
            from: offset + partStart,
            to: offset + partEnd,
            run,
            localFrom: partStart,
            localTo: partEnd,
          });
          partStart = partEnd;
        }
      }
    } else if (child.type.name === 'hard_break') {
      trimTrailingSpaces();
      tokens.push({ kind: 'nodebreak', from: offset, to: offset + child.nodeSize });
    } else {
      tokens.push({
        kind: 'box',
        from: offset,
        to: offset + child.nodeSize,
        width: atomWidth(offset, child),
      });
    }
  });

  if (invalid) return null;
  if (opts.forced.some((forced) => forced.hyphen && !consumedHyphens.has(forced.at))) return null;
  if (!tokens.some(isBox)) return [];

  trimTrailingSpaces();
  tokens.push({ kind: 'end', from: block.content.size, to: block.content.size });

  const forcedTokenIndexes = new Set<number>();
  for (const forced of opts.forced) {
    const index = tokens.findIndex(
      (token) =>
        token.from === forced.at &&
        (forced.hyphen ? token.kind === 'hyphen' : token.kind === 'space'),
    );
    if (index < 0) return null;
    forcedTokenIndexes.add(index);
  }

  const partitions: Array<{ start: number; end: number }> = [];
  let partitionStart = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'nodebreak' || token.kind === 'end' || forcedTokenIndexes.has(index)) {
      partitions.push({ start: partitionStart, end: index });
      partitionStart = index + 1;
    }
  }

  const drafts: LineDraft[] = [];
  for (const partition of partitions) {
    const breakToken = tokens[partition.end];
    let contentEnd = partition.end - 1;
    while (contentEnd >= partition.start && !isBox(tokens[contentEnd])) contentEnd--;
    if (contentEnd < partition.start) continue;

    let spaces = 0;
    const contributions: Array<number | MeasuredContribution> = [];
    for (let index = partition.start; index <= contentEnd; index++) {
      const token = tokens[index];
      if (token.kind === 'space') spaces++;
      if (isTextToken(token)) {
        let localEnd = token.localTo;
        let last = index;
        while (last + 1 <= contentEnd) {
          const next = tokens[last + 1];
          if (!isTextToken(next) || next.run !== token.run || next.localFrom !== localEnd) break;
          localEnd = next.localTo;
          last++;
          if (next.kind === 'space') spaces++;
        }
        const interval = token.run.intervals.length;
        token.run.intervals.push({ start: token.localFrom, end: localEnd });
        contributions.push({ run: token.run, interval });
        index = last;
      } else if (token.kind === 'box') {
        contributions.push(token.width);
      }
    }

    const hyphenKind = breakToken.kind === 'hyphen';
    drafts.push({
      from: tokens[partition.start].from,
      to: tokens[contentEnd].to,
      spaces,
      contributions,
      breakKind: breakToken.kind,
      breakAt: breakToken.from,
      breakPos:
        breakToken.kind === 'space'
          ? breakToken.to
          : hyphenKind
            ? breakToken.from
            : null,
      hyphen: hyphenKind && !breakToken.glyphless,
      hyphenWidth: hyphenKind ? breakToken.width : 0,
    });
  }

  // One batch: all probe writes land before all Range reads, so measuring
  // every run costs a single forced layout pass.
  const measuredRuns = runs.filter((run) => run.intervals.length);
  if (measuredRuns.length) {
    const widths = measurer.intervalWidthsBatch(
      measuredRuns.map((run) => ({ text: run.text, intervals: run.intervals, key: run.font })),
    );
    measuredRuns.forEach((run, index) => {
      run.widths = widths[index];
    });
  }

  const baseFont = measurer.fontFor([]);
  const baseSpace = measurer.spaceWidth(baseFont) * K;
  const eps = fitEps(K);

  return drafts.map((draft) => {
    let natural = 0;
    for (const contribution of draft.contributions) {
      natural +=
        typeof contribution === 'number'
          ? contribution
          : contribution.run.widths[contribution.interval] * K;
    }
    natural += draft.hyphenWidth;

    const justified = draft.breakKind === 'space' || draft.breakKind === 'hyphen';
    const spacing = lineWordSpacing(justified, draft.spaces, natural, measure, eps, baseSpace);

    return {
      from: draft.from,
      to: draft.to,
      spacing,
      breakPos: draft.breakPos,
      hyphen: draft.hyphen,
      oracleBreak: justified ? { at: draft.breakAt, hyphen: draft.breakKind === 'hyphen' } : undefined,
    };
  });
}
