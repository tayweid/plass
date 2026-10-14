// Session-level policy for the promoted suffix paginator: which passes the
// planner may attempt, whether an eligible result is installed or merely
// shadow-compared, which installs are sampled for verification, and the
// kill-switch that returns the session to full passes after the first
// verified mismatch. Pure state — no DOM, no ProseMirror — so the sampling
// counter and the kill-switch state machine are unit-testable in node.

export type SuffixPaginationMode =
  /** Promoted: an eligible suffix result is installed; a deterministic
   * sample of installs is re-verified against the reference pass at idle. */
  | 'live'
  /** The pre-promotion soak harness: the full pass is always run, installed,
   * and compared against the suffix result. Kept for future soaks. */
  | 'shadow'
  /** Suffix planning disabled outright (cost-comparison measurements). */
  | 'full';

export interface SuffixKillDetail {
  /** Seed source of the mismatching pass ('exact' | 'fallback'), or
   * 'injected' for a dev-hook trip. */
  readonly source: string;
  readonly summary: string;
}

/** Every Nth installed suffix result is re-verified. Counter-based and
 * deterministic: installs 1, 1+N, 1+2N, ... are sampled, so the first
 * install of a session (or of a reset stats window) is always verified. */
const VERIFY_SAMPLE_EVERY = 8;

export class SuffixPaginationControl {
  mode: SuffixPaginationMode = 'live';
  readonly verifyEvery: number;
  private killedState = false;
  private detail: SuffixKillDetail | null = null;
  private installCount = 0;

  constructor(verifyEvery: number = VERIFY_SAMPLE_EVERY) {
    if (!Number.isInteger(verifyEvery) || verifyEvery < 1) {
      throw new Error(`verifyEvery must be a positive integer, got ${verifyEvery}`);
    }
    this.verifyEvery = verifyEvery;
  }

  get killed(): boolean {
    return this.killedState;
  }

  get killDetail(): SuffixKillDetail | null {
    return this.detail;
  }

  get installs(): number {
    return this.installCount;
  }

  /** Why the planner must not even attempt a seed, or null when it may. */
  inactiveReason(): 'killed' | 'mode-full' | null {
    if (this.killedState) return 'killed';
    if (this.mode === 'full') return 'mode-full';
    return null;
  }

  /** Whether an eligible suffix result is INSTALLED (vs shadow-compared). */
  get installsSuffix(): boolean {
    return !this.killedState && this.mode === 'live';
  }

  /** Record one installed suffix result. True when this install falls on the
   * deterministic verification sample. */
  recordInstall(): boolean {
    this.installCount++;
    return (this.installCount - 1) % this.verifyEvery === 0;
  }

  /** First verified mismatch kills the suffix paginator for the session:
   * every later pass runs full. The first detail is retained (later calls
   * cannot overwrite the original evidence). */
  recordMismatch(detail: SuffixKillDetail): void {
    if (!this.killedState) this.detail = { ...detail };
    this.killedState = true;
  }

  /** Manual dev/test override: re-arm a killed session. */
  revive(): void {
    this.killedState = false;
    this.detail = null;
  }

  /** Restart the sampling counter (stats-reset hook) so a test window's
   * first install is verified. Kill state is deliberately NOT reset. */
  resetSampling(): void {
    this.installCount = 0;
  }
}
