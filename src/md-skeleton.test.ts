// The content-parity reducer (md-skeleton.ts) on hand-built trees: each
// case builds the ProseMirror document Plass's reader should produce and
// the pandoc JSON AST `pandoc -f markdown-smart -t json` produces for the
// same Markdown (shapes taken from pandoc 3.4), and requires the two
// skeletons to agree — or, for the cases the referee must report, to
// differ. No pandoc run here: that is the referee's (md-parity, step 10).
// Run: npx tsx src/md-skeleton.test.ts
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { docSkeleton, firstDivergence, pandocSkeleton, type PandocDoc, type PandocNode, type SkeletonRecord } from './md-skeleton';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}
const show = (rs: SkeletonRecord[]) => '\n' + rs.map((r) => '      ' + JSON.stringify(r)).join('\n');

/** Both reductions agree (optionally ignoring fields), and when `expected`
 *  is given the Plass side is exactly those records. */
function same(name: string, pm: PMNode, pd: PandocDoc, expected?: SkeletonRecord[], ignore: Array<keyof SkeletonRecord> = []) {
  const a = docSkeleton(pm);
  const b = pandocSkeleton(pd);
  const i = firstDivergence(a, b, ignore);
  check(name, i < 0, `first divergence at ${i}:\n    plass:${show(a)}\n    pandoc:${show(b)}`);
  if (expected) check(`${name} (records)`, firstDivergence(a, expected) < 0, `got${show(a)}\n    want${show(expected)}`);
}

// ---------------------------------------------------------------- pandoc
type Attr = [string, string[], Array<[string, string]>];
const attr = (id = '', classes: string[] = [], kvs: Array<[string, string]> = []): Attr => [id, classes, kvs];
const S = (s: string): PandocNode => ({ t: 'Str', c: s });
const Sp: PandocNode = { t: 'Space' };
const SB: PandocNode = { t: 'SoftBreak' };
/** Plain words as pandoc tokenizes them: a Str per word, Space between. */
const w = (text: string): PandocNode[] => text.split(' ').flatMap((x, i) => (i ? [Sp, S(x)] : [S(x)]));
type Inl = PandocNode | PandocNode[];
const Para = (...inl: Inl[]): PandocNode => ({ t: 'Para', c: inl.flat() });
const Plain = (...inl: Inl[]): PandocNode => ({ t: 'Plain', c: inl.flat() });
const Header = (level: number, id: string, inl: PandocNode[], classes: string[] = []): PandocNode => ({ t: 'Header', c: [level, attr(id, classes), inl] });
const Div = (a: Attr, blocks: PandocNode[]): PandocNode => ({ t: 'Div', c: [a, blocks] });
const RawB = (format: string, s: string): PandocNode => ({ t: 'RawBlock', c: [format, s] });
const RawI = (format: string, s: string): PandocNode => ({ t: 'RawInline', c: [format, s] });
const MathI = (s: string): PandocNode => ({ t: 'Math', c: [{ t: 'InlineMath' }, s] });
const MathD = (s: string): PandocNode => ({ t: 'Math', c: [{ t: 'DisplayMath' }, s] });
const Note = (...blocks: PandocNode[]): PandocNode => ({ t: 'Note', c: blocks });
const Code = (s: string): PandocNode => ({ t: 'Code', c: [attr(), s] });
const Emph = (...inl: Inl[]): PandocNode => ({ t: 'Emph', c: inl.flat() });
const Image = (src: string, alt: PandocNode[] = [], a: Attr = attr()): PandocNode => ({ t: 'Image', c: [a, alt, [src, '']] });
const Quote = (...blocks: PandocNode[]): PandocNode => ({ t: 'BlockQuote', c: blocks });
const Bullets = (...items: PandocNode[][]): PandocNode => ({ t: 'BulletList', c: items });
const Ordered = (start: number, ...items: PandocNode[][]): PandocNode => ({ t: 'OrderedList', c: [[start, { t: 'Decimal' }, { t: 'Period' }], items] });
interface Cit { id: string; mode?: string; prefix?: PandocNode[]; suffix?: PandocNode[] }
const Cite = (...cs: Cit[]): PandocNode => ({
  t: 'Cite',
  c: [
    cs.map((c) => ({ citationId: c.id, citationPrefix: c.prefix ?? [], citationSuffix: c.suffix ?? [], citationMode: { t: c.mode ?? 'NormalCitation' }, citationNoteNum: 1, citationHash: 0 })),
    [S('[@…]')],
  ],
});
const MetaInl = (inl: PandocNode[]): PandocNode => ({ t: 'MetaInlines', c: inl });
const cell = (...blocks: PandocNode[]) => [attr(), { t: 'AlignDefault' }, 1, 1, blocks];
const row = (...cells: unknown[]) => [attr(), cells];
function Table(o: { aligns: string[]; head: unknown[]; body: unknown[]; caption?: PandocNode[] }): PandocNode {
  return {
    t: 'Table',
    c: [attr(), [null, o.caption ?? []], o.aligns.map((a) => [{ t: a }, { t: 'ColWidthDefault' }]), [attr(), o.head], [[attr(), 0, [], o.body]], [attr(), []]],
  };
}
const ast = (blocks: PandocNode[], meta: Record<string, PandocNode> = {}): PandocDoc => ({ 'pandoc-api-version': [1, 23, 1], meta, blocks });

