#!/usr/bin/env bash
# Real-provider M0 probe. All generated state stays in a fresh /tmp directory.
set -euo pipefail
set +x
umask 077

scenario=${1:-all}
case $scenario in
  baseline|permissions|subagents|patch|interrupt|all) ;;
  *) printf 'Usage: bash tests/m0-spike.sh [baseline|permissions|subagents|patch|interrupt|all]\n' >&2; exit 2 ;;
esac

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
dsh_bin=$(command -v "${MBOT_DSH:-dsh}")
node_bin=$(command -v node)
for tool in git jq flock timeout zstd; do
  command -v "$tool" >/dev/null || { printf 'Missing dependency: %s\n' "$tool" >&2; exit 1; }
done

# Never print the key or pass it on a process command line.
if [[ -z ${DEEPSEEK_API_KEY:-} && -f $repo/.env ]]; then
  source "$repo/.env"
fi
: "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY or put it in the repository .env}"

spike=$(mktemp -d /tmp/mbot-m0.XXXXXX)
outside=$(mktemp -d "$repo/.m0-outside.XXXXXX")
# Only remove fixtures owned by this invocation. Keep logs, remove the key.
trap 'rm -f -- "$spike/dsh-home/.env"; rm -rf -- "$outside"' EXIT
mkdir -p "$spike/dsh-home" "$spike/ws/.mbot" "$spike/tools" "$spike/outside" "$spike/logs"
printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY" > "$spike/dsh-home/.env"
unset DEEPSEEK_API_KEY
printf 'M0 artifacts: %s\n' "$spike"

git -C "$spike/ws" init -q
cat > "$spike/ws/AGENTS.md" <<'EOF'
# M0 test protocol
Every final answer must begin with M0_AGENTS_LOADED_7C91.
Do not read any .env file, credentials, or API keys. Never commit.
Only perform the explicitly requested M0 probes.
EOF
printf 'inside-original\n' > "$spike/ws/inside.txt"
printf 'outside-original\n' > "$outside/denied.txt"
cat > "$spike/tools/botctl-probe" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p .mbot
flock .mbot/botctl.lock bash -c 'printf "external-script-ok run=%s\n" "$MBOT_RUN_ID" >> .mbot/probe.log'
printf 'external-script-ok run=%s\n' "$MBOT_RUN_ID"
EOF

cat > "$spike/interrupt.patch.yml" <<'EOF'
- id: tool-subagent-control
  config:
    interrupt: true
EOF
chmod +x "$spike/tools/botctl-probe"

cat > "$spike/model.patch.yml" <<'EOF'
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
EOF

# An empty cron-like environment: the key is only in the isolated DSH_HOME.
# Preserve the actual HOME; redirect DSH and XDG state explicitly instead.
run() {
  local name=$1 prompt=$2
  shift 2
  local start end rc=0
  start=$(date +%s%3N)
  (
    cd "$spike/ws"
    env -i HOME="$HOME" DSH_HOME="$spike/dsh-home" \
      XDG_CACHE_HOME="$spike/cache" XDG_CONFIG_HOME="$spike/config" \
      XDG_DATA_HOME="$spike/data" TMPDIR="$spike" \
      PATH="$spike/tools:$(dirname -- "$dsh_bin"):$(dirname -- "$node_bin"):/usr/bin:/bin" \
      MBOT_RUN_ID=M0_RUN_7C91 MBOT_BOT=chief DSH_TELEMETRY_MODE=DISABLED \
      timeout --kill-after=10s "${MBOT_SPIKE_TIMEOUT:-300}s" \
      "$dsh_bin" --profile headless "$@" --json \
      --permission-mode workspace-write --approval-policy never "$prompt"
  ) > "$spike/logs/$name.jsonl" 2> "$spike/logs/$name.stderr" || rc=$?
  end=$(date +%s%3N)
  jq -n --arg name "$name" --argjson exit_code "$rc" --argjson elapsed_ms "$((end-start))" \
    '{name: $name, exit_code: $exit_code, elapsed_ms: $elapsed_ms}' > "$spike/logs/$name.metrics.json"
  printf '%s: exit=%s elapsed=%sms\n' "$name" "$rc" "$((end-start))"
  if [[ -s $spike/logs/$name.jsonl ]]; then
    jq -s '{events: (map(.type) | unique), final: (map(select(.type == "final")) | last)}' \
      "$spike/logs/$name.jsonl"
  fi
  if (( rc != 0 )) || ! jq -es 'any(.[]; .type == "final" and .reason.kind == "completed")' \
    "$spike/logs/$name.jsonl" >/dev/null; then
    printf 'Incomplete run: inspect %s/logs/%s.stderr\n' "$spike" "$name" >&2
    failures=$((failures+1))
  fi
}

failures=0
check() {
  local label=$1
  shift
  if "$@" >/dev/null; then
    printf 'PASS: %s\n' "$label"
  else
    printf 'FAIL: %s\n' "$label" >&2
    failures=$((failures+1))
  fi
}

if [[ $scenario == baseline || $scenario == all ]]; then
    run baseline '列出当前目录。只调用一次 bash 执行 pwd 和 ls -a，然后给出简短回答。'
    check 'root AGENTS.md loaded' jq -es \
      'any(.[]; .type == "final" and (.text | startswith("M0_AGENTS_LOADED_7C91")))' \
      "$spike/logs/baseline.jsonl"
