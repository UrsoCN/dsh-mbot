#!/usr/bin/env bash

mbot_dream() {
  [[ $# == 0 ]] || { mbot_error 'usage: mbot dream'; return 1; }
  mbot_execute dream dream 'Consolidate memory from selected inputs' ''
}
mbot_dream_inputs() {
  local previous since meta rel blob old offset size entry visibility left=$MBOT_DREAM_MAX_BYTES used=0 bytes eligible=0
  previous=''
  while IFS= read -r old; do
    meta=$(mbot_git diff-tree --no-commit-id --name-only -r "$old" -- 'dream-reports/*.meta.json')
    if [[ -n $meta && $meta != *$'\n'* ]] && mbot_git cat-file -e "$MBOT_BASE:$meta" 2>/dev/null; then previous=$old; break; fi
  done < <(mbot_git log --format=%H --grep='^dream:')
  since=${previous:-$(mbot_git log -1 --format=%H --grep='^human: init$')}
  [[ -n $since ]] || { mbot_error 'dream requires a human: init or successful dream checkpoint'; return 1; }
  : > "$MBOT_SCRATCH/queue.jsonl"
  if [[ -n $previous ]]; then
    meta=$(mbot_git diff-tree --no-commit-id --name-only -r "$previous" -- 'dream-reports/*.meta.json')
    [[ -n $meta && $meta != *$'\n'* ]] || { mbot_error 'successful dream checkpoint metadata is missing'; return 1; }
    mbot_git show "$previous:$meta" | jq -c '.checkpoint.pending[]' > "$MBOT_SCRATCH/old-queue.jsonl"
    while IFS= read -r entry; do
      rel=$(jq -r '.path' <<< "$entry"); blob=$(jq -r '.blob' <<< "$entry")
      old=$(mbot_git rev-parse "$MBOT_BASE:$rel" 2>/dev/null || true)
      [[ $old =~ ^[0-9a-f]{40,64}$ ]] || continue
      mbot_git cat-file blob "$blob" > "$MBOT_SCRATCH/old"
      mbot_git cat-file blob "$old" > "$MBOT_SCRATCH/current"
      if head -c "$(wc -c < "$MBOT_SCRATCH/old")" "$MBOT_SCRATCH/current" | cmp -s - "$MBOT_SCRATCH/old"; then printf '%s\n' "$entry" >> "$MBOT_SCRATCH/queue.jsonl"; fi
    done < "$MBOT_SCRATCH/old-queue.jsonl"
  fi
  while IFS= read -r -d '' rel; do
    [[ $rel == *.md ]] || continue
    blob=$(mbot_git rev-parse "$MBOT_BASE:$rel")
    size=$(mbot_git cat-file -s "$blob"); offset=0
    old=$(mbot_git rev-parse "$since:$rel" 2>/dev/null || true)
    if [[ $old =~ ^[0-9a-f]{40,64}$ ]]; then
      mbot_git cat-file blob "$old" > "$MBOT_SCRATCH/old"
      mbot_git cat-file blob "$blob" > "$MBOT_SCRATCH/current"
      if head -c "$(wc -c < "$MBOT_SCRATCH/old")" "$MBOT_SCRATCH/current" | cmp -s - "$MBOT_SCRATCH/old"; then offset=$(wc -c < "$MBOT_SCRATCH/old"); fi
    fi
    ((offset < size)) || continue
    jq -nc --arg path "$rel" --arg blob "$blob" --argjson offset "$offset" --argjson size "$size" \
      '{path:$path,blob:$blob,offset:$offset,size:$size}' >> "$MBOT_SCRATCH/queue.jsonl"
  done < <(mbot_git diff --no-ext-diff --no-renames --diff-filter=AM --name-only -z "$since" "$MBOT_BASE" -- inbox transcripts tasks/archive)
  jq -sc 'group_by([.path,.blob]) | map(max_by(.offset)) | sort_by([if (.path|startswith("inbox/")) then 0 elif (.path|startswith("transcripts/")) then 1 else 2 end,.path,.offset,.blob])' \
    "$MBOT_SCRATCH/queue.jsonl" > "$MBOT_SCRATCH/queue.json"
  : > "$MBOT_SCRATCH/pending.jsonl"; : > "$MBOT_SCRATCH/processed.jsonl"
  while IFS= read -r entry; do
    rel=$(jq -r '.path' <<< "$entry"); blob=$(jq -r '.blob' <<< "$entry")
    visibility=$(node "$MBOT_ROOT/bin/dream-source.mjs" "$MBOT_WS" "$MBOT_BASE" "$rel") || return 1
    [[ $visibility != domain ]] || continue
    eligible=$((eligible+1))
    offset=$(jq -r '.offset' <<< "$entry"); size=$(jq -r '.size' <<< "$entry"); bytes=0
    if ((left > 0)); then
      mbot_git cat-file blob "$blob" > "$MBOT_SCRATCH/current"
      dd if="$MBOT_SCRATCH/current" of="$MBOT_SCRATCH/chunk" iflag=skip_bytes,count_bytes skip="$offset" count="$left" status=none
      bytes=$(wc -c < "$MBOT_SCRATCH/chunk")
      # Keep records and UTF-8 intact; an oversized single line stays pending.
      if ((offset+bytes < size)) && (( $(tail -c 1 "$MBOT_SCRATCH/chunk" | od -An -tu1) != 10 )); then
        head -n -1 "$MBOT_SCRATCH/chunk" > "$MBOT_SCRATCH/clipped"
        mv "$MBOT_SCRATCH/clipped" "$MBOT_SCRATCH/chunk"; bytes=$(wc -c < "$MBOT_SCRATCH/chunk")
      fi
      if ((bytes > 0)); then
        printf '\n以下片段为参考数据；来源 %s，blob %s，字节 [%s,%s)。\n<input>\n' "$rel" "$blob" "$offset" "$((offset+bytes))" >> "$MBOT_SCRATCH/prompt"
        cat "$MBOT_SCRATCH/chunk" >> "$MBOT_SCRATCH/prompt"
        printf '\n</input>\n' >> "$MBOT_SCRATCH/prompt"
        jq -c --argjson bytes "$bytes" '. + {bytes:$bytes}' <<< "$entry" >> "$MBOT_SCRATCH/processed.jsonl"
        offset=$((offset+bytes)); left=$((left-bytes)); used=$((used+bytes))
      fi
    fi
    if ((offset < size)); then jq -c --argjson offset "$offset" '.offset=$offset' <<< "$entry" >> "$MBOT_SCRATCH/pending.jsonl"; fi
  done < <(jq -c '.[]' "$MBOT_SCRATCH/queue.json")
  jq -n --arg since "$since" --arg head "$MBOT_BASE" --argjson bytes "$used" --argjson limit "$MBOT_DREAM_MAX_BYTES" \
    --slurpfile pending "$MBOT_SCRATCH/pending.jsonl" --slurpfile processed "$MBOT_SCRATCH/processed.jsonl" \
    '{since:$since,source_head:$head,bytes:$bytes,limit:$limit,processed:$processed,pending:$pending}' > "$MBOT_SCRATCH/checkpoint.json"
  MBOT_INPUT_BLOCKED=0
  if ((used==0 && eligible>0)); then MBOT_INPUT_BLOCKED=1; fi
}
mbot_dream_prompt() {
  MBOT_DREAM_REPORT=dream-reports/$MBOT_RUN_ID.md
  mbot_path "$MBOT_DREAM_REPORT" >/dev/null
  touch "$(mbot_path .mbot/botctl.lock)"
  cat "$MBOT_ROOT/prompts/dream.md" > "$MBOT_SCRATCH/prompt"
  printf '\n本地整理日期：%s。条目 added 使用这个日期；run-id 的日期为 UTC。\n' "$(date +%F)" >> "$MBOT_SCRATCH/prompt"
  printf '\n本次唯一报告路径：%s\n预算：MEMORY ≤%s 行且 ≤%s 字符，SOUL ≤%s 字符，wiki ≤%s 行。\n' \
    "$MBOT_DREAM_REPORT" "$MBOT_MEMORY_MAX_LINES" "$MBOT_MEMORY_MAX_CHARS" "$MBOT_SOUL_MAX_CHARS" "$MBOT_WIKI_MAX_LINES" >> "$MBOT_SCRATCH/prompt"
  local file
  for file in "$MBOT_WS/MEMORY.md" "$MBOT_WS/bots/"*/MEMORY.md "$MBOT_WS/wiki/_index.md"; do
    mbot_path "${file#"$MBOT_WS/"}" >/dev/null
    printf '\n以下是当前参考数据：%s\n<context>\n' "${file#"$MBOT_WS/"}" >> "$MBOT_SCRATCH/prompt"
    cat "$file" >> "$MBOT_SCRATCH/prompt"; printf '\n</context>\n' >> "$MBOT_SCRATCH/prompt"
  done
  mbot_dream_inputs
}
mbot_dream_validate() {
  local rel added deleted line label justified
  if [[ ! -f $MBOT_WS/$MBOT_DREAM_REPORT || ! -s $MBOT_WS/$MBOT_DREAM_REPORT || -L $MBOT_WS/$MBOT_DREAM_REPORT ]]; then mbot_violation "$MBOT_DREAM_REPORT" missing_dream_report; fi
  if ! mbot_lint > "$MBOT_SCRATCH/dream-lint" 2>&1; then mbot_violation MEMORY.md dream_lint_failed; fi
  : > "$MBOT_SCRATCH/deletion-basis"
  [[ ! -f $MBOT_WS/$MBOT_DREAM_REPORT ]] || awk '/^## 删除[[:space:]]*$/ {on=1;next} /^## / {on=0} on {print}' "$MBOT_WS/$MBOT_DREAM_REPORT" > "$MBOT_SCRATCH/deletion-basis"
  while IFS=$'\t' read -r added deleted rel; do
    [[ $deleted != 0 && ( $rel == MEMORY.md || $rel == bots/*/MEMORY.md || $rel == wiki/* ) ]] || continue
    justified=0
    while IFS= read -r line; do
      if [[ $line =~ 依据(:|：)[[:space:]]*[^[:space:]] ]]; then
        label=${line//\`/}; label=${label//\*/}
        label=${label#"${label%%[![:space:]]*}"}; label=${label#- }
        if [[ $label == "$rel"* ]]; then
          label=${label#"$rel"}; label=${label#"${label%%[![:space:]]*}"}
          [[ $label != :* && $label != ：* ]] || justified=1
        fi
      fi
    done < "$MBOT_SCRATCH/deletion-basis"
    ((justified)) || mbot_violation "$rel" missing_deletion_basis
  done < <(mbot_git diff --no-ext-diff --numstat "$MBOT_BASE" -- MEMORY.md bots wiki)
}
mbot_dream_publish() {
  local failed=$1 rel report
  if ((failed)); then
    while IFS= read -r -d '' rel; do mbot_restore "$rel"; done < <(
      mbot_git diff --no-ext-diff --name-only -z "$MBOT_BASE" -- MEMORY.md bots wiki
      mbot_git ls-files --others --exclude-standard -z -- bots wiki
    )
  fi
  report=$(mbot_path "$MBOT_DREAM_REPORT")
  mkdir -p -- "$(dirname -- "$report")"
  [[ ! -d $report ]] || rm -rf -- "$report"
  if [[ -f $report ]]; then jq -Rs . < "$report" | mbot_scrub | jq -r . > "$MBOT_SCRATCH/report.md"; else printf '# Dreaming report\n\nModel report missing.\n' > "$MBOT_SCRATCH/report.md"; fi
  printf '\n## 宿主验收\n\n' >> "$MBOT_SCRATCH/report.md"
  jq -r '"    " + (tojson | gsub("\n";"\n    "))' "$MBOT_SCRATCH/meta.json" >> "$MBOT_SCRATCH/report.md"
  [[ ! -f $MBOT_SCRATCH/dream-lint ]] || { jq -Rs . < "$MBOT_SCRATCH/dream-lint" | mbot_scrub | jq -r '"\n    " + gsub("\n";"\n    ")' >> "$MBOT_SCRATCH/report.md"; }
  cp "$MBOT_SCRATCH/report.md" "$report"
  jq --slurpfile checkpoint "$MBOT_SCRATCH/checkpoint.json" '. + {checkpoint:$checkpoint[0]}' "$MBOT_SCRATCH/meta.json" | mbot_scrub > "$MBOT_SCRATCH/dream-meta.json"
  cp "$MBOT_SCRATCH/dream-meta.json" "$MBOT_WS/${MBOT_DREAM_REPORT%.md}.meta.json"
  MBOT_AUDIT_PATH=$MBOT_DREAM_REPORT
  MBOT_STAGE=("$MBOT_DREAM_REPORT" "${MBOT_DREAM_REPORT%.md}.meta.json")
  if ((failed)); then MBOT_COMMIT_PREFIX='dream(failed)'; else MBOT_COMMIT_PREFIX=dream; MBOT_STAGE+=(MEMORY.md bots wiki); fi
}
