// Red text (text-color.ts): `[text]{.red}` reads as the color mark and
// writes back; the Typst export wraps the run in `#text(fill: red)[…]` and
// reads it back from a legacy .typ; TeX gets \textcolor with xcolor; a
// formula in the run is red, a footnote marker or a citation never is;
// and a content block's line head is escaped (Typst reads `- ` at the
// head of `#text(fill: red)[…]` or `#strike[…]` as a list item).
// Run: npm test
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { mdToDoc } from './md-parser.ts';
import { docToMd } from './md-serializer.ts';
import { docToTyp } from './typ-serializer.ts';
import { typToDoc } from './typ-parser.ts';
import { docToTex } from './tex-serializer.ts';
import { schema } from './schema.ts';
import { toggleTextColor, TEXT_COLORS } from './text-color.ts';
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

const red = (n: PMNode) => n.marks.some((m) => m.type.name === 'color' && m.attrs.name === 'red');
const reds = (doc: PMNode): string[] => {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isInline && red(n)) out.push(n.isText ? n.text! : `<${n.type.name}>`);
    return true;
  });
  return out;
};
function trip(md: string) {
  const first = mdToDoc(md);
  const md1 = docToMd(first.doc);
  const second = mdToDoc(md1);
  return { doc: first.doc, warnings: first.warnings, md1, md2: docToMd(second.doc), doc2: second.doc };
}

check('the palette is red, Typst\'s #ff4136', Object.keys(TEXT_COLORS).join() === 'red' && TEXT_COLORS.red.css === '#ff4136');

