// One whole-document Typst publication per EditorView and document revision.
//
// Page layout and executable-embed previews need the same compiled document.
// They must not submit two nearly identical worker jobs, nor may either
// consumer cancel work that the other still needs. This broker owns the one
// coordinated compiler key, shares a pending publication between consumers,
// and retains the completed result for a late consumer of the same immutable
// ProseMirror document. Asset changes advance a separate epoch because they
// can change output without changing the document object.

import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import {
  cancelCoordinatedCompilerTask,
  releaseCoordinatedCompilerKey,
  type PreviewCompilePriority,
} from './compiler/coordinated-compiler';
import type { TypstDocumentSvgPublication } from './typst-document-publication';

const ASSET_EVENT = 'typeset-assets-changed';
let nextBrokerId = 1;

export interface DocumentCompileExecutionRequest {
  key: string;
  revision: number;
  priority: PreviewCompilePriority;
  signal: AbortSignal;
}

export type DocumentCompiler = (
  doc: PMNode,
  onMessage: (message: string) => void,
  request: DocumentCompileExecutionRequest,
) => Promise<TypstDocumentSvgPublication | null>;

export interface DocumentCompileRequest {
  priority: PreviewCompilePriority;
  signal?: AbortSignal;
  onMessage?: (message: string) => void;
}

export interface DocumentCompileBrokerStats {
  /** Whole-document jobs admitted through this broker. */
  compilerTasks: number;
  /** Non-null, current results published and cached. */
  publications: number;
  /** Requests served by an in-flight or completed publication. */
  sharedRequests: number;
  /** Active product owners (layout and/or embed preview manager). */
  owners: number;
}

interface CachedOutcome {
  epoch: number;
  messages: readonly string[];
  value?: TypstDocumentSvgPublication | null;
  error?: unknown;
}

interface Waiter {
  signal?: AbortSignal;
  onAbort?: () => void;
  onMessage?: (message: string) => void;
  resolve: (value: TypstDocumentSvgPublication | null) => void;
  reject: (error: unknown) => void;
}

interface PendingPublication {
  doc: PMNode;
  epoch: number;
  generation: number;
  revision: number;
  priority: PreviewCompilePriority;
  abort: AbortController;
  waiters: Set<Waiter>;
  messages: string[];
}

const defaultCompiler: DocumentCompiler = async (doc, onMessage, request) => {
  if (request.signal.aborted) return null;
  const { compileDocSvgWithEmbedRegions } = await import('./pdf');
  if (request.signal.aborted) return null;
  return compileDocSvgWithEmbedRegions(doc, onMessage, request, request.signal);
};

/** Testable broker implementation. Product code acquires the shared instance
 * through acquireDocumentCompileBroker(); injected manager tests may own an
 * isolated instance with a deterministic compiler. */
export class DocumentCompileBroker {
  private readonly compileKey = `document:editor:${nextBrokerId++}`;
  private cache = new WeakMap<PMNode, CachedOutcome>();
  private current: PendingPublication | null = null;
  private epoch = 0;
  private generation = 0;
  private revision = 0;
  private destroyed = false;
  private compilerTasks = 0;
  private publications = 0;
  private sharedRequests = 0;
  private ownerCount = 0;
  private readonly onAssets = () => this.invalidateAssets();

  constructor(
    private readonly view: { readonly state: { readonly doc: PMNode } },
    private readonly compiler: DocumentCompiler = defaultCompiler,
  ) {
    if (typeof window !== 'undefined') window.addEventListener(ASSET_EVENT, this.onAssets);
  }

  /** Request the exact publication for one immutable document. A consumer's
   * abort only detaches that consumer. The worker is stopped only after every
   * waiter has left, or when a newer live document/asset epoch supersedes it. */
  request(
    doc: PMNode,
    request: DocumentCompileRequest,
  ): Promise<TypstDocumentSvgPublication | null> {
    if (this.destroyed || request.signal?.aborted || doc !== this.view.state.doc) {
      return Promise.resolve(null);
    }

    const cached = this.cache.get(doc);
    if (cached?.epoch === this.epoch) {
      this.sharedRequests++;
      if (request.onMessage) {
        for (const message of cached.messages) this.deliverMessage(request.onMessage, message);
      }
      if ('error' in cached) return Promise.reject(cached.error);
      return Promise.resolve(cached.value ?? null);
    }

    let pending = this.current;
    if (pending && pending.doc === doc && pending.epoch === this.epoch) {
      this.sharedRequests++;
    } else {
      if (pending) this.cancelPending('newer-request');
      pending = this.start(doc, request.priority);
    }
    return this.attach(pending, request);
  }

  /** Asset bytes can change under an identical PM document. Drop every
   * completed outcome and make any old in-flight publication unpublishable. */
  invalidateAssets(): void {
    if (this.destroyed) return;
    this.epoch++;
    this.cache = new WeakMap();
    this.cancelPending('newer-request');
  }

  setOwnerCount(count: number): void {
    this.ownerCount = count;
  }

