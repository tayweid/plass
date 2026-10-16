// PM doc -> Typst markup (.typ) serialization (spec §3.3, serialize half).
//
// Math is authored as LaTeX (KaTeX). What Plass compiles and exports
// (`islands: 'print'`) is native Typst math, converted formula by formula
// (math-convert.ts), with the handles it names defined in the header
// (typst-math-prelude.ts). The working .typ file (`'file'`) keeps each
// formula's LaTeX in a `#mi`/`#mitex` call of the mitex package, so the
// file reopens exactly.

import type { Node as PMNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { normalizeSettings, parseMathMacros, type DocSettings, paperInches, DEFAULT_SETTINGS } from './settings';
import { wrapAligned } from './math-src';
import { isPortableCitationKey, parseBibTeX } from './bibtex';
import { RAW_FONT, codeBlockMetricsEm, effectiveFont, parityMetrics } from './font-registry';
import { TABLE_DENSITY_INSET_PT, type TableDensity } from './table-density';
import { rowRuleArg, type RowRule } from './table-rules';
import { CELL_FILL_TYPST, type CellFill } from './table-fills';
import type { CitationStyle } from './citation-styles';
import { commentToTyp } from './editor-comments-format';
import { MITEX_IMPORT, TYPST_EXACT_VERSION } from './typst-config';
import { convertMath, displayEquation, inlineEquation, mathConverterReady } from './math-convert';
import { mathPrelude } from './typst-math-prelude';
import { linkPrefixScan } from './layout/port/linebreak';

export interface TypExportOptions {
  /** When given, receives the text offset at which each top-level block's
   *  serialization begins (index = position of the block in `doc`). The
   *  source view maps a caret between the document and its text by block;
   *  nothing finer is promised (SOURCE-VIEW.md, decision 5). */
  offsets?: number[];
  /** Rewrite image sources (e.g. data: URLs to VFS paths for compilation). */
  resolveImage?: (src: string) => string;
  /** Extra font families appended to #set text(font: …) as fallbacks. */
  fontFallback?: string[];
  /**
   * Preview-only: wrap each table cell body in #link("cell://row-col")[…] so
   * compiled SVGs expose per-cell hit geometry for in-place editing.
   */
  cellLinks?: boolean;
  /**
   * What becomes of islands — raw Typst (`typst-raw` blocks, `typst_inline`
   * spans) and raw Markdown (`md-raw` blocks). 'file' (default) is the .typ
   * on disk: raw Typst verbatim, so the file never loses content. 'print'
   * is what Plass compiles (the audit, PDF): every island is a raw code
   * block or inline raw, shown as source and never run — the page shows the
   * same code block, so page and print agree (Typst on rails). Math too:
   * 'file' keeps each formula's LaTeX (`#mi`/`#mitex`); 'print' converts it
   * to native Typst math, which needs `ensureMathConverter()` awaited first
   * and throws MathConvertError for a formula the converter rejects.
   */
  islands?: 'file' | 'print';
}

/** A fence longer than any backtick run inside `text` (Typst raw blocks). */
function rawFence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(longest + 1);
}

/** An island as printed: a raw block, never executed. */
function islandBlock(text: string, indent: string): string {
  const fence = rawFence(text);
  return indent + fence + '\n' + text + '\n' + fence + '\n\n';
}

// ---------- editor↔Typst vertical parity ----------
//
// The editor lays text on a CSS grid (line-height, margins, paddings); Typst
// spaces tight glyph boxes (leading, par spacing, block above/below). These
// measured font constants + the formulas below make the exported document
// reproduce the editor's baseline geometry exactly (calibrated empirically;
// see README "Fidelity").
//   cssA/cssD: Chrome's ascent/descent for the font (line-box placement)
//   typAsc: a paragraph's Typst frame top above the editor's baseline
//   extent: Typst's baseline pitch at leading 0 — the body face's cap height
//   boldExtent: the same for a heading line — the bold face's cap height
// Every spacing the export emits is the editor's gap between two Typst
// frames, each frame placed in its editor box by pageTopAdjustEm (top) and
// pageBottomInsetEm (bottom): one model for the page and the print.
/**
 * First-baseline offset difference (Typst − editor CSS) in body em for a
 * unit type standing at a page top: Typst suppresses leading block spacing
 * and places the first baseline one ascender below the margin, while the
 * editor's CSS line boxes/padding still apply. The paginator shifts its
 * page spacers by this amount so page-top ink coincides with the PDF.
 */
export function pageTopAdjustEm(s: DocSettings, unit: 'paragraph' | 'line' | 'h1' | 'h2' | 'h3' | 'code'): number {
  const m = parityMetrics(s.font);
  const pSlackAbove = s.lineHeight / 2 + (m.cssA - m.cssD) / 2;
  if (unit === 'paragraph' || unit === 'line') return m.typAsc - pSlackAbove;
  if (unit === 'code') {
    // The raw block's top edge sits at the margin; its first baseline is
    // one raw top-edge below. The editor's first baseline is the padding
    // plus the line box's slack above the glyphs.
    const c = codeBlockMetricsEm(s);
    const slackAbove = c.lineEm / 2 + (RAW_FONT.scale * (RAW_FONT.cssA - RAW_FONT.cssD)) / 2;
    return RAW_FONT.scale * RAW_FONT.topEdge - (c.padTopEm + slackAbove);
  }
  return -headingFrameEm(s, unit === 'h1' ? 1 : unit === 'h2' ? 2 : 3).top;
}

/**
 * How far a unit's Typst frame BOTTOM sits above the bottom of its painted
 * editor box, in body em — the counterpart of pageTopAdjustEm for the page
 * bottom. Typst's default bottom edge is the baseline, so a text frame ends
 * at its last baseline; the editor's line box goes on below it by the
 * descent and the half-leading. The local paginator subtracts this before
 * testing a unit against the page's content bottom, so a line or block that
 * Typst would place — its frame ending at the margin — is placed here too.
 *
 * Derivation per kind: box = padTop + n·lineBox; frame top = box top +
 * (padTop + slackAbove − typAsc) (pageTopAdjustEm, negated); frame height
 * = n·extent + (n−1)·leading with lineBox = extent + leading. The box's
 * excess below the frame is then lineBox − slackAbove − (extent − typAsc),
 * independent of n and of padTop.
 */
export function pageBottomInsetEm(s: DocSettings, unit: 'paragraph' | 'line' | 'h1' | 'h2' | 'h3' | 'code'): number {
  const m = parityMetrics(s.font);
  if (unit === 'paragraph' || unit === 'line') {
    const pSlackAbove = s.lineHeight / 2 + (m.cssA - m.cssD) / 2;
    return s.lineHeight - pSlackAbove - (m.extent - m.typAsc);
  }
  if (unit === 'code') {
    // The raw frame's extent is its top edge (typeset-plugin's rail).
    const c = codeBlockMetricsEm(s);
    const slackAbove = c.lineEm / 2 + (RAW_FONT.scale * (RAW_FONT.cssA - RAW_FONT.cssD)) / 2;
    return c.lineEm - slackAbove;
  }
  return headingFrameEm(s, unit === 'h1' ? 1 : unit === 'h2' ? 2 : 3).bottom;
}

/**
 * A heading's Typst frame inside its editor box, body em: `top` from the
 * box top (its padding-top `padTop`, the plain one by default) down to the
 * frame top, `bottom` from the frame bottom down to the box bottom. Typst's
 * heading line runs from the bold face's cap height to the baseline (its
 * text's top and bottom edges), so a one-line frame is boldExtent · hs
 * tall, and the heading leading (parityRules) pitches further lines at the
 * editor's 1.25 · hs: `bottom` holds for any number of lines. Typst's
 * baseline sits `rise` above the editor line box's (HEADINGS).
 */
