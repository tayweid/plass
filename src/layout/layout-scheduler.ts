/**
 * Scheduling and browser-lifecycle policy for settled layout.
 *
 * This class deliberately knows nothing about ProseMirror or line breaking.
 * It only preserves the timing contract used by the typeset view:
 *
 * - full layout waits 250 ms after the latest edit;
 * - unrelated full-layout requests are suppressed during that edit window;
 * - full layout otherwise coalesces into one animation frame;
 * - meaningful width and font changes request a fresh full layout.
 */

export const EDIT_SETTLE_DELAY_MS = 250;
export const RESIZE_THRESHOLD_PX = 0.5;

export interface LayoutSchedulerCallbacks {
  runSettled: () => void;
  /** Drop font/measurement-dependent caches before the following settle. */
  invalidateMetrics: () => void;
}

export interface LayoutSchedulerFonts {
  readonly ready: PromiseLike<unknown>;
  /** Subscribe to lazily loaded webfont completions. */
  subscribeLoadingDone(listener: () => void): () => void;
}

/** Injectable browser boundary. Tests use a deterministic in-memory clock. */
export interface LayoutSchedulerEnvironment {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  observeResize(target: HTMLElement, listener: () => void): () => void;
  readonly fonts?: LayoutSchedulerFonts;
}

function browserEnvironment(): LayoutSchedulerEnvironment {
  if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
    throw new Error('LayoutScheduler requires a browser environment');
  }
  const fontSet = typeof document !== 'undefined' ? document.fonts : undefined;
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    observeResize: (target, listener) => {
      const observer = new ResizeObserver(listener);
      observer.observe(target);
      return () => observer.disconnect();
    },
    fonts: fontSet
      ? {
          ready: fontSet.ready,
          subscribeLoadingDone: (listener) => {
            fontSet.addEventListener('loadingdone', listener);
            return () => fontSet.removeEventListener('loadingdone', listener);
          },
        }
      : undefined,
  };
}

export class LayoutScheduler {
  private readonly environment: LayoutSchedulerEnvironment;
  private editTimer: number | null = null;
  private settledFrame: number | null = null;
  private lastWidth: number;
  private stopResize: (() => void) | null = null;
  private stopFontEvents: (() => void) | null = null;
  private destroyed = false;

  constructor(
    private readonly widthTarget: HTMLElement,
    private readonly callbacks: LayoutSchedulerCallbacks,
    environment?: LayoutSchedulerEnvironment,
  ) {
    this.environment = environment ?? browserEnvironment();
    this.lastWidth = widthTarget.clientWidth;
    this.stopResize = this.environment.observeResize(widthTarget, this.onResize);

    const fonts = this.environment.fonts;
    if (fonts) {
      // A promise cannot be unsubscribed. onFontsChanged's destroyed guard
      // makes a late resolution harmless after teardown.
      void fonts.ready.then(this.onFontsChanged);
      this.stopFontEvents = fonts.subscribeLoadingDone(this.onFontsChanged);
    }

    // Match TypesetView's constructor: the first settled run is scheduled
    // after all observers/listeners have been installed.
    this.scheduleSettled();
  }

  /** Restart the quiet-period timer following a document edit. */
  scheduleAfterEdit(): void {
    if (this.destroyed) return;
    // A compiler/asset completion may already have queued a full-layout
    // frame. Once a document edit arrives that revision is stale and must not
    // be allowed to run during active typing; re-arm it after the quiet
    // period along with every other settled request.
    if (this.settledFrame !== null) {
      this.environment.cancelAnimationFrame(this.settledFrame);
      this.settledFrame = null;
    }
    if (this.editTimer !== null) this.environment.clearTimeout(this.editTimer);
    this.editTimer = this.environment.setTimeout(() => {
      this.editTimer = null;
      this.scheduleSettled();
    }, EDIT_SETTLE_DELAY_MS);
  }

  /**
   * Request full layout. Requests arriving during active editing are folded
   * into scheduleAfterEdit's eventual settle; otherwise they share one rAF.
   */
  scheduleSettled(): void {
    if (this.destroyed || this.editTimer !== null || this.settledFrame !== null) return;
    this.settledFrame = this.environment.requestAnimationFrame(() => {
      this.settledFrame = null;
      if (!this.destroyed) this.callbacks.runSettled();
    });
  }

  /** Remove every cancellable browser hook. Safe to call more than once. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.stopFontEvents?.();
    this.stopFontEvents = null;
    this.stopResize?.();
    this.stopResize = null;

    if (this.editTimer !== null) {
      this.environment.clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    if (this.settledFrame !== null) {
      this.environment.cancelAnimationFrame(this.settledFrame);
      this.settledFrame = null;
    }
  }

  private onResize = () => {
    if (this.destroyed) return;
    const width = this.widthTarget.clientWidth;
    if (Math.abs(width - this.lastWidth) > RESIZE_THRESHOLD_PX) {
      this.lastWidth = width;
      this.scheduleSettled();
    }
  };

  private onFontsChanged = () => {
    if (this.destroyed) return;
    this.callbacks.invalidateMetrics();
    this.scheduleSettled();
  };
}
