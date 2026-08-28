# Contributing to Plass

Plass is preparing for a public release. Contributions should preserve the
core promise that opening, editing, and saving an untrusted document cannot
execute active content, leak local data, or silently destroy work.

## Development setup

Use Node.js 22 and install exactly from the lockfile. The production editor no
longer ships or loads the historical line-breaking sidecar. Rust 1.97.0,
Cargo, and wasm-pack 0.15.0 are needed only when explicitly exercising or
changing that opt-in differential harness. The first Cargo-backed check may
need network access to populate the local crate cache.

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

For any change under `sidecar/`, or when certifying the optional differential
harness, also run the pinned Rust audit and native sidecar tests:

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
git diff --stat -- sidecar/pkg sidecar/Cargo.lock
```

The build wrapper rejects any other Rust/Cargo/wasm-pack version, remaps host
paths out of the binary, records source and artifact hashes in
`sidecar/pkg/PROVENANCE.json`, and marks the generated package private. Never
update `sidecar/Cargo.lock` or its notices without rebuilding the WASM that the
browser actually imports.

The tracked package is the Linux CI rebuild, and only a Linux rebuild
reproduces it. The build is byte-deterministic for a given host — the same
bytes from any checkout path on the same machine — but Cargo derives each
crate's metadata hash from the full rustc version string, host triple
included, so a macOS rebuild differs from CI's in its `TypeId` constants and
symbol ordering even at identical sources and pinned tool versions. Rebuild
locally to test the change, then push and take the bytes CI produces: the
**Verify and deploy** workflow's `sidecar-reproducibility` job publishes its
rebuild as the `canonical-sidecar-pkg` artifact whenever the tracked package
differs. Commit `pkg/typeset_sidecar_bg.wasm` and `pkg/PROVENANCE.json` from
that artifact — not the local build — and confirm the job's next run reports a
byte-for-byte match.

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
the unused-code check, the knip unused-export check, the static import-cycle
check, TypeScript check, and Vite production build. Production verification
must run after that build because it inspects `dist/` rather than source files.

The GitHub **Verify and deploy** workflow pins Node and Rust, then runs the npm
and historical-sidecar Rust audits, sidecar source tests, license, unit,
layout, browser, build, and production-artifact gates. Production verification
also rejects any accidental sidecar WASM artifact. The advisory
sidecar-reproducibility check warns rather than blocks. CodeQL runs separately on
pushes, pull requests from this repository, a weekly schedule, and manual
dispatches. Run the same gates locally; a remote green check is not a
substitute for verifying the exact release worktree.

## Exact layout contract

Layout changes carry a stricter contract than ordinary UI changes:

- `src/layout/knuth-plass.ts` and `src/layout/port/linebreak.ts` are frozen
  algorithmic references. Do not mix changes to either file into a renderer,
  cache, scheduling, or pagination refactor. A deliberate upstream-port change
  requires its own review and regenerated differential evidence.
- Typst's whole-document compile is the only production line-breaking
  authority. The local port may compare results in an explicitly invoked test
  harness, but it may not be imported, loaded, or used as a live fallback.
  Pending, failed, and safely-unmappable blocks stay browser-native.
- `PageOracle` is the only product component allowed to publish settled line
  or page decisions. It derives body, caption, footnote, and page mappings from
  one immutable full-document publication; the paragraph-fragment
  `TypstOracle` is a test/research utility only.
- Layout, math, bibliography, executable-embed previews, and supported fixed
  inline Typst atoms must acquire that publication through the per-editor
  document broker. A document revision plus asset epoch admits at most one
  live compile, and one consumer's cancellation must not discard work another
  still needs. Do not reintroduce per-formula or per-bibliography fragment
  compiles.
- The shared worker task must compile one vector artifact, run every region
  query against that artifact's still-live world, and render that same vector.
  A query pass followed by a second main-file SVG compile is not one atomic
  publication, even if its source string is identical.
- Publication fan-out must index document positions once per immutable
  document/publication. Do not replace it with one `doc.descendants` traversal
  per node view or listener; the browser lifecycle gate intentionally registers
  hundreds of consumers to keep application O(document + consumers).
- Exact line and page decorations may publish only after every live
  geometry-carrying view has applied the same immutable publication. Keep this
  readiness barrier object-identity based; a parsed PageOracle result beside a
  pending or last-good crop is not an exact editor surface.
- A normal edit must remove touched forced-line presentation before its first
  paint, then install at most one settled line-decoration update. A matching
  snapshot result is a no-op, not a second visual correction.
- Compiler work is bounded, priority-aware, and latest-revision-wins. Stale or
  canceled work may neither publish nor block a final Proof/PDF action behind
  disposable background work.
- Contextual caption/footnote boundary markers must be zero-flow. All internal
  preview instrumentation must be collision-resistant and removed from the
  sanitized preview asset; `.typ`, Proof, and PDF must continue through the
  uninstrumented prepared-source boundary.
- Line breaks, spacing, hyphens, and page gaps stay presentation-only. They may
  not enter document content, undo history, clipboard data, accessibility
  text, persistence, or exported source.
- Pagination optimizations must fail closed on structural edits, inline atoms,
  footnotes, tables, lists, changed settings or geometry, invalid markers, and
  stale asynchronous results. "Fail closed" means clearing page markers,
  spacers, sheets, and folios and entering labelled continuous mode; it never
  means invoking a browser-geometry page planner. Mapped starts may be held
  only with explicit provenance from the last exact compile, only while its
  replacement is pending, and only after stale-geometry validation.

For any layout change, in addition to the full command set above:

1. Confirm the two frozen files have no diff against the target branch:

   ```sh
   git diff --exit-code origin/main...HEAD -- \
     src/layout/knuth-plass.ts src/layout/port/linebreak.ts
   ```

2. Run `npm run test:layout` for port smoke and font certification, `npm test`
   for pure layout contracts, and `npm run test:browser` for live/PageOracle,
   shared-publication, decoration, pagination, selection, undo, and
   writing-stability behavior.
3. Confirm the full-document snapshot belongs to the latest serialized source,
   page starts and line ranges retain their signatures, and the first-paint and
   queue counters do not exceed their checked-in budgets. Do not loosen a
   tolerance or update a baseline without attaching the before/after fixture
   and explaining the numerical cause.

## Structured editing and Typst escape hatches

- A table is one native ProseMirror tree of rows and rich cells. Extend that
  model and its direct Typst serializer; do not add a compiled table clone,
  modal string grid, or second source of cell truth.
- Ordinary language-labelled code blocks are inert, including a `typst`
  fence. Only the dedicated `typst_embed` node executes Typst. Keep legacy
  migration keyed to the exact historical `typst-raw` marker so opening a
  normal code sample can never make it executable. Keep ordinary code visually
  plain in both native editing and Proof: the generated unlabelled `#raw` plus
  inert `typeset:code-block-params` comment is its lossless round-trip boundary.
