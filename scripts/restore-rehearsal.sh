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
fake_dir=""

cleanup() {
  docker compose -p "$restore_project" -f "$project_dir/compose.yaml" rm -sf app >/dev/null 2>&1 || true
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
export PORCHFEST_HEALTH_ATTEMPTS=45

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
archive_dir="$PORCHFEST_ARCHIVE_DIR"
archive="$(newest_archive)"
[[ -n "$archive" ]] || {
  printf 'ERROR: archive rehearsal produced no archive\n' >&2
  exit 1
}

PORCHFEST_RESTORE_VOLUME="$restore_volume" \
  PORCHFEST_RESTORE_PROJECT="$restore_project" \
  "$project_dir/deploy/restore.sh" "$archive" | grep '^restore_result=PASS$' >/dev/null

PORCHFEST_PROXY_NETWORK=porchfest-proxy-test \
  PORCHFEST_DOMAIN=porchfest.example \
  PORCHFEST_TLS_RESOLVER=testresolver \
  docker compose \
    -f "$project_dir/compose.yaml" \
    -f "$project_dir/deploy/compose.external-proxy.yaml" \
    config >/dev/null

before_rollback_container="$(docker compose -p "$PORCHFEST_COMPOSE_PROJECT" -f "$project_dir/compose.yaml" ps -q app)"
"$project_dir/deploy/rollback.sh" | grep '^rollback_path=image-only$' >/dev/null
after_rollback_container="$(docker compose -p "$PORCHFEST_COMPOSE_PROJECT" -f "$project_dir/compose.yaml" ps -q app)"
[[ -n "$after_rollback_container" && "$after_rollback_container" != "$before_rollback_container" ]] || {
  printf 'ERROR: image-only rollback did not recreate the app container\n' >&2
  exit 1
}

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

echo "OK: archive restored with matching counts and integrity, same-schema rollback passed, and external-proxy Compose validated"
