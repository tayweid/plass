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

/** Previously offered machine-local names, retained only for compatibility. */
export const LEGACY_FONT_NAMES = ['Charter', 'Palatino', 'Georgia', 'Times New Roman'] as const;

/** The selector list used by older Plass builds. Kept here so migration and
 * compatibility UI do not grow another independent capability table. */
export const HISTORICAL_FONT_CHOICES = [
  DEFAULT_FONT.label,
  STIX_TWO_TEXT.label,
  TEX_GYRE_PAGELLA.label,
  ...LEGACY_FONT_NAMES,
] as const;

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