function headingFrameEm(s: DocSettings, level: number, padTop?: number): { top: number; bottom: number } {
  const m = parityMetrics(s.font);
  const h = HEADINGS[Math.min(3, Math.max(1, level)) - 1];
  const slackAbove = (h.hs * (1.25 + m.cssA - m.cssD)) / 2;
  return {
    top: (padTop ?? h.padTop * h.hs) + slackAbove - h.rise - m.boldExtent * h.hs,
    bottom: 1.25 * h.hs - slackAbove + h.rise,
  };
}

/**
 * A table's block spacing in the editor, body em: Typst's Auto spacing (=
 * paragraph spacing) measured frame to frame, less what the neighbouring
 * paragraph boxes already carry (descent below, cap slack above). The
 * margin-top is dropped at a page top like every weak block spacing.
 */
export function tableMarginsEm(s: DocSettings): { top: number; bottom: number } {
  return {
    top: parSpacingEm(s) - pageBottomInsetEm(s, 'paragraph'),
    bottom: parSpacingEm(s) + pageTopAdjustEm(s, 'paragraph'),
  };
}

/** A heading level's text size as a ratio of the body size (levels 4–6
 * print like 3). The port lays headings out at this scale, bold. */
export function headingScale(level: number): number {
  return HEADINGS[Math.min(3, Math.max(1, level)) - 1].hs;
}

// Heading scale mirrored from the editor CSS (.ProseMirror h1/h2/h3).
// `rise` (body em) is how far Typst's heading baseline sits above the
// editor line box's metric baseline, which places the print's heading
// inside the gap the page gives it: its spacing below is the page's gap
// less this. Calibrated in July against the live editor (NCM defaults; it
// was stated as `shift` with a descent of 0.0123 em, rise = shift −
// 0.0123 hs). It moves no frame against another: the page and the print
// share every gap. The page paints its heading ink about this much lower
// than the print does.
/** The solution block's colour — a verified preset, not a free parameter
 * (`style.css`'s `--solution-red` paints the same value in the editor).
 * The block is `#block(width: 100%, stroke: (left: 2pt + red), inset:
 * (left: 1em))` with `#set text(fill: red)` inside: a left inset the CSS
 * mirrors as padding, no vertical inset, Auto block spacing — so its
 * vertical box equals a plain paragraph run and needs no calibration. */
const SOLUTION_COLOR = 'rgb("#c00000")';

const HEADINGS: Array<{ level: number; hs: number; padTop: number; marginBottom: number; rise: number }> = [
  { level: 1, hs: 1.9, padTop: 0.2, marginBottom: 0.5, rise: 0.1698 },
  { level: 2, hs: 1.4, padTop: 1.4, marginBottom: 0.5, rise: 0.1097 },
  { level: 3, hs: 1.15, padTop: 1.4, marginBottom: 0.5, rise: 0.1692 },
];

/**
 * `#set par(spacing: ...)` in body em: the Auto block-spacing fallback
 * Typst resolves for every block whose `above`/`below` isn't explicitly
 * set (`styles.resolve(ParElem::spacing)` in `flow/collect.rs::block`) —
 * paragraphs, lists, plain code blocks, raw-Typst islands, figures, and
 * tables all collapse to this SAME value on both sides when adjacent,
 * since Auto is independently resolved for `above` and `below` alike.
 * Exported so `flow-rules.ts` can build the weakness-tagged spacing item
 * Typst's collector assigns this construct (weakness 4) without
 * duplicating the formula.
 */
/** Item pitch (body em, frame to frame): a tight list's items sit at
 *  leading + 0.25em (the editor's `li > p` margin), a loose list's at
 *  paragraph spacing — Typst's own rule, with `spacing: auto`. */
export function listSpacingEm(s: DocSettings, tight: boolean): number {
  if (!tight) return parSpacingEm(s);
  return s.lineHeight + 0.25 - parityMetrics(s.font).extent;
}

export function parSpacingEm(s: DocSettings): number {
  const m = parityMetrics(s.font);
  // Classic (indented) paragraphs flow with no extra gap: spacing = leading.
  const parGapEm = s.parIndent ? 0 : 0.9;
  return s.lineHeight + parGapEm - m.extent;
}

/**
 * Explicit `#set block(above/below: ...)` (body em) a heading's show rule
 * emits — Typst's weakness-3 explicit block spacing for headings (see
 * `parityRules` below, which calls this per level so the emitted text and
 * this value can never drift apart). Exported for `flow-rules.ts`'s
 * region-top spacing-drop rule.
 *
 * Each is the page's gap between the heading's frame and a paragraph's:
 * above, from the paragraph's frame bottom over its inset and 0.9em margin
 * to the heading's frame top; below, from the heading's frame bottom over
 * its inset and margin to the paragraph's frame top. Explicit spacing beats
 * the paragraph's Auto spacing (weakness 3 against 4, distribute.rs
 * `keep_spacing`) whichever is larger, so Typst's gap is exactly this.
 */
export function headingBlockSpacingEm(s: DocSettings, level: number): { above: number; below: number } {
  const h = HEADINGS[Math.min(3, Math.max(1, level)) - 1];
  const frame = headingFrameEm(s, level);
  const above = pageBottomInsetEm(s, 'paragraph') + 0.9 + frame.top;
  const below = frame.bottom + h.marginBottom * h.hs - pageTopAdjustEm(s, 'paragraph');
  return { above, below };
}

/**
 * A heading's padding-top (body em) when the block printed before it is a
 * heading of level `prev`: a run, as in "= Part" then "== Section". Typst
 * collapses `prev`'s spacing below and this level's above — both weakness 3
 * (flow/collect.rs `block`) — to the larger (distribute.rs `keep_spacing`);
 * the editor's boxes already carry part of that gap around it, `prev`'s
 * inset below its frame and its margin-bottom, and this heading's line-box
 * slack above its frame. The padding is the rest (negative below a line
 * height of about 1.3: the plugin publishes that part as a margin-top).
 */
export function headingRunPadTopEm(s: DocSettings, prev: number, level: number): number {
  const p = HEADINGS[Math.min(3, Math.max(1, prev)) - 1];
  const gap = Math.max(headingBlockSpacingEm(s, prev).below, headingBlockSpacingEm(s, level).above);
  return gap - (headingFrameEm(s, prev).bottom + p.marginBottom * p.hs) - headingFrameEm(s, level, 0).top;
}

/**
 * Explicit `#set block(above/below: ...)` (body em) the display-math show
 * rule emits — weakness-3 explicit block spacing, same status as headings'.
 * Exported for `flow-rules.ts`'s region-top spacing-drop rule. The
 * equation's frame is its ink, inside the editor's 0.5em padding; the rest
 * of each gap is a paragraph's frame inset and its 0.9em margin.
 */
export function equationBlockSpacingEm(s: DocSettings): { above: number; below: number } {
  const above = pageBottomInsetEm(s, 'paragraph') + 0.9 + 0.5;
  const below = 0.5 + 0.9 - pageTopAdjustEm(s, 'paragraph');
  return { above, below };
}

/** {page} in a running text: the page counter in the numbering in force. */
export const RUNNING_PAGE_TYP = '#context counter(page).display()';
/** {section} in a running text: the level-1 heading in force at the top
 *  of the page — the last one before the header's own location, so a
 *  heading that opens this page is not yet it (the editor mirrors this:
 *  the last level-1 heading on an earlier page). */
