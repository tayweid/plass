// Fenced divs (md-divs.ts) and attribute blocks (md-attrs.ts): pandoc
// 3.4's syntax, case by case. Every structure and every attribute value
// below was checked against `pandoc -f markdown -t native` (3.4); the few
// places the reader departs from pandoc say so where they are tested.
//
// The div rule is exercised in the markdown-it instance the reader uses
// (md-parser.ts: `new MarkdownIt({ html: true }).use(footnotePlugin)`),
// and each case compares the whole token stream.
// Run: npx tsx src/md-divs.test.ts
import MarkdownIt from 'markdown-it';
import footnotePlugin from 'markdown-it-footnote';
import { fencedDivs, type DivMeta } from './md-divs';
import { readAttrBlock, readTrailingAttrBlock, writeAttrBlock, writeFenceAttrs, type PandocAttrs } from './md-attrs';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const md = new MarkdownIt({ html: true }).use(footnotePlugin).use(fencedDivs);
type Parser = typeof md;

/** Attributes in pandoc's order, values quoted: `{#id .a k="v"}`. */
function showAttrs(a: PandocAttrs): string {
  const parts = [...(a.id ? [`#${a.id}`] : []), ...a.classes.map((c) => `.${c}`), ...a.kvs.map(([k, v]) => `${k}=${JSON.stringify(v)}`)];
  return `{${parts.join(' ')}}`;
}

/** The token stream, one token per line, indented by nesting level. */
function stream(src: string, parser: Parser = md): string[] {
  return parser.parse(src, {}).map((t) => {
    let s = '  '.repeat(t.level) + t.type;
    if (t.map) s += ` ${t.map[0]}-${t.map[1]}`;
    if (t.type === 'inline' || t.type === 'fence' || t.type === 'html_block' || t.type === 'code_block') s += ` ${JSON.stringify(t.content)}`;
    if (t.type === 'div_open') {
      const meta = t.meta as DivMeta;
      s += ` ${showAttrs(meta.attrs)}${meta.glued ? ' glued' : ''}${meta.unclosed ? ' unclosed' : ''}`;
    }
    return s;
  });
}

function expectStream(name: string, src: string, expected: string[], parser: Parser = md) {
  const got = stream(src, parser);
  const ok = got.length === expected.length && got.every((line, i) => line === expected[i]);
  check(name, ok, `\n    got:\n      ${got.join('\n      ')}\n    expected:\n      ${expected.join('\n      ')}`);
}

const para = (level: number, from: number, to: number, text: string) => {
  const pad = '  '.repeat(level);
  return [`${pad}paragraph_open ${from}-${to}`, `${pad}  inline ${from}-${to} ${JSON.stringify(text)}`, `${pad}paragraph_close`];
};

// --- 1. the plan's .table example: the closer right after the last pipe row ---
const TABLE = `::: {#tbl:x .table caption="Results" style=grid density=compact}
| Name | Score |
|:-----|------:|
| a    | 12.5  |
:::
`;
const TABLE_BODY = [
  '  table_open 1-4',
  '    thead_open 1-2',
  '      tr_open 1-2',
  '        th_open',
  '          inline "Name"',
  '        th_close',
  '        th_open',
  '          inline "Score"',
  '        th_close',
  '      tr_close',
  '    thead_close',
  '    tbody_open 3-4',
  '      tr_open 3-4',
  '        td_open',
  '          inline "a"',
  '        td_close',
  '        td_open',
  '          inline "12.5"',
  '        td_close',
  '      tr_close',
  '    tbody_close',
  '  table_close',
];
expectStream('table div: the closer right after the last row ends the table and the div', TABLE, [
  'div_open 0-5 {#tbl:x .table caption="Results" style="grid" density="compact"}',
  ...TABLE_BODY,
  'div_close 4-5',
]);
{
  // Why the rule sits in the terminator chains: registered without them,
  // the closer is one more table row and the div never closes.
  const bare = new MarkdownIt({ html: true }).use(footnotePlugin).use(fencedDivs);
  const rule = bare.block.ruler.getRules('')[0];
  const noAlt = new MarkdownIt({ html: true }).use(footnotePlugin);
  noAlt.block.ruler.before('table', 'div', rule);
  const got = stream(TABLE, noAlt);
  check(
    'without the alt chains the closer is swallowed as a row',
    got.includes('      tr_open 4-5') && got[0].endsWith(' unclosed'),
    got.join(' | '),
  );
}

