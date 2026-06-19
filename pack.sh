#!/usr/bin/env bash
# Media Seekbar — produces a ZIP suitable for upload to extensions.gnome.org.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SRC_DIR}/dist"
OUT_ZIP="${BUILD_DIR}/mediaseekbar@carlosjdelgado.shell-extension.zip"

cd "${SRC_DIR}"
mkdir -p "${BUILD_DIR}"
rm -f "${OUT_ZIP}"
zip -qj "${OUT_ZIP}" metadata.json extension.js seekBar.js stylesheet.css LICENSE

echo "Package ready: ${OUT_ZIP}"
