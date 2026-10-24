#!/usr/bin/env bash
set -euo pipefail
umask 077

DMG="${1:?DMG path is required}"
LOG="${2:?Redacted notarization log path is required}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "::error::Notarization credentials not configured!"
  exit 1
fi

echo "Notarizing universal DMG..."
# Stream the submission ID before --wait can outlive the runner. The redactor
# precedes both stdout and the local log; pipefail keeps every failure fatal.
if ! xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait 2>&1 |
  python3 "$SCRIPT_DIR/redact-notary-output.py" |
  tee "$LOG"; then
  echo "::error::Notarization failed!"
  SUBMISSION_ID="$(grep -o 'id: [a-f0-9-]*' "$LOG" | head -1 | cut -d' ' -f2 || true)"
  if [[ -n "$SUBMISSION_ID" ]]; then
    echo "Fetching notarization log..."
    xcrun notarytool log "$SUBMISSION_ID" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" 2>&1 |
      python3 "$SCRIPT_DIR/redact-notary-output.py" || true
  fi
  exit 1
fi

echo "Stapling notarization ticket to DMG..."
xcrun stapler staple "$DMG"
echo "Verifying notarization..."
spctl --assess --type open --context context:primary-signature -v "$DMG" || true
