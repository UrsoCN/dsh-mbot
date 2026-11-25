#!/usr/bin/env bash

mbot_git() { git --git-dir="${MBOT_GIT_DIR:-$MBOT_WS/.git}" --work-tree="$MBOT_WS" -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
mbot_mark_paused() {
  mbot_guard_parent .mbot/PAUSED
  [[ ! -L $MBOT_WS/.mbot/PAUSED && ! -d $MBOT_WS/.mbot/PAUSED ]] || rm -rf -- "$MBOT_WS/.mbot/PAUSED"
  printf '%s\n' "$1" > "$MBOT_WS/.mbot/PAUSED"
}
mbot_violation() {
  printf '%s\0%s' "$1" "$2" | jq -Rsc 'split("\u0000") | {path: .[0], reason: .[1]}' >> "$MBOT_SCRATCH/violations.jsonl"
}

# Replace unsafe ancestor nodes without following an Agent-created symlink.
mbot_guard_parent() {
  local rel=$1 part current=$MBOT_WS
  local -a parts
  IFS=/ read -r -a parts <<< "$rel"
  for part in "${parts[@]:0:${#parts[@]}-1}"; do
    current+=/$part
    if [[ -L $current || ( -e $current && ! -d $current ) ]]; then rm -f -- "$current"; fi
    mkdir -p -- "$current"
  done
}
mbot_restore() {
  local rel=$1
  mbot_guard_parent "$rel"
  if [[ -L $MBOT_WS/$rel || -d $MBOT_WS/$rel ]]; then rm -rf -- "$MBOT_WS/$rel"; fi
  if mbot_git cat-file -e "$MBOT_BASE:$rel" 2>/dev/null; then
    mbot_git restore --source="$MBOT_BASE" --worktree -- "$rel"
  elif [[ -e $MBOT_SCRATCH/ignored/$rel || -L $MBOT_SCRATCH/ignored/$rel ]]; then
    rm -f -- "$MBOT_WS/$rel"
    cp -a -- "$MBOT_SCRATCH/ignored/$rel" "$MBOT_WS/$rel"
  else
    rm -f -- "$MBOT_WS/$rel"
  fi
}
mbot_guard_snapshot() {
  local rel
  mkdir -p "$MBOT_SCRATCH/ignored"
  mbot_git ls-files --others --ignored --exclude-standard -z > "$MBOT_SCRATCH/ignored.list"
  while IFS= read -r -d '' rel; do
    case $rel in .mbot/lock|.mbot/botctl.lock|.mbot/PAUSED) continue ;; esac
    mkdir -p -- "$MBOT_SCRATCH/ignored/$(dirname -- "$rel")"
    cp -a -- "$MBOT_WS/$rel" "$MBOT_SCRATCH/ignored/$rel"
  done < "$MBOT_SCRATCH/ignored.list"
  MBOT_LOCK_INODE=$(stat -c '%d:%i' "$MBOT_WS/.mbot/lock" "$MBOT_WS/.mbot/botctl.lock")
}
mbot_guard_allowed() {
  local rel=$1
  case $rel in
    tasks/_template.md) return 1 ;;
    BOARD.md|tasks/*|inbox/*) ;;
    *) return 1 ;;
  esac
  mbot_path "$rel" >/dev/null 2>&1 && [[ -f $MBOT_WS/$rel ]] || return 1
  if [[ $rel == inbox/* ]] && mbot_git cat-file -e "$MBOT_BASE:$rel" 2>/dev/null; then
    mbot_git show "$MBOT_BASE:$rel" > "$MBOT_SCRATCH/prefix"
    head -c "$(wc -c < "$MBOT_SCRATCH/prefix")" "$MBOT_WS/$rel" | cmp -s - "$MBOT_SCRATCH/prefix" || return 1
  fi
}
mbot_guard_run() {
  local rel observed_ref
  MBOT_OBSERVED_HEAD=$(mbot_git rev-parse HEAD)
  observed_ref=$(mbot_git symbolic-ref -q HEAD || true)
  if [[ $MBOT_OBSERVED_HEAD != "$MBOT_BASE" || $observed_ref != "$MBOT_BASE_REF" ]]; then
    mbot_violation .git/HEAD head_moved
    mbot_mark_paused 'HEAD moved during run; review transcript before resuming.'
    [[ -z $MBOT_BASE_REF ]] || mbot_git symbolic-ref HEAD "$MBOT_BASE_REF"
    mbot_git reset --soft "$MBOT_BASE"
  fi
  mbot_git reset -q "$MBOT_BASE"
  while IFS= read -r -d '' rel; do
    if ! mbot_guard_allowed "$rel"; then
      mbot_violation "$rel" forbidden_change_or_nonappend
      mbot_restore "$rel"
    fi
  done < <(mbot_git diff --no-ext-diff --name-only -z "$MBOT_BASE")
  # Enumerate again after tracked restoration: parent symlinks may have vanished.
  while IFS= read -r -d '' rel; do
    if ! mbot_guard_allowed "$rel"; then
      mbot_violation "$rel" forbidden_new_file
      mbot_restore "$rel"
    fi
  done < <(mbot_git ls-files --others --exclude-standard -z)
  while IFS= read -r -d '' rel; do
    case $rel in .mbot/lock|.mbot/botctl.lock|.mbot/PAUSED) continue ;; esac
    if [[ -e $MBOT_SCRATCH/ignored/$rel || -L $MBOT_SCRATCH/ignored/$rel ]]; then
      if [[ -L $MBOT_SCRATCH/ignored/$rel && -L $MBOT_WS/$rel && $(readlink -- "$MBOT_SCRATCH/ignored/$rel") == "$(readlink -- "$MBOT_WS/$rel")" ]]; then continue; fi
      if [[ -L $MBOT_WS/$rel || ! -f $MBOT_WS/$rel ]] || ! cmp -s "$MBOT_WS/$rel" "$MBOT_SCRATCH/ignored/$rel"; then
        mbot_violation "$rel" ignored_file_changed; mbot_restore "$rel"
      fi
    else
      mbot_violation "$rel" forbidden_ignored_file; mbot_restore "$rel"
    fi
  done < <(mbot_git ls-files --others --ignored --exclude-standard -z)
  while IFS= read -r -d '' rel; do
    case $rel in .mbot/lock|.mbot/botctl.lock|.mbot/PAUSED) continue ;; esac
    if [[ ! -e $MBOT_WS/$rel && ! -L $MBOT_WS/$rel ]]; then mbot_violation "$rel" ignored_file_deleted; mbot_restore "$rel"; fi
  done < "$MBOT_SCRATCH/ignored.list"
  if [[ $(stat -c '%d:%i' "$MBOT_WS/.mbot/lock" "$MBOT_WS/.mbot/botctl.lock" 2>/dev/null || true) != "$MBOT_LOCK_INODE" || -L $MBOT_WS/.mbot/PAUSED || -d $MBOT_WS/.mbot/PAUSED ]]; then
    mbot_violation .mbot runtime_control_path_replaced
    mbot_mark_paused 'Runtime control path replaced; review before resuming.'
  fi
  if ! { mbot_board_check && mbot_budget "$MBOT_WS/BOARD.md" "$MBOT_BOARD_MAX_LINES" lines; } > "$MBOT_SCRATCH/board.stderr" 2>&1; then
    mbot_violation BOARD.md board_lint_failed
    while IFS= read -r -d '' rel; do mbot_restore "$rel"; done < <(
      mbot_git diff --no-ext-diff --name-only -z "$MBOT_BASE" -- BOARD.md tasks
      mbot_git ls-files --others --exclude-standard -z -- tasks
    )
  fi
  mbot_board_check
}
