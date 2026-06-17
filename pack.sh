#!/usr/bin/env bash
# Media Seekbar — produces a ZIP suitable for upload to extensions.gnome.org.
# Built from a clean staging dir with only the runtime files (no README,
# no screenshot, no scripts). Needs only `zip`; no GNOME install required.

set -euo pipefail

UUID="mediaseekbar@carlosjdelgado"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SRC_DIR}/dist"
STAGE_DIR="${BUILD_DIR}/${UUID}"
OUT_ZIP="${BUILD_DIR}/${UUID}.shell-extension.zip"

cd "${SRC_DIR}"

rm -rf "${BUILD_DIR}"
mkdir -p "${STAGE_DIR}"

cp metadata.json extension.js stylesheet.css LICENSE "${STAGE_DIR}/"

( cd "${STAGE_DIR}" && zip -qr "${OUT_ZIP}" . )

echo "Package ${UUID} ready: ${OUT_ZIP}"
