// Code blocks (code-language.ts, code-colors.ts, code-block.ts): what a
// fence's info string names as its language, the raw block the export
// prints for it, the compiler's color answer read back onto the block's
// text, the list the language field offers, and Enter on a fence.
// Run: npm test
//
// The compiler itself is asked in the browser suite (tests/code-colors
// .spec.ts): the page's colors against the in-app Typst's.
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { CODE_LANGUAGES, cleanLanguage, fenceLang, rawBlockTyp } from './code-language.ts';
import { codeColorSource, codeSpans } from './code-colors.ts';
import { enterFence, languageMatches } from './code-block.ts';
import { docToTyp } from './typ-serializer.ts';
import { mdToDoc } from './md-parser.ts';
import { docToMd } from './md-serializer.ts';
import { schema } from './schema.ts';
import { ensureMathConverter } from './math-convert.ts';

await ensureMathConverter();

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? '\n' + detail : ''}`);
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------- the language a fence names ----------
{
  const cases: Array<[string, string]> = [
    ['python', 'python'],
    ['  r  ', 'r'],
    ['c++', 'c++'],
    ['c#', 'c#'],
    ['', ''],
    // An island is no language, and neither is a raw fence.
    ['typst-raw', ''],
    ['md-raw', ''],
    ['{=latex}', ''],
    // The first word, as pandoc reads it; then an attribute block's first class.
    ['python title="x"', 'python'],
    ['python {.numberLines}', 'python'],
    ['{.python .numberLines startFrom="10"}', 'python'],
    ['{#lst:a .python}', 'python'],
    ['{#lst:a}', ''],
    // Nothing Typst would read as more than a tag.
    ['py`thon', ''],
    ['{.py"thon}', ''],
  ];
  for (const [info, lang] of cases) check(`fenceLang(${JSON.stringify(info)}) is ${JSON.stringify(lang)}`, fenceLang(info) === lang, `got ${JSON.stringify(fenceLang(info))}`);

  check('the field writes a tag: its own characters only', cleanLanguage('  Py thon`{}  ') === 'Python' && cleanLanguage('c++') === 'c++' && cleanLanguage('objective-c') === 'objective-c');
  check('the field never writes an island', cleanLanguage('typst-raw') === '' && cleanLanguage('md-raw') === '');
  check('every offered language is a tag the field would write', CODE_LANGUAGES.every((l) => cleanLanguage(l.tag) === l.tag && fenceLang(l.tag) === l.tag));
  check('no language is offered twice', new Set(CODE_LANGUAGES.map((l) => l.tag)).size === CODE_LANGUAGES.length);
}

// ---------- the raw block the export prints ----------
{
  check('a listing is a fence with its language', rawBlockTyp('python', 'x = 1') === '```python\nx = 1\n```');
  check('no language, no tag', rawBlockTyp('', 'x = 1') === '```\nx = 1\n```');
  check('a fence is longer than any backtick run in the code', rawBlockTyp('md', 'a\n```\nb\n````') === '`````md\na\n```\nb\n````\n`````');

  const block = (params: string, text: string) => schema.nodes.doc.create(null, [schema.nodes.code_block.create({ params }, text ? schema.text(text) : [])]);
  const typ = (params: string, text: string) => docToTyp(block(params, text), { islands: 'print' });
  check('the export tags the block with its language', typ('python', 'x = 1').includes('```python\nx = 1\n```'));
  // An info string with a space used to reach Typst whole: the tag ended at
  // the space and the rest was printed as the listing's first line.
  const spaced = typ('python title="demo"', 'x = 1');
  check('only the language of an info string reaches Typst', spaced.includes('```python\nx = 1\n```') && !spaced.includes('title'), spaced.slice(-120));
  check('an attribute block names the language too', typ('{.r .numberLines}', 'x <- 1').includes('```r\nx <- 1\n```'));
  check('code holding a fence cannot close its own', typ('', 'a\n```\nb').includes('````\na\n```\nb\n````'));
  check('an island prints with no language', typ('md-raw', '<div>x</div>').includes('```\n<div>x</div>\n```'));

  // The .md file keeps the info string as written, whatever its language is.
  for (const md of ['```python\nx = 1\n```\n', '```{.python .numberLines}\nx = 1\n```\n', '```python title="x"\nx = 1\n```\n']) {
    check(`the file keeps ${JSON.stringify(md.split('\n')[0])}`, docToMd(mdToDoc(md).doc) === md, docToMd(mdToDoc(md).doc));
  }
  check('the colors are asked with the block the export prints', codeColorSource('python', 'x = "```"').endsWith(rawBlockTyp('python', 'x = "```"') + '\n'));
}

