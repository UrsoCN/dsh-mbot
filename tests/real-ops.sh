#!/usr/bin/env bash
# M5 day-zero rehearsal with real DSH, never a seven-day acceptance claim.
set -Eeuo pipefail
set +x
shopt -s nullglob
umask 077
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ -z ${DEEPSEEK_API_KEY:-} && -f $repo/.env ]]; then source "$repo/.env"; fi
: "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY or use the repository .env}"
root=$(mktemp -d /tmp/mbot-real-ops.XXXXXX)
trap 'rm -f -- "$root/dsh/.env"; printf "M5 rehearsal artifacts: %s\n" "$root"' EXIT
mkdir -p "$root/dsh"
printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY" > "$root/dsh/.env"
unset DEEPSEEK_API_KEY MBOT_RUN_ID MBOT_BOT MBOT_GRANTS
ws=$root/ws
cron_env=(env -i HOME="$HOME" PATH="$PATH" DSH_HOME="$root/dsh" DSH_TELEMETRY_MODE=DISABLED
  XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state" XDG_CACHE_HOME="$root/cache" XDG_DATA_HOME="$root/data" TMPDIR="$root"
  MBOT_WS="$ws" MBOT_DSH="$(command -v dsh)" MBOT_TIMEOUT=180 MBOT_PUSH_AFTER_DREAM=1 MBOT_PUSH_TIMEOUT=10
  GIT_AUTHOR_NAME='mbot ops acceptance' GIT_AUTHOR_EMAIL=mbot-tests@example.invalid
  GIT_COMMITTER_NAME='mbot ops acceptance' GIT_COMMITTER_EMAIL=mbot-tests@example.invalid)
printf 'Real M5 workspace: %s\n' "$ws"
printf '%s\n' "${cron_env[@]}" > "$root/cron-env.txt"
"${cron_env[@]}" "$repo/bin/mbot" init "$ws"
cp "$ws/MEMORY.md" "$root/memory.before"
"${cron_env[@]}" "$repo/bin/botctl" remember '以后周报一律用中文'
"${cron_env[@]}" "$repo/bin/botctl" board add 'M5 已完成的归档演练任务'
"${cron_env[@]}" "$repo/bin/botctl" board set 001 done
cp "$ws/tasks/001.md" "$root/task.before"
branch=$(git -C "$ws" symbolic-ref HEAD)
git init --bare -q "$root/backup.git"
git -C "$ws" remote add origin "$root/backup.git"
git -C "$ws" push -qu origin "$branch"
"${cron_env[@]}" "$repo/ops/cron-run.sh" nightly | tee "$root/nightly.output"
[[ $(git -C "$ws" log -1 --format=%s) == 'dream:'* ]]
[[ $(git -C "$ws" log -1 --skip=1 --format=%s) == 'chore(archive):'* ]]
dream_commit=$(git -C "$ws" rev-parse HEAD)
cmp "$ws/tasks/archive/$(date +%Y-%m)/001.md" "$root/task.before"
[[ $(cat "$ws/MEMORY.md") == *周报* && $(cat "$ws/MEMORY.md") == *中文* ]]
metas=("$ws/dream-reports/"*.meta.json)
[[ ${#metas[@]} == 1 ]]
jq -e '.success and .grants==[] and (.violations|length)==0' "${metas[0]}" >/dev/null
pushes=("$ws/.mbot/runs/"*.push.json)
jq -e '.attempted and .success' "${pushes[0]}" >/dev/null
[[ $(git --git-dir="$root/backup.git" rev-parse "$branch") == "$dream_commit" ]]
"${cron_env[@]}" "$repo/bin/mbot" pause 'M5 PAUSED rehearsal'
"${cron_env[@]}" "$repo/ops/cron-run.sh" nightly | tee "$root/paused.output"
[[ $(git -C "$ws" rev-parse HEAD) == "$dream_commit" ]]
"${cron_env[@]}" "$repo/bin/mbot" resume
"${cron_env[@]}" "$repo/ops/recover.sh" "$ws" | tee "$root/recovery.output"
[[ $(git -C "$ws" rev-parse HEAD) == "$dream_commit" ]]
"${cron_env[@]}" git -C "$ws" revert --no-edit "$dream_commit"
cmp "$ws/MEMORY.md" "$root/memory.before"
"${cron_env[@]}" "$repo/bin/botctl" lint
"${cron_env[@]}" "$repo/ops/observe.sh" 'Day-zero rehearsal: real empty-env nightly, local backup, clone cold-start, PAUSED/resume and dream revert passed. Seven-day continuous observation pending.'
[[ -z $(git -C "$ws" status --porcelain) ]]
[[ ! -e $ws/.mbot/PAUSED && $(cat "$ws/.mbot/failures") == 0 ]]
"${cron_env[@]}" "$repo/bin/mbot" status
git -C "$ws" log --oneline -8
printf 'Real M5 day-zero rehearsal passed; seven-day acceptance remains pending.\n'
