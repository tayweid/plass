import assert from 'node:assert/strict';
import type { CompilerTask } from '../typst-worker-protocol';
import {
  CoordinatedCompiler,
  type CompilerTaskExecutor,
  type CompilerValue,
} from './coordinated-compiler';

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(value: T): void {
    this.resolvePromise(value);
  }

  reject(error: unknown): void {
    this.rejectPromise(error);
  }
}

interface StartedTask {
  task: CompilerTask;
  deferred: Deferred<CompilerValue>;
  signal: AbortSignal;
}

function harness(maxQueuedJobs = 8) {
  const started: StartedTask[] = [];
  const executor: CompilerTaskExecutor = (task, options) => {
    const deferred = new Deferred<CompilerValue>();
    started.push({ task, deferred, signal: options.signal });
    const abort = () => deferred.reject(new Error(`aborted: ${String(options.signal.reason)}`));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
    return deferred.promise.finally(() => options.signal.removeEventListener('abort', abort));
  };
  const goods: string[] = [];
  const errors: Array<{ key: string; lastGood: CompilerValue | undefined }> = [];
  const compiler = new CoordinatedCompiler(executor, {
    maxQueuedJobs,
    publishLastGood: (publication) => goods.push(publication.key),
    publishError: (publication) => errors.push({
      key: publication.key,
      lastGood: publication.lastGood?.value,
    }),
  });
  return { compiler, started, goods, errors };
}

const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

async function cancellationRejectsStaleIntegrationResults() {
  const h = harness();
  const running = h.compiler.run<string>(
    { kind: 'svg', source: 'old' },
    { key: 'preview:raw:1', revision: 1, priority: 'foreground', timeoutMs: 1000 },
  );
  const queued = h.compiler.run<string>(
    { kind: 'svg', source: 'new' },
    { key: 'preview:raw:1', revision: 2, priority: 'foreground', timeoutMs: 1000 },
  );

  assert.equal(h.compiler.cancel('preview:raw:1'), true);
  assert.equal(await queued, null);
  assert.equal(await running, null);
  assert.equal(h.started[0].signal.aborted, true);
  // Revision 2 already made revision 1 disposable before the explicit cancel
  // invalidated the queued successor.
  assert.equal(h.started[0].signal.reason, 'newer-request');
  assert.equal(h.compiler.getLastGood('preview:raw:1'), undefined);
  assert.deepEqual(h.goods, []);
  assert.equal(h.compiler.telemetry().canceled, 1);
  assert.equal(h.compiler.telemetry().staleCompletions, 1);
  assert.equal(h.compiler.telemetry().preempted, 1);
}

async function newerRevisionAbortsUnderlyingExecutor() {
  const h = harness();
  const obsolete = h.compiler.run<string>(
    { kind: 'svg', source: 'obsolete' },
    { key: 'preview:page', revision: 1, priority: 'layout', timeoutMs: 1000 },
  );
  const current = h.compiler.run<string>(
    { kind: 'svg', source: 'current' },
    { key: 'preview:page', revision: 2, priority: 'layout', timeoutMs: 1000 },
  );

  assert.equal(await obsolete, null);
  assert.equal(h.started[0].signal.aborted, true);
  assert.equal(h.started[0].signal.reason, 'newer-request');
  await tick();
  assert.equal(h.started[1].task.kind, 'svg');
  h.started[1].deferred.resolve('<svg>current</svg>');
  assert.equal(await current, '<svg>current</svg>');
  assert.equal(h.compiler.telemetry().preempted, 1);
  assert.deepEqual(h.goods, ['preview:page']);
}

async function currentErrorsRetainLastGoodPublication() {
  const h = harness();
  const first = h.compiler.run<string>(
    { kind: 'svg', source: 'good' },
    { key: 'preview:table:1', revision: 1, priority: 'layout', timeoutMs: 1000 },
  );
  h.started[0].deferred.resolve('<svg>good</svg>');
  assert.equal(await first, '<svg>good</svg>');

  const failed = h.compiler.run<string>(
    { kind: 'svg', source: 'bad' },
    { key: 'preview:table:1', revision: 2, priority: 'layout', timeoutMs: 1000 },
  );
  h.started[1].deferred.reject(new Error('bad Typst'));
  await assert.rejects(failed, /bad Typst/);
  assert.equal(h.compiler.getLastGood<string>('preview:table:1')?.value, '<svg>good</svg>');
  assert.deepEqual(h.goods, ['preview:table:1']);
  assert.deepEqual(h.errors, [{ key: 'preview:table:1', lastGood: '<svg>good</svg>' }]);
}

async function finalActionsArePrioritizedAndNeverCoalesced() {
  const h = harness();
  const blocker = h.compiler.run<string>(
    { kind: 'svg', source: 'blocker' },
    { key: 'preview:blocker', revision: 1, priority: 'background', timeoutMs: 1000 },
  );
  const foreground = h.compiler.run<string>(
    { kind: 'svg', source: 'foreground' },
    { key: 'preview:foreground', revision: 1, priority: 'foreground', timeoutMs: 1000 },
  );
  const proof = h.compiler.runFinal<string>(
    { kind: 'document-svg', source: 'same source', assets: [] },
    { timeoutMs: 1000 },
  );
  const exportPdf = h.compiler.runFinal<Uint8Array>(
    { kind: 'pdf', source: 'same source', assets: [] },
    { timeoutMs: 1000 },
  );

  assert.equal(h.started[0].signal.aborted, true);
  assert.equal(h.started[0].signal.reason, 'final-preemption');
  await tick();
  assert.equal(h.started[1].task.kind, 'document-svg');
  assert.equal(h.started[1].signal.aborted, false);
  h.started[1].deferred.resolve('<svg>proof</svg>');
  assert.equal(await proof, '<svg>proof</svg>');
  await tick();
  assert.equal(h.started[2].task.kind, 'pdf');
  assert.equal(h.started[2].signal.aborted, false);
  h.started[2].deferred.resolve(new Uint8Array([2]));
  assert.deepEqual([...await exportPdf], [2]);
  await tick();
  assert.equal(h.started[3].task.kind, 'svg');
  assert.equal(h.started[3].task.source, 'foreground');
  h.started[3].deferred.resolve('<svg>foreground</svg>');
  await foreground;
  await tick();
  assert.equal(h.started[4].task.kind, 'svg');
  assert.equal(h.started[4].task.source, 'blocker');
  h.started[4].deferred.resolve('<svg>blocker resumed</svg>');
  assert.equal(await blocker, '<svg>blocker resumed</svg>');
  await h.compiler.whenIdle();
  assert.equal(h.compiler.telemetry().succeeded, 4);
  assert.equal(h.compiler.telemetry().staleCompletions, 0);
  assert.equal(h.compiler.telemetry().preempted, 1);
}

const cases: Array<[string, () => Promise<void>]> = [
  ['cancellation rejects stale integration results', cancellationRejectsStaleIntegrationResults],
  ['newer revision aborts the underlying executor', newerRevisionAbortsUnderlyingExecutor],
  ['current errors retain last-good publication', currentErrorsRetainLastGoodPublication],
  ['final actions are prioritized and never coalesced', finalActionsArePrioritizedAndNeverCoalesced],
];

for (const [name, run] of cases) {
  await run();
  console.log(`  ok  ${name}`);
}

console.log('\nall coordinated compiler integration tests passed');
