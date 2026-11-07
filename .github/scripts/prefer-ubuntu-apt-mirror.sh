#!/usr/bin/env bash
set -euo pipefail

# Azure's archive can stay reachable with very slow downloads. Prefer Ubuntu's
# archive for CI while retaining the runner image's Azure/security fallbacks.
if [[ "${RUNNER_ARCH:-}" != X64 || ! -f /etc/apt/apt-mirrors.txt ]]; then
  exit 0
fi

printf '%s\tpriority:%s\n' \
  'https://archive.ubuntu.com/ubuntu/' 1 \
  'http://azure.archive.ubuntu.com/ubuntu/' 2 \
  'https://security.ubuntu.com/ubuntu/' 3 \
  | sudo tee /etc/apt/apt-mirrors.txt > /dev/null