export const RUNNING_SECTION_TYP =
  '#context { let hs = query(selector(heading.where(level: 1)).before(here())); if hs.len() > 0 { hs.last().body } }';

/** A leaf block's Typst frame inside its painted box, body em: `above` is
 *  the slack from the box top down to the frame top, `below` the inset from
 *  the frame bottom down to the box bottom. Text kinds carry the
 *  calibrated line-box slack; the kinds with no calibration (figure, table,
 *  display math, raw islands…) have frame = box. Grid cells (grid-editor.ts)
 *  normalize every cell to the paragraph's values with these. */
export function blockFrameSlackEm(node: PMNode, s: DocSettings): { above: number; below: number } {
  const name = node.type.name;
  const kind =
    name === 'paragraph' || name === 'doc_title' || name === 'doc_authors' || name === 'doc_date'
      ? 'paragraph'
      : name === 'heading'
        ? (`h${Math.min(3, (node.attrs.level as number) || 1)}` as 'h1' | 'h2' | 'h3')
        : name === 'code_block'
          ? 'code'
          : null;
  if (!kind) return { above: 0, below: 0 };
  return { above: -pageTopAdjustEm(s, kind), below: pageBottomInsetEm(s, kind) };
}

/** A parity length in body em, printed in pt. Four places: Typst pitches
 *  every line by the leading, so a rounding error is paid once per line,
 *  and at 12.5 pt the body leading is 10.2125 pt (three places would print
 *  10.212 and lose 0.02 px over a page). */
function parityPt(s: DocSettings): (em: number) => string {
  return (em) => `${+(em * s.sizePt).toFixed(4)}pt`;
}

/** The parity header: set/show rules reproducing editor spacing in Typst. */
export function parityRules(s: DocSettings): string {
  const m = parityMetrics(s.font);
  const lh = s.lineHeight;
  const pt = parityPt(s);
  let out = '';
  out += `#set par(justify: true, leading: ${pt(lh - m.extent)}, spacing: ${pt(parSpacingEm(s))})\n`;
  if (s.parIndent) out += `#set par(first-line-indent: 1.5em)\n`;
  out += `#set list(spacing: ${pt(listSpacingEm(s, true))})\n`;
  out += `#set enum(spacing: ${pt(listSpacingEm(s, true))})\n`;
  // Grid rows are atomic: the editor moves a row whole between pages.
  out += '#set grid.cell(breakable: false)\n';
  // Levels 4–6 print like level 3 (the editor styles them the same), so
  // the metrics calibrated for three levels hold for six.
  for (let level = 1; level <= 6; level++) {
    const h = HEADINGS[Math.min(3, level) - 1];
    const { above, below } = headingBlockSpacingEm(s, level);
    out += `#show heading.where(level: ${level}): set text(size: ${pt(h.hs)})\n`;
    out += `#show heading.where(level: ${level}): set block(above: ${pt(above)}, below: ${pt(below)})\n`;
    out += `#show heading.where(level: ${level}): set par(leading: ${pt((1.25 - m.boldExtent) * h.hs)})\n`;
  }
  // Inline raw: pin Typst's defaults so editor code spans (same font file,
  // same ratio) have identical advance widths.
  out += `#show raw.where(block: false): set text(font: "DejaVu Sans Mono", size: ${pt(0.8)})\n`;
  // Display math: the editor shows Typst's own ink inside 0.5em padding.
  const { above: eqAbove, below: eqBelow } = equationBlockSpacingEm(s);
  out += `#show math.equation.where(block: true): set block(above: ${pt(eqAbove)}, below: ${pt(eqBelow)})\n`;
  // Tables remain continuous structured editor content. Typst breaks them
  // between rows with the repeating table.header row laid at the top of each
  // continuation page; the editor mirrors that as a row-boundary widget
  // (PAGE-PORT.md Phase 7) and places a table atomically only when it
  // cannot certify the split.
  return out;
}

let exportOpts: TypExportOptions = {};
let eqLabels = new Set<string>();
let docBib: { name: string; content: string } | null = null;
let docBibKeys = new Set<string>();
let docMacros: Record<string, string> = {};

