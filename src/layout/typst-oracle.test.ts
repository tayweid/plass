// Regression coverage for the footnote-marker gluing bug: a footnote's
// rendered superscript number glues onto whatever precedes it — even when
// the document itself holds a real space right before the marker, because
// Typst drops that source space rather than rendering it. buildSpec must
// predict "no space" unconditionally for such atoms (ResolvedAtom.glueLeft)
// or the matcher's boundary check fails on the very first footnote-bearing
// paragraph that happens to have been typed with a trailing space before
// the marker.

import { schema } from '../schema';
import { buildSpec, matchParagraph, type AtomResolver, type SvgLine } from './typst-oracle';

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

const footnoteResolver: AtomResolver = (child) => {
  if (child.type.name === 'footnote') return { markup: '#footnote[.]', text: '1', glueLeft: true };
  return null;
};

// --- buildSpec: the atom token never carries a leading space --------------

{
  // A real document space sits right before the footnote node — exactly
  // what typing "word " and then inserting a footnote produces.
  const withSpace = schema.nodes.paragraph.create(null, [
    schema.text('word '),
    schema.nodes.footnote.create(null, schema.text('body')),
    schema.text(' after'),
  ]);
  const spec = buildSpec(withSpace, footnoteResolver)!;
  const atom = spec.tokens.find((t) => t.kind === 'atom')!;
  check('glueLeft atom predicts no leading space despite a real source space', atom.spaceBefore === false);
  const after = spec.tokens[spec.tokens.indexOf(atom) + 1];
  check('the token after the atom still sees its own real space', after.spaceBefore === true);
}

{
  // No source space at all: still glued, same prediction either way.
  const glued = schema.nodes.paragraph.create(null, [
    schema.text('word'),
    schema.nodes.footnote.create(null, schema.text('body')),
    schema.text(' after'),
  ]);
  const spec = buildSpec(glued, footnoteResolver)!;
  const atom = spec.tokens.find((t) => t.kind === 'atom')!;
  check('glueLeft atom predicts no leading space when there was none either', atom.spaceBefore === false);
}

// --- matchParagraph: the predicted stream matches Typst's actual gluing ---

{
  // Simulates the compiled SVG's extracted line: the marker "1" glued
  // directly onto "word" regardless of the document's own spacing.
  const doc = schema.nodes.paragraph.create(null, [
    schema.text('word '),
    schema.nodes.footnote.create(null, schema.text('body')),
    schema.text(' after the marker.'),
  ]);
  const spec = buildSpec(doc, footnoteResolver)!;
  const lines: SvgLine[] = [{ text: 'word1 after the marker.', y: 0 }];
  const res = matchParagraph(spec, lines, 0);
  check('a glued marker line matches a paragraph typed with a trailing space', res.status === 'ok');
}

{
  // The pre-fix behavior: without glueLeft, the spec expects a space that
  // Typst never renders, and the boundary check must reject the line
  // rather than silently accept a shifted match (fail closed).
  const naiveResolver: AtomResolver = (child) => {
    if (child.type.name === 'footnote') return { markup: '#footnote[.]', text: '1' };
    return null;
  };
  const doc = schema.nodes.paragraph.create(null, [
    schema.text('word '),
    schema.nodes.footnote.create(null, schema.text('body')),
    schema.text(' after the marker.'),
  ]);
  const spec = buildSpec(doc, naiveResolver)!;
  const lines: SvgLine[] = [{ text: 'word1 after the marker.', y: 0 }];
  const res = matchParagraph(spec, lines, 0);
  check('without glueLeft the same line is (correctly) rejected, not silently patched over', res.status === 'fail');
}
