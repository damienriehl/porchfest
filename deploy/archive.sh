#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$script_dir/common.sh"

usage() {
  printf 'Usage: %s [--no-restart]\n' "$0" >&2
  exit 2
}

no_restart="${PORCHFEST_ARCHIVE_NO_RESTART:-0}"
case "${1:-}" in
  "") ;;
  --no-restart) no_restart=1 ;;
  *) usage ;;
esac
[[ $# -le 1 ]] || usage
[[ "$no_restart" == 0 || "$no_restart" == 1 ]] \
  || die "PORCHFEST_ARCHIVE_NO_RESTART must be 0 or 1"

load_dotenv_if_present
init_deploy_config
require_command docker
require_command sha256sum
ensure_archive_dir_safe
assert_pinned_volume

container="$(app_container_id)"
running_image_id="$(docker inspect --format '{{.Image}}' "$container")"
[[ "$running_image_id" == "$(image_id "$app_image")" ]] || die "running app image is not PORCHFEST_APP_IMAGE"
IFS=$'\t' read -r schema_when schema_tag _schema_idx < <(image_schema_entry "$running_image_id")

archive_app_state() {
  local target
  target="$(compose ps -a -q app 2>/dev/null || true)"
  if [[ -z "$target" ]]; then
    printf '%s\n' 'missing'
  else
    docker inspect --format '{{.State.Status}}' "$target" 2>/dev/null || printf '%s\n' 'unknown'
  fi
}

archive_exit() {
  local status=$?
  local restart_result="not-needed"
  local resulting_state
  trap - EXIT
  if ((status != 0)); then
    printf '%s\n' 'ERROR: archive step failed' >&2
    resulting_state="$(archive_app_state)"
    if ((no_restart)); then
      restart_result="not-requested"
    elif [[ "$resulting_state" != running ]]; then
      if compose start app; then
        restart_result="restarted"
      else
        restart_result="restart-failed"
      fi
    fi
    resulting_state="$(archive_app_state)"
    printf 'archive_failure_app_restart=%s\n' "$restart_result" >&2
    printf 'archive_failure_app_state=%s\n' "$resulting_state" >&2
  fi
  exit "$status"
}
trap archive_exit EXIT

compose stop app >/dev/null

integrity="$(volume_integrity)"
counts="$(volume_counts)"
database_schema_when="$(volume_schema_when)"
[[ "$database_schema_when" == "$schema_when" ]] || die "database migration journal does not match the archived image"

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
archive="$archive_dir/${compose_project}-porchfest-${schema_when}-${stamp}.tar.gz"
umask 077
docker run --rm \
  --volume "$data_volume:/source:ro" \
  "$utility_image" \
  tar -czf - -C /source . >"$archive"
chmod 0600 "$archive"
archive_mode="$(stat -c '%a' "$archive")"
archive_owner="$(stat -c '%u:%g' "$archive")"
[[ "$archive_mode" == "600" ]] || die "archive mode is not 0600"
[[ "$archive_owner" == "$(id -u):$(id -g)" ]] || die "archive is not owned by the deploy user"

archive_sha="$(sha256sum "$archive" | cut -d ' ' -f 1)"
sha_file="$(archive_sha_path "$archive")"
printf '%s  %s\n' "$archive_sha" "$(basename -- "$archive")" >"$sha_file"
chmod 0600 "$sha_file"
metadata="$(archive_metadata_path "$archive")"
write_evidence_json "$metadata" archive "$integrity" "$counts" "$archive" "$archive_sha" "$archive_mode" "$schema_when" "$schema_tag"

if ((no_restart)); then
  printf '%s\n' 'archive_app_state=stopped'
else
  compose start app
  wait_for_app_health
  assert_pinned_volume
fi

mapfile -t archives < <(
  deployment_archives
)
for ((index = archive_keep; index < ${#archives[@]}; index++)); do
  old="${archives[index]}"
  rm -f -- "$old" "$(archive_sha_path "$old")" "$(archive_metadata_path "$old")" "${old}.age" "${old}.age.sha256"
done

if [[ -n "${PORCHFEST_ARCHIVE_RESULT_FILE:-}" ]]; then
  (umask 077; printf '%s\n' "$archive" >"$PORCHFEST_ARCHIVE_RESULT_FILE")
  chmod 0600 "$PORCHFEST_ARCHIVE_RESULT_FILE"
fi

printf 'schema_journal=%s:%s\n' "$schema_when" "$schema_tag"
printf 'archive_metadata=%s\n' "$metadata"
print_evidence_block "$integrity" "$counts" "$archive" "$archive_sha" "$archive_mode"
