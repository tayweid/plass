import assert from 'node:assert/strict';
import {
  CompileCoordinator,
  type CompileExecutionContext,
  type CompileFailure,
  type CompileSuccess,
} from './compile-coordinator';

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

interface TestJob {
  name: string;
  deferred: Deferred<string>;
  abortable?: boolean;
  attempts?: number;
  retryDeferreds?: Array<Deferred<string>>;
}

function harness(maxQueuedJobs = 8) {
  let clock = 0;
  const starts: Array<{ name: string; context: CompileExecutionContext }> = [];
  const goods: CompileSuccess<string>[] = [];
  const errors: CompileFailure<string>[] = [];
  const telemetry: number[] = [];
  const coordinator = new CompileCoordinator<TestJob, string>(
    (job, context) => {
      starts.push({ name: job.name, context });
      const attempt = job.attempts ?? 0;
      job.attempts = attempt + 1;
      const deferred = attempt === 0
        ? job.deferred
        : (() => {
            const retry = new Deferred<string>();
            (job.retryDeferreds ??= []).push(retry);
            return retry;
          })();
      if (!job.abortable) return deferred.promise;
      const abort = () => deferred.reject(new Error(`aborted: ${String(context.signal.reason)}`));
      if (context.signal.aborted) abort();
      else context.signal.addEventListener('abort', abort, { once: true });
      return deferred.promise.finally(() => context.signal.removeEventListener('abort', abort));
    },
    {
      maxQueuedJobs,
      now: () => clock,
      publishLastGood: (publication) => goods.push(publication),
      publishError: (publication) => errors.push(publication),
      onTelemetry: (snapshot) => telemetry.push(snapshot.queueDepth),
    },
  );
  return {
    coordinator,
    starts,
    goods,
    errors,
    telemetry,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const job = (name: string): TestJob => ({ name, deferred: new Deferred<string>() });
const abortableJob = (name: string): TestJob => ({
  name,
  deferred: new Deferred<string>(),
  abortable: true,
});
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

async function latestQueuedRequestWins() {
  const h = harness();
  const blocker = job('blocker');
  const old = job('old-preview');
  const current = job('current-preview');
  const blockerOutcome = h.coordinator.submit({ key: 'blocker', revision: 1, priority: 'foreground', job: blocker });
  const oldOutcome = h.coordinator.submit({ key: 'preview:a', revision: 1, job: old });
  const currentOutcome = h.coordinator.submit({ key: 'preview:a', revision: 2, job: current });

  assert.deepEqual(await oldOutcome, {
    status: 'superseded',
    key: 'preview:a',
    revision: 1,
    reason: 'newer-request',
    by: { key: 'preview:a', revision: 2 },
  });
  assert.deepEqual(h.starts.map((entry) => entry.name), ['blocker']);
  blocker.deferred.resolve('blocked-result');
  assert.equal((await blockerOutcome).status, 'published');
  await tick();
  assert.deepEqual(h.starts.map((entry) => entry.name), ['blocker', 'current-preview']);
  current.deferred.resolve('fresh');
  const outcome = await currentOutcome;
  assert.equal(outcome.status, 'published');
  assert.equal(h.goods.at(-1)?.value, 'fresh');
  await h.coordinator.whenIdle();
}

async function priorityLanesAreStrictAndFifo() {
  const h = harness();
  const blocker = job('blocker');
  const backgroundA = job('background-a');
  const backgroundB = job('background-b');
  const layout = job('layout');
  const foreground = job('foreground');
  void h.coordinator.submit({ key: 'blocker', revision: 1, priority: 'foreground', job: blocker });
  const outcomes = [
    h.coordinator.submit({ key: 'ba', revision: 1, priority: 'background', job: backgroundA }),
    h.coordinator.submit({ key: 'bb', revision: 1, priority: 'background', job: backgroundB }),
    h.coordinator.submit({ key: 'layout', revision: 1, priority: 'layout', job: layout }),
    h.coordinator.submit({ key: 'foreground', revision: 1, priority: 'foreground', job: foreground }),
  ];
  blocker.deferred.resolve('done');
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'foreground');
  foreground.deferred.resolve('done');
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'layout');
  layout.deferred.resolve('done');
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'background-a');
  backgroundA.deferred.resolve('done');
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'background-b');
  backgroundB.deferred.resolve('done');
  assert.deepEqual((await Promise.all(outcomes)).map((outcome) => outcome.status), [
    'published',
    'published',
    'published',
    'published',
  ]);
}

