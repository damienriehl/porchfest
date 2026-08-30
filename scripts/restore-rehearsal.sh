#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_dir="$(cd -- "$script_dir/.." && pwd -P)"
# shellcheck source=deploy/common.sh
source "$project_dir/deploy/common.sh"

required=(
  PORCHFEST_COMPOSE_PROJECT
  PORCHFEST_APP_IMAGE
  PORCHFEST_DATA_VOLUME
  PORCHFEST_CADDY_DATA_VOLUME
  PORCHFEST_CADDY_CONFIG_VOLUME
  PORCHFEST_ARCHIVE_DIR
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || {
    printf 'ERROR: %s must be set for restore rehearsal\n' "$name" >&2
    exit 1
  }
done

restore_volume="${PORCHFEST_DATA_VOLUME}-rehearsal"
restore_project="${PORCHFEST_COMPOSE_PROJECT}-rehearsal"
prev_image="$(image_tag_ref "$PORCHFEST_APP_IMAGE" "prev-${PORCHFEST_COMPOSE_PROJECT}")"
previous_fixture_project="${PORCHFEST_COMPOSE_PROJECT}-previous-fixture"
previous_fixture_volume="${PORCHFEST_DATA_VOLUME}-previous-fixture"
previous_image_container="${PORCHFEST_COMPOSE_PROJECT}-previous-image"
fake_dir=""

cleanup() {
  docker compose -p "$previous_fixture_project" -f "$project_dir/compose.yaml" \
    down --remove-orphans >/dev/null 2>&1 || true
  docker compose -p "$restore_project" -f "$project_dir/compose.yaml" \
    down --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$previous_image_container" >/dev/null 2>&1 || true
  docker volume rm "$previous_fixture_volume" >/dev/null 2>&1 || true
  docker volume rm "$restore_volume" >/dev/null 2>&1 || true
  docker image rm "$prev_image" >/dev/null 2>&1 || true
  if [[ -n "$fake_dir" ]]; then
    rm -rf -- "$fake_dir"
  fi
}
trap cleanup EXIT

app_container="$(
  docker compose -p "$PORCHFEST_COMPOSE_PROJECT" -f "$project_dir/compose.yaml" ps -q app
)"
[[ -n "$app_container" ]] || {
  printf 'ERROR: restore rehearsal needs the smoke app to be running\n' >&2
  exit 1
}

docker exec "$app_container" node -e '
  const Database = require("better-sqlite3");
  const db = new Database("/data/porchfest.db");
  db.prepare(`insert into seasons
    (year, display_name, state, timezone, event_city, event_state, version, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch())`)
    .run(2099, "Restore rehearsal", "setup", "UTC", "Example", "EX");
  db.close();
'

export PORCHFEST_UTILITY_IMAGE="${PORCHFEST_UTILITY_IMAGE:-alpine:3.22}"
export PORCHFEST_ARCHIVE_KEEP=2

fake_dir="$(mktemp -d)"
dotenv_probe="$fake_dir/dotenv-probe"
printf 'PORCHFEST_DEPLOY_HOST=$(touch %s)\n' "$dotenv_probe" >"$fake_dir/test.env"
dotenv_expected="\$(touch $dotenv_probe)"
(
  unset PORCHFEST_DEPLOY_HOST
  load_dotenv_if_present "$fake_dir/test.env"
  [[ "$PORCHFEST_DEPLOY_HOST" == "$dotenv_expected" ]]
)
[[ ! -e "$dotenv_probe" ]] || {
  printf 'ERROR: dotenv parser executed shell syntax\n' >&2
  exit 1
}
echo "OK: deploy dotenv parsing preserves literal values without shell evaluation"

"$project_dir/deploy/preflight.sh" >/dev/null
"$project_dir/deploy/archive.sh" >/dev/null
no_restart_output="$fake_dir/no-restart-output.txt"
archive_result="$fake_dir/archive-result.txt"
PORCHFEST_ARCHIVE_RESULT_FILE="$archive_result" \
  "$project_dir/deploy/archive.sh" --no-restart >"$no_restart_output"
