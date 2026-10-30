#!/usr/bin/env bash
# Builds the release ZIP: just the files the browser loads, inside a
# top-level mist-provision-box/ folder ready for "Load unpacked". Built from the
# committed tree (git archive), so local edits and untracked files never
# leak into a release.
#
#   scripts/build-release.sh [output.zip]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$(realpath -m "${1:-mist-provision-box.zip}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git -C "$here/.." archive HEAD mist-toolbox | tar -x -C "$work"
rm -rf "$work/mist-toolbox/tests" "$work/mist-toolbox/scripts" \
       "$work/mist-toolbox/docs/screenshots" "$work/mist-toolbox/package.json"
# Its own folder name, so it unzips beside the read-only Mist Toolbox without clashing.
mv "$work/mist-toolbox" "$work/mist-provision-box"
rm -f "$out"
(cd "$work" && zip -qr -X "$out" mist-provision-box)
version="$(grep -o '"version": *"[^"]*"' "$here/manifest.json" | cut -d'"' -f4)"
echo "$out  (v$version, $(unzip -l "$out" | tail -1 | awk '{print $2}') files)"
sha256sum "$out"
