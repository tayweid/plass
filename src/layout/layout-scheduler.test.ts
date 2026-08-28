import assert from 'node:assert/strict';
import {
  EDIT_SETTLE_DELAY_MS,
  LayoutScheduler,
  RESIZE_THRESHOLD_PX,
  type LayoutSchedulerEnvironment,
  type LayoutSchedulerFonts,
} from './layout-scheduler';

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(value: T): void {
    this.resolvePromise(value);
  }
}

class FakeEnvironment implements LayoutSchedulerEnvironment {
  private nextId = 1;
  readonly timeouts = new Map<number, { callback: () => void; delayMs: number }>();
  readonly frames = new Map<number, FrameRequestCallback>();
  readonly fontReady = new Deferred<unknown>();
  readonly fontListeners = new Set<() => void>();
  resizeListener: (() => void) | null = null;
  resizeDisconnects = 0;

  readonly fonts: LayoutSchedulerFonts = {
    ready: this.fontReady.promise,
    subscribeLoadingDone: (listener) => {
      this.fontListeners.add(listener);
      return () => this.fontListeners.delete(listener);
    },
  };

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: number): void {
    this.timeouts.delete(handle);
  }

  requestAnimationFrame(callback: FrameRequestCallback): number {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  }

  cancelAnimationFrame(handle: number): void {
    this.frames.delete(handle);
  }

  observeResize(_target: HTMLElement, listener: () => void): () => void {
    this.resizeListener = listener;
    return () => {
      this.resizeDisconnects++;
      if (this.resizeListener === listener) this.resizeListener = null;
    };
  }

  flushFrames(): void {
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const callback of pending) callback(0);
  }

  flushTimeouts(): void {
    const pending = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const { callback } of pending) callback();
  }

  emitLoadingDone(): void {
    for (const listener of [...this.fontListeners]) listener();
  }
}

function harness() {
  const environment = new FakeEnvironment();
  const widthTarget = { clientWidth: 800 } as HTMLElement;
  const calls = { settled: 0, invalidations: 0 };
  const scheduler = new LayoutScheduler(
    widthTarget,
    {
      runSettled: () => calls.settled++,
      invalidateMetrics: () => calls.invalidations++,
    },
    environment,
  );
  return { environment, widthTarget, calls, scheduler };
}

// Constructor and settled requests share one animation frame.
{
  const { environment, calls, scheduler } = harness();
  scheduler.scheduleSettled();
  scheduler.scheduleSettled();
  assert.equal(environment.frames.size, 1);
  environment.flushFrames();
  assert.equal(calls.settled, 1);
  scheduler.destroy();
}

// Same-task edits share one restarted quiet-period timer.
{
  const { environment, calls, scheduler } = harness();
  environment.flushFrames();
  for (let i = 0; i < 3; i++) {
    scheduler.scheduleAfterEdit();
  }
  assert.equal(environment.timeouts.size, 1);
  environment.flushTimeouts();
  environment.flushFrames();
  assert.equal(calls.settled, 2);
  scheduler.destroy();
}

// Edits debounce for exactly 250 ms and suppress intervening settle requests.
{
  const { environment, calls, scheduler } = harness();
  environment.flushFrames();
  scheduler.scheduleAfterEdit();
  assert.equal([...environment.timeouts.values()][0]?.delayMs, EDIT_SETTLE_DELAY_MS);
  scheduler.scheduleSettled();
  assert.equal(environment.frames.size, 0);
  scheduler.scheduleAfterEdit();
  assert.equal(environment.timeouts.size, 1);
  environment.flushTimeouts();
  assert.equal(environment.frames.size, 1);
  environment.flushFrames();
  assert.equal(calls.settled, 2);
  scheduler.destroy();
}

// A frame queued before an edit belongs to a stale revision. The edit cancels
// it, then the quiet-period timer requests the authoritative settle.
{
  const { environment, calls, scheduler } = harness();
  scheduler.scheduleAfterEdit();
  environment.flushFrames();
  assert.deepEqual(calls, { settled: 0, invalidations: 0 });
  environment.flushTimeouts();
  environment.flushFrames();
  assert.deepEqual(calls, { settled: 1, invalidations: 0 });
  scheduler.destroy();
}

// Frame ownership clears before the callback, so callback-triggered work is
// queued for the following frame rather than being lost as a duplicate.
{
  const environment = new FakeEnvironment();
  const widthTarget = { clientWidth: 800 } as HTMLElement;
  let calls = 0;
  let scheduler!: LayoutScheduler;
  scheduler = new LayoutScheduler(
    widthTarget,
    {
      runSettled: () => {
        calls++;
        if (calls === 1) scheduler.scheduleSettled();
      },
      invalidateMetrics: () => {},
    },
    environment,
  );
  environment.flushFrames();
  assert.equal(calls, 1);
  assert.equal(environment.frames.size, 1);
  environment.flushFrames();
  assert.equal(calls, 2);
  scheduler.destroy();
}

// Resize changes accumulate against the last accepted width and use > 0.5 px.
{
  const { environment, widthTarget, calls, scheduler } = harness();
  environment.flushFrames();
  Object.defineProperty(widthTarget, 'clientWidth', { value: 800 + RESIZE_THRESHOLD_PX, configurable: true });
  environment.resizeListener?.();
  assert.equal(environment.frames.size, 0);
  Object.defineProperty(widthTarget, 'clientWidth', { value: 800.51, configurable: true });
  environment.resizeListener?.();
  assert.equal(environment.frames.size, 1);
  environment.flushFrames();
  assert.equal(calls.settled, 2);
  scheduler.destroy();
}

// Both FontFaceSet channels invalidate metrics, then request a coalesced settle.
{
  const { environment, calls, scheduler } = harness();
  environment.flushFrames();
  environment.emitLoadingDone();
  assert.equal(calls.invalidations, 1);
  assert.equal(environment.frames.size, 1);
  environment.fontReady.resolve(undefined);
  await Promise.resolve();
  assert.equal(calls.invalidations, 2);
  assert.equal(environment.frames.size, 1);
  environment.flushFrames();
  assert.equal(calls.settled, 2);
  scheduler.destroy();
}

// Destruction is idempotent and pending callbacks cannot reach the view.
{
  const { environment, calls, scheduler } = harness();
  scheduler.scheduleAfterEdit();
  scheduler.destroy();
  scheduler.destroy();
  assert.equal(environment.resizeDisconnects, 1);
  assert.equal(environment.fontListeners.size, 0);
  assert.equal(environment.timeouts.size, 0);
  assert.equal(environment.frames.size, 0);
  environment.emitLoadingDone();
  environment.fontReady.resolve(undefined);
  await Promise.resolve();
  assert.deepEqual(calls, { settled: 0, invalidations: 0 });
}

console.log('layout scheduler tests passed');
