#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_dir="$(cd -- "$script_dir/.." && pwd -P)"
temp_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

fake_bin="$temp_dir/bin"
mkdir -p -- "$fake_bin"
rsync_marker="$temp_dir/rsync-called"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'remote_command="${2:-}"' \
  'case "$remote_command" in' \
  '  test\ *) bash -c "$remote_command" ;;' \
  '  cd\ --\ *) : ;;' \
  '  *) exit 97 ;;' \
  'esac' >"$fake_bin/ssh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  ': >"$PORCHFEST_FAKE_RSYNC_MARKER"' >"$fake_bin/rsync"
chmod +x "$fake_bin/ssh" "$fake_bin/rsync"

remote_deploy_dir="$temp_dir/remote deploy directory"
mkdir -p -- "$remote_deploy_dir"
: >"$remote_deploy_dir/.env"
: >"$remote_deploy_dir/.porchfest-deploy-root"
ship_output="$temp_dir/ship-output.txt"
if ! PATH="$fake_bin:$PATH" \
  PORCHFEST_DEPLOY_HOST=deploy-host.example \
  PORCHFEST_DEPLOY_DIR="$remote_deploy_dir" \
  PORCHFEST_FAKE_RSYNC_MARKER="$rsync_marker" \
  bash "$project_dir/deploy/deploy.sh" >"$ship_output" 2>&1; then
  fail "ship mode rejected an existing deploy directory whose path requires quoting"
fi
[[ -e "$rsync_marker" ]] || fail "ship mode did not continue after the remote guard succeeded"

rm -f -- "$remote_deploy_dir/.porchfest-deploy-root" "$rsync_marker"
missing_marker_output="$temp_dir/missing-marker-output.txt"
if PATH="$fake_bin:$PATH" \
  PORCHFEST_DEPLOY_HOST=deploy-host.example \
  PORCHFEST_DEPLOY_DIR="$remote_deploy_dir" \
  PORCHFEST_FAKE_RSYNC_MARKER="$rsync_marker" \
  bash "$project_dir/deploy/deploy.sh" >"$missing_marker_output" 2>&1; then
  fail "ship mode accepted a deploy directory without its required root marker"
fi
grep -Fq 'remote deploy directory must exist with .env and .porchfest-deploy-root' \
  "$missing_marker_output" || fail "missing remote marker did not report the guard failure"
[[ ! -e "$rsync_marker" ]] || fail "ship mode invoked rsync after the remote guard failed"

docker_marker="$temp_dir/docker-called"
printf '%s\n' '#!/usr/bin/env bash' ': >"$PORCHFEST_FAKE_DOCKER_MARKER"' 'exit 99' >"$fake_bin/docker"
chmod +x "$fake_bin/docker"
archive_fixture="$temp_dir/archive.tar.gz"
: >"$archive_fixture"
restore_output="$temp_dir/restore-collision.txt"
if PATH="$fake_bin:$PATH" \
  PORCHFEST_FAKE_DOCKER_MARKER="$docker_marker" \
  PORCHFEST_COMPOSE_PROJECT=porchfest-test \
  PORCHFEST_DATA_VOLUME=porchfest-test-data \
  PORCHFEST_APP_IMAGE=porchfest-test:current \
  PORCHFEST_RESTORE_PROJECT=porchfest-test \
  PORCHFEST_RESTORE_VOLUME=porchfest-test-restore \
  bash "$project_dir/deploy/restore.sh" "$archive_fixture" >"$restore_output" 2>&1; then
  fail "restore accepted the production Compose project as its throwaway project"
fi
grep -Fq 'restore Compose project must differ from the production project' "$restore_output" \
  || fail "restore project collision did not report the guard"
[[ ! -e "$docker_marker" ]] || fail "restore project collision invoked Docker before refusing"

