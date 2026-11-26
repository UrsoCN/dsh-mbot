#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s nullglob
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
test_root=$(mktemp -d /tmp/mbot-tests.XXXXXX)
trap 'code=$?; if ((code == 0)); then rm -rf -- "$test_root"; else printf "Artifacts: %s\n" "$test_root" >&2; fi' EXIT
trap 'printf "FAIL at line %s\n" "$LINENO" >&2' ERR
unset MBOT_WS MBOT_RUN_ID MBOT_BOT MBOT_DSH MBOT_CLI_WS
unset MBOT_MEMORY_MAX_LINES MBOT_MEMORY_MAX_CHARS MBOT_SOUL_MAX_CHARS MBOT_WIKI_MAX_LINES MBOT_BOARD_MAX_LINES MBOT_TIMEOUT MBOT_DREAM_MAX_BYTES MBOT_GRANTS
export XDG_CONFIG_HOME=$test_root/config
export GIT_AUTHOR_NAME='mbot tests' GIT_AUTHOR_EMAIL='mbot-tests@example.invalid'
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
mbot=$repo/bin/mbot
botctl=$repo/bin/botctl
ws=$test_root/workspace
cfg=$XDG_CONFIG_HOME/mbot/config
count=0
ok() { count=$((count+1)); printf 'PASS %s: %s\n' "$count" "$1"; }
contains() { [[ $(cat -- "$2") == *"$1"* ]]; }
fail_with() {
  local text=$1
  shift
  if "$@" > "$test_root/error" 2>&1; then printf 'Expected failure: %s\n' "$*" >&2; exit 1; fi
  contains "$text" "$test_root/error"
}
clean() { [[ -z $(git -C "$ws" status --porcelain) ]]; }
head_id() { git -C "$ws" rev-parse HEAD; }

for file in "$repo/bin/mbot" "$repo/bin/botctl" "$repo/install.sh" "$repo/lib/"*.sh; do bash -n "$file"; done
"$mbot" --help >/dev/null
"$botctl" --help >/dev/null
"$botctl" remember --help >/dev/null
"$botctl" board add --help >/dev/null
"$botctl" task result --help >/dev/null
fail_with 'workspace not found' "$botctl" -C "$ws" board show
[[ ! -e $ws ]]
"$mbot" init "$ws"
[[ $(git -C "$ws" log -1 --format=%s) == 'human: init' ]]
"$botctl" -C "$ws" lint
clean
ok 'init creates a clean independent data repository; missing workspace never auto-created'

id=$("$botctl" -C "$ws" board add '试试' --owner coder)
[[ $id == 001 && -f $ws/tasks/001.md ]]
contains '| 001 | todo | coder | 试试 |' "$ws/BOARD.md"
[[ $(git -C "$ws" log -1 --format=%s) == 'human: board add 001 试试' ]]
clean
ok 'board add allocates 001, creates task and commits'

before=$(head_id)
"$botctl" -C "$ws" remember --help >/dev/null
[[ $(head_id) == "$before" && ! -f $ws/inbox/$(date +%F).md ]]
cp "$ws/BOARD.md" "$test_root/board.before"
fail_with 'blocked requires --reason' "$botctl" -C "$ws" board set 001 blocked
fail_with 'invalid state' "$botctl" -C "$ws" board set 001 unknown
fail_with 'unknown bot' "$botctl" -C "$ws" board add 'bad owner' --owner absent
fail_with 'single line' "$botctl" -C "$ws" board add $'bad\nrow'
fail_with 'invalid task id' "$botctl" -C "$ws" task show ../MEMORY
[[ $(head_id) == "$before" ]]
cmp "$ws/BOARD.md" "$test_root/board.before"
clean
"$botctl" -C "$ws" board set 001 blocked --reason '等待输入' >/dev/null
contains '> [blocked] 等待输入' "$ws/tasks/001.md"
"$botctl" -C "$ws" board set 001 doing --owner chief >/dev/null
"$botctl" -C "$ws" board show --status doing > "$test_root/filtered"
contains '| 001 | doing | chief |' "$test_root/filtered"
before=$(head_id)
"$botctl" -C "$ws" board set 001 doing >/dev/null
[[ $(head_id) == "$before" ]]
ok 'state transitions update task, require blocked reason, and reject invalid input without changes'

