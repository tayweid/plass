// The Typst line-break oracle (spec M0): the editor's structural answer to
// "why aren't the editor and the PDF pixel-identical?" — because two
// independent Knuth-Plass implementations may choose different optima. This
// module removes the second decider: paragraphs are compiled by the real
// Typst (WASM, in-app) and its exact break decisions are imposed on the DOM.
//
// Extraction channel: the compiled SVG's invisible text-selection layer
// (.tsel spans) — one per rendered text run, carrying the line's actual
// text. The compiled document is byte-identical to what the PDF pipeline
// sees (no probes, no instrumentation), so the breaks are guaranteed
// faithful; an earlier probe-injection design perturbed knife-edge breaks
// through sub-pixel item-boundary effects. Line texts are matched back to
// character offsets word by word; hyphenation points arrive textually
// (the line ends with a word prefix).
//
// The JS Knuth-Plass remains the instant first pass and the fallback for
// content the matcher can't align.

import type { Node as PMNode } from 'prosemirror-model';
import { escapeTyp, parityRules, textSetLine } from '../typ-serializer';
import type { DocSettings } from '../settings';
import type { ForcedBreak } from './paragraph';
import { parseTypstSvg } from '../safe-svg';
import { EDIT_SETTLE_DELAY_MS } from './layout-scheduler';

/** A word (or atom) with its offsets in the block's content. */
interface Token {
  kind: 'word' | 'atom' | 'hard';
  start: number;
  end: number;
  /** The exact rendered text, when known (words, citations, refs, raw). */
  text?: string;
  /** Whether a space separates this token from the previous one. */
  spaceBefore: boolean;
}

export interface ParagraphSpec {
  /** Cache key: the exact content signature. */
  key: string;
  /** Clean Typst markup for the paragraph body (exactly what the PDF sees). */
  src: string;
  tokens: Token[];
  hasMath: boolean;
}

export interface ResolvedAtom {
  /** Typst markup for the atom (must render exactly as the PDF will). */
  markup: string;
  /** Rendered text as it appears in the selection layer, when known. */
  text?: string;
}

export interface AtomResolver {
  (child: PMNode): ResolvedAtom | null;
}

/**
 * Build the Typst markup + token table for one paragraph. Returns null when
 * the paragraph contains content we can't represent — the caller keeps using
 * the JS oracle for it.
 */
export function buildSpec(node: PMNode, resolveAtom: AtomResolver): ParagraphSpec | null {
  let src = '';
  let key = '';
  const tokens: Token[] = [];
  let hasMath = false;
  let failed = false;
  let pendingSpace = false;

  const take = () => {
    const sp = pendingSpace;
    pendingSpace = false;
    return sp;
  };

  node.forEach((child, offset) => {
    if (failed) return;
    if (child.isText && child.text) {
      const marks = new Set(child.marks.map((m) => m.type.name));
      if (marks.has('code')) {
        src += '`' + child.text + '`';
        tokens.push({
          kind: 'atom',
          start: offset,
          end: offset + child.text.length,
          text: child.text,
          spaceBefore: take(),
        });
        key += '`' + child.text + '`';
        return;
      }
      let inner = '';
      const re = /\s+|\S+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(child.text))) {
        const token = m[0];
        if (/\s/.test(token[0])) {
          pendingSpace = true;
          // A run containing U+00A0 must emit as ~ or the probe would let
          // Typst break where the document forbids it.
          inner += token.includes('\u00a0') ? '~' : ' ';
          continue;
        }
        tokens.push({
          kind: 'word',
          start: offset + m.index,
          end: offset + m.index + token.length,
          text: token,
          spaceBefore: take(),
        });
        inner += escapeTyp(token);
      }
      let t = inner;
      if (marks.has('strong')) t = `*${t}*`;
      if (marks.has('em')) t = `_${t}_`;
      if (marks.has('strike')) t = `#strike[${t}]`;
      src += t;
      key += `[${[...marks].sort().join(',')}]${child.text}`;
    } else if (child.type.name === 'hard_break') {
      src += ' \\\n';
      tokens.push({ kind: 'hard', start: offset, end: offset + child.nodeSize, spaceBefore: take() });
      key += '\\\\';
    } else {
      const resolved = resolveAtom(child);
      if (resolved === null) {
        failed = true;
        return;
      }
      if (child.type.name === 'math_inline') hasMath = true;
      src += resolved.markup;
      tokens.push({
        kind: 'atom',
        start: offset,
        end: offset + child.nodeSize,
        text: resolved.text,
        spaceBefore: take(),
      });
      key += `⟦${resolved.markup}⟧`;
    }
  });

  if (failed || !tokens.some((t) => t.kind === 'word' || t.kind === 'atom')) return null;
  return { key, src, tokens, hasMath };
}

