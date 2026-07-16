#!/bin/bash
# HackerAI Agent Sandbox - Docker Run Script
# This script runs the container with required capabilities for penetration testing tools

set -e

IMAGE_NAME="${1:-hackerai-sandbox}"
CONTAINER_NAME="${2:-hackerai-agent}"
LOG_MAX_SIZE="${HACKERAI_DOCKER_LOG_MAX_SIZE:-50m}"
LOG_MAX_FILE="${HACKERAI_DOCKER_LOG_MAX_FILE:-3}"

if [[ ! "$LOG_MAX_SIZE" =~ ^[1-9][0-9]*([kKmMgG])?$ ]]; then
    echo "Invalid HACKERAI_DOCKER_LOG_MAX_SIZE: $LOG_MAX_SIZE" >&2
    exit 1
fi

if [[ ! "$LOG_MAX_FILE" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid HACKERAI_DOCKER_LOG_MAX_FILE: $LOG_MAX_FILE" >&2
    exit 1
fi

echo "🚀 Starting HackerAI Agent Sandbox..."
echo "   Image: $IMAGE_NAME"
echo "   Container: $CONTAINER_NAME"

# Remove existing container if it exists
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Run with required capabilities for penetration testing
docker run -it \
    --name "$CONTAINER_NAME" \
    --log-driver local \
    --log-opt max-size="$LOG_MAX_SIZE" \
    --log-opt max-file="$LOG_MAX_FILE" \
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
