#!/bin/bash
# Build Plass.app from app/Sources with the command-line tools alone: no
# Xcode project, no package manager (the knuth pattern). The vite build
# rides in the bundle; the Typst compiler and compile fonts are fetched once
# on first launch (externalize.mjs), which keeps the committed zip small.
#
#   app/build.sh                   # -> app/build/Plass.app + app/Plass.app.zip
#   PLASS_SKIP_WEB=1 app/build.sh  # reuse the existing dist/
#   app/build.sh /Applications/Plass.app
set -euo pipefail
cd "$(dirname "$0")"
out="${1:-build/Plass.app}"
# The target is replaced wholesale, so it must be an app bundle.
case "$out" in
    *.app) ;;
    *) echo "build.sh: the target must end in .app (got $out)" >&2; exit 1 ;;
esac
icon_source="../public/icons/plass-512.png"

if [ -z "${PLASS_SKIP_WEB:-}" ]; then
    (cd .. && npx vite build)
fi
if [ ! -f ../dist/index.html ]; then
    echo "no dist/index.html — run the vite build" >&2
    exit 1
fi

# The command-line tools can ship an SDK newer than their own compiler,
# which swiftc refuses. Pick the newest SDK the compiler accepts.
sdk=""
probe="$(mktemp -d)/probe.swift"
echo 'import Foundation' > "$probe"
for candidate in $(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX*.*.sdk 2>/dev/null | sort -rV); do
    if swiftc -sdk "$candidate" -swift-version 5 -typecheck "$probe" >/dev/null 2>&1; then
        sdk="$candidate"
        break
    fi
done
rm -rf "$(dirname "$probe")"
[ -n "$sdk" ] || sdk="$(xcrun --show-sdk-path)"
echo "sdk: $sdk"

rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
# One binary for both Mac architectures when the toolchain can build both.
slices=()
for arch in arm64 x86_64; do
    if swiftc -O -swift-version 5 -sdk "$sdk" -target "$arch-apple-macos12.0" \
        -framework AppKit -framework WebKit \
        -o "$out/Contents/MacOS/Plass-$arch" Sources/main.swift 2>/dev/null; then
        slices+=("$out/Contents/MacOS/Plass-$arch")
    fi
done
if [ "${#slices[@]}" -eq 0 ]; then
    swiftc -O -swift-version 5 -sdk "$sdk" \
        -framework AppKit -framework WebKit \
        -o "$out/Contents/MacOS/Plass" Sources/main.swift
else
    lipo -create "${slices[@]}" -output "$out/Contents/MacOS/Plass"
    rm -f "${slices[@]}"
fi
echo "architectures: $(lipo -archs "$out/Contents/MacOS/Plass")"
cp Info.plist "$out/Contents/Info.plist"
printf 'APPL????' > "$out/Contents/PkgInfo"

# The site's install script is not part of the page.
rsync -a --exclude install ../dist/ "$out/Contents/Resources/web/"
# The compiler and compile fonts come on first launch, not in the zip.
node externalize.mjs "$out/Contents/Resources/web"

iconset="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$icon_source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    if [ "$double" -le 512 ]; then
        sips -z "$double" "$double" "$icon_source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
    fi
done
cp "$icon_source" "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o "$out/Contents/Resources/AppIcon.icns"
rm -rf "$(dirname "$iconset")"

# Ad-hoc signature: enough to run locally on Apple silicon.
codesign --force --sign - "$out" >/dev/null 2>&1
echo "built $out ($(du -sh "$out" | cut -f1 | tr -d ' '))"

# The download is this zip, committed to the repo (the knuth model): a file
# on GitHub, no release and no workflow. ditto keeps the bundle's metadata.
if [ "$out" = "build/Plass.app" ]; then
    rm -f Plass.app.zip
    ditto -c -k --keepParent "$out" Plass.app.zip
    echo "zipped app/Plass.app.zip ($(du -h Plass.app.zip | cut -f1 | tr -d ' '))"
fi
