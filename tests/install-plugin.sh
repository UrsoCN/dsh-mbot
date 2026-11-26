#!/usr/bin/env bash
# Keyless acceptance of the actual DSH installer and installed Cordis runtime.
set -Eeuo pipefail
umask 077
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
root=$(mktemp -d /tmp/mbot-plugin-install.XXXXXX)
trap 'printf "Plugin installation artifacts: %s\n" "$root"' EXIT
export DSH_HOME=$root/dsh XDG_CONFIG_HOME=$root/config XDG_DATA_HOME=$root/data XDG_CACHE_HOME=$root/cache XDG_STATE_HOME=$root/state TMPDIR=$root
export DSH_TELEMETRY_MODE=DISABLED
export COREPACK_HOME=$root/corepack
export GIT_AUTHOR_NAME='mbot plugin install' GIT_AUTHOR_EMAIL=mbot-tests@example.invalid
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
unset MBOT_WS MBOT_RUN_ID MBOT_BOT DEEPSEEK_API_KEY
cd "$root"
npm pack "$repo" --json --ignore-scripts --pack-destination "$root" --cache "$root/npm-cache" > "$root/pack.json"
tarball=$root/$(jq -r '.[0].filename' "$root/pack.json")
jq -e '.[0].files | any(.path=="templates/workspace/gitignore") and any(.path=="templates/workspace/.mbot/config") and any(.path=="plugin/index.d.ts") and any(.path=="plugin/client.js") and any(.path=="plugin/client.d.ts") and all(.path != ".env" and (.path | startswith("node_modules/") | not))' "$root/pack.json" >/dev/null
# A committed package tree tests Git installation without linking developer node_modules.
mkdir "$root/git-source"
tar -xzf "$tarball" -C "$root/git-source" --strip-components=1
git -C "$root/git-source" init -q
git -C "$root/git-source" add -- .
git -C "$root/git-source" commit -qm 'fixture: packaged Git plugin source'
git_commit=$(git -C "$root/git-source" rev-parse HEAD)
git clone --bare --no-hardlinks "$root/git-source" "$root/plugin.git" > "$root/git-fixture.log" 2>&1
cat > "$root/probe.mjs" <<'JS'
import { writeFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
export const inject = ['mbot', 'tools', 'commands', 'pluginManager', 'appExit']
export async function apply(ctx) {
  try {
    await setImmediate()
    const init = await ctx.mbot.execute('mbot', ['init'])
    if (init.exitCode) throw new Error(init.stderr)
    const definition = ctx.tools.get('botctl')
    if (!definition) throw new Error('native botctl tool missing')
    const signal = new AbortController().signal
    const output = await definition.execute({ action: 'board_add', text: 'installed Cordis native tool' }, { callId: 'install-probe', signal })
    const command = ctx.commands.find({}, 'mbot')
    if (!command) throw new Error('/mbot command missing')
    const status = await command.handler({ rawInput: 'status', signal })
    const bundle = (await ctx.pluginManager.listBundles()).find(item => item.name==='dsh-mbot')
    const meta = bundle?.meta
    if (meta?.error || meta?.title?.en !== 'MBot' || meta?.title?.zh !== 'MBot'
      || !meta?.description?.zh?.includes('记忆')) throw new Error('DSH localized plugin metadata not loaded')
    await writeFile(process.env.MBOT_INSTALL_RESULT, JSON.stringify({ success: status.kind==='success', output, status, meta }, null, 2))
    ctx.appExit(status.kind==='success' ? 0 : 1)
  } catch (error) {
    await writeFile(process.env.MBOT_INSTALL_RESULT, JSON.stringify({ success: false, error: String(error) }))
    ctx.appExit(1)
  }
}
JS
for mode in tarball source git; do
  case $mode in
    tarball) spec=$tarball ;;
    source) spec=$repo ;;
    git) spec="git+file://$root/plugin.git#$git_commit" ;;
  esac
  profile=mbot-$mode
  dsh plugin --profile "$profile" add "$spec" --store-dir "$root/pnpm-store" --ignore-scripts > "$root/$mode.install.log" 2>&1
  jq -e '.dsh.profile.bundles | index("dsh-mbot") != null' "$DSH_HOME/profiles/$profile/package.json" >/dev/null
  dsh --profile "$profile" --dump-config > "$root/$mode.config.yml"
  [[ $(cat "$root/$mode.config.yml") == *'# == dsh-mbot'* ]]
  ws=$root/$mode-workspace
  printf '%s\n' '- id: mbot' '  config:' "    workspace: '$ws'" '- id: sandbox-policy' '  config:' '    mode: danger-full-access' '- insert:' "    - name: '$root/probe.mjs'" > "$root/probe.yml"
  MBOT_INSTALL_RESULT="$root/$mode.result.json" timeout --kill-after=5s 30 dsh --profile "$profile" --patch "$root/probe.yml" > "$root/$mode.runtime.log" 2>&1
  jq -e '.success and (.output|contains("001")) and (.status.text|contains("todo=1"))' "$root/$mode.result.json" >/dev/null
  [[ -z $(git -C "$ws" status --porcelain) ]]
  [[ $(git -C "$ws" log -1 --format=%s) == 'human: board add 001'* ]]
  [[ -x $DSH_HOME/profiles/$profile/node_modules/.bin/mbot && -x $DSH_HOME/profiles/$profile/node_modules/.bin/botctl ]]
  "$DSH_HOME/profiles/$profile/node_modules/.bin/botctl" -C "$ws" lint > "$root/$mode.lint.log"
  dsh --profile "$profile" --dump-config-schema > "$root/$mode.schema.json"
  jq -e '..|objects|select(.properties?.workspace? != null)|.properties.workspace["x-cordis"].volatile==true' "$root/$mode.schema.json" >/dev/null
  dsh plugin --profile "$profile" remove dsh-mbot --store-dir "$root/pnpm-store" > "$root/$mode.remove.log" 2>&1
  jq -e '.dsh.profile.bundles | index("dsh-mbot") == null' "$DSH_HOME/profiles/$profile/package.json" >/dev/null
  [[ -f $ws/BOARD.md && -z $(git -C "$ws" status --porcelain) ]]
  printf 'Plugin install PASS: %s install/activation/native tool/command/schema/bin/metadata/removal\n' "$mode"
done
