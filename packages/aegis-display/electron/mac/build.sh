#!/usr/bin/env bash
#
# build.sh — Build, sign, and notarize the AegisDisplayHelper binary
#
# Usage (on macOS only):
#   ./build.sh                          # build only (debug, unsigned)
#   ./build.sh --release                # build release (unsigned)
#   ./build.sh --release --sign         # build release + Developer ID sign
#   ./build.sh --release --sign --notarize  # full pipeline
#
# Output: ../../../electron/mac/dist/AegisDisplayHelper
#         (electron-builder picks this up via extraResources)
#
# Phase 2 §6.2 scaffold (2026-05-10): build pipeline is laid out but un-tested
# until next Mac session. Sign + notarize sections are gated behind --sign /
# --notarize flags so initial Mac runs can iterate without code-signing setup.

set -euo pipefail

# ─── Args ────────────────────────────────────────────────────────────────────
CONFIG="debug"
DO_SIGN=0
DO_NOTARIZE=0

for arg in "$@"; do
  case "$arg" in
    --release) CONFIG="release" ;;
    --sign) DO_SIGN=1 ;;
    --notarize) DO_NOTARIZE=1 ;;
    -h|--help)
      head -20 "$0" | sed -n 's/^# \?//p'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$DO_NOTARIZE" == 1 && "$DO_SIGN" == 0 ]]; then
  echo "--notarize requires --sign" >&2
  exit 2
fi

# ─── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$SCRIPT_DIR/AegisDisplayHelper"
DIST_DIR="$SCRIPT_DIR/dist"
ENTITLEMENTS="$SCRIPT_DIR/AegisDisplayHelper.entitlements"

# ─── Sanity checks ───────────────────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo "build.sh must run on macOS (current: $(uname))" >&2
  exit 1
fi

if ! command -v swift &>/dev/null; then
  echo "swift CLI not found — install Xcode or Xcode Command Line Tools" >&2
  exit 1
fi

# ─── Build ───────────────────────────────────────────────────────────────────
echo "==> swift build -c $CONFIG (in $HELPER_DIR)"
cd "$HELPER_DIR"
swift build -c "$CONFIG"

BUILT_BINARY="$HELPER_DIR/.build/$CONFIG/AegisDisplayHelper"
if [[ ! -f "$BUILT_BINARY" ]]; then
  echo "Build succeeded but binary not at expected path: $BUILT_BINARY" >&2
  exit 1
fi
echo "==> built: $BUILT_BINARY"

# ─── Stage to dist/ ──────────────────────────────────────────────────────────
mkdir -p "$DIST_DIR"
cp "$BUILT_BINARY" "$DIST_DIR/AegisDisplayHelper"
DIST_BINARY="$DIST_DIR/AegisDisplayHelper"
echo "==> staged to: $DIST_BINARY"

# ─── Sign (optional) ─────────────────────────────────────────────────────────
if [[ "$DO_SIGN" == 1 ]]; then
  if [[ -z "${AEGIS_DEVELOPER_ID:-}" ]]; then
    echo "AEGIS_DEVELOPER_ID env var required for signing (e.g. 'Developer ID Application: AegisRD (TEAMID)')" >&2
    exit 1
  fi
  echo "==> codesign with Developer ID + hardened runtime"
  codesign \
    --force \
    --options runtime \
    --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$AEGIS_DEVELOPER_ID" \
    "$DIST_BINARY"
  codesign --verify --deep --strict --verbose=2 "$DIST_BINARY"
  echo "==> signed: $DIST_BINARY"
fi

# ─── Notarize (optional) ─────────────────────────────────────────────────────
if [[ "$DO_NOTARIZE" == 1 ]]; then
  if [[ -z "${AEGIS_NOTARIZE_PROFILE:-}" ]]; then
    echo "AEGIS_NOTARIZE_PROFILE env var required (xcrun notarytool keychain profile name)" >&2
    exit 1
  fi
  echo "==> notarize via xcrun notarytool"
  # CLI binaries can't be notarized standalone — they must be in a zip / dmg.
  # We zip the helper, submit, then unzip the staple-d binary back.
  ZIP_PATH="$DIST_DIR/AegisDisplayHelper.zip"
  ditto -c -k --keepParent "$DIST_BINARY" "$ZIP_PATH"
  xcrun notarytool submit "$ZIP_PATH" \
    --keychain-profile "$AEGIS_NOTARIZE_PROFILE" \
    --wait
  # Note: stapling does not apply to CLI binaries. Notarization is recorded
  # against the binary's hash; Gatekeeper checks via online ticket lookup.
  rm -f "$ZIP_PATH"
  echo "==> notarized: $DIST_BINARY"
fi

echo "==> done"
echo "    output: $DIST_BINARY"
echo "    next:   electron-builder will copy this to <App>.app/Contents/Resources/"
