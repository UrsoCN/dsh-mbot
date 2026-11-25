#!/usr/bin/env bash
set -Eeuo pipefail
MBOT_ROOT=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd -P)
source "$MBOT_ROOT/lib/config.sh"
bin_dir=$HOME/.local/bin
workspace=''
while (($#)); do
  case $1 in
    --bin-dir|--workspace)
      [[ $# -ge 2 && -n $2 ]] || { mbot_error "$1 requires a value"; exit 2; }
      if [[ $1 == --bin-dir ]]; then bin_dir=$2; else workspace=$2; fi
      shift 2 ;;
    -h|--help) printf 'Usage: bash install.sh [--bin-dir dir] [--workspace dir]\n'; exit 0 ;;
    *) mbot_error "unknown option: $1"; exit 2 ;;
  esac
done
mbot_line "$bin_dir" || { mbot_error 'invalid bin directory'; exit 2; }
[[ -z $workspace ]] || mbot_workspace_path "$workspace"
bin_dir=$(realpath -m -- "$bin_dir")
for name in mbot botctl; do
  dest=$bin_dir/$name
  if [[ -e $dest || -L $dest ]]; then
    [[ -L $dest && $(readlink -f -- "$dest") == "$MBOT_ROOT/bin/$name" ]] || { mbot_error "will not overwrite $dest"; exit 1; }
  fi
done
mkdir -p -- "$bin_dir"
for name in mbot botctl; do ln -sfn -- "$MBOT_ROOT/bin/$name" "$bin_dir/$name"; done
[[ -z $workspace ]] || mbot_save_workspace
printf 'Installed mbot and botctl into %s\n' "$bin_dir"
printf 'Add that directory to PATH. Initialize data with mbot init <dir>.\n'
