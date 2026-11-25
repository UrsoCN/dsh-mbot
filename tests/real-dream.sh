#!/usr/bin/env bash
# Optional real-provider acceptance of the M3 memory loop.
set -Eeuo pipefail
set +x
umask 077
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ -z ${DEEPSEEK_API_KEY:-} && -f $repo/.env ]]; then source "$repo/.env"; fi
: "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY or use the repository .env}"
root=$(mktemp -d /tmp/mbot-real-dream.XXXXXX)
export DEEPSEEK_API_KEY DSH_HOME=$root/dsh-home XDG_CONFIG_HOME=$root/config
export XDG_CACHE_HOME=$root/cache XDG_DATA_HOME=$root/data TMPDIR=$root DSH_TELEMETRY_MODE=DISABLED
export MBOT_DSH=$(command -v dsh) MBOT_TIMEOUT=180 MBOT_DREAM_MAX_BYTES=64000
unset MBOT_RUN_ID MBOT_BOT MBOT_GRANTS
mbot=$repo/bin/mbot
ws=$root/ws
printf 'Real memory-loop workspace: %s\n' "$ws"
"$mbot" init "$ws"
cp "$ws/MEMORY.md" "$root/memory.before"
"$mbot" -C "$ws" run chief '以后周报一律用中文，记住这条'
cmp "$ws/MEMORY.md" "$root/memory.before"
[[ -f $ws/inbox/$(date +%F).md ]]
[[ $(cat "$ws/inbox/$(date +%F).md") != *'- --help '* ]]
"$mbot" -C "$ws" dream
dream_commit=$(git -C "$ws" rev-parse HEAD)
[[ $(git -C "$ws" log -1 --format=%s) == 'dream:'* ]]
[[ $(cat "$ws/MEMORY.md") == *周报* && $(cat "$ws/MEMORY.md") == *中文* ]]
[[ $(cat "$ws/MEMORY.md") == *"added: $(date +%F)"* ]]
meta=("$ws/dream-reports/"*.meta.json)
[[ ${#meta[@]} == 1 ]]
jq -e '.success and .mode=="dream" and (.violations|length)==0' "${meta[0]}" >/dev/null
"$mbot" -C "$ws" run chief 'Draft a short weekly report with three sections: Completed, Next, Risks.' | tee "$root/weekly-answer"
[[ $(cat "$root/weekly-answer") == *风险* && ( $(cat "$root/weekly-answer") == *完成* || $(cat "$root/weekly-answer") == *本周* ) ]]
git -C "$ws" revert --no-edit "$dream_commit"
cmp "$ws/MEMORY.md" "$root/memory.before"
"$repo/bin/botctl" -C "$ws" lint
[[ -z $(git -C "$ws" status --porcelain) ]]
"$mbot" -C "$ws" status
printf 'Real M3 memory-loop acceptance passed; artifacts: %s\n' "$root"