// ----------------------------------------------------------- ProseMirror
const N = schema.nodes;
const t = (s: string) => schema.text(s);
const p = (...content: PMNode[]) => N.paragraph.create(null, content);
const pa = (attrs: Record<string, unknown>, ...content: PMNode[]) => N.paragraph.create(attrs, content);
const mi = (src: string) => N.math_inline.create({ src });
const cite = (key: string) => N.citation.create({ key });
const ref = (label: string) => N.eq_ref.create({ label });
const fn = (...content: PMNode[]) => N.footnote.create(null, content);
const note = (text: string) => N.editor_comment.create(null, text ? [t(text)] : []);
const island = () => N.code_block.create({ params: 'md-raw' }, [t('<raw>')]);
const doc = (...blocks: PMNode[]) => N.doc.create(null, blocks);
const rec = (kind: string, depth: number, fields: Partial<SkeletonRecord> = {}): SkeletonRecord => ({ kind, depth, printed: true, ...fields });

const SVG = 'data:image/svg+xml;base64,' + 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4'.repeat(3);
/** The skeleton's short form of SVG (its shape is checked with the figures). */
const SVG_KEY = docSkeleton(doc(p(N.image.create({ src: SVG }))))[0].src ?? '';

console.log('md-skeleton:');

// Front matter: title/author/date are inline text, the abstract blocks;
// pandoc's text (smart off) is normalized the way the importer does it.
same(
  'front matter, normalized like body text',
  doc(
    N.doc_title.create(null, [t('Taylor’s – draft')]),
    N.doc_authors.create(null, [t('A. One, O’Brien')]),
    N.doc_date.create(null, [t('2026-10-04')]),
    N.abstract.create(null, [p(t('First '), mi('\\beta'), t(' para '), cite('key'), t('.')), p(t('Second.'))]),
  ),
  ast([], {
    title: MetaInl([S("Taylor's"), Sp, S('--'), Sp, S('draft')]),
    author: { t: 'MetaList', c: [MetaInl(w('A. One')), MetaInl([S("O'Brien")])] },
    date: MetaInl([S('2026-10-04')]),
    abstract: { t: 'MetaBlocks', c: [Para(w('First'), Sp, MathI('\\beta'), Sp, S('para'), Sp, Cite({ id: 'key' }), S('.')), Para(w('Second.'))] },
  }),
  [
    rec('title', 0, { text: 'Taylor’s – draft' }),
    rec('author', 0, { text: 'A. One, O’Brien' }),
    rec('date', 0, { text: '2026-10-04' }),
    rec('abstract', 0),
    rec('paragraph', 1, { text: 'First ⟦$⟧ para ⟦cite:key⟧.', math: ['\\beta'], mode: ['normal'] }),
    rec('paragraph', 1, { text: 'Second.' }),
  ],
);

// normalizations.md, each line its own paragraph (one quote state each).
same(
  'Typst normalizations applied to pandoc text',
  doc(
    p(t('Costs −3 dollars.')),
    p(t('He said “hi” and left.')),
    p(t('The ‘90s were long.')),
    p(t('Colin is 5′11″ tall.')),
    p(t('A claim'), fn(t('The footnote.')), t(' with a space before its marker.')),
    p(t('A written ‘90s keeps its opening quote.')),
    p(t('Water is H~2~O, x^2^, @plass and note^[x].')),
    p(t('An en dash – an em dash — and an ellipsis…')),
  ),
  ast([
    Para(w('Costs -3 dollars.')),
    Para(w('He said "hi" and left.')),
    Para(w("The '90s were long.")),
    Para(w('Colin is 5\'11" tall.')),
    Para(w('A claim'), Sp, Note(Para(w('The footnote.'))), Sp, w('with a space before its marker.')),
    Para(w('A written ‘90s keeps its opening quote.')),
    Para(w('Water is H~2~O, x^2^, @plass and note^[x].')),
    Para(w('An en dash -- an em dash --- and an ellipsis...')),
  ]),
);

// The raw forms are sub/superscript to pandoc: a REPORTED divergence.
{
  const pm = doc(p(t('Water is H~2~O.')));
  const pd = ast([Para(w('Water is'), Sp, S('H'), { t: 'Subscript', c: [S('2')] }, S('O.'))]);
  const b = pandocSkeleton(pd);
  check('a hand-written H~2~O diverges (pandoc reads a subscript)', firstDivergence(docSkeleton(pm), b) === 0 && b[0].text === 'Water is H2O.', show(b));
}

