#!/usr/bin/env bash
set -euo pipefail
umask 077

DMG="${1:?DMG path is required}"
ARCHIVE="${2:?Recovery archive path is required}"
if [[ ! "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] ||
  [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
  [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]; then
  echo "A verified workflow source and run identity are required" >&2
  exit 1
fi

RECOVERY_DIR="$(mktemp -d)"
trap 'rm -rf "$RECOVERY_DIR"' EXIT
cp "$DMG" "$RECOVERY_DIR/HackerAI-universal.dmg"
(
  cd "$RECOVERY_DIR"
  shasum -a 256 HackerAI-universal.dmg > HackerAI-universal.dmg.sha256
)
printf '%s\n' "$GITHUB_SHA" > "$RECOVERY_DIR/source-commit.txt"
printf '%s/%s\n' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" > "$RECOVERY_DIR/build-run.txt"
# Keep the pending DMG inside a tarball: release workflows search downloaded
# artifacts for installers, and must never discover this unnotarized copy.
tar -czf "$ARCHIVE" -C "$RECOVERY_DIR" \
  HackerAI-universal.dmg HackerAI-universal.dmg.sha256 source-commit.txt build-run.txt
