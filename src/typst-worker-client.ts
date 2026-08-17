// Main-thread RPC/watchdog for the isolated Typst worker. Requests are
// serialized because the compiler has one virtual filesystem. A deadline is
// enforced by terminating the worker, the only reliable way to interrupt
// synchronous WASM without freezing the editor.

import CompilerWorker from './typst-compiler.worker?worker';
import {
  compilerCircuitEpoch,
  isCompilerCircuitEpochBlocked,
  isCompilerCircuitOpen,
  openCompilerCircuit,
} from './compiler-circuit';
import {
  COMPILER_LIMITS,
  type CompilerRequest,
  type CompilerResponse,
  type CompilerTask,
  validateCompilerTask,
} from './typst-worker-protocol';

export class CompilerWorkerError extends Error {
  constructor(
    public readonly code: 'invalid' | 'compile' | 'output-limit' | 'timeout' | 'crash' | 'queue-limit' | 'circuit-open',
    message: string,
  ) {
    super(message);
    this.name = 'CompilerWorkerError';
  }
}

interface QueuedRequest<T> {
  id: number;
  epoch: number;
  task: CompilerTask;
  timeoutMs: number;
  onMessage: (message: string) => void;
  resolve: (value: T) => void;
  reject: (error: CompilerWorkerError) => void;
}

let worker: Worker | null = null;
let current: QueuedRequest<unknown> | null = null;
let nextId = 1;
let timeoutId = 0;
let idleTimer = 0;
const queue: Array<QueuedRequest<unknown>> = [];
let workersCreated = 0;
let tasksPosted = 0;
let circuitRejects = 0;

function terminateIdleWorker() {
  if (current || queue.length) return;
  worker?.terminate();
  worker = null;
}

function scheduleIdleTermination() {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(terminateIdleWorker, 120_000);
}

function rejectCurrent(code: 'timeout' | 'crash', message: string) {
  window.clearTimeout(timeoutId);
  timeoutId = 0;
  worker?.terminate();
  worker = null;
  const request = current;
  current = null;
  request?.reject(new CompilerWorkerError(code, message));

  // A timeout can be caused by hostile input with a super-linear parser or
  // by a document that exhausts the compiler. Do not feed queued work from
  // that same (or an older) input generation to replacement workers.
  // Background retries from that generation stay blocked until a trusted
  // action advances the shared circuit epoch.
  if (code === 'timeout') {
    const timedOutEpoch = request?.epoch;
    if (timedOutEpoch !== undefined) {
      openCompilerCircuit(timedOutEpoch);
      const retained: Array<QueuedRequest<unknown>> = [];
      for (const queued of queue.splice(0)) {
        if (queued.epoch <= timedOutEpoch) {
          queued.reject(new CompilerWorkerError(
            'timeout',
            'Typst compilation was canceled after an earlier request timed out; retry the action or edit the document',
          ));
        } else {
          retained.push(queued);
        }
      }
      queue.push(...retained);
    }
    // A genuine edit may have authorized newer work while the old request
    // was still running. Its epoch is not poisoned by the old timeout.
    if (queue.length) queueMicrotask(pump);
    return;
  }
  queueMicrotask(pump);
}

function handleResponse(source: Worker, response: CompilerResponse) {
  // Terminated workers can still have already-queued events. They must never
  // be allowed to reject a request running in the replacement worker.
  if (worker !== source) return;
  const request = current;
  if (!request || response.id !== request.id) {
    rejectCurrent('crash', 'Compiler worker returned an unexpected response');
    return;
  }
  window.clearTimeout(timeoutId);
  current = null;
  if (response.ok) request.resolve(response.value);
  else {
    request.reject(new CompilerWorkerError(response.code, response.message));
    // An output-limit task may have left a large compiler arena behind.
    if (response.code === 'output-limit') {
      worker?.terminate();
      worker = null;
    }
  }
  if (queue.length) queueMicrotask(pump);
  else scheduleIdleTermination();
}

function ensureWorker(onMessage: (message: string) => void): Worker {
  if (worker) return worker;
  try {
    onMessage('Loading Typst compiler…');
  } catch (error) {
    console.warn('Compiler status callback failed', error);
  }
  const instance = new CompilerWorker();
  workersCreated++;
  instance.onmessage = (event: MessageEvent<CompilerResponse>) => handleResponse(instance, event.data);
  instance.onerror = (event) => {
    if (worker !== instance) return;
    event.preventDefault();
    rejectCurrent('crash', 'Typst compiler worker crashed');
  };
  instance.onmessageerror = () => {
    if (worker === instance) rejectCurrent('crash', 'Typst compiler returned unreadable data');
  };
  worker = instance;
  return instance;
}

