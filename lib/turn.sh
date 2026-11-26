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
  jq --slurpfile header "$MBOT_SCRATCH/header.json" '. + {runtime:{kind:"managed-turn",schemaVersion:1,
    bot_id:$header[0].botId,session_id:$header[0].sessionId,turn:$header[0].turn,request_ids:$header[0].requestIds}}' \
    "$MBOT_SCRATCH/meta.json" | mbot_scrub > "$MBOT_SCRATCH/managed-meta.json"
  mv -- "$MBOT_SCRATCH/managed-meta.json" "$MBOT_SCRATCH/meta.json"
  if [[ ${MBOT_RECOVERING:-0} == 1 ]]; then
    jq '.runtime.recovered=true' "$MBOT_SCRATCH/meta.json" > "$MBOT_SCRATCH/recovered-meta.json"
    mv -- "$MBOT_SCRATCH/recovered-meta.json" "$MBOT_SCRATCH/meta.json"
  fi
  printf '\n## Managed turn\n\n' >> "$MBOT_SCRATCH/transcript.md"
  jq -r '.runtime | tojson | "    " + .' "$MBOT_SCRATCH/meta.json" >> "$MBOT_SCRATCH/transcript.md"
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
  jq -cn --arg id "$MBOT_RUN_ID" --arg head "$head" --arg meta "$meta" --arg transcript "$transcript" --argjson success "$((1-failed))" --argjson recovering "${MBOT_RECOVERING:-0}" \
    '{kind:(if $recovering==1 then "recovered" else "finished" end),runId:$id,head:$head,meta:$meta,transcript:$transcript,success:($success==1)}
      + (if $recovering==1 then {needed:true,alreadyCommitted:false} else {} end)'
}

mbot_turn_settle() {
  local meta=$1
  failed=0
  jq -e .success "$MBOT_WS/$meta" >/dev/null || failed=1
  if ((failed)); then base_failures=$((base_failures+1)); else base_failures=0; fi
  printf '%s\n' "$base_failures" > "$(mbot_path .mbot/failures)"
  if ((base_failures>=3)); then mbot_mark_paused 'Automatically paused after three failed managed turns.'; fi
  rm -- "$ledger"
}
