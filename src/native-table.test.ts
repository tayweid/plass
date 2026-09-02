// Native structured-table regressions. Run with:
//   node --import tsx src/native-table.test.ts
import { setBlockType } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { TableMap, goToNextCell, tableEditing } from 'prosemirror-tables';
import {
  CellSelection,
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  mergeCells,
  splitCell,
  structuredTablePlugin,
  toggleHeaderRow,
} from './table-editor.ts';
import { schema } from './schema.ts';
import { docToTyp } from './typ-serializer.ts';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n${detail}` : ''}`);
  }
}

const bib = '@book{knuth86, title={The TeXbook}, author={Knuth, Donald E.}, year={1986}}';
const { doc: docType, table, table_row, table_cell, table_header, paragraph } = schema.nodes;
const richCell = table_cell.create(null, [
  paragraph.create(null, [
    schema.text('Marked', [schema.marks.strong.create()]),
    schema.text(' math '),
    schema.nodes.math_inline.create({ src: 'x^2' }),
    schema.text(' cite '),
    schema.nodes.citation.create({ key: 'knuth86' }),
  ]),
  paragraph.create(null, schema.text('Second paragraph', [schema.marks.em.create()])),
]);
const plainCell = (text: string, header = false) => (header ? table_header : table_cell).create(
  null,
  paragraph.create(null, text ? schema.text(text) : undefined),
);
const fixtureTable = table.create(
  { style: 'booktabs', caption: 'Structured results', label: 'tab:structured' },
  [
    table_row.create(null, [richCell, plainCell('B')]),
    table_row.create(null, [plainCell('C'), plainCell('D')]),
  ],
);

function makeState(): EditorState {
  return EditorState.create({
    doc: docType.create({ bib: { name: 'refs.bib', content: bib } }, [fixtureTable]),
    plugins: [history(), structuredTablePlugin(), tableEditing()],
  });
}

function firstTable(state: EditorState): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null;
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'table') {
      found = { node, pos };
      return false;
    }
    return !found;
  });
  if (!found) throw new Error('table fixture disappeared');
  return found;
}

function cellPos(state: EditorState, index: number): number {
  const found = firstTable(state);
  return found.pos + 1 + TableMap.get(found.node).map[index];
}

function selectedCellPos(state: EditorState): number {
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const role = $from.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') return $from.before(depth);
  }
  return -1;
}

function hasInline(node: PMNode, type: string): boolean {
  let found = false;
  node.descendants((child) => {
    if (child.type.name === type) found = true;
    return !found;
  });
  return found;
}

// Direct character editing is a normal PM transaction. Only the intended
// text changes; marks, inline atoms, and the second paragraph remain.
{
  let state = makeState();
  const dispatch = (tr: Parameters<EditorState['apply']>[0]) => { state = state.apply(tr); };
  const insertion = cellPos(state, 0) + 2 + 'Marked'.length;
  dispatch(state.tr.insertText('!', insertion));
  const edited = firstTable(state).node.child(0).child(0);
  check('one-character edit reaches the native rich cell', edited.textContent.startsWith('Marked! math'));
  check('strong mark survives direct editing', edited.child(0).child(0).marks.some((mark) => mark.type.name === 'strong'));
  check('inline math survives direct editing', hasInline(edited, 'math_inline'));
  check('citation survives direct editing', hasInline(edited, 'citation'));
  check('paragraph boundary survives direct editing', edited.childCount === 2 && edited.child(1).textContent === 'Second paragraph');
  check('edited table still exports through the lossless path', docToTyp(state.doc).includes('Marked!'));

  check('undo handles a native cell edit', undo(state, dispatch));
  check('undo restores the rich cell exactly', JSON.stringify(firstTable(state).node.child(0).child(0).toJSON()) === JSON.stringify(richCell.toJSON()));
  check('redo handles a native cell edit', redo(state, dispatch));
  check('redo restores only the intended text edit', firstTable(state).node.child(0).child(0).textContent.startsWith('Marked! math'));
}

// A legacy table may contain a schema-valid block that today's structured
// editor deliberately refuses to create. Deleting it is allowed, and undo
// must restore the exact historical content instead of being filtered.
{
  const legacyList = schema.nodes.bullet_list.create(null, [
    schema.nodes.list_item.create(null, [paragraph.create(null, schema.text('Legacy list'))]),
  ]);
  const legacyTable = table.create(null, [
    table_row.create(null, [table_cell.create(null, [legacyList])]),
  ]);
  let state = EditorState.create({
    doc: docType.create(null, [legacyTable, paragraph.create(null, schema.text('After'))]),
    plugins: [history(), structuredTablePlugin(), tableEditing()],
  });
  const dispatch = (tr: Parameters<EditorState['apply']>[0]) => { state = state.apply(tr); };
  dispatch(state.tr.setSelection(NodeSelection.create(state.doc, 0)).deleteSelection());
  check('unsupported legacy table can be deleted', state.doc.firstChild?.type.name === 'paragraph');
  check('undo accepts restoration of an unsupported legacy table', undo(state, dispatch));
  check(
    'undo restores unsupported legacy table byte-for-byte',
    JSON.stringify(state.doc.firstChild?.toJSON()) === JSON.stringify(legacyTable.toJSON()),
  );
}