// ---------- the compiler's answer, read onto the text ----------
{
  const row = (n: number, piece: string, fill = '#000000') => ({ func: 'metadata', value: [n, piece, fill], label: '<plass-code>' });
  const mark = (value: string) => ({ func: 'metadata', value, label: '<plass-code>' });

  // `def f(x):` then an indented return with a comment.
  const text = 'def f(x):\n    return 1  # c';
  const rows = [
    row(1, 'def', '#d73948'), row(1, ' '), row(1, 'f', '#4b69c6'), row(1, '('), row(1, 'x'), row(1, ')'), row(1, ':'),
    row(2, '    '), row(2, 'return', '#d73948'), row(2, ' '), row(2, '1', '#b60157'), row(2, '  '), row(2, '#', '#74747c'), row(2, ' c', '#74747c'),
  ];
  const spans = codeSpans(text, rows);
  check(
    'pieces become spans of the text, plain ones none, neighbours of one color one',
    same(spans, [
      { from: 0, to: 3, color: '#d73948', underline: false },
      { from: 4, to: 5, color: '#4b69c6', underline: false },
      { from: 14, to: 20, color: '#d73948', underline: false },
      { from: 21, to: 22, color: '#b60157', underline: false },
      { from: 24, to: 27, color: '#74747c', underline: false },
    ]),
    JSON.stringify(spans),
  );
  check('every span is the text it colors', !!spans && spans.map((s) => text.slice(s.from, s.to)).join('|') === 'def|f|return|1|# c');

  // A blank line reports nothing; lines are Typst's (a CR LF is one end).
  const blank = codeSpans('a\r\n\r\nb', [row(1, 'a', '#d73948'), row(3, 'b', '#198810')]);
  check('lines are counted as Typst counts them', same(blank?.map((s) => [s.from, s.to]), [[0, 1], [5, 6]]), JSON.stringify(blank));

  // A tab is laid out to the next stop (two columns): the spaces Typst
  // reports for it are the tab.
  const tabbed = codeSpans('\tx = 1\na\tb', [row(1, '  '), row(1, 'x'), row(1, ' '), row(1, '=', '#d73948'), row(1, ' '), row(1, '1', '#b60157'), row(2, 'a'), row(2, ' '), row(2, 'b', '#198810')]);
  check('a tab is the spaces Typst sets it as', same(tabbed?.map((s) => [s.from, s.to]), [[3, 4], [5, 6], [9, 10]]), JSON.stringify(tabbed));

  // An underline (a Typst listing's heading, a Markdown link) brackets its pieces.
  const under = codeSpans('[a](http://x.y)', [row(1, '['), row(1, 'a'), row(1, ']'), row(1, '('), mark('u+'), row(1, 'http://x.y'), mark('u-'), row(1, ')')]);
  check('an underline is a span of its own, in the text color', same(under, [{ from: 4, to: 14, color: null, underline: true }]), JSON.stringify(under));

  // Astral characters are two units of the text and one column.
  const astral = codeSpans('"😀"\t# c', [row(1, '"😀"', '#198810'), row(1, ' '), row(1, '# c', '#74747c')]);
  check('offsets are the text’s own units', same(astral?.map((s) => [s.from, s.to]), [[0, 4], [5, 8]]), JSON.stringify(astral));

  // An answer that does not account for the text exactly paints nothing.
  check('a piece that is not the text is refused', codeSpans('x = 1', [row(1, 'y'), row(1, ' = 1')]) === null);
  check('a line left unfinished is refused', codeSpans('x = 1', [row(1, 'x')]) === null);
  check('a line Typst skipped must be empty', codeSpans('a\nb', [row(1, 'a')]) === null);
  check('a line out of range is refused', codeSpans('a', [row(1, 'a'), row(2, 'b')]) === null);
  check('a line reported twice is refused', codeSpans('a\nb', [row(1, 'a'), row(2, 'b'), row(1, 'a')]) === null);
  check('a fill that is no color is refused', codeSpans('a', [row(1, 'a', 'red; background: url(x)')]) === null);
  check('a row of another shape is refused', codeSpans('a', [{ value: [1, 'a'] }]) === null);
  check('an empty block has no spans', same(codeSpans('', []), []));
}

