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

/** The only Typst Universe package Plass-generated source requires. Keep the
 * exact artifact and digest explicit: imported raw Typst cannot turn the
 * compiler into a general-purpose network client. */
export const TYPST_PACKAGE_POLICY = {
  namespace: 'preview',
  name: 'mitex',
  version: '0.2.5',
  url: 'https://packages.typst.org/preview/mitex-0.2.5.tar.gz',
  sha256: 'd1e6fe0c33c06b2c1158cf8374b66332961be34cf283a4b944a2308d86ac59aa',
  maxBytes: 512 * 1024,
  fetchTimeoutMs: 15_000,
} as const;

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
