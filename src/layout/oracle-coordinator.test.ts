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
const failures: PageOracleEntry[] = Array.from({ length: 4 }, (_, i) => ({
  status: 'fail',
  reason: `failure ${i + 1}`,
}));

let decision = policy.observe(undefined);
check(
  'missing entry can hold',
  decision.hold && decision.confidence === 'held' && decision.failureStreak === 0 && decision.status === 'pending',
);

decision = policy.observe(failures[0]);
check('first failed entry can hold', decision.hold && decision.failureStreak === 1);
decision = policy.observe(failures[0]);
check('same failed entry increments once', decision.hold && decision.failureStreak === 1);

decision = policy.observe(failures[1]);
check('second distinct failed entry can hold', decision.hold && decision.failureStreak === 2);
decision = policy.observe(failures[2]);
check('third distinct failed entry can hold', decision.hold && decision.failureStreak === 3);
decision = policy.observe(failures[3]);
check(
  'fourth distinct failed entry abandons hold',
  !decision.hold && decision.confidence === 'fallback' && decision.failureStreak === 4,
);

decision = policy.observe(undefined);
check(
  'pending entry can hold after failure cutoff',
  decision.hold && decision.confidence === 'held' && decision.failureStreak === 4,
);

decision = policy.observe({ status: 'ok', pageStarts: [], pageCount: 1 });
check(
  'successful entry is exact rather than permission to hold older starts',
  !decision.hold && decision.confidence === 'exact' && decision.failureStreak === 0,
);

policy.record(failures[0]);
policy.record({ status: 'ok', pageStarts: [], pageCount: 1 });
decision = policy.observe(undefined);
check(
  'published success heals the streak before the recovery path reads it',
  decision.hold && decision.confidence === 'held' && decision.failureStreak === 0,
);

decision = policy.observe(failures[3]);
check('failure after success begins a new streak', decision.hold && decision.failureStreak === 1);

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

async function checkSuspend() {
  // Paragraph oracle: a request queued before sleep never launches, a
  // request made while asleep is dropped, and a compile already in flight
  // finishes into the cache (its answer is keyed by spec and measure, not
  // by editor geometry) — publication is the sleeping scheduler's problem.
  let compiles = 0;
  let notifications = 0;
  const paragraph = new TypstOracle(
    () => notifications++,
    [],
    () => {
      compiles++;
      return Promise.resolve(null);
    },
  );
  const spec: ParagraphSpec = { key: 'sleep', src: 'sleep', tokens: [], hasMath: false };
  paragraph.request('queued', spec, 400, DEFAULT_SETTINGS);
  paragraph.suspend();
  await (paragraph as unknown as { flush(): Promise<void> }).flush();
  paragraph.request('asleep', spec, 400, DEFAULT_SETTINGS);
  await (paragraph as unknown as { flush(): Promise<void> }).flush();
  check(
    'paragraph oracle launches nothing while suspended',
    compiles === 0 && paragraph.queue.size === 0 && !paragraph.get('queued') && !paragraph.get('asleep'),
  );
  paragraph.resume();
  paragraph.request('awake', spec, 400, DEFAULT_SETTINGS);
  await (paragraph as unknown as { flush(): Promise<void> }).flush();
  check('paragraph oracle compiles again after resume', compiles === 1 && paragraph.get('awake')?.status === 'fail');
  paragraph.destroy();

  const inflight = deferred<string | null>();
  let inflightNotifications = 0;
  const busy = new TypstOracle(() => inflightNotifications++, [], () => inflight.promise);
  busy.request('inflight', spec, 400, DEFAULT_SETTINGS);
  busy.request('later', { ...spec, key: 'later', src: 'later' }, 900, DEFAULT_SETTINGS);
  const busyFlush = (busy as unknown as { flush(): Promise<void> }).flush();
  busy.suspend();
  inflight.resolve(null);
  await busyFlush;
  check(
    'in-flight paragraph compile finishes into the cache without re-arming',
    busy.get('inflight')?.status === 'fail' && busy.queue.size === 0 && !busy.inflight && inflightNotifications === 1,
  );
  busy.destroy();

  // Page oracle: the pending request is dropped at sleep, requests while
  // asleep are refused, and the resumed pass's request compiles normally.
  let pageCompiles = 0;
  const page = new PageOracle(
    () => {},
    () => {
      pageCompiles++;
      return Promise.resolve(null);
    },
  );
  const doc = {} as PMNode;
  page.request('pending', doc, DEFAULT_SETTINGS, () => null);
  page.suspend();
  await (page as unknown as { flush(): Promise<void> }).flush();
  page.request('asleep', doc, DEFAULT_SETTINGS, () => null);
  await (page as unknown as { flush(): Promise<void> }).flush();
  check('page oracle launches nothing while suspended', pageCompiles === 0 && !page.get('pending') && !page.get('asleep'));
  page.resume();
  page.request('awake', doc, DEFAULT_SETTINGS, () => null);
  await (page as unknown as { flush(): Promise<void> }).flush();
  check('page oracle compiles again after resume', pageCompiles === 1 && page.get('awake')?.status === 'fail');
  page.destroy();
}

await checkParagraphGeneration();
await checkPageGeneration();
await checkDestroyGeneration();
await checkSuspend();

console.log('\nall oracle lifecycle tests passed');
