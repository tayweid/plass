// One source of truth for the document CSP and the stronger response-header
// policy to use on a host that supports custom headers. Vite injects the meta
// policy before every resource-bearing element in index.html.

export interface SecurityPolicyOptions {
  development?: boolean;
  /** Header-only directives are ignored when CSP is delivered by <meta>. */
  responseHeader?: boolean;
}

export function contentSecurityPolicy(options: SecurityPolicyOptions = {}): string {
  const connectSources = ["'self'", 'https:'];
  if (options.development) connectSources.push('ws:');

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['base-uri', ["'none'"]],
    ['object-src', ["'none'"]],
    ['script-src', ["'self'", "'wasm-unsafe-eval'"]],
    ['script-src-attr', ["'none'"]],
    // The editor positions pagination/UI elements dynamically and sanitized
    // Typst SVG uses inline paint styles. Script remains separately strict.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'blob:', 'data:']],
    ['font-src', ["'self'"]],
    // Arbitrary HTTPS is deliberate: only the explicit, session-scoped
    // remote-image permission path uses it. Direct remote <img> loads remain
    // blocked by img-src, and the compiler has its own pinned package policy.
    ['connect-src', connectSources],
    ['worker-src', ["'self'"]],
    ['child-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['media-src', ["'none'"]],
    ['manifest-src', ["'self'"]],
    ['form-action', ["'none'"]],
  ];

  if (options.responseHeader) {
    directives.push(['frame-ancestors', ["'none'"]]);
  }

  return directives.map(([name, values]) => `${name}${values.length ? ` ${values.join(' ')}` : ''}`).join('; ');
}

/** Apply these at the CDN/origin when moving to a header-capable host.
 * @public Referenced from RELEASING.md and SECURITY.md for self-hosters;
 * intentionally exported despite having no in-app callers. */
export const RECOMMENDED_RESPONSE_HEADERS = {
  'Content-Security-Policy': contentSecurityPolicy({ responseHeader: true }),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'Permissions-Policy': 'camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()',
} as const;

/** Browser regression hook. This module is not part of the production app
 * bundle; calling Function from a served module avoids automation-runtime
 * exemptions that can apply to code injected directly by Playwright.
 * Reached only via dynamic import() from tests/security.spec.ts — not dead code. */
export function testJavaScriptEvalBlocked(): boolean {
  try {
    Function('return 1')();
    return false;
  } catch (error) {
    return error instanceof EvalError;
  }
}
