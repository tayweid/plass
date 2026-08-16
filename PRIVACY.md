# Privacy

Effective August 16, 2026.

Plass is a client-side editor. It has no Plass account system, application
backend, analytics, advertising, or telemetry. Document editing and Typst
compilation happen in the browser.

## Data stored on your device

Plass keeps a recovery copy of the current document in browser storage. In
browsers that support the File System Access API, it may also keep file handles
in IndexedDB so it can reconnect to files you previously opened. The browser
controls these permissions. Clearing the site's storage removes these recovery
records and handles; it does not delete files already saved or downloaded to
your device.

## Network requests

Plass does not upload document contents to an application backend. It can make
these narrowly scoped requests:

- If a document uses the supported mitex package for math, the compiler fetches
  one pinned, integrity-checked package archive from `packages.typst.org`. The
  request sends no credentials or referrer.
- A remote image remains blocked until you explicitly approve its displayed
  HTTPS origin for the current session. The request sends no credentials or
  referrer. The image host can still observe ordinary connection information,
  such as your IP address.
- GitHub hosts the static application through GitHub Pages and may process
  ordinary web-server connection data under GitHub's own privacy terms.

Files you deliberately upload through the browser's file picker are read
locally by Plass; they are not uploaded to a Plass server. Files you save or
export are written or downloaded through browser APIs.

## Questions and security reports

Use a GitHub issue for general privacy questions, but never put private
documents or sensitive personal information in an issue. Report suspected
vulnerabilities through the private process in [`SECURITY.md`](./SECURITY.md).
