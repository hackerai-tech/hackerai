#!/bin/sh
set -eu

# Debian's backport fixes CVE-2026-111497 while Kali's rolling packages lag.
# Hashes are from packages.debian.org/sid/<arch>/<package>/download.
version=1.2.0-4.1
arch=$(dpkg --print-architecture)
case "$arch" in
    amd64)
        library_sha=2d58db32250aa535e27c62e98451debd43b539aa026066806432e842d5b56c00
        python_sha=3b62003bf956337d2ae672b40174cd303e740ea0e013d8405e503a4b5abaf061
        development_sha=2bfc5c1dd9c9cfcd45f619756e18fdcab6ae7e7ff3a289d54824cd4f7310c39f
        ;;
    arm64)
        library_sha=ff90055f0c42dc39fdf8f12d7f68c7da32da2ec90d0a49eb39e80b764988ee02
        python_sha=0923c03d9293e45cd8f744f1de5103b97603f0ae0c54b275d8f03ebf87b29750
        development_sha=d9c3e1fc125d3dd4a018cbc957286ec4776a9206de2484c1acb2504b02166516
        ;;
    *) echo 'Unsupported sandbox architecture' >&2; exit 1 ;;
esac

download_dir=$(mktemp -d)
trap 'rm -rf "$download_dir"' EXIT HUP INT TERM
for package in libbrotli1 python3-brotli libbrotli-dev; do
    status=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)
    # The development package has an exact library dependency. Upgrade it when
    # present, without adding headers to images that do not already need them.
    if [ "$package" = libbrotli-dev ] && [ "$status" != installed ]; then continue; fi
    if [ "$status" = installed ]; then
        installed=$(dpkg-query -W -f='${Version}' "$package")
        if dpkg --compare-versions "$installed" ge "$version"; then continue; fi
    fi
    case "$package" in
        libbrotli1) checksum=$library_sha ;;
        python3-brotli) checksum=$python_sha ;;
        libbrotli-dev) checksum=$development_sha ;;
    esac
    archive="$download_dir/$package.deb"
    curl --fail --silent --show-error --location --retry 3 \
        "https://deb.debian.org/debian/pool/main/b/brotli/${package}_${version}_${arch}.deb" \
        -o "$archive"
    echo "$checksum  $archive" | sha256sum -c -
    test "$(dpkg-deb -f "$archive" Package)" = "$package"
    test "$(dpkg-deb -f "$archive" Version)" = "$version"
    test "$(dpkg-deb -f "$archive" Architecture)" = "$arch"
done

set -- "$download_dir"/*.deb
if [ -f "$1" ]; then dpkg -i "$@"; fi