// --- 2. closers right after a paragraph line, a list item, a quote line ---
expectStream('closer right after a paragraph line', '::: solution\nSome text\n:::\n', [
  'div_open 0-3 {.solution}',
  ...para(1, 1, 2, 'Some text'),
  'div_close 2-3',
]);
expectStream('closer right after a list item', '::: solution\n- item one\n- item two\n:::\n', [
  'div_open 0-4 {.solution}',
  '  bullet_list_open 1-3',
  '    list_item_open 1-2',
  '      paragraph_open 1-2',
  '        inline 1-2 "item one"',
  '      paragraph_close',
  '    list_item_close',
  '    list_item_open 2-3',
  '      paragraph_open 2-3',
  '        inline 2-3 "item two"',
  '      paragraph_close',
  '    list_item_close',
  '  bullet_list_close',
  'div_close 3-4',
]);
expectStream('closer right after a quote line', '::: solution\n> quoted\n:::\n', [
  'div_open 0-3 {.solution}',
  '  blockquote_open 1-2',
  ...para(2, 1, 2, 'quoted'),
  '  blockquote_close',
  'div_close 2-3',
]);
expectStream("closer right after a quote's lazy continuation", '::: solution\n> quote\ncontinued\n:::\n', [
  'div_open 0-4 {.solution}',
  '  blockquote_open 1-3',
  ...para(2, 1, 3, 'quote\ncontinued'),
  '  blockquote_close',
  'div_close 3-4',
]);
expectStream('text right after the closer is a new paragraph', '::: solution\ntext\n:::\nafter\n', [
  'div_open 0-3 {.solution}',
  ...para(1, 1, 2, 'text'),
  'div_close 2-3',
  ...para(0, 3, 4, 'after'),
]);

// --- 3. an opener with no blank line before it: accepted, flagged ---
// Pandoc reads this opener (and the rest) as paragraph text; the reader
// warns, and the writer's blank line before every ::: heals it on save.
expectStream('opener directly after a paragraph line: a div, flagged glued', 'Para text\n::: solution\ninside\n:::\n', [
  ...para(0, 0, 1, 'Para text'),
  'div_open 1-4 {.solution} glued',
  ...para(1, 2, 3, 'inside'),
  'div_close 3-4',
]);
expectStream("opener directly after a list item's line: flagged glued", '- item\n::: solution\nx\n:::\n', [
  'bullet_list_open 0-1',
  '  list_item_open 0-1',
  '    paragraph_open 0-1',
  '      inline 0-1 "item"',
  '    paragraph_close',
  '  list_item_close',
  'bullet_list_close',
  'div_open 1-4 {.solution} glued',
  ...para(1, 2, 3, 'x'),
  'div_close 3-4',
]);
// Pandoc opens a div with no blank line after a heading, a table, another
// fence: not flagged.
expectStream('opener directly after a heading: not flagged', '# H\n::: solution\nx\n:::\n', [
  'heading_open 0-1',
  '  inline 0-1 "H"',
  'heading_close',
  'div_open 1-4 {.solution}',
  ...para(1, 2, 3, 'x'),
  'div_close 3-4',
]);
{
  const got = stream('| a | b |\n|---|---|\n| 1 | 2 |\n::: solution\nx\n:::\n');
  check('opener directly after a table row: ends the table, not flagged', got.includes('div_open 3-6 {.solution}') && got.at(-1) === 'div_close 5-6', got.join(' | '));
}
expectStream('nested openers and closers with no blank lines at all', '::: a\n::: b\nx\n:::\n:::\n', [
  'div_open 0-5 {.a}',
  '  div_open 1-4 {.b}',
  ...para(2, 2, 3, 'x'),
  '  div_close 3-4',
  'div_close 4-5',
]);

