#!/usr/bin/env bash

mbot_turn_save_settings() {
  local key
  for key in MBOT_MEMORY_MAX_LINES MBOT_MEMORY_MAX_CHARS MBOT_SOUL_MAX_CHARS MBOT_WIKI_MAX_LINES MBOT_BOARD_MAX_LINES MBOT_TIMEOUT; do
    printf '%s=%s\n' "$key" "${!key}"
  done > "$MBOT_SCRATCH/settings"
}

mbot_turn_recover() {
  local ledger scratch actual key value role base_failures start settled=0
  local -A limits=()
  ledger=$(mbot_turn_ledger)
  exec 8> "$(mbot_path .mbot/lock)"
  flock -n 8 || { mbot_error 'turn writer is active; cannot recover it'; return 1; }
  if [[ ! -e $ledger ]]; then printf '{"kind":"recovered","needed":false}\n'; return; fi
  [[ -f $ledger && ! -L $ledger ]] || { mbot_error 'invalid turn journal'; return 1; }
  jq -e --arg workspace "$MBOT_WS" '.schemaVersion==1 and .workspace==$workspace and .writerScope=="data-subprocesses"
    and (.runId|type)=="string" and (.runId|test("^[0-9]{8}T[0-9]{6}Z-turn-[a-f0-9]{16}$"))
    and (.token|type)=="string" and (.token|test("^[a-f0-9]{64}$"))
    and (.scratch|type)=="string" and (.scratch|test("^/tmp/mbot-turn\\.[A-Za-z0-9]+$"))
    and (.pid|type)=="number" and .pid>0 and (.pid|floor)==.pid
    and (.pidStart|type)=="string" and (.pidStart|test("^[0-9]+$"))
    and (.ownerPid|type)=="number" and .ownerPid>=0 and (.ownerPid|floor)==.ownerPid
    and (.ownerStart|type)=="string" and (.ownerPid==0 or (.ownerStart|test("^[0-9]+$")))
    and (.role|type)=="string" and .role!="human" and (.role|test("^[a-z][a-z0-9_-]{0,31}$"))
    and (.baseHead|type)=="string" and (.baseHead|test("^([a-f0-9]{40}|[a-f0-9]{64})$"))
    and (.baseRef|type)=="string" and (.startedAt|type)=="string"
    and (.startedMs|type)=="number" and .startedMs>0 and (.baseFailures|type)=="number" and .baseFailures>=0
    and (.phase=="active" or .phase=="abandoned" or .phase=="committing" or .phase=="committed")' "$ledger" >/dev/null 2>&1 \
    || { mbot_error 'invalid or incomplete turn journal; review manually'; return 1; }
  scratch=$(jq -r .scratch "$ledger")
  [[ -d $scratch && ! -L $scratch && $(stat -c '%u:%a' "$scratch") == "$UID:700" ]] || { mbot_error 'private turn snapshot is missing or unsafe; review manually'; return 1; }
  node "$MBOT_ROOT/bin/turn-snapshot.mjs" "$scratch"
  jq -e --slurpfile saved "$scratch/ledger.json" 'del(.phase)==($saved[0]|del(.phase))' "$ledger" >/dev/null 2>&1 \
    || { mbot_error 'turn journal does not match its private snapshot'; return 1; }
  jq -e --slurpfile saved "$scratch/ledger.json" --slurpfile token "$scratch/token.json" '
    .schemaVersion==1 and .kind=="begin" and .botId==$saved[0].botId and .sessionId==$saved[0].sessionId
    and .turn==$saved[0].turn and (.request|type)=="string" and (.request|contains("\u0000")|not)
    and (.requestIds|type)=="array" and all(.requestIds[]; type=="string" and length>0 and (test("[\u0000\r\n]")|not))
    and $token[0]==$saved[0].token' "$scratch/header.json" >/dev/null 2>&1 \
    || { mbot_error 'turn inputs do not match their private identity'; return 1; }
  node "$MBOT_ROOT/bin/turn-writers.mjs" "$ledger" "${MBOT_RECOVERY_OWNER:-0}" "${MBOT_RECOVERY_START:-}" >/dev/null
  MBOT_SCRATCH=$scratch
  MBOT_GIT_DIR=$(jq -r .gitDir "$ledger")
  MBOT_GIT_INODE=$(jq -r .gitInode "$ledger")
  [[ $(realpath -e -- "$(git -C "$MBOT_WS" rev-parse --absolute-git-dir 2>/dev/null)" 2>/dev/null || true) == "$MBOT_GIT_DIR" ]] \
    || { mbot_error 'workspace Git binding changed; review manually'; return 1; }
  [[ $(realpath -e -- "$MBOT_GIT_DIR" 2>/dev/null || true) == "$MBOT_GIT_DIR" && $(stat -c '%d:%i' "$MBOT_GIT_DIR" 2>/dev/null || true) == "$MBOT_GIT_INODE" ]] \
    || { mbot_error 'turn Git identity changed; review manually'; return 1; }
  MBOT_LOCK_INODE=$(jq -r .lockInodes "$ledger")
  [[ $(stat -c '%d:%i' "$MBOT_WS/.mbot/lock" "$MBOT_WS/.mbot/botctl.lock" 2>/dev/null || true) == "$MBOT_LOCK_INODE" ]] \
    || { mbot_error 'turn lock identity changed; review manually'; return 1; }
  exec 9> "$(mbot_path .mbot/botctl.lock)"
  flock -n 9 || { mbot_error 'a data operation is still active; retry after it settles'; return 1; }
  MBOT_BASE=$(jq -r .baseHead "$ledger")
  MBOT_BASE_REF=$(jq -r .baseRef "$ledger")
  MBOT_RUN_ID=$(jq -r .runId "$ledger")
  MBOT_MODE=run
  MBOT_STARTED=$(jq -r .startedAt "$ledger")
  start=$(jq -er .startedMs "$ledger")
  base_failures=$(jq -er .baseFailures "$ledger")
  role=$(jq -r .role "$ledger")
  while IFS='=' read -r key value; do
    case $key in MBOT_MEMORY_MAX_LINES|MBOT_MEMORY_MAX_CHARS|MBOT_SOUL_MAX_CHARS|MBOT_WIKI_MAX_LINES|MBOT_BOARD_MAX_LINES|MBOT_TIMEOUT) ;;
      *) mbot_error 'invalid saved turn settings'; return 1 ;; esac
    [[ $value =~ ^[1-9][0-9]{0,8}$ ]] || { mbot_error 'invalid saved turn limit'; return 1; }
    [[ ! -v limits[$key] ]] || { mbot_error 'duplicate saved turn limit'; return 1; }
    limits[$key]=$value
    printf -v "$key" '%s' "$value"
  done < "$scratch/settings"
  ((${#limits[@]}==6)) || { mbot_error 'missing saved turn limit'; return 1; }
  # SIGKILL may leave an unexpired active permit. Fence it while holding both
  # locks, before restoring data; retries after a failed recovery stay fenced.
  if [[ $(jq -r .phase "$ledger") == active ]]; then mbot_turn_write_ledger abandoned; fi
  mbot_mark_paused 'Recovered managed turn; review status and audit before explicit resume.'
  # Keep evidence and pause on a second interruption, including after Git commit.
  trap 'mbot_mark_paused "Turn recovery interrupted; review and retry recovery." || true' EXIT
  if [[ $(jq -r .phase "$ledger") == committed && ( ! -f $scratch/commit-intent.json || $(mbot_git rev-parse HEAD) == "$MBOT_BASE" ) ]]; then
    mbot_error 'committed turn HEAD or commit intent changed; review manually'; return 1
  fi
  if [[ -f $scratch/commit-intent.json && $(mbot_git rev-parse HEAD) != "$MBOT_BASE" ]]; then
    local commit meta intent=$scratch/commit-intent.json
    commit=$(mbot_git rev-parse HEAD); meta=$(jq -er .meta "$intent")
    jq -e --arg id "$MBOT_RUN_ID" --arg base "$MBOT_BASE" --arg ref "$MBOT_BASE_REF" '
      .parent==$base and .ref==$ref and (.tree|test("^([a-f0-9]{40}|[a-f0-9]{64})$"))
      and (.meta|test("^transcripts/[0-9]{4}-[0-9]{2}-[0-9]{2}/"+$id+"\\.meta\\.json$"))
      and .transcript==(.meta|sub("\\.meta\\.json$";".md")) and (.message|type)=="string"' "$intent" >/dev/null 2>&1 \
      || { mbot_error 'invalid saved commit intent'; return 1; }
    [[ $(mbot_git show -s --format=%P HEAD) == "$MBOT_BASE" && $(mbot_git rev-parse 'HEAD^{tree}') == "$(jq -r .tree "$intent")" \
      && $(mbot_git show -s --format=%B HEAD) == "$(jq -r .message "$intent")" \
      && $(mbot_git symbolic-ref -q HEAD || true) == "$MBOT_BASE_REF" && -z $(mbot_git status --porcelain) ]] \
      || { mbot_error 'HEAD does not match the saved turn commit; review manually'; return 1; }
    mbot_path "$meta" >/dev/null
    mbot_git show "$commit:$meta" | jq -e --arg id "$MBOT_RUN_ID" --arg base "$MBOT_BASE" --slurpfile header "$scratch/header.json" '
      .run_id==$id and .base_head==$base and (.success|type)=="boolean" and .runtime.kind=="managed-turn"
      and .runtime.bot_id==$header[0].botId and .runtime.session_id==$header[0].sessionId and .runtime.turn==$header[0].turn' >/dev/null
    mbot_turn_settle "$meta"
    settled=1
    rm -rf -- "$scratch"
    trap - EXIT
    jq -cn --arg id "$MBOT_RUN_ID" --arg head "$commit" --arg meta "$meta" --argjson success "$((1-failed))" \
      '{kind:"recovered",needed:true,alreadyCommitted:true,runId:$id,head:$head,meta:$meta,success:($success==1)}'
    return
  fi
  # The journal is a Host-owned control record: its abandoned phase is expected.
  for actual in ignored ignored/.mbot ignored/.mbot/runs; do
    [[ -d $scratch/$actual && ! -L $scratch/$actual ]] || { mbot_error 'unsafe ignored-file snapshot'; return 1; }
  done
  [[ ! -L $scratch/ignored/.mbot/runs/active-turn.json ]] || { mbot_error 'unsafe journal snapshot'; return 1; }
  cp -- "$ledger" "$scratch/ignored/.mbot/runs/active-turn.json"
  if [[ ! -f $scratch/finish.json ]]; then
    jq -n --slurpfile token "$scratch/token.json" '{kind:"finish",token:$token[0],reason:{kind:"aborted",message:"Recovered interrupted turn"},text:""}' > "$scratch/finish.json"
  fi
  jq -e --slurpfile token "$scratch/token.json" '.token==$token[0] and (.reason.kind|type)=="string" and (.text|type)=="string"' "$scratch/finish.json" >/dev/null 2>&1 \
    || { mbot_error 'invalid saved turn completion; review and retry recovery'; return 1; }
  MBOT_RECOVERING=1
  mbot_turn_finalize
  rm -rf -- "$scratch"
  trap - EXIT
}
