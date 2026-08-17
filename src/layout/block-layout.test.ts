import type { Node as PMNode } from 'prosemirror-model';
import { DEFAULT_SETTINGS } from '../settings';
import {
  BlockLayoutCache,
  blockLayoutEntryMatches,
  blockLayoutSettingsKey,
  blockOracleKey,
  type BlockLayoutCacheKey,
  type BlockLayoutEntry,
} from './block-layout';

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

const node = {} as PMNode;
const cache = new BlockLayoutCache();
cache.set(node, entry);
check('cache returns a matching persistent node', cache.getMatching(node, key) === entry);
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
