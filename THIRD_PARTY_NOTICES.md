# Third-party notices

Plass distributes third-party JavaScript, WebAssembly, and font files.

- [`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt) is
  generated from the exact production packages in `package-lock.json`. Run
  `npm run generate:notices` after changing dependencies and commit the
  result. `npm run verify:licenses` fails if it is stale or a production
  package lacks a declared license or license text.
- [`public/fonts/README.md`](public/fonts/README.md) maps every bundled font
  family and version to its full license notice.

Plass's own source is distributed under the root [`MIT License`](LICENSE).
Third-party code and fonts retain the separate terms listed in their notices.
In particular, NewCM10-Regular's Distribution Exception requires the
surrounding program to use a GPLv3-compatible license; Plass relies on that
exception with its MIT project license. This inventory is release-engineering
documentation, not legal advice.