// printedForm runs per markdown-it text token: emphasis, code and breaks
// cut a run, so `*a*-3` holds a minus (the importer's own reading).
same(
  'printedForm per token, code verbatim',
  doc(p(schema.text('a', [schema.marks.em.create()]), t('−3, x −3 and '), schema.text('code -- -3', [schema.marks.code.create()]), t('.'))),
  ast([Para(Emph(S('a')), S('-3,'), Sp, S('x'), Sp, S('-3'), Sp, S('and'), Sp, Code('code -- -3'), S('.'))]),
);

// The quoter sees a formula as an object (a quote after it closes, an
// apostrophe after it is one) and a citation as its closing `]`, after
// which a single quote opens (beforeAfterNode's stand-ins).
same(
  'quotes thread across atoms',
  doc(p(t('“'), mi('x'), t('” and '), mi('y'), t('’s view, '), cite('a'), t('‘s too'))),
  ast([Para(S('"'), MathI('x'), S('"'), Sp, S('and'), Sp, MathI('y'), S("'s"), Sp, S('view,'), Sp, Cite({ id: 'a' }), S("'s"), Sp, S('too'))]),
);

same(
  'footnotes: marker swallows its space, paragraphs joined',
  doc(p(t('claim'), fn(t('First para. Second para.')), t(' and inline'), fn(t('Inline note.')), t(' end.'))),
  ast([
    Para(S('claim'), Sp, Note(Para(w('First para.')), Para(w('Second para.'))), Sp, S('and'), Sp, S('inline'), Note(Para(w('Inline note.'))), Sp, S('end.')),
  ]),
  [
    rec('paragraph', 0, { text: 'claim⟦fn⟧ and inline⟦fn⟧ end.' }),
    rec('footnote', 1, { text: 'First para. Second para.' }),
    rec('footnote', 1, { text: 'Inline note.' }),
  ],
);

// Pandoc invents an id for every heading; only a different one is a label.
same(
  'headings: auto identifiers are not labels',
  doc(
    N.heading.create({ level: 1 }, [t('Intro')]),
    N.heading.create({ level: 1 }, [t('Intro')]),
    N.heading.create({ level: 1, label: 'sec:res' }, [t('Results')]),
    N.heading.create({ level: 2 }, [t('Notes')]),
    N.heading.create({ level: 1 }, [t('Colin’s PPF – 1.2 '), mi('x'), t(' values')]),
    N.heading.create({ level: 1 }, [t('!!!')]),
    N.heading.create({ level: 3, label: 'intro' }, [t('Elsewhere')]),
  ),
  ast([
    Header(1, 'intro', w('Intro')),
    Header(1, 'intro-1', w('Intro')),
    Header(1, 'sec:res', w('Results')),
    Header(2, 'notes', w('Notes'), ['unnumbered']),
    Header(1, 'colins-ppf----1.2-x-values', [...w("Colin's PPF -- 1.2"), Sp, MathI('x'), Sp, S('values')]),
    Header(1, 'section', [S('!!!')]),
    Header(3, 'intro', w('Elsewhere')),
  ]),
);

// A `[^ref]` marker is unresolved text when pandoc names the heading, so
// its label is in the id; an inline `^[…]` note adds nothing (pandoc 3.4).
same(
  'headings: a footnote reference label in the auto identifier',
  doc(
    N.heading.create({ level: 1 }, [t('Footnote here'), fn(t('One.'))]),
    N.heading.create({ level: 1 }, [t('Slope here'), fn(t('Slope.'))]),
    N.heading.create({ level: 1 }, [t('Inline here'), fn(t('An inline note.'))]),
    N.heading.create({ level: 1 }, [t('Two'), fn(t('One.')), t(' notes'), fn(t('Slope.')), t(' here')]),
    N.heading.create({ level: 1 }, [t('Footnote here'), fn(t('One.'))]),
    N.heading.create({ level: 2, label: 'sec:noted' }, [t('Labeled'), fn(t('One.'))]),
  ),
  ast([
    Header(1, 'footnote-here1', [...w('Footnote here'), Note(Para(S('One.')))]),
    Header(1, 'slope-hereslope', [...w('Slope here'), Note(Para(S('Slope.')))]),
    Header(1, 'inline-here', [...w('Inline here'), Note(Para(w('An inline note.')))]),
    Header(1, 'two1-notesslope-here', [S('Two'), Note(Para(S('One.'))), Sp, S('notes'), Note(Para(S('Slope.'))), Sp, S('here')]),
    Header(1, 'footnote-here1-1', [...w('Footnote here'), Note(Para(S('One.')))]),
    Header(2, 'sec:noted', [S('Labeled'), Note(Para(S('One.')))]),
  ]),
);

