#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${1:-}"
HOST_OUT_DIR="${2:-$ROOT/tmp/visual-checks}"
CONTAINER_OUT_DIR="/work/tmp/visual-checks"
IMAGE="${PLAYWRIGHT_DOCKER_IMAGE:-mcr.microsoft.com/playwright:v1.57.0-noble}"

mkdir -p "$HOST_OUT_DIR"

docker run --rm \
  --network host \
  --user "$(id -u):$(id -g)" \
  -e VISUAL_CHECK_THEME="${VISUAL_CHECK_THEME:-}" \
  -v "$ROOT:/work" \
  -w /work \
  "$IMAGE" \
  node /work/scripts/visual-check.mjs "$URL" "$CONTAINER_OUT_DIR"
