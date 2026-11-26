#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
MBOT_ROOT=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/.." && pwd -P)
source "$MBOT_ROOT/lib/config.sh"
[[ ! -v MBOT_RUN_ID ]] || { mbot_error 'Bots must not invoke cron-run'; exit 1; }
if [[ ${1:-} == -C ]]; then
  [[ $# -ge 2 && -n $2 ]] || { mbot_error '-C requires a directory'; exit 2; }
  MBOT_CLI_WS=$2; shift 2
fi
[[ $# == 1 && ( $1 == tick || $1 == nightly ) ]] || { mbot_error 'usage: cron-run.sh [-C dir] tick|nightly'; exit 2; }
action=$1
mbot_select_workspace
cli=(-C "$MBOT_WS")
log_dir=$(realpath -m -- "${XDG_STATE_HOME:-$HOME/.local/state}/mbot/logs")
for protected in "$MBOT_WS" "$MBOT_ROOT" "$(realpath -m -- "${DSH_HOME:-$HOME/.dsh}")"; do
  [[ $log_dir != "$protected" && $log_dir != "$protected/"* ]] || { mbot_error 'cron log directory must be outside workspace/framework/DSH_HOME'; exit 1; }
done
mkdir -p -- "$log_dir"
log=$(mktemp "$log_dir/$(date -u +%Y%m%dT%H%M%SZ)-$action.XXXXXX.log")
rc=0
(
  printf 'Start UTC: %s; action: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$action"
  if [[ $action == tick ]]; then "$MBOT_ROOT/bin/mbot" "${cli[@]}" tick
  else "$MBOT_ROOT/bin/mbot" "${cli[@]}" archive && "$MBOT_ROOT/bin/mbot" "${cli[@]}" dream; fi
) > "$log" 2>&1 || rc=$?
printf '\nExit: %s; end UTC: %s\n' "$rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$log"
printf 'cron %s: exit=%s; log=%s\n' "$action" "$rc" "$log"
exit "$rc"
