#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_dir="$(cd -- "$script_dir/.." && pwd -P)"
# shellcheck source=deploy/common.sh
source "$project_dir/deploy/common.sh"
# shellcheck source=deploy/probe.sh
source "$project_dir/deploy/probe.sh"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

temp_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

fake_state="$temp_dir/admin-attempts"
signout_marker="$temp_dir/signed-out"

compose() {
  if [[ "$*" == *" node -e "* ]]; then
    printf '%s\n' 'https://porchfest.example.test'
    return 0
  fi
  if [[ "${FAKE_LINK_FAIL:-0}" == 1 ]]; then
    printf '%s\n' 'Organizer "missing" was not found.' >&2
    return 1
  fi
  printf '%s\n' '  Porchfest organizer sign-in link for organizer@porchfest.example.test:'
  printf '%s\n' '    https://porchfest.example.test/admin/sign-in?token=recovery-token'
}

curl() {
  local config="" dump_header="" arg url=""
  local -a args=("$@")
  for ((index = 0; index < ${#args[@]}; index++)); do
    arg="${args[index]}"
    case "$arg" in
      --config) config="${args[index + 1]}" ;;
      --dump-header) dump_header="${args[index + 1]}" ;;
    esac
  done
  if [[ -z "$config" ]]; then
    if [[ " $* " == *" --write-out "* ]]; then
      [[ "${args[-1]}" == 'https://porchfest.example.test/health' ]] || return 90
      printf '%s' '2 200'
      return 0
    fi
    [[ "${args[-1]}" == 'http://porchfest.example.test/health' ]] || return 91
    printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://porchfest.example.test/health\r\n\r\n' >"$dump_header"
    return 0
  fi

  url="$(sed -n 's/^url = "\(.*\)"$/\1/p' "$config")"
  dump_header="$(sed -n 's/^dump-header = "\(.*\)"$/\1/p' "$config")"
  if [[ "$url" == 'https://porchfest.example.test/admin/sign-in' && \
        "$(sed -n '/^request = "POST"$/p' "$config")" == "" ]]; then
    : >"$dump_header"
    printf '%s\n' '<form><input name="_csrf" value="page-csrf"></form>'
  elif [[ "$url" == *'/admin/sign-in?token='* ]]; then
    : >"$dump_header"
    printf '%s\n' '<form><input name="_csrf" value="sign-in-csrf"></form>'
  elif [[ "$url" == 'https://porchfest.example.test/admin/sign-in' ]]; then
    printf 'HTTP/2 303\r\nSet-Cookie: porchfest_session=session-token; Path=/; Secure; HttpOnly; SameSite=Lax\r\n\r\n' >"$dump_header"
  elif [[ "$url" == 'https://porchfest.example.test/admin' ]]; then
    attempts=0
    [[ ! -f "$fake_state" ]] || attempts="$(<"$fake_state")"
    printf '%s\n' "$((attempts + 1))" >"$fake_state"
    if ((attempts == 0)); then
      return 92
    fi
    printf '%s\n' '<form action="/admin/sign-out">'
    printf '%s\n' '<input name="_csrf" value="sign-out-csrf">'
  elif [[ "$url" == 'https://porchfest.example.test/admin/sign-out' ]]; then
    : >"$signout_marker"
  else
    return 93
  fi
}

export PUBLIC_BASE_URL='https://porchfest.example.test/path/'
export PORCHFEST_EXTERNAL_CONNECT_TIMEOUT=1
export PORCHFEST_EXTERNAL_MAX_TIME=2
export PORCHFEST_DEPLOY_PROBE_ORGANIZER=organizer@porchfest.example.test
export TMPDIR="$temp_dir"

probe_output="$temp_dir/probe-output.txt"
if (external_checks) >"$probe_output" 2>&1; then
  fail "forced post-login probe failure unexpectedly succeeded"
fi
[[ -f "$signout_marker" ]] || fail "EXIT cleanup did not sign out the temporary session"
grep -Fq 'probe cleanup: signed out the temporary organizer session' "$probe_output" \
  || fail "EXIT cleanup did not report the sign-out"
if find "$temp_dir" -maxdepth 1 -type f -name 'tmp.*' | grep -q .; then
  fail "probe EXIT cleanup left temporary files behind"
fi

unset PORCHFEST_DEPLOY_PROBE_ORGANIZER
skip_output="$(external_checks)"
[[ "$skip_output" == *'probe: skipped — no organizer configured (set PORCHFEST_DEPLOY_PROBE_ORGANIZER)'* ]] \
  || fail "unconfigured organizer probe did not print the required skip"

export PORCHFEST_DEPLOY_PROBE_ORGANIZER=missing
export FAKE_LINK_FAIL=1
link_output="$temp_dir/link-output.txt"
if (external_checks) >"$link_output" 2>&1; then
  fail "organizer-link failure unexpectedly succeeded"
fi
grep -Fq 'Organizer "missing" was not found.' "$link_output" \
  || fail "organizer-link stderr was not surfaced"

echo "OK: deploy probe normalizes origins, skips fresh installs, surfaces link errors, and signs out on failure"