// --- 4. openers: attribute blocks, quoted and bare values, an id ---
expectStream('an id, classes, bare and quoted values', `::: {#my-id .a .b key=val k2="two words" k3='single q' k4="esc \\"q\\""}\ntext\n:::\n`, [
  'div_open 0-3 {#my-id .a .b key="val" k2="two words" k3="single q" k4="esc \\"q\\""}',
  ...para(1, 1, 2, 'text'),
  'div_close 2-3',
]);
expectStream('a multi-line opener: the block runs to its closing brace', '::: {.columns\n  gutter=1em\n  cols=2}\ninside\n:::\n', [
  'div_open 0-5 {.columns gutter="1em" cols="2"}',
  ...para(1, 3, 4, 'inside'),
  'div_close 4-5',
]);
expectStream('a quoted value over a line break reads the break as a space', '::: {.a k="x\ny"}\ntext\n:::\n', [
  'div_open 0-4 {.a k="x y"}',
  ...para(1, 2, 3, 'text'),
  'div_close 3-4',
]);
expectStream('a block broken by a blank line is no block: the bare word is the class', '::: {.a\n\n  .b}\ntext\n:::\n', [
  'div_open 0-5 {.{.a}',
  ...para(1, 2, 4, '.b}\ntext'),
  'div_close 4-5',
]);
for (const [opener, cls] of [
  [':::solution', 'solution'],
  [':::{.solution}', 'solution'],
  ['::: solution :::', 'solution'],
  [':::: {.solution} ::::  ', 'solution'],
  [':::\tsolution', 'solution'],
  ['::: .solution', '.solution'],
  ['::: callout-note', 'callout-note'],
  ['::: a{b}', 'a{b}'],
  ['::: {foo}', '{foo}'],
  ['::: {k="x"y}', '{k="x"y}'],
] as const) {
  const got = stream(`${opener}\nx\n:::\n`);
  check(`opener ${JSON.stringify(opener)} is the class ${JSON.stringify(cls)}`, got[0] === `div_open 0-3 {.${cls}}`, got[0]);
}
for (const line of ['::: solution extra', '::: {.a} junk', '::: solution {.x}', ':: solution', '   ::: solution', ' ::: solution', `::: {k="x"y k2='a'"b"}`]) {
  const got = stream(`${line}\ntext\n:::\n`);
  check(`${JSON.stringify(line)} is no opener: paragraph text`, got.length === 3 && got[0] === 'paragraph_open 0-3', got.join(' | '));
}
expectStream('an opener indented four spaces is a code block', '    ::: solution\n    text\n    :::\n', [
  'code_block 0-3 "::: solution\\ntext\\n:::\\n"',
]);

// --- 5. nesting, unknown classes, empty and closers' forms ---
expectStream(
  'nested divs: a solution holding a two-column grid',
  '::: solution\nouter\n\n::: {.columns gutter=1em cols=2}\n::: {.column width=60%}\nleft\n:::\n::: column\nright\n:::\n:::\nafter\n:::\n',
  [
    'div_open 0-13 {.solution}',
    ...para(1, 1, 2, 'outer'),
    '  div_open 3-11 {.columns gutter="1em" cols="2"}',
    '    div_open 4-7 {.column width="60%"}',
    ...para(3, 5, 6, 'left'),
    '    div_close 6-7',
    '    div_open 7-10 {.column}',
    ...para(3, 8, 9, 'right'),
    '    div_close 9-10',
    '  div_close 10-11',
    ...para(1, 11, 12, 'after'),
    'div_close 12-13',
  ],
);
expectStream('an unknown class is a div like any other (the reader decides)', '::: weird\ntext\n:::\n', [
  'div_open 0-3 {.weird}',
  ...para(1, 1, 2, 'text'),
  'div_close 2-3',
]);
expectStream('an empty div', '::: solution\n:::\n', ['div_open 0-2 {.solution}', 'div_close 1-2']);
expectStream('a longer closer, trailing spaces', ':::: solution\ntext\n:::::   \n', [
  'div_open 0-3 {.solution}',
  ...para(1, 1, 2, 'text'),
  'div_close 2-3',
]);
expectStream('a div inside a quote', '> ::: solution\n> text\n> :::\n', [
  'blockquote_open 0-3',
  '  div_open 0-3 {.solution}',
  ...para(2, 1, 2, 'text'),
  '  div_close 2-3',
  'blockquote_close',
]);

