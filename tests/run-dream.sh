#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s nullglob
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
root=$(mktemp -d /tmp/mbot-dream-tests.XXXXXX)
trap 'code=$?; if ((code==0)); then rm -rf -- "$root"; else printf "Dream artifacts: %s\n" "$root" >&2; fi' EXIT
trap 'printf "Dream FAIL line %s\n" "$LINENO" >&2' ERR
unset MBOT_WS MBOT_RUN_ID MBOT_BOT MBOT_CLI_WS MBOT_GRANTS MBOT_DREAM_MAX_BYTES
export XDG_CONFIG_HOME=$root/config MBOT_DSH=$repo/tests/fake-dsh MBOT_TIMEOUT=5 MBOT_FAKE_ARTIFACTS=$root/probes
export GIT_AUTHOR_NAME='mbot dream tests' GIT_AUTHOR_EMAIL=mbot-tests@example.invalid
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
mbot=$repo/bin/mbot
ws=$root/ws
count=0
ok() { count=$((count+1)); printf 'Dream PASS %s: %s\n' "$count" "$1"; }
contains() { [[ $(cat -- "$2") == *"$1"* ]]; }
clean() { [[ -z $(git -C "$ws" status --porcelain) ]]; }
dream() { MBOT_FAKE_MODE=$1 "$mbot" -C "$ws" dream > "$root/output" 2>&1; }
fail() {
  "$mbot" -C "$ws" resume >/dev/null
  if dream "$1"; then printf 'Expected failed dream: %s\n' "$1" >&2; exit 1; fi
}
latest() {
  local file newest=''
  for file in "$ws/dream-reports/"*.meta.json; do [[ -n $newest && ! $file -nt $newest ]] || newest=$file; done
  printf '%s\n' "$newest"
}
"$mbot" init "$ws" >/dev/null
"$repo/bin/botctl" -C "$ws" remember '以后周报一律用中文' >/dev/null
cp "$ws/MEMORY.md" "$root/memory.before"
cp "$ws/inbox/$(date +%F).md" "$root/inbox.before"
dream dream-normal
contains '周报一律使用中文' "$ws/MEMORY.md"
contains '编码结果附验收证据' "$ws/bots/coder/MEMORY.md"
contains '[[wiki/weekly.md]]' "$ws/wiki/_index.md"
cmp "$ws/inbox/$(date +%F).md" "$root/inbox.before"
[[ $(git -C "$ws" log -1 --format=%s) == 'dream:'* ]]
jq -e '.success and .mode=="dream" and .checkpoint.bytes>0 and (.checkpoint.pending|length)==0' "$(latest)" >/dev/null
"$mbot" -C "$ws" status > "$root/status"
contains "Latest: $(jq -r .run_id "$(latest)")" "$root/status"
[[ ! -d $ws/transcripts ]]
clean
ok 'normal dream consolidates inbox, leaves candidate immutable, saves report/checkpoint in one commit'

dream_commit=$(git -C "$ws" rev-parse HEAD)
MBOT_FAKE_MODE=respect "$mbot" -C "$ws" run chief '检查周报规则' >/dev/null
git -C "$ws" revert --no-edit "$dream_commit" >/dev/null
cmp "$ws/MEMORY.md" "$root/memory.before"
MBOT_FAKE_MODE=respect MBOT_TEST_EXPECT_RULE=0 "$mbot" -C "$ws" run chief '检查回滚后的规则' >/dev/null
clean
ok 'next run sees consolidated memory; git revert removes rule from cold context'