export interface OracleEntry {
  status: 'ok' | 'fail';
  breaks?: ForcedBreak[];
  /** Why classification failed (diagnostic only). */
  reason?: string;
}

/** What context a spec compiles in (affects wrapping + painted prefixes). */
export type SpecKind = { kind: 'body' } | { kind: 'caption'; figNo: number } | { kind: 'footnote' };

interface Queued {
  spec: ParagraphSpec;
  widthPx: number;
  skind: SpecKind;
  /** Body paragraph carrying the classic first-line indent. */
  indented: boolean;
  /** Stable identity of the requesting block (supersession tracking): a
   * newer spec for the same block makes an older one permanently dead. */
  blockId?: string;
}

const MAX_RESULTS = 800;
/** How often a finished compile re-checks for quiet before analyzing. */
const QUIET_POLL_MS = 100;
/** Hyphen-like characters Typst may append to a hyphenated line. */
const HYPHENS = /[-‐‑\u00ad]+$/;

export class TypstOracle {
  results = new Map<string, OracleEntry>();
  queue = new Map<string, Queued>();
  private timer = 0;
  inflight = false;
  disposed = false;
  private settings: DocSettings | null = null;
  /** Invalidates completions that were already compiling when clear() or
   * destroy() was called. The underlying compiler task cannot be cancelled,
   * so publication has to be guarded when it returns. */
  private generation = 0;
  /** Latest requested key per block identity: an in-flight or queued compile
   * whose key is no longer the block's latest is dead and its result must
   * never reach the main-thread analysis step. */
  private latestForBlock = new Map<string, string>();

  constructor(
    private onResults: () => void,
    private fontFallback: string[],
    private compileSvg: (source: string) => Promise<string | null> = async (source) => {
      const { compileSvg } = await import('../pdf');
      return compileSvg(source);
    },
    /** Whether the user is inside an edit's quiet window (mid typing burst).
     * While true, no compile launches and no finished result is analyzed. */
    private isEditing: () => boolean = () => false,
  ) {}

  get(key: string): OracleEntry | undefined {
    return this.results.get(key);
  }