// `$$ … $$ {#eq:x}`: pandoc leaves the attribute block as text after the
// formula, on the closing line or the next.
same(
  'display math with labels and numbering',
  doc(
    N.math_display.create({ src: 'x^2', label: 'eq:x' }),
    N.math_display.create({ src: 'y', label: 'eq:y', numbered: false }),
    N.math_display.create({ src: 'z', numbered: false }),
    N.math_display.create({ src: 'e', numbered: true }),
    N.math_display.create({ src: '\\frac{a}{b}' }),
  ),
  ast([
    Para(MathD(' x^2 '), Sp, S('{#eq:x}')),
    Para(MathD('\ny\n'), SB, S('{#eq:y'), Sp, S('.unnumbered}')),
    Para(MathD(' z '), Sp, S('{.unnumbered}')),
    Para(MathD('e'), Sp, S('{.numbered}')),
    Para(MathD('\n  \\frac{a}{b}\n')),
  ]),
  [
    rec('math', 0, { math: ['x^2'], label: 'eq:x' }),
    rec('math', 0, { math: ['y'], label: 'eq:y', classes: ['unnumbered'] }),
    rec('math', 0, { math: ['z'], classes: ['unnumbered'] }),
    rec('math', 0, { math: ['e'], classes: ['numbered'] }),
    rec('math', 0, { math: ['\\frac{a}{b}'] }),
  ],
);

same(
  'inline math over a line break is one formula',
  doc(p(t('Para '), mi('a +\nb'), t(' text.')), N.blockquote.create(null, [p(t('quote '), mi('c + d'), t(' math'))])),
  ast([Para(S('Para'), Sp, MathI('a +\nb'), Sp, S('text.')), Quote(Para(S('quote'), Sp, MathI('c +\nd'), Sp, S('math')))]),
  [
    rec('paragraph', 0, { text: 'Para ⟦$⟧ text.', math: ['a + b'] }),
    rec('quote', 0),
    rec('paragraph', 1, { text: 'quote ⟦$⟧ math', math: ['c + d'] }),
  ],
);

// Every citation form: one sentinel per key, prefix/suffix/`-` as text,
// a label prefix makes a reference; pandoc's mode is the accepted part.
{
  const pm = doc(
    p(
      t('see '), cite('c'), t(', p. 3; '), cite('a'), cite('b'), t(' and -'), cite('c'), t(' and '), cite('key'),
      t(' and '), ref('eq:x'), t(' and '), ref('eq:x'), t(', '), cite('a'), t(', p. 3; also '), cite('b'), t(', '), cite('s'), t(' [p. 33].'),
    ),
  );
  const pd = ast([
    Para(
      Cite({ id: 'c', prefix: [S('see')], suffix: [S(','), Sp, S('p.'), Sp, S('3')] }), S(';'), Sp,
      Cite({ id: 'a' }, { id: 'b' }), Sp, S('and'), Sp, Cite({ id: 'c', mode: 'SuppressAuthor' }), Sp, S('and'), Sp,
      Cite({ id: 'key', mode: 'AuthorInText' }), Sp, S('and'), Sp, Cite({ id: 'eq:x', mode: 'AuthorInText' }), Sp, S('and'), Sp,
      Cite({ id: 'eq:x' }), S(','), Sp, Cite({ id: 'a', suffix: [S(','), Sp, S('p.'), Sp, S('3')] }, { id: 'b', prefix: [S('also')] }), S(','), Sp,
      Cite({ id: 's', mode: 'AuthorInText', suffix: w('p. 33') }), S('.'),
    ),
  ]);
  same('citations: every form, modes aside', pm, pd, undefined, ['mode']);
  const b = pandocSkeleton(pd)[0];
  check('citation modes are recorded, references carry none', JSON.stringify(b.mode) === JSON.stringify(['normal', 'normal', 'normal', 'suppress', 'in-text', 'normal', 'normal', 'in-text']), JSON.stringify(b.mode));
  check('the mode is the accepted divergence', firstDivergence(docSkeleton(pm), pandocSkeleton(pd)) === 0);
}

// Nested comments move to the top-level boundary: before the block when
// nothing printed precedes them in it, after it otherwise.
same(
  'nested comments are hoisted',
  doc(
    note('lead'),
    N.blockquote.create({ kind: 'solution' }, [p(t('Answer text more.'))]),
    note('inline'),
    note('trailing'),
    N.grid.create({ columns: [1, 1] }, [N.grid_row.create(null, [N.grid_cell.create(null, [p(t('Left.'))]), N.grid_cell.create(null, [p(t('Right.'))])])]),
    note('in column'),
    N.bullet_list.create(null, [N.list_item.create(null, [p(t('One.'))]), N.list_item.create(null, [p(t('Two.'))])]),
    note('in item'),
    N.blockquote.create(null, [p(t('Quoted.'))]),
    note('in quote'),
    N.table.create(null, [
      N.table_row.create(null, [N.table_header.create(null, [p(t('Item'))]), N.table_header.create(null, [p(t('Note'))])]),
      N.table_row.create(null, [N.table_cell.create(null, [p(t('a'))]), N.table_cell.create(null, [p(t('b'))])]),
    ]),
    note('in cell'),
    p(t('Text.')),
  ),
  ast([
    Div(attr('', ['solution']), [
      RawB('html', '<!-- lead -->'),
      Para(w('Answer text'), Sp, RawI('html', '<!-- inline -->'), Sp, S('more.')),
      RawB('html', '<!-- trailing -->'),
    ]),
    Div(attr('', ['columns'], [['gutter', '1em']]), [
      Div(attr('', ['column']), [Para(w('Left.'))]),
      Div(attr('', ['column']), [RawB('html', '<!-- in column -->'), Para(w('Right.'))]),
    ]),
    Bullets([Plain(w('One.'))], [Plain(w('Two.')), RawB('html', '<!-- in item -->')]),
    Quote(Para(w('Quoted.')), RawB('html', '<!-- in quote -->')),
    Table({
      aligns: ['AlignLeft', 'AlignLeft'],
      head: [row(cell(Plain(S('Item'))), cell(Plain(S('Note'))))],
      body: [row(cell(Plain(S('a'))), cell(Plain(S('b'), Sp, RawI('html', '<!-- in cell -->'))))],
    }),
    Para(S('Text.')),
  ]),
);

