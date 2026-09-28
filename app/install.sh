#!/bin/bash
# Install or update Plass.app:
#
#   curl -fsSL https://raw.githubusercontent.com/tayweid/plass/main/app/install.sh | bash
#
# Downloads the app (app/Plass.app.zip, committed to the repository — the
# knuth model), puts it in /Applications (or ~/Applications when that is not
# writable), and fetches the Typst compiler and fonts it keeps outside the
# zip, so the first launch opens straight to a page. Needs nothing but macOS.
#
# Overrides, for testing: PLASS_ZIP (a URL or local path), PLASS_APP.
set -euo pipefail

zip_source="${PLASS_ZIP:-https://raw.githubusercontent.com/tayweid/plass/main/app/Plass.app.zip}"

die() { printf 'Plass install: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = "Darwin" ] || die "Plass.app is for macOS."

if [ -n "${PLASS_APP:-}" ]; then
    app="$PLASS_APP"
elif [ -w /Applications ]; then
    app="/Applications/Plass.app"
else
    mkdir -p "$HOME/Applications"
    app="$HOME/Applications/Plass.app"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "Plass: downloading the app…"
case "$zip_source" in
    http*) curl -fsSL -o "$work/Plass.app.zip" "$zip_source" ;;
    *) cp "$zip_source" "$work/Plass.app.zip" ;;
esac
ditto -x -k "$work/Plass.app.zip" "$work"
[ -x "$work/Plass.app/Contents/MacOS/Plass" ] || die "the download did not contain Plass.app."

rm -rf "$app"
mkdir -p "$(dirname "$app")"
mv "$work/Plass.app" "$app"
echo "Plass: installed $app"

# A failure here is not fatal: the app fetches what is missing when it opens.
"$app/Contents/MacOS/Plass" --fetch-runtime || true
echo "Open Plass from $(dirname "$app")."