  stats(): Readonly<DocumentCompileBrokerStats> {
    return Object.freeze({
      compilerTasks: this.compilerTasks,
      publications: this.publications,
      sharedRequests: this.sharedRequests,
      owners: this.ownerCount,
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    this.cancelPending('canceled');
    if (typeof window !== 'undefined') window.removeEventListener(ASSET_EVENT, this.onAssets);
    releaseCoordinatedCompilerKey(this.compileKey);
    this.cache = new WeakMap();
    this.ownerCount = 0;
  }

  private start(doc: PMNode, priority: PreviewCompilePriority): PendingPublication {
    const pending: PendingPublication = {
      doc,
      epoch: this.epoch,
      generation: ++this.generation,
      revision: ++this.revision,
      priority,
      abort: new AbortController(),
      waiters: new Set(),
      messages: [],
    };
    this.current = pending;
    this.compilerTasks++;
    void this.run(pending);
    return pending;
  }

  private attach(
    pending: PendingPublication,
    request: DocumentCompileRequest,
  ): Promise<TypstDocumentSvgPublication | null> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal: request.signal,
        onMessage: request.onMessage,
        resolve,
        reject,
      };
      pending.waiters.add(waiter);
      if (request.onMessage) {
        for (const message of pending.messages) this.deliverMessage(request.onMessage, message);
      }
      if (request.signal) {
        waiter.onAbort = () => {
          if (!pending.waiters.delete(waiter)) return;
          resolve(null);
          if (this.current === pending && pending.waiters.size === 0) {
            this.cancelPending('canceled');
          }
        };
        request.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      // An abort can race between request()'s early guard and listener setup.
      if (request.signal?.aborted) {
        waiter.onAbort?.();
        return;
      }
    });
  }

  private async run(pending: PendingPublication): Promise<void> {
    try {
      const value = await this.compiler(
        pending.doc,
        (message) => {
          if (this.current !== pending || pending.generation !== this.generation) return;
          pending.messages.push(message);
          for (const waiter of pending.waiters) {
            if (waiter.onMessage) this.deliverMessage(waiter.onMessage, message);
          }
        },
        {
          key: this.compileKey,
          revision: pending.revision,
          priority: pending.priority,
          signal: pending.abort.signal,
        },
      );
      if (!this.isCurrent(pending)) return;
      if (pending.doc !== this.view.state.doc) {
        this.finish(pending, { value: null }, false);
        return;
      }
      this.cache.set(pending.doc, {
        epoch: pending.epoch,
        messages: Object.freeze([...pending.messages]),
        value,
      });
      if (value) this.publications++;
      this.finish(pending, { value }, true);
    } catch (error) {
      if (!this.isCurrent(pending)) return;
      if (pending.doc !== this.view.state.doc) {
        this.finish(pending, { value: null }, false);
        return;
      }
      this.cache.set(pending.doc, {
        epoch: pending.epoch,
        messages: Object.freeze([...pending.messages]),
        error,
      });
      this.finish(pending, { error }, true);
    }
  }

  private isCurrent(pending: PendingPublication): boolean {
    return (
      !this.destroyed &&
      this.current === pending &&
      pending.generation === this.generation &&
      pending.epoch === this.epoch &&
      !pending.abort.signal.aborted
    );
  }

  private finish(
    pending: PendingPublication,
    outcome: { value?: TypstDocumentSvgPublication | null; error?: unknown },
    publish: boolean,
  ): void {
    if (this.current === pending) this.current = null;
    for (const waiter of pending.waiters) {
      this.detachAbort(waiter);
      if (!publish) waiter.resolve(null);
      else if ('error' in outcome) waiter.reject(outcome.error);
      else waiter.resolve(outcome.value ?? null);
    }
    pending.waiters.clear();
  }

  private cancelPending(_reason: 'newer-request' | 'canceled'): void {
    const pending = this.current;
    if (!pending) return;
    this.current = null;
    this.generation++;
    pending.abort.abort(_reason);
    cancelCoordinatedCompilerTask(this.compileKey);
    for (const waiter of pending.waiters) {
      this.detachAbort(waiter);
      waiter.resolve(null);
    }
    pending.waiters.clear();
  }

  private detachAbort(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }

  private deliverMessage(listener: (message: string) => void, message: string): void {
    try {
      listener(message);
    } catch {
      // Diagnostics are advisory; one consumer must not break publication for
      // the other consumer sharing this compile.
    }
  }
}

interface BrokerRecord {
  broker: DocumentCompileBroker;
  owners: number;
}

export interface DocumentCompileBrokerLease {
  broker: DocumentCompileBroker;
  release(): void;
}

const brokers = new WeakMap<EditorView, BrokerRecord>();

/** Acquire the one broker shared by product consumers in an EditorView. */
export function acquireDocumentCompileBroker(view: EditorView): DocumentCompileBrokerLease {
  let record = brokers.get(view);
  if (!record) {
    record = { broker: new DocumentCompileBroker(view), owners: 0 };
    brokers.set(view, record);
  }
  record.owners++;
  record.broker.setOwnerCount(record.owners);
  let released = false;
  return {
    broker: record.broker,
    release() {
      if (released) return;
      released = true;
      const current = brokers.get(view);
      if (!current || current.broker !== record!.broker) return;
      current.owners--;
      current.broker.setOwnerCount(current.owners);
      if (current.owners > 0) return;
      brokers.delete(view);
      current.broker.destroy();
    },
  };
}

/** Development/test visibility without creating or retaining a broker. */
export function documentCompileBrokerStats(view: EditorView): Readonly<DocumentCompileBrokerStats> {
  return brokers.get(view)?.broker.stats() ?? Object.freeze({
    compilerTasks: 0,
    publications: 0,
    sharedRequests: 0,
    owners: 0,
  });
}
