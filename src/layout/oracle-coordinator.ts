// Lifecycle and confidence policy for the two Typst-backed layout oracles.
// Break selection and scheduling stay with the underlying oracles/caller.

import { PageOracle, type PageOracleEntry } from './page-oracle';
import { TypstOracle } from './typst-oracle';

export interface PageHoldDecision {
  /** Whether mapped page-start markers may be reused for this entry. */
  hold: boolean;
  /** Preferred source before the caller validates exact starts/held marks. */
  confidence: 'exact' | 'held' | 'fallback';
  /** Consecutive distinct failure entries since the last success. */
  failureStreak: number;
  status: 'ok' | 'fail' | 'pending';
}

/**
 * Confidence policy for mapped-through-edit page starts. A repeated read of
 * the same failed cache entry counts once; a successful publication heals
 * the streak. Pending/missing answers can retain the last known starts; only
 * the current fourth-or-later distinct failure requires fallback.
 */
export class PageHoldConfidence {
  private streak = 0;
  private lastFailure: PageOracleEntry | null = null;

  /** Record a newly published result. This is separate from reads because a
   * successful exact layout normally returns before the recovery path calls
   * observe(), but it must still heal the failure streak. */
  record(entry: PageOracleEntry): void {
    if (entry?.status === 'ok') {
      this.streak = 0;
      this.lastFailure = null;
    } else if (entry?.status === 'fail' && entry !== this.lastFailure) {
      this.streak++;
      this.lastFailure = entry;
    }
  }

  observe(entry: PageOracleEntry | undefined): PageHoldDecision {
    if (entry) this.record(entry);
    const confidence = entry?.status === 'ok'
      ? 'exact'
      : entry?.status === 'fail' && this.streak > 3
        ? 'fallback'
        : 'held';

    return {
      // An exact result is used by the caller before this recovery decision.
      // If those starts were rejected, older mapped starts are not a safer
      // substitute. Preserve the established cutoff: the current fourth+
      // failure falls back, while a later pending state can hold again.
      hold: confidence === 'held',
      confidence,
      failureStreak: this.streak,
      status: entry?.status ?? 'pending',
    };
  }
}

export interface OracleCoordinatorOptions {
  fontFallback: string[];
  onParagraphResults: () => void;
  onPageResults: () => void;
}

/** Owns oracle construction, teardown, cache clearing, and page confidence. */
export class OracleCoordinator {
  readonly paragraph: TypstOracle;
  readonly page: PageOracle;
  readonly pageConfidence = new PageHoldConfidence();

  private destroyed = false;

  constructor(options: OracleCoordinatorOptions) {
    this.paragraph = new TypstOracle(() => {
      if (!this.destroyed) options.onParagraphResults();
    }, options.fontFallback);
    this.page = new PageOracle((entry) => {
      if (!this.destroyed) {
        this.pageConfidence.record(entry);
        options.onPageResults();
      }
    });
  }

  /** Apply the mapped-page-start confidence policy to the current entry. */
  observePageEntry(entry: PageOracleEntry | undefined): PageHoldDecision {
    return this.pageConfidence.observe(entry);
  }

  /** Clear both result caches. Confidence intentionally persists, matching
   * the previous coordinator behavior; a successful page entry resets it. */
  clear() {
    this.paragraph.clear();
    this.page.clear();
  }

  clearParagraph() {
    this.paragraph.clear();
  }

  clearPage() {
    this.page.clear();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.paragraph.destroy();
    this.page.destroy();
  }
}
