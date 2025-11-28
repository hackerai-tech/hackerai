#!/bin/bash
# Build the HackerAI sandbox Docker image locally
# Usage: ./docker/build.sh [tag]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${1:-latest}"
IMAGE_NAME="hackerai-sandbox:${TAG}"

echo "🔨 Building HackerAI Sandbox image..."
echo "   Tag: ${IMAGE_NAME}"
echo ""

docker build \
  -t "${IMAGE_NAME}" \
  -f "${SCRIPT_DIR}/Dockerfile" \
  "${SCRIPT_DIR}"

echo ""
echo "✅ Build complete: ${IMAGE_NAME}"
echo ""
echo "To run the container with required capabilities:"
echo "  ./docker/run.sh ${IMAGE_NAME}"
echo ""
echo "Or manually:"
echo "  docker run -it --cap-add=NET_RAW --cap-add=NET_ADMIN --cap-add=SYS_PTRACE ${IMAGE_NAME}"
echo ""
echo "To use this image with the local sandbox client:"
echo "  pnpm local-sandbox --token YOUR_TOKEN --image ${IMAGE_NAME}"