/** Expand math macros so exported LaTeX compiles anywhere. */
export function expandMacrosWith(src: string, macros: Record<string, string>): string {
  let out = src;
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const [name, expansion] of Object.entries(macros)) {
      const re = new RegExp('\\\\' + name.slice(1) + '(?![a-zA-Z])', 'g');
      const next = out.replace(re, expansion.replace(/\$/g, '$$$$'));
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

function expandMacros(src: string): string {
  return expandMacrosWith(src, docMacros);
}

/** The #set text(...) header line. */
export function textSetLine(s: DocSettings, fontFallback?: string[]): string {
  const primary = effectiveFont(s.font).typstFamily;
  const fonts = fontFallback?.length
    ? `(${[primary, ...fontFallback.filter((f) => f !== primary)].map((f) => JSON.stringify(f)).join(', ')})`
    : JSON.stringify(primary);
  return `#set text(size: ${s.sizePt}pt, font: ${fonts}, hyphenate: ${s.hyphenate})\n`;
}

function imageSrc(src: string): string {
  return exportOpts.resolveImage ? exportOpts.resolveImage(src) : src;
}

function imageWidthArg(node: PMNode): string {
  const width = node.attrs.widthPct;
  return typeof width === 'number' && Number.isFinite(width) && width > 0 && width <= 100 ? `, width: ${width}%` : '';
}

export function escapeTyp(text: string): string {
  return writeLinks(escapePieces(text, true));
}

/** A URL Typst links on its own, held until what follows it is known. */
interface HeldLink {
  url: string;
}
type Piece = string | HeldLink;

/**
 * Prose text as markup: escaped text, and each URL Typst links on its own
 * (it links `http://` and `https://` wherever they stand, mid-word too, as
 * far as its `link_prefix` reaches: the port's mirror) held as it is.
 *
 * A literal ~ must escape — Typst reads a bare ~ as a non-breaking
 * space, silently gluing the words around it. A real U+00A0 in the text
 * emits AS Typst's ~, so the printed glue matches the editor's.
 * A straight quote escapes too: unescaped, Typst would print it curly,
 * and the document already holds the curly glyph wherever that is
 * wanted (smart-quotes.ts) — document text equals printed text.
 *
 * Typst reads `//` and `/*` as comment openers anywhere in markup,
 * mid-word too, and a stray comment closer as an error: `a // b` prints
 * "a", and a comment inside `*…*` or `#footnote[…]` swallows the closing
 * delimiter, so the compile fails. A `*` in the text is escaped already;
 * a slash beside another slash, or at either end of the text (where it
 * meets a `*` delimiter or the next text node), prints through its
 * escape. A URL is not escaped at all: inside the link its slashes, `_`,
 * `#` and `~` are the link's, not markup, and an escape would end the
 * link there. Without `links` (table cells) no URL is held, so a URL
 * prints as text.
 */
function escapePieces(text: string, links: boolean): Piece[] {
  const pieces: Piece[] = [];
  const special = links ? /[\\#$*_`@<>[\]~"'/\u00a0]|https?:\/\//g : /[\\#$*_`@<>[\]~"'/\u00a0]/g;
  let prose = '';
  let from = 0;
  for (let m = special.exec(text); m; m = special.exec(text)) {
    const i = m.index;
    prose += text.slice(from, i);
    const c = m[0];
    if (c.length > 1) {
      const url = c + linkPrefixScan(text.slice(i + c.length)).link;
      if (prose) pieces.push(prose);
      prose = '';
      pieces.push({ url });
      from = special.lastIndex = i + url.length;
      continue;
    }
    if (c === '/') {
      const lone = i > 0 && i < text.length - 1 && text[i - 1] !== '/' && text[i + 1] !== '/';
      prose += lone ? '/' : '\\/';
    } else {
      prose += c === '\u00a0' ? '~' : '\\' + c;
    }
    from = i + 1;
  }
  prose += text.slice(from);
  if (prose) pieces.push(prose);
  return pieces;
}

/**
 * The markup the pieces make, each held URL written as Typst will read
 * it, last to first so what follows each is final: bare where Typst's
 * lexer, reading on past it, links exactly that URL; else through its
 * link function, which prints the same. A bare URL would run on into the
 * `*` or `_` closing a strong or emph run, a footnote, a formula, a
 * citation or the `~` of a no-break space right after it, and one whose
 * brackets do not balance does not compile.
 */
function writeLinks(pieces: Piece[]): string {
  let after = '';
  for (let k = pieces.length - 1; k >= 0; k--) {
    const piece = pieces[k];
    after = (typeof piece === 'string' ? piece : linkMarkup(piece.url, after)) + after;
  }
  return after;
}

function linkMarkup(url: string, after: string): string {
  const rest = url.slice(url.indexOf('//') + 2);
  const read = linkPrefixScan(rest + after);
  if (read.balanced && read.link.length === rest.length) return url;
  // A `;` ends the call where the next character would continue it (`(`,
  // `[`, a `.` field) or be taken as its end (`;`); Typst drops it.
  return `#link("${url}")` + (/^[;([.]/.test(after) ? ';' : '');
}

/** Markup Typst reads at the head of a line — a heading, list, enum or term
 *  marker (`=`, `-`, `+`, `/ `, `3. `) — escaped, so the line prints as the
 *  text it is. A line's head is a paragraph's start (a list item's too: the
 *  item's body starts a line), a content block's (a footnote, a caption, a
 *  cell, a running header), and the text after a hard break; a heading's
 *  text is not one. */
function escapeLineHead(t: string): string {
  return t.replace(/^([ \t]*)(?:([=+-]|\/(?=[ \t]|$))|(\d+)(?=\.(?:[ \t]|$)))/, (_m, lead: string, mark?: string, digits?: string) =>
    mark ? `${lead}\\${mark}` : `${lead}${digits}\\`,
  );
}

/** Table cells keep their established, narrower encoding: a URL's
 * slashes escape like any other, so a URL in a cell prints as text, not a
 * link. */
function escapeTableCellText(text: string): string {
  return writeLinks(escapePieces(text, false));
}

function portableTableLabel(label: unknown): string {
  const value = String(label ?? '');
  if (!value) return '';
  if (!isPortableCitationKey(value)) {
    throw new Error(`Cannot export table: reference label ${JSON.stringify(value)} is not portable Typst syntax`);
  }
  return ` <${value}>`;
}

/** Marks that wrap a run of inline content on export, outermost last. */
const RUN_MARKS = ['strong', 'em', 'strike'] as const;

function runSignature(child: PMNode): string {
  const names = new Set(child.marks.map((m) => m.type.name));
  return RUN_MARKS.filter((n) => names.has(n)).join(',');
}

function wrapRun(t: Piece[], sig: string): Piece[] {
  if (sig.includes('strong')) t = ['*', ...t, '*'];
  if (sig.includes('em')) t = ['_', ...t, '_'];
  if (sig.includes('strike')) t = ['#strike[', ...t, ']'];
  return t;
}

/**
 * Inline content -> Typst markup. Text and inline math sharing the same
 * strong/em/strike marks form one run wrapped once (`*#mi(\`2\`) drinks*`):
 * Typst's strong emboldens math, and the editor compiles such a formula's
 * ink in that context, so the printed span must stay one span. Every other
 * atom (raw Typst, refs, citations, footnotes, images) closes the run and
 * is emitted bare — their print does not follow the surrounding marks.
 * `head`: the content starts a Typst line (escapeLineHead), as everything
 * but a heading's text does.
 */
function inlineToTyp(node: PMNode, tableCell = false, head = true): string {
  const out: Piece[] = [];
  let run: Piece[] = [];
  let sig = '';
  const flush = () => {
    if (run.length) out.push(...wrapRun(run, sig));
    run = [];
  };
  node.forEach((child) => {
    // Plain text first on its line could read as markup; a marked run
    // opens with its own delimiter, a code span with a backtick.
    const atHead = head;
    head = child.type.name === 'hard_break';
    if (child.isText && child.text) {
      const s = runSignature(child);
      if (s !== sig) {
        flush();
        sig = s;
      }
      if (child.marks.some((m) => m.type.name === 'code')) {
        // Typst has no variable-length inline raw fence. Use its string form
        // for certified table cells when a literal backtick would close `...`.
        run.push(tableCell && child.text.includes('`')
          ? `#raw(${JSON.stringify(child.text)}, block: false)`
          : '`' + child.text + '`');
      } else {
        const pieces = escapePieces(child.text, !tableCell);
        if (atHead && !s && typeof pieces[0] === 'string') pieces[0] = escapeLineHead(pieces[0]);
        run.push(...pieces);
      }
      return;
    }
    if (child.type.name === 'math_inline') {
      const s = runSignature(child);
      if (s !== sig) {
        flush();
        sig = s;
      }
      const source = inlineLatex(child);
      if (exportOpts.islands === 'print') run.push(inlineEquation(convertMath(source)));
      else run.push(tableCell ? `#mi(raw(${JSON.stringify(source)}, block: false))` : `#mi(\`${source}\`)`);
      return;
    }
    flush();
    sig = '';
    if (child.type.name === 'typst_inline') {
      // Raw Typst: verbatim in the file; printed as inline raw, never run.
      // Inline HTML has no Typst form and is inline raw in the file too.
      const raw = exportOpts.islands === 'print' || child.attrs.lang === 'html';
      out.push(raw ? `#raw(${JSON.stringify(child.attrs.src as string)})` : (child.attrs.src as string));
    } else if (child.type.name === 'eq_ref') {
      // Equation refs render as "(1)" to match the editor (Typst's default
      // would be "Equation 1"); figure refs keep "Figure 1".
      out.push(unnumberedEqLabels.has(child.attrs.label as string)
        ? escapeTyp(`@${child.attrs.label}`)
        : eqLabels.has(child.attrs.label)
          ? `(#ref(<${child.attrs.label}>, supplement: none))`
          : `@${child.attrs.label}`);
    } else if (child.type.name === 'citation') {
      const key = child.attrs.key as string;
      // Invalid keys may exist in an old/local JSON snapshot. Keep their
      // visible text without letting them become executable Typst syntax.
      out.push(isPortableCitationKey(key) ? `@${key}` : escapeTyp(`@${key}`));
    } else if (child.type.name === 'footnote') {
      out.push(`#footnote[${inlineToTyp(child)}]`);
    } else if (child.type.name === 'hard_break') {
      out.push(' \\\n');
    } else if (child.type.name === 'image') {
      out.push(`#image("${imageSrc(child.attrs.src)}"${imageWidthArg(child)})`);
    }
  });
  flush();
  return writeLinks(out);
}

const TABLE_CELL_MARKS = new Set(['strong', 'em', 'strike', 'code']);
const TABLE_CELL_INLINE = new Set([
  'text',
  'hard_break',
  'math_inline',
  'eq_ref',
  'citation',
]);

/**
 * Serialize only the table-cell subset that the importer can reconstruct
 * without guessing. The schema permits arbitrary blocks; an explicit failure
 * leaves the ProseMirror document untouched instead of silently dropping them.
 */
function tableCellContentToTyp(cell: PMNode, row: number, column: number): string {
  const where = `table cell ${row + 1}:${column + 1}`;
  const paragraphs: string[] = [];
  cell.forEach((block) => {
    if (block.type.name !== 'paragraph') {
      throw new Error(`Cannot export ${where}: unsupported ${block.type.name} block; content was not discarded`);
    }
    if (block.attrs.keep || block.attrs.align) {
      throw new Error(`Cannot export ${where}: paragraph layout attributes are not supported inside table cells`);
    }
    block.descendants((child) => {
      if (!TABLE_CELL_INLINE.has(child.type.name)) {
        throw new Error(`Cannot export ${where}: unsupported inline ${child.type.name}; content was not discarded`);
      }
      const markNames = child.marks.map((mark) => mark.type.name);
      const unsupported = markNames.find((name) => !TABLE_CELL_MARKS.has(name));
      if (unsupported) {
        throw new Error(`Cannot export ${where}: unsupported ${unsupported} mark; content was not discarded`);
      }
      if (!child.isText && markNames.length) {
        throw new Error(`Cannot export ${where}: marks on ${child.type.name} are not supported`);
      }
      if (markNames.includes('code') && markNames.length > 1) {
        throw new Error(`Cannot export ${where}: code combined with another mark is not supported`);
      }
      const inlineSource = child.isText
        ? (child.text ?? '')
        : child.type.name === 'math_inline'
          ? (child.attrs.src as string)
          : '';
      if (/[\r\n]/.test(inlineSource)) {
        throw new Error(`Cannot export ${where}: multiline inline content is not supported`);
      }
      if (child.type.name === 'citation') {
        const key = child.attrs.key as string;
        if (!isPortableCitationKey(key) || !docBibKeys.has(key)) {
          throw new Error(`Cannot export ${where}: citation ${JSON.stringify(key)} has no portable bibliography entry`);
        }
      }
      if (child.type.name === 'eq_ref') {
        const label = child.attrs.label as string;
        if (!isPortableCitationKey(label)) {
          throw new Error(`Cannot export ${where}: reference label ${JSON.stringify(label)} is not portable Typst syntax`);
        }
        if (unnumberedEqLabels.has(label)) {
          throw new Error(`Cannot export ${where}: a reference to an unnumbered equation is not lossless`);
        }
      }
      return true;
    });
    // A cell's text starts a line, as each line after a hard break does:
    // inlineToTyp escapes their markup heads.
    const body = inlineToTyp(block, true);
    if (/\n[ \t]*\n/.test(body)) {
      throw new Error(`Cannot export ${where}: an inline source contains a blank line`);
    }
    paragraphs.push(body);
  });
  if (paragraphs.length === 1 && !paragraphs[0]) return '';
  return paragraphs
    .map((body) => body || '// typeset:empty-table-paragraph\n~')
    .join('\n\n');
}

function tableCellBrackets(content: string): string {
  if (!content.includes('\n')) return `[${content}]`;
  return `[\n${content.split('\n').map((line) => `    ${line}`).join('\n')}\n  ]`;
}

function blocksToTyp(parent: PMNode, indent: string): string {
  let out = '';
  parent.forEach((node) => {
    out += blockToTyp(node, indent);
  });
  return out;
}

function blockToTyp(node: PMNode, indent = ''): string {
  switch (node.type.name) {
    case 'paragraph': {
      // A leading =, -, +, `/ ` or `3. ` is escaped by inlineToTyp: it would
      // re-parse as heading or list syntax.
      const s = inlineToTyp(node);
      // An empty paragraph is one blank line of vertical space — in the PDF
      // too (a bare ~ renders as an empty line of full line height). Without
      // this, Typst sees nothing where the editor shows a gap, and its pages
      // drift from the editor's real heights.
      if (!s.trim()) return indent + '~\n\n';
      const body = node.attrs.keep ? `#block(breakable: false)[${s}]` : s;
      // Aligned paragraphs (top level only): the MULTI-line #align form —
      // the single-line form right after a title is the authors line.
      if (node.attrs.align && !indent) {
        return `#align(${node.attrs.align})[\n  ${body}\n]\n\n`;
      }
      if (node.attrs.keep) return indent + body + '\n\n';
      return indent + s + '\n\n';
    }
    case 'heading': {
      const label = node.attrs.label ? ` <${node.attrs.label}>` : '';
      return indent + '='.repeat(node.attrs.level) + ' ' + inlineToTyp(node, false, false) + label + '\n\n';
    }
    case 'doc_title':
      return indent + `#align(center, text(size: 1.55em, weight: 700)[${inlineToTyp(node)}])\n\n`;
    case 'doc_authors':
      return indent + `#align(center)[${inlineToTyp(node)}]\n\n`;
    case 'doc_date':
      return indent + `#align(center, text(style: "italic")[${inlineToTyp(node)}])\n\n`;
    case 'abstract':
      return (
        indent +
        '#align(center, text(weight: 600)[Abstract])\n' +
        indent +
        '#pad(x: 1.8em)[\n' +
        blocksToTyp(node, indent + '  ') +
        indent +
        ']\n\n'
      );
    case 'blockquote':
      if (node.attrs.kind === 'solution') {
        return (
          indent +
          `#block(width: 100%, stroke: (left: 2pt + ${SOLUTION_COLOR}), inset: (left: 1em))[\n` +
          indent +
          `  #set text(fill: ${SOLUTION_COLOR})\n\n` +
          blocksToTyp(node, indent + '  ') +
          indent +
          ']\n\n'
        );
      }
      return indent + '#quote(block: true)[\n' + blocksToTyp(node, indent + '  ') + indent + ']\n\n';
    case 'editor_comment':
      // The working file keeps the note in its comment frame; the print
      // compile (PDF, the audit) omits it whole — no separator, no trace —
      // so the printed body equals that of the same document without it.
      if (exportOpts.islands === 'print') return '';
      return indent + commentToTyp(node.textContent) + '\n\n';
    case 'code_block':
      // Islands: a raw-Typst block stays verbatim in the .typ file and is
      // printed as a raw block; a Markdown block has no Typst form and is
      // a raw block in both.
      if (node.attrs.params === 'typst-raw' && exportOpts.islands !== 'print') return indent + node.textContent + '\n\n';
      if (node.attrs.params === 'typst-raw' || node.attrs.params === 'md-raw') return islandBlock(node.textContent, indent);
      return indent + '```' + (node.attrs.params ?? '') + '\n' + node.textContent + '\n```\n\n';
    case 'math_display': {
      const numberedAttr = node.attrs.numbered as boolean | null;
      const effNumbered = numberedAttr ?? emitNumberEquations;
      // A label on an unnumbered equation would make every reference to it
      // a compile error (Typst: cannot ref an unnumbered equation) — drop
      // it; the references degrade to literal placeholders.
      const label = node.attrs.label && effNumbered ? ` <${node.attrs.label}>` : '';
      const latex = displayLatex(node);
      const body = (exportOpts.islands === 'print' ? displayEquation(convertMath(latex)) : '#mitex(`' + latex + '`)') + label;
      const numbered = node.attrs.numbered as boolean | null;
      // Per-equation override as bare set/restore rules: a wrapping content
      // block (#[...]) changes Typst's block spacing (~0.5em) and shifted
      // the whole page when toggling; set rules are style-only.
      const docNum = emitNumberEquations ? '"(1)"' : 'none';
      if (numbered === false && emitNumberEquations) {
        return indent + '#set math.equation(numbering: none)\n' + body + '\n#set math.equation(numbering: ' + docNum + ')\n\n';
      }
      if (numbered === true && !emitNumberEquations) {
        return indent + '#set math.equation(numbering: "(1)")\n' + body + '\n#set math.equation(numbering: ' + docNum + ')\n\n';
      }
      return indent + body + '\n\n';
    }
    case 'figure': {
      // src is emitted verbatim (even data: URLs) so our own files round-trip
      // losslessly; swap in a real image path for Typst compilation.
      const label = node.attrs.label ? ` <${node.attrs.label}>` : '';
      return indent + `#figure(image("${imageSrc(node.attrs.src)}"${imageWidthArg(node)}), caption: [${inlineToTyp(node)}])${label}\n\n`;
    }
    case 'bullet_list':
    case 'ordered_list': {
      const marker = node.type.name === 'bullet_list' ? '- ' : '+ ';
      // A numbered list that starts past 1 opens with that number, Typst's
      // explicit enum marker; the items after it count on from there. (A
      // `#set enum(start:)` would restart every nested list too.)
      const start = node.type.name === 'ordered_list' ? (node.attrs.order as number) : 1;
      const tight = node.attrs.tight !== false;
      let out = '';
      node.forEach((item, _o, k) => {
        const body = blocksToTyp(item, '').trimEnd().split('\n').join('\n' + indent + '  ');
        // A loose list: blank lines between the items (Typst's own tight:
        // false), spaced by paragraph spacing. The document's `#set` fixes
        // the item pitch for tight lists, so the loose one is set and
        // restored around the list (bare set rules, like an equation's
        // numbering override: a wrapping content block would add spacing).
        out += (tight || k === 0 ? '' : '\n') + indent + (k === 0 && start !== 1 ? `${start}. ` : marker) + body + '\n';
      });
      if (!tight) {
        const kind = node.type.name === 'bullet_list' ? 'list' : 'enum';
        const spacing = parityPt(docSettings);
        out =
          indent + `#set ${kind}(spacing: ${spacing(listSpacingEm(docSettings, false))})\n` +
          out +
          indent + `#set ${kind}(spacing: ${spacing(listSpacingEm(docSettings, true))})\n`;
      }
      return out + '\n';
    }
    case 'grid': {
      // Typst's grid: fraction columns, one gutter, cells row-major as
      // content blocks (the rail's whole vocabulary — grid-editor.ts).
      const columns = node.attrs.columns as number[];
      const gutter = node.attrs.gutter as number;
      const fr = (c: number) => `${+c.toFixed(3)}fr`;
      let out = indent + `#grid(\n${indent}  columns: (${columns.map(fr).join(', ')}),\n${indent}  gutter: ${+gutter.toFixed(2)}em,\n`;
      // A merged or aligned cell is grid.cell(colspan: …, align: …)[…]:
      // its span, then across, down, or both (Typst's horizon is the
      // rail's middle).
      const head = (cell: PMNode) => {
        const span = (cell.attrs.colspan as number) || 1;
        const across = cell.attrs.align as string | null;
        const down = cell.attrs.valign as string | null;
        const parts = [across, down === 'middle' ? 'horizon' : down].filter(Boolean);
        const args = [...(span > 1 ? [`colspan: ${span}`] : []), ...(parts.length ? [`align: ${parts.join(' + ')}`] : [])];
        return args.length ? `grid.cell(${args.join(', ')})` : '';
      };
      node.forEach((row) => {
        row.forEach((cell) => {
          const body = blocksToTyp(cell, '').trimEnd();
          // An empty cell (one empty paragraph) is `[]`, not the `~` an
          // empty paragraph prints as in the flow.
          if (!body.trim() || (cell.childCount === 1 && cell.firstChild!.type.name === 'paragraph' && !cell.firstChild!.content.size)) {
            out += indent + '  ' + head(cell) + '[],\n';
            return;
          }
          out += indent + '  ' + head(cell) + '[\n' + body.split('\n').map((l) => (l.trim() ? indent + '    ' + l : '')).join('\n') + '\n' + indent + '  ],\n';
        });
      });
      return out + indent + ')\n\n';
    }
    case 'table': {
      // Row-major cell list; header rows via table.header, merges via
      // table.cell(colspan/rowspan), style presets via stroke/hline —
      // Typst's grid model matches PM's.
      const style = (node.attrs.style as string) || 'grid';
      let columns = 0;
      const firstRow = node.child(0);
      firstRow?.forEach((cell) => {
        columns += (cell.attrs.colspan as number) ?? 1;
      });

      // A column default is an optimization; every differing cell overrides
      // it. Keep unspecified axes distinct from explicit left/top so a trip
      // through source does not change the document or mark it dirty. If any
      // cell leaves an axis unset, the column must leave that axis unset too.
      const tableMap = TableMap.get(node);
      const colValues: Array<Set<string | null>> = Array.from({ length: columns }, () => new Set());
      const colVerticals: Array<Set<string | null>> = Array.from({ length: columns }, () => new Set());
      node.forEach((row, rowOffset) => {
        row.forEach((cell, cellOffset) => {
          const col = tableMap.findCell(rowOffset + cellOffset + 1).left;
          colValues[col]?.add((cell.attrs.align as string) || null);
          colVerticals[col]?.add((cell.attrs.valign as string) || null);
        });
      });
      const columnDefault = (values: Set<string | null>) => values.has(null) ? null : [...values][0] ?? null;
      const colAligns = colValues.map((values) => values.has('decimal') ? 'decimal' : columnDefault(values));
      const colValigns = colVerticals.map(columnDefault);
      // Typst's auto inherits the centered table wrapper. Write physical
      // left with a preservation comment for the editor's implicit default.
      const aligned = (horizontal: string | null, vertical: string | null) =>
        `${horizontal ?? 'left /* typeset:default */'}${vertical === null ? '' : ` + ${vertical === 'middle' ? 'horizon' : vertical}`}`;

      // Decimal columns split into paired sub-columns at the point (integer
      // part right-aligned, fraction left-aligned, zero inner inset so the
      // halves join). A directive comment lets the importer fuse them back.
      const decimalCols: number[] = [];
      colAligns.forEach((a, i) => {
        if (a === 'decimal') decimalCols.push(i);
      });
      const decimalsIn = (c: number, span: number) => decimalCols.filter((d) => d >= c && d < c + span).length;

      let hasHeader = false;
      const rows: string[] = [];
      node.forEach((row, rowOffset, rowIndex) => {
        const cells: string[] = [];
        let allHeader = row.childCount > 0;
        row.forEach((cell, cellOffset, cellIndex) => {
          const col = tableMap.findCell(rowOffset + cellOffset + 1).left;
          if (cell.type.name !== 'table_header') allHeader = false;
          let content = tableCellContentToTyp(cell, rowIndex, cellIndex);
          if (exportOpts.cellLinks) {
            content = `#link("cell://${rowIndex}-${cellIndex}")[${content || '#h(1em)'}]`;
          }
          const body = tableCellBrackets(content);
          const colspan = (cell.attrs.colspan as number) ?? 1;
          const rowspan = (cell.attrs.rowspan as number) ?? 1;
          const align = (cell.attrs.align as string) || null;
          const valign = (cell.attrs.valign as string) || null;
          const fill = ((cell.attrs.fill as CellFill) || '') as CellFill;
          const fillArg = fill ? `fill: ${CELL_FILL_TYPST[fill]}` : '';

          const inDecimal = decimalCols.includes(col) && colspan === 1;
          if (inDecimal) {
            const plain = cell.textContent.trim();
            const isHeader = cell.type.name === 'table_header';
            const numM = /^([-+]?[\d,]*)(\.\d*)?$/.exec(plain);
            if (!isHeader && plain && numM && !exportOpts.cellLinks) {
              const intPart = numM[1] ?? '';
              const fracPart = numM[2] ?? '';
              const rs = (rowspan > 1 ? `, rowspan: ${rowspan}` : '') + (fillArg ? `, ${fillArg}` : '');
              cells.push(`table.cell(align: ${aligned('right', valign)}, inset: (right: 0pt)${rs})[${escapeTyp(intPart)}]`);
              cells.push(`table.cell(align: ${aligned('left', valign)}, inset: (left: 0pt)${rs})[${escapeTyp(fracPart)}]`);
            } else {
              // Headers, empties, and non-numeric content span the pair.
              const args = [`colspan: 2`];
              if (rowspan > 1) args.push(`rowspan: ${rowspan}`);
              args.push(`align: ${aligned(isHeader ? 'center' : 'right', valign)}`);
              if (fillArg) args.push(fillArg);
              cells.push(`table.cell(${args.join(', ')})${body}`);
            }
            return;
          }

          const emitSpan = colspan + decimalsIn(col, colspan);
          const args: string[] = [];
          if (emitSpan > 1) args.push(`colspan: ${emitSpan}`);
          if (rowspan > 1) args.push(`rowspan: ${rowspan}`);
          if (align !== colAligns[col] || valign !== colValigns[col]) {
            args.push(`align: ${aligned(align, valign)}`);
          }
          if (fillArg) args.push(fillArg);
          cells.push(args.length ? `table.cell(${args.join(', ')})${body}` : body);
        });
        if (allHeader) hasHeader = true;
        rows.push(allHeader ? `  table.header(${cells.join(', ')}),` : `  ${cells.join(', ')},`);
      });

      // User midrules (table.hline(y: …)) coexist with style presets; the
      // rest of the custom params replace the preset entirely. A row's own
      // rule preset is the same construct at the row's lower boundary.
      const rowRules: string[] = [];
      node.forEach((row, _off, i) => {
        const rule = (row.attrs.rule as RowRule) || '';
        if (rule) rowRules.push(rowRuleArg(i, rule));
      });
      const customAll = [((node.attrs.params as string) || '').trim(), ...rowRules].filter(Boolean).join(',\n');
      const userRules: string[] = [...rowRules];
      const custom = ((node.attrs.params as string) || '')
        .trim()
        .replace(/table\.[hv]line\([^)]*\)\s*,?/g, (m) => {
          userRules.push(m.replace(/,?\s*$/, ''));
          return '';
        })
        .replace(/,\s*,/g, ',')
        .replace(/^\s*,\s*/, '')
        .replace(/[,\s]+$/, '')
        .trim();
      const customHas = (name: string) => new RegExp(`(^|[\\s,(])${name}\\s*:`).test(custom);

      // Decimal columns double up: expand the count, the align tuple, and
      // any user width tuple (the pair gets the width plus an auto).
      let customExpanded = custom;
      const mapVlineX = (src: string) =>
        src.replace(/table\.vline\(\s*x\s*:\s*(\d+)/g, (_, x: string) => {
          const n = parseInt(x, 10);
          return `table.vline(x: ${n + decimalCols.filter((d) => d < n).length}`;
        });
      if (decimalCols.length) {
        for (let i = 0; i < userRules.length; i++) userRules[i] = mapVlineX(userRules[i]);
        customExpanded = mapVlineX(custom).replace(/columns\s*:\s*\(([^)]*)\)/, (_, tuple: string) => {
          const widths = tuple.split(',').map((w: string) => w.trim());
          const out: string[] = [];
          widths.forEach((w, i) => {
            if (decimalCols.includes(i)) out.push(w === 'auto' ? 'auto' : w, 'auto');
            else out.push(w);
          });
          return `columns: (${out.join(', ')})`;
        });
      }

      const params: string[] = [];
      if (!customHas('columns')) {
        const widths = node.attrs.columnWidths as string[] | null;
        const expanded = widths?.length === columns
          ? widths.flatMap((width, index) => decimalCols.includes(index) ? [width, 'auto'] : [width]) : null;
        params.push(`  columns: ${expanded ? `(${expanded.join(', ')}${expanded.length === 1 ? ',' : ''})` : columns + decimalCols.length},`);
      }
      // Density preset: a uniform cell inset (Typst's default 5pt is implicit).
      const density = ((node.attrs.density as string) || '') as TableDensity;
      const insetPt = node.attrs.insetPt;
      if (!customHas('inset')) {
        if (typeof insetPt === 'number' && Number.isFinite(insetPt) && insetPt >= 0 && insetPt <= 72) params.push(`  inset: ${insetPt}pt,`);
        else if (density) params.push(`  inset: ${TABLE_DENSITY_INSET_PT[density]}pt,`);
      }
      if (!customHas('align')) {
        const emitted: string[] = [];
        colAligns.forEach((a, i) => {
          if (decimalCols.includes(i)) emitted.push(aligned('right', colValigns[i]), aligned('left', colValigns[i]));
          else emitted.push(aligned(a, colValigns[i]));
        });
        params.push(`  align: (${emitted.join(', ')}${emitted.length === 1 ? ',' : ''}),`);
      }
      // Style preset and custom params are ADDITIVE: the preset renders
      // unless a custom key overrides it (stroke overrides the preset
      // stroke; the booktabs rules stay unless the style itself changes).
      if (style !== 'grid' && !customHas('stroke')) params.push('  stroke: none,');
      if (customExpanded) {
        const block = customExpanded
          .split('\n')
          .map((l) => '  ' + l.trim())
          .join('\n');
        params.push(block.replace(/,?\s*$/, ','));
      }
      if (style === 'booktabs') {
        // Each preset rule yields to an explicit table.hline at its own
        // boundary (the card cycles them light/heavy/none via y: rules).
        const hasY = (y: number) => new RegExp(`table\\.hline\\(\\s*y\\s*:\\s*${y}[,)]`).test(customAll);
        if (!hasY(0)) rows.unshift('  table.hline(stroke: 0.08em),');
        if (hasHeader && !hasY(1)) {
          const idx = rows.findIndex((r) => r.includes('table.header('));
          rows.splice(idx + 1, 0, '  table.hline(stroke: 0.05em),');
        }
        if (!hasY(node.childCount)) rows.push('  table.hline(stroke: 0.08em),');
      }
      for (const rule of userRules) params.push(`  ${rule},`);
      let tableCall = `table(\n${params.join('\n')}\n${rows.join('\n')}\n)`;
      const fontSize = (node.attrs.fontSize as string) || '';
      if (fontSize) {
        tableCall = `text(size: ${fontSize}, ${tableCall})`;
      }
      const directive = decimalCols.length ? `// typeset:decimal-columns ${decimalCols.join(',')}\n` : '';
      const caption = (node.attrs.caption as string) || '';
      const tLabel = (node.attrs.label as string) || '';
      if (caption || tLabel) {
        // A captioned table is a figure: numbered "Table N", referenceable.
        const cap = caption ? `,\n  caption: [${escapeLineHead(escapeTableCellText(caption))}]` : '';
        const kind = fontSize ? ',\n  kind: table' : '';
        const lab = portableTableLabel(tLabel);
        return indent + directive + `#figure(\n${tableCall.split('\n').map((l) => '  ' + l).join('\n')}${cap}${kind},\n)${lab}\n\n`;
      }
      return indent + directive + `#align(center, ${tableCall})\n\n`;
    }
    case 'bibliography': {
      // Embedded inline so the .typ stays self-contained (bytes() source).
      const bib = docBib;
      if (!bib?.content) return '';
      return indent + `#bibliography(bytes(${JSON.stringify(bib.content)}), title: "References", style: "${docCitationStyle}")\n\n`;
    }
    case 'page_break':
      return indent + '#pagebreak()\n\n';
    case 'numbering_restart':
      // Front matter ends: switch to the document's numbering format and
      // restart at 1 (the set page rule itself starts a new page).
      return indent + `#set page(numbering: "${docNumFormat}")\n#counter(page).update(1)\n\n`;
    case 'horizontal_rule':
      return indent + '#line(length: 100%)\n\n';
    case 'image':
      return indent + `#image("${imageSrc(node.attrs.src)}"${imageWidthArg(node)})\n\n`;
    default:
      return node.isTextblock ? indent + inlineToTyp(node) + '\n\n' : '';
  }
}

/** Whether the export needs the mitex import: a math node anywhere. */
function containsMath(doc: PMNode): boolean {
  let found = false;
  doc.descendants((n) => {
    if (n.type.name === 'math_inline' || n.type.name === 'math_display') found = true;
    return !found;
  });
  return found;
}

/** The LaTeX an inline formula prints from: its macros expanded. */
function inlineLatex(node: PMNode): string {
  return expandMacros(node.attrs.src as string);
}

/** The LaTeX a display formula prints from, between the two newlines the
 * `#mitex` raw block holds: what the converter has always been given. */
function displayLatex(node: PMNode): string {
  return '\n' + expandMacros(wrapAligned(node.attrs.src as string)) + '\n';
}

/** The print header's math definitions: every formula converted first (so
 * a rejected one throws before any text is built), then the prelude for
 * the handles they name. */
function printMathPrelude(doc: PMNode): string {
  if (!mathConverterReady()) {
    throw new Error('Printing math needs the math converter: await ensureMathConverter() before docToTyp');
  }
  const converted: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'math_inline') converted.push(convertMath(inlineLatex(n)));
    else if (n.type.name === 'math_display') converted.push(convertMath(displayLatex(n)));
    return true;
  });
  const prelude = mathPrelude(converted);
  return prelude ? '// LaTeX math handles, from mitex 0.2.7 (Apache-2.0)\n' + prelude : '';
}

