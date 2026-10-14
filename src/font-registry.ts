/**
 * One capability registry for every font-sensitive rendering surface.
 *
 * A stored document preference is not necessarily a font that Plass can
 * render exactly. Callers must preserve the stored string and resolve it at
 * the point of use with `effectiveFont`.
 */

export const FONT_STYLES = ['regular', 'italic', 'bold', 'bolditalic'] as const;
export type FontStyle = (typeof FONT_STYLES)[number];
export type FontFaceFiles = Readonly<Record<FontStyle, string>>;
export type FontFaceKeys = Readonly<Record<FontStyle, string>>;

export interface ParityMetrics {
  cssA: number;
  cssD: number;
  typAsc: number;
  typDesc: number;
  extent: number;
}

export interface FontDefinition {
  /** Stable internal identity used in caches. */
  id: string;
  /** User-facing and persisted historical name. */
  label: string;
  /** Explicit bundled CSS family. */
  cssFamily: string;
  /** Family name reported to Typst. */
  typstFamily: string;
  aliases: readonly string[];
  /** Original binaries used by the compiler and sidecar. */
  compilerFiles: FontFaceFiles;
  /** Files expected in browser @font-face declarations. */
  browserFiles: FontFaceFiles;
  /** Namespaced sidecar selectors for this family. */
  portKeys: FontFaceKeys;
  parity: ParityMetrics | null;
  /** Proven to have one effective face across browser, sidecar, and Typst. */
  exact: boolean;
  /** May be offered in the public settings UI. */
  selectable: boolean;
  /** Retained in the compiler's fallback inventory. */
  compilerFallback: boolean;
}

const faces = (regular: string, italic: string, bold: string, bolditalic: string): FontFaceFiles => ({
  regular,
  italic,
  bold,
  bolditalic,
});

const keys = (id: string): FontFaceKeys => ({
  regular: `${id}/regular`,
  italic: `${id}/italic`,
  bold: `${id}/bold`,
  bolditalic: `${id}/bolditalic`,
});

export const DEFAULT_FONT: FontDefinition = {
  id: 'new-computer-modern',
  label: 'New Computer Modern',
  cssFamily: 'New Computer Modern',
  typstFamily: 'New Computer Modern',
  aliases: ['NewComputerModern'],
  compilerFiles: faces(
    'NewCM10-Regular.otf',
    'NewCM10-Italic.otf',
    'NewCM10-Bold.otf',
    'NewCM10-BoldItalic.otf',
  ),
  browserFiles: faces(
    'NewCM10-Regular.woff2',
    'NewCM10-Italic.woff2',
    'NewCM10-Bold.woff2',
    'NewCM10-BoldItalic.woff2',
  ),
  portKeys: keys('new-computer-modern'),
  parity: { cssA: 1.127, cssD: 0.29, typAsc: 0.6723, typDesc: 0.0123, extent: 0.6828 },
  exact: true,
  selectable: true,
  compilerFallback: true,
};

const STIX_TWO_TEXT: FontDefinition = {
  id: 'stix-two-text',
  label: 'STIX Two Text',
  cssFamily: 'STIX Two Text',
  typstFamily: 'STIX Two Text',
  aliases: [],
  compilerFiles: faces(
    'STIXTwoText-Regular.otf',
    'STIXTwoText-Italic.otf',
    'STIXTwoText-Bold.otf',
    'STIXTwoText-BoldItalic.otf',
  ),
  browserFiles: faces(
    'STIXTwoText-Regular.otf',
    'STIXTwoText-Italic.otf',
    'STIXTwoText-Bold.otf',
    'STIXTwoText-BoldItalic.otf',
  ),
  portKeys: keys('stix-two-text'),
  // Kept as calibration history, not a certification claim.
  parity: { cssA: 0.762, cssD: 0.238, typAsc: 0.657, typDesc: -0.0001, extent: 0.657 },
  exact: false,
  selectable: false,
  compilerFallback: true,
};