"$botctl" -C "$ws" boot coder --task 001 > "$test_root/boot"
contexts=$(sed -n 's/^<context file="\(.*\)">$/\1/p' "$test_root/boot")
[[ $contexts == $'bots/coder/SOUL.md\nMEMORY.md\nbots/coder/MEMORY.md\nBOARD.md\ntasks/001.md' ]]
cp "$ws/tasks/001.md" "$test_root/task.before"
bytes=$(wc -c < "$test_root/task.before")
printf '完成\n## 不应成为任务结构\n验证通过\n' | "$botctl" -C "$ws" task result 001 --as coder >/dev/null
head -c "$bytes" "$ws/tasks/001.md" | cmp - "$test_root/task.before"
contains '> ## 不应成为任务结构' "$ws/tasks/001.md"
"$botctl" -C "$ws" task show 001 | cmp - "$ws/tasks/001.md"
fail_with 'result must not be empty' "$botctl" -C "$ws" task result 001 < /dev/null
ok 'boot order, exact task prefix preservation, quoted multiline result, empty result rejection'

cp "$ws/MEMORY.md" "$test_root/memory.before"
"$botctl" -C "$ws" remember '周报使用中文' --as coder --task 001 >/dev/null
cmp "$ws/MEMORY.md" "$test_root/memory.before"
contains '[by: coder; run: human; task: 001;' "$ws/inbox/$(date +%F).md"
clean
ok 'remember appends attributed candidate to inbox and leaves memory unchanged'

printf 'unrelated\n' > "$ws/unrelated.txt"
git -C "$ws" add unrelated.txt
[[ $("$botctl" -C "$ws" board add '带 | 与 & 的标题') == 002 ]]
contains '带 &#124; 与 & 的标题' "$ws/BOARD.md"
[[ $(git -C "$ws" diff --cached --name-only) == unrelated.txt ]]
[[ $(git -C "$ws" show --format= --name-only HEAD) != *unrelated.txt* ]]
git -C "$ws" commit -qm 'human: unrelated fixture'
printf '\n人工未提交修改\n' >> "$ws/tasks/001.md"
fail_with 'uncommitted changes' "$botctl" -C "$ws" task result 001 <<< '不能混入提交'
git -C "$ws" restore -- tasks/001.md
ok 'human commits exclude unrelated staging and refuse dirty target files'

before=$(head_id)
for i in {1..8}; do
  MBOT_RUN_ID=parallel-test MBOT_BOT=chief "$botctl" -C "$ws" board add "并发 $i" --owner coder > "$test_root/id.$i" &
done
for job in $(jobs -p); do wait "$job"; done
[[ $(cat "$test_root/id."* | sort -u | wc -l) == 8 ]]
[[ $(head_id) == "$before" ]]
MBOT_RUN_ID=parallel-test "$botctl" -C "$ws" remember '运行内候选' --as coder --task 001 >/dev/null
MBOT_RUN_ID=parallel-test "$botctl" -C "$ws" task result 001 --as coder <<< '运行内结果' >/dev/null
"$botctl" -C "$ws" lint
[[ $(head_id) == "$before" ]]
git -C "$ws" add BOARD.md tasks inbox
git -C "$ws" commit -qm 'run(chief): offline fixture'
clean
ok 'eight concurrent additions use unique IDs; all Bot mutations leave HEAD unchanged'

mkdir -p "$ws/tasks/archive/2026-11"
mv "$ws/tasks/010.md" "$ws/tasks/archive/2026-11/010.md"
sed -i '/^| 010 |/d' "$ws/BOARD.md"
git -C "$ws" add BOARD.md tasks
git -C "$ws" commit -qm 'chore(archive): fixture'
[[ $("$botctl" -C "$ws" board add '归档后不复用 ID') == 011 ]]
ok 'ID allocation also includes archived tasks'

