#!/usr/bin/env bash
# Build the image, run it, and check that key URLs respond. Usage: smoke_test.sh [image] [port]
set -euo pipefail

IMAGE="${1:-study-cards:test}"
PORT="${2:-8089}"
NAME="study-cards-smoke-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker build -t "$IMAGE" .
docker run -d --name "$NAME" -p "$PORT:80" "$IMAGE" >/dev/null

for i in $(seq 1 20); do
  curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null && break
  sleep 1
  [ "$i" -eq 20 ] && { echo "health check never passed"; docker logs "$NAME"; exit 1; }
done

for path in / /css/style.css /js/app.js /js/scheduler.js /data/gate-me-2026-deck.txt; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$path")
  [ "$code" = "200" ] || { echo "FAIL $path -> $code"; exit 1; }
  echo "OK   $path"
done
echo "Smoke test passed"
