#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
repo=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/.." && pwd -P)
[[ ! -v MBOT_RUN_ID ]] || { printf 'Bots must not invoke recovery.\n' >&2; exit 1; }
[[ $# == 1 && -n $1 ]] || { printf 'Usage: recover.sh <workspace repository or URL>\n' >&2; exit 2; }
root=$(mktemp -d /tmp/mbot-recover.XXXXXX)
printf 'Recovery artifacts: %s\n' "$root"
git -c core.hooksPath=/dev/null clone --no-hardlinks -- "$1" "$root/ws"
export MBOT_GRANTS='' MBOT_PUSH_AFTER_DREAM=0
"$repo/bin/botctl" -C "$root/ws" lint
base=$(git -C "$root/ws" rev-parse HEAD)
"$repo/bin/mbot" -C "$root/ws" run chief '这是恢复演练，只读检查，不派活、不修改看板/任务/inbox。请说明你是谁、看板状态以及共享记忆中的规则。只允许宿主生成本次 transcript。'
[[ $(git -C "$root/ws" rev-parse HEAD) != "$base" && $(git -C "$root/ws" log -1 --format=%s) == 'run(chief):'* ]]
meta=$(git -C "$root/ws" diff-tree --no-commit-id --name-only -r HEAD -- 'transcripts/*.meta.json')
[[ -n $meta && $meta != *$'\n'* ]]
jq -e '.success and (.violations|length)==0 and .grants==[]' "$root/ws/$meta" >/dev/null
git -C "$root/ws" diff --quiet "$base" HEAD -- . ':!transcripts'
[[ -z $(git -C "$root/ws" status --porcelain) ]]
printf 'Recovery cold-start check passed; restored data unchanged; artifacts: %s\n' "$root"
