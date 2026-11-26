#!/usr/bin/env bash
# Real model acceptance of the packaged plugin, outside its bot data repository.
set -Eeuo pipefail
set +x
shopt -s nullglob
umask 077
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ -z ${DEEPSEEK_API_KEY:-} && -f $repo/.env ]]; then source "$repo/.env"; fi
: "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY or use the repository .env}"
root=$(mktemp -d /tmp/mbot-real-plugin.XXXXXX)
mkdir -p "$root/dsh" "$root/consumer"
trap 'rm -f -- "$root/dsh/.env"; printf "Real plugin artifacts: %s\n" "$root"' EXIT
printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY" > "$root/dsh/.env"
unset DEEPSEEK_API_KEY MBOT_WS MBOT_RUN_ID MBOT_BOT MBOT_GRANTS
export DSH_HOME=$root/dsh XDG_CONFIG_HOME=$root/config XDG_STATE_HOME=$root/state XDG_CACHE_HOME=$root/cache XDG_DATA_HOME=$root/data TMPDIR=$root
export DSH_TELEMETRY_MODE=DISABLED MBOT_TIMEOUT=180
export GIT_AUTHOR_NAME='mbot real plugin' GIT_AUTHOR_EMAIL=mbot-tests@example.invalid
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
npm --prefix "$repo" pack --json --ignore-scripts --pack-destination "$root" --cache "$root/npm-cache" > "$root/pack.json"
tarball=$root/$(jq -r '.[0].filename' "$root/pack.json")
dsh plugin --profile headless add "$tarball" --store-dir "$root/pnpm-store" --ignore-scripts > "$root/install.log" 2>&1
mbot=$DSH_HOME/profiles/headless/node_modules/.bin/mbot
ws=$root/ws
"$mbot" init "$ws"
cp "$ws/MEMORY.md" "$root/memory.before"
printf '%s\n' '- id: mbot' '  config:' "    workspace: '$ws'" > "$DSH_HOME/profiles/headless/cordis.patch.yml"
git -C "$root/consumer" init -q
(
  cd "$root/consumer"
  timeout --kill-after=10s 180 dsh --profile headless --json --permission-mode danger-full-access --approval-policy never \
    '这是 dsh-mbot 插件安装验收。只使用原生 botctl 工具（不要用 bash/read/write/git）：先 action=board_add、text=插件原生安装验收、owner=chief；再 action=remember、text=以后周报一律用中文、as=chief、task_id=刚生成的任务ID；最后 action=board_show。不要修改 MEMORY，不调用 /mbot，不派子代理。简短报告结果。' \
    > "$root/native.jsonl" 2> "$root/native.stderr"
)
jq -es 'map(select(.type=="final"))|last|.reason.kind=="completed"' "$root/native.jsonl" >/dev/null
jq -es 'any(.type=="tool_call" and .tool=="botctl") and all(.type!="tool_call" or .tool=="botctl")' "$root/native.jsonl" >/dev/null
[[ $(cat "$ws/BOARD.md") == *插件原生安装验收* && -f $ws/tasks/001.md ]]
[[ $(cat "$ws/inbox/$(date +%F).md") == *周报* ]]
cmp "$ws/MEMORY.md" "$root/memory.before"
[[ -z $(git -C "$ws" status --porcelain) ]]
"$mbot" -C "$ws" dream | tee "$root/dream.output"
[[ $(cat "$ws/MEMORY.md") == *周报* && $(cat "$ws/MEMORY.md") == *中文* ]]
meta=("$ws/dream-reports/"*.meta.json)
jq -e '.success and (.violations|length)==0' "${meta[0]}" >/dev/null
"$DSH_HOME/profiles/headless/node_modules/.bin/botctl" -C "$ws" lint
[[ -z $(git -C "$ws" status --porcelain) ]]
git -C "$ws" log --oneline
printf 'Real plugin acceptance passed: native tools from a separate project, installed Bash Dreaming and clean audit commits.\n'