// --- 6. closers that are not: fences, comments, stray, nested, indented ---
expectStream('::: inside a backtick fence is code', '::: solution\n```\n:::\n```\n:::\n', [
  'div_open 0-5 {.solution}',
  '  fence 1-4 ":::\\n"',
  'div_close 4-5',
]);
expectStream('::: inside a tilde fence is code', '::: solution\n~~~~ text\n:::\n::: other\n~~~~\n:::\n', [
  'div_open 0-6 {.solution}',
  '  fence 1-5 ":::\\n::: other\\n"',
  'div_close 5-6',
]);
expectStream('::: inside an HTML comment is the comment', '::: solution\n<!--\n:::\n-->\ntext\n:::\n', [
  'div_open 0-6 {.solution}',
  '  html_block 1-4 "<!--\\n:::\\n-->\\n"',
  ...para(1, 4, 5, 'text'),
  'div_close 5-6',
]);
expectStream('a comment line directly before the closer', '::: solution\n<!-- note -->\n:::\n', [
  'div_open 0-3 {.solution}',
  '  html_block 1-2 "<!-- note -->\\n"',
  'div_close 2-3',
]);
expectStream('a stray closer is text', 'text\n\n:::\n\nmore\n', [...para(0, 0, 1, 'text'), ...para(0, 2, 3, ':::'), ...para(0, 4, 5, 'more')]);
expectStream('a stray closer after a paragraph line continues it', 'text\n:::\nmore\n', [...para(0, 0, 3, 'text\n:::\nmore')]);
expectStream('a closer indented one space is text (pandoc)', '::: solution\ntext\n :::\nafter\n', [
  'div_open 0-4 {.solution} unclosed',
  ...para(1, 1, 4, 'text\n :::\nafter'),
  'div_close',
]);
expectStream('a closer at a list item\'s column is that item\'s text; the next one closes', '::: solution\n- item\n  :::\n:::\n', [
  'div_open 0-4 {.solution}',
  '  bullet_list_open 1-3',
  '    list_item_open 1-3',
  ...para(3, 1, 2, 'item'),
  ...para(3, 2, 3, ':::'),
  '    list_item_close',
  '  bullet_list_close',
  'div_close 3-4',
]);
expectStream("a closer inside a quote is the quote's text", '::: a\n> x\n> :::\n:::\n', [
  'div_open 0-4 {.a}',
  '  blockquote_open 1-3',
  ...para(2, 1, 2, 'x'),
  ...para(2, 2, 3, ':::'),
  '  blockquote_close',
  'div_close 3-4',
]);
expectStream('an opener-like line with trailing text inside a div is a glued opener', '::: solution\ntext\n::: more\n:::\n', [
  'div_open 0-4 {.solution} unclosed',
  ...para(1, 1, 2, 'text'),
  '  div_open 2-4 {.more} glued',
  '  div_close 3-4',
  'div_close',
]);
// Markdown-it's HTML block runs to the next blank line, as md-parser's
// math pre-pass assumes, so a closer directly under an HTML line is in the
// block. (Pandoc parses Markdown inside the element and closes the div
// there: a known divergence; the writer's blank lines avoid it.)
expectStream('a closer directly under an HTML line is inside the HTML block', '::: solution\n<div style="x">\n</div>\n:::\n', [
  'div_open 0-4 {.solution} unclosed',
  '  html_block 1-4 "<div style=\\"x\\">\\n</div>\\n:::\\n"',
  'div_close',
]);
expectStream('inline HTML at a line start inside a paragraph does not hide the closer', '::: solution\nSome text with\n<b>bold</b> continuing\n:::\n', [
  'div_open 0-4 {.solution}',
  ...para(1, 1, 3, 'Some text with\n<b>bold</b> continuing'),
  'div_close 3-4',
]);