// A footnote's comment follows its marker: after the paragraph.
{
  const b = pandocSkeleton(ast([Para(S('Text.'), Note(Para(S('n'), Sp, RawI('html', '<!-- c -->'))))]));
  check('a comment in a footnote moves after its paragraph', b.map((r) => r.kind).join(' ') === 'paragraph footnote comment' && b[2].text === 'c' && !b[2].printed, show(b));
}

// A comment on the line after paragraph text is inline to pandoc; at the
// paragraph's end it lands where markdown-it's block comment does.
same(
  'a comment right after a paragraph line',
  doc(p(t('Some text.')), note('after')),
  ast([Para(w('Some text.'), SB, RawI('html', '<!-- after -->'))]),
);
check(
  'followed by more text it is the accepted divergence',
  firstDivergence(
    docSkeleton(doc(p(t('Some text.')), note('mid'), p(t('More text.')))),
    pandocSkeleton(ast([Para(w('Some text.'), SB, RawI('html', '<!-- mid -->'), SB, w('More text.'))])),
  ) === 0,
);

{
  const b = pandocSkeleton(
    ast([
      RawB('html', '<!-- a --&gt; b & c -- d -->'),
      RawB('html', '<!--\nA comment may run\nover several lines.\n-->'),
      RawB('html', '<!-- plass:comment\ntagged &amp; -&#45; text\n-->'),
    ]),
  );
  check(
    'comment payloads: trimmed, --&gt; decoded, the tagged frame decoded the old way',
    JSON.stringify(b.map((r) => r.text)) === JSON.stringify(['a --> b & c -- d', 'A comment may run\nover several lines.', 'tagged & -- text']) && b.every((r) => r.kind === 'comment' && !r.printed),
    show(b),
  );
}

// Grids: one `.columns` div per row; later rows carry `.continued`.
const gcell = (...blocks: PMNode[]) => N.grid_cell.create(null, blocks);
const grow = (...xs: string[]) => N.grid_row.create(null, xs.map((x) => gcell(p(t(x)))));
const colDiv = (...blocks: PandocNode[]) => Div(attr('', ['column']), blocks);
const rowDiv = (classes: string[], ...xs: string[]) =>
  Div(attr('', ['columns', ...classes], [['gutter', '1em']]), xs.map((x) => colDiv(Para(S(x)))));
const cellRecs = (...xs: string[]) => xs.flatMap((x) => [rec('column', 1), rec('paragraph', 2, { text: x })]);

same(
  'columns: a 3x2 grid is two divs, the second .continued',
  doc(
    N.grid.create({ columns: [1.5, 1], gutter: 1 }, [N.grid_row.create(null, [gcell(p(t('Left.'))), gcell(p(N.image.create({ src: SVG })))])]),
    N.grid.create({ columns: [1, 1, 1], gutter: 1 }, [grow('a', 'b', 'c'), grow('d', 'e', 'f')]),
  ),
  ast([
    Div(attr('', ['columns'], [['gutter', '1em']]), [
      Div(attr('', ['column'], [['width', '60%']]), [Para(w('Left.'))]),
      Div(attr('', ['column'], [['width', '40%']]), [Para(Image(SVG))]),
    ]),
    rowDiv([], 'a', 'b', 'c'),
    rowDiv(['continued'], 'd', 'e', 'f'),
  ]),
  [
    rec('columns', 0, { cols: 2 }),
    rec('column', 1),
    rec('paragraph', 2, { text: 'Left.' }),
    rec('column', 1),
    rec('image', 2, { src: SVG_KEY }),
    rec('columns', 0, { cols: 3 }),
    ...cellRecs('a', 'b', 'c', 'd', 'e', 'f'),
  ],
);

