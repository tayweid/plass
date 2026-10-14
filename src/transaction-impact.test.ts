import assert from 'node:assert/strict';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { TableMap, addRowAfter, toggleHeaderRow } from 'prosemirror-tables';
import { schema } from './schema';
import { eqKey, equationsPlugin } from './equations';
import {
  transactionChangesDerivedStructure,
  transactionTouchesNodeTypes,
  type DerivedStructureRules,
} from './transaction-impact';

const numbering = new Set(['heading', 'math_display', 'figure', 'table', 'footnote', 'eq_ref']);
const citations = new Set(['citation', 'bibliography']);

const paragraph = schema.nodes.paragraph.create(null, schema.text('ordinary prose'));
let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [paragraph]) });
let tr = state.tr.insertText('clear ', 1);
assert.equal(transactionTouchesNodeTypes(tr, numbering), false);
assert.equal(transactionTouchesNodeTypes(tr, citations), false);
console.log('  ok  ordinary prose edits map derived decorations without a document scan');

const heading = schema.nodes.heading.create({ level: 1 }, schema.text('Heading'));
state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [heading, paragraph]) });
tr = state.tr.insertText('New ', 1);
assert.equal(transactionTouchesNodeTypes(tr, numbering), true);
console.log('  ok  edits inside numbered structural nodes invalidate numbering');

const citation = schema.nodes.citation.create({ key: 'doe2026' });
const citedParagraph = schema.nodes.paragraph.create(null, [schema.text('See '), citation]);
state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [citedParagraph]) });
tr = state.tr.delete(5, 6);
assert.equal(transactionTouchesNodeTypes(tr, citations), true);
console.log('  ok  deleting a citation invalidates citation order');

const figure = schema.nodes.figure.create(
  { src: '', label: '', name: '' },
  schema.text('A caption'),
);
state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [paragraph]) });
tr = state.tr.insert(state.doc.content.size, figure);
assert.equal(transactionTouchesNodeTypes(tr, numbering), true);
console.log('  ok  inserted numbered nodes invalidate numbering');

const numberingStructure: DerivedStructureRules = {
  heading: { attrs: ['level', 'label'] },
  math_display: { attrs: ['label', 'numbered'] },
  figure: { attrs: ['label'] },
  table: {
    attrs: ['label'],
    attrPresence: ['caption'],
    structure: {
      table_row: [],
      table_cell: ['colspan', 'rowspan', 'colwidth', 'align'],
      table_header: ['colspan', 'rowspan', 'colwidth', 'align'],
    },
  },
  footnote: {},
  eq_ref: { attrs: ['label'] },
};

const tableCell = (text: string) => schema.nodes.table_cell.create(
  null,
  schema.nodes.paragraph.create(null, schema.text(text)),
);
const fixtureTable = schema.nodes.table.create(
  { style: 'booktabs', caption: 'Results', label: 'tab:results' },
  [
    schema.nodes.table_row.create(null, [tableCell('A'), tableCell('B')]),
    schema.nodes.table_row.create(null, [tableCell('C'), tableCell('D')]),
  ],
);
const tableDoc = schema.nodes.doc.create(null, [fixtureTable]);
const firstCell = 1 + TableMap.get(fixtureTable).map[0];

state = EditorState.create({ schema, doc: tableDoc });
tr = state.tr.insertText('x', firstCell + 2);
assert.equal(transactionChangesDerivedStructure(tr, numberingStructure), false);
console.log('  ok  table cell text does not invalidate derived numbering structure');

tr = state.tr.setNodeMarkup(0, undefined, { ...fixtureTable.attrs, caption: 'Edited results' });
assert.equal(transactionChangesDerivedStructure(tr, numberingStructure), false);
console.log('  ok  table caption text maps numbering decorations');

tr = state.tr.setNodeMarkup(0, undefined, { ...fixtureTable.attrs, caption: '' });
assert.equal(transactionChangesDerivedStructure(tr, numberingStructure), true);
console.log('  ok  removing a table caption invalidates numbering presence');

const uncaptionedTable = fixtureTable.type.create(
  { ...fixtureTable.attrs, caption: '', label: '' },
  fixtureTable.content,
);
const uncaptionedState = EditorState.create({
  schema,
  doc: schema.nodes.doc.create(null, [uncaptionedTable]),
});
tr = uncaptionedState.tr.setNodeMarkup(0, undefined, { ...uncaptionedTable.attrs, caption: 'Now numbered' });
assert.equal(transactionChangesDerivedStructure(tr, numberingStructure), true);
console.log('  ok  adding a table caption invalidates numbering presence');