async function finalWorkPreservesAProtectedPreviewSuccessor() {
  const h = harness(1);
  const running = job('running-preview');
  const successor = job('preview-successor');
  const final = job('final-export');
  const excessFinal = job('excess-final');
  const runningOutcome = h.coordinator.submit({ key: 'preview', revision: 1, priority: 'layout', job: running });
  const successorOutcome = h.coordinator.submit({ key: 'preview', revision: 2, priority: 'foreground', job: successor });
  const finalOutcome = h.coordinator.submit({ key: 'export:1', revision: 1, priority: 'final', job: final });

  // One bounded final reserve makes the otherwise impossible state explicit:
  // the settling executor, its only current successor, and the user action.
  assert.equal(h.coordinator.telemetry().queueDepth, 2);
  assert.equal(h.coordinator.telemetry().maxQueueDepth, 2);
  assert.deepEqual(
    await h.coordinator.submit({ key: 'export:2', revision: 1, priority: 'final', job: excessFinal }),
    { status: 'rejected', key: 'export:2', revision: 1, reason: 'capacity' },
  );
  running.deferred.resolve('obsolete-preview');
  assert.deepEqual(await runningOutcome, { status: 'stale', key: 'preview', revision: 1 });
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'final-export');
  final.deferred.resolve('pdf');
  assert.equal((await finalOutcome).status, 'published');
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'preview-successor');
  successor.deferred.resolve('current-preview');
  assert.equal((await successorOutcome).status, 'published');
  assert.equal(h.coordinator.getLastGood('preview')?.value, 'current-preview');
}

async function pendingWorkIsBoundedWithPriorityAdmission() {
  const h = harness(2);
  const blocker = job('blocker');
  const backgroundA = job('background-a');
  const backgroundB = job('background-b');
  const layout = job('layout');
  const rejected = job('rejected-background');
  void h.coordinator.submit({ key: 'blocker', revision: 1, priority: 'foreground', job: blocker });
  const backgroundAOutcome = h.coordinator.submit({ key: 'ba', revision: 1, priority: 'background', job: backgroundA });
  const backgroundBOutcome = h.coordinator.submit({ key: 'bb', revision: 1, priority: 'background', job: backgroundB });
  const layoutOutcome = h.coordinator.submit({ key: 'layout', revision: 1, priority: 'layout', job: layout });
  assert.deepEqual(await backgroundBOutcome, {
    status: 'superseded',
    key: 'bb',
    revision: 1,
    reason: 'priority-eviction',
    by: { key: 'layout', revision: 1 },
  });
  const rejectedOutcome = await h.coordinator.submit({
    key: 'bc',
    revision: 1,
    priority: 'background',
    job: rejected,
  });
  assert.deepEqual(rejectedOutcome, {
    status: 'rejected',
    key: 'bc',
    revision: 1,
    reason: 'capacity',
  });
  assert.equal(h.coordinator.telemetry().queueDepth, 2);
  assert.equal(h.coordinator.telemetry().maxQueueDepth, 2);
  assert.equal(h.coordinator.telemetry().evicted, 1);
  assert.equal(h.coordinator.telemetry().rejected, 1);

  blocker.deferred.resolve('done');
  await tick();
  layout.deferred.resolve('done');
  await tick();
  backgroundA.deferred.resolve('done');
  assert.equal((await layoutOutcome).status, 'published');
  assert.equal((await backgroundAOutcome).status, 'published');
}

