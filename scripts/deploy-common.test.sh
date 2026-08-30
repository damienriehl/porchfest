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

growth_output="$temp_dir/growth.txt"
actual_counts=$'seasons=1\nvenues=1\nacts=2\ncontacts=3\nassignments=1\noutbox_messages=1'
assert_counts_match_json "$metadata" "$actual_counts" >"$growth_output"
grep -Fq '+1 acts during the window' "$growth_output" || fail "count growth was not reported"
grep -Fq '+2 contacts during the window' "$growth_output" || fail "contact growth was not reported"
if (assert_counts_match_json "$metadata" $'seasons=1\nvenues=0\nacts=1\ncontacts=1\nassignments=1\noutbox_messages=1') >/dev/null 2>&1; then
  fail "count comparator accepted a decrease"
fi
if (assert_counts_match_json "$metadata" $'seasons=2\nvenues=1\nacts=1\ncontacts=1\nassignments=1\noutbox_messages=1') >/dev/null 2>&1; then
  fail "count comparator accepted a season increase"
fi
assert_counts_equal_json "$metadata" "$expected_counts"

for image_and_expected in \
  'porchfest|porchfest:prev-project' \
  'ghcr.io/x/porchfest|ghcr.io/x/porchfest:prev-project' \
  'localhost:5000/porchfest|localhost:5000/porchfest:prev-project' \
  'localhost:5000/porchfest:current|localhost:5000/porchfest:prev-project'; do
  image_ref="${image_and_expected%%|*}"
  expected_ref="${image_and_expected#*|}"
  [[ "$(image_tag_ref "$image_ref" prev-project)" == "$expected_ref" ]] \
    || fail "tag derivation failed for $image_ref"
done

app_image="localhost:5000/porchfest:current"
compose_project="smoke-123"
[[ "$(rollback_image_ref)" == 'localhost:5000/porchfest:prev-smoke-123' ]] \
  || fail "rollback tag is not compose-project scoped"

echo "OK: deploy helpers parse dotenv/JSON safely, tolerate count growth, and derive scoped tags"
