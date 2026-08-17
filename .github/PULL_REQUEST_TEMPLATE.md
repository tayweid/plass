## Summary

Describe the user-visible change and why it is needed.

## Verification

- [ ] I added or updated regression coverage where appropriate.
- [ ] `npm run verify:licenses` passes.
- [ ] For a sidecar dependency or lockfile change, pinned `cargo-audit` 0.22.2
      passes and I reviewed the documented unmaintained-package advisories.
- [ ] For a Typst compiler/renderer package change, I regenerated the pinned
      WASM provenance/notices and reviewed the binary RustSec findings.
- [ ] `npm test` passes.
- [ ] `npm run test:layout` passes for any layout, font, or sidecar change.
- [ ] `npm run test:browser` passes.
- [ ] `npm run build && npm run verify:production` passes.
- [ ] I documented any new network request, untrusted-input boundary, DOM sink,
      dependency, or file-write path.
- [ ] I did not include private documents, credentials, generated `dist/`, or
      unrelated changes.
