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

/** The only Typst Universe package Plass-generated source requires. Keep the
 * exact artifact and digest explicit: imported raw Typst cannot turn the
 * compiler into a general-purpose network client. mitex 0.2.7: 0.2.5 fails
 * on typst ≥ 0.15 (`unknown variable: kai`), so an export pinned to it does
 * not compile with a current CLI; 0.2.7 compiles on 0.14.2 and 0.15.x, and
 * on 0.14.2 inks every formula of the demo, the test fixtures and the course
 * corpus byte-identically to 0.2.5 (the step-0 A/B). */
export const TYPST_PACKAGE_POLICY = {
  namespace: 'preview',
  name: 'mitex',
  version: '0.2.7',
  url: 'https://packages.typst.org/preview/mitex-0.2.7.tar.gz',
  sha256: '0159e214845e49cbdc332d9d572da112dae5ad248072e0a7680d38c8307c2e15',
  maxBytes: 512 * 1024,
  fetchTimeoutMs: 15_000,
} as const;

/** The import every Plass-generated source with math opens with — the
 * export header and math-ink's per-formula compile — so both name exactly
 * the package the policy allows. */
export const MITEX_IMPORT = `#import "@${TYPST_PACKAGE_POLICY.namespace}/${TYPST_PACKAGE_POLICY.name}:${TYPST_PACKAGE_POLICY.version}": mi, mitex`;

export interface TypstPackageSpec {
  namespace: string;
  name: string;
  version: string;
}

export function isAllowedTypstPackage(spec: TypstPackageSpec): boolean {
  return (
    spec.namespace === TYPST_PACKAGE_POLICY.namespace &&
    spec.name === TYPST_PACKAGE_POLICY.name &&
    spec.version === TYPST_PACKAGE_POLICY.version
  );
}

export function sourceNeedsPinnedTypstPackage(source: string): boolean {
  return source.includes(`@${TYPST_PACKAGE_POLICY.namespace}/${TYPST_PACKAGE_POLICY.name}:${TYPST_PACKAGE_POLICY.version}`);
}
