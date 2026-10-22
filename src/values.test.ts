// Values from values.json (values.ts): the key lookup, the printed form,
// the picker's list, and the refresh that keeps a document's values current.
// Run: npx tsx src/values.test.ts
import { EditorState } from 'prosemirror-state';
import { schema } from './schema';
import { digitsOf, flattenValues, formatValue, lookupValue, refreshValues } from './values';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const data = { prices: [4.5, 7, -3.25], fit: { slope: 0.123456, label: 'OLS', ok: true }, n: 120, table: [{ a: 1 }], 'bad key': 1 };

console.log('lookup');
check('an array element by index', lookupValue(data, 'prices.0') === 4.5);
check('a nested key', lookupValue(data, 'fit.slope') === 0.123456);
check('a string and a boolean', lookupValue(data, 'fit.label') === 'OLS' && lookupValue(data, 'fit.ok') === true);
check('a list or an object is no value', lookupValue(data, 'prices') === undefined && lookupValue(data, 'fit') === undefined);
check('a missing key or index', lookupValue(data, 'prices.9') === undefined && lookupValue(data, 'nope') === undefined && lookupValue(data, 'prices.x') === undefined);
check('no prototype keys', lookupValue({}, 'constructor') === undefined && lookupValue({}, '__proto__') === undefined);

console.log('printed form');
check('a number as JSON has it', formatValue(4.5, null) === '4.5' && formatValue(7, null) === '7' && formatValue(0.1 + 0.2, null) === '0.30000000000000004');
check('rounded to digits', formatValue(0.123456, 2) === '0.12' && formatValue(7, 2) === '7.00' && formatValue(2.5, 0) === '3');
check('a minus sign, not a hyphen', formatValue(-3.25, null) === '−3.25' && formatValue(-0.5, 1) === '−0.5');
check('no exponent', formatValue(1e21, null) === '1000000000000000000000' && formatValue(1e-7, null) === '0.0000001');
check('strings and booleans as they are', formatValue('OLS', 2) === 'OLS' && formatValue(true, null) === 'true');
check('digits: 0–10 or null', digitsOf('2') === 2 && digitsOf(0) === 0 && digitsOf('11') === null && digitsOf('x') === null && digitsOf(null) === null);

console.log('picker');
const flat = flattenValues(data);
check('every scalar, by dotted key', flat.some((v) => v.name === 'prices.2' && v.value === -3.25) && flat.some((v) => v.name === 'table.0.a') && flat.some((v) => v.name === 'fit.ok'));
check('a key that is not a name is left out', !flat.some((v) => v.name.includes(' ')));
check('at most the limit', flattenValues({ xs: Array.from({ length: 1000 }, (_, i) => i) }, 50).length === 50);

console.log('refresh');
{
  const value = (name: string, digits: number | null = null) => schema.marks.value.create({ name, digits });
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [
      schema.text('Price '),
      schema.text('1.0', [value('prices.0')]),
      schema.text(', slope '),
      schema.text('0.1', [schema.marks.strong.create(), value('fit.slope', 3)]),
      schema.text(', gone '),
      schema.text('42', [value('missing.key')]),
      schema.text('.'),
    ]),
  ]);
  const state = EditorState.create({ doc, schema });
  const tr = refreshValues(state, data);
  check('a refresh is a transaction', tr !== null);
  const text = tr!.doc.textContent;
  check('values brought up to date, a missing one kept', text === 'Price 4.5, slope 0.123, gone 42.', text);
  let marked = '';
  tr!.doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'value')) marked += `[${n.text}|${n.marks.map((m) => m.type.name).join('+')}]`;
  });
  check('the marks stay on the new text, strong included', marked === '[4.5|value][0.123|strong+value][42|value]', marked);
  check('out of the undo history', tr!.getMeta('addToHistory') === false);
  check('nothing to do: no transaction', refreshValues(state.apply(tr!), data) === null);
}

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall values tests passed');
}
