#!/usr/bin/env bash

mbot_failure_count() {
  local file value=0
  file=$(mbot_path .mbot/failures)
  [[ ! -f $file ]] || value=$(cat -- "$file")
  [[ $value =~ ^[0-9]{1,8}$ ]] || { mbot_error 'invalid failure counter'; return 1; }
  printf '%s\n' "$((10#$value))"
}
mbot_pause() {
  [[ ! -v MBOT_RUN_ID ]] || { mbot_error 'Bots must not call mbot pause/resume'; return 1; }
  [[ $# -le 1 ]] || { mbot_error 'usage: mbot pause [reason]'; return 1; }
  local file
  file=$(mbot_path .mbot/PAUSED)
  mbot_line "${1:-Paused by human}" || { mbot_error 'pause reason must be a single line'; return 1; }
  printf '%s\n' "${1:-Paused by human}" > "$file"
  printf 'Paused. Current run may finish; future runs will skip.\n'
}
mbot_resume() {
  [[ ! -v MBOT_RUN_ID ]] || { mbot_error 'Bots must not call mbot pause/resume'; return 1; }
  [[ $# == 0 ]] || { mbot_error 'usage: mbot resume'; return 1; }
  local lock paused
  lock=$(mbot_path .mbot/lock); paused=$(mbot_path .mbot/PAUSED)
  exec 8> "$lock"
  flock -n 8 || { mbot_error 'a run is active; resume after it finishes'; return 1; }
  rm -f -- "$paused"
  printf '0\n' > "$(mbot_path .mbot/failures)"
  printf 'Resumed; consecutive failures reset.\n'
}
mbot_status() {
  [[ $# == 0 ]] || { mbot_error 'usage: mbot status'; return 1; }
  local file latest=''
  printf 'Workspace: %s\nConsecutive failures: %s\n' "$MBOT_WS" "$(mbot_failure_count)"
  file=$(mbot_path .mbot/PAUSED)
  if [[ -f $file ]]; then printf 'PAUSED: %s\n' "$(cat -- "$file")"; else printf 'PAUSED: no\n'; fi
  for file in "$MBOT_WS/transcripts/"*/*.meta.json; do [[ -n $latest && ! $file -nt $latest ]] || latest=$file; done
  if [[ -n $latest ]]; then jq -r '"Latest: " + .run_id + " success=" + (.success|tostring)' "$latest"; else printf 'Latest: none\n'; fi
  mbot_rows | awk -F '|' '{n[$2]++} END {printf "Board: todo=%d doing=%d blocked=%d done=%d\n",n["todo"],n["doing"],n["blocked"],n["done"]}'
  for file in "$MBOT_WS/MEMORY.md" "$MBOT_WS/bots/"*/MEMORY.md; do
    printf '%s: %s lines/%s, %s characters/%s\n' "${file#"$MBOT_WS/"}" "$(awk 'END{print NR}' "$file")" "$MBOT_MEMORY_MAX_LINES" "$(LC_ALL=C.UTF-8 wc -m < "$file")" "$MBOT_MEMORY_MAX_CHARS"
  done
}

mbot_run() {
  [[ ! -v MBOT_RUN_ID ]] || { mbot_error 'nested mbot run is forbidden (MBOT_RUN_ID is set)'; return 1; }
  local bot=chief request task='' lock base_failures rc=0 start elapsed summary
  [[ $# -ge 1 ]] || { mbot_error 'usage: mbot run [bot] "request" [--task id]'; return 1; }
  if [[ $# == 1 || ${2:-} == --task ]]; then request=$1; shift; else bot=$1 request=$2; shift 2; fi
  [[ $# == 0 || ( $# == 2 && $1 == --task ) ]] || { mbot_error 'usage: mbot run [bot] "request" [--task id]'; return 1; }
  task=${2:-}
  [[ -n ${request//[[:space:]]/} ]] || { mbot_error 'request must not be empty'; return 1; }
  if [[ -f $(mbot_path .mbot/PAUSED) ]]; then printf 'Skipped: workspace is PAUSED.\n'; return 0; fi
  lock=$(mbot_path .mbot/lock)
  exec 8> "$lock"
  if ! flock -n 8; then printf 'Skipped: another run is active.\n'; return 0; fi
  if [[ -f $(mbot_path .mbot/PAUSED) ]]; then printf 'Skipped: workspace is PAUSED.\n'; return 0; fi
  MBOT_GIT_DIR=$(realpath -e -- "$(git -C "$MBOT_WS" rev-parse --absolute-git-dir)")
  MBOT_GIT_INODE=$(stat -c '%d:%i' "$MBOT_GIT_DIR")
  [[ -z $(mbot_git status --porcelain) ]] || { mbot_error 'workspace must be clean before run'; return 1; }
  mbot_role "$bot"
  [[ $bot != human ]] || { mbot_error 'run requires a bot role'; return 1; }
  [[ -z $task ]] || mbot_task_path "$task" >/dev/null
  [[ -z $MBOT_GRANTS ]] || { mbot_error 'MBOT_GRANTS support arrives in M4; run with empty grants'; return 1; }
  command -v "$MBOT_DSH" >/dev/null || { mbot_error "DSH executable not found: $MBOT_DSH"; return 1; }
  MBOT_DSH=$(command -v "$MBOT_DSH")
  [[ $MBOT_DSH != */* ]] || MBOT_DSH=$(realpath -e -- "$MBOT_DSH")
  MBOT_BASE=$(mbot_git rev-parse HEAD)
  MBOT_BASE_REF=$(mbot_git symbolic-ref -q HEAD || true)
  MBOT_SCRATCH=$(mktemp -d /tmp/mbot-run.XXXXXX)
  trap 'rm -rf -- "$MBOT_SCRATCH"' EXIT
  : > "$MBOT_SCRATCH/violations.jsonl"
  local -a boot_args=(boot "$bot")
  [[ -z $task ]] || boot_args+=(--task "$task")
  "$MBOT_ROOT/bin/botctl" -C "$MBOT_WS" "${boot_args[@]}" > "$MBOT_SCRATCH/prompt"
  printf '\n只通过 botctl 改看板/任务/候选，记忆只读；禁止 git commit 或调用 mbot。\n本次请求：\n<request>\n%s\n</request>\n' "$request" >> "$MBOT_SCRATCH/prompt"
  mbot_capture_secrets
  base_failures=$(mbot_failure_count)
  mbot_guard_snapshot
  MBOT_RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)-run-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')
  MBOT_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  start=$(date +%s%3N)
  # Close inherited lock descriptors in DSH; the host alone owns run serialization.
  (
    cd "$MBOT_WS"
    export MBOT_RUN_ID MBOT_WS MBOT_BOT=$bot PATH="$MBOT_ROOT/bin:$PATH"
    timeout --kill-after=10s "$MBOT_TIMEOUT" "$MBOT_DSH" --profile headless --json \
      --permission-mode workspace-write --approval-policy never - 8>&- 9>&-
  ) < "$MBOT_SCRATCH/prompt" > "$MBOT_SCRATCH/raw.jsonl" 2> "$MBOT_SCRATCH/stderr" || rc=$?
  elapsed=$(($(date +%s%3N)-start))
  trap 'if ((BASH_SUBSHELL)); then exit 1; fi; trap - ERR
    mbot_guard_parent ".mbot/runs/$MBOT_RUN_ID.jsonl"
    cp -- "$MBOT_SCRATCH/raw.jsonl" "$MBOT_WS/.mbot/runs/$MBOT_RUN_ID.jsonl"
    cp -- "$MBOT_SCRATCH/stderr" "$MBOT_WS/.mbot/runs/$MBOT_RUN_ID.stderr"
    printf "%s\n" "$((base_failures+1))" > "$MBOT_WS/.mbot/failures"
    mbot_mark_paused "Host validation failed; inspect raw logs and workspace before resuming."
    mbot_error "host validation failed; raw logs preserved; workspace PAUSED"; exit 1' ERR
  [[ $(stat -c '%d:%i' "$MBOT_GIT_DIR" 2>/dev/null || true) == "$MBOT_GIT_INODE" && $(realpath -e -- "$MBOT_GIT_DIR" 2>/dev/null || true) == "$MBOT_GIT_DIR" ]] || { mbot_error 'Git directory replaced during run'; return 1; }
  mbot_guard_run
  mbot_render "$request" "$elapsed" "$rc" "$bot" "$task"
  local day=$(date +%F) transcript meta raw_dir failed=0
  transcript=transcripts/$day/$MBOT_RUN_ID.md
  meta=transcripts/$day/$MBOT_RUN_ID.meta.json
  raw_dir=$(mbot_path .mbot/runs)
  mbot_path "$transcript" >/dev/null; mbot_path "$meta" >/dev/null
  mkdir -p -- "$raw_dir" "$MBOT_WS/transcripts/$day"
  cp -- "$MBOT_SCRATCH/raw.jsonl" "$raw_dir/$MBOT_RUN_ID.jsonl"
  cp -- "$MBOT_SCRATCH/stderr" "$raw_dir/$MBOT_RUN_ID.stderr"
  cp -- "$MBOT_SCRATCH/transcript.md" "$MBOT_WS/$transcript"
  cp -- "$MBOT_SCRATCH/meta.json" "$MBOT_WS/$meta"
  jq -e '.success' "$MBOT_SCRATCH/meta.json" >/dev/null || failed=1
  summary=$(jq -r '.summary' "$MBOT_SCRATCH/meta.json")
  mbot_git add -A -- BOARD.md tasks inbox "$transcript" "$meta"
  if ! mbot_git commit -q -m "run($bot): $MBOT_RUN_ID $summary"; then
    mbot_mark_paused 'Commit failed; review the preserved workspace changes.'
    failed=1
  fi
  if ((failed)); then base_failures=$((base_failures+1)); else base_failures=0; fi
  printf '%s\n' "$base_failures" > "$MBOT_WS/.mbot/failures"
  if ((base_failures >= 3)); then mbot_mark_paused "Automatically paused after $base_failures consecutive failed runs."; fi
  jq -r 'map(select(.type=="final")) | last | .text // empty' "$MBOT_SCRATCH/clean-events.json"
  printf 'run %s: success=%s; transcript=%s\n' "$MBOT_RUN_ID" "$((1-failed))" "$MBOT_WS/$transcript"
  trap - ERR
  ((failed == 0))
}
