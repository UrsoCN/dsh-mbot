#!/usr/bin/env bash

mbot_push_prepare() {
  MBOT_PUSH_REMOTE=''; MBOT_PUSH_REF=''; MBOT_PUSH_URLS=''
  [[ $MBOT_MODE == dream && $MBOT_PUSH_AFTER_DREAM == 1 && -n $MBOT_BASE_REF ]] || return 0
  MBOT_PUSH_REMOTE=$(mbot_git for-each-ref --format='%(upstream:remotename)' "$MBOT_BASE_REF")
  MBOT_PUSH_REF=$(mbot_git for-each-ref --format='%(upstream:remoteref)' "$MBOT_BASE_REF")
  [[ -z $MBOT_PUSH_REMOTE || $MBOT_PUSH_REMOTE == . ]] || MBOT_PUSH_URLS=$(mbot_git remote get-url --push --all "$MBOT_PUSH_REMOTE" 2>/dev/null || true)
  return 0
}
mbot_push() {
  local rc=0 attempted=false current_remote current_ref current_urls='' log
  log=$MBOT_WS/.mbot/runs/$MBOT_RUN_ID.push.log
  current_remote=$(mbot_git for-each-ref --format='%(upstream:remotename)' "$MBOT_BASE_REF")
  current_ref=$(mbot_git for-each-ref --format='%(upstream:remoteref)' "$MBOT_BASE_REF")
  [[ -z $current_remote || $current_remote == . ]] || current_urls=$(mbot_git remote get-url --push --all "$current_remote" 2>/dev/null || true)
  if [[ -z $MBOT_PUSH_URLS || -z $MBOT_PUSH_REF || $current_remote != "$MBOT_PUSH_REMOTE" || $current_ref != "$MBOT_PUSH_REF" || $current_urls != "$MBOT_PUSH_URLS" ]]; then
    rc=128
    printf 'Push skipped: no prepared upstream or upstream changed.\n' > "$MBOT_SCRATCH/push.log"
  else
    attempted=true
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=Never timeout --kill-after=5s "$MBOT_PUSH_TIMEOUT" \
      git --git-dir="$MBOT_GIT_DIR" --work-tree="$MBOT_WS" -c core.hooksPath=/dev/null -c core.fsmonitor=false \
      push "$MBOT_PUSH_REMOTE" "$MBOT_BASE_REF:$MBOT_PUSH_REF" < /dev/null > "$MBOT_SCRATCH/push.log" 2>&1 || rc=$?
  fi
  jq -Rs . < "$MBOT_SCRATCH/push.log" | mbot_scrub | jq -r . > "$log"
  jq -n --arg run "$MBOT_RUN_ID" --arg remote "$MBOT_PUSH_REMOTE" --arg ref "$MBOT_PUSH_REF" --argjson rc "$rc" --argjson attempted "$attempted" \
    '{run_id:$run,remote:$remote,ref:$ref,attempted:$attempted,exit_code:$rc,success:($rc==0)}' | mbot_scrub > "$MBOT_WS/.mbot/runs/$MBOT_RUN_ID.push.json"
  if ((rc)); then printf 'Push failed/skipped (exit %s); local dream commit retained. Log: %s\n' "$rc" "$log" >&2; else printf 'Pushed successful dream to configured upstream.\n'; fi
}