{
  // Two adjacent unmarked rows with equal shares and gutter: two grids.
  const pd = ast([rowDiv([], 'a', 'b'), rowDiv([], 'c', 'd')]);
  same(
    'columns: adjacent unmarked divs stay two grids',
    doc(N.grid.create({ columns: [1, 1], gutter: 1 }, [grow('a', 'b')]), N.grid.create({ columns: [1, 1], gutter: 1 }, [grow('c', 'd')])),
    pd,
    [rec('columns', 0, { cols: 2 }), ...cellRecs('a', 'b'), rec('columns', 0, { cols: 2 }), ...cellRecs('c', 'd')],
  );
  const merged = docSkeleton(doc(N.grid.create({ columns: [1, 1], gutter: 1 }, [grow('a', 'b'), grow('c', 'd')])));
  check('…and are not one two-row grid', firstDivergence(merged, pandocSkeleton(pd)) === 5, show(pandocSkeleton(pd)));
}

same(
  'columns: a comment between rows is hoisted and the rows still merge',
  doc(
    N.grid.create({ columns: [1, 1], gutter: 1 }, [grow('a', 'b'), grow('c', 'd')]),
    note('between rows'),
    note('first in row two'),
    N.blockquote.create({ kind: 'solution' }, [p(t('Lead.')), N.grid.create({ columns: [1, 1], gutter: 1 }, [grow('e', 'f'), grow('g', 'h')])]),
    note('nested between rows'),
    p(t('After.')),
    N.grid.create({ columns: [1, 1], gutter: 1 }, [grow('i', 'j')]),
  ),
  ast([
    rowDiv([], 'a', 'b'),
    RawB('html', '<!-- between rows -->'),
    Div(attr('', ['columns', 'continued'], [['gutter', '1em']]), [colDiv(RawB('html', '<!-- first in row two -->'), Para(S('c'))), colDiv(Para(S('d')))]),
    // Nested in a solution, with a comment between the rows' divs too.
    Div(attr('', ['solution']), [Para(S('Lead.')), rowDiv([], 'e', 'f'), RawB('html', '<!-- nested between rows -->'), rowDiv(['continued'], 'g', 'h')]),
    Para(S('After.')),
    // A `.continued` row with no grid before it starts one.
    rowDiv(['continued'], 'i', 'j'),
  ]),
  [
    rec('columns', 0, { cols: 2 }),
    ...cellRecs('a', 'b', 'c', 'd'),
    rec('comment', 0, { printed: false, text: 'between rows' }),
    rec('comment', 0, { printed: false, text: 'first in row two' }),
    rec('solution', 0),
    rec('paragraph', 1, { text: 'Lead.' }),
    rec('columns', 1, { cols: 2 }),
    ...['e', 'f', 'g', 'h'].flatMap((x) => [rec('column', 2), rec('paragraph', 3, { text: x })]),
    rec('comment', 0, { printed: false, text: 'nested between rows' }),
    rec('paragraph', 0, { text: 'After.' }),
    rec('columns', 0, { cols: 2 }),
    ...cellRecs('i', 'j'),
  ],
);

same(
  'center, right and keep divs are paragraph attributes',
  doc(pa({ align: 'center' }, t('Centered.')), pa({ align: 'right' }, t('Right.')), pa({ keep: true, align: 'center' }, t('Kept.')), island()),
  ast([
    Div(attr('', ['center']), [Para(w('Centered.'))]),
    Div(attr('', ['right']), [Para(w('Right.'))]),
    Div(attr('', ['keep', 'center']), [Para(w('Kept.'))]),
    Div(attr('', ['keep']), [Para(MathD(' x '))]),
  ]),
  [
    rec('paragraph', 0, { text: 'Centered.', classes: ['center'] }),
    rec('paragraph', 0, { text: 'Right.', classes: ['right'] }),
    rec('paragraph', 0, { text: 'Kept.', classes: ['center', 'keep'] }),
    rec('island', 0),
  ],
);

