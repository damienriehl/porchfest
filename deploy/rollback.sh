#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$script_dir/common.sh"

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
    docker image rm "$safety_image_ref" >/dev/null 2>&1 || true
  }
  trap cleanup_safety_tag EXIT

  PORCHFEST_ARCHIVE_KEEP=1000000 "$script_dir/archive.sh" --no-restart >/dev/null
  safety_archive="$(newest_archive)"
  [[ -n "$safety_archive" && "$safety_archive" != "$archive" ]] \
    || die "safety archive was not created"
  verify_archive_sha "$safety_archive" >/dev/null

  restore_project="${compose_project}-rollback-restore-$$"
  if (
    compose rm -f app >/dev/null
    docker volume rm "$data_volume" >/dev/null
    PORCHFEST_APP_IMAGE="$prev_ref" \
      PORCHFEST_RESTORE_VOLUME="$data_volume" \
      PORCHFEST_RESTORE_PROJECT="$restore_project" \
      PORCHFEST_ALLOW_PINNED_RESTORE=1 \
      "$script_dir/restore.sh" "$archive" >/dev/null
    docker tag "$prev_ref" "$app_image"
    compose up -d --no-build app
    wait_for_app_health
    assert_pinned_volume
    restored_integrity="$(volume_integrity)"
    restored_counts="$(volume_counts)"
    assert_counts_equal_json "$matching_metadata" "$restored_counts"
  ); then
    integrity="$(volume_integrity)"
    counts="$(volume_counts)"
  else
    printf '%s\n' 'ERROR: rollback restore failed; restoring the safety archive into the pinned volume' >&2
    compose rm -sf app >/dev/null 2>&1 || true
    docker compose -p "$restore_project" -f "$project_dir/compose.yaml" \
      down --remove-orphans >/dev/null 2>&1 || true
    docker volume rm "$data_volume" >/dev/null 2>&1 || true

    safety_restore_project="${compose_project}-safety-restore-$$"
    if PORCHFEST_APP_IMAGE="$safety_image_ref" \
      PORCHFEST_RESTORE_VOLUME="$data_volume" \
      PORCHFEST_RESTORE_PROJECT="$safety_restore_project" \
      PORCHFEST_ALLOW_PINNED_RESTORE=1 \
      "$script_dir/restore.sh" "$safety_archive" >/dev/null; then
      docker tag "$safety_image_ref" "$app_image"
      compose up -d --no-build app
      wait_for_app_health
      assert_pinned_volume
      printf 'safety_archive_restored=%s\n' "$safety_archive" >&2
      die "rollback failed; the pre-rollback safety archive was restored automatically"
    fi
    die "rollback failed and automatic safety-archive restoration also failed"
  fi
fi

printf 'rollback_path=%s\n' "$path"
printf 'rollback_reason=%s\n' "$reason"
printf 'current_schema_before=%s:%s\n' "$current_when" "$current_tag"
printf 'previous_schema=%s:%s\n' "$previous_when" "$previous_tag"
printf 'rollback_result=PASS\n'
print_evidence_block "$integrity" "$counts" "$archive" "$archive_sha" "$archive_mode"
