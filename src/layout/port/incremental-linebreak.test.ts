// Differential gate for the incremental line-break search (incremental.ts):
// after every scripted edit, the cross-run cached path must produce lines
// deep-equal (offsets, kinds, hyphen char counts, widths, justify, dash)
// to a from-scratch linebreak() over a freshly prepared paragraph — and
// the cache must actually serve lines, so the gate cannot pass on a
// silent permanent fallback. Covers long paragraphs (400/1000 words),
// hyphenation-heavy narrow measures, dashes/quotes, mixed marks with
// measured atoms, edits near start/middle/end, space splits/joins,
// line-count and last-line changes, measure changes, atom-width changes,
// an ineligible (CJ) paragraph, and a seeded random edit fuzz.
// Run: npx tsx src/layout/port/incremental-linebreak.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMON_FONT_FILES,
  COMMON_PORT_KEYS,
  DEFAULT_FONT,
  FONT_STYLES,
} from '../../font-registry';
import { loadPrimitivesFromBytes } from '../primitives';
import { defaultConfig, prepare, type InputSegment } from './prepare';
import { linebreak, type Line } from './linebreak';
import {
  clearIncrementalLinebreak,
  incrementalLinebreakStats,
  linebreakIncremental,
} from './incremental';

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const faces = FONT_STYLES.map((style) => ({
  key: DEFAULT_FONT.portKeys[style],
  bytes: readFileSync(root(`public/fonts/${DEFAULT_FONT.compilerFiles[style]}`)),
}));
faces.push({
  key: COMMON_PORT_KEYS.mono,
  bytes: readFileSync(root(`public/fonts/${COMMON_FONT_FILES.mono}`)),
});

await loadPrimitivesFromBytes(
  readFileSync(root('sidecar/pkg/typeset_sidecar_bg.wasm')),
  faces,
);

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failed++;
  }
}

const regular = DEFAULT_FONT.portKeys.regular;
const bold = DEFAULT_FONT.portKeys.bold;
const italic = DEFAULT_FONT.portKeys.italic;

interface LineSig {
  end: number;
  kind: string;
  l: number;
  r: number;
  width: number;
  justify: boolean;
  dash: string | null;
}

function sig(lines: Line[]): LineSig[] {
  return lines.map((ln) => ({
    end: ln.endByte,
    kind: ln.bp.kind,
    l: ln.bp.kind === 'hyphen' ? ln.bp.l : -1,
    r: ln.bp.kind === 'hyphen' ? ln.bp.r : -1,
    width: ln.width,
    justify: ln.justify,
    dash: ln.dash,
  }));
}

