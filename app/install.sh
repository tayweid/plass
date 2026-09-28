#!/bin/bash
# Install or update Plass.app by building it from the GitHub repository.
#
#   curl -fsSL https://raw.githubusercontent.com/tayweid/plass/main/app/install.sh | bash
#
# Nothing prebuilt is downloaded: the repository is cloned (once) into
# ~/Library/Application Support/Plass/source, brought up to date, and built
# on this Mac, then installed in /Applications (or ~/Applications when
# /Applications is not writable). Running it again updates Plass.
#
# Needs Apple's Command Line Tools (swiftc, git) and Node 22 or newer.
#
# Overrides, for testing: PLASS_REPO (clone source), PLASS_BRANCH,
# PLASS_SOURCE_DIR (where the clone lives), PLASS_APP (the .app to write).
set -euo pipefail

repo="${PLASS_REPO:-https://github.com/tayweid/plass.git}"
branch="${PLASS_BRANCH:-main}"
source_dir="${PLASS_SOURCE_DIR:-$HOME/Library/Application Support/Plass/source}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Plass install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "Plass.app is for macOS."

if ! xcode-select -p >/dev/null 2>&1 || ! command -v swiftc >/dev/null 2>&1; then
    xcode-select --install >/dev/null 2>&1 || true
    die "Apple's Command Line Tools are needed. macOS is offering to install them now; run this again when that finishes."
fi
command -v git >/dev/null 2>&1 || die "git is missing (it comes with the Command Line Tools)."
command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
    || die "Node 22 or newer is needed: https://nodejs.org (or: brew install node)."
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' \
    || die "Node $(node -v) is too old; Plass needs Node 22 or newer."

if [ -n "${PLASS_APP:-}" ]; then
    app="$PLASS_APP"
elif [ -w /Applications ]; then
    app="/Applications/Plass.app"
else
    mkdir -p "$HOME/Applications"
    app="$HOME/Applications/Plass.app"
fi

# The clone is Plass's own build cache, never anyone's working copy, so it
# is simply made to match the branch.
if [ -d "$source_dir/.git" ]; then
    say "Updating the Plass source…"
    git -C "$source_dir" fetch --quiet --depth 1 origin "$branch"
    git -C "$source_dir" reset --quiet --hard FETCH_HEAD
else
    say "Downloading the Plass source…"
    mkdir -p "$(dirname "$source_dir")"
    git clone --quiet --depth 1 --branch "$branch" "$repo" "$source_dir"
fi
say "Plass $(git -C "$source_dir" log -1 --format='%h, %cd' --date=short)"

say "Installing build tools (npm)…"
(cd "$source_dir" && npm ci --no-audit --no-fund --loglevel=error)

say "Building Plass.app…"
"$source_dir/app/build.sh" "$app"

say "Installed $app"
echo "Open it from Applications, or: open \"$app\""
