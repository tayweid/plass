// Pipe tables and the `.table` div grammar (md-tables.ts): every attribute
// both ways, 0-based written-grid positions with covered cells, the blank
// header line of a headerless table, caption lines, decimal columns, pipe
// escaping, and every warning.
// Run: npx tsx src/md-tables.test.ts
import MarkdownIt from 'markdown-it';
import type { Node as PMNode, Mark } from 'prosemirror-model';
import { schema } from './schema';
import { docToMd } from './md-serializer';
import {
  applyTableDivAttrs,
  captionFromLine,
  delimiterAlign,
  escapeCellProse,
  pipeTableMd,
  readPipeTable,
  tableDivAttrs,
  takeCaptionLine,
  type DivAttrs,
} from './md-tables';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => JSON.stringify(v, null, 1);

// ---------- builders ----------

const { table: tableType, table_row, table_cell, table_header, paragraph } = schema.nodes;

/** Inline content from a tiny notation: `$…$` is math, `` `…` `` code. */
function inl(text: string): PMNode[] {
  const out: PMNode[] = [];
  for (const part of text.split(/(\$[^$]+\$|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith('$')) out.push(schema.nodes.math_inline.create({ src: part.slice(1, -1) }));
    else if (part.startsWith('`')) out.push(schema.text(part.slice(1, -1), [schema.marks.code.create()]));
    else out.push(schema.text(part));
  }
  return out;
}
type CellSpec = string | [string, Record<string, unknown>];
const cellOf = (type: typeof table_cell, spec: CellSpec) => {
  const [text, attrs] = typeof spec === 'string' ? [spec, {}] : spec;
  return type.create(attrs, paragraph.create(null, inl(text)));
};
const td = (spec: CellSpec) => cellOf(table_cell, spec);
const th = (spec: CellSpec) => cellOf(table_header, spec);
const tr = (cells: PMNode[], rule = '') => table_row.create({ rule }, cells);
const table = (rows: PMNode[], attrs: Record<string, unknown> = {}) => tableType.create({ style: 'booktabs', ...attrs }, rows);

/** The serializer's own inline writer, through a one-paragraph document. */
const cellMd = (p: PMNode) => docToMd(schema.nodes.doc.create(null, [p])).replace(/\n+$/, '');

/** Read a pipe table the way the Markdown reader does once the div lands
 *  (plan step 6): code spans and `$…$` math sentinelized before
 *  markdown-it, so its GFM splitter never sees their pipes; the header row
 *  as header cells; each cell aligned by `delimiterAlign`. */
function readMd(md: string): PMNode {
  const saved: PMNode[] = [];
  const pre = md.replace(/`[^`\n]*`|(?<!\\)\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, (m: string, math?: string) => {
    saved.push(m.startsWith('`') ? schema.text(m.slice(1, -1), [schema.marks.code.create()]) : schema.nodes.math_inline.create({ src: math }));
    return `${saved.length - 1}`;
  });
  const tokens = new MarkdownIt().parse(pre, {});
  const rows: PMNode[] = [];
  let cells: PMNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'tr_open') cells = [];
    else if (t.type === 'tr_close') rows.push(table_row.create(null, cells));
    else if (t.type === 'th_open' || t.type === 'td_open') {
      const type = t.type === 'th_open' ? table_header : table_cell;
      const content: PMNode[] = [];
      let marks: readonly Mark[] = [];
      for (const c of tokens[i + 1].children ?? []) {
        if (c.type === 'text') {
          for (const part of c.content.split(/(\d+)/).map((s, k) => (k % 2 ? saved[+s] : s))) {
            if (typeof part !== 'string') content.push(part.isText ? part.mark([...part.marks, ...marks]) : part);
            else if (part) content.push(schema.text(part, marks));
          }
        } else if (c.type === 'strong_open') marks = [...marks, schema.marks.strong.create()];
        else if (c.type === 'em_open') marks = [...marks, schema.marks.em.create()];
        else if (c.type === 'strong_close' || c.type === 'em_close') marks = marks.slice(0, -1);
      }
      cells.push(type.create({ align: delimiterAlign(t.attrGet('style')) }, paragraph.create(null, content)));
    }
  }
  return tableType.create({ style: 'booktabs' }, rows);
}

/** Write a table (div attributes and pipe text) and read it back. */
function trip(t: PMNode) {
  const writeWarnings: string[] = [];
  const attrs = tableDivAttrs(t, (w) => writeWarnings.push(w));
  const md = pipeTableMd(t, cellMd, (w) => writeWarnings.push(w));
  const readWarnings: string[] = [];
  const back = readPipeTable(readMd(md), attrs, (w) => readWarnings.push(w), md.split('\n').pop());
  return { attrs, md, back, writeWarnings, readWarnings };
}
const kv = (attrs: DivAttrs | null) => Object.fromEntries(attrs?.keyvals ?? []);