function sigDiff(a: LineSig[], b: LineSig[]): string | null {
  if (a.length !== b.length) return `line count ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    for (const k of ['end', 'kind', 'l', 'r', 'width', 'justify', 'dash'] as const) {
      if (x[k] !== y[k]) return `line ${i} ${k}: ${String(x[k])} vs ${String(y[k])}`;
    }
  }
  return null;
}

/** One step: incremental (persistent module cache) vs from-scratch, each
 * over its own freshly prepared paragraph. Returns null when equal. */
function step(segments: InputSegment[], width: number): string | null {
  const config = defaultConfig(11);
  const incremental = linebreakIncremental(prepare(segments, config), width);
  if (incremental === null) return 'tripwire fired (null result)';
  const scratch = linebreak(prepare(segments, config), width);
  return sigDiff(sig(incremental), sig(scratch));
}

const WORDS = [
  'antidisestablishmentarianism',
  'characteristically',
  'the',
  'quick',
  'brown',
  'foxes',
  'jump',
  'over',
  'lazy',
  'dogs',
  'while',
  'hyphenation',
  'candidates',
  'proliferate',
  'throughout',
  'exceptionally',
  'verbose',
  'paragraphs',
  'demonstrating',
  'justification',
  'behaviour',
  'across',
  'multiple',
  'lines',
  'with',
  'ordinary',
  'prose',
  'words',
  'interleaved',
  'reasonably',
  'floccinaucinihilipilification',
  'pseudopseudohypoparathyroidism',
];

function prose(words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[i % WORDS.length]);
  return out.join(' ') + '.';
}

type Edit = { note: string; apply: (t: string, prev: string) => string };

/** Scripted edit sequence exercising every eligibility-relevant shape. */
function editScript(base: string): Edit[] {
  const mid = Math.floor(base.length / 2);
  const insertAt = (t: string, i: number, s: string) => t.slice(0, i) + s + t.slice(i);
  const deleteAt = (t: string, i: number, n = 1) => t.slice(0, i) + t.slice(i + n);
  const nearestNonSpace = (t: string, i: number) => (t[i] === ' ' ? i + 1 : i);
  const spaceNear = (t: string, i: number) => {
    const fwd = t.indexOf(' ', i);
    return fwd >= 0 ? fwd : t.lastIndexOf(' ');
  };
  return [
    { note: 'insert char mid-word (middle)', apply: (t) => insertAt(t, nearestNonSpace(t, mid), 'x') },
    { note: 'delete char (middle)', apply: (t) => deleteAt(t, nearestNonSpace(t, mid)) },
    { note: 'insert space splitting a word', apply: (t) => insertAt(t, nearestNonSpace(t, mid + 4), ' ') },
    { note: 'delete space joining words', apply: (t) => deleteAt(t, spaceNear(t, mid)) },
    { note: 'edit near start', apply: (t) => insertAt(t, 5, 'y') },
    { note: 'edit near end', apply: (t) => insertAt(t, t.length - 3, 'z') },
    {
      note: 'insert long word (changes line count)',
      apply: (t) => insertAt(t, spaceNear(t, mid) + 1, 'incomprehensibilities of typesetting '),
    },
    { note: 'delete run (changes line count)', apply: (t) => deleteAt(t, mid, 40) },
    { note: 'append at very end (changes last line)', apply: (t) => t + ' postscriptum addendum' },
    { note: 'delete tail (changes last line)', apply: (t) => t.slice(0, t.length - 24) },
    { note: 'insert em-dash aside', apply: (t) => insertAt(t, spaceNear(t, mid), ' — that is — ') },
  ];
}

function runScript(
  name: string,
  toSegments: (t: string) => InputSegment[],
  base: string,
  width: number,
  expectServes: boolean,
) {
  clearIncrementalLinebreak();
  incrementalLinebreakStats(true);
  let text = base;
  // Prime the cache.
  let diff = step(toSegments(text), width);
  check(`${name}: initial run matches scratch`, diff === null);
  let servedEverywhere = true;
  // A single-step undo of the previous edit (the realistic ⌘Z shape).
  const edits: Edit[] = [
    ...editScript(base),
    { note: 'undo previous edit', apply: (_t, prev) => prev },
  ];
  let prev = text;
  for (const edit of edits) {
    const next = edit.apply(text, prev);
    prev = text;
    text = next;
    const before = incrementalLinebreakStats();
    diff = step(toSegments(text), width);
    const after = incrementalLinebreakStats();
    const served = after.linesServed - before.linesServed;
    if (served <= 0) servedEverywhere = false;
    check(`${name}: ${edit.note}${diff ? ` (${diff})` : ''}`, diff === null);
  }
  const stats = incrementalLinebreakStats();
  if (expectServes) {
    check(
      `${name}: cache served on every edit step (built ${stats.linesBuilt}, served ${stats.linesServed})`,
      servedEverywhere && stats.linesServed > 0 && stats.cachedRuns >= edits.length,
    );
  } else {
    check(`${name}: ineligible paragraph never served (served ${stats.linesServed})`, stats.linesServed === 0);
  }
  check(`${name}: no tripwire taints`, stats.taints === 0);
}

const plain = (t: string): InputSegment[] => [{ kind: 'text', text: t, styleKey: regular }];

// --- 1. long plain paragraphs at a body measure -------------------------
runScript('400 words', plain, prose(400), 426, true);
runScript('1000 words', plain, prose(1000), 426, true);

// --- 2. hyphenation-heavy narrow measure --------------------------------
runScript('hyphenation-heavy narrow', plain, prose(120), 150, true);

// --- 3. dashes, quotes, punctuation -------------------------------------
const dashy =
  '“Quotation marks,” she said — with an em-dash aside — ‘and single ones’ … plus an ellipsis; ' +
  'en-dash ranges 1914–1918 and minus-like hyphens co-operate across fifty-five affluent lines. ' +
  prose(80);
runScript('dashes and quotes', plain, dashy, 300, true);

// --- 4. mixed marks with measured atoms ---------------------------------
function marked(t: string): InputSegment[] {
  const third = Math.floor(t.length / 3);
  return [
    { kind: 'text', text: t.slice(0, third), styleKey: regular },
    { kind: 'text', text: t.slice(third, 2 * third), styleKey: bold },
    { kind: 'atom', width: 27.5 },
    { kind: 'text', text: t.slice(2 * third), styleKey: italic },
    { kind: 'atom', width: 12.25 },
    { kind: 'text', text: ' code tail', styleKey: COMMON_PORT_KEYS.mono, fontSize: 8.8 },
  ];
}
runScript('mixed marks with atoms', marked, prose(150), 320, true);

// --- 4b. hard break (mandatory breakpoint mid-paragraph) ----------------
function withHardBreak(t: string): InputSegment[] {
  const half = Math.floor(t.length / 2);
  return [
    { kind: 'text', text: t.slice(0, half), styleKey: regular },
    { kind: 'text', text: ' \n ', styleKey: regular },
    { kind: 'text', text: t.slice(half), styleKey: regular },
  ];
}
runScript('hard break mid-paragraph', withHardBreak, prose(120), 300, true);

// --- 4c. soft hyphens (whole-run shaping path, soft-dash lines) ---------
runScript(
  'soft hyphens',
  plain,
  prose(80).replaceAll('hyphenation', 'hy­phen­ation'),
  220,
  true,
);

// --- 5. measure change on unchanged text reuses lines -------------------
{
  clearIncrementalLinebreak();
  incrementalLinebreakStats(true);
  const segs = plain(prose(300));
  check('measure sweep: initial', step(segs, 426) === null);
  const before = incrementalLinebreakStats();
  let ok = true;
  for (const width of [420, 360, 426, 200]) {
    const d = step(segs, width);
    if (d) {
      check(`measure sweep @ ${width} (${d})`, false);
      ok = false;
    }
  }
  const after = incrementalLinebreakStats();
  check(
    `measure sweep: identical + lines reused across widths (served ${after.linesServed - before.linesServed})`,
    ok && after.linesServed - before.linesServed > 0,
  );
}

// --- 6. atom width change invalidates only the atom's neighborhood ------
{
  clearIncrementalLinebreak();
  incrementalLinebreakStats(true);
  const t = prose(120);
  const withAtom = (w: number): InputSegment[] => [
    { kind: 'text', text: t.slice(0, 300), styleKey: regular },
    { kind: 'atom', width: w },
    { kind: 'text', text: t.slice(300), styleKey: regular },
  ];
  check('atom width: initial', step(withAtom(20), 300) === null);
  const before = incrementalLinebreakStats();
  const d = step(withAtom(31.5), 300);
  const after = incrementalLinebreakStats();
  check(`atom width change stays exact${d ? ` (${d})` : ''}`, d === null);
  check(
    `atom width change still serves unaffected lines (served ${after.linesServed - before.linesServed})`,
    after.linesServed - before.linesServed > 0,
  );
}

// --- 7. ineligible content fails open ------------------------------------
runScript('CJ content (ineligible)', plain, '汉字排版测试 ' + prose(40), 300, false);

// --- 8. seeded random edit fuzz ------------------------------------------
{
  clearIncrementalLinebreak();
  incrementalLinebreakStats(true);
  let rngState = 0x51f0d1;
  const rnd = () => ((rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  const CHARS = 'abcdefghijklmnopqrstuvwxyz -—–';
  let text = prose(200);
  let fuzzDiff: string | null = null;
  let fuzzNote = '';
  check('fuzz: initial', step(plain(text), 300) === null);
  for (let iter = 0; iter < 80 && !fuzzDiff; iter++) {
    const pos = 1 + Math.floor(rnd() * (text.length - 2));
    if (rnd() < 0.5) {
      const n = 1 + Math.floor(rnd() * 3);
      let ins = '';
      for (let k = 0; k < n; k++) ins += CHARS[Math.floor(rnd() * CHARS.length)];
      text = text.slice(0, pos) + ins + text.slice(pos);
      fuzzNote = `insert ${JSON.stringify(ins)} @ ${pos}`;
    } else {
      const n = 1 + Math.floor(rnd() * 4);
      text = text.slice(0, pos) + text.slice(Math.min(pos + n, text.length));
      fuzzNote = `delete ${n} @ ${pos}`;
    }
    fuzzDiff = step(plain(text), 300);
  }
  const stats = incrementalLinebreakStats();
  check(`fuzz: 80 random edits stay exact${fuzzDiff ? ` (${fuzzNote}: ${fuzzDiff})` : ''}`, fuzzDiff === null);
  check(`fuzz: cache active (served ${stats.linesServed}, taints ${stats.taints})`, stats.linesServed > 0 && stats.taints === 0);
}

if (failed) process.exit(1);
console.log('\nall incremental line-break differentials passed');
