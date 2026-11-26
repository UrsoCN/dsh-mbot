#!/usr/bin/env bash

mbot_grants() {
  local path physical protected previous
  local -a roots
  MBOT_GRANTED=()
  [[ -n $MBOT_GRANTS ]] || return 0
  mbot_line "$MBOT_GRANTS" || { mbot_error 'MBOT_GRANTS must be a single line'; return 1; }
  [[ $MBOT_GRANTS != :* && $MBOT_GRANTS != *: && $MBOT_GRANTS != *::* ]] || { mbot_error 'MBOT_GRANTS contains an empty path'; return 1; }
  IFS=: read -r -a roots <<< "$MBOT_GRANTS"
  for path in "${roots[@]}"; do
    mbot_line "$path" && [[ $path == /* && -d $path ]] || { mbot_error "grant must be an existing absolute directory: $path"; return 1; }
    physical=$(realpath -e -- "$path")
    [[ $path == "$physical" ]] || { mbot_error "grant must use its physical path: $path"; return 1; }
    [[ $physical != / ]] || { mbot_error 'cannot grant filesystem root'; return 1; }
    for protected in "$MBOT_ROOT" "$MBOT_WS" "$(realpath -m -- "${DSH_HOME:-$HOME/.dsh}")" "$(realpath -m -- "$HOME/.dsh")"; do
      if [[ $physical == "$protected" || $physical == "$protected/"* || $protected == "$physical/"* ]]; then
        mbot_error "grant overlaps a protected directory: $path"; return 1
      fi
    done
    for previous in "${MBOT_GRANTED[@]}"; do
      [[ $previous != "$physical" ]] || { mbot_error "duplicate grant: $path"; return 1; }
    done
    MBOT_GRANTED+=("$physical")
  done
}
mbot_tick() {
  [[ $# == 0 ]] || { mbot_error 'usage: mbot tick'; return 1; }
  mbot_execute run chief "$(cat "$MBOT_ROOT/prompts/tick.md")" '' tick
}
mbot_archive_files() {
  local month=$1 id temp
  shift
  mkdir -p -- "$MBOT_WS/tasks/archive/$month"
  for id in "$@"; do mv -- "$MBOT_WS/tasks/$id.md" "$MBOT_WS/tasks/archive/$month/$id.md"; done
  temp=$(mktemp "$MBOT_WS/.mbot/board.XXXXXX")
  awk -F '|' 'function trim(s){gsub(/^[ \t]+|[ \t]+$/, "", s);return s} NF==7 && trim($3)=="done" {next} {print}' "$MBOT_WS/BOARD.md" > "$temp"
  mv -- "$temp" "$MBOT_WS/BOARD.md"
  mbot_board_check
}
mbot_archive() {
  [[ ! -v MBOT_RUN_ID ]] || { mbot_error 'nested mbot archive is forbidden'; return 1; }
  [[ $# == 0 ]] || { mbot_error 'usage: mbot archive'; return 1; }
  if [[ -f $(mbot_path .mbot/PAUSED) ]]; then printf 'Skipped: workspace is PAUSED.\n'; return 0; fi
  exec 8> "$(mbot_path .mbot/lock)"
  if ! flock -n 8; then printf 'Skipped: another run is active.\n'; return 0; fi
  exec 9> "$(mbot_path .mbot/botctl.lock)"
  flock 9
  MBOT_GIT_DIR=$(realpath -e -- "$(git -C "$MBOT_WS" rev-parse --absolute-git-dir)")
  [[ -z $(mbot_git status --porcelain) ]] || { mbot_error 'workspace must be clean before archive'; return 1; }
  mbot_board_check
  local month=$(date +%Y-%m) id dest
  local -a ids
  mapfile -t ids < <(mbot_rows | awk -F '|' '$2=="done" {print $1}')
  if ((${#ids[@]}==0)); then printf 'Skipped: no done tasks to archive.\n'; return 0; fi
  MBOT_CHANGED=(BOARD.md)
  for id in "${ids[@]}"; do
    dest=$(mbot_path "tasks/archive/$month/$id.md")
    [[ ! -e $dest ]] || { mbot_error "archive destination exists: $dest"; return 1; }
    MBOT_CHANGED+=("tasks/$id.md" "tasks/archive/$month/$id.md")
  done
  mkdir -p -- "$MBOT_WS/tasks/archive/$month"
  mbot_transaction_as 'chore(archive)' "archive ${#ids[@]} done tasks" mbot_archive_files "$month" "${ids[@]}"
  printf 'Archived %s task(s) into tasks/archive/%s\n' "${#ids[@]}" "$month"
}