- A Typst embed's editable source remains visible, and its preview is a crop
  from the shared whole-document publication so earlier definitions, settings,
  counters, fonts, and assets are in scope. Do not reintroduce per-embed
  synthetic compiles.
- Environment-mutating or out-of-flow embeds (`#set`, `#show`, include/eval,
  place/move, explicit page/column breaks, and state/counter updates) are
  Proof-only layout boundaries. Preserve and execute them exactly in Proof/PDF,
  keep their source editable, and label the live surface continuous with the
  blocker reason. Never certify later native DOM against effects it does not
  paint.
- Inline Typst support is deliberately classified: one balanced fixed atom may
  use a shared-publication crop, and canonical `#h(1fr)` may consume compiled
  line slack. Everything else stays lossless and visibly unsupported in the
  editor while remaining exact in `.typ`, Proof, and PDF; never approximate or
  silently discard arbitrary inline source.
- Committed math and a populated References block obtain their exact ink and
  geometry from the shared publication. KaTeX and the semantic bibliography
  DOM are immediate, disposable fallbacks; neither may become settled width,
  line, page, or export authority.
- A bounded preview region that crosses Typst pages cannot be represented as
  one live atomic crop. Retain the current publication, show an explicit
  Proof-only state with editable/semantic fallback, and let the independent
  page mapper fail continuous when the internal boundary is unrepresentable.
  Never paint a page-spanning overlay or charge invented height to document
  flow merely to make the crop look present.

## Supported-font contract

New Computer Modern is currently the only exact, selectable body family. Its
regular, italic, bold, and bold-italic faces are explicitly registered for the
browser and Typst compiler through `src/font-registry.ts`; the optional
differential sidecar retains matching fixtures for research tests. Other
bundled or historical font names are compatibility inputs, not fidelity
claims: Plass preserves the stored preference but `effectiveFont` resolves it
to New Computer Modern consistently for live layout, CSS, compilation, and
export.

Do not expose another family in the selector merely because its files are
bundled. A new public family needs all four faces from one licensed family,
matching browser/compiler identities, notices, registry tests, full-document
snapshot coverage, Proof/PDF comparison, and browser coverage. The optional
port fixtures may provide additional evidence but are not a production
dependency. A family may be marked `exact` and `selectable` only after every
required layer passes.

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
- the mixed-document soak, large-document typing budgets, compile preemption,
  publication lifecycle/readiness, Chromium/Firefox/WebKit core flow, and real
  Proof-versus-downloaded-PDF raster comparison pass without relaxed budgets;
- `npm run verify:production` passes after the final build, and the deployed
  HTTPS site is checked again for its CSP, compiler worker, startup, and PDF
  export; and
- the production import graph contains no local or suffix pagination planner
  and no paragraph-fragment layout authority; broker-sharing and PageOracle
  failure/recovery browser tests prove that stale page artifacts do not
  resurrect before a new exact success.

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
