#!/usr/bin/env bash

mbot_error() { printf 'mbot: %s\n' "$*" >&2; return 1; }
mbot_line() { [[ -n $1 && $1 != *$'\n'* && $1 != *$'\r'* ]]; }
mbot_config_file() { printf '%s/mbot/config\n' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

# Config is data: no source, interpolation, escapes or command substitution.
mbot_read_config() {
  local file=$1 scope=$2 line key value
  [[ -f $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^([A-Z_]+)=(.*)$ ]] || { mbot_error "invalid config line in $file"; return 1; }
    key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
    if [[ $scope == user ]]; then
      [[ $key == MBOT_WS ]] || { mbot_error "unknown user config key: $key"; return 1; }
    else
      case $key in
        MBOT_MEMORY_MAX_LINES|MBOT_MEMORY_MAX_CHARS|MBOT_SOUL_MAX_CHARS|MBOT_WIKI_MAX_LINES|MBOT_BOARD_MAX_LINES|MBOT_TIMEOUT|MBOT_DREAM_MAX_BYTES|MBOT_GRANTS|MBOT_DSH) ;;
        *) mbot_error "unknown workspace config key: $key"; return 1 ;;
      esac
    fi
    if [[ $value == \"*\" || $value == \'*\' ]]; then value=${value:1:${#value}-2}; fi
    [[ $value != *$'\r'* ]] || { mbot_error "config must use LF: $file"; return 1; }
    [[ -v $key ]] || printf -v "$key" '%s' "$value"
  done < "$file"
}

mbot_workspace_path() {
  local path=$1 dsh_home
  mbot_line "$path" || { mbot_error 'workspace path must be a nonempty single line'; return 1; }
  [[ $path != '~' && $path != '~/'* ]] || path="$HOME${path:1}"
  MBOT_WS=$(realpath -m -- "$path")
  dsh_home=$(realpath -m -- "${DSH_HOME:-$HOME/.dsh}")
  if [[ $MBOT_WS == "$MBOT_ROOT" || $MBOT_WS == "$MBOT_ROOT/"* || $MBOT_ROOT == "$MBOT_WS/"* || $MBOT_WS == / ]]; then
    mbot_error 'workspace must not overlap the framework repository'; return 1
  fi
  if [[ $MBOT_WS == "$dsh_home" || $MBOT_WS == "$dsh_home/"* || $MBOT_WS == "$HOME/.dsh" || $MBOT_WS == "$HOME/.dsh/"* ]]; then
    mbot_error 'workspace must not be inside DSH_HOME or ~/.dsh'; return 1
  fi
}

mbot_select_workspace() {
  if [[ -n ${MBOT_CLI_WS:-} ]]; then
    mbot_workspace_path "$MBOT_CLI_WS"
  else
    [[ -v MBOT_WS ]] || mbot_read_config "$(mbot_config_file)" user
    mbot_workspace_path "${MBOT_WS-$HOME/.mbot-ws}"
  fi
}

mbot_save_workspace() {
  local file tmp
  file=$(mbot_config_file)
  mkdir -p -- "$(dirname -- "$file")"
  tmp=$(mktemp "${file}.XXXXXX")
  printf 'MBOT_WS=%s\n' "$MBOT_WS" > "$tmp"
  mv -- "$tmp" "$file"
}

# Reject symlinked managed files/directories, including an absent final file.
mbot_path() {
  local rel=$1 part current=$MBOT_WS
  [[ $rel != /* && $rel != *$'\n'* && $rel != *$'\r'* ]] || { mbot_error "invalid relative path: $rel"; return 1; }
  local -a parts
  IFS=/ read -r -a parts <<< "$rel"
  for part in "${parts[@]}"; do
    [[ -n $part && $part != . && $part != .. ]] || { mbot_error "invalid relative path: $rel"; return 1; }
    current+=/$part
    [[ ! -L $current ]] || { mbot_error "symlink not allowed: $rel"; return 1; }
  done
  printf '%s\n' "$current"
}

mbot_load_workspace() {
  mbot_select_workspace
  if [[ ! -d $MBOT_WS ]]; then
    if [[ -t 0 && -t 2 && ! -v MBOT_RUN_ID ]]; then
      local answer
      printf '工作区不存在。输入路径 [%s]: ' "$MBOT_WS" >&2
      IFS= read -r answer
      mbot_workspace_path "${answer:-$MBOT_WS}"
      mbot_save_workspace
      mbot_error "配置已保存，请执行 mbot init '$MBOT_WS'"; return 1
    fi
    mbot_error "workspace not found: $MBOT_WS; use mbot init <dir>"; return 1
  fi
  [[ $(git -C "$MBOT_WS" rev-parse --show-toplevel 2>/dev/null) == "$MBOT_WS" ]] || { mbot_error 'workspace must be an independent Git repository'; return 1; }
  local rel key
  for rel in .mbot/config AGENTS.md MEMORY.md BOARD.md tasks/_template.md wiki/_index.md; do
    [[ -f $(mbot_path "$rel") ]] || { mbot_error "workspace file missing: $rel"; return 1; }
  done
  mbot_read_config "$MBOT_WS/.mbot/config" workspace
  : "${MBOT_MEMORY_MAX_LINES:=150}" "${MBOT_MEMORY_MAX_CHARS:=3000}" "${MBOT_SOUL_MAX_CHARS:=5000}"
  : "${MBOT_WIKI_MAX_LINES:=200}" "${MBOT_BOARD_MAX_LINES:=80}" "${MBOT_TIMEOUT:=300}"
  : "${MBOT_DREAM_MAX_BYTES:=64000}" "${MBOT_GRANTS:=}" "${MBOT_DSH:=dsh}"
  for key in MBOT_MEMORY_MAX_LINES MBOT_MEMORY_MAX_CHARS MBOT_SOUL_MAX_CHARS MBOT_WIKI_MAX_LINES MBOT_BOARD_MAX_LINES MBOT_TIMEOUT MBOT_DREAM_MAX_BYTES; do
    [[ ${!key} =~ ^[1-9][0-9]{0,8}$ ]] || { mbot_error "$key must be a positive integer"; return 1; }
  done
  mbot_line "$MBOT_DSH" || { mbot_error 'MBOT_DSH must be nonempty'; return 1; }
}
