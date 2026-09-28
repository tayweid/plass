#!/bin/bash
# Build Plass.app and install it (the knuth pattern: one Swift file, swiftc
# alone, no Xcode project).
#
#   app/build.sh                   # your own copy, into /Applications
#   app/build.sh ~/Desktop/P.app   # anywhere else
#   PLASS_SKIP_WEB=1 app/build.sh  # reuse the existing dist/
#
# The app is the site's page (the vite build, compiler and fonts included)
# inside a small native shell. The shell's compiled program and icon are
# committed in app/bin, because the site deploy runs on Linux and cannot
# compile Swift: `npm run build` packs app/bin with the page into dist/app,
# and plass.tayweid.io/install assembles the app from there. Nothing large
# is committed; the page reaches installs with every deploy.
#
# app/bin is recompiled only when main.swift or the icon changes (their
# hashes are in app/bin/sources.sha256) — commit it with that change. The
# build check fails when they disagree, so a stale shell never ships.
set -euo pipefail
cd "$(dirname "$0")"
if [ -n "${1:-}" ]; then
    out="$1"
elif [ -w /Applications ]; then
    out="/Applications/Plass.app"
else
    mkdir -p "$HOME/Applications"
    out="$HOME/Applications/Plass.app"
fi
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

# ---- the shell (app/bin), refreshed only when its sources changed ----
if ! shasum -a 256 -c bin/sources.sha256 >/dev/null 2>&1 || [ ! -x bin/Plass ] || [ ! -f bin/AppIcon.icns ]; then
    echo "main.swift or the icon changed: recompiling app/bin (commit it with the change)"
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

    work="$(mktemp -d)"
    # One program for both Mac architectures.
    for arch in arm64 x86_64; do
        swiftc -O -swift-version 5 -sdk "$sdk" -target "$arch-apple-macos12.0" \
            -framework AppKit -framework WebKit \
            -o "$work/Plass-$arch" Sources/main.swift
    done
    mkdir -p bin
    lipo -create "$work/Plass-arm64" "$work/Plass-x86_64" -output bin/Plass

    iconset="$work/AppIcon.iconset"
    mkdir -p "$iconset"
    for size in 16 32 128 256 512; do
        sips -z "$size" "$size" "$icon_source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
        double=$((size * 2))
        if [ "$double" -le 512 ]; then
            sips -z "$double" "$double" "$icon_source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
        fi
    done
    cp "$icon_source" "$iconset/icon_512x512@2x.png"
    iconutil -c icns "$iconset" -o bin/AppIcon.icns
    rm -rf "$work"
    shasum -a 256 Sources/main.swift "$icon_source" > bin/sources.sha256
fi

# ---- the app: the same assembly plass.tayweid.io/install does ----
rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
cp bin/Plass "$out/Contents/MacOS/Plass"
cp bin/AppIcon.icns "$out/Contents/Resources/AppIcon.icns"
cp Info.plist "$out/Contents/Info.plist"
printf 'APPL????' > "$out/Contents/PkgInfo"
# The site's installer and app pieces are not part of the page.
rsync -a --exclude /install --exclude /app ../dist/ "$out/Contents/Resources/web/"
# Ad-hoc signature: enough to run on Apple silicon.
codesign --force --sign - "$out" >/dev/null 2>&1
echo "built $out ($(du -sh "$out" | cut -f1 | tr -d ' '))"