const LIBERTINUS_SERIF: FontDefinition = {
  id: 'libertinus-serif',
  label: 'Libertinus Serif',
  cssFamily: 'Libertinus Serif',
  typstFamily: 'Libertinus Serif',
  aliases: [],
  compilerFiles: faces(
    'LibertinusSerif-Regular.otf',
    'LibertinusSerif-Italic.otf',
    'LibertinusSerif-Bold.otf',
    'LibertinusSerif-BoldItalic.otf',
  ),
  browserFiles: faces(
    'LibertinusSerif-Regular.otf',
    'LibertinusSerif-Italic.otf',
    'LibertinusSerif-Bold.otf',
    'LibertinusSerif-BoldItalic.otf',
  ),
  portKeys: keys('libertinus-serif'),
  // Kept as calibration history, not a certification claim.
  parity: { cssA: 0.9, cssD: 0.25, typAsc: 0.6547, typDesc: -0.0053, extent: 0.6582 },
  exact: false,
  selectable: false,
  compilerFallback: true,
};

const TEX_GYRE_PAGELLA: FontDefinition = {
  id: 'tex-gyre-pagella',
  label: 'TeX Gyre Pagella',
  cssFamily: 'TeX Gyre Pagella',
  typstFamily: 'TeX Gyre Pagella',
  aliases: ['Palatino'],
  compilerFiles: faces(
    'texgyrepagella-regular.otf',
    'texgyrepagella-italic.otf',
    'texgyrepagella-bold.otf',
    'texgyrepagella-bolditalic.otf',
  ),
  browserFiles: faces(
    'texgyrepagella-regular.otf',
    'texgyrepagella-italic.otf',
    'texgyrepagella-bold.otf',
    'texgyrepagella-bolditalic.otf',
  ),
  portKeys: keys('tex-gyre-pagella'),
  parity: null,
  exact: false,
  selectable: false,
  compilerFallback: false,
};

export const FONT_CATALOG: readonly FontDefinition[] = [
  DEFAULT_FONT,
  STIX_TWO_TEXT,
  LIBERTINUS_SERIF,
  TEX_GYRE_PAGELLA,
];

export const COMMON_FONT_FILES = {
  math: 'NewCMMath-Regular.otf',
  mono: 'DejaVuSansMono.ttf',
} as const;

export const COMMON_PORT_KEYS = {
  mono: 'common/mono',
} as const;

const byName = new Map<string, FontDefinition>();
for (const font of FONT_CATALOG) {
  for (const name of [font.id, font.label, font.cssFamily, font.typstFamily, ...font.aliases]) {
    byName.set(name.toLocaleLowerCase('en-US'), font);
  }
}

/** Return a bundled family by canonical name or alias, whether certified or not. */
export function requestedFont(name: string): FontDefinition | null {
  return byName.get(name.trim().toLocaleLowerCase('en-US')) ?? null;
}

/** Resolve a persisted preference to a family with a proven exact contract. */
export function effectiveFont(name: string): FontDefinition {
  const requested = requestedFont(name);
  return requested?.exact ? requested : DEFAULT_FONT;
}

export function parityMetrics(name: string): ParityMetrics {
  return effectiveFont(name).parity ?? DEFAULT_FONT.parity!;
}

export function selectableFonts(): readonly FontDefinition[] {
  return FONT_CATALOG.filter((font) => font.exact && font.selectable);
}

/** A deterministic CSS stack: the bundled effective face, then generic serif. */
export function cssFontStack(name: string): string {
  return `${JSON.stringify(effectiveFont(name).cssFamily)}, serif`;
}

/** All compiler font binaries, in stable registration order. */
export function compilerFontFiles(): readonly string[] {
  const out: string[] = [];
  for (const font of FONT_CATALOG) {
    for (const style of FONT_STYLES) out.push(font.compilerFiles[style]);
  }
  out.push(COMMON_FONT_FILES.math, COMMON_FONT_FILES.mono);
  return out;
}

