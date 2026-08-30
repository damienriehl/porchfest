#!/usr/bin/env bash

# Shared, deliberately small deployment primitives. Callers must enable
# `set -euo pipefail` before sourcing this file.

deploy_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_dir="$(cd -- "$deploy_dir/.." && pwd -P)"
readonly COUNT_TABLES="seasons venues acts contacts assignments outbox_messages"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "$name must be set"
  case "${!name}" in
    *$'\n'* | *$'\r'* | *$'\t'*) die "$name contains unsupported whitespace" ;;
  esac
}

load_dotenv_if_present() {
  local dotenv_path="${1:-$project_dir/.env}"
  [[ -f "$dotenv_path" ]] || return 0

  local line key value quote
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] \
      || die "unsupported .env line (expected KEY=VALUE)"
    key="${BASH_REMATCH[2]}"

    case "$key" in
      PUBLIC_BASE_URL | PORCHFEST_APP_IMAGE | PORCHFEST_ARCHIVE_DIR | PORCHFEST_ARCHIVE_KEEP | \
        PORCHFEST_BACKUP_AGE_RECIPIENT | PORCHFEST_BACKUP_KEEP | PORCHFEST_BACKUP_REMOTE | \
        PORCHFEST_COMPOSE_PROJECT | PORCHFEST_DATA_VOLUME | PORCHFEST_DEPLOY_DIR | \
        PORCHFEST_DEPLOY_HOST | PORCHFEST_DEPLOY_OFFSITE | PORCHFEST_DEPLOY_ORGANIZER_SELECTOR | \
        PORCHFEST_EXTERNAL_CONNECT_TIMEOUT | PORCHFEST_EXTERNAL_MAX_TIME | PORCHFEST_HEALTH_ATTEMPTS | \
        PORCHFEST_RESTORE_IDENTITY | PORCHFEST_RESTORE_PROJECT | PORCHFEST_RESTORE_VOLUME | \
        PORCHFEST_UTILITY_IMAGE)
        ;;
      *) continue ;;
    esac
    [[ -z "${!key+x}" ]] || continue

    value="${BASH_REMATCH[3]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"* || "$value" == \'* ]]; then
      quote="${value:0:1}"
      if [[ "$quote" == '"' && "$value" =~ ^\"([^\"]*)\"[[:space:]]*(#.*)?$ ]]; then
        value="${BASH_REMATCH[1]}"
      elif [[ "$quote" == "'" && "$value" =~ ^\'([^\']*)\'[[:space:]]*(#.*)?$ ]]; then
        value="${BASH_REMATCH[1]}"
      else
        die "unclosed quote or unsupported text after quoted value for $key in .env"
      fi
    elif [[ "$value" =~ ^(.*[^[:space:]])[[:space:]]+#.*$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    printf -v "$key" '%s' "$value"
    export "$key"
  done <"$dotenv_path"
}

init_deploy_config() {
  require_value PORCHFEST_COMPOSE_PROJECT
  require_value PORCHFEST_DATA_VOLUME
  require_value PORCHFEST_APP_IMAGE

  compose_project="$PORCHFEST_COMPOSE_PROJECT"
  data_volume="$PORCHFEST_DATA_VOLUME"
  app_image="$PORCHFEST_APP_IMAGE"
  archive_dir="${PORCHFEST_ARCHIVE_DIR:-/var/backups/porchfest}"
  archive_keep="${PORCHFEST_ARCHIVE_KEEP:-7}"
  backup_keep="${PORCHFEST_BACKUP_KEEP:-30}"
  utility_image="${PORCHFEST_UTILITY_IMAGE:-alpine:3.22}"

  [[ "$archive_keep" =~ ^[1-9][0-9]*$ ]] || die "PORCHFEST_ARCHIVE_KEEP must be a positive integer"
  [[ "$backup_keep" =~ ^[1-9][0-9]*$ ]] || die "PORCHFEST_BACKUP_KEEP must be a positive integer"
  [[ "$data_volume" != *'${'* && "$data_volume" != *'$('* ]] || die "PORCHFEST_DATA_VOLUME must be a literal name"
  [[ "$app_image" != *@* ]] || die "PORCHFEST_APP_IMAGE must be a taggable image reference, not a digest"
}

compose() {
  (
    cd -- "$project_dir"
    docker compose -p "$compose_project" "$@"
  )
}

app_container_id() {
  local container
  container="$(compose ps -q app)"
  [[ -n "$container" ]] || die "the app service is not running for compose project $compose_project"
  printf '%s\n' "$container"
}

assert_pinned_volume() {
  local container mounted
  container="$(app_container_id)"
  mounted="$(
    docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container"
  )"
  [[ -n "$mounted" ]] || die "the running app has no named volume mounted at /data"
  [[ "$mounted" == "$data_volume" ]] || die "running /data volume is $mounted, not configured literal $data_volume"
  docker volume inspect "$data_volume" >/dev/null
}

wait_for_container_health() {
  local container="$1"
  local attempts="${2:-90}"
  local status=""
  local _
  for _ in $(seq 1 "$attempts"); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    case "$status" in
      healthy) return 0 ;;
      exited | dead | unhealthy) die "container failed health check (status: $status)" ;;
    esac
    sleep 1
  done
  die "container did not become healthy (last status: ${status:-unknown})"
}

wait_for_app_health() {
  wait_for_container_health "$(app_container_id)" "${PORCHFEST_HEALTH_ATTEMPTS:-90}"
}

image_tag_ref() {
  local image="$1"
  local tag="$2"
  local prefix final repository
  final="${image##*/}"
  if [[ "$image" == */* ]]; then
    prefix="${image%/*}/"
  else
    prefix=""
  fi
  repository="${prefix}${final%%:*}"
  printf '%s:%s\n' "$repository" "$tag"
}

rollback_image_ref() {
  image_tag_ref "$app_image" "prev-${compose_project}"
}

image_id() {
  docker image inspect --format '{{.Id}}' "$1"
}

image_tags() {
  docker image inspect --format '{{join .RepoTags ","}}' "$1"
}

git_commit() {
  if [[ -n "${PORCHFEST_DEPLOY_COMMIT:-}" ]]; then
    printf '%s\n' "$PORCHFEST_DEPLOY_COMMIT"
  else
    git -C "$project_dir" rev-parse HEAD 2>/dev/null || printf 'unavailable\n'
  fi
}

image_schema_entry() {
  local image="$1"
  docker run --rm --entrypoint node "$image" -e '
    const journal = require("/app/packages/core/drizzle/meta/_journal.json");
    const entry = journal.entries.at(-1);
    if (!entry) process.exit(2);
    process.stdout.write(`${entry.when}\t${entry.tag}\t${entry.idx}\n`);
  '
}

volume_sqlite() {
  local sql="$1"
  docker run --rm --read-only \
    --volume "$data_volume:/data:ro" \
    --env PORCHFEST_SQL="$sql" \
    --entrypoint node \
    "$app_image" \
    -e '
      const Database = require("better-sqlite3");
      const database = new Database("/data/porchfest.db", {
        readonly: true,
        fileMustExist: true,
      });
      try {
        for (const row of database.prepare(process.env.PORCHFEST_SQL).all()) {
          const values = Object.values(row);
          if (values.length !== 1) process.exit(2);
          process.stdout.write(`${values[0]}\n`);
        }
      } finally {
        database.close();
      }
    '
}

volume_integrity() {
  local result
  result="$(volume_sqlite 'PRAGMA integrity_check;')"
  [[ "$result" == "ok" ]] || die "SQLite integrity_check failed"
  printf '%s\n' "$result"
}

volume_counts() {
  local counts table count
  counts="$(volume_sqlite '
    SELECT "seasons=" || count(*) FROM seasons
    UNION ALL SELECT "venues=" || count(*) FROM venues
    UNION ALL SELECT "acts=" || count(*) FROM acts
    UNION ALL SELECT "contacts=" || count(*) FROM contacts
    UNION ALL SELECT "assignments=" || count(*) FROM assignments
    UNION ALL SELECT "outbox_messages=" || count(*) FROM outbox_messages;
  ')"
  for table in seasons venues acts contacts assignments outbox_messages; do
    count="$(count_value "$counts" "$table")"
    [[ "$count" =~ ^[0-9]+$ ]] || die "invalid count returned for $table"
  done
  printf '%s\n' "$counts"
}

volume_schema_when() {
  local value
  value="$(volume_sqlite 'SELECT coalesce(max(created_at), 0) FROM __drizzle_migrations;')"
  [[ "$value" =~ ^[0-9]+$ ]] || die "invalid __drizzle_migrations timestamp"
  printf '%s\n' "$value"
}

count_value() {
  local counts="$1"
  local key="$2"
  sed -n "s/^${key}=//p" <<<"$counts"
}

json_extract() {
  local path="$1"
  local operation="$2"
  local key="${3:-}"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    document = json.load(source)
operation = sys.argv[2]
key = sys.argv[3]
if operation == "counts":
    counts = document["counts"]
    for table in ("seasons", "venues", "acts", "contacts", "assignments", "outbox_messages"):
        value = counts[table]
        if type(value) is not int or value < 0:
            raise ValueError(f"invalid count: {table}")
        print(f"{table}={value}")
else:
    value = document
    for component in key.split("."):
        value = value[component]
    if operation == "number":
        if type(value) is not int or value < 0:
            raise ValueError(f"invalid non-negative integer: {key}")
    elif operation == "string":
        if not isinstance(value, str) or "\n" in value or "\r" in value:
            raise ValueError(f"invalid string: {key}")
    else:
        raise ValueError(f"unknown operation: {operation}")
    print(value)
' "$path" "$operation" "$key"
    return
  fi

  local evidence_dir evidence_name
  evidence_dir="$(cd -- "$(dirname -- "$path")" && pwd -P)"
  evidence_name="$(basename -- "$path")"
  docker run --rm --read-only \
    --volume "$evidence_dir:/evidence:ro" \
    --entrypoint node \
    "$app_image" \
    -e '
      const fs = require("node:fs");
      const document = JSON.parse(fs.readFileSync(`/evidence/${process.argv[1]}`, "utf8"));
      const operation = process.argv[2];
      const key = process.argv[3];
      if (operation === "counts") {
        for (const table of ["seasons", "venues", "acts", "contacts", "assignments", "outbox_messages"]) {
          const value = document.counts?.[table];
          if (!Number.isSafeInteger(value) || value < 0) process.exit(2);
          process.stdout.write(`${table}=${value}\n`);
        }
      } else {
        let value = document;
        for (const component of key.split(".")) value = value?.[component];
        if (operation === "number" && (!Number.isSafeInteger(value) || value < 0)) process.exit(2);
        if (operation === "string" && (typeof value !== "string" || /[\r\n]/.test(value))) process.exit(2);
        if (operation !== "number" && operation !== "string") process.exit(2);
        process.stdout.write(`${value}\n`);
      }
    ' "$evidence_name" "$operation" "$key"
}

counts_from_json() {
  local path="$1"
  local counts table count
  counts="$(json_extract "$path" counts)" || die "archive metadata counts are not valid JSON values"
  for table in $COUNT_TABLES; do
    count="$(count_value "$counts" "$table")"
    [[ "$count" =~ ^[0-9]+$ ]] || die "archive metadata has no valid $table count"
  done
  printf '%s\n' "$counts"
}

json_escape() {
  sed 's/\\/\\\\/g; s/"/\\"/g' <<<"$1" | tr -d '\r\n'
}

write_evidence_json() {
  local path="$1"
  local stage="$2"
  local integrity="$3"
  local counts="$4"
  local archive_path="${5:-}"
  local archive_sha="${6:-}"
  local archive_mode="${7:-}"
  local schema_when="${8:-0}"
  local schema_tag="${9:-unknown}"
  local tmp="${path}.tmp.$$"
  local current_id prev_ref prev_id tags
  current_id="$(image_id "$app_image")"
  prev_ref="$(rollback_image_ref)"
  prev_id="$(image_id "$prev_ref" 2>/dev/null || printf 'unavailable')"
  tags="$(image_tags "$current_id")"
  mkdir -p -- "$(dirname -- "$path")"
  umask 077
  {
    printf '{\n'
    printf '  "format": "porchfest-deploy-evidence/v1",\n'
    printf '  "stage": "%s",\n' "$(json_escape "$stage")"
    printf '  "created_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "commit": "%s",\n' "$(json_escape "$(git_commit)")"
    printf '  "image": "%s",\n' "$(json_escape "$app_image")"
    printf '  "image_id": "%s",\n' "$(json_escape "$current_id")"
    printf '  "previous_image": "%s",\n' "$(json_escape "$prev_ref")"
    printf '  "previous_image_id": "%s",\n' "$(json_escape "$prev_id")"
    printf '  "volume": "%s",\n' "$(json_escape "$data_volume")"
    printf '  "integrity": "%s",\n' "$(json_escape "$integrity")"
    printf '  "counts": {\n'
    printf '    "seasons": %s,\n' "$(count_value "$counts" seasons)"
    printf '    "venues": %s,\n' "$(count_value "$counts" venues)"
    printf '    "acts": %s,\n' "$(count_value "$counts" acts)"
    printf '    "contacts": %s,\n' "$(count_value "$counts" contacts)"
    printf '    "assignments": %s,\n' "$(count_value "$counts" assignments)"
    printf '    "outbox_messages": %s\n' "$(count_value "$counts" outbox_messages)"
    printf '  },\n'
    printf '  "schema": {"when": %s, "tag": "%s"},\n' "$schema_when" "$(json_escape "$schema_tag")"
    printf '  "archive": {"path": "%s", "sha256": "%s", "mode": "%s"},\n' \
      "$(json_escape "$archive_path")" "$(json_escape "$archive_sha")" "$(json_escape "$archive_mode")"
    printf '  "tags": "%s"\n' "$(json_escape "$tags")"
    printf '}\n'
  } >"$tmp"
  chmod 0600 "$tmp"
  mv -f -- "$tmp" "$path"
}

json_number() {
  local path="$1"
  local key="$2"
  json_extract "$path" number "$key" || die "archive metadata has no valid $key number"
}

json_string() {
  local path="$1"
  local key="$2"
  json_extract "$path" string "$key" || die "archive metadata has no valid $key string"
}

assert_counts_match_json() {
  local expected="$1"
  local actual="$2"
  local expected_counts table wanted got
  expected_counts="$(counts_from_json "$expected")"
  for table in $COUNT_TABLES; do
    wanted="$(count_value "$expected_counts" "$table")"
    got="$(count_value "$actual" "$table")"
    [[ "$got" =~ ^[0-9]+$ ]] || die "row count is invalid for $table (got ${got:-missing})"
    if [[ "$table" == seasons ]]; then
      [[ "$wanted" == "$got" ]] || die "row count mismatch for seasons (expected $wanted, got $got)"
    else
      ((got >= wanted)) || die "row count decreased for $table (baseline $wanted, got $got)"
      if ((got > wanted)); then
        printf '+%s %s during the window\n' "$((got - wanted))" "$table"
      fi
    fi
  done
}

assert_counts_equal_json() {
  local expected="$1"
  local actual="$2"
  local expected_counts table wanted got
  expected_counts="$(counts_from_json "$expected")"
  for table in $COUNT_TABLES; do
    wanted="$(count_value "$expected_counts" "$table")"
    got="$(count_value "$actual" "$table")"
    [[ -n "$wanted" && "$wanted" == "$got" ]] \
      || die "row count mismatch for $table (expected ${wanted:-missing}, got ${got:-missing})"
  done
}

ensure_archive_dir_safe() {
  require_command tar
  mkdir -p -- "$archive_dir"
  local resolved_archive resolved_project
  resolved_archive="$(cd -- "$archive_dir" && pwd -P)"
  resolved_project="$project_dir"
  case "$resolved_archive/" in
    "$resolved_project/"*) die "PORCHFEST_ARCHIVE_DIR must be outside the compose project directory" ;;
  esac
  [[ -w "$resolved_archive" ]] || die "archive directory is not writable by the deploy user: $resolved_archive"
  archive_dir="$resolved_archive"
}

newest_archive() {
  find "$archive_dir" -maxdepth 1 -type f -name 'porchfest-*.tar.gz' -printf '%T@\t%p\n' \
    | sort -nr \
    | head -n 1 \
    | cut -f 2-
}

archive_metadata_path() {
  printf '%s.json\n' "$1"
}

archive_sha_path() {
  printf '%s.sha256\n' "$1"
}

verify_archive_sha() {
  local archive="$1"
  local sidecar
  sidecar="$(archive_sha_path "$archive")"
  [[ -f "$sidecar" ]] || die "archive SHA-256 sidecar is missing: $sidecar"
  local expected actual
  expected="$(cut -d ' ' -f 1 "$sidecar")"
  actual="$(sha256sum "$archive" | cut -d ' ' -f 1)"
  [[ "$expected" == "$actual" ]] || die "archive SHA-256 does not match its sidecar"
  printf '%s\n' "$actual"
}

restore_archive_into_fresh_volume() {
  local archive="$1"
  local target_volume="$2"
  docker volume inspect "$target_volume" >/dev/null 2>&1 && die "restore target volume already exists: $target_volume"
  docker volume create "$target_volume" >/dev/null
  if ! docker run --rm \
    --volume "$target_volume:/restore" \
    --volume "$(dirname -- "$archive"):/backup:ro" \
    "$utility_image" \
    sh -ceu 'tar -xzf "/backup/$1" -C /restore' sh "$(basename -- "$archive")"; then
    docker volume rm "$target_volume" >/dev/null 2>&1 || true
    die "archive extraction failed"
  fi
}

print_evidence_block() {
  local integrity="$1"
  local counts="$2"
  local archive_path="${3:-none}"
  local archive_sha="${4:-none}"
  local archive_mode="${5:-none}"
  local prev_ref
  prev_ref="$(rollback_image_ref)"
  printf '%s\n' '--- PORCHFEST DEPLOY EVIDENCE ---'
  printf 'commit=%s\n' "$(git_commit)"
  printf 'image_id=%s\n' "$(image_id "$app_image")"
  printf 'volume=%s\n' "$data_volume"
  printf 'integrity=%s\n' "$integrity"
  while IFS= read -r line; do printf 'count_%s\n' "$line"; done <<<"$counts"
  printf 'archive_path=%s\n' "$archive_path"
  printf 'archive_sha256=%s\n' "$archive_sha"
  printf 'archive_mode=%s\n' "$archive_mode"
  printf 'tags=%s\n' "$(image_tags "$(image_id "$app_image")")"
  printf 'rollback_tag=%s\n' "$prev_ref"
  printf '%s\n' '--- END PORCHFEST DEPLOY EVIDENCE ---'
}
