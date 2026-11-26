#!/usr/bin/env bash

mbot_turn_write_ledger() {
  local phase=$1 temp
  mbot_guard_parent .mbot/runs/active-turn.json
  mbot_path .mbot/runs/active-turn.json >/dev/null
  [[ ! -L $ledger && ! -d $ledger ]] || rm -rf -- "$ledger"
  temp=$(mktemp "$MBOT_WS/.mbot/runs/active-turn.XXXXXX")
  printf '%s' "$phase" | jq -Rs --slurpfile original "$MBOT_SCRATCH/ledger.json" '. as $phase | $original[0] + {phase:$phase}' > "$temp"
  mv -- "$temp" "$ledger"
}
mbot_turn_finalize() {
  flock 9
  [[ $(stat -c '%d:%i' "$MBOT_GIT_DIR" 2>/dev/null || true) == "$MBOT_GIT_INODE" && $(realpath -e -- "$MBOT_GIT_DIR" 2>/dev/null || true) == "$MBOT_GIT_DIR" ]] || { mbot_error 'Git directory replaced during managed turn'; exit 1; }
  mbot_guard_run
  mbot_turn_write_ledger committing
  jq -cs 'def text: [.content[]? | select(.type=="text") | .text] | join("\n");
    .[] | if .type=="tool/call" then {type:"tool_call",tool:.data.name,input:(.data.arguments|try fromjson catch .)}
      elif .type=="tool/result" then {type:"tool_result",result:(.data.message|text)}
      elif .type=="assistant/message" and .data.usage then {type:"status",phase:"step_end",usage:.data.usage}
      else empty end' "$MBOT_SCRATCH/session-events.jsonl" > "$MBOT_SCRATCH/raw.jsonl"
  jq -c --slurpfile header "$MBOT_SCRATCH/header.json" '{type:"final",text:.text,reason:.reason,sessionId:$header[0].sessionId}' "$MBOT_SCRATCH/finish.json" >> "$MBOT_SCRATCH/raw.jsonl"
  rc=1
  jq -e '.reason.kind=="completed"' "$MBOT_SCRATCH/finish.json" >/dev/null && rc=0
  elapsed=$(($(date +%s%3N)-start))
  request=$(jq -r .request "$MBOT_SCRATCH/header.json")
  mbot_render "$request" "$elapsed" "$rc" "$role" ''
  jq --slurpfile header "$MBOT_SCRATCH/header.json" --slurpfile journal "$MBOT_SCRATCH/ledger.json" --slurpfile session "$MBOT_SCRATCH/session-events.jsonl" '
    def cancellation_error: .=="ABORTED" or .=="ABORTED_BEFORE_DISPATCH" or .=="APPROVAL_CANCELLED";
    any($session[];
      ((.type=="assistant/message" or .type=="assistant/attempt") and any(.data.stream[]?;
        .chunk.type=="finish" and (.chunk.reason.kind=="max-tokens"
          or (.chunk.reason.kind=="error" and (.chunk.reason.failure.code | cancellation_error | not)))))
      or (.type=="tool/result" and .data.message.isError==true and (.data.error.code | cancellation_error | not))) as $execution_fault |
    (if .success then "completed"
     elif $journal[0].schemaVersion==2 and .reason.kind=="aborted" and .reason.reason.kind=="user" and (.violations|length)==0 and ($execution_fault|not) then "cancelled"
     else "failed" end) as $outcome |
    . + {outcome:$outcome, failure_count_effect:(if $outcome=="completed" then "reset" elif $outcome=="cancelled" then "preserve" else "increment" end),
      runtime:{kind:"managed-turn",schemaVersion:1, outcome_schema_version:1, execution_fault:$execution_fault,
        bot_id:$header[0].botId,session_id:$header[0].sessionId,turn:$header[0].turn,request_ids:$header[0].requestIds}}' \
    "$MBOT_SCRATCH/meta.json" | mbot_scrub > "$MBOT_SCRATCH/managed-meta.json"
  mv -- "$MBOT_SCRATCH/managed-meta.json" "$MBOT_SCRATCH/meta.json"
  mbot_turn_outcome "$MBOT_SCRATCH/meta.json" || return 1
  if [[ ${MBOT_RECOVERING:-0} == 1 ]]; then
    jq '.runtime.recovered=true' "$MBOT_SCRATCH/meta.json" > "$MBOT_SCRATCH/recovered-meta.json"
    mv -- "$MBOT_SCRATCH/recovered-meta.json" "$MBOT_SCRATCH/meta.json"
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
  cp -- "$MBOT_SCRATCH/session-events.jsonl" "$MBOT_WS/.mbot/runs/$MBOT_RUN_ID.session.jsonl"
  mbot_git add -A -- BOARD.md tasks inbox "$transcript" "$meta"
  summary=$(jq -r .summary "$MBOT_SCRATCH/meta.json")
  # Persist exact commit intent before advancing HEAD. Recovery can recognize a
  # completed commit even if the process died before publishing its receipt.
  jq -n --arg tree "$(mbot_git write-tree)" --arg parent "$MBOT_BASE" --arg ref "$MBOT_BASE_REF" \
    --arg message "run($role): $MBOT_RUN_ID $summary" --arg meta "$meta" --arg transcript "$transcript" \
    '{tree:$tree,parent:$parent,ref:$ref,message:$message,meta:$meta,transcript:$transcript}' > "$MBOT_SCRATCH/commit-intent.tmp"
  mv -- "$MBOT_SCRATCH/commit-intent.tmp" "$MBOT_SCRATCH/commit-intent.json"
  if ! mbot_git commit -q -m "run($role): $MBOT_RUN_ID $summary"; then mbot_error 'managed turn commit failed; preserved for recovery'; exit 1; fi
  head=$(mbot_git rev-parse HEAD)
  mbot_turn_write_ledger committed
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
  turn_outcome=$(jq -er --slurpfile journal "$MBOT_SCRATCH/ledger.json" '
    if (.success|type)!="boolean" then error("invalid success")
    elif $journal[0].schemaVersion==2 and .runtime.outcome_schema_version!=1 then error("v2 journal requires versioned outcome")
    elif (has("outcome") or has("failure_count_effect") or .runtime.outcome_schema_version!=null) then
      if .runtime.outcome_schema_version!=1 or (.runtime.execution_fault|type)!="boolean" or (.violations|type)!="array" then error("invalid outcome version")
      elif .outcome=="completed" and .success==true and .failure_count_effect=="reset" and (.violations|length)==0 then .outcome
      elif .outcome=="cancelled" and .success==false and .failure_count_effect=="preserve"
        and $journal[0].schemaVersion==2 and .reason.kind=="aborted" and .reason.reason.kind=="user" and (.violations|length)==0 and .runtime.execution_fault==false then .outcome
      elif .outcome=="failed" and .success==false and .failure_count_effect=="increment" then .outcome
      else error("invalid outcome effect") end
    elif .success then "completed" else "failed" end' "$file") \
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
}
