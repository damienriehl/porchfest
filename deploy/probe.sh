#!/usr/bin/env bash

# External deployment checks. Source after deploy/common.sh.

probe_session_active=0
probe_cookie=""
probe_origin=""
probe_auth_config=""
probe_redirect_headers=""
probe_headers_file=""
probe_organizer_error=""
probe_connect_timeout=""
probe_max_time=""
probe_https_status=""
probe_cookie_result="SKIPPED"

probe_url_origin() {
  local url="$1"
  compose exec -T app node -e '
    try {
      const url = new URL(process.argv[1]);
      if (url.protocol !== "https:") process.exit(2);
      process.stdout.write(`${url.origin}\n`);
    } catch {
      process.exit(2);
    }
  ' "$url" || die "PUBLIC_BASE_URL is not a valid HTTPS URL"
}

probe_cookie_has_required_flags() {
  local cookie_header="$1"
  [[ "$cookie_header" == *"Secure"* && "$cookie_header" == *"HttpOnly"* && "$cookie_header" == *"SameSite=Lax"* ]]
}

attempt_probe_sign_out() {
  ((probe_session_active)) || return 0
  local admin_page sign_out_csrf
  printf 'silent\nshow-error\nheader = "Cookie: %s"\nurl = "%s/admin"\n' \
    "$probe_cookie" "$probe_origin" >"$probe_auth_config"
  admin_page="$(curl --connect-timeout "$probe_connect_timeout" --max-time "$probe_max_time" \
    --config "$probe_auth_config")" || return 1
  sign_out_csrf="$(sed -n '/action="\/admin\/sign-out"/{n;s/.*name="_csrf" value="\([^"]*\)".*/\1/p;q;}' <<<"$admin_page")"
  [[ -n "$sign_out_csrf" ]] || return 1
  {
    printf 'silent\nshow-error\noutput = "/dev/null"\nrequest = "POST"\n'
    printf 'header = "Origin: %s"\nheader = "Cookie: %s"\n' "$probe_origin" "$probe_cookie"
    printf 'header = "Content-Type: application/x-www-form-urlencoded"\n'
    printf 'data-urlencode = "_csrf=%s"\nurl = "%s/admin/sign-out"\n' "$sign_out_csrf" "$probe_origin"
  } >"$probe_auth_config"
  curl --connect-timeout "$probe_connect_timeout" --max-time "$probe_max_time" \
    --config "$probe_auth_config" || return 1
  probe_session_active=0
}

cleanup_external_probe() {
  local status=$?
  trap - EXIT
  if ((probe_session_active)); then
    if attempt_probe_sign_out; then
      printf '%s\n' 'probe cleanup: signed out the temporary organizer session' >&2
    else
      printf '%s\n' 'ERROR: probe cleanup could not sign out the temporary organizer session' >&2
    fi
  fi
  rm -f -- "$probe_redirect_headers" "$probe_headers_file" "$probe_auth_config" "$probe_organizer_error"
  exit "$status"
}

external_checks() {
  require_value PUBLIC_BASE_URL
  [[ "$PUBLIC_BASE_URL" != *\"* && "$PUBLIC_BASE_URL" != *"'"* ]] \
    || die "PUBLIC_BASE_URL contains unsupported curl-config characters"
  probe_connect_timeout="${PORCHFEST_EXTERNAL_CONNECT_TIMEOUT:-5}"
  probe_max_time="${PORCHFEST_EXTERNAL_MAX_TIME:-20}"
  [[ "$probe_connect_timeout" =~ ^[1-9][0-9]*$ ]] || die "PORCHFEST_EXTERNAL_CONNECT_TIMEOUT must be a positive integer"
  [[ "$probe_max_time" =~ ^[1-9][0-9]*$ ]] || die "PORCHFEST_EXTERNAL_MAX_TIME must be a positive integer"

  probe_origin="$(probe_url_origin "$PUBLIC_BASE_URL")"
  local http_url redirect_code redirect_location
  local link_output sign_in_url sign_in_page sign_in_csrf cookie_header page_cookie_header
  local -a curl_limits=(--connect-timeout "$probe_connect_timeout" --max-time "$probe_max_time")

  probe_https_status="$(curl "${curl_limits[@]}" --silent --show-error --output /dev/null --write-out '%{http_version} %{http_code}' "$probe_origin/health")"
  [[ "$probe_https_status" == *" 200" ]] || die "external HTTPS health check failed"

  probe_redirect_headers="$(mktemp)"
  probe_headers_file="$(mktemp)"
  probe_auth_config="$(mktemp)"
  probe_organizer_error="$(mktemp)"
  chmod 0600 "$probe_redirect_headers" "$probe_headers_file" "$probe_auth_config" "$probe_organizer_error"
  trap cleanup_external_probe EXIT

  http_url="http://${probe_origin#https://}"
  curl "${curl_limits[@]}" --silent --show-error --output /dev/null \
    --dump-header "$probe_redirect_headers" "$http_url/health"
  redirect_code="$(awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code}' "$probe_redirect_headers")"
  redirect_location="$(awk 'BEGIN{IGNORECASE=1} /^location:/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$probe_redirect_headers")"
  [[ "$redirect_code" =~ ^30[178]$ && "$redirect_location" == https://* ]] || die "plain HTTP did not redirect to HTTPS"

  printf 'silent\nshow-error\ndump-header = "%s"\nurl = "%s/admin/sign-in"\n' \
    "$probe_headers_file" "$probe_origin" >"$probe_auth_config"
  sign_in_page="$(curl "${curl_limits[@]}" --config "$probe_auth_config")"
  page_cookie_header="$(awk 'BEGIN{IGNORECASE=1} /^set-cookie:/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$probe_headers_file")"
  if [[ -n "$page_cookie_header" ]]; then
    probe_cookie_has_required_flags "$page_cookie_header" \
      || die "sign-in page cookie is missing Secure, HttpOnly, or SameSite=Lax"
    probe_cookie_result="Secure,HttpOnly,SameSite=Lax"
  fi

  if [[ -z "${PORCHFEST_DEPLOY_PROBE_ORGANIZER:-}" ]]; then
    printf '%s\n' 'probe: skipped — no organizer configured (set PORCHFEST_DEPLOY_PROBE_ORGANIZER)'
    return 0
  fi

  if ! link_output="$(compose exec -T app npm run --silent organizer:link -- \
    --organizer "$PORCHFEST_DEPLOY_PROBE_ORGANIZER" 2>"$probe_organizer_error")"; then
    printf '%s\n' 'organizer:link failed:' >&2
    command cat "$probe_organizer_error" >&2
    die "could not issue the short-lived cookie-check recovery link"
  fi
  [[ "$link_output" == *"Porchfest organizer sign-in link for"* ]] \
    || die "organizer:link did not produce an existing-organizer recovery link"
  sign_in_url="$(grep -Eo 'https://[^[:space:]]+/admin/sign-in\?token=[^[:space:]]+' <<<"$link_output" | tail -n 1)"
  [[ -n "$sign_in_url" ]] || die "organizer-link did not return a usable HTTPS sign-in URL"
  printf 'silent\nshow-error\ndump-header = "%s"\nurl = "%s"\n' \
    "$probe_headers_file" "$sign_in_url" >"$probe_auth_config"
  sign_in_page="$(curl "${curl_limits[@]}" --config "$probe_auth_config")"
  sign_in_csrf="$(sed -n 's/.*name="_csrf" value="\([^"]*\)".*/\1/p' <<<"$sign_in_page" | head -n 1)"
  [[ -n "$sign_in_csrf" ]] || die "sign-in page did not contain a CSRF token"
  {
    printf 'silent\nshow-error\noutput = "/dev/null"\ndump-header = "%s"\n' "$probe_headers_file"
    printf 'request = "POST"\nheader = "Origin: %s"\n' "$probe_origin"
    printf 'header = "Content-Type: application/x-www-form-urlencoded"\n'
    printf 'data-urlencode = "token=%s"\ndata-urlencode = "_csrf=%s"\n' "${sign_in_url##*token=}" "$sign_in_csrf"
    printf 'url = "%s/admin/sign-in"\n' "$probe_origin"
  } >"$probe_auth_config"
  curl "${curl_limits[@]}" --config "$probe_auth_config"
  cookie_header="$(awk 'BEGIN{IGNORECASE=1} /^set-cookie:[[:space:]]*porchfest_session=/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$probe_headers_file")"
  probe_cookie_has_required_flags "$cookie_header" \
    || die "sign-in cookie is missing Secure, HttpOnly, or SameSite=Lax"
  probe_cookie="${cookie_header%%;*}"
  probe_cookie_result="Secure,HttpOnly,SameSite=Lax"
  probe_session_active=1
  attempt_probe_sign_out || die "could not sign out the cookie-check session"
}
