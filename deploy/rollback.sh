#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$script_dir/common.sh"

recover_safety_archive() {
  local safety_image_ref="$1"
  local safety_archive="$2"
  local safety_restore_project="$3"
  if ! PORCHFEST_APP_IMAGE="$safety_image_ref" \
    PORCHFEST_RESTORE_VOLUME="$data_volume" \
    PORCHFEST_RESTORE_PROJECT="$safety_restore_project" \
    PORCHFEST_ALLOW_PINNED_RESTORE=1 \
    "$script_dir/restore.sh" "$safety_archive" >/dev/null; then
    return 1
  fi

  printf 'safety_archive_restored=%s\n' "$safety_archive" >&2
  docker tag "$safety_image_ref" "$app_image" || return 2
  compose up -d --no-build app || return 2
  wait_for_app_health || return 2
  assert_pinned_volume || return 2
}

recover_schema_moved_rollback() {
  local failed_step="$1"
  local safety_image_ref="$2"
  local safety_archive="$3"
  local restore_project="$4"
  local safety_restore_project="${compose_project}-safety-restore-$$"
  local recovery_status=0

  printf 'ERROR: rollback step failed (%s); restoring the safety archive into the pinned volume\n' \
    "$failed_step" >&2
  compose rm -sf app >/dev/null 2>&1 || true
  docker compose -p "$restore_project" -f "$project_dir/compose.yaml" \
    down --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$data_volume" >/dev/null 2>&1 || true

  recover_safety_archive "$safety_image_ref" "$safety_archive" "$safety_restore_project" \
    || recovery_status=$?
  case "$recovery_status" in
    0) die "rollback failed at $failed_step; the pre-rollback safety archive was restored automatically and the app was restarted" ;;
    2) die "rollback failed at $failed_step; the pre-rollback safety archive data was restored automatically, but the app did not restart" ;;
    *) die "rollback failed at $failed_step and automatic safety-archive restoration also failed" ;;
  esac
}

if [[ "${PORCHFEST_ROLLBACK_LIB_ONLY:-0}" == 1 ]]; then
  return 0 2>/dev/null || exit 0
fi

load_dotenv_if_present
init_deploy_config
require_command docker
require_command sha256sum
ensure_archive_dir_safe
assert_pinned_volume

prev_ref="$(rollback_image_ref)"
image_id "$prev_ref" >/dev/null 2>&1 || die "rollback image is missing: $prev_ref"
IFS=$'\t' read -r current_when current_tag _current_idx < <(image_schema_entry "$app_image")
IFS=$'\t' read -r previous_when previous_tag _previous_idx < <(image_schema_entry "$prev_ref")

before_integrity="$(volume_integrity)"
before_counts="$(volume_counts)"
path=""
reason=""
archive="none"
archive_sha="none"
archive_mode="none"

if [[ "$current_when" == "$previous_when" && "$current_tag" == "$previous_tag" ]]; then
  path="image-only"
  reason="current and previous images ship the same Drizzle journal entry"
  docker tag "$prev_ref" "$app_image"
  compose up -d --no-build --force-recreate app
  wait_for_app_health
  assert_pinned_volume
  [[ "$(docker inspect --format '{{.Image}}' "$(app_container_id)")" == "$(image_id "$prev_ref")" ]] \
    || die "image-only rollback did not replace the running container image"
  integrity="$(volume_integrity)"
  counts="$(volume_counts)"
  [[ "$before_counts" == "$counts" ]] || die "row counts changed during image-only rollback"
