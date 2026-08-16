import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { contentSecurityPolicy } from '../src/security-policy';
import { TYPST_PACKAGE_POLICY } from '../src/typst-config';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Production security verification failed: ${message}`);
}

const dist = join(process.cwd(), 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const tags = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/gi)];
assert(tags.length === 1, 'index.html must contain exactly one CSP meta element');
const builtPolicy = tags[0][1].replaceAll('&#39;', "'").replaceAll('&amp;', '&');
assert(builtPolicy === contentSecurityPolicy(), 'built CSP differs from the production policy source');
assert((tags[0].index ?? Infinity) < html.indexOf('<script'), 'CSP must precede every script element');
assert(!builtPolicy.includes('ws:'), 'production CSP must not permit WebSockets');
assert(!builtPolicy.includes(" 'unsafe-eval'"), 'production CSP must not permit JavaScript eval');
assert(/<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/i.test(html), 'no-referrer meta policy is missing');

const workerName = readdirSync(join(dist, 'assets')).find((name) => /^typst-compiler\.worker-.*\.js$/.test(name));
assert(workerName, 'isolated Typst worker artifact is missing');
const worker = readFileSync(join(dist, 'assets', workerName), 'utf8');
assert(worker.includes(TYPST_PACKAGE_POLICY.url), 'worker does not contain the exact pinned package URL');
assert(worker.includes(TYPST_PACKAGE_POLICY.sha256), 'worker does not contain the pinned package digest');
assert(worker.includes('Dynamic JavaScript construction is disabled'), 'worker fail-closed Function shim is missing');

console.log('production security artifact verified');