archive_state="$temp_dir/archive-state"
archive_restart_marker="$temp_dir/archive-restarted"
printf '%s\n' running >"$archive_state"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case " $* " in' \
  '  *" compose "*" ps -a -q app "* | *" compose "*" ps -q app "*) printf '\''%s\n'\'' app-container ;;' \
  '  *" compose "*" stop app "*) printf '\''%s\n'\'' exited >"$PORCHFEST_FAKE_ARCHIVE_STATE"; exit 12 ;;' \
  '  *" compose "*" start app "*) printf '\''%s\n'\'' running >"$PORCHFEST_FAKE_ARCHIVE_STATE"; : >"$PORCHFEST_FAKE_ARCHIVE_RESTARTED" ;;' \
  '  *" inspect "*"range .Mounts"*) printf '\''%s\n'\'' porchfest-test-data ;;' \
  '  *" inspect "*".State.Status"*) command cat "$PORCHFEST_FAKE_ARCHIVE_STATE" ;;' \
  '  *" inspect "*".Image"*) printf '\''%s\n'\'' sha256:app-image ;;' \
  '  *" image inspect "*".Id"*) printf '\''%s\n'\'' sha256:app-image ;;' \
  '  *" volume inspect "*) : ;;' \
  '  *" run "*) printf '\''100\ttest-schema\t0\n'\'' ;;' \
  '  *) printf '\''unexpected fake docker call: %s\n'\'' "$*" >&2; exit 98 ;;' \
  'esac' >"$fake_bin/docker"
chmod +x "$fake_bin/docker"
archive_output="$temp_dir/archive-partial-stop.txt"
if PATH="$fake_bin:$PATH" \
  PORCHFEST_FAKE_ARCHIVE_STATE="$archive_state" \
  PORCHFEST_FAKE_ARCHIVE_RESTARTED="$archive_restart_marker" \
  PORCHFEST_COMPOSE_PROJECT=porchfest-test \
  PORCHFEST_DATA_VOLUME=porchfest-test-data \
  PORCHFEST_APP_IMAGE=porchfest-test:current \
  PORCHFEST_ARCHIVE_DIR="$temp_dir/archives" \
  bash "$project_dir/deploy/archive.sh" >"$archive_output" 2>&1; then
  fail "archive unexpectedly succeeded after the injected partial stop failure"
fi
[[ -e "$archive_restart_marker" ]] || fail "archive did not restart the app after a partial stop failure"
grep -Fq 'archive_failure_app_restart=restarted' "$archive_output" \
  || fail "archive did not report the recovery restart"
grep -Fq 'archive_failure_app_state=running' "$archive_output" \
  || fail "archive did not report the recovered app state"

# shellcheck source=deploy/rollback.sh
PORCHFEST_ROLLBACK_LIB_ONLY=1 source "$project_dir/deploy/rollback.sh"
rollback_restore_dir="$temp_dir/rollback-restore"
mkdir -p -- "$rollback_restore_dir"
printf '%s\n' '#!/usr/bin/env bash' ': >"$PORCHFEST_FAKE_RESTORE_MARKER"' >"$rollback_restore_dir/restore.sh"
chmod +x "$rollback_restore_dir/restore.sh"
script_dir="$rollback_restore_dir"
data_volume=porchfest-test-data
app_image=porchfest-test:current
restore_marker="$temp_dir/safety-restored"
docker() { :; }
compose() { :; }
wait_for_app_health() { :; }
assert_pinned_volume() { :; }
export PORCHFEST_FAKE_RESTORE_MARKER="$restore_marker"
recovery_output="$temp_dir/recovery-output.txt"
recover_safety_archive porchfest-test:safety "$archive_fixture" porchfest-test-safety \
  2>"$recovery_output"
[[ -e "$restore_marker" ]] || fail "rollback recovery did not invoke the safety restore"
grep -Fq "safety_archive_restored=$archive_fixture" "$recovery_output" \
  || fail "rollback recovery did not report the restored safety archive"

compose() { return 9; }
recovery_status=0
recover_safety_archive porchfest-test:safety "$archive_fixture" porchfest-test-safety \
  2>"$recovery_output" || recovery_status=$?
[[ "$recovery_status" == 2 ]] || fail "rollback recovery did not distinguish app restart failure"
grep -Fq "safety_archive_restored=$archive_fixture" "$recovery_output" \
  || fail "rollback recovery hid the completed data restore when app startup failed"

echo "OK: deploy failure paths protect the live project, restart partial stops, and report safety recovery"