async function staleRevisionsCannotPublish() {
  const h = harness();
  const first = job('first');
  const second = job('second');
  const tooOld = job('too-old');
  const firstOutcome = h.coordinator.submit({ key: 'page', revision: 10, priority: 'layout', job: first });
  const secondOutcome = h.coordinator.submit({ key: 'page', revision: 11, priority: 'layout', job: second });
  const rejected = await h.coordinator.submit({ key: 'page', revision: 9, priority: 'foreground', job: tooOld });
  assert.deepEqual(rejected, { status: 'rejected', key: 'page', revision: 9, reason: 'stale-revision' });

  first.deferred.resolve('obsolete');
  assert.deepEqual(await firstOutcome, { status: 'stale', key: 'page', revision: 10 });
  assert.equal(h.goods.length, 0);
  await tick();
  second.deferred.resolve('current');
  assert.equal((await secondOutcome).status, 'published');
  assert.deepEqual(h.goods.map((publication) => publication.value), ['current']);
  assert.equal(h.coordinator.telemetry().staleSubmissions, 1);
  assert.equal(h.coordinator.telemetry().staleCompletions, 1);
}

async function capacityRejectionStillAdvancesTheRevisionWatermark() {
  const h = harness(1);
  const blocker = job('blocker');
  const queued = job('queued');
  const rejectedNewer = job('rejected-newer');
  const regressed = job('regressed');
  const blockerOutcome = h.coordinator.submit({ key: 'blocker', revision: 1, job: blocker });
  const queuedOutcome = h.coordinator.submit({ key: 'queued', revision: 1, priority: 'foreground', job: queued });

  assert.deepEqual(
    await h.coordinator.submit({ key: 'page', revision: 11, job: rejectedNewer }),
    { status: 'rejected', key: 'page', revision: 11, reason: 'capacity' },
  );
  assert.deepEqual(
    await h.coordinator.submit({ key: 'page', revision: 10, job: regressed }),
    { status: 'rejected', key: 'page', revision: 10, reason: 'stale-revision' },
  );

  blocker.deferred.resolve('done');
  await blockerOutcome;
  await tick();
  queued.deferred.resolve('done');
  await queuedOutcome;
  assert.equal(h.coordinator.telemetry().staleSubmissions, 1);
}

async function failuresRetainLastGoodAndStaleErrorsStaySilent() {
  const h = harness();
  const good = job('good');
  const failing = job('failing');
  const staleFailing = job('stale-failing');
  const superseding = job('superseding');
  const goodOutcome = h.coordinator.submit({ key: 'table', revision: 1, job: good });
  good.deferred.resolve('last-good');
  assert.equal((await goodOutcome).status, 'published');

  const failingOutcome = h.coordinator.submit({ key: 'table', revision: 2, job: failing });
  failing.deferred.reject(new Error('bad source'));
  const failed = await failingOutcome;
  assert.equal(failed.status, 'error');
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].lastGood?.value, 'last-good');
  assert.equal(h.coordinator.getLastGood('table')?.value, 'last-good');

  const staleFailureOutcome = h.coordinator.submit({ key: 'table', revision: 3, job: staleFailing });
  const currentOutcome = h.coordinator.submit({ key: 'table', revision: 4, job: superseding });
  staleFailing.deferred.reject(new Error('superseded bad source'));
  assert.deepEqual(await staleFailureOutcome, { status: 'stale', key: 'table', revision: 3 });
  await tick();
  superseding.deferred.resolve('new-good');
  assert.equal((await currentOutcome).status, 'published');
  assert.equal(h.errors.length, 1);
  assert.equal(h.coordinator.getLastGood('table')?.value, 'new-good');
}

async function cancellationInvalidatesQueuedAndRunningWork() {
  const h = harness();
  const running = job('running');
  const queued = job('queued');
  const retry = job('retry');
  const runningOutcome = h.coordinator.submit({ key: 'raw', revision: 1, job: running });
  const queuedOutcome = h.coordinator.submit({ key: 'raw', revision: 2, job: queued });

  assert.equal(h.coordinator.cancel('raw'), true);
  assert.deepEqual(await queuedOutcome, { status: 'canceled', key: 'raw', revision: 2 });
  running.deferred.resolve('obsolete');
  assert.deepEqual(await runningOutcome, { status: 'stale', key: 'raw', revision: 1 });
  assert.equal(h.goods.length, 0);
  assert.equal(h.coordinator.telemetry().canceled, 1);

  const retryOutcome = h.coordinator.submit({ key: 'raw', revision: 2, job: retry });
  retry.deferred.resolve('current');
  assert.equal((await retryOutcome).status, 'published');
  assert.equal(h.coordinator.getLastGood('raw')?.value, 'current');
  assert.equal(h.coordinator.release('raw'), true);
  assert.equal(h.coordinator.getLastGood('raw'), undefined);
  assert.equal(h.coordinator.cancel('raw'), false);
}