/** Compiler fallback families retained from the existing public output. */
export function compilerFallbackFamilies(): readonly string[] {
  return FONT_CATALOG.filter((font) => font.compilerFallback).map((font) => font.typstFamily);
}

/**
 * Typst's raw block (`raw.rs`): DejaVu Sans Mono at 0.8em, ragged, no
 * hyphenation, lines joined by linebreaks under the document's `par`
 * leading. Measured against the compiler (100× scale): a block of n lines
 * is `topEdge + (n − 1) · (leading + topEdge)` tall in raw em, top edge to
 * last baseline, with Auto block spacing (`parSpacingEm`) on both sides —
 * exactly a paragraph's model in the raw font. DejaVu carries no OS/2 cap
 * height, so Typst's "cap-height" top edge falls back to its typographic
 * ascender (0.7598); `cssA`/`cssD` are its hhea ascent/descent, which is
 * where Chrome places the glyphs inside a line box.
 */
export const RAW_FONT = { scale: 0.8, topEdge: 0.7598, cssA: 0.9282, cssD: 0.2358 } as const;

/**
 * The editor's code-block box in body em, derived so that the baseline
 * distances into and out of the block equal Typst's (spacing + top edge)
 * for whatever body font and line height the document uses:
 *   line pitch  = leading + raw top edge        (Typst's raw line)
 *   padding-top = what the surrounding paragraph line boxes' slack and the
 *                 raw line box's slack leave short of `spacing + topEdge`
 *   margin-bottom = paragraph gap − padding-top  (so block→paragraph lands
 *                 at `spacing + body top edge`, like paragraph→paragraph)
 * `settings.ts` publishes these as px custom properties for the CSS;
 * `typ-serializer.ts` derives the page-top landing spot from them.
 */
export function codeBlockMetricsEm(s: { font: string; lineHeight: number; parIndent: boolean }): { lineEm: number; padTopEm: number; marginBottomEm: number } {
  const m = parityMetrics(s.font);
  const r = RAW_FONT;
  const lineEm = s.lineHeight - m.extent + r.scale * r.topEdge;
  const padTopEm = ((m.cssA - m.cssD) - m.extent + r.scale * (r.topEdge - (r.cssA - r.cssD))) / 2;
  const parGapEm = s.parIndent ? 0 : 0.9;
  return { lineEm, padTopEm, marginBottomEm: parGapEm - padTopEm };
}

/** Footnote entry text: Typst's `footnote.entry` show rule sets 0.85em, and
 * its lines are pitched at the cap height plus a leading of 0.5em of that
 * size (measured against the compiled page: 12.57pt at 12.5pt body text).
 * `.fn-body` mirrors both through `--fn-line`. */
export const FN_SCALE = 0.85;
export const FN_LEADING_EM = 0.5;

/**
 * A footnote entry's Typst frame against its painted `.fn-body` box, in
 * body em: the frame starts `top` below the box top (the entry's cap top)
 * and ends `bottom` above the box bottom (its last baseline); `leading` is
 * their sum — a frame of n lines is n line boxes minus one leading. The
 * paginator reserves frames (Typst stacks entry frames at the page bottom,
 * the last baseline on the margin), and the painter offsets the boxes.
 */
export function footnoteFrameInsetsEm(s: { font: string }): { top: number; bottom: number; leading: number } {
  const m = parityMetrics(s.font);
  const k = FN_SCALE;
  const lineBox = (m.extent + FN_LEADING_EM) * k;
  const slackAbove = lineBox / 2 + ((m.cssA - m.cssD) / 2) * k;
  const top = slackAbove - m.typAsc * k;
  const bottom = lineBox - slackAbove - (m.extent - m.typAsc) * k;
  return { top, bottom, leading: top + bottom };
}
