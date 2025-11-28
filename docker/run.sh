#!/bin/bash
# HackerAI Agent Sandbox - Docker Run Script
# This script runs the container with required capabilities for penetration testing tools

set -e

IMAGE_NAME="${1:-hackerai-sandbox}"
CONTAINER_NAME="${2:-hackerai-agent}"

echo "🚀 Starting HackerAI Agent Sandbox..."
echo "   Image: $IMAGE_NAME"
echo "   Container: $CONTAINER_NAME"

# Remove existing container if it exists
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Run with required capabilities for penetration testing
docker run -it \
    --name "$CONTAINER_NAME" \
    --cap-add=NET_RAW \
    --cap-add=NET_ADMIN \
    --cap-add=SYS_PTRACE \
    -v "$(pwd)/workspace:/home/user/workspace" \
    "$IMAGE_NAME" \
    /bin/bash

# Capabilities explained:
# - NET_RAW: Required for ping, nmap, masscan, hping3, arp-scan, raw sockets
# - NET_ADMIN: Required for network interface manipulation, arp-scan, netdiscover
# - SYS_PTRACE: Required for gdb, strace, ltrace debugging tools

