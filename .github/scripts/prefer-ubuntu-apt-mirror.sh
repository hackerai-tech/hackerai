#!/usr/bin/env bash
set -euo pipefail

# Hosted runners have failed to resolve Canonical's Ubuntu hostnames, and
# Azure's archive can stay reachable with very slow downloads. Route the
# runner's Ubuntu archive sources through an APT mirror list that prefers
# Hetzner's independently hosted HTTPS replica and retains Canonical fallbacks.
# Only the URI changes: suites, components, Signed-By and the Ubuntu archive
# keyring still verify every Release file. Other sources are left untouched.
# APT_MIRROR_ROOT runs the helper against a fixture configuration tree.
apt_root="${APT_MIRROR_ROOT:-/}"
apt_dir="${apt_root%/}/etc/apt"
mirror_list=/etc/apt/apt-mirrors.txt

case "${RUNNER_ARCH:-$(dpkg --print-architecture 2> /dev/null || true)}" in
  X64 | amd64)
    ubuntu_uri='^https?://([a-z0-9-]+[.])*(archive|security)[.]ubuntu[.]com/ubuntu/?$'
    mirrors=$(printf '%s\tpriority:%s\n' \
      'https://packages.hetzner.com/ubuntu/packages/' 1 \
      'https://archive.ubuntu.com/ubuntu/' 2 \
      'http://azure.archive.ubuntu.com/ubuntu/' 3 \
      'https://security.ubuntu.com/ubuntu/' 4)
    ;;
  ARM64 | arm64)
    ubuntu_uri='^https?://([a-z0-9-]+[.])*ports[.]ubuntu[.]com/ubuntu-ports/?$'
    mirrors=$(printf '%s\tpriority:%s\n' \
      'https://packages.hetzner.com/ubuntu-ports/packages/' 1 \
      'http://ports.ubuntu.com/ubuntu-ports/' 2)
    ;;
  *) exit 0 ;;
esac
if [[ ! -d $apt_dir ]]; then
  exit 0
fi

as_root() {
  if [[ $apt_root == / && $EUID -ne 0 ]]; then
    sudo "$@"
  else
    "$@"
  fi
}

# Rewrites the URI of legacy one-line entries or Deb822 URIs fields when it
# names this architecture's Canonical archive. Exits 10 when nothing changed.
# shellcheck disable=SC2016
rewrite_program='
function ubuntu(uri) { return tolower(uri) ~ pattern }
format == "list" && $1 ~ /^deb(-src)?$/ {
  i = 2
  if ($2 ~ /^\[/) { while (i < NF && $i !~ /\]$/) i++; i++ }
  if (i <= NF && ubuntu($i)) { $i = mirror; changed = 1 }
}
format == "sources" && tolower($0) ~ /^uris:/ {
  n = split(substr($0, 6), uris, /[ \t]+/)
  line = ""; found = 0
  split("", seen)
  for (j = 1; j <= n; j++) {
    if (uris[j] == "") continue
    if (ubuntu(uris[j])) { uris[j] = mirror; found = 1 }
    if (uris[j] in seen) continue
    seen[uris[j]] = 1
    line = line " " uris[j]
  }
  if (found) { $0 = substr($0, 1, 5) line; changed = 1 }
}
{ print }
END { if (!changed) exit 10 }
'

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

rewrite() {
  local status=0
  awk -v format="$2" -v pattern="$ubuntu_uri" -v mirror="mirror+file:$mirror_list" \
    "$rewrite_program" "$1" > "$tmp" || status=$?
  case $status in
    0)
      as_root tee "$1" < "$tmp" > /dev/null
      echo "Routed Ubuntu sources in $1 through $mirror_list"
      ;;
    10) ;;
    *) return "$status" ;;
  esac
}

# Write the list before any source refers to it.
printf '%s\n' "$mirrors" | as_root tee "$apt_dir/apt-mirrors.txt" > /dev/null

# Bound each acquisition so an unreachable mirror falls through or fails the
# install step within minutes instead of stalling the job.
printf '%s\n' \
  'Acquire::Retries "3";' \
  'Acquire::http::Timeout "30";' \
  'Acquire::https::Timeout "30";' \
  | as_root tee "$apt_dir/apt.conf.d/99ci-acquire-bounds" > /dev/null

shopt -s nullglob
for file in "$apt_dir/sources.list" "$apt_dir"/sources.list.d/*.list; do
  if [[ -f $file ]]; then
    rewrite "$file" list
  fi
done
for file in "$apt_dir"/sources.list.d/*.sources; do
  rewrite "$file" sources
done