else
  ((current_when > previous_when)) || die "previous image schema is not equal to or older than the current image"
  path="archive-restore"
  reason="current image ships a newer Drizzle journal entry than the previous image"

  matching_metadata=""
  while IFS= read -r candidate; do
    if [[ "$(json_number "$candidate" schema.when)" == "$previous_when" ]]; then
      matching_metadata="$candidate"
      break
    fi
  done < <(
    find "$archive_dir" -maxdepth 1 -type f -name 'porchfest-*.tar.gz.json' -printf '%T@\t%p\n' \
      | sort -nr \
      | cut -f 2-
  )
  [[ -n "$matching_metadata" ]] || die "schema moved; image-only rollback refused and no archive matches previous schema $previous_when:$previous_tag"
  archive="${matching_metadata%.json}"
  [[ -f "$archive" ]] || die "matching archive recorded by metadata is missing"
  archive_sha="$(verify_archive_sha "$archive")"
  archive_mode="$(stat -c '%a' "$archive")"

  rehearsal_volume="${data_volume}-rollback-rehearsal-$$"
  rehearsal_project="${compose_project}-rollback-rehearsal-$$"
  rehearsal_output="$(mktemp)"
  if ! PORCHFEST_APP_IMAGE="$prev_ref" \
    PORCHFEST_RESTORE_VOLUME="$rehearsal_volume" \
    PORCHFEST_RESTORE_PROJECT="$rehearsal_project" \
    "$script_dir/restore.sh" "$archive" >"$rehearsal_output"; then
    docker compose -p "$rehearsal_project" -f "$project_dir/compose.yaml" \
      down --remove-orphans >/dev/null 2>&1 || true
    docker volume rm "$rehearsal_volume" >/dev/null 2>&1 || true
    rm -f -- "$rehearsal_output"
    die "rollback archive failed rehearsal; the pinned volume was not touched"
  fi
  rehearsal_passed=0
  grep -Fxq 'restore_result=PASS' "$rehearsal_output" && rehearsal_passed=1
  rm -f -- "$rehearsal_output"
  docker compose -p "$rehearsal_project" -f "$project_dir/compose.yaml" \
    down --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$rehearsal_volume" >/dev/null
  ((rehearsal_passed)) || die "rollback archive rehearsal did not report PASS"

  safety_image_ref="$(image_tag_ref "$app_image" "rollback-safety-${compose_project}-$$")"
  docker tag "$(image_id "$app_image")" "$safety_image_ref"
  cleanup_safety_tag() {
    [[ -z "${safety_result:-}" ]] || rm -f -- "$safety_result"
    docker image rm "$safety_image_ref" >/dev/null 2>&1 || true
  }
  trap cleanup_safety_tag EXIT

  safety_result="$(mktemp)"
  chmod 0600 "$safety_result"
  PORCHFEST_ARCHIVE_KEEP=1000000 PORCHFEST_ARCHIVE_RESULT_FILE="$safety_result" \
    "$script_dir/archive.sh" --no-restart >/dev/null
  safety_archive="$(archive_from_result_file "$safety_result")"
  rm -f -- "$safety_result"
  safety_result=""
  [[ -n "$safety_archive" && "$safety_archive" != "$archive" ]] \
    || die "safety archive was not created"
  verify_archive_sha "$safety_archive" >/dev/null

  restore_project="${compose_project}-rollback-restore-$$"
  compose rm -f app >/dev/null || {
    recover_schema_moved_rollback "compose rm app" "$safety_image_ref" "$safety_archive" "$restore_project"
  }
  docker volume rm "$data_volume" >/dev/null || {
    recover_schema_moved_rollback "docker volume rm $data_volume" "$safety_image_ref" "$safety_archive" "$restore_project"
  }
  PORCHFEST_APP_IMAGE="$prev_ref" \
    PORCHFEST_RESTORE_VOLUME="$data_volume" \
    PORCHFEST_RESTORE_PROJECT="$restore_project" \
    PORCHFEST_ALLOW_PINNED_RESTORE=1 \
    "$script_dir/restore.sh" "$archive" >/dev/null || {
      recover_schema_moved_rollback "restore rollback archive" "$safety_image_ref" "$safety_archive" "$restore_project"
    }
  docker tag "$prev_ref" "$app_image" || {
    recover_schema_moved_rollback "docker tag previous image" "$safety_image_ref" "$safety_archive" "$restore_project"
  }
  compose up -d --no-build app || {
    recover_schema_moved_rollback "compose up app" "$safety_image_ref" "$safety_archive" "$restore_project"
  }
  wait_for_app_health || {
    recover_schema_moved_rollback "wait for app health" "$safety_image_ref" "$safety_archive" "$restore_project"
  }
  assert_pinned_volume || {
    recover_schema_moved_rollback "assert pinned volume" "$safety_image_ref" "$safety_archive" "$restore_project"
  }
  integrity="$(volume_integrity)" || {
    recover_schema_moved_rollback "check restored volume integrity" "$safety_image_ref" "$safety_archive" "$restore_project"
  }
  counts="$(volume_counts)" || {
    recover_schema_moved_rollback "read restored volume counts" "$safety_image_ref" "$safety_archive" "$restore_project"
  }
  assert_counts_equal_json "$matching_metadata" "$counts" || {
    recover_schema_moved_rollback "compare restored volume counts" "$safety_image_ref" "$safety_archive" "$restore_project"
  }
fi

printf 'rollback_path=%s\n' "$path"
printf 'rollback_reason=%s\n' "$reason"
printf 'current_schema_before=%s:%s\n' "$current_when" "$current_tag"
printf 'previous_schema=%s:%s\n' "$previous_when" "$previous_tag"
printf 'rollback_result=PASS\n'
print_evidence_block "$integrity" "$counts" "$archive" "$archive_sha" "$archive_mode"
