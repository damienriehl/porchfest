#!/usr/bin/env bash
set -euo pipefail

image="porchfest-ci"
container="porchfest-empty-config-smoke-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker compose down >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -t "$image" .

# No --env or --env-file flags: this proves the image's unconfigured boot path.
docker run -d --name "$container" -p 127.0.0.1::9398 "$image" >/dev/null
port="$(docker port "$container" 9398/tcp | sed -n 's/.*://p')"

for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${port}/health" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent "http://127.0.0.1:${port}/health" | grep -q '"ok":true'

docker run --rm --entrypoint node "$image" -e \
  "const fs=require('node:fs');const p=['core','web','email','antibot','geo'];if(p.some(x=>!fs.existsSync('/app/packages/'+x)))process.exit(1)"

node scripts/clean-room-scan.mjs --image "$image"

docker rm -f "$container" >/dev/null
docker compose up -d --no-build
for _ in $(seq 1 45); do
  if curl --fail --silent --insecure https://localhost/health >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --insecure https://localhost/health | grep -q '"ok":true'

echo "OK: container boots empty, contains all workspaces, and serves TLS health"
