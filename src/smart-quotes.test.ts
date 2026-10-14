// Typst's smart quotes, mirrored: the cases from vendor/typst/tests/suite/
// text/smartquote.typ (English set) plus the editor's own — a closing quote
// typed after an already-normalized opening one still closes.
// Run: npx tsx src/smart-quotes.test.ts
import { createQuoteState, smartenText } from './smart-quotes';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}
const smart = (s: string, before: string | null = null) => smartenText(s, createQuoteState(), before).text;

console.log('smart quotes:');
check('the telephone sentence', smart(`"The horse eats no cucumber salad" was the first sentence ever uttered on the 'telephone.'`) === '“The horse eats no cucumber salad” was the first sentence ever uttered on the ‘telephone.’', smart(`"The horse eats no cucumber salad" was the first sentence ever uttered on the 'telephone.'`));
check('numbers, apostrophes, primes', smart(`The 5'11" 'quick' brown fox jumps over the "lazy" dog's ear.`) === 'The 5′11″ ‘quick’ brown fox jumps over the “lazy” dog’s ear.', smart(`The 5'11" 'quick' brown fox jumps over the "lazy" dog's ear.`));
check('apostrophe inside a double quotation', smart(`He said "I'm a big fella."`) === 'He said “I’m a big fella.”', smart(`He said "I'm a big fella."`));
check('an empty pair', smart('""') === '“”', smart('""'));
check('quotes reopen after a slash', smart('"Hello"/"World"') === '“Hello”/“World”', smart('"Hello"/"World"'));
check('nested single around doubles', smart(`'"Hello"/"World"'`) === '‘“Hello”/“World”’', smart(`'"Hello"/"World"'`));
check('opening after a bracket', smart('("quoted")') === '(“quoted”)', smart('("quoted")'));
check("shouldn't is an apostrophe", smart("Well, shouldn't it just go?") === 'Well, shouldn’t it just go?', smart("Well, shouldn't it just go?"));
check('a quote after an object closes or opens like after a letter', smart("'s share", '￼') === '’s share');
check('a paragraph-start quote opens', smart("'tis") === '‘tis');
check('an already-curly opening quote lets a typed closing quote close', smart('“abc"') === '“abc”', smart('“abc"'));
check('an already-curly single opening quote closes the same way', smart("‘abc'") === '‘abc’', smart("‘abc'"));
check('a curly apostrophe does not close a double quotation', smart('"I’m here"') === '“I’m here”', smart('"I’m here"'));
check('state threads across text runs', (() => {
  const st = createQuoteState();
  const a = smartenText('He said "', st, null);
  const b = smartenText('no" and left.', st, a.before);
  return a.text + b.text === 'He said “no” and left.';
})());
check('swaps report input indexes', JSON.stringify(smartenText(`a "b"`, createQuoteState(), null).swaps) === JSON.stringify([{ index: 2, glyph: '“' }, { index: 4, glyph: '”' }]));
check('soft hyphens are looked past', smart("it\u00ad's") === 'it\u00ad’s' && smart('"a\u00ad"') === '“a\u00ad”', smart("it\u00ad's"));

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('all smart-quote tests passed');
