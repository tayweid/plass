import { compilerFallbackFamilies, compilerFontFiles } from './font-registry';

/** Fonts bundled with the app and preloaded into the isolated compiler. */
export const TYPST_FONT_FILES = [...compilerFontFiles()];

/** Fonts guaranteed to exist in the compiler; used as #set text fallback. */
export const FONT_FALLBACK = [...compilerFallbackFamilies()];

export const TYPST_FONT_LIMITS = {
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  fetchTimeoutMs: 15_000,
} as const;

/** The Typst release the in-app compiler is built on (the
 * `@myriaddreamin/typst-ts-web-compiler` 0.7.0 pin in package.json is typst
 * 0.14.2; `sidecar/Cargo.toml` pins the same graph). Plass's pages, and the
 * `.typ` it exports, are exact for this version — the export says so on its
 * first line. Bump it with every typst.ts upgrade. */
export const TYPST_EXACT_VERSION = '0.14.2';

/** The import a working .typ file with math opens with (`docToTyp`'s
 * 'file' mode, the legacy save): its formulas stay LaTeX in `#mi`/`#mitex`
 * calls, so the file reopens exactly. Nothing Plass compiles imports it —
 * print-mode math is native Typst (math-convert.ts) and the compiler
 * resolves no package at all. mitex 0.2.7 because 0.2.5 fails on typst ≥
 * 0.15 (`unknown variable: kai`); 0.2.7 compiles on 0.14.2 and 0.15.x. */
export const MITEX_IMPORT = '#import "@preview/mitex:0.2.7": mi, mitex';
