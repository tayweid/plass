# Releasing Plass

This checklist is intentionally conservative. A release is ready only when
every applicable item is complete on the exact commit being published.

## One-time public-release gates

- [ ] Choose an open-source license, add it as root `LICENSE`, and add the
  matching `license` field to `package.json`. Record the correct copyright
  holder; do not copy a name from Git history without confirmation. The
  selected license must be GPLv3-compatible to use NewCM10-Regular's
  Distribution Exception; otherwise remove or replace that bundled font.
- [ ] Decide whether outside contributions require a Developer Certificate of
  Origin, a contributor license agreement, or ordinary inbound=outbound
  licensing, then update `CONTRIBUTING.md`.
- [x] Enable GitHub private vulnerability reporting and document the monitored
  intake, supported versions, acknowledgement target, and disclosure
  expectations in `SECURITY.md`.
- [ ] Protect `main`: require the verification and CodeQL checks, require an
  approving review, dismiss stale approvals, and block force pushes/deletion.
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

## Every release

1. Start from a clean worktree on the intended release commit.
2. Review Dependabot and CodeQL findings; resolve or explicitly document every
   open high/moderate production finding.
3. Install and verify from scratch:

   ```sh
   npm ci
   npm audit --audit-level=moderate
   npm run verify:licenses
   npm test
   npx --no-install playwright install chromium
   npm run test:browser
   npm run build -- --base=/plass/
   npm run verify:production
   ```

4. Smoke-test a new document, open/save/autosave conflict handling, project
   image reload, remote-image consent, Typst import/round-trip, PDF export,
   and refresh/session recovery against the built preview.
5. Confirm `dist/THIRD_PARTY_NOTICES.txt` and every
   `dist/fonts/licenses/*.txt` notice are present.
6. Update the version and release notes. Tag the exact verified commit; do not
   rebuild from an uncommitted worktree.
7. Let the pinned GitHub Actions workflow deploy the artifact. Verify the live
   CSP, HTTPS, app startup, compiler worker, and a PDF export after deployment.
8. Keep rollback instructions and the prior known-good artifact or tag at hand.

## Incident stop conditions

Do not release when a required check is skipped or failing, the lockfile and
installed tree disagree, notices are stale, the security contact is
unmonitored, a secret may have entered history, or a high-impact security issue
is unresolved. Roll back a live release if documents can leak, active imported
content can execute, saves can overwrite external changes, or the production
artifact differs from the verified build.
