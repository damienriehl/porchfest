#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$script_dir/common.sh"

usage() {
  printf 'Usage: %s ARCHIVE[.age]\n' "$0" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
source_archive="$1"
[[ -f "$source_archive" ]] || die "archive does not exist: $source_archive"

load_dotenv_if_present
init_deploy_config
require_command docker
require_command sha256sum

restore_volume="${PORCHFEST_RESTORE_VOLUME:-${data_volume}-restore-$(date -u +%Y%m%d%H%M%S)-$$}"
restore_project="${PORCHFEST_RESTORE_PROJECT:-${compose_project}-restore-$$}"
[[ "$restore_volume" != "$data_volume" || "${PORCHFEST_ALLOW_PINNED_RESTORE:-0}" == "1" ]] || die "rehearsal restore target must differ from the pinned production volume"

temp_dir="$(mktemp -d)"
archive="$source_archive"
cleanup_restore() {
  PORCHFEST_COMPOSE_PROJECT="$restore_project" \
    PORCHFEST_DATA_VOLUME="$restore_volume" \
    docker compose -p "$restore_project" -f "$project_dir/compose.yaml" rm -sf app >/dev/null 2>&1 || true
  rm -rf -- "$temp_dir"
}
trap cleanup_restore EXIT

if [[ "$source_archive" == *.age ]]; then
  require_value PORCHFEST_RESTORE_IDENTITY
  require_command age
  archive="$temp_dir/$(basename -- "${source_archive%.age}")"
  age --decrypt --identity "$PORCHFEST_RESTORE_IDENTITY" --output "$archive" "$source_archive"
  cp -- "${source_archive%.age}.sha256" "$(archive_sha_path "$archive")"
  cp -- "${source_archive%.age}.json" "$(archive_metadata_path "$archive")"
fi

metadata="$(archive_metadata_path "$archive")"
[[ -f "$metadata" ]] || die "archive metadata is missing: $metadata"
archive_sha="$(verify_archive_sha "$archive")"
archive_schema_when="$(json_number "$metadata" schema.when)"
[[ -n "$archive_schema_when" ]] || die "archive metadata has no schema journal timestamp"
IFS=$'\t' read -r image_schema_when image_schema_tag _image_schema_idx < <(image_schema_entry "$app_image")
((archive_schema_when <= image_schema_when)) || die "restore image is older than the archive schema"

restore_archive_into_fresh_volume "$archive" "$restore_volume"

compose_project="$restore_project"
data_volume="$restore_volume"
export PORCHFEST_COMPOSE_PROJECT="$restore_project"
export PORCHFEST_DATA_VOLUME="$restore_volume"
export PORCHFEST_APP_IMAGE="$app_image"
export PORCHFEST_SESSION_SECRET=
export PUBLIC_BASE_URL=
export PORCHFEST_TURNSTILE_SITE_KEY=
export PORCHFEST_TURNSTILE_SECRET_KEY=
export GEO_PROVIDER=null
export GEO_USER_AGENT=
export PORCHFEST_SMTP_HOST=
export PORCHFEST_SMTP_FROM=
export PORCHFEST_SMTP_PORT=
export PORCHFEST_SMTP_SECURE=false
export PORCHFEST_SMTP_STARTTLS=true
export PORCHFEST_SMTP_USERNAME=
export PORCHFEST_SMTP_PASSWORD=
export PORCHFEST_SMTP_PASSWORD_FILE=
compose -f "$project_dir/compose.yaml" up -d --no-build app
wait_for_app_health
assert_pinned_volume

integrity="$(volume_integrity)"
counts="$(volume_counts)"
assert_counts_equal_json "$metadata" "$counts"
database_schema_when="$(volume_schema_when)"
[[ "$database_schema_when" == "$image_schema_when" ]] || die "restored database did not reach the restore image's schema journal"

archive_mode="$(json_string "$metadata" archive.mode)"
printf 'restore_project=%s\n' "$restore_project"
printf 'restore_volume=%s\n' "$restore_volume"
printf 'archive_schema=%s\n' "$archive_schema_when"
printf 'restored_schema=%s:%s\n' "$image_schema_when" "$image_schema_tag"
printf 'restore_result=PASS\n'
print_evidence_block "$integrity" "$counts" "$source_archive" "$archive_sha" "$archive_mode"

# Retain the restored volume: the caller owns its inspection and removal.
