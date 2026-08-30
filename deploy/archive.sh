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

container="$(app_container_id)"
running_image_id="$(docker inspect --format '{{.Image}}' "$container")"
[[ "$running_image_id" == "$(image_id "$app_image")" ]] || die "running app image is not PORCHFEST_APP_IMAGE"
IFS=$'\t' read -r schema_when schema_tag _schema_idx < <(image_schema_entry "$running_image_id")

stopped=0
restart_app() {
  if ((stopped)); then
    compose start app >/dev/null 2>&1 || true
  fi
}
trap restart_app EXIT

compose stop app >/dev/null
stopped=1

integrity="$(volume_integrity)"
counts="$(volume_counts)"
database_schema_when="$(volume_schema_when)"
[[ "$database_schema_when" == "$schema_when" ]] || die "database migration journal does not match the archived image"

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
archive="$archive_dir/porchfest-${compose_project}-${schema_when}-${stamp}.tar.gz"
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

compose start app >/dev/null
stopped=0
wait_for_app_health
assert_pinned_volume

mapfile -t archives < <(
  find "$archive_dir" -maxdepth 1 -type f -name 'porchfest-*.tar.gz' -printf '%T@\t%p\n' \
    | sort -nr \
    | cut -f 2-
)
for ((index = archive_keep; index < ${#archives[@]}; index++)); do
  old="${archives[index]}"
  rm -f -- "$old" "$(archive_sha_path "$old")" "$(archive_metadata_path "$old")" "${old}.age" "${old}.age.sha256"
done

printf 'schema_journal=%s:%s\n' "$schema_when" "$schema_tag"
printf 'archive_metadata=%s\n' "$metadata"
print_evidence_block "$integrity" "$counts" "$archive" "$archive_sha" "$archive_mode"
