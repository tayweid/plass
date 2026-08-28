/**
 * Scheduling policy for consumers that share one preemptible compiler.
 *
 * The coordinator deliberately knows nothing about Typst or workers. Callers
 * provide a single-job executor; the coordinator contributes keyed
 * latest-wins coalescing, priority lanes, bounded admission, computational
 * preemption for disposable work, stale-publication guards, and observable
 * last-good/error state.
 */

/** `final` is reserved for explicit user actions whose result must be
 * delivered (PDF/source export). Preview callers use the other three lanes. */
export type CompilePriority = 'final' | 'foreground' | 'layout' | 'background';

const PRIORITY_RANK: Record<CompilePriority, number> = {
  final: 0,
  foreground: 1,
  layout: 2,
  background: 3,
};

export interface CompileRequest<Job> {
  /** Stable logical output, such as `page:document` or `table:<node-id>`. */
  key: string;
  /** Monotonic source revision within this key. Equal revisions may retry. */
  revision: number;
  priority?: CompilePriority;
  job: Job;
}

export interface CompileTaskContext {
  key: string;
  revision: number;
  priority: CompilePriority;
}

export interface CompileExecutionContext extends CompileTaskContext {
  /** Aborted when this disposable execution is no longer useful. Executors
   * should stop the underlying computation, not merely discard its result. */
  signal: AbortSignal;
}

export type CompileExecutor<Job, Result> = (
  job: Job,
  context: CompileExecutionContext,
) => Promise<Result>;

export interface CompileSuccess<Result> extends CompileTaskContext {
  value: Result;
  enqueuedAt: number;
  startedAt: number;
  completedAt: number;
  waitMs: number;
  runMs: number;
}

export interface CompileFailure<Result> extends CompileTaskContext {
  error: unknown;
  /** The prior successful publication is retained when a newer compile fails. */
  lastGood?: CompileSuccess<Result>;
  enqueuedAt: number;
  startedAt: number;
  completedAt: number;
  waitMs: number;
  runMs: number;
}

export type CompileSupersedeReason = 'newer-request' | 'priority-eviction';

export type CompileOutcome<Result> =
  | { status: 'published'; publication: CompileSuccess<Result> }
  | { status: 'error'; publication: CompileFailure<Result> }
  | {
      status: 'superseded';
      key: string;
      revision: number;
      reason: CompileSupersedeReason;
      by: { key: string; revision: number };
    }
  | { status: 'canceled'; key: string; revision: number }
  | { status: 'stale'; key: string; revision: number }
  | { status: 'rejected'; key: string; revision: number; reason: 'stale-revision' | 'capacity' };

export interface CompileTelemetry {
  /** Queued work only; the running job is reported separately. */
  queueDepth: number;
  queueDepthByPriority: Record<CompilePriority, number>;
  maxQueueDepth: number;
  running: boolean;
  runningKey: string | null;
  submitted: number;
  accepted: number;
  started: number;
  succeeded: number;
  failed: number;
  superseded: number;
  canceled: number;
  evicted: number;
  rejected: number;
  staleSubmissions: number;
  staleCompletions: number;
  /** Running disposable executions asked to stop before completion. */
  preempted: number;
  waitSamples: number;
  totalWaitMs: number;
  lastWaitMs: number;
  maxWaitMs: number;
  averageWaitMs: number;
  hookErrors: number;
}

export interface CompileCoordinatorHooks<Result> {
  /** Publish a successful current revision and replace this key's last-good value. */
  publishLastGood?: (publication: CompileSuccess<Result>) => void;
  /** Publish a current-revision error while retaining `publication.lastGood`. */
  publishError?: (publication: CompileFailure<Result>) => void;
  onTelemetry?: (telemetry: Readonly<CompileTelemetry>) => void;
}

export interface CompileCoordinatorOptions<Result> extends CompileCoordinatorHooks<Result> {
  /** Normal queued-job bound. One protected final-action reserve may be used
   * above this bound so admitting an export never destroys the sole current
   * successor to obsolete running preview work. One additional job may be
   * executing. */
  maxQueuedJobs?: number;
  /** Injectable monotonic clock for deterministic tests and host telemetry. */
  now?: () => number;
}