// --- 7. an unclosed div: closed implicitly at its container's end, nothing lost ---
// Pandoc 3.4: "Div at line 1 column 1 unclosed …, closing implicitly."
expectStream('an unclosed div ends at the end of the document, flagged', '::: solution\ntext\n\nmore\n', [
  'div_open 0-4 {.solution} unclosed',
  ...para(1, 1, 2, 'text'),
  ...para(1, 3, 4, 'more'),
  'div_close',
]);
expectStream('an unclosed div in a quote ends with the quote', '> ::: solution\n> text\n\nafter\n', [
  'blockquote_open 0-2',
  '  div_open 0-2 {.solution} unclosed',
  ...para(2, 1, 2, 'text'),
  '  div_close',
  'blockquote_close',
  ...para(0, 3, 4, 'after'),
]);
expectStream('an inner div closed, the outer one not', '::: a\n::: b\nx\n:::\n', [
  'div_open 0-4 {.a} unclosed',
  '  div_open 1-4 {.b}',
  ...para(2, 2, 3, 'x'),
  '  div_close 3-4',
  'div_close',
]);
// Departure: pandoc's lazy continuation also takes an unprefixed closer for
// a div opened in a quote; here a closer belongs to its opener's container.
expectStream('a closer without the quote marker is the quote paragraph\'s lazy text', '> ::: solution\n> text\n:::\n', [
  'blockquote_open 0-3',
  '  div_open 0-3 {.solution} unclosed',
  ...para(2, 1, 3, 'text\n:::'),
  '  div_close',
  'blockquote_close',
]);
{
  // Footnotes inside a div: the plugin moves the definition to the tail;
  // the div's tokens stay balanced around what remains.
  const tokens = md.parse('::: solution\nText[^1]\n\n[^1]: Note\n:::\n\nafter\n', {});
  const opens = tokens.filter((t) => t.type === 'div_open').length;
  const closes = tokens.filter((t) => t.type === 'div_close').length;
  const meta = tokens[0].meta as DivMeta;
  check('a footnote definition inside a div', tokens[0].type === 'div_open' && !meta.unclosed && opens === 1 && closes === 1 && tokens.some((t) => t.type === 'footnote_open'), stream('::: solution\nText[^1]\n\n[^1]: Note\n:::\n').join(' | '));
}
{
  // Deep nesting stays linear and balanced.
  const depth = 60;
  const src = '::: d\n'.repeat(depth) + 'x\n' + ':::\n'.repeat(depth);
  const tokens = md.parse(src, {});
  const opens = tokens.filter((t) => t.type === 'div_open');
  check('sixty nested divs open and close in order', opens.length === depth && opens.every((t) => !(t.meta as DivMeta).unclosed) && tokens.at(-1)!.type === 'div_close', `${opens.length} opens`);
  const unclosed = md.parse('::: d\n'.repeat(depth) + 'x\n', {});
  check('sixty unclosed divs all close at the end', unclosed.filter((t) => t.type === 'div_close').length === depth, String(unclosed.length));
  // Past markdown-it's nesting limit (100 levels) an opener is text, never
  // dropped content.
  const deep = md.parse('::: d\n'.repeat(150) + 'x\n', {});
  const text = deep.filter((t) => t.type === 'inline').map((t) => t.content).join('\n');
  check(
    'openers past the nesting limit stay text: nothing dropped',
    deep.filter((t) => t.type === 'div_open').length === 99 && text === '::: d\n'.repeat(51) + 'x',
    `${deep.filter((t) => t.type === 'div_open').length} divs, text ${JSON.stringify(text.slice(0, 40))}`,
  );
}