tr = state.tr.setNodeMarkup(0, undefined, { ...fixtureTable.attrs, label: 'tab:renamed' });
assert.equal(transactionChangesDerivedStructure(tr, numberingStructure), true);
console.log('  ok  table label changes invalidate reference targets');

tr = state.tr.delete(0, fixtureTable.nodeSize);
assert.equal(transactionChangesDerivedStructure(tr, numberingStructure), true);
console.log('  ok  table deletion invalidates numbering structure');

const proseState = EditorState.create({
  schema,
  doc: schema.nodes.doc.create(null, [paragraph]),
});
tr = proseState.tr.insert(proseState.doc.content.size, fixtureTable);
assert.equal(transactionChangesDerivedStructure(tr, numberingStructure), true);
console.log('  ok  table insertion invalidates numbering structure');

const tableSelectionState = state.apply(
  state.tr.setSelection(TextSelection.create(state.doc, firstCell + 2)),
);
let structuralTransaction: Transaction | null = null;
assert.equal(toggleHeaderRow(tableSelectionState, (next) => { structuralTransaction = next; }), true);
assert.ok(structuralTransaction);
assert.equal(transactionChangesDerivedStructure(structuralTransaction, numberingStructure), true);
console.log('  ok  table header topology invalidates derived numbering structure');

structuralTransaction = null;
assert.equal(addRowAfter(tableSelectionState, (next) => { structuralTransaction = next; }), true);
assert.ok(structuralTransaction);
assert.equal(transactionChangesDerivedStructure(structuralTransaction, numberingStructure), true);
console.log('  ok  table row insertion invalidates derived numbering structure');

// The plugin-level identity check instruments the actual expensive path:
// `labels` is allocated only by the full document build and is deliberately
// retained when decorations merely map through a transaction.
state = EditorState.create({ schema, doc: tableDoc, plugins: [equationsPlugin()] });
const labelsBeforeCellEdit = eqKey.getState(state)?.labels;
state = state.apply(state.tr.insertText('x', firstCell + 2));
assert.equal(eqKey.getState(state)?.labels, labelsBeforeCellEdit);
console.log('  ok  native cell typing performs no full numbering build');

const labelsBeforeCaptionEdit = eqKey.getState(state)?.labels;
const currentTable = state.doc.child(0);
state = state.apply(
  state.tr.setNodeMarkup(0, undefined, { ...currentTable.attrs, caption: 'A mapped caption' }),
);
assert.equal(eqKey.getState(state)?.labels, labelsBeforeCaptionEdit);
console.log('  ok  caption typing performs no full numbering build');

const labelsBeforeLabelEdit = eqKey.getState(state)?.labels;
state = state.apply(
  state.tr.setNodeMarkup(0, undefined, { ...state.doc.child(0).attrs, label: 'tab:new-label' }),
);
assert.notEqual(eqKey.getState(state)?.labels, labelsBeforeLabelEdit);
assert.equal(eqKey.getState(state)?.labels.get('tab:new-label'), 'Table 1');
console.log('  ok  label edits still rebuild and publish reference targets');

// Typst only counts table figures. A plain native table before a labeled one
// must not make the live reference disagree with the visible caption/export.
const labeledTable = fixtureTable.type.create(
  { ...fixtureTable.attrs, caption: 'Counted', label: 'tab:counted' },
  fixtureTable.content,
);
const refParagraph = schema.nodes.paragraph.create(null, [
  schema.text('See '),
  schema.nodes.eq_ref.create({ label: 'tab:counted' }),
]);
state = EditorState.create({
  schema,
  doc: schema.nodes.doc.create(null, [uncaptionedTable, labeledTable, refParagraph]),
  plugins: [equationsPlugin()],
});
assert.equal(eqKey.getState(state)?.labels.get('tab:counted'), 'Table 1');
const beforePresenceChange = eqKey.getState(state)?.labels;
state = state.apply(
  state.tr.setNodeMarkup(0, undefined, { ...state.doc.child(0).attrs, caption: 'New first table' }),
);
assert.notEqual(eqKey.getState(state)?.labels, beforePresenceChange);
assert.equal(eqKey.getState(state)?.labels.get('tab:counted'), 'Table 2');
console.log('  ok  plain tables do not consume numbers and caption presence renumbers later references');

console.log('\nall transaction impact tests passed');
