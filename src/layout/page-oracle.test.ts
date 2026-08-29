// Regression coverage for the ordered-list marker bug: Typst renders an
// ordered item's marker ("1.", "2.", …) glued directly onto its first word
// in the extracted text layer, with no separating space. The page oracle's
// old blind-strip regex (MARKER) happened to work for bullet glyphs but
// silently no-op'd on a leading digit (its first alternation branch — an
// optional bullet char plus optional whitespace — always matches a
// zero-length string before the digit branch is ever tried), so an ordered
// item's marker was never actually removed. buildUnits now predicts the
// exact marker text per item (deterministic: Typst's default enum
// numbering restarts at 1 for every list, nested or not, and the exporter
// never overrides it) and stripListMarker requires it verbatim.

import { schema } from '../schema';
import { buildUnits, matchesAnchor, stripListMarker, type Unit } from './page-oracle';
import type { AtomResolver } from './typst-oracle';

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

const noAtoms: AtomResolver = () => null;
const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const item = (text: string) => schema.nodes.list_item.create(null, paragraph(text));

// --- stripListMarker: the pure strip/match rule ----------------------------

{
  check('a matching ordered marker is stripped exactly', stripListMarker('1.Ordered item one.', '1.') === 'Ordered item one.');
  check(
    'a mismatched ordered marker is left untouched (fail closed)',
    stripListMarker('2.Ordered item one.', '1.') === '2.Ordered item one.',
  );
  check('a bullet marker glyph is stripped by the generic pattern', stripListMarker('• First bullet.', true) === 'First bullet.');
  check('no marker leaves the text untouched', stripListMarker('Plain paragraph.', undefined) === 'Plain paragraph.');
  // The bug in miniature: the OLD regex's first alternation (an optional
  // bullet char, optional whitespace) matches a zero-length string before a
  // bare digit is ever tried against the second alternation — reproduced
  // here as a sanity check that stripListMarker does NOT use that pattern
  // for a string marker (it requires the literal prefix instead).
  check(
    'a digit-led paragraph with no marker unit stays untouched too',
    stripListMarker('1.5 apples remain.', undefined) === '1.5 apples remain.',
  );
}

// --- buildUnits: marker prediction per list item ---------------------------

{
  const list = schema.nodes.ordered_list.create(null, [item('One.'), item('Two.'), item('Three.')]);
  const doc = schema.nodes.doc.create(null, [list]);
  const units = buildUnits(doc, noAtoms);
  const markers = units.filter((u): u is Unit & { marker: string } => typeof u.marker === 'string').map((u) => u.marker);
  check('three ordered items predict markers 1., 2., 3.', JSON.stringify(markers) === JSON.stringify(['1.', '2.', '3.']));
}

{
  // A second, independent ordered_list restarts its own count at 1 — this
  // is what a nested ordered list inside a list_item does too (Typst's
  // default enum numbering is per-list, not document-global).
  const listA = schema.nodes.ordered_list.create(null, [item('A one.'), item('A two.')]);
  const listB = schema.nodes.ordered_list.create(null, [item('B one.')]);
  const doc = schema.nodes.doc.create(null, [listA, listB]);
  const units = buildUnits(doc, noAtoms);
  const markers = units.filter((u): u is Unit & { marker: string } => typeof u.marker === 'string').map((u) => u.marker);
  check('a second ordered list restarts numbering at 1.', JSON.stringify(markers) === JSON.stringify(['1.', '2.', '1.']));
}

{
  const list = schema.nodes.bullet_list.create(null, [item('One.'), item('Two.')]);
  const doc = schema.nodes.doc.create(null, [list]);
  const units = buildUnits(doc, noAtoms);
  const markers = units.filter((u) => u.marker !== false && u.marker !== undefined).map((u) => u.marker);
  check('bullet items carry the boolean glyph marker, not literal text', markers.every((m) => m === true));
}

{
  // A multi-paragraph list item: only its FIRST block carries the marker —
  // a second paragraph (or a nested list) inside the same item has none.
  const multi = schema.nodes.list_item.create(null, [paragraph('First para.'), paragraph('Second para.')]);
  const list = schema.nodes.ordered_list.create(null, [multi, item('Item two.')]);
  const doc = schema.nodes.doc.create(null, [list]);
  const units = buildUnits(doc, noAtoms);
  const paraUnits = units.filter((u) => u.type === 'paragraph');
  check('only the first block of a multi-block item gets a marker', paraUnits[0].marker === '1.');
  check('the second block of the same item gets none', !paraUnits[1].marker);
  check('the next item still gets its own marker', paraUnits[2].marker === '2.');
}

// --- matchesAnchor: opaque-block resync onto a MARKED next unit -----------
//
// Regression for the opaque-block-swallows-the-marked-item bug: an opaque
// block (a code_block, a figure, a table, …) resyncs onto the next exact
// unit by comparing SVG line text against that unit's first two words. When
// that next unit is a list item, Typst glues its marker onto the line's
// front — the un-stripped comparison could never match, so the opaque
// block consumed straight past its real end into the marked item's own
// lines (reproduced end-to-end as a permanent "page splits inside atomic
// block" failure for a code_block immediately followed by an ordered_list).

{
  check(
    'an ordered marker glued onto the anchor line still matches',
    matchesAnchor('1.Ordered item one immediately after the block.', { text: 'Ordered item', marker: '1.' }),
  );
  check(
    'a bullet glyph glued onto the anchor line still matches',
    matchesAnchor('• Bullet item one.', { text: 'Bullet item', marker: true }),
  );
  check(
    'a mismatched ordered marker still fails to match (fail closed)',
    !matchesAnchor('2.Ordered item one immediately after the block.', { text: 'Ordered item', marker: '1.' }),
  );
  check(
    'an unmarked anchor matches its line exactly as before',
    matchesAnchor('Plain paragraph text.', { text: 'Plain paragraph' }),
  );
  check('a null anchor never matches (trailing opaque content owns the rest)', !matchesAnchor('Anything.', null));
}
