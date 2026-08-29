// Differential gate for segment-stitched shaping (primitives.ts): the
// keystroke fast path splits an eligible run into word+space chunks,
// shapes each independently (LRU-cached), and stitches the results. That
// is only sound if no rustybuzz interaction crosses a chunk boundary, so
// this test certifies it per registered face, bit for bit, against the
// reference whole-run path:
//   1. every ordered pair of SEGMENT_SAFE_CHARS across a space (catches
//      kern pairs and short contextual lookups involving the space),
//   2. seeded random strings (longer contexts, multiple spaces),
//   3. a real-text corpus (hyphenation candidates, dashes, quotes, mixed
//      styles, Latin-1 accents),
//   4. the full prepare+linebreak pipeline with the fast path on vs off.
// It also encodes which inputs BYPASS the fast path (fail open to
// whole-run shaping): U+00AD SOFT HYPHEN — whose default-ignorable
// cluster merging differs at a chunk start — newlines/tabs, combining
// marks, and every character outside the certified set.
// Run: npx tsx src/layout/port/shape-cache.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMON_FONT_FILES,
  COMMON_PORT_KEYS,
  DEFAULT_FONT,
  FONT_STYLES,
} from '../../font-registry';
import {
  SEGMENT_SAFE_CHARS,
  loadPrimitivesFromBytes,
  segmentShapingEligible,
  type ShapedGlyphRaw,
} from '../primitives';
import { defaultConfig, prepare, type InputSegment } from './prepare';
import { linebreak } from './linebreak';

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const faces = FONT_STYLES.map((style) => ({
  key: DEFAULT_FONT.portKeys[style],
  bytes: readFileSync(root(`public/fonts/${DEFAULT_FONT.compilerFiles[style]}`)),
}));
faces.push({
  key: COMMON_PORT_KEYS.mono,
  bytes: readFileSync(root(`public/fonts/${COMMON_FONT_FILES.mono}`)),
});

const prim = await loadPrimitivesFromBytes(
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

function glyphsDiffer(a: ShapedGlyphRaw[], b: ShapedGlyphRaw[]): string | null {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.glyphId !== y.glyphId) return `glyphId@${i}: ${x.glyphId} vs ${y.glyphId}`;
    if (x.cluster !== y.cluster) return `cluster@${i}: ${x.cluster} vs ${y.cluster}`;
    if (x.xAdvance !== y.xAdvance) return `xAdvance@${i}: ${x.xAdvance} vs ${y.xAdvance}`;
    if (x.xOffset !== y.xOffset) return `xOffset@${i}: ${x.xOffset} vs ${y.xOffset}`;
    if (x.safeToBreak !== y.safeToBreak) return `safeToBreak@${i}: ${x.safeToBreak} vs ${y.safeToBreak}`;
  }
  return null;
}

/** Compare the production shape() (stitched when eligible) against the
 * reference whole-run path. */
function compare(fontKey: string, text: string): string | null {
  return glyphsDiffer(prim.shape(fontKey, text, { lang: 'en' }), prim.shapeFull(fontKey, text));
}

// --- 1. eligibility encoding -------------------------------------------
check('plain body text is eligible', segmentShapingEligible('The quick — naïve, “fifty-five” Zürich café.'));
check('NBSP is eligible', segmentShapingEligible('55 kg'));
check('SOFT HYPHEN bypasses', !segmentShapingEligible('hy­phen'));
check('newline bypasses', !segmentShapingEligible('a \n b'));
check('tab bypasses', !segmentShapingEligible('a\tb'));
check('combining mark bypasses', !segmentShapingEligible('é'));
check('ZWJ bypasses', !segmentShapingEligible('a‍b'));
check('Cyrillic bypasses', !segmentShapingEligible('привет'));
check('CJK bypasses', !segmentShapingEligible('文字'));
check('astral chars bypass', !segmentShapingEligible('a\u{1F600}b'));
check('object replacement bypasses', !segmentShapingEligible('a￼b'));

// Bypassed inputs still shape (identically, through the whole-run path).
for (const text of ['hy­phen ate', 'hard \n break', 'при вет мир']) {
  check(`bypassed input still shapes: ${JSON.stringify(text)}`, compare(faces[0].key, text) === null);
}

// --- 2. pairwise sweep across a space, every face ----------------------
for (const face of faces) {
  let diff: string | null = null;
  let at = '';
  outer: for (const a of SEGMENT_SAFE_CHARS) {
    for (const b of SEGMENT_SAFE_CHARS) {
      const d = compare(face.key, `${a} ${b}`);
      if (d) {
        diff = d;
        at = `U+${a.codePointAt(0)!.toString(16)} U+${b.codePointAt(0)!.toString(16)}`;
        break outer;
      }
    }
  }
  check(
    `${face.key}: ${SEGMENT_SAFE_CHARS.length}² char pairs across a space stitch bit-identically` +
      (diff ? ` (${at}: ${diff})` : ''),
    diff === null,
  );
}