grep -Fxq 'archive_app_state=stopped' "$no_restart_output"
stopped_state="$(docker inspect --format '{{.State.Status}}' "$app_container")"
[[ "$stopped_state" == exited ]] || {
  printf 'ERROR: --no-restart archive left app in state %s\n' "$stopped_state" >&2
  exit 1
}
docker compose -p "$PORCHFEST_COMPOSE_PROJECT" -f "$project_dir/compose.yaml" start app >/dev/null
wait_for_container_health "$app_container"
archive_dir="$PORCHFEST_ARCHIVE_DIR"
archive="$(archive_from_result_file "$archive_result")"
[[ -n "$archive" ]] || {
  printf 'ERROR: archive rehearsal produced no archive\n' >&2
  exit 1
}

PORCHFEST_RESTORE_VOLUME="$restore_volume" \
  PORCHFEST_RESTORE_PROJECT="$restore_project" \
  "$project_dir/deploy/restore.sh" "$archive" | grep '^restore_result=PASS$' >/dev/null
if docker network inspect "${restore_project}_default" >/dev/null 2>&1; then
  printf 'ERROR: restore rehearsal leaked its default network\n' >&2
  exit 1
fi

external_proxy_config="$fake_dir/external-proxy-config.yaml"
PORCHFEST_PROXY_NETWORK=porchfest-proxy-test \
  PORCHFEST_DOMAIN=porchfest.example \
  PORCHFEST_TLS_RESOLVER=testresolver \
  docker compose \
    -f "$project_dir/compose.yaml" \
    -f "$project_dir/deploy/compose.external-proxy.yaml" \
    config >"$external_proxy_config"
for expected_label in \
  "traefik.http.routers.${PORCHFEST_COMPOSE_PROJECT}-http.entrypoints: http" \
  "traefik.http.routers.${PORCHFEST_COMPOSE_PROJECT}-http.middlewares: ${PORCHFEST_COMPOSE_PROJECT}-https-redirect" \
  "traefik.http.middlewares.${PORCHFEST_COMPOSE_PROJECT}-https-redirect.redirectscheme.scheme: https" \
  "traefik.http.routers.${PORCHFEST_COMPOSE_PROJECT}-https.entrypoints: https" \
  "traefik.http.routers.${PORCHFEST_COMPOSE_PROJECT}-https.service: ${PORCHFEST_COMPOSE_PROJECT}" \
  "traefik.http.services.${PORCHFEST_COMPOSE_PROJECT}.loadbalancer.server.port: \"9398\""; do
  grep -Fq "$expected_label" "$external_proxy_config" || {
    printf 'ERROR: external-proxy Compose omitted project-scoped label: %s\n' \
      "$expected_label" >&2
    exit 1
  }
done

before_rollback_container="$(docker compose -p "$PORCHFEST_COMPOSE_PROJECT" -f "$project_dir/compose.yaml" ps -q app)"
"$project_dir/deploy/rollback.sh" | grep '^rollback_path=image-only$' >/dev/null
after_rollback_container="$(docker compose -p "$PORCHFEST_COMPOSE_PROJECT" -f "$project_dir/compose.yaml" ps -q app)"
[[ -n "$after_rollback_container" && "$after_rollback_container" != "$before_rollback_container" ]] || {
  printf 'ERROR: image-only rollback did not recreate the app container\n' >&2
  exit 1
}

docker image rm "$prev_image" >/dev/null
previous_journal="$fake_dir/previous-journal.json"
docker create --name "$previous_image_container" "$PORCHFEST_APP_IMAGE" >/dev/null
docker cp \
  "$previous_image_container:/app/packages/core/drizzle/meta/_journal.json" \
  "$previous_journal"
