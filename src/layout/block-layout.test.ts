import type { Node as PMNode } from 'prosemirror-model';
import { DEFAULT_SETTINGS } from '../settings';
import {
  BlockLayoutCache,
  blockLayoutEntryBaseMatches,
  blockLayoutSettingsKey,
  blockOracleKey,
  canReuseBlockLayoutEntry,
  forcedBreakSignature,
  lineBreakSignature,
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
  key: 'paragraph',
  indent: 24,
  scale: 0.85,
};
const entry: BlockLayoutEntry = { ...key, lines: [] };

check(
  'cache tolerance includes the half-pixel boundaries',
  blockLayoutEntryBaseMatches(entry, { ...key, measure: 500.5, indent: 24.5 }),
);
check('cache accepts sub-hundredth scale drift', blockLayoutEntryBaseMatches(entry, { ...key, scale: 0.8599 }));
check(
  'cache rejects measure, indent, and scale changes beyond tolerance',
  !blockLayoutEntryBaseMatches(entry, { ...key, measure: 500.5001 }) &&
    !blockLayoutEntryBaseMatches(entry, { ...key, indent: 24.5001 }) &&
    !blockLayoutEntryBaseMatches(entry, { ...key, scale: 0.8601 }),
);
check('cache rejects content key changes', !blockLayoutEntryBaseMatches(entry, { ...key, key: 'different' }));

const breaks: ForcedBreak[] = [
  { at: 12, hyphen: false },
  { at: 27, hyphen: true },
];
const portEntry: BlockLayoutEntry = { ...entry, authority: 'port', breakSignature: forcedBreakSignature(breaks) };

check(
  'forced break signatures are stable, ordered, and distinguish break kind',
  forcedBreakSignature(breaks) === forcedBreakSignature(breaks.map((item) => ({ ...item }))) &&
    forcedBreakSignature([]) === 'v1:' &&
    forcedBreakSignature(breaks) !== forcedBreakSignature([...breaks].reverse()) &&
    forcedBreakSignature(breaks) !==
      forcedBreakSignature([
        { at: 12, hyphen: true },
        { at: 27, hyphen: true },
      ]),
);
check(
  'lineBreakSignature derives the forced-equivalent signature from lines',
  lineBreakSignature([
    { from: 0, to: 11, spacing: 1, breakPos: 13, hyphen: false, oracleBreak: { at: 12, hyphen: false } },
    { from: 13, to: 30, spacing: 0.5, breakPos: 27, hyphen: true, oracleBreak: { at: 27, hyphen: true } },
    { from: 27, to: 40, spacing: 0, breakPos: null, hyphen: false },
  ]) === forcedBreakSignature(breaks) && lineBreakSignature([]) === forcedBreakSignature([]),
);
check(
  'reuse follows the stable inputs alone',
  canReuseBlockLayoutEntry(portEntry, key) &&
    !canReuseBlockLayoutEntry(portEntry, { ...key, measure: 500.5001 }) &&
    !canReuseBlockLayoutEntry(portEntry, { ...key, indent: 24.5001 }) &&
    !canReuseBlockLayoutEntry(portEntry, { ...key, scale: 0.8601 }),
);

const node = {} as PMNode;
const cache = new BlockLayoutCache();
cache.set(node, portEntry);
check(
  'cache wrapper exposes the reusable lookup',
  cache.getReusable(node, key) === portEntry && cache.getReusable(node, { ...key, key: 'other' }) === undefined,
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