// --- 8. md-attrs: the attribute grammar ---
type Attr = [id: string, classes: string[], kvs: Array<[string, string]>];
const ATTR_CASES: Array<[string, Attr | null]> = [
  ['{#tbl:x .table caption="Results" style=grid density=compact}', ['tbl:x', ['table'], [['caption', 'Results'], ['style', 'grid'], ['density', 'compact']]]],
  ['{.columns gutter=1em cols=2}', ['', ['columns'], [['gutter', '1em'], ['cols', '2']]]],
  ['{.column width=60%}', ['', ['column'], [['width', '60%']]]],
  ['{}', ['', [], []]],
  ['{  .a   #b  }', ['b', ['a'], []]],
  ['{.a\t.b}', ['', ['a', 'b'], []]],
  ['{.a.b #c.d}', ['c.d', ['a.b'], []]],
  ['{.a#b}', ['b', ['a'], []]],
  ['{#a #b}', ['b', [], []]],
  ['{.a .a}', ['', ['a', 'a'], []]],
  ['{k=1 k=2}', ['', [], [['k', '1'], ['k', '2']]]],
  ['{id=foo class="a b" .c}', ['foo', ['a', 'b', 'c'], []]],
  ['{#a id=b}', ['b', [], []]],
  ['{id=b #a}', ['a', [], []]],
  ['{id="x y"}', ['x y', [], []]],
  ['{-}', ['', ['unnumbered'], []]],
  ['{#h - .x}', ['h', ['unnumbered', 'x'], []]],
  ['{-.a}', ['', ['unnumbered', 'a'], []]],
  ['{--}', ['', ['unnumbered', 'unnumbered'], []]],
  ['{-k=1}', ['', ['unnumbered'], [['k', '1']]]],
  // identifiers: an id is any run of letters, digits, -_:. ; a class or key
  // starts with a letter
  ['{#1abc}', ['1abc', [], []]],
  ['{#-x}', ['-x', [], []]],
  ['{#:x}', [':x', [], []]],
  ['{#_x}', ['_x', [], []]],
  ['{#a- .b-}', ['a-', ['b-'], []]],
  ['{#eq:a.b_c-d}', ['eq:a.b_c-d', [], []]],
  ['{#é .ü}', ['é', ['ü'], []]],
  ['{.résumé}', ['', ['résumé'], []]],
  ['{#a١}', ['a١', [], []]],
  ['{.2x}', null],
  ['{._x}', null],
  ['{.-x}', null],
  ['{.:x}', null],
  ['{1k=1}', null],
  ['{_k=1}', null],
  ['{# .a}', null],
  ['{. .a}', null],
  ['{foo}', null],
  ['{#a/b}', null],
  ['{.a+b}', null],
  ['{data-x=1 my_key=2 a:b=3 a.b=4}', ['', [], [['data-x', '1'], ['my_key', '2'], ['a:b', '3'], ['a.b', '4']]]],
  // values
  ['{k=a=b k2=a"b"c}', ['', [], [['k', 'a=b'], ['k2', 'a"b"c']]]],
  ['{k="a}b"}', ['', [], [['k', 'a}b']]]],
  ['{k=a\\}b k2=c\\ d}', ['', [], [['k', 'a}b'], ['k2', 'c d']]]],
  ['{k=a\\nb k2=a\\\\b}', ['', [], [['k', 'a\\nb'], ['k2', 'a\\b']]]],
  ['{k=a\\—b k2=a\\éb}', ['', [], [['k', 'a—b'], ['k2', 'a\\éb']]]],
  ["{k='it\\'s'}", ['', [], [['k', "it's"]]]],
  ['{k="a\\\\b\\nc"}', ['', [], [['k', 'a\\b\\nc']]]],
  ['{k=\'a\\"b\' k2="a\\\'b"}', ['', [], [['k', 'a"b'], ['k2', "a'b"]]]],
  ['{k="a\\\\"}', ['', [], [['k', 'a\\']]]],
  ['{k="" k2=\'\'}', ['', [], [['k', ''], ['k2', '']]]],
  ['{k= .a}', ['', ['a'], [['k', '']]]],
  ['{k="a "}', ['', [], [['k', 'a ']]]],
  ['{k="a   b"}', ['', [], [['k', 'a   b']]]],
  ['{class="a b "}', ['', ['a', 'b'], []]],
  ['{k="\\ a"}', ['', [], [['k', ' a']]]],
  ['{k=" a"}', null],
  ['{k="  a"}', null],
  ["{k=' a'}", null],
  ['{k="\ta"}', null],
  ['{class="  a   b "}', null],
  ['{k="x"y}', null],
  ['{k="x".a}', ['', ['a'], [['k', 'x']]]],
  ['{k="x"y=1}', ['', [], [['k', 'x'], ['y', '1']]]],
  ['{k="abc}', ['', [], [['k', '"abc']]]],
  ['{k=a\'b}', ['', [], [['k', "a'b"]]]],
  ['{k=“a”}', ['', [], [['k', '“a”']]]],
  ['{k="a&amp;b" k2=c&amp;d k3=\'e&lt;f\'}', ['', [], [['k', 'a&b'], ['k2', 'c&amp;d'], ['k3', 'e<f']]]],
  ['{k="&#65;&#x42;"}', ['', [], [['k', 'AB']]]],
  ["{k='&foo;'}", ['', [], [['k', '&foo;']]]],
  ['{caption="Costs \\"&\\" \\&amp; more"}', ['', [], [['caption', 'Costs "&" &amp; more']]]],
  // line breaks: one is a separator (or a space in a quoted value); a
  // blank line fails the block
  ['{.a\n.b\n}', ['', ['a', 'b'], []]],
  ['{\n.a}', ['', ['a'], []]],
  ['{.a k="x\n    y"}', ['', ['a'], [['k', 'x     y']]]],
  ['{.a\n\n.b}', null],
  ['{k="x\n\ny"}', null],
  ['{.a', null],
];
for (const [src, want] of ATTR_CASES) {
  const got = readAttrBlock(src, 0);
  const gotTuple = got && [got.attrs.id, got.attrs.classes, got.attrs.kvs];
  const ok = JSON.stringify(gotTuple) === JSON.stringify(want) && (!got || got.end === src.length);
  check(`attrs ${JSON.stringify(src)}`, ok, `got ${JSON.stringify(gotTuple)} end ${got?.end}, want ${JSON.stringify(want)}`);
}
{
  const at = readAttrBlock('![Cap](f.svg){#fig:f width=60%} more', 13);
  check('a block read mid-line ends after its brace', at?.end === 31 && at.attrs.id === 'fig:f' && at.attrs.kvs[0][1] === '60%', JSON.stringify(at));
  check('no block where there is no brace', readAttrBlock('x {#a}', 0) === null);
}