// --- Markdown ---
{
  const t = trip('A [red word]{.red} here.\n');
  check('[text]{.red} reads as the red mark', reds(t.doc).join('|') === 'red word', JSON.stringify(reds(t.doc)));
  check('and writes back as it came', t.md1 === 'A [red word]{.red} here.\n' && t.md2 === t.md1, t.md1);
  check('with no warning', t.warnings.length === 0, t.warnings.join('; '));
}
{
  const t = trip('[**bold** and red]{.red}\n');
  check('strong inside the span stays inside', t.md1 === '[**bold** and red]{.red}\n' && reds(t.doc).join('|') === 'bold| and red', t.md1);
}
{
  const t = trip('**[red]{.red} bold**\n');
  check('a mark the whole span shares stays outside it', t.md1 === '**[red]{.red} bold**\n' && reds(t.doc).join('|') === 'red', t.md1);
}
{
  const t = trip('[a $x$ b]{.red}\n');
  check('a formula in the span is red', reds(t.doc).join('|') === 'a |<math_inline>| b', JSON.stringify(reds(t.doc)));
  check('and the span is written whole over it', t.md1 === '[a $x$ b]{.red}\n' && t.md2 === t.md1, t.md1);
}
{
  const t = trip('[a[^1] b]{.red}\n\n[^1]: Note.\n');
  const fn = ((): PMNode | null => { let hit: PMNode | null = null; t.doc.descendants((n) => { if (n.type.name === 'footnote') hit = n; return !hit; }); return hit; })();
  check('a footnote marker in the span is not red', !!fn && !red(fn) && reds(t.doc).join('|') === 'a| b', JSON.stringify(reds(t.doc)));
  check('and the span closes and reopens around it', t.md1 === '[a]{.red}[^1][ b]{.red}\n\n[^1]: Note.\n' && t.md2 === t.md1, t.md1);
}
{
  const t = trip('[[a]{.red} b]{.red}\n');
  check('a red span in a red span is one run', reds(t.doc).join('|') === 'a b' && t.md1 === '[a b]{.red}\n', JSON.stringify([reds(t.doc), t.md1]));
}
{
  const t = trip('[[4.5]{.value name=p digits=1}]{.red}\n');
  const both = ((): boolean => { let hit = false; t.doc.descendants((n) => { if (n.isText && red(n) && n.marks.some((m) => m.type.name === 'value' && m.attrs.name === 'p' && m.attrs.digits === 1)) hit = true; return true; }); return hit; })();
  check('a value inside a red span carries both marks', both && t.md1 === '[[4.5]{.value name=p digits=1}]{.red}\n' && t.md2 === t.md1, t.md1);
}
{
  const t = trip('[a]{.red .aside #x k=v}\n');
  check('other attributes on a red span are dropped with a warning', t.md1 === '[a]{.red}\n' && t.warnings.length === 1 && /#x \.aside k=/.test(t.warnings[0]), JSON.stringify([t.md1, t.warnings]));
}
{
  const t = trip('[a]{.blue} and [b]{.red}\n');
  check('a span of another class is text', reds(t.doc).join('|') === 'b' && t.doc.textContent === '[a]{.blue} and b' && t.md1 === '[a]{.blue} and [b]{.red}\n', JSON.stringify([t.doc.textContent, t.md1]));
}
{
  const t = trip('| a | b |\n|---|---|\n| [red]{.red} | 2 |\n');
  check('red text in a table cell round-trips', reds(t.doc).join('|') === 'red' && t.md1 === t.md2 && t.md1.includes('[red]{.red}'), t.md1);
}

// --- Typst: the print, the audit's compile, the legacy .typ save ---
{
  const { doc } = mdToDoc('A [red *word* and $x$]{.red} here.\n');
  const file = docToTyp(doc);
  // One run per mark signature, as strong and emphasis are written
  // (`*a *_*b*_* c*`): Typst shapes the same segments either way.
  check('the export wraps each run in #text(fill: red)[…], the formula inside', /#text\(fill: red\)\[red \]#text\(fill: red\)\[_word_\]#text\(fill: red\)\[ and #mi\(`x`\)\]/.test(file), file);
  const print = docToTyp(doc, { islands: 'print' });
  check('the print form too, with native math', /#text\(fill: red\)\[ and \$x \$\]/.test(print), print);
  const back = typToDoc(file);
  check('a legacy .typ reads it back as the mark', reds(back.doc).join('|') === 'red |word| and |<math_inline>' && back.warnings.length === 0, JSON.stringify([reds(back.doc), back.warnings]));
  check('and re-exports the same', docToTyp(back.doc) === file, docToTyp(back.doc));
}
{
  const { doc } = typToDoc('Keep #text(fill: blue)[this] as it is.\n');
  check('another fill stays an island, never a color', reds(doc).length === 0 && !!(() => { let hit = false; doc.descendants((n) => { if (n.type.name === 'typst_inline' && /fill: blue/.test(String(n.attrs.src))) hit = true; return true; }); return hit; })(), JSON.stringify(doc.toJSON()));
}
{
  const typ = docToTyp(mdToDoc('[- not a list]{.red}\n\n~~= not a heading~~\n\n**- bold**\n').doc);
  check('a list marker at the head of a red run is escaped', typ.includes('#text(fill: red)[\\- not a list]'), typ);
  check('so is a heading marker at the head of a struck run', typ.includes('#strike[\\= not a heading]'), typ);
  check('a strong run needs no escape: its delimiter guards the head', typ.includes('*- bold*'), typ);
}
{
  const t = trip('[a\\\nb]{.red}\n');
  check('a line break inside the span stays inside it', t.md1 === '[a\\\nb]{.red}\n' && t.md2 === t.md1 && reds(t.doc).join('|') === 'a|b', JSON.stringify([t.md1, reds(t.doc)]));
  // Markdown cannot write a list marker after a break inside a span (the
  // line would open a list), so the document is built here.
  const color = schema.marks.color.create({ name: 'red' });
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('b', [color]), schema.nodes.hard_break.create(), schema.text('- c', [color])]));
  const typ = docToTyp(doc);
  check('a marker after a line break inside the run is escaped', /#text\(fill: red\)\[b\] \\\n#text\(fill: red\)\[\\- c\]/.test(typ), typ.split('\n').filter((l) => /fill: red|^\\- /.test(l)).join('\n'));
}

// --- TeX ---
{
  const tex = docToTex(mdToDoc('A [red $x$ word]{.red} here.\n').doc);
  check('TeX gets \\textcolor{red} over text and formula', tex.includes('\\textcolor{red}{red }\\textcolor{red}{$x$}\\textcolor{red}{ word}'), tex);
  check('and pulls in xcolor', tex.includes('\\usepackage{xcolor}\n'), tex);
  check('a document without red does not', !docToTex(mdToDoc('plain\n').doc).includes('xcolor'));
}

// --- The toggle ---
{
  const { doc } = mdToDoc('a[^1] $x$ b\n\n[^1]: n\n');
  let state = EditorState.create({ doc, schema });
  const para = doc.firstChild!;
  state = state.apply(state.tr.setSelection(TextSelection.create(doc, 1, 1 + para.content.size)));
  const run = (s: EditorState) => {
    let next = s;
    toggleTextColor('red')(s, (tr) => { next = s.apply(tr); });
    return next;
  };
  const on = run(state);
  // The footnote's own text takes the mark as it takes Bold; its marker
  // never does.
  check('the toggle reds text and formula, never the footnote marker', reds(on.doc).join('|') === 'a|n| |<math_inline>| b', JSON.stringify(reds(on.doc)));
  const off = run(on);
  check('and toggles off again', reds(off.doc).length === 0, JSON.stringify(reds(off.doc)));
  check('the toggle is a command that reports itself possible', toggleTextColor('red')(state));
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('text-color: all checks passed');
