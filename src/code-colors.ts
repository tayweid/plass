// Code colors: a code block's syntax colors, asked of the compiler that
// prints it (Taylor, 2026-11-12: "ask the compiler").
//
// A fence with a language prints highlighted: Typst colors a raw block by
// its own highlighter and theme. The page has no highlighter of its own.
// It sends the block (the very source the export prints, `rawBlockTyp`)
// to the in-app Typst, in the worker math ink uses, with a show rule that
// reports every piece of every line and the fill it is set in, and paints
// what comes back. So the page's colors are the print's by construction,
// for every language and any theme Typst has, and a language Typst does
// not know is plain in both.
//
// Paint only. A color moves nothing; the theme's bold and italic (a
// Markdown listing's heading) print in the one mono face the compiler is
// given (DejaVuSansMono.ttf, regular: Typst synthesizes neither), so the
// page draws neither; an underline (a Typst listing's heading, a Markdown
// link) is ink in print and a text decoration here.
//
// Measured 2026-11-12, Typst 0.14.2 in the worker: 4-8 ms for a short
// block once the compiler is up, 150 ms for 420 lines, 200 ms the first
// time (the compiler's load).

import { compilerCircuitEpoch } from './compiler-circuit';
import { rawBlockTyp } from './code-language';

/** A run of a code block's text set apart from plain: offsets into the
 *  block's text (UTF-16, `to` exclusive). `color` null: the text's own
 *  color, underlined. */
export interface CodeSpan {
  from: number;
  to: number;
  color: string | null;
  underline: boolean;
}

/** A block larger than this is never asked for (it stays plain on the
 *  page): its answer would run past the worker's query budget. */
const MAX_COLORED_CHARS = 200_000;

const LABEL = 'plass-code';

/** The show rule that makes Typst say what it paints: inside each raw
 *  line, every text piece reports its line, its text and the fill it is
 *  set in (the highlighter sets a piece's fill, or leaves the text's
 *  own), and an underline brackets its pieces. */
const PRELUDE =
  '#set page(width: auto, height: auto, margin: 0pt)\n' +
  '#show raw.line: it => {\n' +
  `  show underline: u => [#metadata("u+")<${LABEL}>#u#metadata("u-")<${LABEL}>]\n` +
  `  show text: t => context [#metadata((it.number, t.text, text.fill.to-hex()))<${LABEL}>#t]\n` +
  '  it\n' +
  '}\n';

/** The Typst source one block's colors are asked with. */
export function codeColorSource(lang: string, text: string): string {
  return PRELUDE + rawBlockTyp(lang, text) + '\n';
}

const CODE_COLOR_SELECTOR = `<${LABEL}>`;

/** Typst's line ends (`is_newline`), a CR LF being one. */
const NEWLINE = /\r\n|[\n\x0B\x0C\r\u0085\u2028\u2029]/g;

/** Raw text's tab size: Typst's default, which the export leaves. */
const TAB_SIZE = 2;

interface Line {
  /** The line as Typst lays it: tabs run out to the next tab stop
   *  (`align_tabs`). */
  text: string;
  /** For each index of `text`, and one past its end, the offset in the
   *  block's text it came from. */
  at: number[];
}

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  const add = (start: number, end: number) => {
    let line = '';
    const at: number[] = [];
    let column = 0;
    for (let i = start; i < end; ) {
      const cp = text.codePointAt(i)!;
      const size = cp > 0xffff ? 2 : 1;
      if (cp === 9) {
        const need = TAB_SIZE - (column % TAB_SIZE);
        for (let k = 0; k < need; k++) {
          line += ' ';
          at.push(i);
        }
        column += need;
      } else {
        line += text.slice(i, i + size);
        for (let k = 0; k < size; k++) at.push(i + k);
        column++;
      }
      i += size;
    }
    at.push(end);
    out.push({ text: line, at });
  };
  let start = 0;
  NEWLINE.lastIndex = 0;
  for (let m = NEWLINE.exec(text); m; m = NEWLINE.exec(text)) {
    add(start, m.index);
    start = m.index + m[0].length;
  }
  add(start, text.length);
  return out;
}

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
/** The fill of text no rule colored: the page's own text color. */
const PLAIN = '#000000';

/**
 * The compiler's answer as spans of the block's text. Null when the
 * answer does not account for the text exactly, piece by piece and line
 * by line (then the block stays plain: a color in the wrong place would
 * be a lie about the print).
 */
