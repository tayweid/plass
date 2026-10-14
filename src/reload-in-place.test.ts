// A reload from disk put in place (reload-in-place.ts): only what changed is
// replaced, the caret maps through it, the result is exactly the file's
// document, a document attribute is set only when its value changed, the
// reload is one undo step that ⌘Z takes back, and it carries the meta that
// keeps it out of the dirty flag. An unchanged file is no transaction.
// Run: npx tsx src/reload-in-place.test.ts
import { history, undo } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';
import { FROM_DISK, reloadTransaction } from './reload-in-place';
import { typToDoc } from './typ-parser';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const parse = (text: string): PMNode => typToDoc(text).doc;
/** An editor on `text` with the caret just after the first `at` in it. */
function editorAt(text: string, at: string): EditorState {
  const doc = parse(text);
  let pos = -1;
  doc.descendants((node, offset) => {
    if (pos >= 0 || !node.isText) return pos < 0;
    const i = node.text!.indexOf(at);
    if (i >= 0) pos = offset + i + at.length;
    return false;
  });
  if (pos < 0) throw new Error(`no "${at}" in the document`);
  const state = EditorState.create({ doc, plugins: [history()] });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, pos)));
}
/** The text before the caret, within its block. */
const beforeCaret = (state: EditorState) => {
  const { $head } = state.selection;
  return $head.parent.textBetween(0, $head.parentOffset);
};
const replaced = (tr: Transaction) =>
  tr.steps.filter((step): step is ReplaceStep => step instanceof ReplaceStep).map((step) => ({ from: step.from, to: step.to }));

const base = '= Notes\n\nThe first paragraph stays as it was.\n\nThe second paragraph is where the caret sits.\n\nThe third paragraph goes away.\n';

console.log('reloadTransaction');

{
  const state = editorAt(base, 'where the caret');
  check('an unchanged file: no transaction', reloadTransaction(state, parse(base)) === null);
}

{
  const state = editorAt(base, 'where the caret');
  const file = parse(base.replace('The third paragraph goes away.\n', 'A new third paragraph.\n'));
  const tr = reloadTransaction(state, file)!;
  const next = state.apply(tr);
  check('the result is the file’s document', next.doc.eq(file));
  const firstEnd = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize + state.doc.child(2).nodeSize;
  check('only the changed block is replaced, past the caret’s', replaced(tr).length === 1 && replaced(tr)[0].from >= firstEnd, JSON.stringify(replaced(tr)));
  check('the caret stays where it was', beforeCaret(next) === 'The second paragraph is where the caret', beforeCaret(next));
  check('the meta that keeps it out of the dirty flag', tr.getMeta(FROM_DISK) === true);
}

{
  // A change above the caret: the caret moves with its text.
  const state = editorAt(base, 'where the caret');
  const file = parse(base.replace('The first paragraph stays as it was.', 'The first paragraph, rewritten at more length than before.'));
  const next = state.apply(reloadTransaction(state, file)!);
  check('a change above: the caret keeps its place in its own text', next.doc.eq(file) && beforeCaret(next) === 'The second paragraph is where the caret', beforeCaret(next));
}

{
  // The caret's own text rewound away: it lands at the change, not at the top.
  const state = editorAt(base, 'where the caret');
  const file = parse(base.replace('The second paragraph is where the caret sits.\n\n', ''));
  const next = state.apply(reloadTransaction(state, file)!);
  check('the caret’s block gone: the caret stays near, not at the start', next.doc.eq(file) && next.selection.head > state.doc.child(0).nodeSize + 2, String(next.selection.head));
}

{
  // Repeated text puts the diff's end before its start.
  const state = editorAt('Ha ha.\n', 'Ha');
  const file = parse('Ha ha ha.\n');
  const next = state.apply(reloadTransaction(state, file)!);
  check('repeated text ("ha ha" to "ha ha ha"): exactly the file', next.doc.eq(file), next.doc.textContent);
}

{
  // A change inside a table cell, nested structure.
  const table = (cell: string) => `#table(columns: 2, [a], [${cell}], [c], [d])\n\nAfter the table.\n`;
  const state = editorAt(table('b'), 'After the');
  const file = parse(table('bee'));
  const tr = reloadTransaction(state, file);
  const next = tr ? state.apply(tr) : state;
  check('a change in a table cell: exactly the file', !!tr && next.doc.eq(file));
  check('and the caret after the table stays', beforeCaret(next) === 'After the', beforeCaret(next));
}

{
  // The settings (a document attribute) change: set once; unchanged ones are left.
  const state = editorAt(base, 'where the caret');
  const smaller = parse(`#set text(size: 10pt)\n\n${base}`);
  if (JSON.stringify(smaller.attrs.settings) === JSON.stringify(state.doc.attrs.settings)) {
    check('the size setting parses to a different settings attribute', false, 'the test text does not change the settings');
  } else {
    const tr = reloadTransaction(state, smaller)!;
    const next = state.apply(tr);
    check('a changed setting: the file’s settings', next.doc.eq(smaller) && JSON.stringify(next.doc.attrs.settings) === JSON.stringify(smaller.attrs.settings));
    check('and the text is left alone', replaced(tr).length === 0, JSON.stringify(replaced(tr)));
  }
  const same = parse(base.replace('goes away', 'went away'));
  const tr = reloadTransaction(state, same)!;
  check('settings with the same values (a new object): not set again', tr.steps.every((step) => step instanceof ReplaceStep), tr.steps.map((s) => s.constructor.name).join());
}

{
  // One undo step: ⌘Z after the reload puts the document back as it was.
  let state = editorAt(base, 'where the caret');
  state = state.apply(state.tr.insertText(' Typed.', state.selection.head));
  const typed = state.doc;
  const file = parse(base.replace('The third paragraph goes away.\n', 'A new third paragraph.\n'));
  state = state.apply(reloadTransaction(state, file)!);
  let undone: EditorState | null = null;
  undo(state, (tr) => {
    undone = state.apply(tr);
  });
  check('⌘Z after the reload: the document before it, typing kept', !!undone && (undone as EditorState).doc.eq(typed));
}

if (failures) {
  console.error(`\n${failures} reload-in-place test(s) failed`);
  process.exit(1);
}
console.log('\nall reload-in-place tests passed');