interface Pending<Job, Result> extends CompileTaskContext {
  job: Job;
  sequence: number;
  enqueuedAt: number;
  abortController: AbortController | null;
  resolve: (outcome: CompileOutcome<Result>) => void;
}

interface LatestKeyState {
  revision: number;
  sequence: number;
}

interface MutableTelemetry {
  maxQueueDepth: number;
  submitted: number;
  accepted: number;
  started: number;
  succeeded: number;
  failed: number;
  superseded: number;
  canceled: number;
  evicted: number;
  rejected: number;
  staleSubmissions: number;
  staleCompletions: number;
  preempted: number;
  waitSamples: number;
  totalWaitMs: number;
  lastWaitMs: number;
  maxWaitMs: number;
  hookErrors: number;
}

const emptyTelemetry = (): MutableTelemetry => ({
  maxQueueDepth: 0,
  submitted: 0,
  accepted: 0,
  started: 0,
  succeeded: 0,
  failed: 0,
  superseded: 0,
  canceled: 0,
  evicted: 0,
  rejected: 0,
  staleSubmissions: 0,
  staleCompletions: 0,
  preempted: 0,
  waitSamples: 0,
  totalWaitMs: 0,
  lastWaitMs: 0,
  maxWaitMs: 0,
  hookErrors: 0,
});

/**
 * Coordinates access to one executor. Jobs are FIFO within a priority lane;
 * final precedes foreground, layout, and background. Only the latest queued
 * submission for a key survives. Running preview work is aborted when a newer
 * same-key submission, cancellation, or explicit final action makes it
 * disposable. Final work is never preempted. Every completion is still checked
 * against its sequence and revision, so an executor that ignores abort cannot
 * publish stale output.
 */
export class CompileCoordinator<Job, Result> {
  private readonly maxQueuedJobs: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending<Job, Result>>();
  private readonly newestRevision = new Map<string, number>();
  private readonly latest = new Map<string, LatestKeyState>();
  private readonly lastGood = new Map<string, CompileSuccess<Result>>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly counters = emptyTelemetry();
  private running: Pending<Job, Result> | null = null;
  private nextSequence = 1;

