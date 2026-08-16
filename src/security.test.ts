import { isPortableCitationKey, parseBibTeX } from './bibtex';
import { schema } from './schema';
import { docToTyp } from './typ-serializer';
import { isRemoteSource, remoteImageStatus } from './remote-images';

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log('  ok ', name);
  else {
    console.error(' FAIL', name);
    failed++;
  }
}

console.log('security boundaries');

check('ordinary citation key accepted', isPortableCitationKey('smith-2026:paper.v2'));
check('HTML citation key rejected', !isPortableCitationKey('<img/src=x/onerror=alert(1)>'));
check('whitespace citation key rejected', !isPortableCitationKey('smith 2026'));
check('empty citation key rejected', !isPortableCitationKey(''));
check('overlong citation key rejected', !isPortableCitationKey('a'.repeat(129)));

const hostileBib = '@article{<img/src=x/onerror=alert(1)>, title={Preserved}}';
const hostileEntry = parseBibTeX(hostileBib)[0];
check('non-portable bibliography entry is preserved', hostileEntry?.key === '<img/src=x/onerror=alert(1)>');
check('non-portable bibliography entry remains unavailable for citation', !isPortableCitationKey(hostileEntry?.key ?? ''));

const badKey = '<img/src=x/onerror=alert(1)>';
const doc = schema.nodes.doc.create(null, [
  schema.nodes.paragraph.create(null, [schema.nodes.citation.create({ key: badKey })]),
]);
const typ = docToTyp(doc);
check('invalid stored citation is escaped as visible Typst text', typ.includes('\\@\\<img/src=x/onerror=alert(1)\\>'));
check('invalid stored citation is never emitted as active @key syntax', !typ.includes(`\n@${badKey}`));

check('HTTPS image URL is recognized as remote', isRemoteSource('https://images.example/paper.png'));
check('project image path is not treated as remote', !isRemoteSource('figures/paper.png'));
check(
  'remote image needs explicit permission by default',
  remoteImageStatus('https://images.example/paper.png')?.allowed === false,
);
check(
  'insecure remote image is rejected',
  remoteImageStatus('http://images.example/paper.png')?.reason === 'Remote images must use HTTPS',
);
check(
  'loopback image target is rejected',
  remoteImageStatus('https://127.0.0.1/paper.png')?.reason === 'Local and private-network image hosts are blocked',
);
check(
  'credential-bearing image URL is rejected',
  remoteImageStatus('https://user:secret@images.example/paper.png')?.reason ===
    'Remote image URLs cannot contain credentials',
);

if (failed) {
  console.error(`\n${failed} security test(s) failed`);
  process.exit(1);
}
console.log('\nall security boundary tests passed');
