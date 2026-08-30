#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$script_dir/common.sh"

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
  printf '%s\n' '8. Check HTTPS status, HTTP redirect, and sign-in cookie flags, then revoke the probe session.'
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

  printf -v remote_guard 'test -d -- %q && test -f -- %q && test -f -- %q' \
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

external_checks() {
  require_value PUBLIC_BASE_URL
  [[ "$PUBLIC_BASE_URL" == https://* ]] || die "PUBLIC_BASE_URL must use HTTPS"
  [[ "$PUBLIC_BASE_URL" != *'"'* && "$PUBLIC_BASE_URL" != *'\'* ]] \
    || die "PUBLIC_BASE_URL contains unsupported curl-config characters"
  local https_status http_url redirect_headers redirect_code redirect_location
  local link_output sign_in_url sign_in_page sign_in_csrf headers_file auth_config cookie_header cookie
  local admin_page sign_out_csrf
  local connect_timeout="${PORCHFEST_EXTERNAL_CONNECT_TIMEOUT:-5}"
  local max_time="${PORCHFEST_EXTERNAL_MAX_TIME:-20}"
  local -a curl_limits=(--connect-timeout "$connect_timeout" --max-time "$max_time")

  [[ "$connect_timeout" =~ ^[1-9][0-9]*$ ]] || die "PORCHFEST_EXTERNAL_CONNECT_TIMEOUT must be a positive integer"
  [[ "$max_time" =~ ^[1-9][0-9]*$ ]] || die "PORCHFEST_EXTERNAL_MAX_TIME must be a positive integer"

  https_status="$(curl "${curl_limits[@]}" --silent --show-error --output /dev/null --write-out '%{http_version} %{http_code}' "$PUBLIC_BASE_URL/health")"
  [[ "$https_status" == *" 200" ]] || die "external HTTPS health check failed"

  http_url="http://${PUBLIC_BASE_URL#https://}"
  redirect_headers="$(mktemp)"
  headers_file="$(mktemp)"
  auth_config="$(mktemp)"
  trap 'rm -f -- "$redirect_headers" "$headers_file" "$auth_config"' RETURN
  curl "${curl_limits[@]}" --silent --show-error --output /dev/null --dump-header "$redirect_headers" "$http_url/health"
  redirect_code="$(awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code}' "$redirect_headers")"
  redirect_location="$(awk 'BEGIN{IGNORECASE=1} /^location:/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$redirect_headers")"
  [[ "$redirect_code" =~ ^30[178]$ && "$redirect_location" == https://* ]] || die "plain HTTP did not redirect to HTTPS"

  if [[ -n "${PORCHFEST_DEPLOY_ORGANIZER_SELECTOR:-}" ]]; then
    link_output="$(compose exec -T app npm run --silent organizer:link -- --organizer "$PORCHFEST_DEPLOY_ORGANIZER_SELECTOR" 2>/dev/null)" \
      || die "could not issue the short-lived cookie-check sign-in link"
  else
    link_output="$(compose exec -T app npm run --silent organizer:link 2>/dev/null)" \
      || die "cookie check needs PORCHFEST_DEPLOY_ORGANIZER_SELECTOR when more than one organizer is active"
  fi
  sign_in_url="$(grep -Eo 'https://[^[:space:]]+/admin/sign-in\?token=[^[:space:]]+' <<<"$link_output" | tail -n 1)"
  [[ -n "$sign_in_url" ]] || die "organizer-link did not return a usable HTTPS sign-in URL"
  printf 'silent\nshow-error\nurl = "%s"\n' "$sign_in_url" >"$auth_config"
  sign_in_page="$(curl "${curl_limits[@]}" --config "$auth_config")"
  sign_in_csrf="$(sed -n 's/.*name="_csrf" value="\([^"]*\)".*/\1/p' <<<"$sign_in_page" | head -n 1)"
  [[ -n "$sign_in_csrf" ]] || die "sign-in page did not contain a CSRF token"
  {
    printf 'silent\nshow-error\noutput = "/dev/null"\ndump-header = "%s"\n' "$headers_file"
    printf 'request = "POST"\nheader = "Origin: %s"\n' "$PUBLIC_BASE_URL"
    printf 'header = "Content-Type: application/x-www-form-urlencoded"\n'
    printf 'data-urlencode = "token=%s"\ndata-urlencode = "_csrf=%s"\n' "${sign_in_url##*token=}" "$sign_in_csrf"
    printf 'url = "%s/admin/sign-in"\n' "$PUBLIC_BASE_URL"
  } >"$auth_config"
  curl "${curl_limits[@]}" --config "$auth_config"
  cookie_header="$(awk 'BEGIN{IGNORECASE=1} /^set-cookie:/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$headers_file")"
  [[ "$cookie_header" == *"Secure"* && "$cookie_header" == *"HttpOnly"* && "$cookie_header" == *"SameSite=Lax"* ]] \
    || die "sign-in cookie is missing Secure, HttpOnly, or SameSite=Lax"
  cookie="${cookie_header%%;*}"

  printf 'silent\nshow-error\nheader = "Cookie: %s"\nurl = "%s/admin"\n' \
    "$cookie" "$PUBLIC_BASE_URL" >"$auth_config"
  admin_page="$(curl "${curl_limits[@]}" --config "$auth_config")"
  sign_out_csrf="$(sed -n '/action="\/admin\/sign-out"/{n;s/.*name="_csrf" value="\([^"]*\)".*/\1/p;q;}' <<<"$admin_page")"
  [[ -n "$sign_out_csrf" ]] || die "could not find sign-out CSRF token for the cookie-check session"
  {
    printf 'silent\nshow-error\noutput = "/dev/null"\nrequest = "POST"\n'
    printf 'header = "Origin: %s"\nheader = "Cookie: %s"\n' "$PUBLIC_BASE_URL" "$cookie"
    printf 'header = "Content-Type: application/x-www-form-urlencoded"\n'
    printf 'data-urlencode = "_csrf=%s"\nurl = "%s/admin/sign-out"\n' "$sign_out_csrf" "$PUBLIC_BASE_URL"
  } >"$auth_config"
  curl "${curl_limits[@]}" --config "$auth_config"

  rm -f -- "$redirect_headers" "$headers_file" "$auth_config"
  trap - RETURN
  printf '%s\n' "$https_status"
}

run_stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
preflight_evidence="$archive_dir/preflight-${run_stamp}.json"
PORCHFEST_EVIDENCE_FILE="$preflight_evidence" "$script_dir/preflight.sh" >/dev/null

"$script_dir/archive.sh" >/dev/null
archive="$(newest_archive)"
[[ -n "$archive" ]] || die "archive step did not produce an archive"
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
https_status="$(external_checks)"

post_evidence="$archive_dir/post-deploy-${run_stamp}.json"
IFS=$'\t' read -r schema_when schema_tag _schema_idx < <(image_schema_entry "$app_image")
write_evidence_json "$post_evidence" post-deploy "$integrity" "$post_counts" "$archive" "$archive_sha" "$archive_mode" "$schema_when" "$schema_tag"
printf 'preflight_evidence=%s\n' "$preflight_evidence"
printf 'post_evidence=%s\n' "$post_evidence"
printf 'https_status=%s\n' "$https_status"
printf 'http_redirect=PASS\n'
printf 'signin_cookie_flags=Secure,HttpOnly,SameSite=Lax\n'
printf 'deploy_result=PASS\n'
print_evidence_block "$integrity" "$post_counts" "$archive" "$archive_sha" "$archive_mode"