  constructor(
    private readonly executor: CompileExecutor<Job, Result>,
    private readonly options: CompileCoordinatorOptions<Result> = {},
  ) {
    const maxQueuedJobs = options.maxQueuedJobs ?? 64;
    if (!Number.isSafeInteger(maxQueuedJobs) || maxQueuedJobs < 1) {
      throw new RangeError('CompileCoordinator maxQueuedJobs must be a positive safe integer');
    }
    this.maxQueuedJobs = maxQueuedJobs;
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * Submit work without exposing rejection-prone background promises. Invalid
   * request shapes throw synchronously; scheduling outcomes resolve normally.
   */
  submit(request: CompileRequest<Job>): Promise<CompileOutcome<Result>> {
    this.validateRequest(request);
    this.counters.submitted++;
    const priority = request.priority ?? 'background';
    const newestRevision = this.newestRevision.get(request.key);
    if (newestRevision !== undefined && request.revision < newestRevision) {
      this.counters.rejected++;
      this.counters.staleSubmissions++;
      const outcome: CompileOutcome<Result> = {
        status: 'rejected',
        key: request.key,
        revision: request.revision,
        reason: 'stale-revision',
      };
      this.emitTelemetry();
      return Promise.resolve(outcome);
    }
    // Final keys represent individually owned user actions. The application
    // gives them unique keys, but guard the generic scheduler as well: no
    // same-key preview/retry may supersede a running or queued final action or
    // advance its revision watermark while it is protected.
    const protectedFinal =
      (this.running?.key === request.key && this.running.priority === 'final') ||
      this.pending.get(request.key)?.priority === 'final';
    if (protectedFinal) {
      this.counters.rejected++;
      const outcome: CompileOutcome<Result> = {
        status: 'rejected',
        key: request.key,
        revision: request.revision,
        reason: 'capacity',
      };
      this.emitTelemetry();
      return Promise.resolve(outcome);
    }
    // The revision watermark records observed source state, not just admitted
    // work. If a newer request is rejected for capacity, an older request must
    // not later sneak through and publish regressed output.
    this.newestRevision.set(request.key, request.revision);

    return new Promise<CompileOutcome<Result>>((resolve) => {
      const sequence = this.nextSequence++;
      const entry: Pending<Job, Result> = {
        key: request.key,
        revision: request.revision,
        priority,
        job: request.job,
        sequence,
        enqueuedAt: this.now(),
        abortController: null,
        resolve,
      };

      const sameKey = this.pending.get(request.key);
      if (sameKey) {
        this.pending.delete(request.key);
        this.resolveSuperseded(sameKey, entry, 'newer-request');
      } else if (this.pending.size >= this.maxQueuedJobs) {
        const protectRunningSuccessor = this.running?.key;
        const forceLatestForRunningKey = this.running?.key === entry.key;
        const victim = this.evictionCandidate(entry.priority, protectRunningSuccessor, forceLatestForRunningKey);
        // If every disposable victim is the protected current successor to
        // stale running work, a final action borrows one explicitly bounded
        // reserve slot. This is the minimum state needed to keep the final,
        // the successor, and the still-settling executor promise at once.
        const canUseFinalReserve =
          entry.priority === 'final' && this.pending.size === this.maxQueuedJobs;
        if (!victim && !canUseFinalReserve) {
          this.counters.rejected++;
          resolve({
            status: 'rejected',
            key: entry.key,
            revision: entry.revision,
            reason: 'capacity',
          });
          this.emitTelemetry();
          return;
        }
        if (victim) {
          this.pending.delete(victim.key);
          this.counters.evicted++;
          this.resolveSuperseded(victim, entry, 'priority-eviction');
        }
      }

      this.latest.set(entry.key, { revision: entry.revision, sequence: entry.sequence });
      this.pending.set(entry.key, entry);
      this.counters.accepted++;
      this.counters.maxQueueDepth = Math.max(this.counters.maxQueueDepth, this.pending.size);
      this.preemptRunningFor(entry);
      this.emitTelemetry();
      this.pump();
    });
  }

  /** Last successful current-revision publication for a key. */
  getLastGood(key: string): CompileSuccess<Result> | undefined {
    return this.lastGood.get(key);
  }

  /** Invalidate queued/running work for one logical output. Queued work
   * resolves immediately as canceled; running disposable work is aborted and
   * its completion remains stale even if its executor ignores the signal. */
  cancel(key: string): boolean {
    const queued = this.pending.get(key);
    const running = this.running?.key === key ? this.running : null;
    if (!queued && !running) return false;

    if (queued) {
      this.pending.delete(key);
      queued.resolve({ status: 'canceled', key, revision: queued.revision });
    }
    const revision = Math.max(
      this.newestRevision.get(key) ?? 0,
      queued?.revision ?? 0,
      running?.revision ?? 0,
    );
    this.latest.set(key, { revision, sequence: this.nextSequence++ });
    this.counters.canceled++;
    if (running) this.preemptRunning('canceled');
    this.emitTelemetry();
    this.pump();
    this.resolveIdleIfNeeded();
    return true;
  }

  /** Cancel active work and forget all revision/last-good state for a key.
   * Use when a view or bounded cache entry is permanently retired. */
  release(key: string): boolean {
    const existed =
      this.pending.has(key) ||
      this.running?.key === key ||
      this.newestRevision.has(key) ||
      this.latest.has(key) ||
      this.lastGood.has(key);
    this.cancel(key);
    this.newestRevision.delete(key);
    this.latest.delete(key);
    this.lastGood.delete(key);
    return existed;
  }

  /** Current immutable telemetry snapshot. */
  telemetry(): Readonly<CompileTelemetry> {
    const queueDepthByPriority: Record<CompilePriority, number> = {
      final: 0,
      foreground: 0,
      layout: 0,
      background: 0,
    };
    for (const entry of this.pending.values()) queueDepthByPriority[entry.priority]++;
    return Object.freeze({
      queueDepth: this.pending.size,
      queueDepthByPriority,
      maxQueueDepth: this.counters.maxQueueDepth,
      running: this.running !== null,
      runningKey: this.running?.key ?? null,
      submitted: this.counters.submitted,
      accepted: this.counters.accepted,
      started: this.counters.started,
      succeeded: this.counters.succeeded,
      failed: this.counters.failed,
      superseded: this.counters.superseded,
      canceled: this.counters.canceled,
      evicted: this.counters.evicted,
      rejected: this.counters.rejected,
      staleSubmissions: this.counters.staleSubmissions,
      staleCompletions: this.counters.staleCompletions,
      preempted: this.counters.preempted,
      waitSamples: this.counters.waitSamples,
      totalWaitMs: this.counters.totalWaitMs,
      lastWaitMs: this.counters.lastWaitMs,
      maxWaitMs: this.counters.maxWaitMs,
      averageWaitMs:
        this.counters.waitSamples === 0 ? 0 : this.counters.totalWaitMs / this.counters.waitSamples,
      hookErrors: this.counters.hookErrors,
    });
  }

  /** Resolve when both the executor and queue are empty. */
  whenIdle(): Promise<void> {
    if (!this.running && this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private validateRequest(request: CompileRequest<Job>): void {
    if (!request.key) throw new TypeError('CompileCoordinator request key must not be empty');
    if (!Number.isSafeInteger(request.revision) || request.revision < 0) {
      throw new RangeError('CompileCoordinator revision must be a non-negative safe integer');
    }
    if (request.priority !== undefined && !Object.hasOwn(PRIORITY_RANK, request.priority)) {
      throw new TypeError(`Unknown compile priority: ${String(request.priority)}`);
    }
  }

  private evictionCandidate(
    incoming: CompilePriority,
    protectedKey: string | undefined,
    force: boolean,
  ): Pending<Job, Result> | null {
    let candidate: Pending<Job, Result> | null = null;
    const incomingRank = PRIORITY_RANK[incoming];
    for (const entry of this.pending.values()) {
      // Never discard the only queued successor to already-stale running work.
      // Final work uses the one bounded reserve when this is the only victim;
      // otherwise the running completion can no longer lead to current output.
      if (entry.key === protectedKey) continue;
      // A preview retry can never displace an explicit user action, even when
      // it is the latest successor to currently running preview work.
      if (entry.priority === 'final' && incoming !== 'final') continue;
      if (!force && PRIORITY_RANK[entry.priority] <= incomingRank) continue;
      if (
        !candidate ||
        PRIORITY_RANK[entry.priority] > PRIORITY_RANK[candidate.priority] ||
        (entry.priority === candidate.priority && entry.sequence > candidate.sequence)
      ) {
        candidate = entry;
      }
    }
    return candidate;
  }

  private resolveSuperseded(
    previous: Pending<Job, Result>,
    replacement: Pick<Pending<Job, Result>, 'key' | 'revision'>,
    reason: CompileSupersedeReason,
  ): void {
    this.counters.superseded++;
    previous.resolve({
      status: 'superseded',
      key: previous.key,
      revision: previous.revision,
      reason,
      by: { key: replacement.key, revision: replacement.revision },
    });
  }

  private pump(): void {
    if (this.running || this.pending.size === 0) return;
    let next: Pending<Job, Result> | null = null;
    for (const entry of this.pending.values()) {
      if (
        !next ||
        PRIORITY_RANK[entry.priority] < PRIORITY_RANK[next.priority] ||
        (entry.priority === next.priority && entry.sequence < next.sequence)
      ) {
        next = entry;
      }
    }
    if (!next) return;
    this.pending.delete(next.key);
    this.running = next;
    next.abortController = new AbortController();
    const startedAt = this.now();
    const waitMs = Math.max(0, startedAt - next.enqueuedAt);
    this.counters.started++;
    this.counters.waitSamples++;
    this.counters.totalWaitMs += waitMs;
    this.counters.lastWaitMs = waitMs;
    this.counters.maxWaitMs = Math.max(this.counters.maxWaitMs, waitMs);
    this.emitTelemetry();
    void this.execute(next, startedAt, waitMs);
  }

  private async execute(entry: Pending<Job, Result>, startedAt: number, waitMs: number): Promise<void> {
    let value: Result | undefined;
    let failure: unknown;
    let failed = false;
    try {
      value = await this.executor(entry.job, {
        key: entry.key,
        revision: entry.revision,
        priority: entry.priority,
        signal: entry.abortController!.signal,
      });
    } catch (error) {
      failed = true;
      failure = error;
    }

    const completedAt = this.now();
    const latest = this.latest.get(entry.key);
    const isCurrent = Boolean(
      latest &&
      latest.sequence === entry.sequence &&
      this.newestRevision.get(entry.key) === entry.revision
    );
    const interruptedForFinal = Boolean(
      failed &&
      isCurrent &&
      entry.priority !== 'final' &&
      entry.abortController?.signal.aborted &&
      entry.abortController.signal.reason === 'final-preemption'
    );
    if (interruptedForFinal) {
      // An export/proof action borrows the worker; it does not invalidate the
      // preview it interrupted. Put that exact logical request back behind the
      // final lane so consumers never cache an expected abort as a failure.
      entry.abortController = null;
      entry.enqueuedAt = completedAt;
      this.pending.set(entry.key, entry);
      this.counters.maxQueueDepth = Math.max(this.counters.maxQueueDepth, this.pending.size);
      this.running = null;
      this.pump();
      this.resolveIdleIfNeeded();
      return;
    }
    if (
      !latest ||
      latest.sequence !== entry.sequence ||
      this.newestRevision.get(entry.key) !== entry.revision
    ) {
      this.counters.staleCompletions++;
      entry.resolve({ status: 'stale', key: entry.key, revision: entry.revision });
    } else if (failed) {
      const publication: CompileFailure<Result> = {
        key: entry.key,
        revision: entry.revision,
        priority: entry.priority,
        error: failure,
        lastGood: this.lastGood.get(entry.key),
        enqueuedAt: entry.enqueuedAt,
        startedAt,
        completedAt,
        waitMs,
        runMs: Math.max(0, completedAt - startedAt),
      };
      this.counters.failed++;
      this.invokeHook(this.options.publishError, publication);
      entry.resolve({ status: 'error', publication });
    } else {
      const publication: CompileSuccess<Result> = {
        key: entry.key,
        revision: entry.revision,
        priority: entry.priority,
        value: value as Result,
        enqueuedAt: entry.enqueuedAt,
        startedAt,
        completedAt,
        waitMs,
        runMs: Math.max(0, completedAt - startedAt),
      };
      this.lastGood.set(entry.key, publication);
      this.counters.succeeded++;
      this.invokeHook(this.options.publishLastGood, publication);
      entry.resolve({ status: 'published', publication });
    }

    this.running = null;
    this.emitTelemetry();
    this.pump();
    this.resolveIdleIfNeeded();
  }

  /** Abort only work whose result is disposable. A final task is a user-owned
   * action and remains protected from preview churn and later final actions. */
  private preemptRunningFor(incoming: Pending<Job, Result>): void {
    const running = this.running;
    if (!running || running.priority === 'final') return;
    if (running.key === incoming.key) {
      this.preemptRunning('newer-request');
      return;
    }
    if (incoming.priority === 'final') this.preemptRunning('final-preemption');
  }

  private preemptRunning(reason: 'newer-request' | 'canceled' | 'final-preemption'): void {
    const running = this.running;
    const controller = running?.abortController;
    if (!running || running.priority === 'final' || !controller || controller.signal.aborted) return;
    // Same-key replacement and explicit cancellation normally install their
    // own invalidating sequence first. Keep this guard as a fail-closed stale
    // publication barrier, but leave final-preempted work current so execute()
    // can requeue it after the final lane has borrowed the executor.
    if (
      reason !== 'final-preemption' &&
      this.latest.get(running.key)?.sequence === running.sequence
    ) {
      this.latest.set(running.key, {
        revision: running.revision,
        sequence: this.nextSequence++,
      });
    }
    this.counters.preempted++;
    controller.abort(reason);
  }

  private invokeHook<T>(hook: ((value: T) => void) | undefined, value: T): void {
    if (!hook) return;
    try {
      hook(value);
    } catch {
      // Publication hooks are observers. A faulty observer must not stall the
      // single executor or reinterpret a successful compile as a failure.
      this.counters.hookErrors++;
    }
  }

  private emitTelemetry(): void {
    // Avoid allocating/freeze-walking snapshots on every scheduler transition
    // in production. The application installs this hook only in development.
    const hook = this.options.onTelemetry;
    if (hook) this.invokeHook(hook, this.telemetry());
  }

  private resolveIdleIfNeeded(): void {
    if (this.running || this.pending.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
