# Third-party notices

Plass distributes third-party JavaScript, WebAssembly, and font files.

- [`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt) is
  generated from the exact production packages in `package-lock.json`. Run
  `npm run generate:notices` after changing dependencies and commit the
  result. `npm run verify:licenses` fails if it is stale or a production
  package lacks a declared license or license text.
- [`public/fonts/README.md`](public/fonts/README.md) maps every bundled font
  family and version to its full license notice.

These third-party terms do not determine the license for Plass's own source
code. That must be selected separately in the repository's root `LICENSE`
file before an open-source release. In particular, NewCM10-Regular's
Distribution Exception requires the surrounding program to use a
GPLv3-compatible license; replace that font if the selected project license is
not compatible. This inventory is release-engineering documentation, not
legal advice.
