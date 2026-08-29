import type { Node as PMNode } from 'prosemirror-model';
import { DEFAULT_SETTINGS } from '../settings';
import {
  BlockLayoutCache,
  blockLayoutEntryBaseMatches,
  blockLayoutEntryMatches,
  blockLayoutSettingsKey,
  blockOracleKey,
  canReuseBlockLayoutEntry,
  forcedBreakSignature,
  type BlockLayoutCacheKey,
  type BlockLayoutEntry,
} from './block-layout';
import type { ForcedBreak } from './paragraph';

let failures = 0;
function check(name: string, condition: boolean) {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
}

const key: BlockLayoutCacheKey = {
  measure: 500,
  oracle: 'ok',
  key: 'paragraph',
  indent: 24,
  scale: 0.85,
};
const entry: BlockLayoutEntry = { ...key, lines: [] };

check(
  'cache tolerance includes the half-pixel boundaries',
  blockLayoutEntryMatches(entry, { ...key, measure: 500.5, indent: 24.5 }),
);
check('cache accepts sub-hundredth scale drift', blockLayoutEntryMatches(entry, { ...key, scale: 0.8599 }));
check(
  'cache rejects measure changes beyond half a pixel',
  !blockLayoutEntryMatches(entry, { ...key, measure: 500.5001 }),
);
check(
  'cache rejects scale changes beyond one hundredth',
  !blockLayoutEntryMatches(entry, { ...key, scale: 0.8601 }),
);
check(
  'cache rejects oracle state and content changes',
  !blockLayoutEntryMatches(entry, { ...key, oracle: 'fail' }) &&
    !blockLayoutEntryMatches(entry, { ...key, key: 'different' }),
);

check(
  'base cache matching ignores transient oracle status',
  blockLayoutEntryBaseMatches(entry, { ...key, oracle: 'fail' }),
);
check(
  'base cache matching preserves measure, key, indent, and scale tolerances',
  blockLayoutEntryBaseMatches(entry, { ...key, oracle: 'fail', measure: 500.5, indent: 24.5 }) &&
    !blockLayoutEntryBaseMatches(entry, { ...key, oracle: 'fail', measure: 500.5001 }) &&
    !blockLayoutEntryBaseMatches(entry, { ...key, oracle: 'fail', key: 'different' }) &&
    !blockLayoutEntryBaseMatches(entry, { ...key, oracle: 'fail', indent: 24.5001 }) &&
    !blockLayoutEntryBaseMatches(entry, { ...key, oracle: 'fail', scale: 0.8601 }),
);

const compiledBreaks: ForcedBreak[] = [
  { at: 12, hyphen: false },
  { at: 27, hyphen: true },
];
const matchingPortEntry: BlockLayoutEntry = {
  ...entry,
  oracle: 'none',
  authority: 'port',
  breakSignature: forcedBreakSignature(compiledBreaks),
};

check(
  'forced break signatures are stable, ordered, and distinguish break kind',
  forcedBreakSignature(compiledBreaks) === forcedBreakSignature(compiledBreaks.map((item) => ({ ...item }))) &&
    forcedBreakSignature([]) === 'v1:' &&
    forcedBreakSignature(compiledBreaks) !== forcedBreakSignature([...compiledBreaks].reverse()) &&
    forcedBreakSignature(compiledBreaks) !==
      forcedBreakSignature([
        { at: 12, hyphen: true },
        { at: 27, hyphen: true },
      ]),
);
check(
  'matching compiled breaks reuse a live port layout across status change',
  canReuseBlockLayoutEntry(matchingPortEntry, { ...key, oracle: 'ok' }, compiledBreaks),
);
check(
  'different compiled breaks supersede a live port layout',
  !canReuseBlockLayoutEntry(matchingPortEntry, { ...key, oracle: 'ok' }, [
    { at: 12, hyphen: false },
    { at: 28, hyphen: true },
  ]),
);
check(
  'missing, pending, or failed compiled results do not invalidate stable layout',
  canReuseBlockLayoutEntry(matchingPortEntry, { ...key, oracle: 'none' }) &&
    canReuseBlockLayoutEntry(matchingPortEntry, { ...key, oracle: 'fail' }, null),
);
check(
  'compiled comparison fails closed for legacy and fallback entries',
  !canReuseBlockLayoutEntry(entry, { ...key, oracle: 'ok' }, compiledBreaks) &&
    !canReuseBlockLayoutEntry(
      { ...matchingPortEntry, authority: 'fallback' },
      { ...key, oracle: 'ok' },
      compiledBreaks,
    ),
);
check(
  'semantic reuse still rejects stable input drift',
  !canReuseBlockLayoutEntry(matchingPortEntry, { ...key, measure: 500.5001 }, compiledBreaks) &&
    !canReuseBlockLayoutEntry(matchingPortEntry, { ...key, indent: 24.5001 }, compiledBreaks) &&
    !canReuseBlockLayoutEntry(matchingPortEntry, { ...key, scale: 0.8601 }, compiledBreaks),
);

const node = {} as PMNode;
const cache = new BlockLayoutCache();
cache.set(node, entry);
check('cache returns a matching persistent node', cache.getMatching(node, key) === entry);
cache.set(node, matchingPortEntry);
check(
  'cache wrapper exposes semantic reusable lookup',
  cache.getReusable(node, { ...key, oracle: 'ok' }, compiledBreaks) === matchingPortEntry &&
    cache.getReusable(node, { ...key, oracle: 'ok' }, [{ at: 13, hyphen: false }]) === undefined,
);
cache.clear();
check('cache clear invalidates persistent nodes', cache.get(node) === undefined);

const canonical = blockLayoutSettingsKey(DEFAULT_SETTINGS);
const legacy = blockLayoutSettingsKey({ ...DEFAULT_SETTINGS, font: 'Georgia' });
check('unsupported stored fonts share the effective layout key', canonical === legacy);
check(
  'oracle key preserves the established measure precision',
  blockOracleKey(canonical, 'pi', 499.96, 'text') === `${canonical}|pi|w500.0|text`,
);

if (failures) process.exit(1);
console.log('\nall block layout contract tests passed');
