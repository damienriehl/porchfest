#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$script_dir/common.sh"

# Usage: deploy/offsite.sh [ARCHIVE]
# ARCHIVE must be inside PORCHFEST_ARCHIVE_DIR and defaults to its newest deployment archive.
usage() {
  printf 'Usage: %s [ARCHIVE]\n' "$0" >&2
  exit 2
}

[[ $# -le 1 ]] || usage
requested_archive="${1:-}"

load_dotenv_if_present
init_deploy_config
require_value PORCHFEST_BACKUP_AGE_RECIPIENT
require_value PORCHFEST_BACKUP_REMOTE
require_command age
require_command rclone
require_command sha256sum
ensure_archive_dir_safe
assert_pinned_volume

if [[ -n "$requested_archive" ]]; then
  [[ -f "$requested_archive" && ! -L "$requested_archive" ]] \
    || die "requested archive does not exist as a regular file: $requested_archive"
  requested_archive_dir="$(cd -- "$(dirname -- "$requested_archive")" && pwd -P)"
  archive="$requested_archive_dir/$(basename -- "$requested_archive")"
  case "$archive" in
    "$archive_dir/"*) ;;
    *) die "requested archive must live inside PORCHFEST_ARCHIVE_DIR" ;;
  esac
else
  archive="$(newest_archive)"
fi
[[ -n "$archive" && -f "$archive" ]] || die "no local archive is available for off-site backup"
metadata="$(archive_metadata_path "$archive")"
plain_sha_file="$(archive_sha_path "$archive")"
[[ -f "$metadata" && -f "$plain_sha_file" ]] || die "archive is missing metadata or SHA-256 evidence"
archive_sha="$(verify_archive_sha "$archive")"

encrypted="${archive}.age"
umask 077
age --recipient "$PORCHFEST_BACKUP_AGE_RECIPIENT" --output "$encrypted" "$archive"
chmod 0600 "$encrypted"
encrypted_sha="$(sha256sum "$encrypted" | cut -d ' ' -f 1)"
printf '%s  %s\n' "$encrypted_sha" "$(basename -- "$encrypted")" >"${encrypted}.sha256"
chmod 0600 "${encrypted}.sha256"

remote="${PORCHFEST_BACKUP_REMOTE%/}"
copy_manifest="$(mktemp)"
cleanup_manifest() {
  rm -f -- "$copy_manifest"
}
trap cleanup_manifest EXIT
printf '%s\n' \
  "$(basename -- "$encrypted")" \
  "$(basename -- "${encrypted}.sha256")" \
  "$(basename -- "$plain_sha_file")" \
  "$(basename -- "$metadata")" >"$copy_manifest"
chmod 0600 "$copy_manifest"
rclone copy "$(dirname -- "$archive")" "$remote/" --files-from "$copy_manifest"

remote_listing="$(rclone lsf --files-only --format tp --time-format unixnano "$remote/")" \
  || die "could not verify the off-site backup listing"
mapfile -t remote_archives < <(
  sed -n "\\#;${compose_project}-.*\\.tar\\.gz\\.age\$#p" <<<"$remote_listing" \
    | sort -t ';' -k1,1nr \
    | cut -d ';' -f 2-
)
printf '%s\n' "${remote_archives[@]}" | grep -Fx "$(basename -- "$encrypted")" >/dev/null \
  || die "copied archive is absent from the verified off-site listing"
for ((index = backup_keep; index < ${#remote_archives[@]}; index++)); do
  remote_archive="${remote_archives[index]}"
  rclone deletefile "$remote/$remote_archive"
  rclone deletefile "$remote/${remote_archive}.sha256" || true
  rclone deletefile "$remote/${remote_archive%.age}.sha256" || true
  rclone deletefile "$remote/${remote_archive%.age}.json" || true
done

integrity="$(json_string "$metadata" integrity)"
counts="$(counts_from_json "$metadata")"
archive_bytes="$(stat -c '%s' "$archive")"
archive_timestamp="$(date -u -r "$archive" +%Y-%m-%dT%H:%M:%SZ)"
remote_count="${#remote_archives[@]}"
if ((remote_count > backup_keep)); then remote_count="$backup_keep"; fi

printf 'encrypted_path=%s\n' "$encrypted"
printf 'encrypted_sha256=%s\n' "$encrypted_sha"
printf 'archive_timestamp=%s\n' "$archive_timestamp"
printf 'archive_bytes=%s\n' "$archive_bytes"
printf 'remote_archive_count=%s\n' "$remote_count"
printf 'remote_retention=%s\n' "$backup_keep"
print_evidence_block "$integrity" "$counts" "$archive" "$archive_sha" "$(stat -c '%a' "$archive")"
