#!/usr/bin/env bash

# Native DSH shells carry per-execution DSH_* facts, never global Host env.
mbot_import_shell_permit() {
  [[ -v DSH_MBOT_RUN_ID || -v DSH_MBOT_PERMIT_TOKEN || -v DSH_MBOT_WS ]] || return 0
  [[ -v DSH_MBOT_RUN_ID && -v DSH_MBOT_PERMIT_TOKEN && -v DSH_MBOT_WS ]] || { mbot_error 'incomplete managed shell identity'; return 1; }
  local name source
  for name in MBOT_RUN_ID MBOT_PERMIT_TOKEN MBOT_WS; do
    source=DSH_$name
    [[ ! -v $name || ${!name} == "${!source}" ]] || { mbot_error 'conflicting managed shell identity'; return 1; }
    printf -v "$name" '%s' "${!source}"
    export "$name"
  done
}
