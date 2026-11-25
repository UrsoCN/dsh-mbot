#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s nullglob
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
root=$(mktemp -d /tmp/mbot-runtime-tests.XXXXXX)
trap 'code=$?; if ((code == 0)); then rm -rf -- "$root"; else printf "Runtime artifacts: %s\n" "$root" >&2; fi' EXIT
trap 'printf "Runtime FAIL line %s\n" "$LINENO" >&2' ERR
unset MBOT_WS MBOT_RUN_ID MBOT_BOT MBOT_CLI_WS MBOT_GRANTS
export XDG_CONFIG_HOME=$root/config
export GIT_AUTHOR_NAME='mbot runtime tests' GIT_AUTHOR_EMAIL=mbot-tests@example.invalid
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
export MBOT_DSH=$repo/tests/fake-dsh MBOT_TIMEOUT=5 MBOT_FAKE_ARTIFACTS=$root/probes
mbot=$repo/bin/mbot
ws=$root/ws
count=0
ok() { count=$((count+1)); printf 'Runtime PASS %s: %s\n' "$count" "$1"; }
contains() { [[ $(cat -- "$2") == *"$1"* ]]; }
run() { MBOT_FAKE_MODE=$1 "$mbot" -C "$ws" run chief 'runtime request' > "$root/output" 2>&1; }
fail() { if run "$1"; then printf 'Expected run failure: %s\n' "$1" >&2; exit 1; fi; }
clean() { [[ -z $(git -C "$ws" status --porcelain) ]]; }
latest() {
  local file newest=''
  for file in "$ws/transcripts/"*/*.meta.json; do [[ -n $newest && ! $file -nt $newest ]] || newest=$file; done
  printf '%s\n' "$newest"
}
"$mbot" init "$ws" >/dev/null
base=$(git -C "$ws" rev-parse HEAD)
run add
[[ $(git -C "$ws" rev-list --count HEAD) == 2 ]]
[[ -f $ws/tasks/001.md ]]
contains '| 001 | todo | chief | 整理 README |' "$ws/BOARD.md"
jq -e --arg base "$base" '.success and .base_head==$base and .usage.total_tokens==65 and .usage.cache_read_tokens==50 and .usage.scope=="top-level"' "$(latest)" >/dev/null
clean
ok 'one run makes one clean commit, creates board task and captures top-level usage'

memory=$(git -C "$ws" show HEAD:MEMORY.md)
fail memory
[[ $(cat "$ws/MEMORY.md") == "$memory" && ! -e $ws/wiki/rogue.md && ! -e $ws/unexpected.txt ]]
[[ -f $ws/tasks/002.md ]]
jq -e '(.violations|length)>=6 and (.success|not)' "$(latest)" >/dev/null
[[ $(cat "$ws/.mbot/failures") == 1 ]]
clean
ok 'memory, roles, protocol, wiki and other unauthorized changes are restored; legal task retained'

run remember
[[ $(cat "$ws/.mbot/failures") == 0 ]]
contains '中文周报' "$ws/inbox/$(date +%F).md"
meta=$(latest)
contains '中文周报' "${meta%.meta.json}.md"
before_inbox=$(cat "$ws/inbox/$(date +%F).md")
fail inbox-delete
[[ $(cat "$ws/inbox/$(date +%F).md") == "$before_inbox" ]]
clean
ok 'remember is included in transcript; inbox prefix deletion is rolled back'

before_board=$(cat "$ws/BOARD.md")
fail bad-board
[[ $(cat "$ws/BOARD.md") == "$before_board" && ! -f $ws/tasks/003.md ]]
jq -e 'any(.violations[]; .reason=="board_lint_failed")' "$(latest)" >/dev/null
clean
"$mbot" -C "$ws" resume >/dev/null
ok 'invalid board rolls back its task changes together'

old_meta=$(latest)
old_transcript=${old_meta%.meta.json}.md
cp "$old_transcript" "$root/history.before"
old_raw=("$ws/.mbot/runs/"*.jsonl)
cp "${old_raw[0]}" "$root/raw.before"
fail history
cmp "$old_transcript" "$root/history.before"
cmp "${old_raw[0]}" "$root/raw.before"
[[ ! -e $ws/transcripts/2000-01-01/forged.md && ! -e $ws/.env.rogue && $(cat "$ws/.mbot/failures") == 1 ]]
clean
ok 'historic transcript/raw log and failure counter protected; ignored rogue files removed'

fail symlink
[[ ! -L $ws/tasks && $(cat "$root/probes/outside/001.md") == outside-original ]]
[[ -f $ws/tasks/001.md && -f $ws/tasks/002.md ]]
clean
"$mbot" -C "$ws" resume >/dev/null
ok 'symlink parent repair restores workspace files without writing to the outside target'

parent=$(git -C "$ws" rev-parse HEAD)
fail head
[[ $(git -C "$ws" rev-parse HEAD^) == "$parent" && -f $ws/.mbot/PAUSED ]]
[[ $(cat "$ws/MEMORY.md") == "$memory" ]]
jq -e 'any(.violations[]; .reason=="head_moved")' "$(latest)" >/dev/null
clean
"$mbot" -C "$ws" resume >/dev/null
ok 'agent HEAD movement is audited, original parent restored, workspace paused'

fail control
[[ $(cat "$root/probes/control-target") == outside-original && -f $ws/.mbot/PAUSED && ! -L $ws/.mbot/PAUSED ]]
jq -e 'any(.violations[]; .reason=="runtime_control_path_replaced")' "$(latest)" >/dev/null
"$mbot" -C "$ws" resume >/dev/null
ok 'control-path symlink cannot redirect host pause writes outside the workspace'

run nested
contains 'nested mbot run is forbidden' "$root/probes/nested"
MBOT_FAKE_MODE=noop "$mbot" -C "$ws" run 'default chief request' --task 001 > "$root/output" 2>&1
contains '<context file="tasks/001.md">' "$root/probes/prompt"
jq -e '.bot=="chief" and .task=="001"' "$(latest)" >/dev/null
ok 'nested entry is denied; default bot and task context are passed correctly'

export MBOT_TEST_SECRET=literal-secret-without-key-prefix
MBOT_FAKE_MODE=secret "$mbot" -C "$ws" run chief "test request $MBOT_TEST_SECRET" > "$root/output" 2>&1
meta=$(latest)
if contains "$MBOT_TEST_SECRET" "$meta" || contains "$MBOT_TEST_SECRET" "${meta%.meta.json}.md" || contains "$MBOT_TEST_SECRET" "$root/output"; then exit 1; fi
contains '[REDACTED]' "${meta%.meta.json}.md"
if contains 'sk-TESTPATTERN12345678901234567890' "${meta%.meta.json}.md" || contains 'testbearersecret123456' "${meta%.meta.json}.md"; then exit 1; fi
[[ $(git -C "$ws" log -1 --format=%s) != *"$MBOT_TEST_SECRET"* ]]
unset MBOT_TEST_SECRET
ok 'literal secrets and common key/Bearer patterns redacted from transcript, metadata and stdout'

fail wrong-final
jq -e '.success==false and .reason=="invalid reason"' "$(latest)" >/dev/null
"$mbot" -C "$ws" resume >/dev/null

fail malformed
jq -e '.success==false and any(.violations[]; .reason=="invalid_json_stream")' "$(latest)" >/dev/null
fail incomplete
jq -e '.success==false and .reason==null' "$(latest)" >/dev/null
fail error
[[ $(cat "$ws/.mbot/failures") == 3 && -f $ws/.mbot/PAUSED ]]
before=$(git -C "$ws" rev-parse HEAD)
run add
[[ $(git -C "$ws" rev-parse HEAD) == "$before" ]]
"$mbot" -C "$ws" status > "$root/status"
contains 'Consecutive failures: 3' "$root/status"
contains 'PAUSED:' "$root/status"
"$mbot" -C "$ws" resume >/dev/null
[[ $(cat "$ws/.mbot/failures") == 0 && ! -e $ws/.mbot/PAUSED ]]
ok 'bad/missing JSON finals and exit failures are audited; three consecutive failures pause; resume resets'

MBOT_TIMEOUT=1 MBOT_FAKE_MODE=timeout "$mbot" -C "$ws" run chief 'timeout request' > "$root/output" 2>&1 && exit 1
jq -e '.success==false and .dsh_exit_code==124' "$(latest)" >/dev/null
clean
"$mbot" -C "$ws" resume >/dev/null
ok 'timeout is bounded, transcript preserved and failure counted'

rm -f "$root/probes/started"
MBOT_FAKE_MODE=slow "$mbot" -C "$ws" run chief 'slow request' > "$root/slow.out" 2>&1 &
slow_pid=$!
for i in {1..100}; do [[ ! -f $root/probes/started ]] || break; sleep 0.02; done
[[ -f $root/probes/started ]]
run add
contains 'another run is active' "$root/output"
if "$repo/bin/botctl" -C "$ws" board add 'human concurrent mutation' > "$root/human.out" 2>&1; then exit 1; fi
contains 'a run is active' "$root/human.out"
"$mbot" -C "$ws" pause 'human pause during run' >/dev/null
wait "$slow_pid"
[[ -f $ws/.mbot/PAUSED ]]
"$mbot" -C "$ws" resume >/dev/null
clean
ok 'second concurrent run skips; human pause survives a running invocation'

printf 'dirty\n' > "$ws/dirty.txt"
if run noop; then exit 1; fi
contains 'must be clean' "$root/output"
rm "$ws/dirty.txt"
if MBOT_RUN_ID=inside "$mbot" -C "$root/nonexistent" run 'nested' > "$root/output" 2>&1; then exit 1; fi
contains 'nested mbot run is forbidden' "$root/output"
ok 'dirty worktree and nested entry are rejected before starting DSH'

ws=$root/broken-ws
"$mbot" init "$ws" >/dev/null
fail git-destroy
[[ -f $ws/.mbot/PAUSED && $(cat "$ws/.mbot/failures") == 1 ]]
raw=("$ws/.mbot/runs/"*.jsonl)
[[ ${#raw[@]} == 1 && -s ${raw[0]} ]]
contains 'host validation failed' "$root/output"
ok 'unusable Git metadata preserves raw evidence, counts a failure and pauses without committing'
printf '%s runtime checks passed\n' "$count"
