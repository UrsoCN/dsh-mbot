#!/usr/bin/env bash
# Only the owned summary request uses DeepSeek; native dialogue is deterministic.
set -Eeuo pipefail
set +x
umask 077
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ -z ${DEEPSEEK_API_KEY:-} && -f $repo/.env ]]; then source "$repo/.env"; fi
: "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY or use the repository .env}"
export DEEPSEEK_API_KEY MBOT_REAL_COMPACTION=1 MBOT_TIMEOUT=180
unset MBOT_RUN_ID MBOT_WS
cd "$repo"
node --test --test-name-pattern='real DeepSeek produces an attributed managed compaction' tests/runtime.test.js
