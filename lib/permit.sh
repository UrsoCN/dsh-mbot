#!/usr/bin/env bash

mbot_turn_ledger() { mbot_path .mbot/runs/active-turn.json; }

# The legacy headless identity remains valid when there is no managed turn.
# New managed callers carry a permit and must never fall back after it expires.
mbot_check_permit() {
  local mutation=$1 file
  file=$(mbot_turn_ledger)
  if [[ -v MBOT_PERMIT_TOKEN ]]; then
    [[ -v MBOT_RUN_ID && -f $file && ! -L $file ]] || { mbot_error 'managed turn permit is no longer active'; return 1; }
    printf '%s\0%s' "$MBOT_RUN_ID" "$MBOT_PERMIT_TOKEN" | jq -Rse --argjson now "$(date +%s%3N)" --slurpfile permit "$file" '
      split("\u0000") as $identity | $permit[0] |
      (.schemaVersion==1 or .schemaVersion==2) and .phase=="active" and .expiresAt>$now and .runId==$identity[0] and .token==$identity[1]' >/dev/null \
      || { mbot_error 'managed turn permit is stale or invalid'; return 1; }
    MBOT_BOT=$(jq -er .role "$file")
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
