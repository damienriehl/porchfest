#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_dir="$(cd -- "$script_dir/.." && pwd -P)"
# shellcheck source=deploy/common.sh
source "$project_dir/deploy/common.sh"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

temp_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

dotenv_probe="$temp_dir/dotenv-probe"
dotenv_file="$temp_dir/test.env"
cat >"$dotenv_file" <<EOF
export PORCHFEST_DEPLOY_HOST="deploy-host.example" # source host
PUBLIC_BASE_URL='https://porchfest.example.test/path/' # public URL
PORCHFEST_DEPLOY_DIR=\$(touch $dotenv_probe)
EOF
(
  unset PORCHFEST_DEPLOY_HOST PUBLIC_BASE_URL PORCHFEST_DEPLOY_DIR
  load_dotenv_if_present "$dotenv_file"
  [[ "$PORCHFEST_DEPLOY_HOST" == "deploy-host.example" ]]
  [[ "$PUBLIC_BASE_URL" == "https://porchfest.example.test/path/" ]]
  [[ "$PORCHFEST_DEPLOY_DIR" == "\$(touch $dotenv_probe)" ]]
) || fail "dotenv parser rejected export/quoted-comment syntax"
[[ ! -e "$dotenv_probe" ]] || fail "dotenv parser evaluated shell syntax"

metadata="$temp_dir/evidence.json"
cat >"$metadata" <<'EOF'
{
  "archive": {"mode": "600", "when": 999},
  "counts": {
    "contacts": 1,
    "seasons": 1,
    "outbox_messages": 1,
    "acts": 1,
    "assignments": 1,
    "venues": 1
  },
  "schema": {"tag": "0001_test", "when": 123}
}
EOF
[[ "$(json_number "$metadata" schema.when)" == 123 ]] || fail "JSON number lookup ignored its object path"
[[ "$(json_string "$metadata" archive.mode)" == 600 ]] || fail "JSON string lookup ignored its object path"
expected_counts=$'seasons=1\nvenues=1\nacts=1\ncontacts=1\nassignments=1\noutbox_messages=1'
[[ "$(counts_from_json "$metadata")" == "$expected_counts" ]] || fail "JSON count parsing depends on key order"

echo "OK: deploy helpers parse dotenv and evidence JSON without shell evaluation or regex"