async function newerSameKeyWorkComputationallyPreemptsRunningWork() {
  const h = harness();
  const obsolete = abortableJob('obsolete');
  const current = job('current');
  const obsoleteOutcome = h.coordinator.submit({
    key: 'page',
    revision: 1,
    priority: 'layout',
    job: obsolete,
  });
  const currentOutcome = h.coordinator.submit({
    key: 'page',
    revision: 2,
    priority: 'layout',
    job: current,
  });

  assert.equal(h.starts[0].context.signal.aborted, true);
  assert.equal(h.starts[0].context.signal.reason, 'newer-request');
  assert.deepEqual(await obsoleteOutcome, { status: 'stale', key: 'page', revision: 1 });
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'current');
  current.deferred.resolve('fresh');
  assert.equal((await currentOutcome).status, 'published');
  assert.equal(h.coordinator.telemetry().preempted, 1);
  assert.deepEqual(h.goods.map((publication) => publication.value), ['fresh']);
}

async function finalWorkPreemptsPreviewButFinalWorkIsProtected() {
  const h = harness();
  const preview = abortableJob('preview');
  const firstFinal = job('first-final');
  const secondFinal = job('second-final');
  const laterPreview = job('later-preview');
  const previewOutcome = h.coordinator.submit({
    key: 'preview',
    revision: 1,
    priority: 'background',
    job: preview,
  });
  const firstFinalOutcome = h.coordinator.submit({
    key: 'final:1',
    revision: 1,
    priority: 'final',
    job: firstFinal,
  });

  assert.equal(h.starts[0].context.signal.aborted, true);
  assert.equal(h.starts[0].context.signal.reason, 'final-preemption');
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'first-final');

  const secondFinalOutcome = h.coordinator.submit({
    key: 'final:2',
    revision: 1,
    priority: 'final',
    job: secondFinal,
  });
  const laterPreviewOutcome = h.coordinator.submit({
    key: 'preview:later',
    revision: 1,
    priority: 'foreground',
    job: laterPreview,
  });
  assert.deepEqual(
    await h.coordinator.submit({
      key: 'final:1',
      revision: 2,
      priority: 'foreground',
      job: job('conflicting-preview'),
    }),
    { status: 'rejected', key: 'final:1', revision: 2, reason: 'capacity' },
  );
  assert.equal(h.starts.at(-1)?.context.signal.aborted, false);

  firstFinal.deferred.resolve('pdf-1');
  assert.equal((await firstFinalOutcome).status, 'published');
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'second-final');
  assert.equal(h.starts.at(-1)?.context.signal.aborted, false);
  secondFinal.deferred.resolve('pdf-2');
  assert.equal((await secondFinalOutcome).status, 'published');
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'later-preview');
  laterPreview.deferred.resolve('preview-later');
  assert.equal((await laterPreviewOutcome).status, 'published');
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'preview');
  preview.retryDeferreds?.[0].resolve('preview-resumed');
  assert.equal((await previewOutcome).status, 'published');
  assert.equal(h.coordinator.telemetry().preempted, 1);
  assert.equal(h.coordinator.telemetry().staleCompletions, 0);
}

async function finalPreemptionRequeueUsesOnlyTheBoundedReserve() {
  const h = harness(1);
  const preview = abortableJob('preview-to-resume');
  const disposable = job('disposable-queued-preview');
  const final = job('protected-final');
  const previewOutcome = h.coordinator.submit({
    key: 'preview', revision: 1, priority: 'background', job: preview,
  });
  const disposableOutcome = h.coordinator.submit({
    key: 'disposable', revision: 1, priority: 'background', job: disposable,
  });
  const finalOutcome = h.coordinator.submit({
    key: 'final:bounded', revision: 1, priority: 'final', job: final,
  });

  assert.deepEqual(await disposableOutcome, {
    status: 'superseded',
    key: 'disposable',
    revision: 1,
    reason: 'priority-eviction',
    by: { key: 'final:bounded', revision: 1 },
  });
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'protected-final');
  assert.equal(h.coordinator.telemetry().queueDepth, 1);
  assert.equal(h.coordinator.telemetry().maxQueueDepth, 2);

  final.deferred.resolve('final-output');
  assert.equal((await finalOutcome).status, 'published');
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'preview-to-resume');
  preview.retryDeferreds?.[0].resolve('resumed-preview');
  assert.equal((await previewOutcome).status, 'published');
  assert.ok(h.coordinator.telemetry().maxQueueDepth <= 2);
}

