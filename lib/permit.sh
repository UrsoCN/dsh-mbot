#!/usr/bin/env bash

mbot_turn_ledger() { mbot_path .mbot/runs/active-turn.json; }

# The legacy headless identity remains valid when there is no managed turn.
# New managed callers carry a permit and must never fall back after it expires.
mbot_check_permit() {
  local mutation=$1 file scratch
  unset MBOT_ACTOR_ID MBOT_ACTOR_TASK
  file=$(mbot_turn_ledger)
  if [[ -v MBOT_PERMIT_TOKEN ]]; then
    [[ -v MBOT_RUN_ID && -f $file && ! -L $file ]] || { mbot_error 'managed turn permit is no longer active'; return 1; }
    jq -e --argjson now "$(date +%s%3N)" '.phase=="active" and (.expiresAt|type)=="number" and .expiresAt>$now' "$file" >/dev/null \
      || { mbot_error 'managed turn permit is stale or invalid'; return 1; }
    scratch=$(jq -r .scratch "$file")
    [[ $scratch =~ ^/tmp/mbot-turn\.[A-Za-z0-9]+$ && -d $scratch && ! -L $scratch
      && $(stat -c '%u:%a' "$scratch") == "$UID:700" && -f $scratch/ledger.json && ! -L $scratch/ledger.json ]] \
      || { mbot_error 'unsafe managed permit snapshot'; return 1; }
    jq -e --slurpfile saved "$scratch/ledger.json" '. == $saved[0]' "$file" >/dev/null \
      || { mbot_error 'managed permit identity changed'; return 1; }
    local actor
    actor=$(printf '%s\0%s' "$MBOT_RUN_ID" "$MBOT_PERMIT_TOKEN" | jq -Rse --argjson now "$(date +%s%3N)" --slurpfile permit "$file" '
      split("\u0000") as $identity | $permit[0] |
      select((.schemaVersion==1 or .schemaVersion==2 or .schemaVersion==3) and .phase=="active" and .expiresAt>$now and .runId==$identity[0]) |
      if .token==$identity[1] then {role:.role}
      elif .schemaVersion==3 and .runtimeOwnership.schemaVersion==2 and .runtimeOwnership.mode=="foreground-workers"
        and .runtimeOwnership.workerDepth==1 and .runtimeOwnership.maxWorkers==2 then
        .actors[] | select(.state=="active" and .token==$identity[1]) | {role,actorId,taskId}
      else empty end') || { mbot_error 'managed turn permit is stale or invalid'; return 1; }
    MBOT_BOT=$(jq -er .role <<< "$actor")
    if jq -e '.actorId!=null' <<< "$actor" >/dev/null; then
      MBOT_ACTOR_ID=$(jq -er .actorId <<< "$actor")
      MBOT_ACTOR_TASK=$(jq -er .taskId <<< "$actor")
      [[ $MBOT_ACTOR_ID =~ ^[a-f0-9]{32}$ && $MBOT_ACTOR_TASK =~ ^[0-9]{3,9}$ ]] || { mbot_error 'invalid delegated actor identity'; return 1; }
    fi
    [[ $MBOT_BOT =~ ^[a-z][a-z0-9_-]{0,31}$ && $MBOT_BOT != human ]] || { mbot_error 'invalid managed actor role'; return 1; }
  elif [[ -e $file || -L $file ]]; then
    if [[ $mutation == 1 || -v MBOT_RUN_ID ]]; then mbot_error 'managed turn requires its active permit; inspect or recover the turn first'; return 1; fi
  fi
}

mbot_check_actor() {
  [[ ! -v MBOT_PERMIT_TOKEN || $1 == "$MBOT_BOT" ]] || { mbot_error 'author must match the managed role'; return 1; }
}

mbot_require_no_turn() {
  local file
  file=$(mbot_turn_ledger)
  [[ ! -e $file && ! -L $file ]] || { mbot_error 'managed turn is active or needs recovery; inspect active-turn.json'; return 1; }
}

# Recheck assignment under botctl.lock. A new owner/state invalidates old work.
mbot_check_command() {
  [[ -v MBOT_ACTOR_ID ]] || return 0
  local row
  row=$(mbot_rows | awk -F '|' -v id="$MBOT_ACTOR_TASK" '$1==id')
  [[ $row == "$MBOT_ACTOR_TASK|doing|$MBOT_BOT|"* ]] || { mbot_error 'delegated task assignment changed'; return 1; }
  case ${1:-} in
    boot) [[ $# == 4 && $2 == "$MBOT_BOT" && $3 == --task && $4 == "$MBOT_ACTOR_TASK" ]] ;;
    lint) [[ $# == 1 ]] ;;
    board) [[ ${2:-} == show ]] ;;
    task) [[ ( ${2:-} == show || ${2:-} == result ) && ${3:-} == "$MBOT_ACTOR_TASK" ]] ;;
    remember) return 0 ;;
    *) false ;;
  esac || { mbot_error 'operation is outside the delegated role/task scope'; return 1; }
}
