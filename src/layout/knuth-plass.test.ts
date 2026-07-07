// Sanity tests for the Knuth-Plass oracle. Run: npm test
import { breakLines, INF, type Item } from './knuth-plass.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

const CHAR_W = 8;
const SPACE_W = 4;

function itemsFromWords(words: string[]): Item[] {
  const items: Item[] = [];
  words.forEach((w, i) => {
    if (i > 0) items.push({ type: 'glue', width: SPACE_W, stretch: SPACE_W / 2, shrink: SPACE_W / 3 });
    items.push({ type: 'box', width: w.length * CHAR_W });
  });
  items.push({ type: 'penalty', width: 0, penalty: INF, flagged: false });
  items.push({ type: 'glue', width: 0, stretch: 1e6, shrink: 0 });
  items.push({ type: 'penalty', width: 0, penalty: -INF, flagged: true });
  return items;
}

// --- empty / degenerate input ---
check('empty items -> no lines', breakLines([], 300).length === 0);

{
  const items = itemsFromWords(['hello']);
  const lines = breakLines(items, 300);
  check('single word -> one line', lines.length === 1);
  check('single line ends at forced break', lines[0]?.end === items.length - 1);
}

{
  // A single word wider than the measure must still produce a line, not crash.
  const items = itemsFromWords(['pneumonoultramicroscopicsilicovolcanoconiosis']);
  const lines = breakLines(items, 100);
  check('overfull single word -> one line, no crash', lines.length === 1);
}

// --- a real paragraph ---
{
  const text =
    'In olden times when wishing still helped one there lived a king whose daughters ' +
    'were all beautiful but the youngest was so beautiful that the sun itself which ' +
    'has seen so much was astonished whenever it shone in her face';
  const words = text.split(' ');
  const items = itemsFromWords(words);
  const measure = 320; // 40 chars
  const lines = breakLines(items, measure);

  check('paragraph breaks into multiple lines', lines.length > 3, `got ${lines.length}`);
  check('last line ends at forced break', lines[lines.length - 1]?.end === items.length - 1);

  // Lines must be contiguous and cover all boxes.
  let contiguous = true;
  for (let i = 1; i < lines.length; i++) {
    for (let j = lines[i - 1].end + 1; j < lines[i].start; j++) {
      if (items[j].type === 'box') contiguous = false;
    }
    if (lines[i].start <= lines[i - 1].end) contiguous = false;
  }
  check('lines are contiguous and skip no boxes', contiguous);

  // Every justified line must fit within measure given its shrink allowance.
  let fits = true;
  for (const line of lines.slice(0, -1)) {
    let w = 0;
    let shrink = 0;
    for (let j = line.start; j < line.end; j++) {
      const it = items[j];
      if (it.type === 'box') w += it.width;
      else if (it.type === 'glue') {
        w += it.width;
        shrink += it.shrink;
      }
    }
    if (w - shrink > measure + 0.001) fits = false;
  }
  check('justified lines fit within measure (after shrink)', fits);

  // Adjustment ratios should be within the shrink bound.
  check(
    'ratios >= -1',
    lines.every((l) => l.ratio >= -1),
    JSON.stringify(lines.map((l) => +l.ratio.toFixed(2))),
  );
}

// --- forced mid-paragraph break (hard break) ---
{
  const items: Item[] = [
    { type: 'box', width: 40 },
    { type: 'penalty', width: 0, penalty: INF, flagged: false },
    { type: 'glue', width: 0, stretch: 1e6, shrink: 0 },
    { type: 'penalty', width: 0, penalty: -INF, flagged: false },
    { type: 'box', width: 40 },
    { type: 'glue', width: SPACE_W, stretch: 2, shrink: 1 },
    { type: 'box', width: 40 },
    { type: 'penalty', width: 0, penalty: INF, flagged: false },
    { type: 'glue', width: 0, stretch: 1e6, shrink: 0 },
    { type: 'penalty', width: 0, penalty: -INF, flagged: true },
  ];
  const lines = breakLines(items, 300);
  check('hard break forces exactly two lines', lines.length === 2, `got ${lines.length}`);
  check('first line ends at the forced penalty', lines[0]?.end === 3);
  check('second line starts at the following box', lines[1]?.start === 4);
}

// --- hyphenation points get used under pressure ---
{
  const items: Item[] = [];
  const syllable = (w: number) => items.push({ type: 'box', width: w });
  const hyphen = () => items.push({ type: 'penalty', width: CHAR_W, penalty: 45, flagged: true });
  const space = () => items.push({ type: 'glue', width: SPACE_W, stretch: SPACE_W / 2, shrink: SPACE_W / 3 });
  for (let i = 0; i < 12; i++) {
    if (i > 0) space();
    syllable(48);
    hyphen();
    syllable(48);
  }
  items.push({ type: 'penalty', width: 0, penalty: INF, flagged: false });
  items.push({ type: 'glue', width: 0, stretch: 1e6, shrink: 0 });
  items.push({ type: 'penalty', width: 0, penalty: -INF, flagged: true });

  const lines = breakLines(items, 150); // narrow: each word is 96+8 wide
  const hyphenBreaks = lines.filter((l) => {
    const it = items[l.end];
    return it.type === 'penalty' && it.penalty === 45;
  });
  check('narrow measure uses hyphenation points', hyphenBreaks.length > 0, `got ${hyphenBreaks.length}`);
}

declare const process: { exitCode?: number };

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall knuth-plass tests passed');
}