export function codeSpans(text: string, rows: unknown[]): CodeSpan[] | null {
  const lines = linesOf(text);
  const spans: CodeSpan[] = [];
  let underline = 0;
  let current = 0;
  let column = 0;
  const seen = new Set<number>();
  const lineDone = () => current === 0 || column === lines[current - 1].text.length;
  for (const row of rows) {
    const value = row && typeof row === 'object' && 'value' in row ? (row as { value: unknown }).value : row;
    if (value === 'u+') {
      underline++;
      continue;
    }
    if (value === 'u-') {
      underline--;
      continue;
    }
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [n, piece, fill] = value as [unknown, unknown, unknown];
    if (typeof n !== 'number' || typeof piece !== 'string' || typeof fill !== 'string' || !HEX.test(fill)) return null;
    if (n !== current) {
      if (!lineDone() || !Number.isInteger(n) || n < 1 || n > lines.length || seen.has(n)) return null;
      current = n;
      column = 0;
      seen.add(n);
    }
    const line = lines[current - 1];
    if (!line.text.startsWith(piece, column)) return null;
    const from = line.at[column];
    const to = line.at[column + piece.length];
    column += piece.length;
    const color = fill.toLowerCase() === PLAIN ? null : fill.toLowerCase();
    if (to <= from || (color === null && underline <= 0)) continue;
    const last = spans[spans.length - 1];
    if (last && last.to === from && last.color === color && last.underline === underline > 0) last.to = to;
    else spans.push({ from, to, color, underline: underline > 0 });
  }
  if (!lineDone()) return null;
  // A line Typst reported nothing for holds nothing.
  for (let i = 0; i < lines.length; i++) if (!seen.has(i + 1) && lines[i].text.length) return null;
  return spans;
}

// ---------- the cache and the compiler ----------

interface Deferred {
  deferred: true;
  /** The circuit epoch the attempt ran in; a later one may retry. */
  epoch: number;
}

type Entry = CodeSpan[] | 'pending' | 'failed' | Deferred;

const isDeferred = (v: Entry | undefined): v is Deferred => typeof v === 'object' && !Array.isArray(v);

const cache = new Map<string, Entry>();
const MAX_ENTRIES = 400;
const keyOf = (lang: string, text: string) => `${lang}\n${text}`;

interface Wanted {
  key: string;
  lang: string;
  text: string;
}

let queue: Wanted[] = [];
let running = false;
const listeners = new Set<() => void>();

/** The colors of a block, once the compiler has answered: its spans (none
 *  for a block Typst leaves plain, or one it could not color). Undefined
 *  while no answer is in. */
export function getCodeColors(lang: string, text: string): CodeSpan[] | undefined {
  const v = cache.get(keyOf(lang, text));
  if (Array.isArray(v)) return v;
  return v === 'failed' ? [] : undefined;
}

/** Called when answers arrive (once per batch). */
export function onCodeColors(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The blocks whose colors are wanted now: every one not yet answered is
 * asked for, and what was queued for a text no longer wanted (the block
 * as it stood a keystroke ago) is dropped unasked.
 */
export function wantCodeColors(blocks: Array<{ lang: string; text: string }>): void {
  const epoch = compilerCircuitEpoch();
  const next: Wanted[] = [];
  const keys = new Set<string>();
  for (const { lang, text } of blocks) {
    if (!lang || text.length > MAX_COLORED_CHARS) continue;
    const key = keyOf(lang, text);
    if (keys.has(key)) continue;
    const v = cache.get(key);
    // A block the compiler could not run waits for a compiler lifecycle
    // its failure did not poison (math ink's rule).
    if (v === undefined || v === 'pending' || (isDeferred(v) && v.epoch < epoch)) {
      keys.add(key);
      next.push({ key, lang, text });
    }
  }
  for (const item of queue) if (!keys.has(item.key) && cache.get(item.key) === 'pending') cache.delete(item.key);
  for (const item of next) cache.set(item.key, 'pending');
  queue = next;
  if (queue.length && !running) void run();
}

async function run(): Promise<void> {
  running = true;
  let answered = false;
  try {
    const { runCompilerTask, CompilerWorkerError } = await import('./typst-worker-client');
    const { COMPILER_DEADLINES } = await import('./typst-worker-protocol');
    while (queue.length) {
      const item = queue.shift()!;
      // Dropped while it waited, or answered by an earlier batch.
      if (cache.get(item.key) !== 'pending') continue;
      const epoch = compilerCircuitEpoch();
      let entry: Entry;
      try {
        const rows = await runCompilerTask<unknown[]>(
          { kind: 'query', source: codeColorSource(item.lang, item.text), selector: CODE_COLOR_SELECTOR },
          { timeoutMs: COMPILER_DEADLINES.previewMs },
        );
        entry = codeSpans(item.text, rows) ?? 'failed';
      } catch (error) {
        // Typst's verdict on the block is final; a compiler that could not
        // run (timeout, paused circuit, full queue, not loadable) says
        // nothing about it.
        const code = error instanceof CompilerWorkerError ? error.code : 'crash';
        entry = code === 'compile' || code === 'invalid' || code === 'output-limit' ? 'failed' : { deferred: true, epoch };
        if (isDeferred(entry)) console.warn('code colors deferred', error);
      }
      cache.set(item.key, entry);
      answered = true;
      // Each answer is painted as it lands: a long block ahead in the
      // queue does not hold a short one's colors back.
      if (queue.length) notify();
    }
    if (cache.size > MAX_ENTRIES) {
      const keys = [...cache.keys()];
      for (let i = 0; i < keys.length / 2; i++) if (cache.get(keys[i]) !== 'pending') cache.delete(keys[i]);
    }
  } finally {
    running = false;
  }
  if (answered) notify();
}

function notify(): void {
  for (const fn of listeners) fn();
}
