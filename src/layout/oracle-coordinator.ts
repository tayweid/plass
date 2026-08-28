// Lifecycle and confidence policy for the one whole-document Typst layout
// publication. Break selection and scheduling stay with PageOracle/caller.

import {
  PageOracle,
  type PageOracleCompileResult,
  type PageOracleEntry,
} from './page-oracle';
import type { Node as PMNode } from 'prosemirror-model';
import type { CoordinatedCompileRequest } from '../compiler/coordinated-compiler';

export interface PageHoldDecision {
  /** Whether mapped page-start markers may be reused for this entry. */
  hold: boolean;
  /** Preferred source before the caller validates exact starts/held marks. */
  confidence: 'exact' | 'held' | 'continuous';
  status: 'ok' | 'fail' | 'pending';
}

/**
 * Confidence policy for mapped-through-edit page starts. A successful Typst
 * result establishes exact provenance. Missing/pending answers may hold that
 * proven basis through an edit; any failure or invalidation abandons it until
 * another exact result succeeds. This fail-closed latch prevents an old page
 * map from silently resurrecting after a later request starts.
 */
export class PageHoldConfidence {
  private hasExactBasis = false;
  private abandoned = false;

  /** Record a newly published result. This is separate from reads because a
   * successful exact layout normally returns before the recovery path calls
   * observe(), but it must still heal the failure streak. */
  record(entry: PageOracleEntry): void {
    if (entry?.status === 'ok') {
      this.hasExactBasis = true;
      this.abandoned = false;
    } else if (entry?.status === 'fail') {
      this.abandon();
    }
  }

  /** The current mapped basis is no longer safe. Only a new exact result may
   * reopen the hold path. */
  abandon(): void {
    this.hasExactBasis = false;
    this.abandoned = true;
  }

  observe(entry: PageOracleEntry | undefined): PageHoldDecision {
    if (entry) this.record(entry);
    const confidence = entry?.status === 'ok'
      ? 'exact'
      : !entry && this.hasExactBasis && !this.abandoned
        ? 'held'
        : 'continuous';

    return {
      hold: confidence === 'held',
      confidence,
      status: entry?.status ?? 'pending',
    };
  }
}

export interface OracleCoordinatorOptions {
  onPageResults: () => void;
  /** Product views inject their shared whole-document broker here. Omission
   * preserves PageOracle's direct compiler seam for focused unit tests. */
  compileDocument?: (
    doc: PMNode,
    coordinated?: CoordinatedCompileRequest,
    signal?: AbortSignal,
  ) => Promise<PageOracleCompileResult | null>;
}

/** Owns the sole production PageOracle, its lifecycle, and page confidence. */
export class OracleCoordinator {
  readonly page: PageOracle;
  readonly pageConfidence = new PageHoldConfidence();

  private destroyed = false;

  constructor(options: OracleCoordinatorOptions) {
    this.page = new PageOracle(
      (entry) => {
        if (!this.destroyed) {
          this.pageConfidence.record(entry);
          options.onPageResults();
        }
      },
      options.compileDocument,
    );
  }

  /** Apply the mapped-page-start confidence policy to the current entry. */
  observePageEntry(entry: PageOracleEntry | undefined): PageHoldDecision {
    return this.pageConfidence.observe(entry);
  }

  /** Clear the PageOracle result cache and invalidate mapped page geometry. */
  clear() {
    this.page.clear();
    this.pageConfidence.abandon();
  }

  clearPage() {
    this.page.clear();
    this.pageConfidence.abandon();
  }

  /** A document edit detaches stale PageOracle demand, but completed results
   * remain valuable for undo and cache reuse. The shared broker keeps a live
   * publication running when an embed/inline-preview consumer still needs it. */
  cancelPending() {
    this.page.cancelPending();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.page.destroy();
  }
}