let docNumFormat = '1';
let docSettings: DocSettings = DEFAULT_SETTINGS;
let emitNumberEquations = true;
let docCitationStyle: CitationStyle = 'ieee';
let unnumberedEqLabels = new Set<string>();

function beginExport(doc: PMNode, opts: TypExportOptions) {
  exportOpts = opts;
  docBib = (doc.attrs?.bib as { name: string; content: string } | null) ?? null;
  docBibKeys = new Set(docBib ? parseBibTeX(docBib.content).map((entry) => entry.key) : []);
  eqLabels = new Set();
  unnumberedEqLabels = new Set();
  doc.descendants((n) => {
    if (n.type.name === 'math_display' && n.attrs.label) {
      eqLabels.add(n.attrs.label as string);
      if (n.attrs.numbered === false) unnumberedEqLabels.add(n.attrs.label as string);
    }
    return true;
  });
}

export function docToTyp(doc: PMNode, opts: TypExportOptions = {}): string {
  beginExport(doc, opts);
  try {
    const s: DocSettings = normalizeSettings(doc.attrs?.settings as Partial<DocSettings> | null);
    docMacros = parseMathMacros(s.mathMacros);
    // Line 1 names the Typst release the export is exact for: the in-app
    // compiler's. (It compiles on later CLIs too; their layout may differ.)
    let out = `// Exported from Plass — exact on typst ${TYPST_EXACT_VERSION}\n`;
    // Named papers by Typst's names; half letter and a custom size by their
    // dimensions (Typst has no name for them).
    const paperName: Partial<Record<DocSettings['page'], string>> = { letter: 'us-letter', a4: 'a4', legal: 'us-legal', b5: 'iso-b5', a5: 'a5' };
    const inches = paperInches(s);
    const paperArg = paperName[s.page] ? `paper: "${paperName[s.page]}"` : `width: ${inches.w}in, height: ${inches.h}in`;
    const uniform = s.marginTop === s.marginRight && s.marginTop === s.marginBottom && s.marginTop === s.marginLeft;
    const marginArg = uniform
      ? `margin: ${s.marginTop}in`
      : `margin: (top: ${s.marginTop}in, right: ${s.marginRight}in, bottom: ${s.marginBottom}in, left: ${s.marginLeft}in)`;
    const pageArgs = [paperArg, marginArg];
    if (s.landscape) pageArgs.push('flipped: true');
    let hasRestart = false;
    doc.forEach((n) => {
      if (n.type.name === 'numbering_restart') hasRestart = true;
    });
    docNumFormat = s.pageNumFormat;
    docSettings = s;
    // With a restart marker, front-matter pages number in roman.
    const frontFormat = hasRestart ? 'i' : s.pageNumFormat;
    if (s.pageNumShow) {
      pageArgs.push(`numbering: "${frontFormat}"`, `number-align: ${s.pageNumPlace === 'top' ? 'top + ' : ''}${s.pageNumAlign}`);
    }
    // Running header and footer: explicit page content (which replaces the
    // automatic number on that edge, as in Typst), with {page} and
    // {section} as context expressions.
    for (const [key, text, align, first] of [
      ['header', s.headerText, s.headerAlign, s.headerFirstPage],
      ['footer', s.footerText, s.footerAlign, s.footerFirstPage],
    ] as Array<[string, string, string, boolean]>) {
      if (!text) continue;
      // The placeholders become code before the links are written, so a
      // URL right before one ends where it should. The text starts a line.
      const pieces = escapePieces(text, true);
      if (typeof pieces[0] === 'string') pieces[0] = escapeLineHead(pieces[0]);
      const inner = writeLinks(
        pieces.map((piece) =>
          typeof piece === 'string'
            ? piece.replace(/\\\{page\\\}|\{page\}/g, RUNNING_PAGE_TYP).replace(/\\\{section\\\}|\{section\}/g, RUNNING_SECTION_TYP)
            : piece,
        ),
      );
      const body = `align(${align})[${inner}]`;
      pageArgs.push(first ? `${key}: ${body}` : `${key}: context if(counter(page).get().first() > 1) { ${body} }`);
    }
    out += `#set page(${pageArgs.join(', ')})\n`;
    out += parityRules(s);
    out += textSetLine(s, opts.fontFallback);
    emitNumberEquations = s.numberEquations;
    docCitationStyle = s.citationStyle;
    if (s.numberEquations) out += '#set math.equation(numbering: "(1)")\n';
    if (s.numberSections) out += '#set heading(numbering: "1.1")\n';
    if (s.footnoteNumbering !== '1') out += `#set footnote(numbering: "${s.footnoteNumbering}")\n`;
    if (s.footnoteSeparator === 'none') out += '#set footnote.entry(separator: none)\n';
    else if (s.footnoteSeparator === 'full') out += '#set footnote.entry(separator: line(length: 100%, stroke: 0.5pt))\n';
    if (s.pageNumStart !== 1) out += `#counter(page).update(${s.pageNumStart})\n`;
    if (s.mathMacros.trim()) out += `// typeset:math-macros ${JSON.stringify(s.mathMacros)}\n`;
    if (containsMath(doc)) out += opts.islands === 'print' ? printMathPrelude(doc) : MITEX_IMPORT + '\n';
    out += '\n';
    const offsets = opts.offsets;
    if (offsets) offsets.length = 0;
    doc.forEach((node) => {
      offsets?.push(out.length);
      out += blockToTyp(node, '');
    });
    return out.trimEnd() + '\n';
  } finally {
    exportOpts = {};
  }
}