  request(
    key: string,
    spec: ParagraphSpec,
    widthPx: number,
    settings: DocSettings,
    skind: SpecKind = { kind: 'body' },
    indented = false,
    blockId?: string,
  ) {
    if (this.disposed || this.results.has(key) || this.queue.has(key)) return;
    if (blockId) {
      // A newer spec for the same block supersedes an older one: the old
      // text can never be verified against the document again. Drop it from
      // the queue before it costs a compile.
      const prior = this.latestForBlock.get(blockId);
      if (prior !== undefined && prior !== key) this.queue.delete(prior);
      this.latestForBlock.set(blockId, key);
      if (this.latestForBlock.size > MAX_RESULTS) {
        const ids = [...this.latestForBlock.keys()];
        for (let i = 0; i < ids.length / 2; i++) this.latestForBlock.delete(ids[i]);
      }
    }
    this.queue.set(key, { spec, widthPx, skind, indented, blockId });
    this.settings = settings;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 80);
  }

  clear() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = 0;
    this.results.clear();
    this.queue.clear();
    this.latestForBlock.clear();
    this.settings = null;
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = 0;
    this.queue.clear();
    this.latestForBlock.clear();
    this.settings = null;
  }

  private async flush() {
    if (this.disposed || this.inflight || !this.queue.size || !this.settings) return;
    // Never launch a compile mid-burst: the next keystroke would invalidate
    // it. Requests keep coalescing into the queue; the flush retries once
    // the edit-settle window can have elapsed.
    if (this.isEditing()) {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.flush(), EDIT_SETTLE_DELAY_MS);
      return;
    }
    // A key can be re-queued while its first compile was in flight (the
    // settled pass re-requests anything not yet published). Published
    // answers win — recompiling them would be pure waste.
    for (const key of this.queue.keys()) if (this.results.has(key)) this.queue.delete(key);
    if (!this.queue.size) return;
    this.inflight = true;
    const generation = this.generation;
    // One compile per measure: indented paragraphs (quotes, list items) have
    // narrower lines and must be broken at their own width. Footnote specs
    // compile separately — their lines render at the page bottom, after all
    // content lines, so mixing kinds would scramble the cursor order.
    const first = [...this.queue.values()][0];
    const isFn = first.skind.kind === 'footnote';
    const width0 = first.widthPx;
    const batch: Array<[string, Queued]> = [];
    for (const [k, q] of this.queue) {
      if (
        Math.abs(q.widthPx - width0) < 0.5 &&
        (q.skind.kind === 'footnote') === isFn &&
        q.indented === first.indented
      ) {
        batch.push([k, q]);
        this.queue.delete(k);
      }
    }
    try {
      const s = this.settings;
      const widthPt = width0 * 0.75;
      const hasMath = batch.some(([, q]) => q.spec.hasMath);
      let src = `#set page(width: ${widthPt.toFixed(3)}pt, height: auto, margin: 0pt)\n`;
      src += parityRules(s);
      src += textSetLine(s, this.fontFallback);
      if (hasMath) src += '#import "@preview/mitex:0.2.5": mi, mitex\n';
      // Fragments batch several paragraphs into one compile, so "consecutive"
      // is an artifact of batching, not of the document. Pin the indent
      // explicitly: on (all lines) for indented specs, off for everything
      // else — parityRules' document-level rule must not leak in.
      src += first.indented && !isFn
        ? '#set par(first-line-indent: (amount: 1.5em, all: true))\n'
        : '#set par(first-line-indent: 0pt)\n';
      src += '\n';
      if (isFn) {
        // One anchor paragraph carrying every marker; the bodies render in
        // Typst's real footnote-entry context (its size, leading, indent).
        src += '#h(0pt)' + batch.map(([, q]) => `#footnote[${q.spec.src}]`).join('') + '\n';
      } else {
        src += batch
          .map(([, q]) =>
            q.skind.kind === 'caption'
              ? `#counter(figure.where(kind: image)).update(${q.skind.figNo - 1})\n` +
                `#figure(rect(height: 0pt, stroke: none), kind: image, supplement: [Figure], caption: [${q.spec.src}])`
              : q.spec.src,
          )
          .join('\n\n');
      }

      if (this.disposed || generation !== this.generation) return;
      const svg = await this.compileSvg(src);
      if (this.disposed || generation !== this.generation) return;

      // Result analysis parses, mounts, and measures the compiled SVG on the
      // main thread. Mid-burst that steals frames from typing: hold the
      // finished compile until the user goes quiet again.
      while (this.isEditing()) {
        await new Promise((resolve) => window.setTimeout(resolve, QUIET_POLL_MS));
        if (this.disposed || generation !== this.generation) return;
      }
      // Edits during the compile may have superseded batch members. A key
      // that is no longer its block's latest is dead: nothing will ever read
      // it, so when the whole batch is dead the analysis is skipped outright
      // (the finally block still reflushes whatever is queued).
      const isLive = ([key, q]: [string, Queued]) =>
        q.blockId === undefined || this.latestForBlock.get(q.blockId) === key;
      if (!batch.some(isLive)) return;

      // Geometry thresholds at the SVG's 1px-per-pt scale.
      const pitch = s.lineHeight * s.sizePt;
      const paraGap = (s.lineHeight + 0.45) * s.sizePt; // between pitch and paragraph pitch
      const lines = svg ? extractLines(svg, pitch / 2) : null;
      let cursor = isFn ? 1 : 0; // footnotes: skip the anchor-markers line
      for (const [key, q] of batch) {
        // A dead member still advances the line cursor below (the batch
        // shares one compiled document) but its entry is never published.
        const publish = isLive([key, q])
          ? (entry: OracleEntry) => this.results.set(key, entry)
          : () => {};
        if (!lines) {
          publish({ status: 'fail', reason: 'compile failed' });
          continue;
        }
        const stripFirst =
          q.skind.kind === 'caption'
            ? /^Figure \d+:\s*/
            : q.skind.kind === 'footnote'
              ? /^\d+\s*/
              : undefined;
        const res = matchParagraph(q.spec, lines, cursor, stripFirst);
        if (res.status === 'ok') {
          cursor = res.next;
        } else {
          cursor = skipParagraph(lines, cursor, paraGap);
        }
        publish(res.entry);
      }
      if (this.results.size > MAX_RESULTS) {
        const keys = [...this.results.keys()];
        for (let i = 0; i < keys.length / 2; i++) this.results.delete(keys[i]);
      }
    } catch (e) {
      if (this.disposed || generation !== this.generation) return;
      console.warn('typst oracle batch failed', e);
      for (const [key] of batch) this.results.set(key, { status: 'fail', reason: String(e).slice(0, 120) });
    } finally {
      this.inflight = false;
      if (!this.disposed && this.queue.size) {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.flush(), 20);
      }
    }
    if (!this.disposed && generation === this.generation) this.onResults();
  }
}

