// The audit's page-start vocabulary (canonicalStart): the local paginator
// names a page start by the block it broke before, the oracle
// (page-oracle's `notePage`) by the node type of the first block Typst
// printed there. A block that starts a page on both sides must read as the
// same start: a display equation used to be `block` locally and
// `math_display` in Typst, and the audit reported a difference on a page
// both agreed on (and so never showed the real one, a page later).

import { schema } from '../schema';
import { buildUnits } from './page-oracle';
import { canonicalStart } from './port-audit';

function check(label: string, condition: boolean, detail = '') {
  if (!condition) throw new Error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  console.log(`  ok  ${label}`);
}

const n = schema.nodes;
const paragraph = (text: string) => n.paragraph.create(null, schema.text(text));
const doc = n.doc.create(null, [
  paragraph('Before.'),
  n.math_display.create({ src: 'x' }),
  n.code_block.create(null, schema.text('let x = 1')),
  n.blockquote.create(null, [n.math_display.create({ src: 'y' }), paragraph('In the quote.')]),
  n.bullet_list.create(null, n.list_item.create(null, paragraph('Item.'))),
  n.heading.create({ level: 2 }, schema.text('Heading')),
]);
const pos: number[] = [];
doc.forEach((_node, offset) => pos.push(offset));
const [, eqPos, codePos, quotePos, listPos, headingPos] = pos;
const show = (e: unknown) => JSON.stringify(e);

// The oracle's names, which the local side must match.
const oracle = new Map(buildUnits(doc, () => null).map((u) => [u.pos, u.type]));

{
  const eq = canonicalStart(doc, { pos: eqPos, line: 0, unit: 'math_display' });
  check('a display equation starts a page as `math_display`', eq.pos === eqPos && eq.unit === oracle.get(eqPos), show(eq));
  const code = canonicalStart(doc, { pos: codePos, line: 0, unit: 'code_block' });
  check('a code block starts a page as `code_block`', code.pos === codePos && code.unit === oracle.get(codePos), show(code));
  // The paginator's old label still names the block by its type.
  const legacy = canonicalStart(doc, { pos: eqPos, line: 0, unit: 'block' });
  check('a `block` label is read as the node type', legacy.unit === 'math_display', show(legacy));
}

{
  // A container is named at the container; the start is its first block,
  // whatever the container was labelled.
  const quote = canonicalStart(doc, { pos: quotePos, line: 0, unit: 'blockquote' });
  check('a quote opening with an equation starts at the equation', quote.pos === quotePos + 1 && quote.unit === 'math_display', show(quote));
  check('… as the oracle names it', oracle.get(quote.pos) === 'math_display', show([...oracle]));
  const list = canonicalStart(doc, { pos: listPos, line: 0, unit: 'bullet_list' });
  check('a list starts at its first item paragraph', list.pos === listPos + 2 && list.unit === 'paragraph', show(list));
}

{
  const heading = canonicalStart(doc, { pos: headingPos, line: 0, unit: 'heading' });
  check('a heading is named by its level', heading.unit === 'h2', show(heading));
  const line = { pos: 0, line: 3, unit: 'line' };
  check('a line start is already exact', canonicalStart(doc, line) === line);
}

console.log('all port-audit tests passed');