cp "$ws/BOARD.md" "$test_root/board.before"
before=$(head_id)
printf '#!/bin/sh\nexit 1\n' > "$ws/.git/hooks/pre-commit"
chmod +x "$ws/.git/hooks/pre-commit"
if "$botctl" -C "$ws" board add '提交失败应回滚' > "$test_root/hook.out" 2>&1; then exit 1; fi
[[ $(head_id) == "$before" && ! -e $ws/tasks/012.md ]]
cmp "$ws/BOARD.md" "$test_root/board.before"
clean
rm -- "$ws/.git/hooks/pre-commit"
ok 'commit failure restores files and index without leaving a partial board entry'

mkdir -p "$(dirname -- "$cfg")"
printf 'MBOT_WS=%s\n' "$ws" > "$cfg"
"$botctl" board show >/dev/null
MBOT_WS=$test_root/missing "$botctl" -C "$ws" board show >/dev/null
printf 'INVALID=config\n' > "$cfg"
MBOT_WS=$ws "$botctl" board show >/dev/null
fail_with 'unknown user config key' "$botctl" board show
printf 'MBOT_WS=$(touch %s)/ws\n' "$test_root/pwned" > "$cfg"
if "$botctl" board show > "$test_root/error" 2>&1; then exit 1; fi
[[ ! -e $test_root/pwned ]]
rm -- "$cfg"
default=$(bash -c 'MBOT_ROOT=$1; source "$1/lib/config.sh"; mbot_select_workspace; printf "%s\n" "$MBOT_WS"' _ "$repo")
[[ $default == "$HOME/.mbot-ws" ]]
ok 'workspace precedence -C > environment > static config > default; config cannot execute shell'

fail_with 'overlap' "$mbot" init "$repo/child"
fail_with 'overlap' "$mbot" init "$(dirname -- "$repo")"
fail_with 'DSH_HOME' "$mbot" init "$HOME/.dsh/mbot-tests"
fail_with 'DSH_HOME' env DSH_HOME="$test_root/dsh-home" "$mbot" init "$test_root/dsh-home/ws"
fail_with 'absent or empty' "$mbot" init "$ws"
mkdir -p "$test_root/nested"
git -C "$test_root/nested" init -q
fail_with 'nested Git' "$mbot" init "$test_root/nested/child"
ln -s "$repo" "$test_root/framework-alias"
fail_with 'overlap' "$mbot" init "$test_root/framework-alias/data"
ok 'init rejects framework overlap, DSH home, symlink aliases, nonempty and nested repositories'

mv "$ws/tasks/001.md" "$test_root/task.saved"
printf 'outside-original\n' > "$test_root/outside.md"
ln -s "$test_root/outside.md" "$ws/tasks/001.md"
fail_with 'symlink not allowed' "$botctl" -C "$ws" task result 001 <<< '应拒绝'
[[ $(cat "$test_root/outside.md") == outside-original ]]
rm "$ws/tasks/001.md"
mv "$test_root/task.saved" "$ws/tasks/001.md"
ok 'managed symlink targets cannot redirect writes outside the workspace'

cp "$ws/MEMORY.md" "$test_root/memory.before"
for i in {1..2999}; do printf '中'; done > "$ws/MEMORY.md"
printf '\n' >> "$ws/MEMORY.md"
LC_ALL=C "$botctl" -C "$ws" lint >/dev/null
printf '中' >> "$ws/MEMORY.md"
fail_with '3001 characters > 3000 (exceeds by 1)' "$botctl" -C "$ws" lint
printf '%s\n' {1..151} > "$ws/MEMORY.md"
fail_with 'MEMORY.md: 151 lines > 150 (exceeds by 1)' "$botctl" -C "$ws" lint
cp "$test_root/memory.before" "$ws/MEMORY.md"
cp "$ws/bots/coder/SOUL.md" "$test_root/soul.before"
printf '%5001s' '' > "$ws/bots/coder/SOUL.md"
fail_with 'SOUL.md: 5001 characters > 5000' "$botctl" -C "$ws" lint
cp "$test_root/soul.before" "$ws/bots/coder/SOUL.md"
printf '%s\n' {1..201} > "$ws/wiki/large.md"
fail_with 'wiki/large.md: 201 lines > 200' "$botctl" -C "$ws" lint
rm "$ws/wiki/large.md"
cp "$ws/BOARD.md" "$test_root/board.before"
for i in {1..81}; do printf '\n'; done >> "$ws/BOARD.md"
fail_with 'BOARD.md:' "$botctl" -C "$ws" lint
cp "$test_root/board.before" "$ws/BOARD.md"
ok 'all budgets report path and excess; UTF-8 characters count correctly even under LC_ALL=C'

