#!/usr/bin/env bash

mbot_rows() {
  awk -F '|' 'function trim(s){gsub(/^[ \t]+|[ \t]+$/, "", s); return s}
    NF == 7 && trim($2) ~ /^[0-9][0-9][0-9][0-9]*$/ {
      for(i=2;i<=6;i++) printf "%s%s", trim($i), (i==6 ? "\n" : "|")
    }' "$MBOT_WS/BOARD.md"
}

mbot_board_check() {
  awk -F '|' -v file=BOARD.md '
    function trim(s){gsub(/^[ \t]+|[ \t]+$/, "", s); return s}
    function fail(s){printf "%s:%d: %s\n",file,FNR,s > "/dev/stderr"; bad=1}
    /^[ \t]*$/ {next}
    /^# 看板$/ && !stage {next}
    !stage {if($0!="| id | 状态 | owner | 摘要 | 更新 |") fail("invalid board header"); stage=1; next}
    stage==1 {if($0!="|---|---|---|---|---|") fail("invalid board separator"); stage=2; next}
    {
      if(NF!=7 || trim($1)!="" || trim($7)!="") {fail("expected five table columns"); next}
      id=trim($2); state=trim($3); owner=trim($4); title=trim($5); date=trim($6)
      if(id!~/^[0-9][0-9][0-9][0-9]*$/ || length(id)>9 || id+0==0) fail("invalid task id")
      if(seen[id]++) fail("duplicate task id " id)
      if(state!~/^(todo|doing|blocked|done)$/) fail("invalid state " state)
      if(owner!~/^[a-z][a-z0-9_-]*$/ || title=="") fail("invalid owner or empty summary")
      if(date!~/^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) fail("invalid update date")
    }
    END {if(stage!=2) fail("missing board table"); exit bad}' "$MBOT_WS/BOARD.md" || return 1
  local id state owner title updated file actual
  while IFS='|' read -r id state owner title updated; do
    file=$(mbot_task_path "$id") || return 1
    mbot_role "$owner" || return 1
    actual=$(awk '/^- owner: / {print substr($0,10)}' "$file")
    [[ $actual == "$owner" ]] || { mbot_error "tasks/$id.md: owner disagrees with BOARD.md"; return 1; }
    actual=$(sed -n 's/^- 状态: //p' "$file")
    [[ $actual == "$state" ]] || { mbot_error "tasks/$id.md: state disagrees with BOARD.md"; return 1; }
  done < <(mbot_rows)
}

mbot_budget() {
  local file=$1 limit=$2 unit=$3 count
  if [[ $unit == lines ]]; then count=$(awk 'END{print NR+0}' "$file"); else count=$(LC_ALL=C.UTF-8 wc -m < "$file"); fi
  if ((count > limit)); then
    printf '%s: %s %s > %s (exceeds by %s)\n' "${file#"$MBOT_WS/"}" "$count" "$unit" "$limit" "$((count-limit))" >&2
    return 1
  fi
}

mbot_lint() {
  local file rel rest target match failures=0
  local link_re='\[\[([^]]+)\]\]'
  mbot_board_check || failures=$((failures+1))
  mbot_budget "$MBOT_WS/BOARD.md" "$MBOT_BOARD_MAX_LINES" lines || failures=$((failures+1))
  for file in "$MBOT_WS/MEMORY.md" "$MBOT_WS/bots/"*/MEMORY.md; do
    rel=${file#"$MBOT_WS/"}
    if ! mbot_path "$rel" >/dev/null; then failures=$((failures+1)); continue; fi
    mbot_budget "$file" "$MBOT_MEMORY_MAX_LINES" lines || failures=$((failures+1))
    mbot_budget "$file" "$MBOT_MEMORY_MAX_CHARS" characters || failures=$((failures+1))
  done
  for file in "$MBOT_WS/bots/"*/SOUL.md; do
    rel=${file#"$MBOT_WS/"}
    if ! mbot_path "$rel" >/dev/null; then failures=$((failures+1)); continue; fi
    mbot_budget "$file" "$MBOT_SOUL_MAX_CHARS" characters || failures=$((failures+1))
  done
  for file in "$MBOT_WS/wiki/"**/*.md; do
    rel=${file#"$MBOT_WS/"}
    if ! mbot_path "$rel" >/dev/null; then failures=$((failures+1)); continue; fi
    mbot_budget "$file" "$MBOT_WIKI_MAX_LINES" lines || failures=$((failures+1))
  done
  for file in "$MBOT_WS/"**/*.md; do
    rel=${file#"$MBOT_WS/"}
    [[ $rel != transcripts/* && $rel != dream-reports/* && $rel != tasks/archive/* && $rel != .git/* && $rel != .mbot/* ]] || continue
    if ! mbot_path "$rel" >/dev/null; then failures=$((failures+1)); continue; fi
    rest=$(cat -- "$file")
    while [[ $rest =~ $link_re ]]; do
      match=${BASH_REMATCH[0]} target=${BASH_REMATCH[1]}
      rest=${rest#*"$match"}
      target=${target%%|*}; target=${target%%#*}
      if ! target=$(mbot_path "$target") || [[ ! -f $target ]]; then
        printf '%s: missing or unsafe link %s\n' "$rel" "$match" >&2
        failures=$((failures+1))
      fi
    done
  done
  if ((failures)); then printf 'lint: %s violation(s)\n' "$failures" >&2; return 1; fi
  printf 'lint: OK\n'
}
