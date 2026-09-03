// The source view's Typst mode tokenizes the rails and nothing else
// (SOURCE-VIEW.md, decision 4). Driven with @codemirror/language's own
// StringStream over the demo document's real serialization, so the mode
// is tested on the text it will actually show.

import assert from 'node:assert/strict';
import { StringStream } from '@codemirror/language';
import { demoDoc } from './demo-doc';
import { docToTyp } from './typ-serializer';
import { typstRails, type TypstRailsState } from './source-typst-mode';

interface Token {
  line: number;
  text: string;
  style: string | null;
}

/** Every token of every line, the way the stream parser would emit them. */
function tokenize(src: string): Token[] {
  const state: TypstRailsState = typstRails.startState!(2);
  const out: Token[] = [];
  src.split('\n').forEach((line, i) => {
    if (line === '') {
      typstRails.blankLine?.(state, 2);
      return;
    }
    const stream = new StringStream(line, 4, 2);
    while (!stream.eol()) {
      const style = typstRails.token(stream, state);
      assert.ok(stream.pos > stream.start, `line ${i + 1}: token made no progress at ${stream.start}`);
      out.push({ line: i + 1, text: stream.current(), style });
      stream.start = stream.pos;
    }
  });
  return out;
}

const styles = (tokens: Token[], style: string | null) => tokens.filter((t) => t.style === style).map((t) => t.text);
const lineOf = (tokens: Token[], n: number) => tokens.filter((t) => t.line === n);

const typ = docToTyp(demoDoc());
const lines = typ.split('\n');
const tokens = tokenize(typ);

// Headings: the marker dims, the rest of the line is one heading token.
{
  const n = lines.indexOf('= Plass') + 1;
  assert.deepEqual(
    lineOf(tokens, n).map((t) => [t.text, t.style]),
    [['=', 'processingInstruction'], [' Plass', 'heading']],
  );
  const m = lines.indexOf('== Mathematics') + 1;
  assert.deepEqual(
    lineOf(tokens, m).map((t) => [t.text, t.style]),
    [['==', 'processingInstruction'], [' Mathematics', 'heading']],
  );
}

// Calls: `#name(` / `#name[` heads dim; their arguments stay text.
{
  const meta = new Set(styles(tokens, 'meta'));
  for (const head of ['#mi', '#mitex', '#figure', '#align', '#quote', '#bibliography', '#footnote']) {
    assert.ok(meta.has(head), `${head} should be a call head`);
  }
  // `#set page(` is off the rails: `#set` is followed by a space, not a bracket.
  assert.ok(!meta.has('#set'));
  assert.ok(!meta.has('#show'));
}

// Math and raw: backtick spans (the mitex wrapper's source) are raw, and
// they carry across lines; a `$…$` span is math.
{
  const raw = styles(tokens, 'monospace').join('');
  assert.ok(raw.includes('`e^{i\\pi} + 1 = 0`'));
  assert.ok(raw.includes('\\int_{-\\infty}^{\\infty}'), 'multi-line raw inside #mitex(`…`)');
  const math = tokenize('Let $x^2 + y^2 = 1$ hold, and $\\$5$ too.');
  assert.deepEqual(styles(math, 'string.special'), ['$', 'x^2 + y^2 = 1$', '$', '\\$5$']);
  const fenced = tokenize('```typst\n#let x = 1\n```\nafter');
  assert.deepEqual(fenced.map((t) => t.style), ['monospace', 'monospace', 'monospace', null]);
}

// Comments: a line comment, but not the `//` of a URL.
{
  assert.deepEqual(styles(tokenize('// Exported from Plass'), 'comment'), ['// Exported from Plass']);
  assert.deepEqual(styles(tokenize('text // aside'), 'comment'), ['// aside']);
  assert.deepEqual(styles(tokenize('#link("https://example.org")'), 'comment'), []);
}

// References and labels.
{
  const refs = styles(tokens, 'link');
  for (const key of ['@knuthplass81', '@knuth86', '@madje22', '@fig:sd']) {
    assert.ok(refs.includes(key), `${key} should be a reference`);
  }
  assert.deepEqual(styles(tokenize('mail me@example.org'), 'link'), []);
  assert.deepEqual(styles(tokenize('#import "@preview/mitex:0.2.5": mi, mitex'), 'link'), []);
  // Labels on the equation and the figure, and the equation reference's
  // `#ref(<eq:gauss>, …)` argument (the serializer's form for equations).
  const labels = styles(tokens, 'labelName');
  assert.deepEqual([...new Set(labels)].sort(), ['<eq:gauss>', '<fig:sd>']);
  assert.ok(labels.length >= 3);
  assert.ok(styles(tokens, 'meta').includes('#ref'));
}

// Emphasis: delimiters dim, the span carries the style; `_` needs a word
// boundary so snake_case stays plain.
{
  const strong = tokenize('a *bold* word');
  assert.deepEqual(strong.map((t) => [t.text, t.style]), [
    ['a ', null],
    ['*', 'processingInstruction'],
    ['bold', 'strong'],
    ['*', 'processingInstruction'],
    [' word', null],
  ]);
  const em = tokenize('an _italic_ word and snake_case_name');
  assert.deepEqual(styles(em, 'emphasis'), ['italic']);
  assert.deepEqual(styles(em, 'processingInstruction'), ['_', '_']);
}

// List markers.
{
  const list = tokenize('- *Measure.* Every word\n+ second');
  assert.deepEqual(lineOf(list, 1)[0], { line: 1, text: '-', style: 'processingInstruction' });
  assert.deepEqual(lineOf(list, 2)[0], { line: 2, text: '+', style: 'processingInstruction' });
}

// Plain prose yields no tokens at all.
{
  const prose = tokenize(
    'Markup-and-compile tools like LaTeX produce beautiful pages but make you write in a two-pane workflow (forever glancing between source and preview).',
  );
  assert.deepEqual(prose.map((t) => t.style), [null]);
  // The demo's prose lines are plain except for their rails.
  const n = lines.findIndex((l) => l.startsWith('Markup-and-compile')) + 1;
  assert.deepEqual(lineOf(tokens, n).map((t) => t.style), [null]);
}

// Every character of the demo is covered exactly once (no gaps, no overlap).
{
  const perLine = new Map<number, string>();
  for (const t of tokens) perLine.set(t.line, (perLine.get(t.line) ?? '') + t.text);
  lines.forEach((line, i) => {
    if (line !== '') assert.equal(perLine.get(i + 1), line, `line ${i + 1} is covered exactly`);
  });
}

console.log('typst rails mode: all assertions passed');
