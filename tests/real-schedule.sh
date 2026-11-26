#!/usr/bin/env bash
# Real M4 acceptance: two fresh Workers, then interruption of a running Worker.
set -Eeuo pipefail
shopt -s nullglob
set +x
umask 077
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
command -v zstd >/dev/null
if [[ -z ${DEEPSEEK_API_KEY:-} && -f $repo/.env ]]; then source "$repo/.env"; fi
: "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY or use the repository .env}"
root=$(mktemp -d /tmp/mbot-real-schedule.XXXXXX)
export DEEPSEEK_API_KEY DSH_HOME=$root/dsh-home XDG_CONFIG_HOME=$root/config
export XDG_CACHE_HOME=$root/cache XDG_DATA_HOME=$root/data TMPDIR=$root DSH_TELEMETRY_MODE=DISABLED
export MBOT_DSH=$(command -v dsh) MBOT_TIMEOUT=240 MBOT_GRANTS=$root/project
unset MBOT_RUN_ID MBOT_BOT
mbot=$repo/bin/mbot
ws=$root/ws
project=$root/project
printf 'Real scheduling workspace: %s\n' "$ws"
"$mbot" init "$ws"
mkdir -p "$project"
git -C "$project" init -q
git -C "$project" commit -qm 'human: project init' --allow-empty
project_head=$(git -C "$project" rev-parse HEAD)
cp "$ws/MEMORY.md" "$root/memory.before"
request="请完成一个并行开发验收。外部项目 $project 已获宿主授权，需要两个独立产物：
1. greet.sh：Bash 脚本，bash greet.sh Ada 输出 Hello, Ada!；无参数输出 Hello, world!；不得 eval 参数。
2. README.md：中文说明这个脚本的用法和预期输出，按上述接口写，独立于另一文件是否已生成。
严格建两个任务 001/002（不要额外父任务），owner 都是 coder；各自用 task result --as chief 持久写目标、输入、唯一可写文件和验收，再标 doing。
必须用原生 fresh subagent，名称分别 coder-001 和 coder-002，两个启动后才等待。每个 Worker 第一条工具命令只能是 botctl boot coder --task 对应ID；之后先执行 sleep 5（用于并发测量），然后仅写自己的文件并验收，用 task result 对应ID --as coder 记录结果。
启动两者后立即 list_agents 记录两者同时 running。等结果后 Chief 只读取产物验收，不自行写产物；验证默认及 Ada 输出、README 非空、两个任务已有 coder 结果，然后标 done。
不得自行 git commit（数据或外部项目）、不得改记忆或调用 mbot。不要只给计划，完成这次派活。"
"$mbot" -C "$ws" run chief "$request"
meta=("$ws/transcripts/"*/*.meta.json)
[[ ${#meta[@]} == 1 ]]
first_meta=${meta[0]}
first_id=$(jq -r .run_id "$first_meta")
first_session=$(jq -r .session_id "$first_meta")
jq -e --arg path "$project" '.success and .grants==[$path] and (.violations|length)==0' "$first_meta" >/dev/null
[[ $(bash "$project/greet.sh" Ada) == 'Hello, Ada!' && $(bash "$project/greet.sh") == 'Hello, world!' && -s $project/README.md ]]
[[ $(git -C "$project" rev-parse HEAD) == "$project_head" ]]
for id in 001 002; do
  [[ $(cat "$ws/tasks/$id.md") == *'[by: coder; run:'* ]]
  [[ $(cat "$ws/BOARD.md") == *"| $id | done | coder |"* ]]
done
jq -es 'any(.[]; .type=="tool_result" and (.result // "" | type)=="string" and (.result | contains("coder-001 [running]") and contains("coder-002 [running]")))' "$ws/.mbot/runs/$first_id.jsonl" >/dev/null
printf 'Real parallel acceptance passed.\n'

request="请完成中断验收，仅新建任务 003、owner coder、标 doing，并用 task result --as chief 写清验收说明。
派一个 fresh Worker，名字 coder-003。第一条工具命令只能是 botctl boot coder --task 003；第二条 bash 命令必须为 printf 'started\\n' > '$project/stuck-started'; sleep 30，模拟卡住。不要让 Worker 改其他文件或先写完成结果。
Chief 用一个 bash 轮询（每0.1秒、最多10秒）等待 $project/stuck-started 出现，确认 Worker 已进入 sleep。然后调用 interrupt_agent 中断 coder-003，等待停止、list_agents 确认 inactive，标 003 blocked --reason '人为中断验收，Worker 未完成'。
不要把003标done，不改001/002，不改记忆，不调用mbot，不提交git。"
"$mbot" -C "$ws" run chief "$request"
last=''
for file in "$ws/transcripts/"*/*.meta.json; do [[ -n $last && ! $file -nt $last ]] || last=$file; done
second_id=$(jq -r .run_id "$last")
jq -e '.success and (.violations|length)==0' "$last" >/dev/null
[[ -f $project/stuck-started && $(cat "$ws/BOARD.md") == *'| 003 | blocked | coder |'* ]]
[[ $(git -C "$project" rev-parse HEAD) == "$project_head" ]]
jq -es 'any(.[]; .type=="tool_call" and .tool=="interrupt_agent") and any(.[]; .type=="tool_result" and (.result // "" | type)=="string" and (.result|contains("coder-003 [inactive]")))' "$ws/.mbot/runs/$second_id.jsonl" >/dev/null
printf 'Real interruption acceptance passed.\n'

mkdir -p "$root/evidence/sessions"
for log in "$DSH_HOME/sessions/"*/*/session.v*.jsonl.zstd; do
  id=$(basename "$(dirname "$log")")
  zstd -dc -- "$log" > "$root/evidence/sessions/$id.jsonl"
done
workers=0
for log in "$root/evidence/sessions/"*.jsonl; do
  if ! jq -es 'any(.[]; .type=="subagent/descriptor")' "$log" >/dev/null; then continue; fi
  first=$(jq -sc '[.[]|select(.type=="assistant/message")|.data.message.content[]?|select(.type=="tool-call")][0]' "$log")
  [[ $(jq -r .name <<< "$first") == bash ]]
  command=$(jq -r '.arguments|fromjson|.command' <<< "$first")
  [[ $command == *'botctl boot coder --task 00'* ]]
  workers=$((workers+1))
done
[[ $workers == 3 ]]
cp "$ws/tasks/001.md" "$root/evidence/task001.before"
cp "$ws/tasks/002.md" "$root/evidence/task002.before"
"$mbot" -C "$ws" archive
month=$(date +%Y-%m)
cmp "$ws/tasks/archive/$month/001.md" "$root/evidence/task001.before"
cmp "$ws/tasks/archive/$month/002.md" "$root/evidence/task002.before"
[[ -f $ws/tasks/003.md && ! -e $ws/tasks/001.md && ! -e $ws/tasks/002.md ]]
[[ $(git -C "$ws" log -1 --format=%s) == 'chore(archive):'* ]]
cmp "$ws/MEMORY.md" "$root/memory.before"
"$repo/bin/botctl" -C "$ws" lint
[[ -z $(git -C "$ws" status --porcelain) ]]
"$mbot" -C "$ws" status
printf 'Real M4 scheduling acceptance passed; artifacts: %s\n' "$root"