// --- 3. seeded fuzz: longer contexts, multiple/leading/trailing spaces --
let rngState = 0x2f6e2b1;
const rnd = () => ((rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
let fuzzDiff: string | null = null;
let fuzzCase = '';
for (let iter = 0; iter < 8000 && !fuzzDiff; iter++) {
  const key = faces[iter % faces.length].key;
  let text = '';
  const len = 3 + Math.floor(rnd() * 40);
  for (let i = 0; i < len; i++) {
    text += rnd() < 0.2 ? ' ' : SEGMENT_SAFE_CHARS[Math.floor(rnd() * SEGMENT_SAFE_CHARS.length)];
  }
  const d = compare(key, text);
  if (d) {
    fuzzDiff = d;
    fuzzCase = `${key} ${JSON.stringify(text)}`;
  }
}
check(`8000 seeded random strings stitch bit-identically${fuzzDiff ? ` (${fuzzCase}: ${fuzzDiff})` : ''}`, fuzzDiff === null);

// --- 4. real-text corpus, raw glyph level ------------------------------
const CORPUS = [
  'The Knuth-Plass algorithm is based on the idea of cost. A line which has a very tight or ' +
    'very loose fit has a higher cost than one that is just right. Ending a line with a hyphen ' +
    'incurs extra cost and ending two successive lines with hyphens even more.',
  'Antidisestablishmentarianism, floccinaucinihilipilification, and pseudopseudohypoparathyroidism ' +
    'are exemplary hyphenation candidates for narrow measures everywhere.',
  '“Quotation marks,” she said — with an em-dash aside — ‘and single ones’ … plus an ellipsis; ' +
    'en-dash ranges 1914–1918 and minus-like hyphens co-operate.',
  'Zür ich, naïve façade, crème brûlée, jalapeño, smörgåsbord, œuvre, Ærø — Latin-1 accents ' +
    'through the certified charset.',
  'Efficient offices affix fifty-five affluent waffles; final fjord flight (ligature-rich: fi fl ff ffi ffl).',
  '   leading spaces, trailing spaces   ',
  'x',
  '',
];
for (const face of faces) {
  let diff: string | null = null;
  let which = -1;
  for (let i = 0; i < CORPUS.length; i++) {
    const d = compare(face.key, CORPUS[i]);
    if (d) {
      diff = d;
      which = i;
      break;
    }
  }
  check(`${face.key}: corpus paragraphs stitch bit-identically${diff ? ` (#${which}: ${diff})` : ''}`, diff === null);
}

// --- 5. full pipeline: prepare + linebreak, fast path on vs off --------
interface LineSig {
  end: number;
  kind: string;
  width: number;
  dash: string | null;
  justify: boolean;
}
function pipeline(segments: InputSegment[], measure: number): LineSig[] {
  const p = prepare(segments, defaultConfig(11));
  return linebreak(p, measure).map((ln) => ({
    end: ln.endByte,
    kind: ln.bp.kind,
    width: ln.width,
    dash: ln.dash,
    justify: ln.justify,
  }));
}
const regular = DEFAULT_FONT.portKeys.regular;
const bold = DEFAULT_FONT.portKeys.bold;
const italic = DEFAULT_FONT.portKeys.italic;
const PIPELINE_CASES: Array<{ name: string; segments: InputSegment[] }> = [
  {
    name: 'plain hyphenating paragraph',
    segments: [{ kind: 'text', text: CORPUS[0] + ' ' + CORPUS[1], styleKey: regular }],
  },
  {
    name: 'dashes and quotes',
    segments: [{ kind: 'text', text: CORPUS[2], styleKey: regular }],
  },
  {
    name: 'mixed marks with math atoms',
    segments: [
      { kind: 'text', text: 'A paragraph with ', styleKey: regular },
      { kind: 'text', text: 'bold emphasis ', styleKey: bold },
      { kind: 'text', text: 'and italic asides ', styleKey: italic },
      { kind: 'text', text: 'and inline code ', styleKey: COMMON_PORT_KEYS.mono, fontSize: 8.8 },
      { kind: 'atom', width: 27.5 },
      { kind: 'text', text: ' interleaved with measured atoms ', styleKey: regular },
      { kind: 'atom', width: 12.25 },
      { kind: 'text', text: ' that the breaker must place — repeatedly, across several lines of text.', styleKey: regular },
    ],
  },
  {
    name: 'non-ASCII Latin with accents',
    segments: [{ kind: 'text', text: CORPUS[3] + ' ' + CORPUS[4], styleKey: regular }],
  },
];
for (const { name, segments } of PIPELINE_CASES) {
  for (const measure of [140, 180, 220, 320]) {
    prim.segmentShapingEnabled = false;
    prim.clearShapeCaches();
    const reference = pipeline(segments, measure);
    prim.segmentShapingEnabled = true;
    prim.clearShapeCaches();
    const stitchedRun = pipeline(segments, measure);
    const same = JSON.stringify(reference) === JSON.stringify(stitchedRun);
    check(`pipeline ${name} @ ${measure}pt: identical breaks, widths, hyphens`, same);
  }
}
prim.segmentShapingEnabled = true;

if (failed) process.exit(1);
console.log('\nall segment-stitched shaping differentials passed');
