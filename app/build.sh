#!/bin/bash
# Build Plass.app from app/Sources with the command-line tools alone: no
# Xcode project, no package manager (the knuth pattern). The vite build
# rides in the bundle, so the app runs with no network.
#
#   app/build.sh                   # -> app/build/Plass.app (runs the vite build)
#   PLASS_SKIP_WEB=1 app/build.sh  # reuse the existing dist/
#   app/build.sh /Applications/Plass.app
set -euo pipefail
cd "$(dirname "$0")"
out="${1:-build/Plass.app}"
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

rsync -a ../dist/ "$out/Contents/Resources/web/"

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