// Tab navigation uses table topology without creating a modal editor or a
// second cell-selection state.
{
  let state = makeState();
  const dispatch = (tr: Parameters<EditorState['apply']>[0]) => { state = state.apply(tr); };
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, cellPos(state, 0) + 2)));
  check('Tab command is available in a cell', goToNextCell(1)(state, dispatch));
  check('Tab moves to the next semantic cell', selectedCellPos(state) === cellPos(state, 1));
  check('Shift-Tab command is available in a cell', goToNextCell(-1)(state, dispatch));
  check('Shift-Tab returns to the previous cell', selectedCellPos(state) === cellPos(state, 0));
}

// Row/column operations transform the table tree and leave existing rich
// content byte-for-byte intact.
{
  let state = makeState();
  const dispatch = (tr: Parameters<EditorState['apply']>[0]) => { state = state.apply(tr); };
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, cellPos(state, 0) + 2)));
  check('add row command runs natively', addRowAfter(state, dispatch));
  check('row command changes table structure', firstTable(state).node.childCount === 3);
  check('add column command runs natively', addColumnAfter(state, dispatch));
  check('column command changes table structure', TableMap.get(firstTable(state).node).width === 3);
  check('structure mutations preserve rich cell JSON', JSON.stringify(firstTable(state).node.child(0).child(0).toJSON()) === JSON.stringify(richCell.toJSON()));
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, cellPos(state, 3) + 2)));
  check('header-row command runs natively', toggleHeaderRow(state, dispatch));
  check('header-row command changes cell node types', firstTable(state).node.child(1).child(0).type.name === 'table_header');
  check('mutated table remains losslessly exportable', docToTyp(state.doc).includes('Second paragraph'));
}

// Deleting an unneeded row/column leaves surviving rich cells untouched.
{
  let state = makeState();
  const dispatch = (tr: Parameters<EditorState['apply']>[0]) => { state = state.apply(tr); };
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, cellPos(state, 2) + 2)));
  check('delete row command runs natively', deleteRow(state, dispatch));
  check('delete row updates table structure', firstTable(state).node.childCount === 1);
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, cellPos(state, 1) + 2)));
  check('delete column command runs natively', deleteColumn(state, dispatch));
  check('delete column updates table structure', TableMap.get(firstTable(state).node).width === 1);
  check('deletions preserve surviving rich cell JSON', JSON.stringify(firstTable(state).node.child(0).child(0).toJSON()) === JSON.stringify(richCell.toJSON()));
}

// Merge/split use CellSelection and retain every rich inline node and
// paragraph; no string-grid flattening is involved.
{
  let state = makeState();
  const dispatch = (tr: Parameters<EditorState['apply']>[0]) => { state = state.apply(tr); };
  const anchor = state.doc.resolve(cellPos(state, 0));
  const head = state.doc.resolve(cellPos(state, 1));
  dispatch(state.tr.setSelection(new CellSelection(anchor, head)));
  check('merge command accepts a rectangular cell selection', mergeCells(state, dispatch));
  const merged = firstTable(state).node.child(0).child(0);
  check('merge retains the rich cell atoms', hasInline(merged, 'math_inline') && hasInline(merged, 'citation'));
  check('merge retains rich paragraph boundaries', merged.childCount >= 3);
  check('split command restores table topology', splitCell(state, dispatch));
  check('split restores two columns', TableMap.get(firstTable(state).node).width === 2);
  check('split retains the rich cell atoms', hasInline(firstTable(state).node.child(0).child(0), 'math_inline'));
}

// Schema-valid but serializer-unsupported cell structures are blocked at the
// transaction boundary. The prior document is untouched rather than being
// flattened or becoming an export-time surprise.
{
  let state = makeState();
  const dispatch = (tr: Parameters<EditorState['apply']>[0]) => { state = state.apply(tr); };
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, cellPos(state, 0) + 2)));
  const before = JSON.stringify(state.doc.toJSON());
  const commandAccepted = setBlockType(schema.nodes.code_block)(state, dispatch);
  check('unsupported block command produces a transaction', commandAccepted);
  check('unsupported cell edit is explicitly rejected without document loss', JSON.stringify(state.doc.toJSON()) === before);
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall native-table tests passed');
}