// The table div grammar: id, caption, decimal columns, a span (its covered
// cell written empty and skipped), a per-cell override; the blank header
// row of a headerless table is not a row.
{
  const th = (s: string, align: string | null = null) => N.table_header.create({ align }, [p(t(s))]);
  const td = (s: string, align: string | null = null, colspan = 1) => N.table_cell.create({ align, colspan }, [s ? p(t(s)) : p()]);
  const tdm = (src: string) => N.table_cell.create(null, [p(mi(src))]);
  same(
    'tables: the .table div, spans, decimal, headerless',
    doc(
      N.table.create({ label: 'tbl:r', caption: 'Results' }, [
        N.table_row.create(null, [th('Name'), th('Score', 'decimal'), th('Note', 'right')]),
        N.table_row.create(null, [td('a'), td('12.5', 'decimal'), td('x', 'center')]),
        N.table_row.create(null, [td('c spans two', null, 2), td('z', 'right')]),
      ]),
      N.table.create({ caption: 'Headerless' }, [
        N.table_row.create(null, [tdm('|x|'), N.table_cell.create(null, [p(schema.text('a|b', [schema.marks.code.create()]))])]),
        N.table_row.create(null, [td('a | b'), td('')]),
      ]),
      N.table.create({ label: 'tbl:x', caption: 'Caption line' }, [N.table_row.create(null, [th('H')]), N.table_row.create(null, [td('v')])]),
    ),
    ast([
      Div(attr('tbl:r', ['table'], [['caption', 'Results'], ['decimal', '1'], ['spans', 'r2c0:2x1'], ['aligns', 'r1c2:center']]), [
        Table({
          aligns: ['AlignLeft', 'AlignRight', 'AlignRight'],
          head: [row(cell(Plain(S('Name'))), cell(Plain(S('Score'))), cell(Plain(S('Note'))))],
          body: [row(cell(Plain(S('a'))), cell(Plain(S('12.5'))), cell(Plain(S('x')))), row(cell(Plain(w('c spans two'))), cell(), cell(Plain(S('z'))))],
        }),
      ]),
      Div(attr('', ['table'], [['caption', 'Headerless']]), [
        Table({
          aligns: ['AlignDefault', 'AlignDefault'],
          head: [],
          body: [row(cell(Plain(MathI('|x|'))), cell(Plain(Code('a|b')))), row(cell(Plain(w('a | b'))), cell())],
        }),
      ]),
      Table({ aligns: ['AlignDefault'], head: [row(cell(Plain(S('H'))))], body: [row(cell(Plain(S('v'))))], caption: [Plain(w('Caption line {#tbl:x}'))] }),
    ]),
    [
      rec('table', 0, { text: 'Results', label: 'tbl:r', rows: 3, head: 1, cols: 3, aligns: ['left', 'decimal', 'right', 'left', 'decimal', 'center', 'left', 'right'] }),
      ...['Name', 'Score', 'Note', 'a', '12.5', 'x', 'c spans two', 'z'].map((x) => rec('paragraph', 1, { text: x })),
      rec('table', 0, { text: 'Headerless', rows: 2, head: 0, cols: 2, aligns: ['left', 'left', 'left', 'left'] }),
      rec('paragraph', 1, { text: '⟦$⟧', math: ['|x|'] }),
      rec('paragraph', 1, { text: 'a|b' }),
      rec('paragraph', 1, { text: 'a | b' }),
      rec('paragraph', 1, { text: '' }),
      rec('table', 0, { text: 'Caption line', label: 'tbl:x', rows: 2, head: 1, cols: 1, aligns: ['left', 'left'] }),
      rec('paragraph', 1, { text: 'H' }),
      rec('paragraph', 1, { text: 'v' }),
    ],
  );
  const emptyHead = pandocSkeleton(
    ast([Table({ aligns: ['AlignDefault'], head: [row(cell())], body: [row(cell(Plain(S('v'))))] })]),
  )[0];
  check('a header row of empty cells is dropped', emptyHead.rows === 1 && emptyHead.head === 0, JSON.stringify(emptyHead));
}

// A table's comments are placed by its cells: before the table when no
// cell text precedes them, after it otherwise; a caption does not count.
{
  const th = (...c: PMNode[]) => N.table_header.create(null, [p(...c)]);
  const td = (...c: PMNode[]) => N.table_cell.create(null, [p(...c)]);
  same(
    'a comment in a table: before it when it precedes every cell’s text',
    doc(
      note('first'),
      N.table.create({ caption: 'Cap' }, [N.table_row.create(null, [th(t('Item')), th(t('Note'))]), N.table_row.create(null, [td(t('a')), td(t('b'))])]),
      note('later'),
      p(t('Text.')),
      N.table.create(null, [N.table_row.create(null, [th(t('H'))]), N.table_row.create(null, [td(t('v'))])]),
      note('after text'),
    ),
    ast([
      Div(attr('', ['table'], [['caption', 'Cap']]), [
        Table({
          aligns: ['AlignLeft', 'AlignLeft'],
          head: [row(cell(Plain(RawI('html', '<!-- first -->'), Sp, S('Item'))), cell(Plain(S('Note'))))],
          body: [row(cell(Plain(S('a'))), cell(Plain(S('b'), Sp, RawI('html', '<!-- later -->'))))],
        }),
      ]),
      Para(S('Text.')),
      Table({ aligns: ['AlignDefault'], head: [row(cell(Plain(S('H'))))], body: [row(cell(Plain(RawI('html', '<!-- after text -->'), Sp, S('v'))))] }),
    ]),
  );
}

