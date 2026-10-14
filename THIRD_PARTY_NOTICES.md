# Third-party notices

Plass distributes third-party JavaScript, WebAssembly, and font files.

- [`public/LICENSE.txt`](public/LICENSE.txt) is a byte-identical distributable
  copy of Plass's root MIT license. Production verification checks both copies.

- [`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt) is
  generated from the exact production packages in `package-lock.json`, and
  from the code vendored outside npm. Run
  `npm run generate:notices` after changing dependencies and commit the
  result. `npm run verify:licenses` fails if it is stale or a production
  package lacks a declared license or license text.
- [`src/mitex/`](src/mitex) holds mitex 0.2.7's `mitex.wasm` (Apache-2.0),
  byte for byte from the Typst Universe archive `preview/mitex-0.2.7.tar.gz`
  (archive sha256 `0159e214845e49cbdc332d9d572da112dae5ad248072e0a7680d38c8307c2e15`,
  wasm sha256 `f30000cbc2b18a6cdc72c3ce539d3ac443faa9109b4e0272cd274b37c6c1cff7`,
  checked on every load and by the unit tests), with its license. Plass
  runs it locally to turn LaTeX math into native Typst math.
  [`src/typst-math-prelude.ts`](src/typst-math-prelude.ts) holds Typst
  definitions modified from mitex's `specs/latex/standard.typ`; its header
  says what changed. Both are listed in the generated notice above.
- [`public/SIDECAR_THIRD_PARTY_NOTICES.txt`](public/SIDECAR_THIRD_PARTY_NOTICES.txt)
  inventories every Rust crate compiled into the line-breaking sidecar from
  the exact reachable graph in `sidecar/Cargo.lock`. The same notice command
  regenerates and verifies both ordinary npm and sidecar inventories.
- [`public/TYPST_WASM_THIRD_PARTY_NOTICES.txt`](public/TYPST_WASM_THIRD_PARTY_NOTICES.txt)
  inventories the 426 external Rust crates reachable from the reconstructed
  locked compiler and renderer configurations associated with the precompiled
  Typst.ts WASM. It pins the npm tarball SRI values, installed WASM hashes,
  npm-registry-reported gitHead source archive, Cargo lockfile, and
  repository-root license sources omitted by some crates.io packages.
  `npm run generate:notices` and
  `npm run verify:licenses` verify this checked artifact offline without
  requiring the upstream sources.
- [`public/fonts/README.md`](public/fonts/README.md) maps every bundled font
  family and version to its full license notice.

Regenerating the Typst WASM inventory is deliberately separate because it
requires authenticated upstream material. Run
`node --import tsx scripts/generate-typst-wasm-notices.ts --print-sources` for
the exact download URLs, filenames, and SHA-256 digests. Then set:

```sh
TYPST_TS_SOURCE=/path/to/extracted/typst.ts-61cd6bdf5c08f508ce63406f58a92b0971ee84b8 \
TYPST_TS_ARCHIVE=/path/to/typst-ts-npm-githead.tar.gz \
TYPST_WASM_LICENSE_ARCHIVES=/path/to/license-source-downloads \
CARGO_HOME=/path/to/populated-cargo-cache \
npm run generate:typst-wasm-notices
```

The generated notice is explicit about two important limitations and
obligations: the published npm tarballs do not embed a verifiable `gitHead`,
so a reproducible source-to-WASM build comparison has not been demonstrated;
and the exact MPL-2.0-covered `option-ext` source archive is distributed at
`public/sources/option-ext-0.2.0.crate`, with its checksum and upstream mirror
printed near the top of the distributed notice.

Plass's own source is distributed under the root [`MIT License`](LICENSE),
which is also included in the built site as `LICENSE.txt`.
Third-party code and fonts retain the separate terms listed in their notices.
In particular, NewCM10-Regular's Distribution Exception requires the
surrounding program to use a GPLv3-compatible license; Plass relies on that
exception with its MIT project license. This inventory is release-engineering
documentation, not legal advice.
