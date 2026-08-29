// The printed-form normalizer: collapsing and dash substitution must behave
// exactly as if the whole document were rescanned, while actually visiting
// only the blocks an edit touched.
// Run: npx tsx src/collapse-spaces.test.ts
import { EditorState } from 'prosemirror-state';
import { Fragment } from 'prosemirror-model';
import { schema } from './schema';
import { collapseSpaces } from './collapse-spaces';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const state = (...paras: ReturnType<typeof p>[]) =>
  EditorState.create({ doc: schema.nodes.doc.create(null, paras), plugins: [collapseSpaces()] });

console.log('collapse-spaces:');

{
  // Typing a second space collapses the run to one plain space.
  const s = state(p('a b'));
  const after = s.apply(s.tr.insertText(' ', 3));
  check('typed double space collapses', after.doc.firstChild!.textContent === 'a b', JSON.stringify(after.doc.firstChild!.textContent));
}

{
  // Dash shorthands normalize as they are typed: -- en, then em, and a
  // whitespace-preceded hyphen before a digit becomes a minus sign.
  const s1 = state(p('x -'));
  const en = s1.apply(s1.tr.insertText('-', 4));
  check('-- becomes en dash', en.doc.firstChild!.textContent === 'x –', JSON.stringify(en.doc.firstChild!.textContent));
  const em = en.apply(en.tr.insertText('-', 4));
  check('en dash + - becomes em dash', em.doc.firstChild!.textContent === 'x —', JSON.stringify(em.doc.firstChild!.textContent));
  const s2 = state(p('x -'));
  const minus = s2.apply(s2.tr.insertText('5', 4));
  check('space-hyphen-digit becomes minus', minus.doc.firstChild!.textContent === 'x −5', JSON.stringify(minus.doc.firstChild!.textContent));
}

{
  // A paste inserting several blocks mid-document normalizes ALL pasted
  // blocks, not just the one holding the selection.
  const s = state(p('start'), p('end'));
  const pasted = Fragment.fromArray([p('c  d'), p('e -- f')]);
  const after = s.apply(s.tr.insert(7, pasted));
  check('pasted block 1 normalized', after.doc.child(1).textContent === 'c d', JSON.stringify(after.doc.child(1).textContent));
  check('pasted block 2 normalized', after.doc.child(2).textContent === 'e – f', JSON.stringify(after.doc.child(2).textContent));
}

{
  // The scan is scoped to the edited ranges: a block the edit never touched
  // is not rescanned (its content is already normalized by whichever
  // transaction wrote it — here it is seeded directly to prove the scope).
  const s = state(p('hello'), p('x  y'));
  const after = s.apply(s.tr.insertText('!', 6));
  check('edited block updated', after.doc.child(0).textContent === 'hello!', JSON.stringify(after.doc.child(0).textContent));
  check('untouched block not rescanned', after.doc.child(1).textContent === 'x  y', JSON.stringify(after.doc.child(1).textContent));
}

{
  // A run of PURE non-breaking spaces is intentional and survives an edit
  // in the same block.
  const s = state(p('a\u00a0\u00a0b'));
  const after = s.apply(s.tr.insertText('x', 5));
  check('pure nbsp run preserved', after.doc.firstChild!.textContent === 'a\u00a0\u00a0bx', JSON.stringify(after.doc.firstChild!.textContent));
  // ...but a run polluted with a plain space collapses to one plain space.
  const s2 = state(p('a b'));
  const after2 = s2.apply(s2.tr.insertText('\u00a0', 3));
  check('mixed space+nbsp run collapses', after2.doc.firstChild!.textContent === 'a b', JSON.stringify(after2.doc.firstChild!.textContent));
}

{
  // Code-marked text keeps its spaces even when its block is edited.
  const code = schema.nodes.paragraph.create(null, [
    schema.text('cmd  --flag', [schema.marks.code.create()]),
    schema.text(' tail'),
  ]);
  const s = EditorState.create({ doc: schema.nodes.doc.create(null, [code]), plugins: [collapseSpaces()] });
  const after = s.apply(s.tr.insertText('!', code.nodeSize - 1));
  check('code-marked text untouched', after.doc.firstChild!.textContent === 'cmd  --flag tail!', JSON.stringify(after.doc.firstChild!.textContent));
}

{
  // Deleting a block boundary rescans the merged block: "a " + " b" joins
  // into "a  b", which must collapse.
  const s = state(p('a '), p(' b'));
  // Delete the boundary between the two paragraphs (positions 3..5).
  const after = s.apply(s.tr.delete(3, 5));
  check('merge across blocks collapses', after.doc.firstChild!.textContent === 'a b', JSON.stringify(after.doc.firstChild!.textContent));
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all passed');