// ---------- the list under the field ----------
{
  const tags = (typed: string) => languageMatches(typed).map((l) => l.tag);
  check('an empty field offers every language, Python first', same(tags(''), CODE_LANGUAGES.map((l) => l.tag)) && tags('')[0] === 'python');
  check('an exact word comes first', tags('r')[0] === 'r' && tags('c')[0] === 'c');
  check('a name finds its word', tags('shell')[0] === 'bash' && tags('C++')[0] === 'cpp' && tags('typst')[0] === 'typ');
  check('a start outranks a middle', tags('sc')[0] === 'scala' && tags('sc').includes('javascript'));
  check('a word that is no language offers nothing', tags('stata').length === 0);
}

// ---------- Enter on a fence ----------
{
  const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : []);
  const press = (doc: PMNode, pos: number): EditorState | null => {
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
    const ran = enterFence(state, (tr) => {
      state = state.apply(tr);
    });
    return ran ? state : null;
  };
  const endOf = (doc: PMNode, index: number) => {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
    return pos + doc.child(index).nodeSize - 1;
  };

  const doc = schema.nodes.doc.create(null, [p('Before.'), p('```python'), p('After.')]);
  const made = press(doc, endOf(doc, 1));
  const block = made?.doc.child(1);
  check('```python and Enter is a Python block', block?.type.name === 'code_block' && block.attrs.params === 'python' && block.content.size === 0);
  check('the caret is in the new block', !!made && made.selection.$from.parent === block && made.selection.empty);
  check('the lines beside it stand', made?.doc.child(0).textContent === 'Before.' && made?.doc.child(2).textContent === 'After.');

  const bare = schema.nodes.doc.create(null, [p('```')]);
  check('``` and Enter is a block in no language', press(bare, endOf(bare, 0))?.doc.child(0).attrs.params === '');
  const spaced = schema.nodes.doc.create(null, [p('``` r')]);
  check('a space after the backticks is allowed', press(spaced, endOf(spaced, 0))?.doc.child(0).attrs.params === 'r');

  const not = (name: string, d: PMNode, pos: number) => check(name, press(d, pos) === null);
  not('the caret must be at the line’s end', doc, endOf(doc, 1) - 2);
  const prose = schema.nodes.doc.create(null, [p('see ```python')]);
  not('a fence after other text is text', prose, endOf(prose, 0));
  const words = schema.nodes.doc.create(null, [p('```python x')]);
  not('more than a language is text', words, endOf(words, 0));
  const two = schema.nodes.doc.create(null, [p('``')]);
  not('two backticks are text', two, endOf(two, 0));
  const marked = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text('```r', [schema.marks.strong.create()]))]);
  not('a marked line is not a fence', marked, endOf(marked, 0));
  const heading = schema.nodes.doc.create(null, [schema.nodes.heading.create({ level: 1 }, schema.text('```r'))]);
  not('a heading is not a fence', heading, endOf(heading, 0));

  // In a list item the block takes the paragraph's place, where the item
  // may hold one (its first block is a paragraph, by the schema).
  const list = schema.nodes.doc.create(null, [
    schema.nodes.bullet_list.create(null, [schema.nodes.list_item.create(null, [p('Query:'), p('```sql')])]),
  ]);
  const inItem = press(list, list.content.size - 3);
  const item = inItem?.doc.child(0).child(0);
  check('in a list item too', item?.childCount === 2 && item.child(1).type.name === 'code_block' && item.child(1).attrs.params === 'sql');
  const first = schema.nodes.doc.create(null, [
    schema.nodes.bullet_list.create(null, [schema.nodes.list_item.create(null, [p('```sql')])]),
  ]);
  not('an item’s first line stays a paragraph', first, first.content.size - 3);
}

if (failures) {
  console.error(`\n${failures} code block check(s) failed`);
  process.exit(1);
}
console.log('\ncode blocks: all checks passed');
