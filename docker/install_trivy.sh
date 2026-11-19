#!/bin/sh
set -eu

# Release archive digests published with Trivy v0.76.2.
version=0.76.2
case "$(uname -m)" in
    x86_64)
        platform=64bit
        checksum=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
        ;;
    aarch64|arm64)
        platform=ARM64
        checksum=ab9d51f86e6a5fb936f605faff6b593ac51bc378fff4d3e8b9d58358b9c367c3
        ;;
    *) echo 'Unsupported sandbox architecture' >&2; exit 1 ;;
esac

download_dir=$(mktemp -d)
trap 'rm -rf "$download_dir"' EXIT
trap 'exit 1' HUP INT TERM
archive="$download_dir/trivy.tar.gz"
curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/aquasecurity/trivy/releases/download/v${version}/trivy_${version}_Linux-${platform}.tar.gz" \
    -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
tar -xzf "$archive" -C "$download_dir" trivy LICENSE
"$download_dir/trivy" --version
install -Dm644 "$download_dir/LICENSE" /usr/local/share/licenses/trivy/LICENSE
install -m0755 "$download_dir/trivy" /usr/local/bin/trivy
