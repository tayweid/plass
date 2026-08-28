import { PageHoldConfidence } from './oracle-coordinator';
import { PageOracle, type PageOracleEntry } from './page-oracle';
import { TypstOracle, type ParagraphSpec } from './typst-oracle';
import { DEFAULT_SETTINGS } from '../settings';
import type { Node as PMNode } from 'prosemirror-model';

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

const policy = new PageHoldConfidence();
const failure: PageOracleEntry = { status: 'fail', reason: 'compiler unavailable' };

let decision = policy.observe(undefined);
check(
  'missing entry before an exact result is continuous',
  !decision.hold && decision.confidence === 'continuous' && decision.status === 'pending',
);

decision = policy.observe({ status: 'ok', pageStarts: [], pageCount: 1 });
check(
  'successful entry is exact rather than permission to hold older starts',
  !decision.hold && decision.confidence === 'exact',
);

decision = policy.observe(undefined);
check(
  'pending replacement may hold a proven exact basis',
  decision.hold && decision.confidence === 'held',
);

decision = policy.observe(failure);
check('one failed replacement abandons the mapped basis', !decision.hold && decision.confidence === 'continuous');

decision = policy.observe(undefined);
check(
  'a later pending request cannot resurrect an abandoned basis',
  !decision.hold && decision.confidence === 'continuous',
);

policy.record({ status: 'ok', pageStarts: [], pageCount: 1 });
decision = policy.observe(undefined);
check('a new exact success reopens the mapped hold path', decision.hold && decision.confidence === 'held');

policy.abandon();
decision = policy.observe(undefined);
check('explicit geometry invalidation remains abandoned while pending', !decision.hold);

console.log('\nall oracle coordinator tests passed');

// The oracles use browser timers in production; Node's timers are sufficient
// for these directly-driven lifecycle checks.
if (!('window' in globalThis)) {
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
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

async function checkParagraphGeneration() {
  const oldCompile = deferred<string | null>();
  const freshCompile = deferred<string | null>();
  const compiles = [oldCompile, freshCompile];
  let notifications = 0;
  const oracle = new TypstOracle(
    () => notifications++,
    [],
    () => compiles.shift()!.promise,
  );
  const spec: ParagraphSpec = { key: 'same', src: 'same', tokens: [], hasMath: false };
  oracle.request('same', spec, 400, DEFAULT_SETTINGS);
  const staleFlush = (oracle as unknown as { flush(): Promise<void> }).flush();
  oracle.clear();
  oracle.request('same', spec, 400, DEFAULT_SETTINGS);
  oldCompile.resolve(null);
  await staleFlush;
  check('paragraph clear rejects stale same-key completion', !oracle.get('same') && notifications === 0);

  const freshFlush = (oracle as unknown as { flush(): Promise<void> }).flush();
  freshCompile.resolve(null);
  await freshFlush;
  check('paragraph replacement generation publishes once', oracle.get('same')?.status === 'fail' && notifications === 1);
  oracle.destroy();
}

async function checkPageGeneration() {
  const oldCompile = deferred<string | null>();
  const freshCompile = deferred<string | null>();
  const compiles = [oldCompile, freshCompile];
  let notifications = 0;
  const oracle = new PageOracle(
    () => notifications++,
    () => compiles.shift()!.promise,
  );
  const doc = {} as PMNode;
  const resolveAtom = () => null;
  oracle.request('same', doc, DEFAULT_SETTINGS, resolveAtom);
  const staleFlush = (oracle as unknown as { flush(): Promise<void> }).flush();
  oracle.clear();
  oracle.request('same', doc, DEFAULT_SETTINGS, resolveAtom);
  oldCompile.resolve(null);
  await staleFlush;
  check('page clear rejects stale same-signature completion', !oracle.get('same') && notifications === 0);

  const freshFlush = (oracle as unknown as { flush(): Promise<void> }).flush();
  freshCompile.resolve(null);
  await freshFlush;
  check('page replacement generation publishes once', oracle.get('same')?.status === 'fail' && notifications === 1);
  oracle.destroy();
}

async function checkDestroyGeneration() {
  const paragraphCompile = deferred<string | null>();
  let paragraphNotifications = 0;
  const paragraph = new TypstOracle(() => paragraphNotifications++, [], () => paragraphCompile.promise);
  const spec: ParagraphSpec = { key: 'destroy', src: 'destroy', tokens: [], hasMath: false };
  paragraph.request('destroy', spec, 400, DEFAULT_SETTINGS);
  const paragraphFlush = (paragraph as unknown as { flush(): Promise<void> }).flush();
  paragraph.destroy();
  paragraphCompile.resolve(null);
  await paragraphFlush;

  const pageCompile = deferred<string | null>();
  let pageNotifications = 0;
  const page = new PageOracle(() => pageNotifications++, () => pageCompile.promise);
  page.request('destroy', {} as PMNode, DEFAULT_SETTINGS, () => null);
  const pageFlush = (page as unknown as { flush(): Promise<void> }).flush();
  page.destroy();
  pageCompile.resolve(null);
  await pageFlush;

  check(
    'destroy rejects both in-flight oracle completions',
    paragraphNotifications === 0 && !paragraph.get('destroy') && pageNotifications === 0 && !page.get('destroy'),
  );
}

async function checkCancelPendingKeepsCache() {
  const firstParagraph = deferred<string | null>();
  const staleParagraph = deferred<string | null>();
  const paragraphCompiles = [firstParagraph, staleParagraph];
  let paragraphNotifications = 0;
  const paragraph = new TypstOracle(
    () => paragraphNotifications++,
    [],
    () => paragraphCompiles.shift()!.promise,
  );
  const spec: ParagraphSpec = { key: 'cached', src: 'cached', tokens: [], hasMath: false };
  paragraph.request('cached', spec, 400, DEFAULT_SETTINGS);
  const firstParagraphFlush = (paragraph as unknown as { flush(): Promise<void> }).flush();
  firstParagraph.resolve(null);
  await firstParagraphFlush;
  paragraph.request('stale', { ...spec, key: 'stale' }, 400, DEFAULT_SETTINGS);
  const staleParagraphFlush = (paragraph as unknown as { flush(): Promise<void> }).flush();
  paragraph.cancelPending();
  staleParagraph.resolve(null);
  await staleParagraphFlush;

  const firstPage = deferred<string | null>();
  const stalePage = deferred<string | null>();
  const pageCompiles = [firstPage, stalePage];
  let pageNotifications = 0;
  const page = new PageOracle(
    () => pageNotifications++,
    () => pageCompiles.shift()!.promise,
  );
  const doc = {} as PMNode;
  page.request('cached', doc, DEFAULT_SETTINGS, () => null);
  const firstPageFlush = (page as unknown as { flush(): Promise<void> }).flush();
  firstPage.resolve(null);
  await firstPageFlush;
  page.request('stale', doc, DEFAULT_SETTINGS, () => null);
  const stalePageFlush = (page as unknown as { flush(): Promise<void> }).flush();
  page.cancelPending();
  stalePage.resolve(null);
  await stalePageFlush;

  check(
    'cancelPending rejects stale completions without discarding completed caches',
    paragraph.get('cached')?.status === 'fail' &&
      !paragraph.get('stale') &&
      paragraphNotifications === 1 &&
      page.get('cached')?.status === 'fail' &&
      !page.get('stale') &&
      pageNotifications === 1,
  );
  paragraph.destroy();
  page.destroy();
}

await checkParagraphGeneration();
await checkPageGeneration();
await checkDestroyGeneration();
await checkCancelPendingKeepsCache();

console.log('\nall oracle lifecycle tests passed');
