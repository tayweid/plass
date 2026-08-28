import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import {
  acquireDocumentCompileBroker,
  DocumentCompileBroker,
  type DocumentCompiler,
} from './document-compile-broker';
import type { TypstDocumentSvgPublication } from './typst-document-publication';

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeDoc(id: string): PMNode {
  return { type: { name: id } } as unknown as PMNode;
}

function publication(svg: string): TypstDocumentSvgPublication {
  return { svg, regions: [] };
}

async function checkSharedPublicationAndIndependentAbort() {
  const doc = fakeDoc('shared');
  const viewState = { state: { doc } };
  const compile = deferred<TypstDocumentSvgPublication | null>();
  let compilerCalls = 0;
  const compilerSignals: AbortSignal[] = [];
  const compiler: DocumentCompiler = async (_doc, onMessage, request) => {
    compilerCalls++;
    compilerSignals.push(request.signal);
    onMessage('preparing exact document');
    return compile.promise;
  };
  const broker = new DocumentCompileBroker(viewState, compiler);
  const layoutAbort = new AbortController();
  const embedMessages: string[] = [];
  const layout = broker.request(doc, { priority: 'layout', signal: layoutAbort.signal });
  const embed = broker.request(doc, {
    priority: 'foreground',
    onMessage: (message) => embedMessages.push(message),
  });

  check('two consumers admit one compiler task', compilerCalls === 1 && broker.stats().compilerTasks === 1);
  check('late joiner receives earlier compiler diagnostics', embedMessages[0] === 'preparing exact document');
  layoutAbort.abort();
  check('canceling layout resolves only its waiter', (await layout) === null);
  check('layout cannot abort a publication still needed by embeds', compilerSignals[0]?.aborted === false);

  const exact = publication('<svg id="shared"/>');
  compile.resolve(exact);
  check('remaining consumer receives the exact shared object', (await embed) === exact);
  const late = await broker.request(doc, { priority: 'layout' });
  check('late page consumer reuses the completed publication', late === exact && compilerCalls === 1);
  check(
    'broker records one publication and both shared requests',
    broker.stats().publications === 1 && broker.stats().sharedRequests === 2,
  );

  broker.invalidateAssets();
  const refreshed = await broker.request(doc, { priority: 'layout' });
  check('asset epoch recompiles an unchanged document', refreshed === exact && compilerCalls === 2);
  broker.destroy();
}

async function checkAllWaitersCancelAndStaleCompletionCannotPublish() {
  const doc = fakeDoc('cancel');
  const viewState = { state: { doc } };
  const stale = deferred<TypstDocumentSvgPublication | null>();
  const fresh = publication('<svg id="fresh"/>');
  let calls = 0;
  const compilerSignals: AbortSignal[] = [];
  const compiler: DocumentCompiler = async (_doc, _message, request) => {
    calls++;
    if (calls === 1) {
      compilerSignals.push(request.signal);
      return stale.promise;
    }
    return fresh;
  };
  const broker = new DocumentCompileBroker(viewState, compiler);
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = broker.request(doc, { priority: 'layout', signal: firstAbort.signal });
  const second = broker.request(doc, { priority: 'foreground', signal: secondAbort.signal });
  firstAbort.abort();
  check('one remaining consumer keeps the worker alive', compilerSignals[0]?.aborted === false);
  secondAbort.abort();
  check('last consumer leaving aborts obsolete worker work', compilerSignals[0]?.aborted === true);
  check('both canceled consumers resolve without an error', (await first) === null && (await second) === null);

  const next = broker.request(doc, { priority: 'foreground' });
  stale.resolve(publication('<svg id="stale"/>'));
  check('ignored-abort stale completion cannot replace the new result', (await next) === fresh);
  await Promise.resolve();
  check(
    'only the current retry publishes',
    broker.stats().compilerTasks === 2 && broker.stats().publications === 1,
  );
  broker.destroy();
}

function checkRefCountedPerViewOwnership() {
  const doc = fakeDoc('lease');
  const view = { state: { doc } } as unknown as EditorView;
  const layout = acquireDocumentCompileBroker(view);
  const embeds = acquireDocumentCompileBroker(view);
  check('layout and embeds acquire the same per-view broker', layout.broker === embeds.broker);
  check('both product owners are visible', layout.broker.stats().owners === 2);
  layout.release();
  check('releasing layout leaves the embed-owned broker alive', embeds.broker.stats().owners === 1);
  embeds.release();
  check('last owner teardown destroys the per-view broker', embeds.broker.stats().owners === 0);
}

await checkSharedPublicationAndIndependentAbort();
await checkAllWaitersCancelAndStaleCompletionCannotPublish();
checkRefCountedPerViewOwnership();

console.log('\nall document compile broker tests passed');
