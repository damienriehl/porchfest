#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$script_dir/common.sh"
# shellcheck source=deploy/probe.sh
source "$script_dir/probe.sh"

usage() {
  printf 'Usage: %s [--dry-run|--on-host]\n' "$0" >&2
  exit 2
}

mode="ship"
case "${1:-}" in
  "") ;;
  --dry-run) mode="dry-run" ;;
  --on-host) mode="on-host" ;;
  *) usage ;;
esac
[[ $# -le 1 ]] || usage

if [[ "$mode" == "dry-run" ]]; then
  printf '%s\n' 'Porchfest deploy dry run (no commands executed)'
  printf '%s\n' '1. Package HEAD with git archive (tracked files only).'
  printf '%s\n' '2. Rsync the package while preserving the host .env.'
  printf '%s\n' '3. Gather preflight commit/image/volume/integrity/count/tag evidence.'
  printf '%s\n' '4. Quiesce, archive, checksum, restart, and health-check app.'
  printf '%s\n' '5. Optionally encrypt/copy/prune the off-site backup when PORCHFEST_DEPLOY_OFFSITE=1.'
  printf '%s\n' '6. Build and replace only app; the proxy service is left alone.'
  printf '%s\n' '7. Recheck the pinned volume and integrity; refuse row-count decreases or season changes.'
  printf '%s\n' '8. Check HTTPS status and HTTP redirect; probe sign-in only for a configured organizer.'
  printf '%s\n' 'Evidence fields: commit, image id, volume, integrity, six row counts, archive path/SHA/mode, tags, HTTPS/redirect/cookie results.'
  exit 0
fi

load_dotenv_if_present

if [[ "$mode" == "ship" ]]; then
  require_value PORCHFEST_DEPLOY_HOST
  require_value PORCHFEST_DEPLOY_DIR
  require_command git
  require_command rsync
  require_command ssh
  require_command tar

  [[ "$PORCHFEST_DEPLOY_DIR" == /* && "$PORCHFEST_DEPLOY_DIR" != "/" ]] \
    || die "PORCHFEST_DEPLOY_DIR must be an absolute, non-root directory"

  printf -v remote_guard 'test -d %q && test -f %q && test -f %q' \
    "$PORCHFEST_DEPLOY_DIR" "$PORCHFEST_DEPLOY_DIR/.env" "$PORCHFEST_DEPLOY_DIR/.porchfest-deploy-root"
  ssh "$PORCHFEST_DEPLOY_HOST" "$remote_guard" \
    || die "remote deploy directory must exist with .env and .porchfest-deploy-root"

  deploy_commit="$(git -C "$project_dir" rev-parse HEAD)"
  stage_dir="$(mktemp -d)"
  cleanup_stage() {
    rm -rf -- "$stage_dir"
  }
  trap cleanup_stage EXIT
  git -C "$project_dir" archive --format=tar HEAD | tar -xf - -C "$stage_dir"
  rsync -a --delete --exclude='.env' --exclude='.git/' --exclude='.porchfest-deploy-root' \
    "$stage_dir/" "$PORCHFEST_DEPLOY_HOST:$PORCHFEST_DEPLOY_DIR/"
  printf -v remote_command 'cd -- %q && PORCHFEST_DEPLOY_COMMIT=%q bash deploy/deploy.sh --on-host' \
    "$PORCHFEST_DEPLOY_DIR" "$deploy_commit"
  ssh "$PORCHFEST_DEPLOY_HOST" "$remote_command"
  exit 0
fi

init_deploy_config
require_command curl
require_command docker
require_command sha256sum
ensure_archive_dir_safe

run_stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
preflight_evidence="$archive_dir/preflight-${run_stamp}.json"
PORCHFEST_EVIDENCE_FILE="$preflight_evidence" "$script_dir/preflight.sh" >/dev/null

archive_result="$(mktemp)"
chmod 0600 "$archive_result"
if ! PORCHFEST_ARCHIVE_RESULT_FILE="$archive_result" "$script_dir/archive.sh" >/dev/null; then
  rm -f -- "$archive_result"
  die "archive step failed"
fi
archive="$(archive_from_result_file "$archive_result")"
rm -f -- "$archive_result"
archive_metadata="$(archive_metadata_path "$archive")"
archive_sha="$(verify_archive_sha "$archive")"
archive_mode="$(stat -c '%a' "$archive")"

case "${PORCHFEST_DEPLOY_OFFSITE:-0}" in
  0) ;;
  1) "$script_dir/offsite.sh" >/dev/null ;;
  *) die "PORCHFEST_DEPLOY_OFFSITE must be 0 or 1" ;;
esac

compose up -d --build app
wait_for_app_health
assert_pinned_volume
integrity="$(volume_integrity)"
post_counts="$(volume_counts)"
assert_counts_match_json "$archive_metadata" "$post_counts"
external_checks
https_status="$probe_https_status"

post_evidence="$archive_dir/post-deploy-${run_stamp}.json"
IFS=$'\t' read -r schema_when schema_tag _schema_idx < <(image_schema_entry "$app_image")
write_evidence_json "$post_evidence" post-deploy "$integrity" "$post_counts" "$archive" "$archive_sha" "$archive_mode" "$schema_when" "$schema_tag"
printf 'preflight_evidence=%s\n' "$preflight_evidence"
printf 'post_evidence=%s\n' "$post_evidence"
printf 'https_status=%s\n' "$https_status"
printf 'http_redirect=PASS\n'
printf 'signin_cookie_flags=%s\n' "$probe_cookie_result"
printf 'deploy_result=PASS\n'
print_evidence_block "$integrity" "$post_counts" "$archive" "$archive_sha" "$archive_mode"
