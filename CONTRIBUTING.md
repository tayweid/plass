# Contributing to Plass

Plass is preparing for a public release. Contributions should preserve the
core promise that opening, editing, and saving an untrusted document cannot
execute active content, leak local data, or silently destroy work.

## Development setup

Use Node.js 22 and install exactly from the lockfile:

```sh
npm ci
npm run dev
```

Before submitting a change, run:

```sh
npm run verify:licenses
npm test
npm run test:browser
npm run build
npm run verify:production
```

Playwright starts its own Vite server on port 5199. Production verification
expects a completed `dist/` build.

## Change discipline

- Keep pull requests focused and explain user-visible behavior changes.
- Add regression tests for security boundaries, file persistence, parsers,
  serialization, and browser behavior whenever those areas change.
- Treat documents, bibliography data, image files, persisted settings, SVG,
  and Typst compiler output as untrusted input.
- Do not add a network request, remote origin, compiler package, HTML/SVG DOM
  sink, or file-write path without documenting its trust boundary and adding
  a fail-closed test.
- Keep dependencies minimal. Commit `package-lock.json`; regenerate and commit
  `public/THIRD_PARTY_NOTICES.txt` after production dependency changes.
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