sed -i 's/| doing |/| bogus |/' "$ws/BOARD.md"
fail_with 'invalid state' "$botctl" -C "$ws" lint
cp "$test_root/board.before" "$ws/BOARD.md"
duplicate=$(sed -n '/^| 001 |/p' "$ws/BOARD.md")
printf '%s\n' "$duplicate" >> "$ws/BOARD.md"
fail_with 'duplicate task id' "$botctl" -C "$ws" lint
cp "$test_root/board.before" "$ws/BOARD.md"
printf '\n[[wiki/missing.md]]\n' >> "$ws/MEMORY.md"
fail_with 'MEMORY.md: missing or unsafe link' "$botctl" -C "$ws" lint
cp "$test_root/memory.before" "$ws/MEMORY.md"
printf '\n[[../outside.md]]\n' >> "$ws/MEMORY.md"
fail_with 'unsafe link' "$botctl" -C "$ws" lint
cp "$test_root/memory.before" "$ws/MEMORY.md"
printf '\n[[wiki/_index.md#知识|入口]]\n' >> "$ws/MEMORY.md"
"$botctl" -C "$ws" lint >/dev/null
cp "$test_root/memory.before" "$ws/MEMORY.md"
ok 'lint checks board shape, duplicate IDs, states, links and traversal; permits link aliases'

before=$(head_id)
limit=$(awk 'END{print NR}' "$ws/BOARD.md")
fail_with 'exceeds by 1' env MBOT_BOARD_MAX_LINES="$limit" "$botctl" -C "$ws" board add '超预算不会留下任务'
[[ $(head_id) == "$before" && ! -e $ws/tasks/012.md ]]
cmp "$ws/BOARD.md" "$test_root/board.before"
clean
cp "$ws/BOARD.md" "$test_root/nonnewline"
truncate -s -1 "$ws/BOARD.md"
MBOT_RUN_ID=border-test "$botctl" -C "$ws" board add '缺少尾部换行也可追加' >/dev/null
"$botctl" -C "$ws" lint >/dev/null
cp "$test_root/nonnewline" "$ws/BOARD.md"
rm "$ws/tasks/012.md"
fail_with 'nonempty' env MBOT_WS= "$botctl" board show
ok 'budget overflow rolls back board and task; missing final newline and empty workspace handled'

cp "$ws/.mbot/config" "$test_root/config.before"
printf '\nMBOT_TIMEOUT=invalid\n' > "$ws/.mbot/config"
fail_with 'positive integer' "$botctl" -C "$ws" lint
cp "$test_root/config.before" "$ws/.mbot/config"
bash "$repo/install.sh" --bin-dir "$test_root/bin" --workspace "$ws" >/dev/null
"$test_root/bin/botctl" lint >/dev/null
bash "$repo/install.sh" --bin-dir "$test_root/bin" >/dev/null
mkdir -p "$test_root/collision"
printf 'keep me\n' > "$test_root/collision/botctl"
fail_with 'will not overwrite' bash "$repo/install.sh" --bin-dir "$test_root/collision"
[[ $(cat "$test_root/collision/botctl") == 'keep me' && ! -e $test_root/collision/mbot ]]
"$mbot" init "$test_root/space workspace" >/dev/null
"$botctl" -C "$test_root/space workspace" lint >/dev/null
clean
ok 'config validation, installation symlink entrypoints, collision protection and paths with spaces'
printf '%s integration checks passed\n' "$count"
bash "$repo/tests/run-runtime.sh"
bash "$repo/tests/run-dream.sh"
bash "$repo/tests/run-schedule.sh"
bash "$repo/tests/run-ops.sh"
