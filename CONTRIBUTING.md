# Contributing to Plass

Plass is preparing for a public release. Contributions should preserve the
core promise that opening, editing, and saving an untrusted document cannot
execute active content, leak local data, or silently destroy work.

## Development setup

Use Node.js 22 and install exactly from the lockfile. Rust 1.97.0 and Cargo
are also required: the checked WASM sidecar has Rust source tests, and license
verification resolves its locked crate graph. Rebuilding that artifact also
requires wasm-pack 0.15.0. The first Cargo-backed check may need network access
to populate the local crate cache.

```sh
npm ci
npm run dev
```

Before submitting an ordinary change, run the repository checks from a clean
install:

```sh
npm audit --audit-level=moderate
npm run verify:licenses
npm test
npm run test:layout
npm run test:browser
npm run build
npm run verify:production
```

For a release or any change under `sidecar/`, also run the pinned Rust audit
and native sidecar tests:

```sh
cargo install cargo-audit --locked --version 0.22.2
cargo audit --file sidecar/Cargo.lock
cargo test --locked --manifest-path sidecar/Cargo.toml
npm run verify:sidecar
```

After changing sidecar source or dependencies, rebuild with the pinned tool:

```sh
cargo install wasm-pack --locked --version 0.15.0
npm run sidecar
npm run verify:sidecar
git diff --exit-code -- sidecar/pkg sidecar/Cargo.lock
```

The build wrapper rejects any other Rust/Cargo/wasm-pack version, remaps host
paths out of the binary, records source and artifact hashes in
`sidecar/pkg/PROVENANCE.json`, and marks the generated package private. CI
repeats the build on Linux and requires a byte-identical tracked package. Never
update `sidecar/Cargo.lock` or its notices without rebuilding the WASM that the
browser actually imports.

The Plass-owned sidecar audit currently reports no vulnerabilities. Its two
informational unmaintained-package advisories are documented in `SECURITY.md`
and must be reviewed whenever the compiler/sidecar dependency versions move;
do not hide new advisories by weakening the command. A formal release must
also run the separate precompiled-WASM binary audit in `RELEASING.md`. That
audit currently reports known upstream findings and is an explicit release
blocker, not part of the sidecar's clean result.

Install the Playwright browsers first when they are not already available:

```sh
npx --no-install playwright install chromium firefox webkit
```

Playwright starts its own Vite server on port 5199. `npm run build` includes
the unused-code check, static import-cycle check, TypeScript check, and Vite
production build. Production verification must run after that build because it
inspects `dist/` rather than source files.

The GitHub **Verify and deploy** workflow pins Node and Rust, then runs the npm
and sidecar Rust audits, sidecar source tests, license, unit, layout, browser,
build, production-artifact, and byte-reproducible sidecar gates. CodeQL runs separately on
pushes, pull requests from this repository, a weekly schedule, and manual
dispatches. Run the same gates locally; a remote green check is not a
substitute for verifying the exact release worktree.

## Exact layout contract

Layout changes carry a stricter contract than ordinary UI changes:

- `src/layout/knuth-plass.ts` and `src/layout/port/linebreak.ts` are frozen
  algorithmic references. Do not mix changes to either file into a renderer,
  cache, scheduling, or pagination refactor. A deliberate upstream-port change
  requires its own review and regenerated differential evidence.
- The live port and compiled Typst oracle must choose the same ordered break
  offsets and hyphen kinds for every certified font and supported content
  context. Browser-greedy breaks, frozen-prefix approximations, or stability
  costs must never replace the selected exact breaks.
- A normal edit installs at most one line-decoration update. A matching oracle
  result must be a no-op, not a second visual correction.
- Line breaks, spacing, hyphens, and page gaps stay presentation-only. They may
  not enter document content, undo history, clipboard data, accessibility
  text, persistence, or exported source.
- Pagination optimizations must fail closed on structural edits, inline atoms,
  footnotes, tables, lists, changed settings or geometry, invalid markers, and
  stale asynchronous results. Suffix pagination currently runs as a
  full-versus-suffix shadow only: the full result is always installed. Do not
  promote the suffix candidate until a production-mode exact-source browser
  fixture proves zero corrections and the promotion has an explicit review.