// ---------- escapeCellProse ----------

console.log('escapeCellProse');
{
  const cases: Array<[string, string, string]> = [
    ['a pipe in plain text is escaped', 'a|b', 'a\\|b'],
    ['a pipe inside $…$ is left alone', '$|x|$', '$|x|$'],
    ['a pipe inside backticks is left alone', '`a|b`', '`a|b`'],
    ['a longer code span holding a backtick', '``a`|b`` | c', '``a`|b`` \\| c'],
    ['raw Typst inline is a code span too', '`#h(1fr) | x`{=typst}', '`#h(1fr) | x`{=typst}'],
    ['an unclosed backtick is literal', '`a|b', '`a\\|b'],
    ['escaped dollars open no math', '\\$5 | \\$6', '\\$5 \\| \\$6'],
    ['a dollar before a space opens no math', '$ x | y$', '$ x \\| y$'],
    ['a space before the closing dollar closes no math', '$5 | $6', '$5 \\| $6'],
    ['a closing dollar before a digit closes no math', '$a|b$5', '$a\\|b$5'],
    ['text after math is prose again', '$x$|y', '$x$\\|y'],
    ['\\| inside math stays (it is the norm bars)', '$\\|v\\|$', '$\\|v\\|$'],
    ['\\text{…} may hold a dollar', '$\\text{a $ b}|c$', '$\\text{a $ b}|c$'],
    ['display math $$…$$', '$$|x|$$ | y', '$$|x|$$ \\| y'],
    ['an escaped backslash before a pipe', 'x \\\\| y', 'x \\\\\\| y'],
    ['an already escaped pipe stays one escape', 'x \\| y', 'x \\| y'],
    ['a line break folds to a space', 'a\nb', 'a b'],
    ['a hard break folds to a space', 'a\\\nb', 'a b'],
    ['a line break inside math folds too', '$a +\nb$', '$a + b$'],
  ];
  for (const [name, input, want] of cases) {
    const got = escapeCellProse(input);
    check(name, got === want, `${JSON.stringify(input)} → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// ---------- the pipe table ----------

console.log('pipe table');
{
  const t = table([tr([th('Name'), th('Score')]), tr([td('a'), td('1')])]);
  const r = trip(t);
  check('a table with nothing set yields no div', r.attrs === null, show(r.attrs));
  check('the header row is the header line', r.md === '| Name | Score |\n| --- | --- |\n| a | 1 |', r.md);
  check('a plain table round-trips exactly', same(r.back.toJSON(), t.toJSON()), `${show(r.back.toJSON())}\nvs\n${show(t.toJSON())}`);
  check('a plain table warns about nothing', !r.writeWarnings.length && !r.readWarnings.length, [...r.writeWarnings, ...r.readWarnings].join('; '));
}
{
  const t = table([tr([td('a'), td('1')]), tr([td('b'), td('2')])]);
  const r = trip(t);
  check('a headerless table writes the blank header line', r.md === '|   |   |\n| --- | --- |\n| a | 1 |\n| b | 2 |', r.md);
  check('a headerless table needs no div', r.attrs === null, show(r.attrs));
  check('a headerless table reads back headerless', same(r.back.toJSON(), t.toJSON()), show(r.back.toJSON()));
  check('the blank header line is not counted as a row', r.back.childCount === 2, String(r.back.childCount));
}
{
  // Positions count Plass rows: with the blank header line, r0 is still
  // the first Plass row.
  const t = table([tr([td('a'), td(['1', { fill: 'yellow' }])]), tr([td('b'), td('2')], 'heavy')]);
  const r = trip(t);
  check('headerless positions start at the first Plass row', kv(r.attrs).fills === 'r0c1:yellow' && kv(r.attrs).rules === '1:heavy', show(r.attrs));
  check('headerless positions read back on the same cells', same(r.back.toJSON(), t.toJSON()), show(r.back.toJSON()));
}
{
  const t = table([tr([th(''), th('')]), tr([td('a'), td('1')])]);
  const r = trip(t);
  check('a header row of empty cells is written as a body row', r.md === '|   |   |\n| --- | --- |\n|   |   |\n| a | 1 |', r.md);
  check('… with a warning', r.writeWarnings.some((w) => w.includes('header row with no text')), r.writeWarnings.join('; '));
  check('… and reads back as an empty body row', r.back.childCount === 2 && r.back.child(0).child(0).type === table_cell, show(r.back.toJSON()));
}
{
  const t = table([tr([th('A'), th('B')]), tr([th('x'), td('1')])]);
  const r = trip(t);
  check('header cells below the first row warn', r.writeWarnings.some((w) => w.includes('header cells outside')), r.writeWarnings.join('; '));
  check('… and read back as body cells', r.back.child(1).child(0).type === table_cell, show(r.back.toJSON()));
  const mixed = trip(table([tr([th('A'), td('B')]), tr([td('x'), td('1')])]));
  check('a partly-header first row is written under a blank header line', mixed.md.startsWith('|   |   |\n'), mixed.md);
  check('… with the same warning', mixed.writeWarnings.some((w) => w.includes('header cells outside')), mixed.writeWarnings.join('; '));
}
{
  const t = table([tr([th('a|b'), th('$|x|$')]), tr([td('`a|b`'), td('p | q')])]);
  const r = trip(t);
  check('`a|b` and $|x|$ are written unescaped, prose pipes escaped',
    r.md === '| a\\|b | $|x|$ |\n| --- | --- |\n| `a|b` | p \\| q |', r.md);
  check('pipes in prose, math and code read back', same(r.back.toJSON(), t.toJSON()), show(r.back.toJSON()));
}
{
  const t = table([tr([th(['L', { align: 'left' }]), th(['C', { align: 'center' }]), th(['R', { align: 'right' }]), th('D')])]);
  const r = trip(t);
  check('the delimiter row carries left, center, right and none', r.md.split('\n')[1] === '| :--- | :---: | ---: | --- |', r.md);
  check('alignment from the delimiter row reads back exactly', same(r.back.toJSON(), t.toJSON()), show(r.back.toJSON()));
}
{
  check('delimiterAlign reads markdown-it styles', delimiterAlign('text-align:left') === 'left' && delimiterAlign('text-align:center') === 'center'
    && delimiterAlign('text-align:right') === 'right' && delimiterAlign(null) === null && delimiterAlign('') === null);
}

// ---------- cell content ----------

console.log('cell content');
{
  const fn = schema.nodes.footnote.create(null, schema.text('note'));
  const img = schema.nodes.image.create({ src: 'a.png' });
  const html = schema.nodes.typst_inline.create({ src: '<sub>2</sub>', lang: 'html' });
  const raw = schema.nodes.typst_inline.create({ src: '#h(1fr)' });
  const cell = table_cell.create(null, [
    paragraph.create(null, [schema.text('one'), fn, img, html, schema.nodes.hard_break.create(), schema.text('two'), raw]),
    paragraph.create(null, [schema.text('three')]),
    schema.nodes.math_display.create({ src: 'x^2' }),
    schema.nodes.bullet_list.create(null, schema.nodes.list_item.create(null, paragraph.create(null, schema.text('item')))),
    schema.nodes.horizontal_rule.create(),
  ]);
  const warnings: string[] = [];
  const md = pipeTableMd(table([tr([th('H')]), tr([cell])]), cellMd, (w) => warnings.push(w));
  check('a cell is written as one line', md.split('\n')[2] === '| one two`#h(1fr)`{=typst} three $x^2$ item |', md);
  for (const [name, needle] of [
    ['footnotes in cells drop with a warning', 'footnotes'],
    ['images in cells drop with a warning', 'images'],
    ['inline HTML in cells drops with a warning', 'inline HTML'],
    ['a line break in a cell becomes a space with a warning', 'line break'],
    ['several paragraphs join with a warning', 'several paragraphs'],
    ['other blocks flatten with a warning', 'flattened'],
    ['a block with no text drops with a warning', 'horizontal rule'],
  ] as const) check(name, warnings.some((w) => w.includes(needle)), warnings.join('; '));
  const aligned = table([tr([th('H')]), tr([table_cell.create(null, paragraph.create({ align: 'center' }, schema.text('x')))])]);
  const w2: string[] = [];
  pipeTableMd(aligned, cellMd, (w) => w2.push(w));
  check('paragraph alignment inside a cell warns', w2.some((w) => w.includes('paragraph alignment')), w2.join('; '));
}

// ---------- table attributes ----------

console.log('table attributes');
{
  const t = table([tr([th('A'), th('B'), th('C')]), tr([td('1'), td('2'), td('3')])], {
    label: 'tbl:x', caption: 'Results “final”', style: 'grid', density: 'compact', insetPt: 9,
    columnWidths: ['auto', '1fr', '72pt'], fontSize: '0.85em',
  });
  const r = trip(t);
  check('id and class', r.attrs?.id === 'tbl:x' && same(r.attrs?.classes, ['table']), show(r.attrs));
  check('every table attribute, in the grammar order', same(r.attrs?.keyvals, [
    ['caption', 'Results “final”'], ['style', 'grid'], ['density', 'compact'], ['inset', '9pt'],
    ['columns', 'auto 1fr 72pt'], ['font-size', '0.85em'],
  ]), show(r.attrs?.keyvals));
  check('table attributes read back exactly', same(r.back.toJSON(), t.toJSON()), show(r.back.toJSON()));
  check('no warnings either way', !r.writeWarnings.length && !r.readWarnings.length, [...r.writeWarnings, ...r.readWarnings].join('; '));
}
{
  const plain = trip(table([tr([th('A')]), tr([td('1')])], { style: 'plain' }));
  check('style=plain', kv(plain.attrs).style === 'plain' && plain.back.attrs.style === 'plain', show(plain.attrs));
  const booktabs = tableDivAttrs(table([tr([th('A')])], { style: 'booktabs' }));
  check('booktabs is the default and is not written', booktabs === null, show(booktabs));
  const empty = tableDivAttrs(table([tr([th('A')])], { style: '' }));
  check('an empty style (the exporter prints grid) is written as grid', kv(empty).style === 'grid', show(empty));
  const roomy = trip(table([tr([th('A')]), tr([td('1')])], { density: 'roomy' }));
  check('density=roomy', kv(roomy.attrs).density === 'roomy' && roomy.back.attrs.density === 'roomy', show(roomy.attrs));
  const label = tableDivAttrs(table([tr([th('A')])], { label: 'tbl:only' }));
  check('a label alone makes the div', label?.id === 'tbl:only' && label.keyvals.length === 0, show(label));
  // pandoc 3.4 reads `{#2024res}`, `{#_x}` and `{#a.b_c-d}` as identifiers.
  const digit = tableDivAttrs(table([tr([th('A')])], { label: '2024res.v_2-b' }));
  check('a label may start with a digit, as a portable key may', digit?.id === '2024res.v_2-b', show(digit));
}
{
  const fn = () => td('x').type.create(null, paragraph.create(null, [schema.text('x'), schema.nodes.footnote.create(null, schema.text('n'))]));
  const warnings: string[] = [];
  pipeTableMd(table([tr([th('A'), th('B')]), tr([fn(), fn()])]), cellMd, (w) => warnings.push(w));
  check('a warning raised by many cells is reported once per table', warnings.filter((w) => w.includes('footnotes')).length === 1, warnings.join('; '));
}
{
  const warnings: string[] = [];
  const attrs = tableDivAttrs(table([tr([th('A'), th('B')])], {
    params: 'stroke: red', label: '9 bad', columnWidths: ['1fr'], fontSize: '12pt', density: 'airy',
  }), (w) => warnings.push(w));
  check('params warn and drop', warnings.some((w) => w.includes('params')), warnings.join('; '));
  check('a label that is not an identifier warns and drops', warnings.some((w) => w.includes('label')) && !attrs?.id, warnings.join('; '));
  check('column widths that miss the column count warn and drop', warnings.some((w) => w.includes('column widths')) && !kv(attrs).columns, warnings.join('; '));
  check('a font size the reader would refuse warns and drops', warnings.some((w) => w.includes('font size')) && !kv(attrs)['font-size'], warnings.join('; '));
  check('an unknown density warns and drops', warnings.some((w) => w.includes('density')) && !kv(attrs).density, warnings.join('; '));
}
{
  const base = table([tr([th('A'), th('B')]), tr([td('1'), td('2')])]);
  const warnings: string[] = [];
  const got = applyTableDivAttrs(base, {
    id: 'tbl:r', classes: ['table', 'striped'],
    keyvals: [['style', 'fancy'], ['density', 'airy'], ['inset', '100pt'], ['columns', 'auto 3em'], ['font-size', '12pt'], ['color', 'red']],
  }, (w) => warnings.push(w));
  check('an unknown class warns', warnings.some((w) => w.includes('.striped')), warnings.join('; '));
  check('an unknown attribute warns', warnings.some((w) => w.includes('"color"')), warnings.join('; '));
  for (const name of ['style', 'density', 'inset', 'columns', 'font-size']) {
    check(`a bad ${name} value warns and is ignored`, warnings.some((w) => w.includes(`attribute ${name}:`)), warnings.join('; '));
  }
  check('ignored values leave the table at its defaults', got.attrs.style === 'booktabs' && got.attrs.density === '' && got.attrs.insetPt === null
    && got.attrs.columnWidths === null && got.attrs.fontSize === '' && got.attrs.label === 'tbl:r', show(got.attrs));
  const wrongCount: string[] = [];
  applyTableDivAttrs(base, { id: '', classes: ['table'], keyvals: [['columns', 'auto 1fr 2fr']] }, (w) => wrongCount.push(w));
  check('columns must name every column', wrongCount.some((w) => w.includes('does not name 2 column')), wrongCount.join('; '));
  const bare = applyTableDivAttrs(base, { id: '', classes: ['table'], keyvals: [['inset', '4'], ['columns', '1fr,2fr']] });
  check('a bare inset number is points; columns may be comma-separated', bare.attrs.insetPt === 4 && same(bare.attrs.columnWidths, ['1fr', '2fr']), show(bare.attrs));
}

// ---------- rules, fills, valign, spans, aligns ----------

console.log('positions');
{
  const t = table([
    tr([th(['Name', { fill: 'gray-dark' }]), th(['Score', { fill: 'gray-dark' }]), th(['Note', { fill: 'gray-dark' }])]),
    tr([td(['a', { colspan: 2 }]), td(['x', { fill: 'yellow', valign: 'middle' }])], 'light'),
    tr([td(['b', { rowspan: 2 }]), td('3.25'), td(['y', { fill: 'blue' }])]),
    tr([td(['', { align: 'center' }]), td('z')], 'none'),
  ]);
  const r = trip(t);
  const want = {
    rules: '1:light 3:none',
    fills: 'r0:gray-dark r1c2:yellow r2c2:blue',
    valign: 'r1c2:middle',
    spans: 'r1c0:2x1 r2c0:1x2',
    aligns: 'r3c1:center',
  };
  check('rules, fills, valign, spans and aligns at 0-based origins', same(kv(r.attrs), want), show(kv(r.attrs)));
  check('the cell after a colspan counts the covered column (r1c2)', kv(r.attrs).fills.includes('r1c2:yellow'), kv(r.attrs).fills);
  check('covered cells are written empty', r.md.split('\n')[2] === '| a |   | x |' && r.md.split('\n')[4] === '|   |   | z |', r.md);
  check('positions read back onto the same cells', same(r.back.toJSON(), t.toJSON()), `${show(r.back.toJSON())}\nvs\n${show(t.toJSON())}`);
  check('no warnings either way', !r.writeWarnings.length && !r.readWarnings.length, [...r.writeWarnings, ...r.readWarnings].join('; '));
}
{
  // A 2x2 span, and a cell after it in the same rows.
  const t = table([
    tr([th('A'), th('B'), th('C'), th('D')]),
    tr([td('1'), td(['big', { colspan: 2, rowspan: 2, fill: 'gray' }]), td('4')]),
    tr([td('5'), td(['8', { fill: 'blue' }])]),
  ]);
  const r = trip(t);
  check('a 2x2 span', kv(r.attrs).spans === 'r1c1:2x2', show(r.attrs));
  check('a fill on the span names its origin; the cell after it counts covered columns', kv(r.attrs).fills === 'r1c1:gray r2c3:blue', show(r.attrs));
  check('a 2x2 span reads back', same(r.back.toJSON(), t.toJSON()), show(r.back.toJSON()));
}
{
  const t = table([tr([th(['A', { valign: 'bottom' }]), th(['B', { valign: 'bottom' }])]), tr([td(['1', { valign: 'bottom' }]), td(['2', { valign: 'bottom' }])])]);
  const r = trip(t);
  check('one vertical alignment for every cell is written once for the table', kv(r.attrs).valign === 'bottom', show(r.attrs));
  check('a table-wide valign reads back', same(r.back.toJSON(), t.toJSON()), show(r.back.toJSON()));
  const row = trip(table([tr([th('A'), th('B')]), tr([td(['1', { fill: 'yellow' }]), td(['2', { fill: 'yellow' }])])]));
  check('one fill for a whole row is written once for the row', kv(row.attrs).fills === 'r1:yellow', show(row.attrs));
}
{
  // Reading: whole-row and table-wide values yield to a cell's own,
  // whatever the written order.
  const base = table([tr([th('A'), th('B')]), tr([td('1'), td('2')])]);
  const got = applyTableDivAttrs(base, { id: '', classes: ['table'], keyvals: [
    ['fills', 'r1c0:blue r1:gray'], ['valign', 'r0c1:top middle'],
  ] });
  const attr = (r: number, c: number, name: string) => got.child(r).child(c).attrs[name];
  check('a cell fill wins over its row fill', attr(1, 0, 'fill') === 'blue' && attr(1, 1, 'fill') === 'gray' && attr(0, 0, 'fill') === '');
  check('a cell valign wins over the table valign', attr(0, 1, 'valign') === 'top' && attr(0, 0, 'valign') === 'middle' && attr(1, 1, 'valign') === 'middle');
  const ruled = applyTableDivAttrs(base, { id: '', classes: ['table'], keyvals: [['rules', 'r0:heavy']] });
  check('rules read rN the same as N', ruled.child(0).attrs.rule === 'heavy');
}
{
  // Reading: positions that do not name a cell's origin, out-of-range
  // positions, malformed entries, and spans that would swallow text.
  const base = table([tr([th('A'), th('B'), th('C')]), tr([td('1'), td(''), td('3')]), tr([td('4'), td('5'), td('')])]);
  const warnings: string[] = [];
  const got = applyTableDivAttrs(base, { id: '', classes: ['table'], keyvals: [
    ['spans', 'r1c0:2x1 r1c1:1x1 r2c0:2x1 r0c2:1x9 r0c1:1x2 r9c0:2x1 r0c0:big'],
    ['fills', 'r1c1:gray r5:gray r0c0:purple r0c0'],
    ['valign', 'r1c1:middle sideways'],
    ['aligns', 'r1c1:left r0c0:justify'],
    ['rules', '7:light 0:thick'],
    ['decimal', '9 x'],
  ] }, (w) => warnings.push(w));
  const has = (needle: string) => warnings.some((w) => w.includes(needle));
  check('a span over an empty cell applies', got.child(1).childCount === 2 && got.child(1).child(0).attrs.colspan === 2, show(got.toJSON()));
  check('a span starting on a covered cell is ignored', has('"r1c1:1x1" does not start at a free cell'), warnings.join('; '));
  check('a span over a cell with text is ignored and keeps the text', has('"r2c0:2x1" would cover') && got.child(2).childCount === 3, warnings.join('; '));
  check('a span past the table edge is ignored', has('"r0c2:1x9" does not fit'), warnings.join('; '));
  check('a span over a span is ignored', has('"r0c1:1x2" would cover'), warnings.join('; '));
  check('a span outside the table is ignored', has('"r9c0:2x1" is outside the table'), warnings.join('; '));
  check('a malformed span is ignored', has('"r0c0:big" is not understood'), warnings.join('; '));
  check('a fill naming a covered position is ignored', has('"r1c1:gray" names a position a span covers'), warnings.join('; '));
  check('a valign naming a covered position is ignored', has('"r1c1:middle" names a position'), warnings.join('; '));
  check('an align naming a covered position is ignored', has('"r1c1:left" names a position'), warnings.join('; '));
  check('a row fill outside the table is ignored', has('"r5:gray" is outside'), warnings.join('; '));
  check('an unknown fill is ignored', has('"r0c0:purple"'), warnings.join('; '));
  check('a fill with no value is ignored', has('fills: "r0c0" is not understood'), warnings.join('; '));
  check('an unknown valign is ignored', has('"sideways"'), warnings.join('; '));
  check('an unknown align is ignored', has('"r0c0:justify"'), warnings.join('; '));
  check('a rule outside the table and an unknown rule are ignored', has('"7:light" is outside') && has('"0:thick"'), warnings.join('; '));
  check('a decimal column outside the table and a malformed one are ignored', has('decimal: "9"') && has('decimal: "x"'), warnings.join('; '));
}

// ---------- decimal columns ----------

console.log('decimal');
{
  const t = table([
    tr([th(['Item', {}]), th(['Price', { align: 'decimal' }])]),
    tr([td('a'), td(['12.5', { align: 'decimal' }])]),
    tr([td('b'), td(['3.25', { align: 'decimal' }])]),
    tr([td('total'), td(['n/a', { align: 'right' }])]),
  ]);
  const r = trip(t);
  check('a decimal column is ---: plus decimal="N"', r.md.split('\n')[1] === '| --- | ---: |' && kv(r.attrs).decimal === '1', `${r.md}\n${show(r.attrs)}`);
  check('a right-aligned cell in a decimal column is an override', kv(r.attrs).aligns === 'r3c1:right', show(r.attrs));
  check('decimal columns read back exactly', same(r.back.toJSON(), t.toJSON()), show(r.back.toJSON()));
}
{
  const read = readMd('| Item | Price |\n| --- | :---: |\n| a | 1.5 |');
  const warnings: string[] = [];
  const got = applyTableDivAttrs(read, { id: '', classes: ['table'], keyvals: [['decimal', '1']] }, (w) => warnings.push(w));
  check('a decimal column without ---: warns', warnings.some((w) => w.includes('needs ---:')), warnings.join('; '));
  check('… and keeps its delimiter alignment', got.child(1).child(1).attrs.align === 'center', show(got.toJSON()));
  const ok = applyTableDivAttrs(readMd('| Item | Price |\n| --- | ---: |\n| a | 1.5 |'), { id: '', classes: ['table'], keyvals: [['decimal', '1']] });
  check('decimal on a ---: column makes every cell in it decimal', ok.child(0).child(1).attrs.align === 'decimal' && ok.child(1).child(1).attrs.align === 'decimal', show(ok.toJSON()));
}
{
  // Column alignment is the majority; a cell with no alignment in an
  // aligned column is written `default`.
  const t = table([tr([th('A'), th('B')]), tr([td(['1', { align: 'right' }]), td('x')]), tr([td(['2', { align: 'right' }]), td('y')])]);
  const r = trip(t);
  check('the delimiter takes the column majority', r.md.split('\n')[1] === '| ---: | --- |', r.md);
  check('an unaligned cell in an aligned column is aligns=default', kv(r.attrs).aligns === 'r0c0:default', show(r.attrs));
  check('default reads back as no alignment', same(r.back.toJSON(), t.toJSON()), show(r.back.toJSON()));
  const odd = table([tr([th(['A', { align: 'justify' }])])]);
  const warnings: string[] = [];
  tableDivAttrs(odd, (w) => warnings.push(w));
  check('an alignment with no Markdown form warns', warnings.some((w) => w.includes('"justify"')), warnings.join('; '));
}

// ---------- caption lines ----------

console.log('captions');
{
  const cases: Array<[string, string | null]> = [
    [': Results', 'Results'],
    ['Table: Results', 'Results'],
    ['table: Results', 'Results'],
    [':NoSpace', 'NoSpace'],
    [':   spaced   ', 'spaced'],
    [':: double', null],
    [':-) smile', null],
    ['TABLE: upper', null],
    [':', null],
    ['Results', null],
  ];
  for (const [line, want] of cases) {
    check(`captionFromLine ${JSON.stringify(line)}`, captionFromLine(line) === want, String(captionFromLine(line)));
  }
}
{
  const read = readMd('| A | B |\n| --- | --- |\n| 1 | 2 |\n: Mean of $x$ in 2024');
  check('markdown-it reads a caption line as a body row', read.childCount === 3, show(read.toJSON()));
  const taken = takeCaptionLine(read);
  check('takeCaptionLine pops it and keeps math as $…$', taken?.caption === 'Mean of $x$ in 2024' && taken.table.childCount === 2, show(taken));
  const back = readPipeTable(read, null);
  check('readPipeTable sets the caption', back.attrs.caption === 'Mean of $x$ in 2024' && back.childCount === 2, show(back.attrs));
  const prefixed = readPipeTable(readMd('| A | B |\n| --- | --- |\n| 1 | 2 |\nTable: Prefixed'), null);
  check('a Table: line is a caption too', prefixed.attrs.caption === 'Prefixed', show(prefixed.attrs));
  const row = readMd('| A | B |\n| --- | --- |\n| : x | y |');
  check('a row whose other cells hold text is not a caption', takeCaptionLine(row) === null);
  const only = readMd('| A |\n| --- |');
  check('a header row alone is never a caption', takeCaptionLine(only) === null);
  const warnings: string[] = [];
  const both = readPipeTable(read, { id: '', classes: ['table'], keyvals: [['caption', 'From the div']] }, (w) => warnings.push(w));
  check('a caption attribute wins; the line stays a row, with a warning',
    both.attrs.caption === 'From the div' && both.childCount === 3 && warnings.some((w) => w.includes('caption line')), `${show(both.attrs)} ${warnings.join('; ')}`);
  const fn = table([tr([th('A')]), tr([table_cell.create(null, paragraph.create(null, [schema.text(': Cap'), schema.nodes.footnote.create(null, schema.text('n'))]))])]);
  const fnWarnings: string[] = [];
  const fnTaken = takeCaptionLine(fn, (w) => fnWarnings.push(w));
  check('a footnote in a caption line drops with a warning', fnTaken?.caption === 'Cap' && fnWarnings.some((w) => w.includes('footnote')), `${show(fnTaken)} ${fnWarnings.join('; ')}`);
}
{
  // The source line decides, as it does for pandoc: a line with a cell pipe
  // is a row; one without is a caption.
  const t = table([tr([th('Key'), th('Value')]), tr([td(': x'), td('')])]);
  const r = trip(t);
  check('a written last row that reads like a caption stays a row', same(r.back.toJSON(), t.toJSON()) && !r.back.attrs.caption, `${r.md}\n${show(r.back.toJSON())}`);
  check('… only the source line tells (without it the row is taken)', takeCaptionLine(readMd(r.md))?.caption === 'x');
  const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n: a \\| b';
  check('a caption line with an escaped pipe is a caption', readPipeTable(readMd(md), null, undefined, ': a \\| b').attrs.caption === 'a | b');
  check('a caption line with math is a caption', takeCaptionLine(readMd('| A |\n| --- |\n| 1 |\n: $|x|$'), undefined, ': $|x|$')?.caption === '$|x|$');
}
{
  // A caption written by Plass goes in the div and comes back from it.
  const t = table([tr([th('A')]), tr([td('1')])], { caption: 'Plain: with a colon | and a pipe' });
  const r = trip(t);
  check('a caption is a div attribute, never a caption line', kv(r.attrs).caption === t.attrs.caption && !r.md.includes('Plain'), r.md);
  check('… and reads back', r.back.attrs.caption === t.attrs.caption, show(r.back.attrs));
}

// ---------- the blank header line, read side ----------

console.log('blank header line');
{
  const headerless = readPipeTable(readMd('|   |   |\n| --- | --- |\n| a | 1 |'), null);
  check('the reader drops a header row whose cells are all empty', headerless.childCount === 1 && headerless.child(0).child(0).type === table_cell, show(headerless.toJSON()));
  const kept = readPipeTable(readMd('| A |   |\n| --- | --- |\n| a | 1 |'), null);
  check('a header row with any text stays', kept.childCount === 2 && kept.child(0).child(0).type === table_header, show(kept.toJSON()));
  const alone = readPipeTable(readMd('|   |   |\n| --- | --- |'), null);
  check('a blank header line with no body stays as one empty body row', alone.childCount === 1 && alone.child(0).child(0).type === table_cell, show(alone.toJSON()));
  const withAttrs = readPipeTable(readMd('|   |   |\n| --- | --- |\n| a | 1 |\n| b | 2 |'), { id: '', classes: ['table'], keyvals: [['fills', 'r1c0:blue']] });
  check('div positions apply after the blank header line is dropped', withAttrs.child(1).child(0).attrs.fill === 'blue' && withAttrs.child(0).child(0).attrs.fill === '', show(withAttrs.toJSON()));
}

// ---------- the grammar example ----------

console.log('grammar example');
{
  // The plan's example, made consistent: its span covers a cell holding
  // text and its `aligns` names the covered position, which the reader
  // refuses (a span never swallows text); here the span covers an empty cell.
  const md = '| Name | Score | Note |\n|:-----|------:|-----:|\n| a    | 12.5  | x    |\n| b    | 3.25  | y    |\n| c    |       |      |';
  const attrs: DivAttrs = {
    id: 'tbl:x',
    classes: ['table'],
    keyvals: [
      ['caption', 'Results'], ['style', 'grid'], ['density', 'compact'], ['inset', '9pt'], ['columns', 'auto 1fr 2fr'],
      ['font-size', '0.85em'], ['decimal', '2'], ['rules', '1:light 3:none'], ['fills', 'r0:gray-dark r3c1:yellow'],
      ['valign', 'r1c2:middle'], ['spans', 'r3c1:2x1'], ['aligns', 'r2c1:center'],
    ],
  };
  const warnings: string[] = [];
  const t = readPipeTable(readMd(md), attrs, (w) => warnings.push(w));
  const cell = (r: number, c: number) => t.child(r).child(c).attrs;
  check('the example reads with no warning', !warnings.length, warnings.join('; '));
  check('table attributes', t.attrs.label === 'tbl:x' && t.attrs.caption === 'Results' && t.attrs.style === 'grid' && t.attrs.density === 'compact'
    && t.attrs.insetPt === 9 && same(t.attrs.columnWidths, ['auto', '1fr', '2fr']) && t.attrs.fontSize === '0.85em', show(t.attrs));
  check('decimal column 2', cell(1, 2).align === 'decimal' && cell(2, 2).align === 'decimal' && cell(1, 1).align === 'right', show(t.toJSON()));
  check('rules', t.child(1).attrs.rule === 'light' && t.child(3).attrs.rule === 'none' && t.child(0).attrs.rule === '');
  check('fills', cell(0, 0).fill === 'gray-dark' && cell(0, 2).fill === 'gray-dark' && cell(3, 1).fill === 'yellow' && cell(1, 0).fill === '');
  check('valign', cell(1, 2).valign === 'middle' && cell(1, 1).valign === null);
  check('span', t.child(3).childCount === 2 && cell(3, 1).colspan === 2, show(t.child(3).toJSON()));
  check('aligns', cell(2, 1).align === 'center');
  const again = tableDivAttrs(t);
  check('writing it back gives the same attributes', same(again, attrs), `${show(again)}\nvs\n${show(attrs)}`);
  const asPlanned = applyTableDivAttrs(readPipeTable(readMd(md), null), { ...attrs, keyvals: attrs.keyvals.map(([k, v]) => [k, k === 'spans' ? 'r2c0:2x1' : k === 'aligns' ? 'r2c1:center' : v] as [string, string]) }, (w) => warnings.push(w));
  check('the plan\'s literal span over "3.25" keeps the text, with a warning', asPlanned.child(2).childCount === 3 && warnings.some((w) => w.includes('"r2c0:2x1" would cover')), warnings.join('; '));
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall md-tables tests passed');
}
