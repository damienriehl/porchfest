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
configured_image_id="$(image_id "$app_image")"
[[ "$running_image_id" == "$configured_image_id" ]] || die "running app image is not PORCHFEST_APP_IMAGE; refusing to retain the wrong rollback image"

prev_ref="$(rollback_image_ref)"
docker tag "$running_image_id" "$prev_ref"
[[ "$(image_id "$prev_ref")" == "$running_image_id" ]] || die "rollback tag did not retain the running image"

integrity="$(volume_integrity)"
counts="$(volume_counts)"
IFS=$'\t' read -r schema_when schema_tag _schema_idx < <(image_schema_entry "$running_image_id")
database_schema_when="$(volume_schema_when)"
[[ "$database_schema_when" == "$schema_when" ]] || die "database migration journal does not match the running image"

evidence_file="${PORCHFEST_EVIDENCE_FILE:-$archive_dir/preflight-latest.json}"
write_evidence_json "$evidence_file" preflight "$integrity" "$counts" "" "" "" "$schema_when" "$schema_tag"
printf 'evidence_file=%s\n' "$evidence_file"
print_evidence_block "$integrity" "$counts"