fi
if [[ $scenario == permissions || $scenario == all ]]; then
    run permissions "执行以下 M0 探针，仅执行列出的操作，完成后立即简短报告，不要探索日志或尝试恢复文件：1. 用 read 读取 inside.txt；用 write 新建 fs-created.txt 内容 fs-ok。2. 用 bash 执行 printf 'bash-ok\\n' > bash-created.txt，然后执行 botctl-probe，并用 printf '%s\\n' \"\$MBOT_RUN_ID\" 和 command -v botctl-probe 检查继承的环境。3. 用 write 尝试把 $outside/denied.txt 写成 overwritten。4. 用 bash 尝试 printf 'overwritten\\n' > $outside/denied.txt。第 3、4 项用于测试越界，应被拒；只记录实际结果，不规避失败、不申请提权、不修复探针文件。不要读 .env。"
    check 'filesystem write inside workspace' test "$(cat "$spike/ws/fs-created.txt")" = fs-ok
    check 'bash write inside workspace' test "$(cat "$spike/ws/bash-created.txt")" = bash-ok
    check 'outside fixture unchanged' test "$(cat "$outside/denied.txt")" = outside-original
    check 'external script and flock' test "$(cat "$spike/ws/.mbot/probe.log")" = 'external-script-ok run=M0_RUN_7C91'
fi
if [[ $scenario == subagents || $scenario == all ]]; then
    run subagents '这是 M0 子代理探针。使用两次 subagent 工具，分别命名 probe-a、probe-b；必须在等待任何结果之前启动两者，使用 fresh subagent，不要 fork。每个 prompt 仅包含以下任务（不要转述 AGENTS.md 的口令）：用 bash 执行 botctl-probe，报告 MBOT_RUN_ID 的值和 command -v botctl-probe 的结果；执行 sleep 5；然后尝试 subagent 派一个只回复 depth-probe 的孙代理，记录拒绝原因；最后报告结果。父代理用 list_agents 记录并发情况。等待两者完成后，使用 send_message 给已完成的 probe-a，要求用 bash 写 resumed.txt 内容 resumed-ok 然后回复 resumed-ok；等待恢复轮完成，确认结果。最终简短汇报口令、环境、并发、深度和恢复行为。不要读取 .env。'
fi
if [[ $scenario == patch || $scenario == all ]]; then
    run patch '只回答模型切换探针完成，不调用工具。' --patch "$spike/model.patch.yml"
fi
if [[ $scenario == interrupt || $scenario == all ]]; then
    run interrupt 'M0 中断探针：启动一个名为 slow-probe 的 fresh subagent，prompt 为“只用 bash 执行 sleep 60，然后回复 finished，不做其他事”。用 list_agents 确认子代理 running，父代理用 bash 执行 sleep 3，然后调用 interrupt_agent 中断 slow-probe；记录工具的实际返回，再用 list_agents 检查状态。只做这些操作，不读 .env，最后简短汇报。' --patch "$spike/interrupt.patch.yml"
    check 'interrupt_agent called' jq -es \
      'any(.[]; .type == "tool_call" and .tool == "interrupt_agent")' \
      "$spike/logs/interrupt.jsonl"
fi

# Inspect child evidence without replaying a child's assertions through its parent.
mkdir -p "$spike/logs/sessions"
shopt -s nullglob
for session_log in "$spike/dsh-home/sessions/"*/*/session.v*.jsonl.zstd; do
  session_id=$(basename -- "$(dirname -- "$session_log")")
  zstd -dc -- "$session_log" > "$spike/logs/sessions/$session_id.jsonl"
done
if [[ $scenario == subagents || $scenario == all ]]; then
  check 'completed child resumed and wrote result' test "$(cat "$spike/ws/resumed.txt")" = resumed-ok
  check 'two workers observed running' jq -es \
    'any(.[]; .type == "tool_result" and (.result // "" | contains("probe-a [running]") and contains("probe-b [running]")))' \
    "$spike/logs/subagents.jsonl"
  child_count=$(jq -s '[.[] | select(.type == "subagent/descriptor")] | length' "$spike/logs/sessions/"*.jsonl)
  check 'fresh child sessions persisted' test "$child_count" -ge 2
  check 'runtime rejected grandchild delegation' jq -es \
    'any(.[]; .type == "tool/result" and any(.data.message.content[]?; .text? == "Error: subagent depth 2 exceeds maxDepth 1"))' \
    "$spike/logs/sessions/"*.jsonl
  instructed_children=0
  for session_log in "$spike/logs/sessions/"*.jsonl; do
    if jq -es 'any(.[]; .type == "subagent/descriptor") and any(.[];
      .type == "assistant/message" and any(.data.message.content[]?;
        .type == "text" and (.text | startswith("M0_AGENTS_LOADED_7C91"))))' "$session_log" >/dev/null; then
      instructed_children=$((instructed_children+1))
    fi
  done
  check 'both fresh workers loaded AGENTS.md' test "$instructed_children" -ge 2
fi
if [[ $scenario == patch || $scenario == all ]]; then
  patch_id=$(jq -r 'select(.type == "session") | .sessionId' "$spike/logs/patch.jsonl")
  check 'patch selected real deepseek-v4-pro response' jq -es \
    'any(.[]; .type == "assistant/message" and .data.message.source.model == "deepseek-v4-pro")' \
    "$spike/logs/sessions/$patch_id.jsonl"
fi
printf 'M0 probe failures: %s; evidence: %s/logs\n' "$failures" "$spike"
(( failures == 0 ))
