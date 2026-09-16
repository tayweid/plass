// Editorial comments: the file forms round-trip byte for byte through both
// formats, hostile payloads cannot escape their frames, and the print
// compile (islands: 'print') and the TeX export omit them without a trace.
// Run: npx tsx src/editor-comments.test.ts
import { schema } from './schema';
import { docToTyp } from './typ-serializer';
import { typToDoc } from './typ-parser';
import { mdToDoc } from './md-parser';
import { docToMd } from './md-serializer';
import { docToTex } from './tex-serializer';
import { commentToMd, commentToTyp, readMdComment, readTypComment } from './editor-comments-format';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const p = (text: string) => schema.nodes.paragraph.create(null, text ? [schema.text(text)] : []);
const note = (text: string) => schema.nodes.editor_comment.create(null, text ? [schema.text(text)] : []);
const docOf = (...blocks: ReturnType<typeof p>[]) => schema.nodes.doc.create(null, blocks);

const PAYLOADS = [
  '',
  'Could this open with the library scene?',
  'Two lines.\nGive the reader a place to stand first.',
  '\n',
  '  indented, trailing spaces   \n\n\tafter a blank line',
  '// /plass:comment\n// plass:comment\n// | nested framing',
  '--> closes an HTML comment? --- and -- and ---- and & and &amp; and &#45;',
  '<!-- plass:comment\n-->',
  "Quotes 'straight' and \"double\", a -- dash, ... and ~ tildes, *stars* _under_ `ticks` $x$ #set",
  '```\nfenced\n```',
];

// --- 1. frame helpers ---
for (const text of PAYLOADS) {
  const typ = commentToTyp(text);
  const lines = typ.split('\n');
  const back = readTypComment(lines, 0);
  check(`typ frame round-trips ${JSON.stringify(text).slice(0, 40)}`, back?.text === text && back.next === lines.length, JSON.stringify(back));
  const md = commentToMd(text);
  check(`md frame round-trips ${JSON.stringify(text).slice(0, 40)}`, readMdComment(md + '\n') === text, JSON.stringify(readMdComment(md + '\n')));
  check('md frame never holds -->', !md.slice('<!-- plass:comment'.length, -3).includes('-->'));
  check('typ frame is comment lines only', lines.every((l) => l.startsWith('//')));
}
check('typ frame: not an opener', readTypComment(['// plain remark'], 0) === null);
check('md frame: a plain comment is not a note', readMdComment('<!-- ED: not ours -->\n') === null);
check('md frame: a one-line tag is not a note', readMdComment('<!-- plass:comment -->\n') === null);
{
  // Malformed: a foreign line ends the frame there and stays visible.
  const lines = ['// plass:comment', '// | kept', '= Heading', '// /plass:comment'];
  const r = readTypComment(lines, 0);
  check('typ frame: malformed frame keeps its payload and stops', r?.text === 'kept' && r.next === 2);
  const r2 = readTypComment(['// plass:comment', '// | to the end'], 0);
  check('typ frame: unterminated frame ends at EOF', r2?.text === 'to the end' && r2.next === 2);
  const r3 = readTypComment(['// plass:comment', '// |', '// | x', '// /plass:comment'], 0);
  check('typ frame: a stripped empty payload line reads as empty', r3?.text === '\nx');
}

// --- 2. documents through both formats ---
for (const text of PAYLOADS) {
  const doc = docOf(note(text), p('One.'), note(text), p('Two.'), note(text));
  const typ = docToTyp(doc);
  const { doc: fromTyp, warnings } = typToDoc(typ);
  check(`typ document round-trips ${JSON.stringify(text).slice(0, 40)}`, JSON.stringify(fromTyp.content.toJSON()) === JSON.stringify(doc.content.toJSON()), typ);
  check('typ import warns nothing', warnings.length === 0, warnings.join('; '));
  check('typ re-export is identical', docToTyp(fromTyp) === typ);
  const md = docToMd(doc);
  const fromMd = mdToDoc(md).doc;
  check(`md document round-trips ${JSON.stringify(text).slice(0, 40)}`, JSON.stringify(fromMd.content.toJSON()) === JSON.stringify(doc.content.toJSON()), md + '\n---\n' + JSON.stringify(fromMd.content.toJSON()));
  check('md re-export is identical', docToMd(fromMd) === md);
}

// --- 3. export omits the note; the printed body equals the plain document's ---
{
  const withNotes = docOf(note('NOTE_LEAD'), p('One.'), note('NOTE_MID'), p('Two.'), p('Three.'), note('NOTE_TAIL'));
  const plain = docOf(p('One.'), p('Two.'), p('Three.'));
  check('print compile equals the comment-free document', docToTyp(withNotes, { islands: 'print' }) === docToTyp(plain, { islands: 'print' }), docToTyp(withNotes, { islands: 'print' }));
  check('print compile holds no note text', !/NOTE_/.test(docToTyp(withNotes, { islands: 'print' })));
  check('TeX export equals the comment-free document', docToTex(withNotes) === docToTex(plain));
  check('file export keeps the note', docToTyp(withNotes).includes('// | NOTE_MID'));
}

// --- 4. a plain `//` remark and a plain HTML comment keep today's meaning ---
{
  const { doc } = typToDoc('// a remark\n\nText.\n');
  check('typ: a plain remark is still dropped', doc.childCount === 1 && doc.firstChild!.type.name === 'paragraph');
  const md = mdToDoc('<!-- ED: keep -->\n\nText.\n').doc;
  check('md: a plain HTML comment is still an island', md.firstChild!.type.name === 'code_block' && md.firstChild!.attrs.params === 'md-raw');
}

// --- 5. a note directly after the settings header, and one that ends the file ---
{
  const src = docToTyp(docOf(note('first'), p('Body.'), note('last')));
  const { doc } = typToDoc(src);
  check('typ: a leading note survives the header pass', doc.firstChild!.type.name === 'editor_comment' && doc.firstChild!.textContent === 'first');
  check('typ: a trailing note survives', doc.lastChild!.type.name === 'editor_comment' && doc.lastChild!.textContent === 'last');
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('editor-comments: all checks passed');
