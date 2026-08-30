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
archive_dir=""
example_env_dir="$(mktemp -d)"
cp .env.example "$example_env_dir/.env"
cmp -s .env.example "$example_env_dir/.env"

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
    docker compose --env-file "$example_env_dir/.env" -p "$compose_project" "$@"
}

assert_schema_ready() {
  local target_container="$1"
  local database_path="$2"

  docker exec \
    -e PORCHFEST_SCHEMA_PROBE_PATH="$database_path" \
    "$target_container" \
    node --import tsx --input-type=module -e '
      const { default: Database } = await import("better-sqlite3");
      const { schemaTableDefinitions, schemaTableNames } = await import(
        "./packages/core/src/storage/schema.ts"
      );
      const database = new Database(process.env.PORCHFEST_SCHEMA_PROBE_PATH, {
        readonly: true,
      });
      const actual = new Set(
        database
          .prepare("select name from sqlite_master where type = ?")
          .all("table")
          .map(({ name }) => name),
      );
      const malformed = schemaTableDefinitions.flatMap((table) => {
        if (!actual.has(table.name)) {
          return [];
        }
        const actualColumns = database
          .prepare("select name from pragma_table_info(?) order by name")
          .all(table.name)
          .map(({ name }) => name);
        if (
          actualColumns.length === table.columns.length &&
          actualColumns.every((name, index) => name === table.columns[index])
        ) {
          return [];
        }
        return [{
          name: table.name,
          expected: table.columns,
          actual: actualColumns,
        }];
      });
      database.close();
      const missing = schemaTableNames.filter((name) => !actual.has(name));
      if (missing.length > 0) {
        console.error(`Missing migrated tables: ${missing.join(", ")}`);
        process.exit(1);
      }
      if (malformed.length > 0) {
        for (const table of malformed) {
          console.error(
            `Malformed migrated table ${table.name}: expected columns ${table.expected.join(", ")}; actual columns ${table.actual.join(", ")}`,
          );
        }
        process.exit(1);
      }
    '
}

cleanup() {
  if [[ -n "$tls_response_file" ]]; then
    rm -f -- "$tls_response_file"
  fi
  if [[ -n "$archive_dir" ]]; then
    rm -rf -- "$archive_dir"
  fi
  rm -rf -- "$example_env_dir"
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
assert_schema_ready "$container" "/data/porchfest.db"

empty_database="/tmp/porchfest-deliberately-empty.db"
docker exec \
  -e PORCHFEST_EMPTY_DATABASE_PATH="$empty_database" \
  "$container" \
  node -e '
    const Database = require("better-sqlite3");
    new Database(process.env.PORCHFEST_EMPTY_DATABASE_PATH).close();
  '
expected_empty_database_error="$(
  docker exec "$container" \
    node --import tsx --input-type=module -e '
      const { schemaTableNames } = await import(
        "./packages/core/src/storage/schema.ts"
      );
      console.log(`Missing migrated tables: ${schemaTableNames.join(", ")}`);
    '
)"
empty_database_probe_output=""
if empty_database_probe_output="$(assert_schema_ready "$container" "$empty_database" 2>&1)"; then
  echo "ERROR: schema readiness probe accepted an empty database" >&2
  exit 1
fi
if [[ "$empty_database_probe_output" != *"$expected_empty_database_error"* ]]; then
  echo "ERROR: schema readiness probe failed for a non-schema reason while checking an empty database" >&2
  echo "Probe output:" >&2
  printf '%s\n' "$empty_database_probe_output" >&2
  exit 1
fi
printf '%s\n' "$empty_database_probe_output"

malformed_database="/tmp/porchfest-deliberately-malformed.db"
docker exec "$container" cp "/data/porchfest.db" "$malformed_database"
malformed_database_original_sha="$(
  docker exec "$container" sha256sum "$malformed_database" | cut -d ' ' -f 1
)"
docker exec \
  -e PORCHFEST_MALFORMED_DATABASE_PATH="$malformed_database" \
  "$container" \
  node -e '
    const Database = require("better-sqlite3");
    const database = new Database(
      process.env.PORCHFEST_MALFORMED_DATABASE_PATH,
    );
    database.pragma("foreign_keys = OFF");
    database.exec(
      "alter table acts rename to acts_original; create table acts (id integer)",
    );
    database.close();
  '
malformed_database_mutated_sha="$(
  docker exec "$container" sha256sum "$malformed_database" | cut -d ' ' -f 1
)"
malformed_database_probe_output=""
if malformed_database_probe_output="$(
  assert_schema_ready "$container" "$malformed_database" 2>&1
)"; then
  echo "ERROR: schema readiness probe accepted a malformed database" >&2
  exit 1
fi
if [[ "$malformed_database_probe_output" != *"Malformed migrated table acts:"* ]]; then
  echo "ERROR: schema readiness probe failed for a non-shape reason while checking a malformed database" >&2
  echo "Probe output:" >&2
  printf '%s\n' "$malformed_database_probe_output" >&2
  exit 1
fi
printf '%s\n' "$malformed_database_probe_output"
docker exec "$container" cp "/data/porchfest.db" "$malformed_database"
malformed_database_restored_sha="$(
  docker exec "$container" sha256sum "$malformed_database" | cut -d ' ' -f 1
)"
if [[ "$malformed_database_restored_sha" != "$malformed_database_original_sha" ]]; then
  echo "ERROR: malformed schema fixture was not restored byte-identically" >&2
  echo "Original SHA-256: $malformed_database_original_sha" >&2
  echo "Mutated SHA-256: $malformed_database_mutated_sha" >&2
  echo "Restored SHA-256: $malformed_database_restored_sha" >&2
  exit 1
fi
echo "OK: malformed table shape rejected and fixture restored byte-identically ($malformed_database_restored_sha)"

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

echo "OK: container migrates an empty data volume, contains all workspaces, and serves TLS health"
echo "OK: .env.example copied verbatim boots the reference Caddy topology"

archive_dir="$(mktemp -d)"
export PORCHFEST_COMPOSE_PROJECT="$compose_project"
export PORCHFEST_APP_IMAGE="$image"
export PORCHFEST_DATA_VOLUME="$data_volume"
export PORCHFEST_CADDY_DATA_VOLUME="$caddy_data_volume"
export PORCHFEST_CADDY_CONFIG_VOLUME="$caddy_config_volume"
export PORCHFEST_ARCHIVE_DIR="$archive_dir"
export PUBLIC_BASE_URL=
bash scripts/restore-rehearsal.sh
rm -rf -- "$archive_dir"
archive_dir=""
