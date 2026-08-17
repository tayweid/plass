// The differ: proof harness for the Typst line-break port (PORT.md phase 4).
// For each (paragraph, measure): compile through the real Typst WASM (the
// oracle — ground truth by construction) and run the TS port on identical
// input; compare line texts string-for-string. Exposed as window.__differ
// for Playwright.

import { compileSvg } from './pdf';
import { extractLines } from './layout/typst-oracle';
import { loadPrimitives } from './layout/primitives';
import { defaultConfig, prepare } from './layout/port/prepare';
import { linebreak } from './layout/port/linebreak';
import { COMMON_PORT_KEYS, DEFAULT_FONT, cssFontStack } from './font-registry';

/** Escape plain prose for Typst markup. '-' is escaped so corpus hyphens
 * stay hyphen-minus (no smart-dash merging); straight quotes are escaped to
 * suppress smart quotes (the editor's serializer does the same for its
 * text). */
function escapeTypst(s: string): string {
  return s.replace(/[\\#$@*_`<>\[\]{}~'"-]/g, (m) => '\\' + m);
}

async function typstLines(c: DiffCase, measure: number, sizePt: number): Promise<string[] | null> {
  const body = c.segments
    ? c.segments.map((s) => (s.kind === 'text' ? escapeTypst(s.text) : `#box(width: ${s.width}pt)`)).join('')
    : escapeTypst(c.text);
  const src = [
    `#set page(width: ${measure + 20}pt, height: auto, margin: (x: 10pt))`,
    `#set text(font: "New Computer Modern", size: ${sizePt}pt, lang: "en")`,
    `#set par(justify: true)`,
    c.indentPt ? `#set par(first-line-indent: (amount: ${c.indentPt}pt, all: true))` : '',
    ``,
    body,
  ].join('\n');
  const svg = await compileSvg(src);
  if (!svg) return null;
  return extractLines(svg, sizePt).map((l) => l.text);
}

function portLines(c: DiffCase, measure: number, sizePt: number): string[] {
  const config = defaultConfig(sizePt);
  if (c.indentPt) config.firstLineIndent = c.indentPt;
  const segs = (c.segments ?? [{ kind: 'text', text: c.text } as CaseSeg]).map((s) =>
    s.kind === 'text'
      ? ({ kind: 'text', text: s.text, styleKey: DEFAULT_FONT.portKeys.regular } as const)
      : ({ kind: 'atom', width: s.width } as const),
  );
  const p = prepare(segs.slice(), config);
  const lines = linebreak(p, measure);
  const out: string[] = [];
  let start = 0;
  for (const ln of lines) {
    out.push(p.text.slice(start, ln.endByte));
    start = ln.endByte;
  }
  return out;
}

/** Normalize a line for comparison: collapse whitespace, strip soft/hard
 * hyphen artifacts at the end (tsel shows hyphenated lines as bare word
 * prefixes; the port's added hyphen glyph isn't part of the text). */
function norm(s: string): string {
  return s
    .replace(/\uFFFC/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-­]+$/, '');
}

export type CaseSeg = { kind: 'text'; text: string } | { kind: 'atom'; width: number };

export interface DiffCase {
  id: string;
  text: string;
  segments?: CaseSeg[];
  indentPt?: number;
  measures: number[];
  sizePt?: number;
}

export interface DiffResult {
  id: string;
  measure: number;
  ok: boolean;
  typst: string[];
  port: string[];
  error?: string;
}

async function differ(cases: DiffCase[]): Promise<DiffResult[]> {
  await loadPrimitives();
  const results: DiffResult[] = [];
  for (const c of cases) {
    const size = c.sizePt ?? 11;
    for (const measure of c.measures) {
      try {
        const typst = await typstLines(c, measure, size);
        if (!typst) {
          results.push({ id: c.id, measure, ok: false, typst: [], port: [], error: 'compile failed' });
          continue;
        }
        const port = portLines(c, measure, size);
        const a = typst.map(norm).filter((s) => s.length);
        const b = port.map(norm).filter((s) => s.length);
        const ok = a.length === b.length && a.every((s, i) => s === b[i]);
        results.push({ id: c.id, measure, ok, typst: a, port: b });
      } catch (e) {
        results.push({
          id: c.id,
          measure,
          ok: false,
          typst: [],
          port: [],
          error: String(e instanceof Error ? (e.stack ?? e.message) : e),
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// PM-level differ: build real ProseMirror paragraphs (marks, atoms, hard
// breaks), run the phase-2 adapter, and compare the resulting ForcedBreaks
// against Typst compiling the equivalent markup.

import { schema } from './schema';
import { portBreaks } from './layout/port/adapter';

export type PMPart =
  | { text: string; marks?: string[] }
  | { atom: number /* width pt */ }
  | { hard: true };

export interface PMCase {
  id: string;
  parts: PMPart[];
  measures: number[];
  sizePt?: number;
}

function pmMarkup(parts: PMPart[]): string {
  return parts
    .map((p) => {
      if ('atom' in p) return `#box(width: ${p.atom}pt)`;
      if ('hard' in p) return ' \\\n';
      let t = escapeTypst(p.text);
      const marks = p.marks ?? [];
      if (marks.includes('code')) return '`' + p.text + '`';
      if (marks.includes('strong')) t = `*${t}*`;
      if (marks.includes('em')) t = `_${t}_`;
      return t;
    })
    .join('');
}

async function pmTypstLines(c: PMCase, measure: number, sizePt: number): Promise<string[] | null> {
  const hasCode = c.parts.some((p) => 'text' in p && p.marks?.includes('code'));
  const src = [
    `#set page(width: ${measure + 20}pt, height: auto, margin: (x: 10pt))`,
    `#set text(font: "New Computer Modern", size: ${sizePt}pt, lang: "en")`,
    `#set par(justify: true)`,
    hasCode
      ? `#show raw.where(block: false): set text(font: "DejaVu Sans Mono", size: ${(0.8 * sizePt).toFixed(3)}pt)`
      : '',
    ``,
    pmMarkup(c.parts),
  ].join('\n');
  const svg = await compileSvg(src);
  if (!svg) return null;
  return extractLines(svg, sizePt).map((l) => l.text);
}

function pmPortLines(c: PMCase, measure: number, sizePt: number): string[] | null {
  const atomWidths = new Map<number, number>();
  const children = [];
  let pos = 0;
  for (const p of c.parts) {
    if ('atom' in p) {
      atomWidths.set(pos, p.atom / 0.75); // pt → px for the adapter
      children.push(schema.nodes.math_inline.create({ src: 'x' }));
      pos += 1;
    } else if ('hard' in p) {
      children.push(schema.nodes.hard_break.create());
      pos += 1;
    } else {
      children.push(schema.text(p.text, (p.marks ?? []).map((m) => schema.marks[m].create())));
      pos += p.text.length;
    }
  }
  const block = schema.nodes.paragraph.create(null, children);

  const breaks = portBreaks(
    block,
    measure / 0.75, // pt → px
    (offset) => atomWidths.get(offset) ?? NaN,
    {
      fontKeys: DEFAULT_FONT.portKeys,
      monoFontKey: COMMON_PORT_KEYS.mono,
      sizePt,
    },
  );
  if (!breaks) return null;

  // Reconstruct line texts: a string aligned so index == PM offset.
  let pmText = '';
  block.forEach((child, offset) => {
    if (child.isText && child.text) pmText = pmText.padEnd(offset) + child.text;
    else if (child.type.name === 'hard_break') pmText = pmText.padEnd(offset) + '\n';
    else pmText = pmText.padEnd(offset) + '￼';
  });

  const lines: string[] = [];
  let start = 0;
  for (const b of breaks) {
    lines.push(pmText.slice(start, b.at) + (b.hyphen ? '-' : ''));
    start = b.at;
    while (start < pmText.length && pmText[start] === ' ') start++;
  }
  lines.push(pmText.slice(start));
  // Mandatory breaks are not in the list — split at hard breaks.
  return lines.flatMap((l) => l.split('\n'));
}

async function differPM(cases: PMCase[]): Promise<DiffResult[]> {
  await loadPrimitives();
  const results: DiffResult[] = [];
  for (const c of cases) {
    const size = c.sizePt ?? 11;
    for (const measure of c.measures) {
      try {
        const typst = await pmTypstLines(c, measure, size);
        const port = pmPortLines(c, measure, size);
        if (!typst || !port) {
          results.push({
            id: c.id,
            measure,
            ok: false,
            typst: typst ?? [],
            port: port ?? [],
            error: !typst ? 'compile failed' : 'adapter returned null',
          });
          continue;
        }
        const a = typst.map(norm).filter((s) => s.length);
        const b = port.map(norm).filter((s) => s.length);
        const ok = a.length === b.length && a.every((s, i) => s === b[i]);
        results.push({ id: c.id, measure, ok, typst: a, port: b });
      } catch (e) {
        results.push({
          id: c.id,
          measure,
          ok: false,
          typst: [],
          port: [],
          error: String(e instanceof Error ? (e.stack ?? e.message) : e),
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Context differ: figure captions and footnote bodies, compiled EXACTLY the
// way the oracle compiles them (same fragment emission, same parity rules)
// and laid out by the port EXACTLY the way the plugin wires it (same indent
// formulas, same 0.85 scale for footnotes).

import { DEFAULT_SETTINGS } from './settings';
import { parityRules, textSetLine } from './typ-serializer';
import { FONT_FALLBACK } from './pdf';
import { defaultConfig as portConfig, prepare as portPrepare } from './layout/port/prepare';
import { primitives } from './layout/primitives';

export interface CtxCase {
  id: string;
  text: string;
  kind: 'caption' | 'footnote';
  figNo?: number;
  measures: number[]; // px, like the app's
}

const ctxCanvas = document.createElement('canvas').getContext('2d')!;
function ctxTextWidth(text: string, font: string): number {
  ctxCanvas.font = font;
  return ctxCanvas.measureText(text).width;
}

async function ctxTypstLines(c: CtxCase, measurePx: number): Promise<string[] | null> {
  const s = DEFAULT_SETTINGS;
  const widthPt = measurePx * 0.75;
  let src = `#set page(width: ${widthPt.toFixed(3)}pt, height: auto, margin: 0pt)\n`;
  src += parityRules(s);
  src += textSetLine(s, FONT_FALLBACK);
  src += '\n';
  const body = escapeTypst(c.text);
  if (c.kind === 'footnote') {
    src += `#h(0pt)#footnote[${body}]\n`;
  } else {
    const n = c.figNo ?? 1;
    src +=
      `#counter(figure.where(kind: image)).update(${n - 1})\n` +
      `#figure(rect(height: 0pt, stroke: none), kind: image, supplement: [Figure], caption: [${body}])`;
  }
  const svg = await compileSvg(src);
  if (!svg) return null;
  const pitch = s.lineHeight * s.sizePt;
  let lines = extractLines(svg, pitch / 2).map((l) => l.text);
  if (c.kind === 'footnote') lines = lines.slice(1); // anchor-markers line
  return lines;
}

function ctxPortLines(c: CtxCase, measurePx: number): string[] {
  const s = DEFAULT_SETTINGS;
  // px-per-em at the app's rendering: sizePt · 4/3.
  const bodyPx = s.sizePt * (4 / 3);
  const font = cssFontStack(s.font);
  const FN_SCALE = 0.85;
  let indentPx = 0;
  let scale = 1;
  let prefixText = '';
  if (c.kind === 'footnote') {
    const fnPx = FN_SCALE * bodyPx;
    const numPx = 0.72 * fnPx;
    indentPx = 0.9 * fnPx + ctxTextWidth('1', `${numPx}px ${font}`) + 0.15 * numPx;
    scale = FN_SCALE;
  } else {
    // The caption prefix is REAL TEXT in Typst — its trailing space
    // justifies with the line. Model it as text, not as an indent.
    prefixText = `Figure ${c.figNo ?? 1}: `;
  }
  const config = portConfig(s.sizePt * scale);
  if (indentPx) config.firstLineIndent = indentPx * 0.75;
  const p = portPrepare(
    [{ kind: 'text', text: prefixText + c.text, styleKey: DEFAULT_FONT.portKeys.regular }],
    config,
  );
  const lines = linebreak(p, measurePx * 0.75);
  const out: string[] = [];
  let start = 0;
  for (const ln of lines) {
    out.push(p.text.slice(start, ln.endByte));
    start = ln.endByte;
  }
  return out;
}

async function differCtx(cases: CtxCase[]): Promise<DiffResult[]> {
  await loadPrimitives();
  if (!primitives()) throw new Error('primitives failed to load');
  const results: DiffResult[] = [];
  for (const c of cases) {
    for (const measure of c.measures) {
      try {
        const typst = await ctxTypstLines(c, measure);
        if (!typst) {
          results.push({ id: c.id, measure, ok: false, typst: [], port: [], error: 'compile failed' });
          continue;
        }
        const port = ctxPortLines(c, measure);
        const a = typst.map(norm).filter((s) => s.length);
        // Strip the painted prefix from the first REAL line (the port
        // models it as a first-line indent, not text).
        if (a.length) a[0] = norm(a[0].replace(c.kind === 'caption' ? /^Figure \d+:\s*/ : /^\d+\s*/, ''));
        const b = port.map(norm).filter((s) => s.length);
        if (c.kind === 'caption' && b.length) b[0] = norm(b[0].replace(/^Figure \d+:\s*/, ''));
        const ok = a.length === b.length && a.every((s, i) => s === b[i]);
        results.push({ id: c.id, measure, ok, typst: a, port: b });
      } catch (e) {
        results.push({
          id: c.id,
          measure,
          ok: false,
          typst: [],
          port: [],
          error: String(e instanceof Error ? (e.stack ?? e.message) : e),
        });
      }
    }
  }
  return results;
}

declare global {
  interface Window {
    __differ: (cases: DiffCase[]) => Promise<DiffResult[]>;
    __differPM: (cases: PMCase[]) => Promise<DiffResult[]>;
    __differCtx: (cases: CtxCase[]) => Promise<DiffResult[]>;
  }
}
window.__differ = differ;
window.__differPM = differPM;
window.__differCtx = differCtx;
document.body.textContent = 'differ ready';
