// Development-only differential harness for the direct forced translator.
// Keeping it outside the ProseMirror coordinator makes the expensive shadow
// work opt-in and keeps production layout orchestration easy to read.

import type { Node as PMNode } from 'prosemirror-model';
import type { AtomWidth } from './block-layout';
import { layoutForcedBlock, type ForcedLayoutOptions } from './forced-layout';
import { wordSpacingValue } from './line-decorations';
import { Measurer } from './measure';
import { layoutBlock, type ForcedBreak, type LineLayout } from './paragraph';

export interface NormalizedForcedLine {
  from: number;
  to: number;
  breakPos: number | null;
  hyphen: boolean;
  spacing: string;
}

export interface ForcedLayoutAuditCase {
  id: string;
  sample: string;
  scale: number;
  forced: ForcedBreak[];
  fast: NormalizedForcedLine[] | null;
  legacy: NormalizedForcedLine[] | null;
  fastReads: number;
  legacyReads: number;
  fastPopulations: number;
  legacyPopulations: number;
  hardBreak: boolean;
  /** Whether the legacy partitioner has an item for every forced cut. A
   * glyphless punctuation split (break before an em-dash, after a link's
   * '/') exists only in the direct translator; on those cases fast succeeds
   * while legacy declines by design. */
  legacyRepresentable: boolean;
}

export interface ForcedLayoutAuditReport {
  cases: ForcedLayoutAuditCase[];
}

function normalize(lines: LineLayout[] | null): NormalizedForcedLine[] | null {
  return lines?.map((line) => ({
    from: line.from,
    to: line.to,
    breakPos: line.breakPos,
    hyphen: line.hyphen,
    spacing: wordSpacingValue(line.spacing),
  })) ?? null;
}

export class ForcedLayoutAuditor {
  private enabled = false;
  private cases = new Map<string, ForcedLayoutAuditCase>();

  constructor(private editorDom: HTMLElement) {}

  start(): void {
    this.enabled = true;
    this.cases.clear();
  }

  snapshot(): ForcedLayoutAuditReport {
    return { cases: [...this.cases.values()] };
  }

  stop(): ForcedLayoutAuditReport {
    this.enabled = false;
    return this.snapshot();
  }

  record(
    id: string,
    block: PMNode,
    measure: number,
    atomWidth: AtomWidth,
    opts: ForcedLayoutOptions,
  ): void {
    if (!this.enabled) return;
    const fastMeasurer = new Measurer(this.editorDom);
    const legacyMeasurer = new Measurer(this.editorDom);
    try {
      const fast = layoutForcedBlock(block, measure, fastMeasurer, atomWidth, opts);
      const fastStats = fastMeasurer.stats();
      const legacy = layoutBlock(block, measure, legacyMeasurer, atomWidth, {
        ...opts,
        forced: [...opts.forced],
      });
      const legacyStats = legacyMeasurer.stats();
      const forced = opts.forced.map((entry) => ({ ...entry }));
      const key = `${id}|${measure.toFixed(2)}|${opts.scale ?? 1}|${forced
        .map((entry) => `${entry.at}${entry.hyphen ? 'h' : 'b'}`)
        .join(',')}|${block.textContent}`;
      let hardBreak = false;
      block.forEach((child) => {
        if (child.type.name === 'hard_break') hardBreak = true;
      });
      // Offset-aligned text: index == PM content offset (atom and nested
      // inline nodes become padding, matching the translators' token model).
      let aligned = '';
      block.forEach((child, childOffset) => {
        if (child.isText && child.text) aligned = aligned.padEnd(childOffset) + child.text;
      });
      const legacyRepresentable = forced.every((entry) => {
        if (!entry.hyphen) return true;
        if (opts.hyphenate === false) return false;
        const before = aligned[entry.at - 1] ?? '';
        const after = aligned[entry.at] ?? '';
        return /[-–—]/.test(before) || (/\p{L}/u.test(before) && /\p{L}/u.test(after));
      });
      this.cases.set(key, {
        id,
        sample: block.textContent.slice(0, 48),
        scale: opts.scale ?? 1,
        forced,
        fast: normalize(fast),
        legacy: normalize(legacy),
        fastReads: fastStats.rangeReads,
        legacyReads: legacyStats.rangeReads,
        fastPopulations: fastStats.probePopulations,
        legacyPopulations: legacyStats.probePopulations,
        hardBreak,
        legacyRepresentable,
      });
    } finally {
      fastMeasurer.destroy();
      legacyMeasurer.destroy();
    }
  }
}