PORCHFEST_PREVIOUS_JOURNAL="$previous_journal" node -e '
  const fs = require("node:fs");
  const path = process.env.PORCHFEST_PREVIOUS_JOURNAL;
  const journal = JSON.parse(fs.readFileSync(path, "utf8"));
  if (journal.entries.length < 2) process.exit(2);
  journal.entries.pop();
  fs.writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`);
'
docker cp \
  "$previous_journal" \
  "$previous_image_container:/app/packages/core/drizzle/meta/_journal.json"
docker commit "$previous_image_container" "$prev_image" >/dev/null
docker rm "$previous_image_container" >/dev/null

env \
  PORCHFEST_COMPOSE_PROJECT="$previous_fixture_project" \
  PORCHFEST_APP_IMAGE="$prev_image" \
  PORCHFEST_DATA_VOLUME="$previous_fixture_volume" \
  PUBLIC_BASE_URL= \
  PORCHFEST_SESSION_SECRET= \
  docker compose -p "$previous_fixture_project" -f "$project_dir/compose.yaml" \
    up -d --no-build app >/dev/null
previous_fixture_container="$(
  docker compose -p "$previous_fixture_project" -f "$project_dir/compose.yaml" ps -q app
)"
wait_for_container_health "$previous_fixture_container"
previous_archive_result="$fake_dir/previous-archive-result.txt"
env \
  PORCHFEST_COMPOSE_PROJECT="$previous_fixture_project" \
  PORCHFEST_APP_IMAGE="$prev_image" \
  PORCHFEST_DATA_VOLUME="$previous_fixture_volume" \
  PORCHFEST_ARCHIVE_DIR="$PORCHFEST_ARCHIVE_DIR" \
  PORCHFEST_ARCHIVE_KEEP=2 \
  PORCHFEST_ARCHIVE_RESULT_FILE="$previous_archive_result" \
  "$project_dir/deploy/archive.sh" --no-restart >/dev/null
[[ -s "$previous_archive_result" ]] || {
  printf 'ERROR: previous-schema fixture produced no rollback archive\n' >&2
  exit 1
}
docker compose -p "$previous_fixture_project" -f "$project_dir/compose.yaml" \
  down --remove-orphans >/dev/null
docker volume rm "$previous_fixture_volume" >/dev/null

real_docker="$(command -v docker)"
tag_failure_shim="$fake_dir/docker"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
  printf '%s\n' 'if [[ "${1:-}" == tag && "${2:-}" == "$PORCHFEST_FAIL_TAG_SOURCE" && "${3:-}" == "$PORCHFEST_FAIL_TAG_TARGET" ]]; then'
  printf '%s\n' '  printf '\''injected docker tag failure\n'\'' >&2'
  printf '%s\n' '  exit 42'
  printf '%s\n' 'fi'
  printf '%s\n' 'exec "$PORCHFEST_REAL_DOCKER" "$@"'
} >"$tag_failure_shim"
chmod +x "$tag_failure_shim"
rollback_failure_output="$fake_dir/rollback-tag-failure.txt"
if PATH="$fake_dir:$PATH" \
  PORCHFEST_REAL_DOCKER="$real_docker" \
  PORCHFEST_FAIL_TAG_SOURCE="$prev_image" \
  PORCHFEST_FAIL_TAG_TARGET="$PORCHFEST_APP_IMAGE" \
  "$project_dir/deploy/rollback.sh" >"$rollback_failure_output" 2>&1; then
  printf 'ERROR: schema-moved rollback reported success after docker tag failed\n' >&2
  exit 1
fi
grep -Fq \
  'rollback step failed (docker tag previous image); restoring the safety archive into the pinned volume' \
  "$rollback_failure_output"
grep -Fq 'safety_archive_restored=' "$rollback_failure_output"
grep -Fq \
  'rollback failed at docker tag previous image; the pre-rollback safety archive was restored automatically and the app was restarted' \
  "$rollback_failure_output"
if grep -Fq 'rollback_result=PASS' "$rollback_failure_output"; then
  printf 'ERROR: failed schema-moved rollback printed rollback_result=PASS\n' >&2
  exit 1
fi
echo "OK: schema-moved rollback stops on docker tag failure and restores its safety archive"

if command -v age-keygen >/dev/null 2>&1 && command -v age >/dev/null 2>&1; then
  identity="$fake_dir/identity.txt"
  key_output="$fake_dir/key-output.txt"
  age-keygen -o "$identity" >"$key_output" 2>&1
  recipient="$(sed -n 's/^Public key: //p' "$key_output")"
  [[ -n "$recipient" ]] || {
    printf 'ERROR: age-keygen did not emit a public recipient\n' >&2
    exit 1
  }
  rclone_log="$fake_dir/rclone.log"
  rclone_state="$fake_dir/rclone-state.txt"
  apply_fake_rclone="$fake_dir/rclone"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
    printf '%s\n' 'printf '\''%q '\'' "$@" >>"$PORCHFEST_FAKE_RCLONE_LOG"'
    printf '%s\n' 'printf '\''\n'\'' >>"$PORCHFEST_FAKE_RCLONE_LOG"'
  printf '%s\n' 'case "${1:-}" in'
    printf '%s\n' '  copy)'
    printf '%s\n' '    while [[ $# -gt 0 ]]; do'
    printf '%s\n' '      if [[ "$1" == "--files-from" ]]; then cat "$2" >>"$PORCHFEST_FAKE_RCLONE_STATE"; break; fi'
    printf '%s\n' '      shift'
    printf '%s\n' '    done'
    printf '%s\n' '    ;;'
    printf '%s\n' '  lsf)'
    printf '%s\n' '    [[ "${PORCHFEST_FAKE_RCLONE_FAIL_LSF:-0}" != 1 ]] || exit 9'
    printf '%s\n' '    test ! -f "$PORCHFEST_FAKE_RCLONE_STATE" || while IFS= read -r path; do printf "1;%s\\n" "$path"; done <"$PORCHFEST_FAKE_RCLONE_STATE"'
    printf '%s\n' '    ;;'
    printf '%s\n' '  deletefile) ;;'
    printf '%s\n' '  *) exit 2 ;;'
    printf '%s\n' 'esac'
  } >"$apply_fake_rclone"
  chmod +x "$apply_fake_rclone"
  : >"$rclone_log"
  : >"$rclone_state"
  missing_output="$fake_dir/missing-output.txt"
  if PORCHFEST_BACKUP_AGE_RECIPIENT= PORCHFEST_BACKUP_REMOTE=porchfest-test-remote:backups \
    "$project_dir/deploy/offsite.sh" >"$missing_output" 2>&1; then
    printf 'ERROR: offsite accepted an empty age recipient\n' >&2
    exit 1
  fi
  grep -q 'PORCHFEST_BACKUP_AGE_RECIPIENT must be set' "$missing_output"
  if PORCHFEST_BACKUP_AGE_RECIPIENT="$recipient" PORCHFEST_BACKUP_REMOTE= \
    "$project_dir/deploy/offsite.sh" >"$missing_output" 2>&1; then
    printf 'ERROR: offsite accepted an empty remote\n' >&2
    exit 1
  fi
  grep -q 'PORCHFEST_BACKUP_REMOTE must be set' "$missing_output"

  PATH="$fake_dir:$PATH" \
    PORCHFEST_FAKE_RCLONE_LOG="$rclone_log" \
    PORCHFEST_FAKE_RCLONE_STATE="$rclone_state" \
    PORCHFEST_BACKUP_AGE_RECIPIENT="$recipient" \
    PORCHFEST_BACKUP_REMOTE=porchfest-test-remote:backups \
    PORCHFEST_BACKUP_KEEP=1 \
    "$project_dir/deploy/offsite.sh" >/dev/null
  grep -q '^copy ' "$rclone_log"
  grep -q '^lsf ' "$rclone_log"
  grep -Fq 'porchfest-test-remote:backups/' "$rclone_log"
  for expected in \
    "$(basename -- "$archive").age" \
    "$(basename -- "$archive").age.sha256" \
    "$(basename -- "$archive").sha256" \
    "$(basename -- "$archive").json"; do
    grep -Fxq "$expected" "$rclone_state" || {
      printf 'ERROR: rclone copy manifest omitted %s\n' "$expected" >&2
      exit 1
    }
  done

  if PATH="$fake_dir:$PATH" \
    PORCHFEST_FAKE_RCLONE_LOG="$rclone_log" \
    PORCHFEST_FAKE_RCLONE_STATE="$rclone_state" \
    PORCHFEST_FAKE_RCLONE_FAIL_LSF=1 \
    PORCHFEST_BACKUP_AGE_RECIPIENT="$recipient" \
    PORCHFEST_BACKUP_REMOTE=porchfest-test-remote:backups \
    PORCHFEST_BACKUP_KEEP=1 \
    "$project_dir/deploy/offsite.sh" >"$missing_output" 2>&1; then
    printf 'ERROR: offsite reported success when the remote listing failed\n' >&2
    exit 1
  fi
  grep -q 'could not verify the off-site backup listing' "$missing_output"
  echo "OK: off-site backup encryption and rclone arguments rehearsed with an isolated shim"
else
  echo "OK: off-site backup shim skipped explicitly (age and age-keygen are not installed)"
fi

echo "OK: archive restored with matching counts and integrity, rollback paths passed, and external-proxy Compose validated"