export interface SvgLine {
  text: string;
  y: number;
}

/**
 * Mount the SVG off-screen and read the text-selection layer, line by line.
 * The .tsel spans are fixed-position overlays, so their x is meaningless —
 * runs stay in DOCUMENT ORDER (Typst emits reading order) and merge into a
 * line while their y stays put.
 */
export function extractLines(svg: string, yTol: number): SvgLine[] {
  const div = parseTypstSvg(svg);
  div.style.cssText = 'position:absolute;visibility:hidden;left:-99999px;top:0;';
  const svgEl = div.querySelector('svg');
  if (!svgEl) return [];
  svgEl.style.width = svgEl.getAttribute('width') + 'px';
  svgEl.style.height = 'auto';
  document.body.appendChild(div);
  const top = svgEl.getBoundingClientRect().top;
  const lines: SvgLine[] = [];
  for (const el of div.querySelectorAll('.tsel')) {
    const y = el.getBoundingClientRect().top - top;
    const text = el.textContent ?? '';
    const L = lines[lines.length - 1];
    if (L && Math.abs(y - L.y) < yTol) L.text += text;
    else lines.push({ text, y });
  }
  div.remove();
  return lines;
}

/** Advance past the next paragraph-sized gap (fallback resync). */
function skipParagraph(lines: SvgLine[], from: number, paraGap: number): number {
  for (let i = from + 1; i < lines.length; i++) {
    if (lines[i].y - lines[i - 1].y > paraGap) return i;
  }
  return lines.length;
}

/**
 * Match a paragraph's tokens against consecutive SVG lines; every line
 * boundary becomes a break. Tokens carry their exact rendered text and
 * whether a space precedes them, so glued punctuation and inline atoms
 * match precisely; unknown-text atoms (math) consume up to the next known
 * token. Hyphenations show up textually: a line ends with a prefix of the
 * pending word.
 */
