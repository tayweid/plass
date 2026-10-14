// A numbered list's start (its `order`) beyond the file formats, which
// md-round.test.ts and typ-parser.test.ts cover: the page paints the
// labels from it and sizes the label column by the last label
// (list-indent.ts), a pasted `<ol start>` is read within what Markdown can
// write back (schema.ts), and the TeX export sets its level's counter one
// short of it. Run: npm test
import { enumAttrs } from './list-indent.ts';
import { schema } from './schema.ts';
import { docToTex } from './tex-serializer.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? '\n' + detail : ''}`);
  }
}

const { doc, ordered_list: OL, bullet_list: BL, list_item: LI, paragraph: P } = schema.nodes;
const items = (n: number) => Array.from({ length: n }, (_, i) => LI.create(null, P.create(null, schema.text(`item ${i + 1}`))));
const ol = (order: number, n: number) => OL.create({ order }, items(n));

// The label column is as wide as the widest label, the last one (every
// bundled face has tabular figures): its digit count picks the indent.
for (const [order, n, digits] of [
  [1, 9, '1'],
  [1, 10, '2'],
  [9, 2, '2'],
  [98, 2, '2'],
  [98, 3, '3'],
  [0, 10, '1'],
  [0, 11, '2'],
  [2026, 1, '4'],
] as const) {
  const attrs = enumAttrs(ol(order, n));
  check(`a list of ${n} from ${order} has ${digits}-digit labels`, attrs['data-digits'] === digits, JSON.stringify(attrs));
}

// The labels count from the start: the counter is reset one short of it,
// inline, only when the start is not the stylesheet's 1.
check('a list from 1 keeps the stylesheet\'s reset', enumAttrs(ol(1, 2)).style === undefined, JSON.stringify(enumAttrs(ol(1, 2))));
check('a list from 3 resets its counter to 2', enumAttrs(ol(3, 2)).style === 'counter-reset: plass-enum 2', JSON.stringify(enumAttrs(ol(3, 2))));
check('a list from 0 resets its counter to -1', enumAttrs(ol(0, 2)).style === 'counter-reset: plass-enum -1', JSON.stringify(enumAttrs(ol(0, 2))));

// Pasted HTML: a start Markdown can write back (a whole number of at most
// nine digits) is kept; anything else (negative, fractional, too long,
// not a number) reads as 1.
const getAttrs = OL.spec.parseDOM![0].getAttrs!;
const element = (start: string | null) =>
  ({ getAttribute: (name: string) => (name === 'start' ? start : null), hasAttribute: (name: string) => name === 'start' && start !== null }) as unknown as HTMLElement;
for (const [start, order] of [
  [null, 1],
  ['3', 3],
  ['0', 0],
  [' 12 ', 12],
  ['999999999', 999999999],
  ['1000000000', 1],
  ['-2', 1],
  ['2.5', 1],
  ['x', 1],
  ['', 1],
] as const) {
  const attrs = getAttrs(element(start)) as { order: number };
  check(`<ol start=${JSON.stringify(start)}> reads as a list from ${order}`, attrs.order === order, JSON.stringify(attrs));
}

// TeX: \setcounter on the list's own level, counted in enumerate
// environments only (a bullet list between does not deepen it).
{
  const tex = docToTex(
    doc.create(null, [
      ol(3, 2),
      BL.create(null, LI.create(null, [P.create(null, schema.text('bullet')), OL.create({ order: 5 }, items(1))])),
      OL.create(null, LI.create(null, [P.create(null, schema.text('outer')), OL.create({ order: 7 }, items(1))])),
    ]),
  );
  check('a list from 3 sets enumi to 2', tex.includes('\\begin{enumerate}\n\\setcounter{enumi}{2}\n\\item item 1\n\\item item 2\n\\end{enumerate}'), tex);
  check('a numbered list under a bullet is enumerate level one', tex.includes('\\begin{enumerate}\n\\setcounter{enumi}{4}\n\\item item 1\n'), tex);
  check('a numbered list in a numbered list sets enumii', tex.includes('\\begin{enumerate}\n\\setcounter{enumii}{6}\n\\item item 1\n'), tex);
  check('a list from 1 sets no counter', (tex.match(/\\setcounter\{enum/g) ?? []).length === 3, tex);
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall list-start tests passed');
}
