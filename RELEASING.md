# Releasing Plass

This checklist is intentionally conservative. A release is ready only when
every applicable item is complete on the exact commit being published.

## One-time public-release gates

- [x] Choose an open-source license, add it as root `LICENSE`, and add the
  matching `license` field to `package.json`. Record the correct copyright
  holder; do not copy a name from Git history without confirmation. The
  selected license must be GPLv3-compatible to use NewCM10-Regular's
  Distribution Exception; otherwise remove or replace that bundled font.
- [x] Decide whether outside contributions require a Developer Certificate of
  Origin, a contributor license agreement, or ordinary inbound=outbound
  licensing, then update `CONTRIBUTING.md`.
- [x] Enable GitHub private vulnerability reporting and document the monitored
  intake, supported versions, acknowledgement target, and disclosure
  expectations in `SECURITY.md`.
- [ ] Protect `main`: require the `verify`, `sidecar-reproducibility`, and
  CodeQL checks, require an approving review, dismiss stale approvals, and
  block force pushes/deletion.
- [ ] Configure GitHub Pages for Actions deployment and verify the production
  URL uses HTTPS. If moving to a host with response headers, apply
  `RECOMMENDED_RESPONSE_HEADERS` from `src/security-policy.ts`.
- [ ] Confirm repository visibility, owner metadata, issue templates, support
  expectations, privacy statement, screenshots, and the public URL.
- [ ] Perform a manual browser smoke test on current Chrome/Edge and the
  upload/download fallback on Safari and Firefox. Document any unsupported
  browser behavior prominently.
- [ ] Have an independent reviewer re-check the threat model, dependency and
  font licenses, generated notices, and the final production artifact.
- [ ] Decide whether the historical `typeset-editor-conversation.md` transcript
  and `code-cells-plan.md` adjacent-project proposal are appropriate for the
  public Git history. Deleting them removes them from the release artifact, not
  earlier commits; rewrite history before publication if they are meant to
  remain private.
- [ ] Replace the precompiled Typst compiler/renderer with an audited build, or
  record an explicit independent risk decision for every RustSec finding
  listed in `SECURITY.md`. The current public preview binaries do not satisfy
  this formal-release gate.

## Every release

1. Start from a clean worktree on the intended release commit.
2. Review Dependabot and CodeQL findings; resolve or explicitly document every
   open high/moderate production finding.
3. Install and verify from scratch:

   ```sh
   npm ci
   npm audit --audit-level=moderate
   cargo install cargo-audit --locked --version 0.22.2
   cargo audit --file sidecar/Cargo.lock
   cargo audit bin \
     node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm \
     node_modules/@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm
   npm run verify:licenses
   npm run verify:sidecar
   npm test
   cargo test --locked --manifest-path sidecar/Cargo.toml
   npm run test:layout
   npx --no-install playwright install chromium firefox webkit
   npm run test:browser
   npm run build
   npm run verify:production
   ```

   The binary audit is expected to fail on the current upstream packages. Do
   not treat the sidecar's clean result as covering these precompiled modules.

4. Smoke-test a new document, open/save/autosave conflict handling, project
   image reload, remote-image consent, Typst import/round-trip, PDF export,
   and refresh/session recovery against the built preview.
5. Confirm `dist/LICENSE.txt`, `dist/THIRD_PARTY_NOTICES.txt`,
   `dist/SIDECAR_THIRD_PARTY_NOTICES.txt`,
   `dist/TYPST_WASM_THIRD_PARTY_NOTICES.txt`,
   `dist/sources/option-ext-0.2.0.crate`, and every
   `dist/fonts/licenses/*.txt` notice are present.
6. Confirm the sidecar audit still reports zero vulnerabilities, then review its
   two tracked unmaintained-package advisories: `rustybuzz` 0.20.1
   (RUSTSEC-2026-0206) and `ttf-parser` 0.25.1 (RUSTSEC-2026-0192). They are
   not vulnerability advisories; these exact versions are retained only for
   Typst dependency parity and must be reconsidered whenever the compiler is
   upgraded.
   Also confirm the workflow's sidecar reproducibility job rebuilt
   `sidecar/pkg` byte-for-byte with Rust 1.97.0 and wasm-pack 0.15.0.
7. Resolve or formally review every precompiled-WASM finding recorded in
   `SECURITY.md`; a package-version bump is not sufficient without checking
   the installed binary and its pinned provenance.
8. Update the version and release notes. Tag the exact verified commit; do not
   rebuild from an uncommitted worktree.
9. Let the pinned GitHub Actions workflow deploy the artifact. Verify the live
   CSP, HTTPS, app startup, compiler worker, and a PDF export after deployment.
10. Keep rollback instructions and the prior known-good artifact or tag at hand.

## Incident stop conditions

Do not release when a required check is skipped or failing, the lockfile and
installed tree disagree, notices are stale, the security contact is
unmonitored, a secret may have entered history, or a high-impact security issue
is unresolved. Roll back a live release if documents can leak, active imported
content can execute, saves can overwrite external changes, or the production
artifact differs from the verified build.
