import assert from 'node:assert/strict';
import { schema } from './schema.ts';
import { classifyTypstEmbed, typstEmbedLayoutBlocker } from './typst-embed-policy.ts';

for (const source of [
  '#let shared = 14pt',
  '#import "@preview/example:1.0.0": thing',
  '#rect(width: shared, height: 5pt)',
  '#figure([Bounded figure], caption: [Caption])',
  '#text("#set text(fill: red)")',
  '// #show heading: set text(red)\n#circle(radius: 2pt)',
]) {
  assert.deepEqual(classifyTypstEmbed(source), { mode: 'bounded' }, source);
}

for (const [source, reason] of [
  ['#set text(fill: red)', 'a document style rule'],
  ['#show heading: set text(blue)', 'a document show rule'],
  ['#place(top + left, rect(width: 5pt))', 'out-of-flow placement'],
  ['#move(dx: -2pt)[ink]', 'out-of-flow movement'],
  ['#pagebreak()', 'an explicit page break'],
  ['#include "chapter.typ"', 'included document content'],
  ['#eval("#set text(red)")', 'dynamically evaluated Typst'],
  ['#counter(page).update(4)', 'a state or counter update'],
] as const) {
  assert.deepEqual(classifyTypstEmbed(source), { mode: 'proof', reason }, source);
}

const embed = schema.nodes.typst_embed.create(null, schema.text('#set text(fill: red)'));
const prose = schema.nodes.paragraph.create(null, schema.text('Native prose must not claim that style.'));
const doc = schema.nodes.doc.create(null, [embed, prose]);
assert.equal(typstEmbedLayoutBlocker(doc), 'Typst embed uses a document style rule');

console.log('typst embed policy tests passed');
