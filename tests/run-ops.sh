#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s nullglob
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
root=$(mktemp -d /tmp/mbot-ops-tests.XXXXXX)
trap 'code=$?; if ((code==0)); then rm -rf -- "$root"; else printf "Ops artifacts: %s\n" "$root" >&2; fi' EXIT
trap 'printf "Ops FAIL line %s\n" "$LINENO" >&2' ERR
unset MBOT_WS MBOT_RUN_ID MBOT_BOT MBOT_CLI_WS MBOT_GRANTS MBOT_PUSH_AFTER_DREAM MBOT_PUSH_TIMEOUT
export XDG_CONFIG_HOME=$root/config XDG_STATE_HOME=$root/state DSH_HOME=$root/dsh
export MBOT_DSH=$repo/tests/fake-dsh MBOT_TIMEOUT=5 MBOT_FAKE_ARTIFACTS=$root/probes
export GIT_AUTHOR_NAME='mbot ops tests' GIT_AUTHOR_EMAIL=mbot-tests@example.invalid
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
mbot=$repo/bin/mbot
ctl=$repo/bin/botctl
ws=$root/ws
count=0
ok() { count=$((count+1)); printf 'Ops PASS %s: %s\n' "$count" "$1"; }
contains() { [[ $(cat -- "$2") == *"$1"* ]]; }
clean() { [[ -z $(git -C "$ws" status --porcelain) ]]; }
latest_push() {
  local files=("$ws/.mbot/runs/"*.push.json)
  printf '%s\n' "${files[@]}" | xargs -d '\n' ls -t | head -1
}
calls() { if [[ -f $root/probes/invocations ]]; then wc -l < "$root/probes/invocations"; else printf '0\n'; fi; }
dream() { MBOT_FAKE_MODE=${1:-dream-noop} MBOT_PUSH_AFTER_DREAM=1 "$mbot" -C "$ws" dream > "$root/output" 2>&1; }
"$mbot" init "$ws" >/dev/null
branch=$(git -C "$ws" symbolic-ref HEAD)
git init --bare -q "$root/upstream.git"
git -C "$ws" remote add origin "$root/upstream.git"
git -C "$ws" push -qu origin "$branch"
remote_before=$(git --git-dir="$root/upstream.git" rev-parse "$branch")
MBOT_FAKE_MODE=dream-noop "$mbot" -C "$ws" dream >/dev/null
[[ $(git --git-dir="$root/upstream.git" rev-parse "$branch") == "$remote_before" ]]
pushes=("$ws/.mbot/runs/"*.push.json)
[[ ${#pushes[@]} == 0 ]]
ok 'push is disabled by default even with a configured upstream'

dream
jq -e '.attempted and .success and .exit_code==0' "$(latest_push)" >/dev/null
[[ $(git --git-dir="$root/upstream.git" rev-parse "$branch") == "$(git -C "$ws" rev-parse HEAD)" ]]
"$mbot" -C "$ws" status > "$root/status"
contains 'Latest push: attempted=true success=true exit=0' "$root/status"
clean
ok 'successful dream pushes its explicit upstream and reports backup status'

remote_before=$(git --git-dir="$root/upstream.git" rev-parse "$branch")
push_count=$(printf '%s\n' "$ws/.mbot/runs/"*.push.json | wc -l)
if dream dream-error; then exit 1; fi
MBOT_PUSH_AFTER_DREAM=1 MBOT_FAKE_MODE=noop "$mbot" -C "$ws" run chief 'read-only' >/dev/null
[[ $(git --git-dir="$root/upstream.git" rev-parse "$branch") == "$remote_before" ]]
[[ $(printf '%s\n' "$ws/.mbot/runs/"*.push.json | wc -l) == "$push_count" ]]
clean
ok 'failed dream and ordinary run never push'

git -C "$ws" branch --unset-upstream
dream
jq -e '.attempted==false and .success==false and .exit_code==128' "$(latest_push)" >/dev/null
[[ $(cat "$ws/.mbot/failures") == 0 && $(git -C "$ws" log -1 --format=%s) == 'dream:'* ]]
git -C "$ws" config "branch.${branch#refs/heads/}.remote" .
git -C "$ws" config "branch.${branch#refs/heads/}.merge" "$branch"
dream
jq -e '.attempted==false and .success==false' "$(latest_push)" >/dev/null
git -C "$ws" branch --set-upstream-to="origin/${branch#refs/heads/}" >/dev/null
clean
ok 'missing or local-dot upstream skips backup without losing the dream commit'

printf '#!/bin/bash\nprintf "rejected https://user:password@example.invalid/repo\\n" >&2\nexit 1\n' > "$root/upstream.git/hooks/pre-receive"
chmod +x "$root/upstream.git/hooks/pre-receive"
dream
jq -e '.attempted and .success==false and .exit_code!=0' "$(latest_push)" >/dev/null
contains 'https://[REDACTED]@example.invalid' "${ws}/.mbot/runs/$(basename "$(latest_push)" .push.json).push.log"
contains 'local dream commit retained' "$root/output"
[[ $(cat "$ws/.mbot/failures") == 0 && ! -e $ws/.mbot/PAUSED ]]
clean
ok 'remote rejection is redacted and does not count as a model failure'

printf '#!/bin/bash\nsleep 10\n' > "$root/upstream.git/hooks/pre-receive"
start=$(date +%s)
MBOT_PUSH_TIMEOUT=1 dream
[[ $(($(date +%s)-start)) -lt 9 ]]
jq -e '.attempted and .exit_code==124 and .success==false' "$(latest_push)" >/dev/null
rm "$root/upstream.git/hooks/pre-receive"
[[ $(cat "$ws/.mbot/failures") == 0 ]]
clean
ok 'backup timeout is bounded and local success remains intact'

git init --bare -q "$root/probes/destination.git"
dream dream-upstream-change
jq -e '.attempted==false and .exit_code==128' "$(latest_push)" >/dev/null
[[ -z $(git --git-dir="$root/probes/destination.git" for-each-ref --format='%(refname)') ]]
git -C "$ws" remote set-url origin "$root/upstream.git"
clean
ok 'upstream destination changed during the model call prevents host push'

for setting in 'MBOT_PUSH_AFTER_DREAM=2' 'MBOT_PUSH_AFTER_DREAM=true' 'MBOT_PUSH_TIMEOUT=0' 'MBOT_PUSH_TIMEOUT=1s'; do
  if env "$setting" "$mbot" -C "$ws" status > "$root/output" 2>&1; then exit 1; fi
done
ok 'push configuration validates static boolean and timeout values'

head_before=$(git -C "$ws" rev-parse HEAD)
before_calls=$(calls)
cron_env=(env -i HOME="$HOME" PATH="$PATH" XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state" DSH_HOME="$root/dsh"
  MBOT_WS="$ws" MBOT_DSH="$MBOT_DSH" MBOT_FAKE_ARTIFACTS="$root/probes" MBOT_FAKE_MODE=dream-noop
  GIT_AUTHOR_NAME="$GIT_AUTHOR_NAME" GIT_AUTHOR_EMAIL="$GIT_AUTHOR_EMAIL" GIT_COMMITTER_NAME="$GIT_COMMITTER_NAME" GIT_COMMITTER_EMAIL="$GIT_COMMITTER_EMAIL")
"${cron_env[@]}" "$repo/ops/cron-run.sh" tick > "$root/output"
[[ $(git -C "$ws" rev-parse HEAD) == "$head_before" && $(calls) == "$before_calls" ]]
logs=("$root/state/mbot/logs/"*.log)
[[ ${#logs[@]} == 1 && $(stat -c %a "${logs[0]}") == 600 ]]
contains 'no todo or doing' "${logs[0]}"
contains 'Exit: 0' "${logs[0]}"
if XDG_STATE_HOME="$ws/state" "$repo/ops/cron-run.sh" -C "$ws" tick > "$root/output" 2>&1; then exit 1; fi
[[ ! -e $ws/state ]]
ok 'cron runs with an empty environment and writes private logs outside the workspace'

"$ctl" -C "$ws" board add 'archive fixture' >/dev/null
"$ctl" -C "$ws" board set 001 done >/dev/null
"${cron_env[@]}" "$repo/ops/cron-run.sh" nightly > "$root/output"
[[ $(git -C "$ws" log -1 --format=%s) == 'dream:'* && $(git -C "$ws" log -1 --skip=1 --format=%s) == 'chore(archive):'* ]]
"$ctl" -C "$ws" board add 'collision fixture' >/dev/null
"$ctl" -C "$ws" board set 002 done >/dev/null
mkdir -p "$ws/tasks/archive/$(date +%Y-%m)"
cp "$ws/tasks/002.md" "$ws/tasks/archive/$(date +%Y-%m)/002.md"
git -C "$ws" add tasks/archive
git -C "$ws" commit -qm 'human: archive collision'
before_calls=$(calls)
head_before=$(git -C "$ws" rev-parse HEAD)
if "${cron_env[@]}" "$repo/ops/cron-run.sh" nightly > "$root/output" 2>&1; then exit 1; fi
[[ $(calls) == "$before_calls" && $(git -C "$ws" rev-parse HEAD) == "$head_before" ]]
git -C "$ws" rm -q "tasks/archive/$(date +%Y-%m)/002.md"
git -C "$ws" commit -qm 'human: remove archive collision'
clean
ok 'nightly archives before dreaming and archive failure short-circuits the model call'

rm -f "$root/probes/started"
MBOT_FAKE_MODE=slow "$repo/ops/cron-run.sh" -C "$ws" nightly > "$root/slow.output" 2>&1 &
pid=$!
for i in {1..100}; do [[ ! -f $root/probes/started ]] || break; sleep 0.02; done
[[ -f $root/probes/started ]]
"$repo/ops/cron-run.sh" -C "$ws" tick > "$root/output"
contains 'exit=0' "$root/output"
if "$repo/ops/observe.sh" -C "$ws" 'busy test' > "$root/output" 2>&1; then exit 1; fi
contains 'a run is active' "$root/output"
wait "$pid"
last_meta=$(git -C "$ws" diff-tree --no-commit-id --name-only -r HEAD -- 'dream-reports/*.meta.json')
jq -e '.success and (.violations|length)==0' "$ws/$last_meta" >/dev/null
clean
ok 'concurrent cron logging does not create guard violations and observation honors the run lock'

mkdir -p "$root/project"
head_before=$(git -C "$ws" rev-parse HEAD)
MBOT_FAKE_MODE=noop MBOT_GRANTS="$root/project" MBOT_PUSH_AFTER_DREAM=1 "$repo/ops/recover.sh" "$ws" > "$root/recover.output" 2>&1
contains 'Recovery cold-start check passed' "$root/recover.output"
recovery=$(sed -n 's/^Recovery artifacts: //p' "$root/recover.output")
[[ $recovery == /tmp/mbot-recover.* && $(git -C "$ws" rev-parse HEAD) == "$head_before" ]]
recover_meta=("$recovery/ws/transcripts/"*/*.meta.json)
jq -e '.success and .grants==[]' "${recover_meta[0]}" >/dev/null
[[ -z $(git -C "$recovery/ws" status --porcelain) ]]
rm -rf -- "$recovery"
clean
ok 'clone recovery cold-start succeeds with grants and pushes cleared, leaving the source unchanged'

MBOT_TEST_SECRET='observation-secret-123456' "$repo/ops/observe.sh" -C "$ws" 'Reviewed observation-secret-123456; day zero only' > "$root/output"
contains 'elapsed whole hours=0' "$root/output"
contains '[REDACTED]' "$ws/wiki/ops-log.md"
contains '验收待人工确认' "$ws/wiki/ops-log.md"
[[ $(git -C "$ws" log -1 --format=%s) == 'human: ops snapshot'* ]]
obs_start=$(sed -n 's/^Observation start UTC: //p' "$ws/wiki/ops-log.md")
cp "$ws/wiki/ops-log.md" "$root/ops.before"
if dream dream-ops; then exit 1; fi
cmp "$ws/wiki/ops-log.md" "$root/ops.before"
last_meta=$(git -C "$ws" diff-tree --no-commit-id --name-only -r HEAD -- 'dream-reports/*.meta.json')
jq -e 'any(.violations[]; .path=="wiki/ops-log.md")' "$ws/$last_meta" >/dev/null
"$repo/ops/observe.sh" -C "$ws" 'Reviewed restored ops-log violation; still pending' >/dev/null
[[ $(sed -n 's/^Observation start UTC: //p' "$ws/wiki/ops-log.md") == "$obs_start" ]]
"$ctl" -C "$ws" lint >/dev/null
clean
ok 'human snapshots redact notes, preserve the observation start and cannot be fabricated by dream'

printf '\nextra\n' >> "$ws/wiki/ops-log.md"
if "$repo/ops/observe.sh" -C "$ws" 'dirty test' > "$root/output" 2>&1; then exit 1; fi
contains 'uncommitted changes' "$root/output"
git -C "$ws" restore wiki/ops-log.md
cp "$ws/wiki/ops-log.md" "$root/ops.before"
if MBOT_WIKI_MAX_LINES=1 "$repo/ops/observe.sh" -C "$ws" 'budget test' > "$root/output" 2>&1; then exit 1; fi
cmp "$ws/wiki/ops-log.md" "$root/ops.before"
printf '%s\n' {1..151} > "$ws/MEMORY.md"
if "$repo/ops/observe.sh" -C "$ws" 'Budget violation recorded for review' > "$root/output" 2>&1; then exit 1; fi
contains 'lint exit: 1' "$ws/wiki/ops-log.md"
contains 'MEMORY.md: 151 lines' "$ws/wiki/ops-log.md"
git -C "$ws" restore MEMORY.md
for script in cron-run recover observe; do
  if MBOT_RUN_ID=inside "$repo/ops/$script.sh" -C "$ws" tick > "$root/output" 2>&1; then exit 1; fi
  contains 'Bots must not invoke' "$root/output"
done
clean
ok 'snapshot rolls back on budget or dirty-target errors, records lint failures and refuses Bot entry'
printf '%s ops checks passed\n' "$count"
