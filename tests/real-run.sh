#!/usr/bin/env bash
# Optional M2 acceptance with a real DeepSeek request, isolated from user DSH state.
set -Eeuo pipefail
set +x
umask 077
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ -z ${DEEPSEEK_API_KEY:-} && -f $repo/.env ]]; then source "$repo/.env"; fi
: "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY or use the repository .env}"
root=$(mktemp -d /tmp/mbot-real-run.XXXXXX)
export DEEPSEEK_API_KEY DSH_HOME=$root/dsh-home XDG_CONFIG_HOME=$root/config
export XDG_CACHE_HOME=$root/cache XDG_DATA_HOME=$root/data TMPDIR=$root DSH_TELEMETRY_MODE=DISABLED
export MBOT_DSH=$(command -v dsh) MBOT_TIMEOUT=180
unset MBOT_RUN_ID MBOT_BOT MBOT_GRANTS
printf 'Real acceptance workspace: %s/ws\n' "$root"
"$repo/bin/mbot" init "$root/ws"
cp "$root/ws/MEMORY.md" "$root/memory.before"
"$repo/bin/mbot" -C "$root/ws" run chief '在看板上加一个任务：整理 README'
cmp "$root/ws/MEMORY.md" "$root/memory.before"
[[ -f $root/ws/tasks/001.md && $(git -C "$root/ws" rev-list --count HEAD) == 2 ]]
[[ -z $(git -C "$root/ws" status --porcelain) ]]
meta=("$root/ws/transcripts/"*/*.meta.json)
[[ ${#meta[@]} == 1 ]]
jq -e '.success and .reason.kind=="completed" and (.violations|length)==0' "${meta[0]}" >/dev/null
"$repo/bin/botctl" -C "$root/ws" lint
"$repo/bin/mbot" -C "$root/ws" status
printf 'Real M2 acceptance passed; artifacts: %s\n' "$root"