export function matchParagraph(
  spec: ParagraphSpec,
  lines: SvgLine[],
  cursor: number,
  stripFirst?: RegExp,
): { status: 'ok'; next: number; entry: OracleEntry } | { status: 'fail'; entry: OracleEntry } {
  const fail = (reason: string) => ({ status: 'fail' as const, entry: { status: 'fail' as const, reason } });
  const breaks: ForcedBreak[] = [];
  const tokens = spec.tokens;
  let ti = 0;
  let li = cursor;
  /** Rest of a word split by hyphenation on the previous line. */
  let pendingSuffix: string | null = null;

  while (ti < tokens.length || pendingSuffix) {
    if (li >= lines.length) return fail('ran out of lines');
    let text = lines[li].text.replace(/\s+/g, ' ').trim();
    // Painted prefixes ("Figure N: ", the entry number) are not tokens.
    if (stripFirst && li === cursor) text = text.replace(stripFirst, '');
    const lineStartTi = ti;
    let brokeWithHyphen = false;

    while (text.length) {
      if (pendingSuffix) {
        if (text.startsWith(pendingSuffix)) {
          text = text.slice(pendingSuffix.length).trimStart();
          pendingSuffix = null;
          continue;
        }
        return fail(`suffix mismatch: expected '${pendingSuffix}' got '${text.slice(0, 24)}'`);
      }
      if (ti >= tokens.length) return fail(`extra line text: '${text.slice(0, 24)}'`);
      const tok = tokens[ti];
      if (tok.kind === 'hard') {
        ti++;
        continue;
      }
      if (tok.text === undefined) {
        // Unknown-text atom (math): consume up to the next known token.
        let nj = ti + 1;
        while (nj < tokens.length && tokens[nj].kind === 'atom' && tokens[nj].text === undefined) nj++;
        const next = nj < tokens.length && tokens[nj].kind !== 'hard' ? tokens[nj] : null;
        if (!next || next.text === undefined) {
          text = '';
          ti = next ? ti + 1 : tokens.length;
          continue;
        }
        const needle = (next.spaceBefore ? ' ' : '') + next.text;
        const idx = (text + ' ').indexOf(needle);
        if (idx < 0) {
          // Next known token is on a later line: this atom owns the rest.
          text = '';
          ti++;
          continue;
        }
        text = text.slice(idx).trimStart();
        ti++;
        continue;
      }
      // Known text (word or atom with known rendering).
      const w = tok.text;
      // Inter-token space: mid-line it must be present; at line start it
      // was consumed by the break.
      const rest = text;
      if (rest.startsWith(w)) {
        const after = rest.slice(w.length);
        // Must end at a boundary: end, space, or a next token that is
        // explicitly glued (spaceBefore false).
        const glueNext = ti + 1 < tokens.length && !tokens[ti + 1].spaceBefore;
        if (after === '' || after.startsWith(' ') || glueNext) {
          text = after.trimStart() === after && after !== '' && !after.startsWith(' ') ? after : after.trimStart();
          ti++;
          continue;
        }
      }
      // Hyphenation: the line ends with a proper prefix of this word.
      if (tok.kind === 'word') {
        const bare = text.replace(HYPHENS, '');
        if (text.length <= w.length + 1 && bare.length > 0 && bare.length < w.length && w.startsWith(bare)) {
          // At an existing '-' the dash stays on this line and no glyph is
          // added; the break offset sits just past it.
          const dash = w[bare.length] === '-' ? 1 : 0;
          breaks.push({ at: tok.start + bare.length + dash, hyphen: true });
          pendingSuffix = w.slice(bare.length + dash);
          ti++;
          text = '';
          brokeWithHyphen = true;
          continue;
        }
      }
      return fail(`token mismatch: expected '${w}' got '${text.slice(0, 24)}'`);
    }

    // Line consumed. If the paragraph continues, this boundary is a break.
    const more = ti < tokens.length || pendingSuffix !== null;
    if (more && !brokeWithHyphen) {
      if (ti === lineStartTi) return fail('empty line inside paragraph');
      const prev = tokens[ti - 1];
      // Hard breaks cut by themselves — no forced break needed.
      if (prev.kind !== 'hard') breaks.push({ at: prev.end, hyphen: false });
    }
    li++;
    if (!more) break;
  }

  return { status: 'ok', next: li, entry: { status: 'ok', breaks } };
}
