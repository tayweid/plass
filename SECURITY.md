# Security model

Plass is a client-side document editor. Opened documents, bibliography data,
and project files are untrusted input. They stay in the browser unless the
user explicitly approves a remote image origin or the isolated compiler needs
the pinned mitex package described below. There is no analytics or application
backend.

## Enforced boundaries

- Typst source executes only in a dedicated Web Worker. The main thread
  enforces deadlines and terminates the worker on timeout or failure. Source,
  virtual filesystem assets, outputs, and the pending queue all have explicit
  limits in `src/typst-worker-protocol.ts`.
- Every Typst-generated SVG DOM sink passes through `src/safe-svg.ts`, which
  removes active elements, event handlers, external subresources, dangerous
  links, and unsafe CSS before mounting the result.
- Remote document images are blocked by default. A visible user action grants
  one validated HTTPS origin for the current session; redirects, credentials,
  private/literal addresses, referrers, oversized responses, and active SVG
  content are rejected.
- Typst package resolution is not a general network capability. Only
  `@preview/mitex:0.2.5` is recognized. Its exact archive is fetched from the
  pinned `packages.typst.org` URL with no credentials or referrer, bounded to
  512 KiB, and checked against the SHA-256 digest in `src/typst-config.ts`
  before the compiler can read it. Other package names cause no request.
- File writes are revision-ordered and compare against the exact on-disk
  baseline. External conflicts stop autosave instead of overwriting either
  copy, and dirty navigation requires an explicit decision.
- User-controlled files are size-checked from metadata before their contents
  are allocated or parsed: documents are bounded to 32 MiB, bibliographies to
  4 MiB, and local compiler images to 20 MiB. Imported settings and table
  dimensions are normalized to finite ranges. Malformed embedded metadata is
  kept as raw source rather than interpreted as application metadata or
  silently discarded.

## Content Security Policy

`src/security-policy.ts` is the single source of truth. Vite injects its meta
policy at the beginning of `<head>` in development and production builds. It
allows same-origin code and workers, the app's WebAssembly, inline presentation
styles, inert `data:`/`blob:` images, and HTTPS connections used only by the
remote-image permission path. It blocks inline script, JavaScript eval,
objects, frames, media, forms, direct remote images, and non-self workers.

The current GitHub Pages workflow publishes a static artifact. A meta CSP
cannot enforce response-only directives or establish a CSP inside the
same-origin compiler worker. The worker therefore has an independent runtime
network allowlist and a fail-closed replacement for the few fixed
wasm-bindgen compatibility functions, so arbitrary JavaScript construction is
disabled there too. If Plass moves to a host/CDN with configurable response
headers, apply `RECOMMENDED_RESPONSE_HEADERS` from `src/security-policy.ts` to
the HTML and static assets. The dev and preview servers already send this CSP
on worker responses as a compatibility regression. The recommended headers add
clickjacking protection and the remaining browser isolation controls; do not
maintain a second, divergent CSP string.

Because approved remote images may come from any user-chosen HTTPS origin,
`connect-src https:` is intentionally broad. `img-src` still rejects direct
remote loads, and application code is responsible for the explicit consent,
CORS, redirect, host, type, and size checks.

## Reporting and release practice

Plass is pre-release and does not yet have a public security intake. Before a
public launch, enable GitHub private vulnerability reporting and replace this
paragraph with the monitored security contact, supported versions,
acknowledgement target, remediation target, and coordinated-disclosure
expectations. Do not report a suspected vulnerability in a public issue.

Release builds must pass unit tests, Playwright security/persistence tests,
the license-notice check, `npm audit`, CodeQL, and the production artifact
checks in CI. Deploy only over HTTPS. See [`RELEASING.md`](./RELEASING.md) for
the complete gate.
