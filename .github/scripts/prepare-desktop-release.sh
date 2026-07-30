#!/usr/bin/env bash

set -euo pipefail

ARTIFACTS_DIR="${1:-}"
RELEASE_DIR="${2:-}"
VERSION="${3:-}"
TAG_NAME="${4:-}"
GH_REPO="${5:-}"

if [[ -z "$ARTIFACTS_DIR" || -z "$RELEASE_DIR" || -z "$VERSION" || -z "$TAG_NAME" || -z "$GH_REPO" ]]; then
  echo "Usage: $0 <artifacts-dir> <release-dir> <version> <tag-name> <owner/repo>" >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Invalid desktop version: $VERSION" >&2
  exit 1
fi

if [[ "$TAG_NAME" != "desktop-v$VERSION" ]]; then
  echo "Tag $TAG_NAME does not match embedded version $VERSION" >&2
  exit 1
fi

if [[ ! -d "$ARTIFACTS_DIR" ]]; then
  echo "Artifact directory does not exist: $ARTIFACTS_DIR" >&2
  exit 1
fi

if [[ -e "$RELEASE_DIR" ]] && find "$RELEASE_DIR" -mindepth 1 -print -quit | grep -q .; then
  echo "Release directory must be empty: $RELEASE_DIR" >&2
  exit 1
fi

mkdir -p "$RELEASE_DIR"

copy_one() {
  local search_dir="$1"
  local pattern="$2"
  local destination_name="${3:-}"
  local -a matches=()

  if [[ ! -d "$search_dir" ]]; then
    echo "Expected artifact is missing: $search_dir" >&2
    exit 1
  fi

  while IFS= read -r -d '' match; do
    matches+=("$match")
  done < <(find "$search_dir" -type f -name "$pattern" -print0)

  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "Expected exactly one $pattern in $search_dir, found ${#matches[@]}" >&2
    exit 1
  fi

  if [[ -z "$destination_name" ]]; then
    destination_name="$(basename "${matches[0]}")"
  fi

  cp "${matches[0]}" "$RELEASE_DIR/$destination_name"
}

# Copy each versioned installer explicitly so a run with incomplete or mixed
# artifacts cannot be promoted accidentally.
copy_one "$ARTIFACTS_DIR/desktop-macOS-arm64" "HackerAI_${VERSION}_aarch64.dmg"
copy_one "$ARTIFACTS_DIR/desktop-macOS-x64" "HackerAI_${VERSION}_x64.dmg"
copy_one "$ARTIFACTS_DIR/desktop-macOS-universal" "HackerAI-universal.dmg"
copy_one "$ARTIFACTS_DIR/desktop-Linux-x64" "HackerAI_${VERSION}_amd64.AppImage"
copy_one "$ARTIFACTS_DIR/desktop-Linux-x64" "HackerAI_${VERSION}_amd64.AppImage.tar.gz"
copy_one "$ARTIFACTS_DIR/desktop-Linux-x64" "HackerAI_${VERSION}_amd64.AppImage.tar.gz.sig"
copy_one "$ARTIFACTS_DIR/desktop-Linux-x64" "HackerAI_${VERSION}_amd64.deb"
copy_one "$ARTIFACTS_DIR/desktop-Linux-arm64" "HackerAI_${VERSION}_aarch64.AppImage"
copy_one "$ARTIFACTS_DIR/desktop-Linux-arm64" "HackerAI_${VERSION}_aarch64.AppImage.tar.gz"
copy_one "$ARTIFACTS_DIR/desktop-Linux-arm64" "HackerAI_${VERSION}_aarch64.AppImage.tar.gz.sig"
copy_one "$ARTIFACTS_DIR/desktop-Linux-arm64" "HackerAI_${VERSION}_arm64.deb"
copy_one "$ARTIFACTS_DIR/desktop-Windows-x64" "HackerAI_${VERSION}_x64-setup.exe"
copy_one "$ARTIFACTS_DIR/desktop-Windows-x64" "HackerAI_${VERSION}_x64-setup.nsis.zip"
copy_one "$ARTIFACTS_DIR/desktop-Windows-x64" "HackerAI_${VERSION}_x64-setup.nsis.zip.sig"

# Tauri gives both macOS updater archives the same filename. Keep both by
# assigning architecture-specific release names before generating latest.json.
copy_one "$ARTIFACTS_DIR/desktop-macOS-arm64" "HackerAI.app.tar.gz" "HackerAI-aarch64.app.tar.gz"
copy_one "$ARTIFACTS_DIR/desktop-macOS-arm64" "HackerAI.app.tar.gz.sig" "HackerAI-aarch64.app.tar.gz.sig"
copy_one "$ARTIFACTS_DIR/desktop-macOS-x64" "HackerAI.app.tar.gz" "HackerAI-x86_64.app.tar.gz"
copy_one "$ARTIFACTS_DIR/desktop-macOS-x64" "HackerAI.app.tar.gz.sig" "HackerAI-x86_64.app.tar.gz.sig"

cp "$RELEASE_DIR/HackerAI_${VERSION}_amd64.AppImage" "$RELEASE_DIR/HackerAI-linux-x64.AppImage"
cp "$RELEASE_DIR/HackerAI_${VERSION}_aarch64.AppImage" "$RELEASE_DIR/HackerAI-linux-arm64.AppImage"
cp "$RELEASE_DIR/HackerAI_${VERSION}_amd64.deb" "$RELEASE_DIR/HackerAI-linux-x64.deb"
cp "$RELEASE_DIR/HackerAI_${VERSION}_arm64.deb" "$RELEASE_DIR/HackerAI-linux-arm64.deb"
cp "$RELEASE_DIR/HackerAI_${VERSION}_x64-setup.exe" "$RELEASE_DIR/HackerAI-windows-x64.exe"

