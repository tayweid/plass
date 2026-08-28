// Application-level admission policy for the single Typst compiler worker.
// The worker remains responsible for isolation, deadlines, and VFS safety;
// this layer prevents obsolete preview/layout requests from reaching its FIFO
// and reserves the highest lane for explicit final-output actions.

import type { CompilerTask } from '../typst-worker-protocol';
import type { TypstDocumentSvgPublication } from '../typst-document-publication';
import {
  CompileCoordinator,
  type CompileCoordinatorOptions,
  type CompilePriority,
  type CompileSuccess,
  type CompileTelemetry,
} from './compile-coordinator';

export type CompilerValue = string | Uint8Array | unknown[] | TypstDocumentSvgPublication | null;
export type PreviewCompilePriority = Exclude<CompilePriority, 'final'>;

interface CompilerJob {
  task: CompilerTask;
  timeoutMs: number;
  onMessage?: (message: string) => void;
}

export interface CoordinatedCompileRequest {
  /** Stable logical consumer key, not a source hash. */
  key: string;
  /** Monotonically increasing within `key`; equal values are retries. */
  revision: number;
  priority: PreviewCompilePriority;
}

export interface CompilerExecutionOptions {
  timeoutMs: number;
  onMessage?: (message: string) => void;
}

export interface CompilerExecutorOptions extends CompilerExecutionOptions {
  /** Coordinator-owned cancellation. Public callers cannot abort protected
   * final work; only the scheduling policy decides when work is disposable. */
  signal: AbortSignal;
}

export type CompilerTaskExecutor = (
  task: CompilerTask,
  options: CompilerExecutorOptions,
) => Promise<CompilerValue>;

/** Testable application adapter around the generic coordinator. */
export class CoordinatedCompiler {
  private readonly coordinator: CompileCoordinator<CompilerJob, CompilerValue>;
  private nextFinalId = 1;

  constructor(
    executor: CompilerTaskExecutor,
    options: CompileCoordinatorOptions<CompilerValue> = {},
  ) {
    this.coordinator = new CompileCoordinator<CompilerJob, CompilerValue>(
      (job, context) => executor(job.task, {
        timeoutMs: job.timeoutMs,
        onMessage: job.onMessage,
        signal: context.signal,
      }),
      options,
    );
  }

  /** Current preview/layout work returns null when it was intentionally
   * coalesced, canceled, evicted, or rejected. Current compiler errors remain
   * errors so the caller can retain last-good UI without caching a failure as
   * a successful answer. */
  async run<T extends CompilerValue>(
    task: CompilerTask,
    options: CoordinatedCompileRequest & CompilerExecutionOptions,
  ): Promise<T | null> {
    const outcome = await this.coordinator.submit({
      key: options.key,
      revision: options.revision,
      priority: options.priority,
      job: { task, timeoutMs: options.timeoutMs, onMessage: options.onMessage },
    });
    if (outcome.status === 'published') return outcome.publication.value as T;
    if (outcome.status === 'error') throw outcome.publication.error;
    return null;
  }

  /** Run an explicit final-output action. Every action receives a unique key,
   * so repeated clicks queue independently rather than superseding each other;
   * the reserved lane evicts disposable preview work and cannot be overtaken. */
  async runFinal<T extends CompilerValue>(
    task: CompilerTask,
    options: CompilerExecutionOptions,
  ): Promise<T> {
    const key = `final:${task.kind}:${this.nextFinalId++}`;
    try {
      const outcome = await this.coordinator.submit({
        key,
        revision: 1,
        priority: 'final',
        job: { task, timeoutMs: options.timeoutMs, onMessage: options.onMessage },
      });
      if (outcome.status === 'published') return outcome.publication.value as T;
      if (outcome.status === 'error') throw outcome.publication.error;
      throw new Error(`Final compiler task was not admitted (${outcome.status})`);
    } finally {
      // Final results are delivered directly; retaining a unique per-click key
      // and last-good value would only grow coordinator state.
      this.coordinator.release(key);
    }
  }

  cancel(key: string): boolean {
    return this.coordinator.cancel(key);
  }

  release(key: string): boolean {
    return this.coordinator.release(key);
  }

  getLastGood<T extends CompilerValue>(key: string): CompileSuccess<T> | undefined {
    return this.coordinator.getLastGood(key) as CompileSuccess<T> | undefined;
  }

  telemetry(): Readonly<CompileTelemetry> {
    return this.coordinator.telemetry();
  }

  whenIdle(): Promise<void> {
    return this.coordinator.whenIdle();
  }
}

const applicationCompiler = new CoordinatedCompiler(
  async (task, options) => {
    // Keep the worker and its large WASM dependency behind the existing lazy
    // preview/export boundary. Importing this policy in a node-view module or
    // unit test does not itself pull in or instantiate the worker.
    const { runCompilerTask } = await import('../typst-worker-client');
    return runCompilerTask<CompilerValue>(task, options);
  },
  { maxQueuedJobs: 32 },
);

export function runCoordinatedCompilerTask<T extends CompilerValue>(
  task: CompilerTask,
  options: CoordinatedCompileRequest & CompilerExecutionOptions,
): Promise<T | null> {
  return applicationCompiler.run<T>(task, options);
}

export function runFinalCompilerTask<T extends CompilerValue>(
  task: CompilerTask,
  options: CompilerExecutionOptions,
): Promise<T> {
  return applicationCompiler.runFinal<T>(task, options);
}

export function cancelCoordinatedCompilerTask(key: string): boolean {
  return applicationCompiler.cancel(key);
}

export function releaseCoordinatedCompilerKey(key: string): boolean {
  return applicationCompiler.release(key);
}

export function compilerCoordinatorTelemetry(): Readonly<CompileTelemetry> {
  return applicationCompiler.telemetry();
}

// Development-only pull telemetry: no hooks, interval, snapshot allocation,
// or console traffic is installed in production. Call this from DevTools after
// reproducing lag to inspect depth, lane mix, wait, eviction, and stale counts.
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __compileCoordinatorStats: () => Readonly<CompileTelemetry> })
    .__compileCoordinatorStats = compilerCoordinatorTelemetry;
}