function pump() {
  if (current || !queue.length) return;
  window.clearTimeout(idleTimer);
  const request = queue.shift()!;
  current = request;
  let instance: Worker;
  try {
    instance = ensureWorker(request.onMessage);
  } catch {
    rejectCurrent('crash', 'Could not start the Typst compiler worker');
    return;
  }
  timeoutId = window.setTimeout(() => {
    // A response could have won the event-loop race after this callback was
    // queued. Never let an old deadline terminate the next request.
    if (current !== request) return;
    rejectCurrent('timeout', `Typst compilation exceeded ${(request.timeoutMs / 1000).toFixed(0)} seconds and was stopped`);
  }, request.timeoutMs);
  const message: CompilerRequest = { id: request.id, task: request.task };
  try {
    instance.postMessage(message);
    tasksPosted++;
  } catch {
    rejectCurrent('crash', 'Could not send work to the Typst compiler');
  }
}

export function runCompilerTask<T extends string | Uint8Array | unknown[] | null>(
  task: CompilerTask,
  options: { timeoutMs: number; onMessage?: (message: string) => void },
): Promise<T> {
  const invalid = validateCompilerTask(task);
  if (invalid) return Promise.reject(new CompilerWorkerError('invalid', invalid));
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new CompilerWorkerError('invalid', 'Typst compiler deadline must be a positive duration'));
  }
  const epoch = compilerCircuitEpoch();
  if (isCompilerCircuitEpochBlocked(epoch)) {
    circuitRejects++;
    return Promise.reject(new CompilerWorkerError(
      'circuit-open',
      'Typst compilation is paused after a timeout; edit or reopen the document, or explicitly export again',
    ));
  }
  if (queue.length + (current ? 1 : 0) >= COMPILER_LIMITS.pendingRequests) {
    return Promise.reject(new CompilerWorkerError('queue-limit', 'Typst compiler queue is full; wait for current previews to finish'));
  }
  return new Promise<T>((resolve, reject) => {
    queue.push({
      id: nextId++,
      epoch,
      task,
      timeoutMs: options.timeoutMs,
      onMessage: options.onMessage ?? (() => {}),
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    pump();
  });
}

/** Deterministic browser regression hook; production builds reject the task. */
export async function testCompilerWatchdog(): Promise<CompilerWorkerError> {
  if (!import.meta.env.DEV) throw new Error('Compiler watchdog probe is development-only');
  try {
    await runCompilerTask({ kind: 'test-busy', milliseconds: 5_000 }, { timeoutMs: 75 });
  } catch (error) {
    if (error instanceof CompilerWorkerError) return error;
    throw error;
  }
  throw new Error('Compiler watchdog did not stop the worker');
}

/** Deterministic browser regression hook for timeout queue containment. */
export async function testCompilerTimeoutCircuitBreaker(): Promise<{
  timedOut: CompilerWorkerError;
  canceled: CompilerWorkerError[];
}> {
  if (!import.meta.env.DEV) throw new Error('Compiler circuit-breaker probe is development-only');

  const capture = async (promise: Promise<unknown>): Promise<CompilerWorkerError> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof CompilerWorkerError) return error;
      throw error;
    }
    throw new Error('Compiler circuit-breaker probe unexpectedly completed');
  };

  const timedOut = capture(runCompilerTask(
    { kind: 'test-busy', milliseconds: 5_000 },
    { timeoutMs: 75 },
  ));
  const canceled = Array.from({ length: 3 }, () => capture(runCompilerTask(
    { kind: 'test-busy', milliseconds: 250 },
    { timeoutMs: 2_000 },
  )));

  return {
    timedOut: await timedOut,
    canceled: await Promise.all(canceled),
  };
}

/** Development-only lifecycle counters for containment regression tests. */
export function testCompilerLifecycleStats(): {
  circuitOpen: boolean;
  epoch: number;
  workersCreated: number;
  tasksPosted: number;
  circuitRejects: number;
  active: boolean;
  queued: number;
} {
  if (!import.meta.env.DEV) throw new Error('Compiler lifecycle stats are development-only');
  return {
    circuitOpen: isCompilerCircuitOpen(),
    epoch: compilerCircuitEpoch(),
    workersCreated,
    tasksPosted,
    circuitRejects,
    active: current !== null,
    queued: queue.length,
  };
}

import.meta.hot?.dispose(() => {
  window.clearTimeout(timeoutId);
  window.clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
  current?.reject(new CompilerWorkerError('crash', 'Compiler worker reloaded'));
  current = null;
  for (const request of queue.splice(0)) {
    request.reject(new CompilerWorkerError('crash', 'Compiler worker reloaded'));
  }
});
