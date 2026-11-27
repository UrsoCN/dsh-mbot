#!/usr/bin/env bash

mbot_add_files() {
  local id=$1 title=$2 owner=$3 today=$4 table_title
  table_title=${title//|/'&#124;'}
  printf '# %s %s\n\n- owner: %s\n- 状态: todo\n- 创建: %s\n- 更新: %s\n\n' "$id" "$title" "$owner" "$today" "$today" > "$MBOT_WS/tasks/$id.md"
  cat -- "$MBOT_WS/tasks/_template.md" >> "$MBOT_WS/tasks/$id.md"
  [[ -z $(tail -c 1 -- "$MBOT_WS/BOARD.md") ]] || printf '\n' >> "$MBOT_WS/BOARD.md"
  printf '| %s | todo | %s | %s | %s |\n' "$id" "$owner" "$table_title" "$today" >> "$MBOT_WS/BOARD.md"
  mbot_board_check
  mbot_budget "$MBOT_WS/BOARD.md" "$MBOT_BOARD_MAX_LINES" lines
}

mbot_append_result() {
  local file=$1 actor=$2 body=$3
  printf '\n### %s [by: %s; run: %s]\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$actor" "${MBOT_RUN_ID:-human}" >> "$file"
  printf '%s\n' "$body" | sed 's/^/> /' >> "$file"
}

mbot_set_files() {
  local id=$1 state=$2 owner=$3 reason=$4 today=$5 tmp file
  tmp=$(mktemp "$MBOT_WS/.mbot/board.XXXXXX")
  awk -F '|' -v OFS='|' -v id="$id" -v state="$state" -v owner="$owner" -v date="$today" '
    function trim(s){gsub(/^[ \t]+|[ \t]+$/, "", s); return s}
    NF==7 && trim($2)==id {$3=" "state" "; $4=" "owner" "; $6=" "date" "} {print}' "$MBOT_WS/BOARD.md" > "$tmp"
  mv -- "$tmp" "$MBOT_WS/BOARD.md"
  file=$MBOT_WS/tasks/$id.md
  tmp=$(mktemp "$MBOT_WS/.mbot/task.XXXXXX")
  awk -v owner="$owner" -v state="$state" -v date="$today" '
    /^- owner: / {print "- owner: "owner; next}
    /^- 状态: / {print "- 状态: "state; next}
    /^- 更新: / {print "- 更新: "date; next} {print}' "$file" > "$tmp"
  mv -- "$tmp" "$file"
  [[ -z $reason ]] || mbot_append_result "$file" "${MBOT_BOT:-human}" "[$state] $reason"
  mbot_board_check
}

mbot_board() {
  local op=${1:-} id title owner=chief reason='' state today file stem max=0 row old_state old_owner
  [[ $# -gt 0 ]] && shift
  case $op in
    show)
      [[ $# == 0 || ( $# == 2 && $1 == --status ) ]] || { mbot_error 'usage: botctl board show [--status state]'; return 1; }
      mbot_board_check
      if [[ $# == 0 ]]; then cat -- "$MBOT_WS/BOARD.md"; return; fi
      [[ $2 =~ ^(todo|doing|blocked|done)$ ]] || { mbot_error "invalid state: $2"; return 1; }
      printf '# 看板\n\n| id | 状态 | owner | 摘要 | 更新 |\n|---|---|---|---|---|\n'
      while IFS='|' read -r id state owner title today; do
        [[ $state != "$2" ]] || printf '| %s | %s | %s | %s | %s |\n' "$id" "$state" "$owner" "$title" "$today"
      done < <(mbot_rows)
      ;;
    add)
      [[ $# == 1 || ( $# == 3 && $2 == --owner ) ]] || { mbot_error 'usage: botctl board add "summary" [--owner bot]'; return 1; }
      title=$1 owner=${3:-chief}
      mbot_line "$title" && [[ -n ${title//[[:space:]]/} ]] || { mbot_error 'summary must be a nonempty single line'; return 1; }
      mbot_role "$owner"
      mbot_board_check
      mbot_result_section "$MBOT_WS/tasks/_template.md"
      for file in "$MBOT_WS/tasks/"**/*.md; do
        stem=${file##*/}; stem=${stem%.md}
        [[ $stem =~ ^[0-9]{3,9}$ ]] || continue
        ((10#$stem <= max)) || max=$((10#$stem))
      done
      ((max < 999999999)) || { mbot_error 'task id space exhausted'; return 1; }
      printf -v id '%03d' "$((max+1))"
      MBOT_CHANGED=(BOARD.md "tasks/$id.md")
      mbot_transaction "board add $id $title" mbot_add_files "$id" "$title" "$owner" "$(date +%F)"
      printf '%s\n' "$id"
      ;;
    set)
      [[ $# -ge 2 ]] || { mbot_error 'usage: botctl board set <id> <state> [--owner bot] [--reason text]'; return 1; }
      id=$1 state=$2 owner=''; shift 2
      [[ $state =~ ^(todo|doing|blocked|done)$ ]] || { mbot_error "invalid state: $state"; return 1; }
      while (($#)); do
        [[ $# -ge 2 ]] || { mbot_error 'option requires a value'; return 1; }
        case $1 in --owner) owner=$2 ;; --reason) reason=$2 ;; *) mbot_error "unknown option: $1"; return 1 ;; esac
        shift 2
      done
      [[ $state != blocked || -n ${reason//[[:space:]]/} ]] || { mbot_error 'blocked requires --reason "explanation"'; return 1; }
      [[ -z $reason ]] || mbot_line "$reason" || { mbot_error 'reason must be a single line'; return 1; }
      file=$(mbot_task_path "$id")
      mbot_result_section "$file"
      mbot_board_check
      row=$(mbot_rows | awk -F '|' -v id="$id" '$1==id')
      [[ -n $row ]] || { mbot_error "task is not on BOARD.md: $id"; return 1; }
      IFS='|' read -r id old_state old_owner title today <<< "$row"
      owner=${owner:-$old_owner}
      mbot_role "$owner"
      if [[ $old_state == "$state" && $old_owner == "$owner" && -z $reason ]]; then printf '%s unchanged\n' "$id"; return; fi
      MBOT_CHANGED=(BOARD.md "tasks/$id.md")
      mbot_transaction "board set $id $state" mbot_set_files "$id" "$state" "$owner" "$reason" "$(date +%F)"
      printf '%s %s\n' "$id" "$state"
      ;;
    *) mbot_error 'usage: botctl board show|add|set ...'; return 1 ;;
  esac
}

mbot_task() {
  local op=${1:-} id=${2:-} actor=${MBOT_BOT:-human} file body
  [[ $# -ge 2 ]] || { mbot_error 'usage: botctl task show|result <id> [--as bot]'; return 1; }
  shift 2
  file=$(mbot_task_path "$id")
  case $op in
    show) [[ $# == 0 ]] || { mbot_error 'usage: botctl task show <id>'; return 1; }; cat -- "$file" ;;
    result)
      [[ $# == 0 || ( $# == 2 && $1 == --as ) ]] || { mbot_error 'usage: botctl task result <id> [--as bot] < text'; return 1; }
      actor=${2:-$actor}; mbot_role "$actor"
      mbot_check_actor "$actor"
      mbot_result_section "$file"
      [[ ! -t 0 ]] || { mbot_error 'task result requires text on stdin'; return 1; }
      body=$(cat)
      [[ -n ${body//[[:space:]]/} ]] || { mbot_error 'result must not be empty'; return 1; }
      mbot_line "${MBOT_RUN_ID:-human}" || { mbot_error 'invalid run id'; return 1; }
      MBOT_CHANGED=("tasks/$id.md")
      mbot_transaction "task result $id ($actor)" mbot_append_result "$file" "$actor" "$body"
      printf 'Recorded result for %s\n' "$id"
      ;;
    *) mbot_error 'usage: botctl task show|result <id>'; return 1 ;;
  esac
}

mbot_remember_file() {
  mkdir -p -- "$MBOT_WS/inbox"
  printf -- '- %s [by: %s; run: %s; task: %s; at: %s]\n' "$1" "$2" "${MBOT_RUN_ID:-human}" "${3:--}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MBOT_WS/$4"
}
mbot_remember() {
  [[ $# -ge 1 ]] || { mbot_error 'usage: botctl remember "fact" [--as bot] [--task id]'; return 1; }
  local fact=$1 actor=${MBOT_BOT:-human} task='' rel
  shift
  while (($#)); do
    [[ $# -ge 2 ]] || { mbot_error 'option requires a value'; return 1; }
    case $1 in --as) actor=$2 ;; --task) task=$2 ;; *) mbot_error "unknown option: $1"; return 1 ;; esac
    shift 2
  done
  mbot_line "$fact" && [[ -n ${fact//[[:space:]]/} ]] || { mbot_error 'fact must be a nonempty single line'; return 1; }
  mbot_line "${MBOT_RUN_ID:-human}" || { mbot_error 'invalid run id'; return 1; }
  mbot_role "$actor"
  mbot_check_actor "$actor"
  if [[ -v MBOT_ACTOR_ID ]]; then
    [[ -z $task || $task == "$MBOT_ACTOR_TASK" ]] || { mbot_error 'candidate task must match the delegated task'; return 1; }
    task=$MBOT_ACTOR_TASK
  fi
  [[ -z $task ]] || mbot_task_path "$task" >/dev/null
  mbot_path inbox >/dev/null
  rel=inbox/$(date +%F).md
  MBOT_CHANGED=("$rel")
  mbot_transaction "remember ($actor)" mbot_remember_file "$fact" "$actor" "$task" "$rel"
  printf 'Remembered in %s\n' "$rel"
}
