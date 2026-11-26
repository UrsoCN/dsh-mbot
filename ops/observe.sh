#!/usr/bin/env bash
# Human daily snapshot; elapsed time is evidence, never automatic acceptance.
set -Eeuo pipefail
shopt -s nullglob globstar
umask 077
MBOT_ROOT=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/.." && pwd -P)
for lib in config ws lint board guard render run; do source "$MBOT_ROOT/lib/$lib.sh"; done
[[ ! -v MBOT_RUN_ID ]] || { mbot_error 'Bots must not invoke observation'; exit 1; }
if [[ ${1:-} == -C ]]; then
  [[ $# -ge 2 && -n $2 ]] || { mbot_error '-C requires a directory'; exit 2; }
  MBOT_CLI_WS=$2; shift 2
fi
[[ $# == 1 ]] && mbot_line "$1" || { mbot_error 'usage: observe.sh [-C dir] "manual review note"'; exit 2; }
note=$1
mbot_load_workspace
exec 8> "$(mbot_path .mbot/lock)"
flock -n 8 || { mbot_error 'a run is active; observe after it finishes'; exit 1; }
exec 9> "$(mbot_path .mbot/botctl.lock)"
flock 9
file=$(mbot_path wiki/ops-log.md)
MBOT_SCRATCH=$(mktemp -d /tmp/mbot-observe.XXXXXX)
trap 'rm -rf -- "$MBOT_SCRATCH"' EXIT
mbot_capture_secrets
lint_rc=0
mbot_lint > "$MBOT_SCRATCH/lint" 2>&1 || lint_rc=$?
mbot_status > "$MBOT_SCRATCH/status"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
start=''
[[ ! -f $file ]] || start=$(sed -n 's/^Observation start UTC: //p' "$file")
[[ ! -f $file || -n $start ]] || { mbot_error 'existing ops-log lacks Observation start UTC marker'; exit 1; }
if [[ -z $start || $start == pending ]]; then start=$now; fi
[[ $start =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { mbot_error 'invalid observation start'; exit 1; }
hours=$((($(date -u +%s)-$(date -u -d "$start" +%s))/3600))
latest_dream=$(git -C "$MBOT_WS" log -1 --format='%h %aI %s' --grep='^dream\((failed)\)\?:' || true)
audits=("$MBOT_WS/transcripts/"*/*.meta.json "$MBOT_WS/dream-reports/"*.meta.json)
violations=0
if ((${#audits[@]})); then violations=$(jq -s '[.[].violations[]] | length' "${audits[@]}"); fi
{
  printf '\n## %s（人工快照）\n\n' "$(date +%F)"
  printf 'UTC: %s; elapsed whole hours: %s; lint exit: %s\n' "$now" "$hours" "$lint_rc"
  printf 'Latest dream commit: %s\n' "${latest_dream:-none}"
  printf 'Retained audit violations: %s（是否已处理须人工复核）\n' "$violations"
  printf 'Manual note: %s\n\n' "$note"
  sed 's/^/    /' "$MBOT_SCRATCH/status" "$MBOT_SCRATCH/lint"
} | jq -Rs . | mbot_scrub | jq -r . > "$MBOT_SCRATCH/entry"
observe_write() {
  if [[ ! -f $file ]]; then
    printf '# 运行观察\n\nObservation start UTC: %s\n\n连续 7 天验收待人工确认；快照不代表调度已连续运行。\n' "$start" > "$file"
  else
    sed "s/^Observation start UTC: pending$/Observation start UTC: $start/" "$file" > "$MBOT_SCRATCH/previous"
    cat "$MBOT_SCRATCH/previous" > "$file"
  fi
  cat "$MBOT_SCRATCH/entry" >> "$file"
  mbot_budget "$file" "$MBOT_WIKI_MAX_LINES" lines
}
MBOT_CHANGED=(wiki/ops-log.md)
mbot_transaction "ops snapshot $(date +%F)" observe_write
printf 'Observation recorded: %s; elapsed whole hours=%s; lint exit=%s; acceptance pending.\n' "$file" "$hours" "$lint_rc"
exit "$lint_rc"