same(
  'figures and images by pandoc’s alt rule',
  doc(
    N.figure.create({ src: 'f.svg', label: 'fig:f' }, [t('Cap')]),
    N.figure.create({ src: 'g.svg', label: 'fig:g' }),
    p(N.image.create({ src: 'h.svg' })),
    p(t('An '), N.image.create({ src: SVG, alt: 'box' }), t(' inline.')),
  ),
  ast([
    { t: 'Figure', c: [attr('fig:f'), [null, [Plain(S('Cap'))]], [Plain(Image('f.svg', [S('Cap')], attr('', [], [['width', '60%']])))]] },
    Para(Image('g.svg', [], attr('fig:g', [], [['width', '60%']]))),
    Para(Image('h.svg', [], attr('', [], [['width', '50%']]))),
    Para(S('An'), Sp, Image(SVG, [S('box')]), Sp, S('inline.')),
  ]),
);
check('a long data URL is shown by type, length and digest', SVG_KEY === `data:image/svg+xml;base64,…${SVG.length}#` + SVG_KEY.slice(-8) && /#[0-9a-f]{8}$/.test(SVG_KEY), SVG_KEY);

// Islands: no text, children not descended, comments still hoisted; an
// HTML element runs through its closing tag; headings inside still take
// pandoc identifiers.
same(
  'unknown divs and HTML elements are islands',
  doc(note('lead in div'), island(), island(), note('in aside'), island(), island(), N.heading.create({ level: 2 }, [t('Inside details')])),
  ast([
    Div(attr('', ['callout-note']), [RawB('html', '<!-- lead in div -->'), Para(w('Inner.')), Div(attr('', ['inner']), [Para(w('Nested.'))])]),
    RawB('html', '<aside>'),
    RawB('html', '<!-- in aside -->'),
    Plain(w('text in aside')),
    RawB('html', '</aside>'),
    Div(attr('', [], [['style', 'margin-top: -70px;']]), []),
    RawB('html', '<details>'),
    RawB('html', '<summary>'),
    Plain(S('Hidden')),
    RawB('html', '</summary>'),
    Header(2, 'inside-details', w('Inside details')),
    Para(S('text'), Sp, RawI('html', '<!-- stays inside -->')),
    RawB('html', '</details>'),
    Header(2, 'inside-details-1', w('Inside details')),
  ]),
);

same(
  'page breaks, the Typst hatch, the bibliography, listings, rules',
  N.doc.create({ bib: { name: 'references.bib', content: '@book{k, title={T}}' } }, [
    N.page_break.create(),
    N.page_break.create(),
    N.code_block.create({ params: 'typst-raw' }, [t('#pagebreak()')]),
    N.bibliography.create(),
    N.code_block.create({ params: 'typst' }, [t('#let x = 1')]),
    N.horizontal_rule.create(),
  ]),
  ast([
    RawB('tex', '\\newpage'),
    RawB('tex', '\\pagebreak'),
    RawB('typst', '#pagebreak()'),
    RawB('bibtex', '@book{k, title={T}}'),
    { t: 'CodeBlock', c: [attr('', ['typst']), '#let x = 1'] },
    { t: 'HorizontalRule' },
  ]),
);
check('a bibliography is its keys and a digest', /^k #[0-9a-f]{8}$/.test(pandocSkeleton(ast([RawB('bibtex', '@book{k, title={T}}')]))[0].text ?? ''));

same(
  'lists, nested and numbered',
  doc(
    N.bullet_list.create(null, [N.list_item.create(null, [p(t('a'))]), N.list_item.create(null, [p(t('b')), N.bullet_list.create(null, [N.list_item.create(null, [p(t('c'))])])])]),
    N.ordered_list.create({ order: 3 }, [N.list_item.create(null, [p(t('three'))])]),
  ),
  ast([Bullets([Plain(S('a'))], [Para(S('b')), Bullets([Plain(S('c'))])]), Ordered(3, [Plain(S('three'))])]),
  [
    rec('list', 0, { classes: ['bullet'] }),
    rec('item', 1),
    rec('paragraph', 2, { text: 'a' }),
    rec('item', 1),
    rec('paragraph', 2, { text: 'b' }),
    rec('list', 2, { classes: ['bullet'] }),
    rec('item', 3),
    rec('paragraph', 4, { text: 'c' }),
    rec('list', 0, { classes: ['ordered', 'start=3'] }),
    rec('item', 1),
    rec('paragraph', 2, { text: 'three' }),
  ],
);

same(
  'spaces collapse, a no-break space is glue, breaks and inline raw are atoms',
  doc(p(t('20\u00a0pasties and  two  spaces'), N.hard_break.create(), t('next '), N.typst_inline.create({ src: '#h(1fr)' }), t(' H'), N.typst_inline.create({ src: '<sub>', lang: 'html' }), t('2'), N.typst_inline.create({ src: '</sub>', lang: 'html' }), t('O'))),
  ast([Para(S('20\u00a0pasties'), Sp, w('and two spaces'), { t: 'LineBreak' }, S('next'), Sp, RawI('typst', '#h(1fr)'), Sp, S('H'), RawI('html', '<sub>'), S('2'), RawI('html', '</sub>'), S('O'))]),
);

{
  const a = [rec('paragraph', 0, { text: 'x', mode: ['normal'] })];
  const b = [rec('paragraph', 0, { text: 'x', mode: ['in-text'] })];
  check('firstDivergence: equal, ignored field, length', firstDivergence(a, a) === -1 && firstDivergence(a, b) === 0 && firstDivergence(a, b, ['mode']) === -1 && firstDivergence(a, [...a, ...a]) === 1);
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('all md-skeleton tests passed');