For any layout change, in addition to the full command set above:

1. Confirm the two frozen files have no diff against the target branch:

   ```sh
   git diff --exit-code origin/main...HEAD -- \
     src/layout/knuth-plass.ts src/layout/port/linebreak.ts
   ```

2. Run `npm run test:layout` for port smoke and font certification, `npm test`
   for pure layout contracts, and `npm run test:browser` for live/oracle,
   decoration, pagination, selection, undo, and writing-stability behavior.
3. Confirm the compiled oracle causes no correction in certified cases, page
   starts and line ranges retain their signatures, and performance counters do
   not exceed their checked-in budgets. Do not loosen a tolerance or update a
   baseline without attaching the before/after fixture and explaining the
   numerical cause.

## Supported-font contract

New Computer Modern is currently the only exact, selectable body family. Its
regular, italic, bold, and bold-italic faces are explicitly registered for the
browser, Typst compiler, and shaping sidecar through `src/font-registry.ts`.
Other bundled or historical font names are compatibility inputs, not fidelity
claims: Plass preserves the stored preference but `effectiveFont` resolves it
to New Computer Modern consistently for live layout, CSS, compilation, and
export.

Do not expose another family in the selector merely because its files are
bundled. A new public family needs all four faces from one licensed family,
matching browser/compiler/sidecar identities, notices, registry tests, port
smoke coverage, font certification, and browser differential coverage. It may
be marked `exact` and `selectable` only after every layer passes.

## Public-release maintainer checklist

The authoritative operational checklist is [`RELEASING.md`](./RELEASING.md).
For each release, also confirm:

- the worktree is clean and the commands above pass on the exact commit to be
  tagged;
- GitHub's verification and CodeQL checks are green, Dependabot and security
  findings are reviewed, and no required check was skipped;
- `public/LICENSE.txt`, `public/THIRD_PARTY_NOTICES.txt`,
  `public/SIDECAR_THIRD_PARTY_NOTICES.txt`,
  `public/TYPST_WASM_THIRD_PARTY_NOTICES.txt`, the exact distributed
  `public/sources/option-ext-0.2.0.crate`, the JavaScript and Rust
  lockfiles, and bundled font notices match the production dependency and
  asset tree;
- the built preview passes document creation, open/save and external-conflict
  handling, project-image reload, remote-image consent, Typst round-trip, PDF
  export, refresh/session recovery, and supported-browser smoke tests;
- `npm run verify:production` passes after the final build, and the deployed
  HTTPS site is checked again for its CSP, compiler worker, startup, and PDF
  export; and
- suffix pagination remains shadow-gated unless the exact-source production
  promotion requirement above has been satisfied.

## Change discipline

- Keep pull requests focused and explain user-visible behavior changes.
- Add regression tests for security boundaries, file persistence, parsers,
  serialization, and browser behavior whenever those areas change.
- Treat documents, bibliography data, image files, persisted settings, SVG,
  and Typst compiler output as untrusted input.
- Do not add a network request, remote origin, compiler package, HTML/SVG DOM
  sink, or file-write path without documenting its trust boundary and adding
  a fail-closed test.
- Keep dependencies minimal. Commit `package-lock.json` and
  `sidecar/Cargo.lock` when their dependency trees change. Run
  `npm run generate:notices` and commit both
  `public/THIRD_PARTY_NOTICES.txt` and
  `public/SIDECAR_THIRD_PARTY_NOTICES.txt` after production dependency
  changes.
- Never commit private documents, credentials, browser profiles, generated
  `dist/`, Playwright results, or `node_modules/`.

## Reporting security issues

Do not disclose a suspected vulnerability in a public issue. Follow
[`SECURITY.md`](./SECURITY.md) and use the private **Report a vulnerability**
form linked there.

## Licensing

Plass is licensed under the [`MIT License`](./LICENSE). By submitting a
contribution, you agree to license it under the same MIT terms and confirm that
you have the right to do so. No separate contributor license agreement or
Developer Certificate of Origin is required.
