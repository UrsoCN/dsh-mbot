#!/usr/bin/env bash

mbot_turn_write_ledger() {
  local phase=$1
  mbot_guard_parent .mbot/runs/active-turn.json
  mbot_path .mbot/runs/active-turn.json >/dev/null
  [[ ! -L $ledger && ! -d $ledger ]] || rm -rf -- "$ledger"
  printf '%s' "$phase" | jq -Rs --slurpfile original "$MBOT_SCRATCH/ledger.json" '. as $phase | $original[0] + {phase:$phase}' \
    | node "$MBOT_ROOT/bin/turn-state.mjs" --atomic-write "$ledger"
}
mbot_turn_finalize() {
  local events_file=${MBOT_RECOVERY_EVENTS:-$MBOT_SCRATCH/session-events.jsonl} finish_file=${MBOT_RECOVERY_FINISH:-$MBOT_SCRATCH/finish.json}
  local turn_ledger=${MBOT_RECOVERY_LEDGER:-$MBOT_SCRATCH/ledger.json}
  flock 9
  if [[ $(jq -r .schemaVersion "$MBOT_SCRATCH/ledger.json") == 3 ]]; then
    if [[ ${MBOT_RECOVERING:-0} == 1 ]]; then
      node "$MBOT_ROOT/bin/turn-runtime-recovery.mjs" --validate "$MBOT_RUNTIME_RECOVERY_PROOF" "$MBOT_WS"
    else
      node "$MBOT_ROOT/bin/turn-actor.mjs" --prepare-finalization "$MBOT_SCRATCH" "$MBOT_WS"
    fi
  fi
  [[ $(stat -c '%d:%i' "$MBOT_GIT_DIR" 2>/dev/null || true) == "$MBOT_GIT_INODE" && $(realpath -e -- "$MBOT_GIT_DIR" 2>/dev/null || true) == "$MBOT_GIT_DIR" ]] || { mbot_error 'Git directory replaced during managed turn'; exit 1; }
  mbot_guard_run
  if [[ $(jq -r .schemaVersion "$MBOT_SCRATCH/ledger.json") == 5 ]]; then
    local candidate
    candidate=$(node "$MBOT_ROOT/bin/turn-domain.mjs" --candidate-path "$MBOT_SCRATCH" "$MBOT_WS")
    # Enumerating changed files alone cannot detect a newly written file/row
    # that disappeared after the tool acknowledged it.
    if ! node "$MBOT_ROOT/bin/turn-domain.mjs" --guard "$MBOT_SCRATCH" "$MBOT_WS" "$candidate" "$events_file" >/dev/null 2>&1; then
      mbot_violation "$candidate" candidate_receipt_mismatch
      mbot_restore "$candidate"
    fi
  fi
  mbot_turn_write_ledger committing
  jq -cs 'def text: [.content[]? | select(.type=="text") | .text] | join("\n");
    .[] | if .type=="tool/call" then {type:"tool_call",tool:.data.name,input:(.data.arguments|try fromjson catch .)}
      elif .type=="tool/result" then {type:"tool_result",result:(.data.message|text)}
      elif .type=="assistant/message" and .data.usage then {type:"status",phase:"step_end",usage:.data.usage}
      elif .type=="plugin:mbot/compact-output" and .data.usage then {type:"status",phase:"step_end",usage:.data.usage}
      else empty end' "$events_file" > "$MBOT_SCRATCH/raw.jsonl"
  jq -c --slurpfile header "$MBOT_SCRATCH/header.json" '{type:"final",text:.text,reason:.reason,sessionId:$header[0].sessionId}' "$finish_file" >> "$MBOT_SCRATCH/raw.jsonl"
  rc=1
  jq -e '.reason.kind=="completed"' "$finish_file" >/dev/null && rc=0
  elapsed=$(($(date +%s%3N)-start))
  request=$(jq -r .request "$MBOT_SCRATCH/header.json")
  mbot_render "$request" "$elapsed" "$rc" "$role" ''
  node "$MBOT_ROOT/bin/turn-reply.mjs" "$MBOT_SCRATCH/header.json" "$events_file" "$finish_file" > "$MBOT_SCRATCH/reply.json"
  jq -L "$MBOT_ROOT/lib" --slurpfile header "$MBOT_SCRATCH/header.json" --slurpfile journal "$turn_ledger" --slurpfile session "$events_file" --slurpfile reply "$MBOT_SCRATCH/reply.json" '
    include "turn-outcome";
    (mbot_execution_fault($session) or any($journal[0].actors[]?; .native.executionFault==true)) as $execution_fault |
    .success=(.success and ($execution_fault|not)) |
    (if .success then "completed"
     elif ($journal[0].schemaVersion==2 or $journal[0].schemaVersion==3 or $journal[0].schemaVersion==4 or $journal[0].schemaVersion==5) and .reason.kind=="aborted" and .reason.reason.kind=="user" and (.violations|length)==0 and ($execution_fault|not) then "cancelled"
     else "failed" end) as $outcome |
    . + {outcome:$outcome, failure_count_effect:(if $outcome=="completed" then "reset" elif $outcome=="cancelled" then "preserve" else "increment" end),
      runtime:({kind:"managed-turn",schemaVersion:1, outcome_schema_version:1, execution_fault:$execution_fault,
        bot_id:$header[0].botId,session_id:$header[0].sessionId,turn:$header[0].turn,
        request_ids:(reduce ($header[0].requestIds[], ($session[] | select(.type=="user/message") | .data.source |
          select(.kind=="user" or .kind=="retry") | (.rpcId // .requestId) | select(type=="string" and length>0))) as $id
          ([]; if index($id)==null then . + [$id] else . end))}
          + (if $reply[0]==null then {} else {writer_scope:"agent-runtime",journal_schema_version:$journal[0].schemaVersion,reply:$reply[0]} end)
          + (if $journal[0].schemaVersion==3 then {actors:[$journal[0].actors[] | del(.token)]} else {} end))}' \
    "$MBOT_SCRATCH/meta.json" | mbot_scrub > "$MBOT_SCRATCH/managed-meta.json"
  node "$MBOT_ROOT/bin/turn-reply.mjs" --seal-meta "$MBOT_SCRATCH/reply.json" "$MBOT_SCRATCH/managed-meta.json" "$events_file" "$MBOT_WS" "$MBOT_SCRATCH/header.json" > "$MBOT_SCRATCH/sealed-meta.json"
  mv -- "$MBOT_SCRATCH/sealed-meta.json" "$MBOT_SCRATCH/meta.json"
  mbot_turn_outcome "$MBOT_SCRATCH/meta.json" || return 1
  if [[ ${MBOT_RECOVERING:-0} == 1 ]]; then
    jq '.runtime.recovered=true' "$MBOT_SCRATCH/meta.json" > "$MBOT_SCRATCH/recovered-meta.json"
    mv -- "$MBOT_SCRATCH/recovered-meta.json" "$MBOT_SCRATCH/meta.json"
    if [[ -n ${MBOT_RUNTIME_RECOVERY_PROOF:-} ]]; then
      jq --slurpfile proof "$MBOT_RUNTIME_RECOVERY_PROOF" 'if $proof[0].mode=="legacy-readonly" then .runtime.recovery_proof=$proof[0].evidence else . end' \
        "$MBOT_SCRATCH/meta.json" > "$MBOT_SCRATCH/recovered-proof-meta.json"
      mv -- "$MBOT_SCRATCH/recovered-proof-meta.json" "$MBOT_SCRATCH/meta.json"
    fi
  fi
  printf '\n## Managed turn\n\n' >> "$MBOT_SCRATCH/transcript.md"
  jq -r '{runtime, outcome, failure_count_effect} | tojson | "    " + .' "$MBOT_SCRATCH/meta.json" >> "$MBOT_SCRATCH/transcript.md"
  day=$(date +%F)
  transcript=transcripts/$day/$MBOT_RUN_ID.md
  meta=transcripts/$day/$MBOT_RUN_ID.meta.json
  mbot_path "$transcript" >/dev/null; mbot_path "$meta" >/dev/null
  mkdir -p -- "$MBOT_WS/transcripts/$day"
  cp -- "$MBOT_SCRATCH/transcript.md" "$MBOT_WS/$transcript"
  cp -- "$MBOT_SCRATCH/meta.json" "$MBOT_WS/$meta"
  cp -- "$MBOT_SCRATCH/raw.jsonl" "$MBOT_WS/.mbot/runs/$MBOT_RUN_ID.jsonl"
  cp -- "$events_file" "$MBOT_WS/.mbot/runs/$MBOT_RUN_ID.session.jsonl"
  mbot_git add -A -- BOARD.md tasks inbox "$transcript" "$meta"
  if [[ $(jq -r .schemaVersion "$MBOT_SCRATCH/ledger.json") == 5 ]]; then
    [[ ! -f $MBOT_WS/$candidate ]] || mbot_git add -- "$candidate"
  fi
  summary=$(jq -r .summary "$MBOT_SCRATCH/meta.json")
  # Persist exact commit intent before advancing HEAD. Recovery can recognize a
  # completed commit even if the process died before publishing its receipt.
  jq -n --arg tree "$(mbot_git write-tree)" --arg parent "$MBOT_BASE" --arg ref "$MBOT_BASE_REF" \
    --arg message "run($role): $MBOT_RUN_ID $summary" --arg meta "$meta" --arg transcript "$transcript" \
    '{tree:$tree,parent:$parent,ref:$ref,message:$message,meta:$meta,transcript:$transcript}' \
    | node "$MBOT_ROOT/bin/turn-state.mjs" --atomic-write "$MBOT_SCRATCH/commit-intent.json"
  node "$MBOT_ROOT/bin/turn-state.mjs" --sync "$MBOT_SCRATCH/meta.json" "$MBOT_SCRATCH/transcript.md" "$MBOT_SCRATCH/raw.jsonl" "$events_file" "$MBOT_SCRATCH"
  if [[ ${MBOT_RECOVERING:-0} == 1 && -n ${MBOT_RUNTIME_RECOVERY_PROOF:-} ]]; then
    node "$MBOT_ROOT/bin/turn-runtime-recovery.mjs" --validate "$MBOT_RUNTIME_RECOVERY_PROOF" "$MBOT_WS"
  fi
  if ! mbot_git commit -q -m "run($role): $MBOT_RUN_ID $summary"; then mbot_error 'managed turn commit failed; preserved for recovery'; exit 1; fi
  head=$(mbot_git rev-parse HEAD)
  mbot_turn_write_ledger committed
  if [[ ${MBOT_RECOVERING:-0} == 1 && -n ${MBOT_RUNTIME_RECOVERY_PROOF:-} ]]; then
    node "$MBOT_ROOT/bin/turn-runtime-recovery.mjs" --validate "$MBOT_RUNTIME_RECOVERY_PROOF" "$MBOT_WS"
  fi
  mbot_turn_settle "$meta"
  settled=1
  jq -cn --arg id "$MBOT_RUN_ID" --arg head "$head" --arg meta "$meta" --arg transcript "$transcript" --argjson success "$((1-failed))" --argjson recovering "${MBOT_RECOVERING:-0}" --arg outcome "$turn_outcome" --arg effect "$failure_count_effect" \
    '{kind:(if $recovering==1 then "recovered" else "finished" end),runId:$id,head:$head,meta:$meta,transcript:$transcript,success:($success==1),outcome:$outcome,failureCountEffect:$effect}
      + (if $recovering==1 then {needed:true,alreadyCommitted:false} else {} end)'
}

mbot_turn_outcome() {
  local file=$1
  # Legacy commits keep their original boolean settlement. New outcome records
  # are validated before touching the counter; recovery never guesses from text.
  turn_outcome=$(jq -L "$MBOT_ROOT/lib" -er --slurpfile journal "$MBOT_SCRATCH/ledger.json" 'include "turn-outcome"; mbot_outcome($journal[0].schemaVersion)' "$file") \
    || { mbot_error 'invalid managed outcome; retained for recovery'; return 1; }
  case $turn_outcome in
    completed) failure_count_effect=reset ;;
    cancelled) failure_count_effect=preserve ;;
    failed) failure_count_effect=increment ;;
  esac
}

mbot_turn_settle() {
  local meta=$1
  failed=0
  jq -e .success "$MBOT_WS/$meta" >/dev/null || failed=1
  mbot_turn_outcome "$MBOT_WS/$meta" || return 1
  case $failure_count_effect in
    reset) base_failures=0 ;;
    preserve) ;;
    increment) base_failures=$((base_failures+1)) ;;
  esac
  printf '%s\n' "$base_failures" > "$(mbot_path .mbot/failures)"
  if ((base_failures>=3)); then mbot_mark_paused 'Automatically paused after three failed managed turns.'; fi
  rm -- "$ledger"
  node "$MBOT_ROOT/bin/turn-state.mjs" --sync "$MBOT_WS/.mbot/failures" "$MBOT_WS/.mbot/runs"
}
