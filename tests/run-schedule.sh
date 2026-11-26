#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s nullglob
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
root=$(mktemp -d /tmp/mbot-schedule-tests.XXXXXX)
trap 'code=$?; if ((code==0)); then rm -rf -- "$root"; else printf "Schedule artifacts: %s\n" "$root" >&2; fi' EXIT
trap 'printf "Schedule FAIL line %s\n" "$LINENO" >&2' ERR
unset MBOT_WS MBOT_RUN_ID MBOT_BOT MBOT_CLI_WS MBOT_GRANTS
export XDG_CONFIG_HOME=$root/config MBOT_DSH=$repo/tests/fake-dsh MBOT_TIMEOUT=5 MBOT_FAKE_ARTIFACTS=$root/probes
export GIT_AUTHOR_NAME='mbot schedule tests' GIT_AUTHOR_EMAIL=mbot-tests@example.invalid
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
mbot=$repo/bin/mbot
ctl=$repo/bin/botctl
ws=$root/ws
count=0
ok() { count=$((count+1)); printf 'Schedule PASS %s: %s\n' "$count" "$1"; }
contains() { [[ $(cat -- "$2") == *"$1"* ]]; }
clean() { [[ -z $(git -C "$ws" status --porcelain) ]]; }
latest() {
  local file newest=''
  for file in "$ws/transcripts/"*/*.meta.json; do [[ -n $newest && ! $file -nt $newest ]] || newest=$file; done
  printf '%s\n' "$newest"
}
"$mbot" init "$ws" >/dev/null
head_before=$(git -C "$ws" rev-parse HEAD)
MBOT_DSH=/does/not/exist "$mbot" -C "$ws" tick > "$root/output"
contains 'no todo or doing' "$root/output"
[[ $(git -C "$ws" rev-parse HEAD) == "$head_before" && ! -e $root/probes/invocations ]]
ok 'idle tick makes no model call or commit, even when DSH is unavailable'

"$ctl" -C "$ws" board add 'first todo' >/dev/null
"$ctl" -C "$ws" board add 'existing doing' >/dev/null
"$ctl" -C "$ws" board add 'blocked task' >/dev/null
"$ctl" -C "$ws" board set 002 doing >/dev/null
"$ctl" -C "$ws" board set 003 blocked --reason 'waiting' >/dev/null
MBOT_FAKE_MODE=tick "$mbot" -C "$ws" tick > "$root/output"
jq -e '.task=="002" and .success and .bot=="chief"' "$(latest)" >/dev/null
contains '| 001 | todo |' "$ws/BOARD.md"
contains '| 002 | done |' "$ws/BOARD.md"
contains '| 003 | blocked |' "$ws/BOARD.md"
MBOT_FAKE_MODE=tick "$mbot" -C "$ws" tick >/dev/null
jq -e '.task=="001" and .success' "$(latest)" >/dev/null
clean
ok 'tick prefers doing, then oldest todo, and keeps blocked thread unchanged'

month=$(date +%Y-%m)
printf 'self reference [[tasks/001.md]]\n' | "$ctl" -C "$ws" task result 001 --as coder >/dev/null
cp "$ws/tasks/001.md" "$root/task1.before"
cp "$ws/tasks/002.md" "$root/task2.before"
before_calls=$(wc -l < "$root/probes/invocations")
"$mbot" -C "$ws" archive >/dev/null
[[ ! -e $ws/tasks/001.md && ! -e $ws/tasks/002.md && -f $ws/tasks/003.md ]]
cmp "$ws/tasks/archive/$month/001.md" "$root/task1.before"
cmp "$ws/tasks/archive/$month/002.md" "$root/task2.before"
[[ $(git -C "$ws" log -1 --format=%s) == 'chore(archive):'* ]]
[[ $(wc -l < "$root/probes/invocations") == "$before_calls" ]]
"$ctl" -C "$ws" lint >/dev/null
head_before=$(git -C "$ws" rev-parse HEAD)
"$mbot" -C "$ws" archive >/dev/null
"$mbot" -C "$ws" tick >/dev/null
[[ $(git -C "$ws" rev-parse HEAD) == "$head_before" ]]
[[ $("$ctl" -C "$ws" board add 'after archive') == 004 ]]
clean
ok 'archive preserves done task bytes, keeps blocked task, does not call model or reuse IDs'

"$ctl" -C "$ws" board set 004 done >/dev/null
mkdir -p "$ws/tasks/archive/$month"
cp "$ws/tasks/004.md" "$ws/tasks/archive/$month/004.md"
git -C "$ws" add tasks/archive
git -C "$ws" commit -qm 'human: conflicting destination fixture'
head_before=$(git -C "$ws" rev-parse HEAD)
if "$mbot" -C "$ws" archive > "$root/output" 2>&1; then exit 1; fi
contains 'destination exists' "$root/output"
[[ -f $ws/tasks/004.md && $(git -C "$ws" rev-parse HEAD) == "$head_before" ]]
git -C "$ws" rm -q "tasks/archive/$month/004.md"
git -C "$ws" commit -qm 'human: remove collision'
cp "$ws/BOARD.md" "$root/board.before"
cp "$ws/tasks/004.md" "$root/task4.before"
if GIT_AUTHOR_NAME= "$mbot" -C "$ws" archive > "$root/output" 2>&1; then exit 1; fi
cmp "$ws/BOARD.md" "$root/board.before"
cmp "$ws/tasks/004.md" "$root/task4.before"
[[ ! -e $ws/tasks/archive/$month/004.md ]]
clean
ok 'archive destination collision and commit failure leave complete original state'

mkdir -p "$root/project space" "$root/project" "$root/projects"
grants="$root/project space:$root/project:$root/projects"
MBOT_GRANTS="$grants" MBOT_FAKE_MODE=grant "$mbot" -C "$ws" run chief 'grant test' >/dev/null
[[ $(cat "$root/project space/grant-marker") == grant-used ]]
jq -e --arg a "$root/project space" --arg b "$root/project" --arg c "$root/projects" '.grants==[$a,$b,$c] and .success' "$(latest)" >/dev/null
args=$(tr '\0' '\n' < "$root/probes/argv")
[[ $args == *$'--add-dir\n'* && $args == *"$root/project space"* ]]
ok 'physical grants with spaces and shared prefixes become separate add-dir arguments and audit roots'

ln -s "$root/project" "$root/alias"
before_calls=$(wc -l < "$root/probes/invocations")
for grant in / "$repo" "$(dirname "$repo")" "$repo/bin" "$ws" "$ws/tasks" "$root" "$HOME/.dsh" "$root/alias" "$root/missing" relative \
  "$root/project:" ":$root/project" "$root/project::$root/projects" "$root/project:$root/project" "$root/project/" "$root/project/../projects" $'/tmp\n/other'; do
  if MBOT_GRANTS="$grant" MBOT_FAKE_MODE=noop "$mbot" -C "$ws" run chief 'invalid grant' > "$root/output" 2>&1; then printf 'Unexpected accepted grant: %s\n' "$grant" >&2; exit 1; fi
done
mkdir -p "$root/custom-dsh"
if DSH_HOME="$root/custom-dsh" MBOT_GRANTS="$root/custom-dsh" "$mbot" -C "$ws" run 'invalid DSH root' > "$root/output" 2>&1; then exit 1; fi
[[ $(wc -l < "$root/probes/invocations") == "$before_calls" ]]
clean
ok 'invalid, alias, duplicate and protected grants fail before a model call'

MBOT_GRANTS="$root/project" MBOT_FAKE_MODE=dream-noop "$mbot" -C "$ws" dream >/dev/null
dream_meta=("$ws/dream-reports/"*.meta.json)
jq -e '.grants==[] and .success' "${dream_meta[0]}" >/dev/null
ok 'dream does not inherit external grants'

for command in tick archive; do
  if MBOT_RUN_ID=inside "$mbot" -C "$root/missing" "$command" > "$root/output" 2>&1; then exit 1; fi
  contains "nested mbot $command" "$root/output"
done
"$mbot" -C "$ws" pause 'test pause' >/dev/null
head_before=$(git -C "$ws" rev-parse HEAD)
"$mbot" -C "$ws" tick >/dev/null
"$mbot" -C "$ws" archive >/dev/null
[[ $(git -C "$ws" rev-parse HEAD) == "$head_before" ]]
"$mbot" -C "$ws" resume >/dev/null
rm -f "$root/probes/started"
MBOT_FAKE_MODE=slow "$mbot" -C "$ws" run chief 'lock probe' > "$root/slow.out" 2>&1 &
pid=$!
for i in {1..100}; do [[ ! -f $root/probes/started ]] || break; sleep 0.02; done
[[ -f $root/probes/started ]]
"$mbot" -C "$ws" tick > "$root/output"
contains 'another run is active' "$root/output"
"$mbot" -C "$ws" archive > "$root/output"
contains 'another run is active' "$root/output"
wait "$pid"
clean
ok 'tick/archive honor pause, shared lock and nested entry denial'
printf '%s schedule checks passed\n' "$count"