// Headings and display math: the block that ends the line.
const TRAILING: Array<[string, string | null, Attr | null]> = [
  ['Title {#sec:x .unnumbered k=v}', 'Title ', ['sec:x', ['unnumbered'], [['k', 'v']]]],
  ['Title {-}', 'Title ', ['', ['unnumbered'], []]],
  ['Title{#x}', 'Title', ['x', [], []]],
  ['A {.x} {#y}', 'A {.x} ', ['y', [], []]],
  ['A {#x}   ', 'A ', ['x', [], []]],
  ['A {k="{#y}"}', 'A ', ['', [], [['k', '{#y}']]]],
  ['A {#x} trailing', null, null],
  ['A \\{#x}', null, null],
  ['A \\\\{#x}', 'A \\\\', ['x', [], []]],
  ['A {#x', null, null],
  ['$$ x $$ {#eq:x .unnumbered}', '$$ x $$ ', ['eq:x', ['unnumbered'], []]],
];
for (const [text, before, want] of TRAILING) {
  const got = readTrailingAttrBlock(text);
  const gotTuple = got && [got.attrs.id, got.attrs.classes, got.attrs.kvs];
  const ok = JSON.stringify(gotTuple) === JSON.stringify(want) && (got ? text.slice(0, got.start) === before : before === null);
  check(`trailing attrs ${JSON.stringify(text)}`, ok, `got ${JSON.stringify(gotTuple)} at ${got?.start}`);
}

