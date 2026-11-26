#!/usr/bin/env bash

# Secrets travel on stdin/private files, never in process arguments.
mbot_capture_secrets() {
  local name file line value
  : > "$MBOT_SCRATCH/secrets.txt"
  while IFS= read -r name; do
    [[ $name =~ (API_KEY|TOKEN|PASSWORD|SECRET)$ ]] || continue
    printf '%s\n' "${!name}" >> "$MBOT_SCRATCH/secrets.txt"
  done < <(compgen -e)
  for file in "$MBOT_WS/.env" "${DSH_HOME:-$HOME/.dsh}/.env"; do
    [[ -f $file ]] || continue
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line =~ ^(export[[:space:]]+)?[A-Z_]*(API_KEY|TOKEN|PASSWORD|SECRET)=(.*)$ ]]; then
        value=${BASH_REMATCH[3]}
        if [[ $value == \"*\" || $value == \'*\' ]]; then value=${value:1:${#value}-2}; fi
        printf '%s\n' "$value" >> "$MBOT_SCRATCH/secrets.txt"
      fi
    done < "$file"
  done
  jq -Rsc 'split("\n") | map(select(length >= 8)) | unique' < "$MBOT_SCRATCH/secrets.txt" > "$MBOT_SCRATCH/secrets.json"
}
mbot_scrub() {
  jq --slurpfile secrets "$MBOT_SCRATCH/secrets.json" '
    def redact: reduce $secrets[0][] as $s (. ; split($s) | join("[REDACTED]"))
      | gsub("sk-[A-Za-z0-9_-]{12,}"; "[REDACTED]")
      | gsub("Bearer [A-Za-z0-9._~+/-]{8,}"; "Bearer [REDACTED]");
    walk(if type == "string" then redact elif type == "object" then with_entries(.key |= redact) else . end)'
}
mbot_render() {
  local request=$1 elapsed=$2 rc=$3 bot=$4 task=$5
  printf '%s' "$request" | jq -Rs . > "$MBOT_SCRATCH/request.json"
  if ! jq -es 'if all(.[]; type=="object" and (.type|type)=="string") then . else error("invalid event") end' "$MBOT_SCRATCH/raw.jsonl" > "$MBOT_SCRATCH/events.json" 2>/dev/null; then
    printf '[]\n' > "$MBOT_SCRATCH/events.json"
    mbot_violation .mbot/runs invalid_json_stream
  fi
  mbot_scrub < "$MBOT_SCRATCH/events.json" > "$MBOT_SCRATCH/clean-events.json"
  mbot_scrub < "$MBOT_SCRATCH/request.json" > "$MBOT_SCRATCH/clean-request.json"
  jq -s . "$MBOT_SCRATCH/violations.jsonl" | mbot_scrub > "$MBOT_SCRATCH/violations.json"
  : > "$MBOT_SCRATCH/remembers.txt"
  local file
  for file in "$MBOT_WS/inbox/"*.md; do
    awk -v run="run: $MBOT_RUN_ID;" 'index($0,run)' "$file" >> "$MBOT_SCRATCH/remembers.txt"
  done
  jq -Rs . < "$MBOT_SCRATCH/remembers.txt" | mbot_scrub > "$MBOT_SCRATCH/remembers.json"
  jq -Rs . < "$MBOT_SCRATCH/stderr" | mbot_scrub > "$MBOT_SCRATCH/diagnostics.json"
  jq -n --arg id "$MBOT_RUN_ID" --arg mode "${MBOT_MODE:-run}" --arg bot "$bot" --arg task "$task" --arg base "$MBOT_BASE" \
    --arg observed "$MBOT_OBSERVED_HEAD" --arg started "$MBOT_STARTED" --argjson elapsed "$elapsed" --argjson rc "$rc" \
    --slurpfile events "$MBOT_SCRATCH/clean-events.json" --slurpfile violations "$MBOT_SCRATCH/violations.json" \
    --slurpfile request "$MBOT_SCRATCH/clean-request.json" --slurpfile grants "$MBOT_SCRATCH/grants.json" '
      ($events[0] | map(select(type == "object" and .type == "final")) | last) as $f |
      ($events[0] | map(select(type == "object" and .type == "status" and .phase == "step_end") | .usage | select(type=="object"))) as $u |
      {run_id:$id, mode:$mode, bot:$bot, task:(if $task=="" then null else $task end), started_at:$started,
       elapsed_ms:$elapsed, dsh_exit_code:$rc, base_head:$base, observed_head:$observed,
       session_id:($f.sessionId // null), reason:($f.reason // null),
       success:($rc==0 and ($f.reason.kind? // "")=="completed" and ($events[0]|last|.type)=="final" and ($violations[0]|length)==0),
       summary:($request[0] | split("\n")[0] | .[0:72]), violations:$violations[0], grants:$grants[0],
       usage:{scope:"top-level", input_tokens:([$u[].inputTokens|numbers]|add // 0),
        output_tokens:([$u[].outputTokens|numbers]|add // 0), cache_read_tokens:([$u[].cacheReadTokens|numbers]|add // 0),
        cache_write_tokens:([$u[].cacheWriteTokens|numbers]|add // 0), total_tokens:([$u[].totalTokens|numbers]|add // 0)}}' > "$MBOT_SCRATCH/meta.json"
  jq -nr --arg id "$MBOT_RUN_ID" --arg bot "$bot" --slurpfile events "$MBOT_SCRATCH/clean-events.json" \
    --slurpfile request "$MBOT_SCRATCH/clean-request.json" --slurpfile remembers "$MBOT_SCRATCH/remembers.json" \
    --slurpfile diagnostics "$MBOT_SCRATCH/diagnostics.json" --slurpfile meta "$MBOT_SCRATCH/meta.json" '
      def block: tostring | "    " + gsub("\n"; "\n    ");
      "# " + $id + " (" + $bot + ")\n\n## Request\n\n" + ($request[0]|block),
      "\n## Tool calls\n",
      ($events[0][] | select(type=="object" and (.type=="tool_call" or .type=="tool_result")) |
        if .type=="tool_call" then "\n### " + ((.tool // "unknown")|tostring) + "\n\n" + (.input|tojson|block)
        else "\n" + ((.result // .error // "")|block) end),
      "\n## Final answer\n\n" + (($events[0]|map(select(type=="object" and .type=="final"))|last|.text // "(no final answer)")|block),
      "\n## Remember candidates\n\n" + ($remembers[0]|block),
      "\n## Outcome\n\n" + ($meta[0]|tojson|block),
      "\n## Diagnostics\n\n" + ($diagnostics[0]|block)' > "$MBOT_SCRATCH/transcript.md"
}