async function cancelAndReleaseAbortRunningDisposableWork() {
  const h = harness();
  const canceled = abortableJob('canceled');
  const canceledOutcome = h.coordinator.submit({ key: 'cancel-me', revision: 1, job: canceled });
  assert.equal(h.coordinator.cancel('cancel-me'), true);
  assert.equal(h.starts[0].context.signal.aborted, true);
  assert.equal(h.starts[0].context.signal.reason, 'canceled');
  assert.deepEqual(await canceledOutcome, { status: 'stale', key: 'cancel-me', revision: 1 });

  const released = abortableJob('released');
  const releasedOutcome = h.coordinator.submit({ key: 'release-me', revision: 1, job: released });
  assert.equal(h.coordinator.release('release-me'), true);
  assert.equal(h.starts.at(-1)?.context.signal.aborted, true);
  assert.equal(h.starts.at(-1)?.context.signal.reason, 'canceled');
  assert.deepEqual(await releasedOutcome, { status: 'stale', key: 'release-me', revision: 1 });
  assert.equal(h.coordinator.telemetry().preempted, 2);
  await h.coordinator.whenIdle();
}

async function telemetryRecordsDepthAndWait() {
  const h = harness();
  const blocker = job('blocker');
  const waited = job('waited');
  const blockerOutcome = h.coordinator.submit({ key: 'blocker', revision: 1, job: blocker });
  h.advance(5);
  const waitedOutcome = h.coordinator.submit({ key: 'waited', revision: 1, job: waited });
  h.advance(20);
  blocker.deferred.resolve('done');
  await blockerOutcome;
  await tick();
  assert.equal(h.starts.at(-1)?.name, 'waited');
  let stats = h.coordinator.telemetry();
  assert.equal(stats.lastWaitMs, 20);
  assert.equal(stats.maxWaitMs, 20);
  assert.equal(stats.totalWaitMs, 20);
  assert.equal(stats.waitSamples, 2);
  assert.equal(stats.averageWaitMs, 10);
  h.advance(7);
  waited.deferred.resolve('done');
  await waitedOutcome;
  stats = h.coordinator.telemetry();
  assert.equal(stats.succeeded, 2);
  assert.equal(stats.queueDepth, 0);
  assert.equal(stats.running, false);
  assert.ok(h.telemetry.includes(1));
}

const cases: Array<[string, () => Promise<void>]> = [
  ['latest queued request wins', latestQueuedRequestWins],
  ['priority lanes are strict and FIFO', priorityLanesAreStrictAndFifo],
  ['final work preserves a protected preview successor', finalWorkPreservesAProtectedPreviewSuccessor],
  ['pending work is bounded with priority admission', pendingWorkIsBoundedWithPriorityAdmission],
  ['stale revisions cannot publish', staleRevisionsCannotPublish],
  ['capacity rejection still advances the revision watermark', capacityRejectionStillAdvancesTheRevisionWatermark],
  ['failures retain last-good and stale errors stay silent', failuresRetainLastGoodAndStaleErrorsStaySilent],
  ['cancellation invalidates queued and running work', cancellationInvalidatesQueuedAndRunningWork],
  ['newer same-key work computationally preempts running work', newerSameKeyWorkComputationallyPreemptsRunningWork],
  ['final work preempts preview but final work is protected', finalWorkPreemptsPreviewButFinalWorkIsProtected],
  ['final preemption requeue uses only the bounded reserve', finalPreemptionRequeueUsesOnlyTheBoundedReserve],
  ['cancel and release abort running disposable work', cancelAndReleaseAbortRunningDisposableWork],
  ['telemetry records depth and wait', telemetryRecordsDepthAndWait],
];

for (const [name, run] of cases) {
  await run();
  console.log(`  ok  ${name}`);
}

console.log('\nall compile coordinator tests passed');