read_signature() {
  local signature_file="$1"
  local signature

  signature="$(<"$signature_file")"
  if [[ -z "$signature" ]]; then
    echo "Updater signature is empty: $signature_file" >&2
    exit 1
  fi
  printf '%s' "$signature"
}

verify_signature() {
  local archive_file="$1"
  local signature_file="$2"
  local decoded_signature

  if [[ -z "${MINISIGN_PUBLIC_KEY:-}" ]]; then
    echo "MINISIGN_PUBLIC_KEY is required to verify updater artifacts" >&2
    exit 1
  fi
  if ! command -v minisign >/dev/null 2>&1; then
    echo "minisign is required to verify updater artifacts" >&2
    exit 1
  fi

  decoded_signature="$(mktemp)"
  if ! openssl base64 -d -A -in "$signature_file" -out "$decoded_signature" 2>/dev/null; then
    rm -f "$decoded_signature"
    echo "Updater signature is not valid base64: $signature_file" >&2
    exit 1
  fi

  if ! minisign -Vm "$archive_file" -x "$decoded_signature" -P "$MINISIGN_PUBLIC_KEY" >/dev/null; then
    rm -f "$decoded_signature"
    echo "Updater signature verification failed: $archive_file" >&2
    exit 1
  fi
  rm -f "$decoded_signature"
}

MACOS_ARM_FILE="HackerAI-aarch64.app.tar.gz"
MACOS_X64_FILE="HackerAI-x86_64.app.tar.gz"
LINUX_X64_FILE="HackerAI_${VERSION}_amd64.AppImage.tar.gz"
LINUX_ARM_FILE="HackerAI_${VERSION}_aarch64.AppImage.tar.gz"
WINDOWS_FILE="HackerAI_${VERSION}_x64-setup.nsis.zip"

verify_signature "$RELEASE_DIR/$MACOS_ARM_FILE" "$RELEASE_DIR/${MACOS_ARM_FILE}.sig"
verify_signature "$RELEASE_DIR/$MACOS_X64_FILE" "$RELEASE_DIR/${MACOS_X64_FILE}.sig"
verify_signature "$RELEASE_DIR/$LINUX_X64_FILE" "$RELEASE_DIR/${LINUX_X64_FILE}.sig"
verify_signature "$RELEASE_DIR/$LINUX_ARM_FILE" "$RELEASE_DIR/${LINUX_ARM_FILE}.sig"
verify_signature "$RELEASE_DIR/$WINDOWS_FILE" "$RELEASE_DIR/${WINDOWS_FILE}.sig"

MACOS_ARM_SIG="$(read_signature "$RELEASE_DIR/${MACOS_ARM_FILE}.sig")"
MACOS_X64_SIG="$(read_signature "$RELEASE_DIR/${MACOS_X64_FILE}.sig")"
LINUX_X64_SIG="$(read_signature "$RELEASE_DIR/${LINUX_X64_FILE}.sig")"
LINUX_ARM_SIG="$(read_signature "$RELEASE_DIR/${LINUX_ARM_FILE}.sig")"
WINDOWS_SIG="$(read_signature "$RELEASE_DIR/${WINDOWS_FILE}.sig")"
PUBLISH_DATE="${PUBLISH_DATE:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
RELEASE_URL="https://github.com/${GH_REPO}/releases/download/${TAG_NAME}"

jq -n \
  --arg version "$VERSION" \
  --arg pub_date "$PUBLISH_DATE" \
  --arg macos_arm_url "$RELEASE_URL/$MACOS_ARM_FILE" \
  --arg macos_arm_sig "$MACOS_ARM_SIG" \
  --arg macos_x64_url "$RELEASE_URL/$MACOS_X64_FILE" \
  --arg macos_x64_sig "$MACOS_X64_SIG" \
  --arg linux_x64_url "$RELEASE_URL/$LINUX_X64_FILE" \
  --arg linux_x64_sig "$LINUX_X64_SIG" \
  --arg linux_arm_url "$RELEASE_URL/$LINUX_ARM_FILE" \
  --arg linux_arm_sig "$LINUX_ARM_SIG" \
  --arg windows_url "$RELEASE_URL/$WINDOWS_FILE" \
  --arg windows_sig "$WINDOWS_SIG" \
  '{
    version: $version,
    notes: "See release notes on GitHub",
    pub_date: $pub_date,
    platforms: {
      "darwin-aarch64": {url: $macos_arm_url, signature: $macos_arm_sig},
      "darwin-x86_64": {url: $macos_x64_url, signature: $macos_x64_sig},
      "linux-x86_64": {url: $linux_x64_url, signature: $linux_x64_sig},
      "linux-aarch64": {url: $linux_arm_url, signature: $linux_arm_sig},
      "windows-x86_64": {url: $windows_url, signature: $windows_sig}
    }
  }' > "$RELEASE_DIR/latest.json"

echo "Prepared desktop release $TAG_NAME from verified $VERSION artifacts:"
find "$RELEASE_DIR" -maxdepth 1 -type f -print | sort