before=$(cat "$ws/MEMORY.md")
printf '# Obsolete page\n' > "$ws/wiki/obsolete.md"
git -C "$ws" add wiki/obsolete.md
git -C "$ws" commit -qm 'human: obsolete wiki fixture'
for mode in dream-large dream-private-large dream-wiki-large dream-link dream-wiki-no-basis dream-no-basis dream-empty-basis dream-wrong-basis dream-index-delete dream-missing dream-directory dream-error; do
  fail "$mode"
  [[ $(cat "$ws/MEMORY.md") == "$before" ]]
  [[ $(git -C "$ws" log -1 --format=%s) == 'dream(failed):'* ]]
  jq -e '.success==false' "$(latest)" >/dev/null
  files=$(git -C "$ws" diff-tree --no-commit-id --name-only -r HEAD)
  [[ $files != *MEMORY.md* && $files == dream-reports/* ]]
  [[ -f ${ws}/wiki/obsolete.md && -f ${ws}/dream-reports/$(basename "$(latest)" .meta.json).md && ! -e $ws/wiki/large.md ]]
  [[ -f $ws/wiki/_index.md ]]
  if [[ $mode == dream-index-delete ]]; then jq -e 'any(.violations[]; .path=="wiki/_index.md")' "$(latest)" >/dev/null; fi
  clean
done
LC_ALL=C fail dream-empty-basis
ok 'budget/link failure, missing deletion basis/report and DSH error restore all memory; only report committed'

fail dream-board
[[ $(cat "$ws/MEMORY.md") == "$before" && ! -f $ws/tasks/001.md ]]
jq -e 'any(.violations[]; .path=="BOARD.md")' "$(latest)" >/dev/null
clean
"$mbot" -C "$ws" resume >/dev/null
dream dream-delete
[[ ! -e $ws/wiki/obsolete.md ]]
contains '周报一律使用中文' "$ws/MEMORY.md"
jq -e '.success and (.violations|length)==0' "$(latest)" >/dev/null
ok 'dream cannot change board/tasks; explicit per-file deletion basis permits a validated rewrite'

export MBOT_TEST_SECRET=report-secret-without-key-prefix
dream dream-secret
if contains "$MBOT_TEST_SECRET" "$(latest)" || contains "$MBOT_TEST_SECRET" "${ws}/dream-reports/$(basename "$(latest)" .meta.json).md"; then exit 1; fi
unset MBOT_TEST_SECRET
ok 'model-written dream report and host metadata are redacted'

ws=$root/queue-ws
"$mbot" init "$ws" >/dev/null
printf '%s\n' '候选一：中文' '候选二：中文' '候选三：中文' '候选四：中文' '候选五：中文' > "$ws/inbox/queue.md"
mkdir -p "$ws/transcripts/2000-01-01" "$ws/tasks/archive/2000-01"
printf '%s\n' {1..20} > "$ws/transcripts/2000-01-01/source.md"
printf 'archived task\n' > "$ws/tasks/archive/2000-01/001.md"
git -C "$ws" add inbox transcripts tasks/archive
git -C "$ws" commit -qm 'human: queue fixtures'
source_bytes=$(($(wc -c < "$ws/inbox/queue.md")+$(wc -c < "$ws/transcripts/2000-01-01/source.md")+$(wc -c < "$ws/tasks/archive/2000-01/001.md")))
export MBOT_DREAM_MAX_BYTES=48
dream dream-noop
jq -e '.checkpoint.bytes<=48 and .checkpoint.processed[0].path=="inbox/queue.md" and (.checkpoint.pending|length)>0' "$(latest)" >/dev/null
resume_offset=$(jq '.checkpoint.pending[] | select(.path=="inbox/queue.md") | .offset' "$(latest)")
printf '新增候选六：中文\n' >> "$ws/inbox/queue.md"
added=$(printf '新增候选六：中文\n' | wc -c)
git -C "$ws" add inbox/queue.md
git -C "$ws" commit -qm 'human: append while pending'
for i in {1..20}; do
  dream dream-noop
  if ((i==1)); then jq -e --argjson offset "$resume_offset" '.checkpoint.processed[0].path=="inbox/queue.md" and .checkpoint.processed[0].offset==$offset' "$(latest)" >/dev/null; fi
  [[ $(jq '.checkpoint.pending|length' "$(latest)") != 0 ]] || break
done
[[ $(jq '.checkpoint.pending|length' "$(latest)") == 0 ]]
jq -es --argjson size "$((source_bytes+added))" '[.[].checkpoint.bytes]|add==$size' "$ws/dream-reports/"*.meta.json >/dev/null
jq -es 'all(.[]; .checkpoint.bytes<=48)' "$ws/dream-reports/"*.meta.json >/dev/null
clean
ok 'capped UTF-8 line batches retain pending offsets, prioritize inbox and consume later append exactly once'

dream dream-noop
jq -e '.checkpoint.bytes==0 and (.checkpoint.pending|length)==0' "$(latest)" >/dev/null
ok 'no new input still produces report without reprocessing completed sources'

ws=$root/retry-ws
"$mbot" init "$ws" >/dev/null
printf '%s\n' {1..100} > "$ws/inbox/queue.md"
git -C "$ws" add inbox/queue.md
git -C "$ws" commit -qm 'human: retry source'
fail dream-large
jq -e '.checkpoint.processed[0].offset==0' "$(latest)" >/dev/null
dream dream-noop
jq -e '.success and .checkpoint.processed[0].offset==0' "$(latest)" >/dev/null
ok 'failed dream does not advance input cursor; retry starts from last successful checkpoint'

old_blob=$(git -C "$ws" rev-parse HEAD:inbox/queue.md)
printf 'changed source\n' > "$ws/inbox/queue.md"
git -C "$ws" add inbox/queue.md
git -C "$ws" commit -qm 'human: replace queued source'
dream dream-noop
jq -e --arg old "$old_blob" 'all(.checkpoint.processed[]; .blob!=$old) and (.checkpoint.pending|length)==0' "$(latest)" >/dev/null
ok 'replaced pending source supersedes obsolete blob rather than resurrecting its contents'

old_ws=$ws
ws=$root/rename-ws
"$mbot" init "$ws" >/dev/null
printf '%s\n' {1..100} > "$ws/inbox/source.md"
git -C "$ws" add inbox/source.md
git -C "$ws" commit -qm 'human: rename source fixture'
dream dream-noop
mv "$ws/inbox/source.md" "$ws/inbox/moved.md"
git -C "$ws" add -A inbox
git -C "$ws" commit -qm 'human: rename queued source'
dream dream-noop
jq -e '.checkpoint.processed[0].path=="inbox/moved.md" and all(.checkpoint.pending[]; .path=="inbox/moved.md")' "$(latest)" >/dev/null
ws=$old_ws

printf '%200s' '' > "$ws/inbox/long-line.md"
git -C "$ws" add inbox/long-line.md
git -C "$ws" commit -qm 'human: oversized single line'
before_calls=$(wc -l < "$root/probes/invocations")
fail dream-noop
[[ $(wc -l < "$root/probes/invocations") == "$before_calls" ]]
jq -e 'any(.violations[]; .reason=="input_budget_too_small") and .checkpoint.bytes==0' "$(latest)" >/dev/null
MBOT_DREAM_MAX_BYTES=300 dream dream-noop
jq -e '.success and .checkpoint.bytes==200' "$(latest)" >/dev/null
ok 'oversized single line keeps progress intact and spends no model call until budget is raised'
unset MBOT_DREAM_MAX_BYTES

rm -f "$root/probes/started"
MBOT_FAKE_MODE=slow "$mbot" -C "$ws" dream > "$root/slow.out" 2>&1 &
pid=$!
for i in {1..100}; do [[ ! -f $root/probes/started ]] || break; sleep 0.02; done
[[ -f $root/probes/started ]]
MBOT_FAKE_MODE=noop "$mbot" -C "$ws" run chief 'concurrent' > "$root/output" 2>&1
contains 'another run is active' "$root/output"
wait "$pid"
if MBOT_RUN_ID=inside "$mbot" -C "$root/missing" dream > "$root/output" 2>&1; then exit 1; fi
contains 'nested mbot dream is forbidden' "$root/output"
clean
ok 'dream shares run lock and nested-call prevention'
printf '%s dream checks passed\n' "$count"