// --- 9. md-attrs: the writer ---
const a = (id: string, classes: string[], kvs: Array<[string, string]> = []): PandocAttrs => ({ id, classes, kvs });
const WRITES: Array<[PandocAttrs, string, string]> = [
  [a('', ['solution']), '{.solution}', 'solution'],
  [a('', ['columns'], [['gutter', '1em'], ['cols', '2']]), '{.columns gutter=1em cols=2}', '{.columns gutter=1em cols=2}'],
  [a('', ['column'], [['width', '33.333%']]), '{.column width=33.333%}', '{.column width=33.333%}'],
  [
    a('tbl:x', ['table'], [['caption', 'Results'], ['columns', 'auto 1fr 2fr'], ['font-size', '0.85em'], ['fills', 'r0:gray-dark r3c1:yellow']]),
    '{#tbl:x .table caption=Results columns="auto 1fr 2fr" font-size=0.85em fills="r0:gray-dark r3c1:yellow"}',
    '{#tbl:x .table caption=Results columns="auto 1fr 2fr" font-size=0.85em fills="r0:gray-dark r3c1:yellow"}',
  ],
  [a('eq:a.b', ['unnumbered']), '{#eq:a.b .unnumbered}', '{#eq:a.b .unnumbered}'],
  [a('', ['keep', 'center']), '{.keep .center}', '{.keep .center}'],
  [a('x y', ['.solution', 'b']), '{id="x y" class=".solution" .b}', '{id="x y" class=".solution" .b}'],
  [a('', ['{.a']), '{class="{.a"}', '{class="{.a"}'],
  [a('', [], [['k', '']]), '{k=""}', '{k=""}'],
  [a('', [], [['k', ' leading']]), '{k="\\ leading"}', '{k="\\ leading"}'],
  [a('', [], [['k', 'say "hi" \\ back']]), '{k="say \\"hi\\" \\\\ back"}', '{k="say \\"hi\\" \\\\ back"}'],
  [a('', [], [['k', 'literal &amp; and & alone']]), '{k="literal \\&amp; and & alone"}', '{k="literal \\&amp; and & alone"}'],
  [a('', [], [['k', 'tab\there']]), '{k="tab&#9;here"}', '{k="tab&#9;here"}'],
  [a('', [], [['k', 'a}b']]), '{k="a}b"}', '{k="a}b"}'],
  [a('', [], [['k', "'q"]]), '{k="\'q"}', '{k="\'q"}'],
];
for (const [attrs, block, fence] of WRITES) {
  const w = writeAttrBlock(attrs);
  const f = writeFenceAttrs(attrs);
  const back = readAttrBlock(w, 0);
  const same = back && JSON.stringify(back.attrs) === JSON.stringify(attrs) && back.end === w.length;
  check(`write ${block}`, w === block && f === fence && !!same, `block ${w} fence ${f} read back ${JSON.stringify(back?.attrs)}`);
}
{
  // A line break in a value is written as the space it would read back as.
  const back = readAttrBlock(writeAttrBlock(a('', [], [['k', 'two\nlines']])), 0);
  check('a line break in a value is written as a space', back?.attrs.kvs[0][1] === 'two lines', JSON.stringify(back));
  // Through the div rule: the fence form reads back as the same div.
  for (const [attrs] of WRITES) {
    const got = stream(`::: ${writeFenceAttrs(attrs)}\nx\n:::\n`)[0];
    check(`fence ${writeFenceAttrs(attrs)} reads back through the div rule`, got === `div_open 0-3 ${showAttrs(attrs)}`, got);
  }
  for (const bad of [a('', [], [['id', 'x']]), a('', [], [['class', 'x']]), a('', [], [['1k', 'x']]), a('', ['a b']), a('', [''])]) {
    let threw = false;
    try {
      writeAttrBlock(bad);
    } catch {
      threw = true;
    }
    check(`no block can say ${JSON.stringify(bad)}: the writer throws`, threw);
  }
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('md-divs: all checks passed');
