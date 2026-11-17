#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:?Notarized app or DMG path is required}"
# Apple's ticket can be unavailable briefly after notarization is Accepted.
# Stapling is idempotent; retain the signed bytes and retry before rebuilding.
for attempt in 1 2 3; do
  if xcrun stapler staple "$TARGET"; then
    xcrun stapler validate "$TARGET"
    exit 0
  else
    result=$?
  fi
  if [[ "$attempt" == 3 ]]; then
    echo "::error::Could not staple the notarization ticket after three attempts"
    exit "$result"
  fi
  echo "Notarization ticket unavailable; retrying stapling in 15 seconds..."
  sleep 15
done
