import { expect, test } from 'playwright/test';

test('abort removes queued and synchronous worker work without opening the timeout circuit', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const {
      CompilerWorkerError,
      runCompilerTask,
      testCompilerLifecycleStats,
    } = await import('/src/typst-worker-client.ts');

    // Let the editor's initial document-layout compile drain. Launching both
    // probes in the same browser task after this check makes their order
    // deterministic with respect to later timers.
    for (let attempt = 0; attempt < 200; attempt++) {
      const stats = testCompilerLifecycleStats();
      if (!stats.active && stats.queued === 0) break;
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    const before = testCompilerLifecycleStats();
    if (before.active || before.queued) throw new Error('Compiler did not become idle for the probe');

    const capture = (promise: Promise<unknown>) => promise.then(
      () => 'completed',
      (error: unknown) => error instanceof CompilerWorkerError ? error.code : String(error),
    );
    const runningController = new AbortController();
    const queuedController = new AbortController();
    const running = capture(runCompilerTask(
      { kind: 'test-busy', milliseconds: 5_000 },
      { timeoutMs: 10_000, signal: runningController.signal },
    ));
    const queued = capture(runCompilerTask(
      { kind: 'test-busy', milliseconds: 250 },
      { timeoutMs: 10_000, signal: queuedController.signal },
    ));
    const admitted = testCompilerLifecycleStats();

    queuedController.abort('canceled');
    const queuedCode = await queued;
    const afterQueuedAbort = testCompilerLifecycleStats();

    runningController.abort('newer-request');
    const runningCode = await running;
    const afterRunningAbort = testCompilerLifecycleStats();

    await runCompilerTask(
      { kind: 'test-busy', milliseconds: 5 },
      { timeoutMs: 2_000 },
    );
    const recovered = testCompilerLifecycleStats();
    return {
      admitted: admitted.active && admitted.queued === 1,
      queuedCode,
      runningCode,
      queuedRemovedOnly: afterQueuedAbort.active && afterQueuedAbort.queued === 0,
      runningRemoved: !afterRunningAbort.active && afterRunningAbort.queued === 0,
      circuitStayedClosed: !afterQueuedAbort.circuitOpen && !afterRunningAbort.circuitOpen && !recovered.circuitOpen,
      cancellationCount: afterRunningAbort.canceledRequests - before.canceledRequests,
      terminatedWorker: afterRunningAbort.workersAborted > before.workersAborted,
      replacementWorker: recovered.workersCreated > afterRunningAbort.workersCreated,
      replacementPosted: recovered.tasksPosted >= before.tasksPosted + 2,
    };
  });

  expect(result).toEqual({
    admitted: true,
    queuedCode: 'canceled',
    runningCode: 'canceled',
    queuedRemovedOnly: true,
    runningRemoved: true,
    circuitStayedClosed: true,
    cancellationCount: 2,
    terminatedWorker: true,
    replacementWorker: true,
    replacementPosted: true,
  });
});
