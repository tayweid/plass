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

## Supported versions

Plass is currently pre-release. Security fixes are made on the latest version
of the `main` branch and deployed to the public site. Older commits, forks,
locally modified builds, and superseded releases are not supported. This
section will be replaced with a version support table if Plass begins
maintaining more than one release line.

## Reporting a vulnerability

Do not report a suspected vulnerability in a public issue, discussion, or pull
request. Use GitHub's private **Report a vulnerability** form instead:

<https://github.com/tayweid/plass/security/advisories/new>

Include the affected feature, reproduction steps or a minimal proof of concept,
the impact you expect, and any relevant browser or operating-system details.
Please do not include real private documents, credentials, or data belonging to
someone else.

The maintainer aims to acknowledge a report within three business days and
provide an initial assessment or status update within seven business days.
Remediation and disclosure timing depend on severity and complexity. Please
keep the report private while a fix is developed and released; the maintainer
will coordinate public disclosure and credit with the reporter. These are
response targets rather than a guarantee, and the project does not currently
offer a bug bounty.

## Release practice

Release builds must pass unit tests, Playwright security/persistence tests,
the license-notice check, `npm audit`, the sidecar's pinned `cargo-audit`
check, CodeQL, and the production artifact checks in CI. Deploy only over
HTTPS. See
[`RELEASING.md`](./RELEASING.md) for the complete gate.

The Plass-owned sidecar lockfile currently reports zero vulnerabilities. It
separately reports two unmaintained-package advisories: `rustybuzz` 0.20.1
(RUSTSEC-2026-0206) and `ttf-parser` 0.25.1 (RUSTSEC-2026-0192). These are not
vulnerability advisories. The exact versions are retained only to preserve
parity with the Typst compiler's dependency graph and must be reviewed again
on every compiler upgrade, then updated as soon as exact parity permits.

The upstream precompiled Typst 0.7.0 compiler and renderer are a distinct
release blocker. A binary RustSec scan recovers only part of their dependency
metadata because they were not built with `cargo auditable`, but it still
finds nine advisories in the compiler (RUSTSEC-2026-0204,
RUSTSEC-2026-0195, RUSTSEC-2026-0194, RUSTSEC-2026-0001,
RUSTSEC-2026-0235, RUSTSEC-2026-0068, RUSTSEC-2026-0067,
RUSTSEC-2026-0103, and RUSTSEC-2026-0009); the renderer contains
RUSTSEC-2026-0001 and RUSTSEC-2026-0235. The worker's strict source/asset
limits, serialized queue with a timeout circuit breaker, hard termination
deadlines, runtime network allowlist, WASM memory isolation, and sanitized
outputs reduce likely impact. They do not make a known dependency finding
disappear. In particular,
`quick-xml` 0.38.4 is plausibly attacker-reachable through inline/raw Typst CSL
style XML; the source cap, watchdog, and timeout circuit breaker bound but do
not eliminate browser-tab denial of service.

A formal public release therefore requires replacement binaries whose exact
dependency graph passes review, or an explicit, independently reviewed risk
decision covering each reachable advisory and its application-level
mitigation. The public preview is not that decision. The compiler and renderer
hashes and their conservative third-party license inventory are pinned by the
notice verifier so a package change cannot silently inherit the old review.
