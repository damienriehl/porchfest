#!/usr/bin/env bash
set -euo pipefail

run_id="$(date -u +%Y%m%d%H%M%S)-$$"
compose_project="porchfest-smoke-${run_id}"
image="porchfest-ci:${run_id}"
container="porchfest-empty-config-smoke-${run_id}"
data_volume="${compose_project}-data"
caddy_data_volume="${compose_project}-caddy-data"
caddy_config_volume="${compose_project}-caddy-config"
tls_response_file=""

compose() {
  env \
    PORCHFEST_COMPOSE_PROJECT="$compose_project" \
    PORCHFEST_APP_IMAGE="$image" \
    PORCHFEST_DATA_VOLUME="$data_volume" \
    PORCHFEST_CADDY_DATA_VOLUME="$caddy_data_volume" \
    PORCHFEST_CADDY_CONFIG_VOLUME="$caddy_config_volume" \
    PORCHFEST_HTTP_PORT_MAPPING="127.0.0.1::80" \
    PORCHFEST_HTTPS_PORT_MAPPING="127.0.0.1::443" \
    PUBLIC_BASE_URL= \
    PORCHFEST_SESSION_SECRET= \
    docker compose -p "$compose_project" "$@"
}

cleanup() {
  if [[ -n "$tls_response_file" ]]; then
    rm -f -- "$tls_response_file"
  fi
  docker rm -fv "$container" >/dev/null 2>&1 || true
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ "$compose_project" == "porchfest-reference" || \
      "$data_volume" == "porchfest-data" || \
      "$caddy_data_volume" == "porchfest-caddy-data" || \
      "$caddy_config_volume" == "porchfest-caddy-config" ]]; then
  echo "ERROR: container smoke resources must not use reference deployment names" >&2
  exit 1
fi

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

docker rm -fv "$container" >/dev/null
compose up -d --no-build
tls_port="$(compose port caddy 443 | sed -n 's/.*://p')"
tls_resolve="localhost:${tls_port}:127.0.0.1"
tls_url="https://localhost:${tls_port}/health"
for _ in $(seq 1 45); do
  if curl --fail --silent --insecure --resolve "$tls_resolve" "$tls_url" >/dev/null; then
    break
  fi
  sleep 1
done

tls_response_file="$(mktemp)"
tls_curl_status=0
if tls_http_code="$(
  curl \
    --silent \
    --show-error \
    --insecure \
    --resolve "$tls_resolve" \
    --output "$tls_response_file" \
    --write-out '%{http_code}' \
    "$tls_url"
)"; then
  :
else
  tls_curl_status=$?
fi

if ((tls_curl_status != 0)) || \
  [[ ! "$tls_http_code" =~ ^2[0-9][0-9]$ ]] || \
  ! grep -q '"ok":true' "$tls_response_file"; then
  echo "ERROR: TLS health probe failed for $tls_url" >&2
  echo "HTTP code: ${tls_http_code:-000}" >&2
  echo "Response body:" >&2
  cat "$tls_response_file" >&2
  echo "Caddy logs:" >&2
  compose logs caddy >&2 || true
  exit 1
fi

echo "OK: container boots empty, contains all workspaces, and serves TLS health"
