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
jq -e '.[0].files | any(.path=="templates/workspace/gitignore") and any(.path=="templates/workspace/.mbot/config") and any(.path=="plugin/index.d.ts") and any(.path=="plugin/client.js") and any(.path=="plugin/client.d.ts") and any(.path=="bin/mbot-turn" and (.mode / 64 | floor % 2)==1) and any(.path=="lib/permit.sh") and any(.path=="plugin/turn.d.ts") and any(.path=="lib/turn-recovery.sh") and any(.path=="bin/turn-writers.mjs") and any(.path=="bin/turn-snapshot.mjs") and all(.path != ".env" and (.path | startswith("node_modules/") | not))' "$root/pack.json" >/dev/null
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
export const inject = ['mbot', 'mbotRuntime', 'agents', 'llm', 'tools', 'commands', 'pluginManager', 'appExit']
export function apply(ctx) { void setImmediate().then(() => probe(ctx)) }
async function probe(ctx) {
  try {
    await setImmediate()
    const init = await ctx.mbot.execute('mbot', ['init'])
    if (init.exitCode) throw new Error(init.stderr)
    const bot = await ctx.mbot.importBot(ctx.mbot.workspace(), { name: 'Installed Bot' })
    await ctx.mbot.selectBot(bot.botId)
    const importedAgain = await ctx.mbot.importBot(ctx.mbot.workspace())
    if (importedAgain.botId !== bot.botId || ctx.mbot.registry().bots.length !== 1) throw new Error('Bot import was not idempotent')
    const native = !!ctx.get('sessionController')
    const bound = native ? await ctx.mbot.ensureBinding(bot.botId) : null
    if (native) {
      if (bound.binding.state !== 'ready' || !bound.workspaceId || !bound.mainSessionId) throw new Error('installed native binding missing')
      const repeated = await ctx.mbot.ensureBinding(bot.botId)
      if (repeated.mainSessionId !== bound.mainSessionId || repeated.workspaceId !== bound.workspaceId) throw new Error('binding retry minted another entity')
    }
    const turn = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'installation-turn', turn: 1, request: 'installed transaction bridge' })
    await turn.execute('botctl', ['remember', 'installed managed candidate', '--as', 'chief'])
    const turnResult = await turn.finish({ reason: { kind: 'completed' }, text: 'installed transaction succeeded' })
    if (!turnResult.success) throw new Error('installed transaction bridge failed')
    const interrupted = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'installation-turn', turn: 2, request: 'installed recovery' })
    interrupted.child.stdin.end()
    await interrupted.child.done
    const recovered = await ctx.mbot.recoverTurn({ botId: bot.botId })
    if (recovered.kind !== 'recovered' || !recovered.needed || recovered.success) throw new Error('installed recovery failed')
    if ((await ctx.mbot.recoverTurn({ botId: bot.botId })).needed) throw new Error('installed recovery was not idempotent')
    if ((await ctx.mbot.execute('mbot', ['resume'])).exitCode) throw new Error('installed recovery cannot resume')
    const { createRequire } = await import('node:module')
    const { realpath } = await import('node:fs/promises')
    const { randomUUID } = await import('node:crypto')
    const fromPackage = createRequire(await realpath(process.env.MBOT_INSTALL_PACKAGE_JSON))
    const { LlmAdapter, createUserMessage } = await import(fromPackage.resolve('@deepseek-ai/dsh-llm'))
    let runtimeCalls = 0
    class InstalledAdapter extends LlmAdapter {
      async *stream(request) {
        // The full Harness also makes auxiliary title requests. They are
        // served locally and are not conversation steps or data writers.
        if (request.purpose) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Installed Bot' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        runtimeCalls++
        if (!JSON.stringify(request.messages).includes('# MBot role: chief')) throw new Error('installed managed context missing')
        const block = runtimeCalls === 1 ? { type: 'tool-call', id: 'installed-runtime-tool', name: 'botctl',
          arguments: JSON.stringify({ action: 'remember', text: 'installed Runtime native candidate' }) } : { type: 'text', text: 'installed Runtime succeeded' }
        yield { type: 'block-start', index: 0, blockType: block.type }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: runtimeCalls === 1 ? 'tool-calls' : 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mbot-installation'], new InstalledAdapter())
    const managed = native ? await ctx.get('sessionController').resolveAgent(bound.mainSessionId)
      : await ctx.agents.create({ sessionId: `installation-${randomUUID()}`, meta: { cwd: ctx.mbot.workspace() },
        agentOptions: { provider: 'mbot-installation', model: 'scripted' },
        setup: (_scope, agent) => ctx.mbotRuntime.attach(agent, { botId: bot.botId }) })
    if ('error' in managed) throw managed.error
    if (!ctx.mbotRuntime.managed(managed.agent)) throw new Error('main Session was not automatically managed')
    if (native) managed.agent.model.select({ provider: 'mbot-installation', model: 'scripted' })
    managed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'installed managed Runtime' }], source: { kind: 'user' } }))
    await managed.agent.whenIdle()
    await ctx.mbotRuntime.settled(managed.agent)
    if (runtimeCalls !== 2) throw new Error(`installed Runtime made ${runtimeCalls} calls; expected tool and final response`)
    const runtimeStatus = await ctx.mbotRuntime.status(managed.agent)
    if (runtimeStatus.state !== 'idle' || runtimeStatus.lastReceipt?.phase !== 'committed' || !runtimeStatus.lastReceipt.head) throw new Error('installed Runtime audit receipt missing')
    const { readdir, readFile } = await import('node:fs/promises')
    const candidates = await readdir(`${ctx.mbot.workspace()}/inbox`)
    const candidateText = (await Promise.all(candidates.filter(name => name.endsWith('.md')).map(name => readFile(`${ctx.mbot.workspace()}/inbox/${name}`, 'utf8')))).join('\n')
    if (!candidateText.includes('installed Runtime native candidate')) throw new Error('installed Runtime data tool did not commit its candidate')
    if (native) {
      const afterTurn = await ctx.mbot.ensureBinding(bot.botId)
      if (afterTurn.mainSessionId !== bound.mainSessionId) throw new Error('repair replaced a started Session')
    } else await managed.dispose()
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
    await writeFile(process.env.MBOT_INSTALL_RESULT, JSON.stringify({ success: status.kind==='success', native, runtimeCalls, output, status, meta, registry: ctx.mbot.registry() }, null, 2))
    ctx.appExit(status.kind==='success' ? 0 : 1)
  } catch (error) {
    await writeFile(process.env.MBOT_INSTALL_RESULT, JSON.stringify({ success: false, error: String(error) }))
    ctx.appExit(1)
  }
}
JS
for mode in tarball source git web-tarball; do
  case $mode in
    tarball|web-tarball) spec=$tarball ;;
    source) spec=$repo ;;
    git) spec="git+file://$root/plugin.git#$git_commit" ;;
  esac
  profile=mbot-$mode
  if [[ $mode == web-tarball ]]; then
    dsh --profile "$profile" --from-default-profile web --dump-config > "$root/$mode.default.yml"
  fi
  dsh plugin --profile "$profile" add "$spec" --store-dir "$root/pnpm-store" --ignore-scripts > "$root/$mode.install.log" 2>&1
  jq -e '.dsh.profile.bundles | index("dsh-mbot") != null' "$DSH_HOME/profiles/$profile/package.json" >/dev/null
  dsh --profile "$profile" --dump-config > "$root/$mode.config.yml"
  [[ $(cat "$root/$mode.config.yml") == *'# == dsh-mbot'* ]]
  ws=$root/$mode-workspace
  printf '%s\n' '- id: mbot' '  config:' "    workspace: '$ws'" '- id: sandbox-policy' '  config:' '    mode: danger-full-access' '- id: approval' '  config:' '    policy: never' '- insert:' '    - id: mbot-install-probe' "      name: '$root/probe.mjs'" > "$DSH_HOME/profiles/$profile/cordis.patch.yml"
  app_args=()
  if [[ $mode == web-tarball ]]; then app_args=(--no-open --host 127.0.0.1 --port 0); fi
  MBOT_INSTALL_RESULT="$root/$mode.result.json" MBOT_INSTALL_PACKAGE_JSON="$DSH_HOME/profiles/$profile/node_modules/dsh-mbot/package.json" timeout --kill-after=5s 30 dsh --profile "$profile" "${app_args[@]}" > "$root/$mode.runtime.log" 2>&1
  jq -e '.success and .runtimeCalls==2 and (.output|contains("001")) and (.status.text|contains("todo=1"))' "$root/$mode.result.json" >/dev/null
  jq -e '.registry.schemaVersion==1 and (.registry.bots|length)==1 and .registry.bots[0].name=="Installed Bot" and .registry.bots[0].botId==.registry.selectedBotId' "$root/$mode.result.json" >/dev/null
  if [[ $mode == web-tarball ]]; then jq -e '.native and .registry.bots[0].binding.state=="ready" and (.registry.bots[0].mainSessionId|startswith("session-"))' "$root/$mode.result.json" >/dev/null; fi
  [[ -z $(git -C "$ws" status --porcelain) ]]
  [[ $(git -C "$ws" log -1 --format=%s) == 'human: board add 001'* ]]
  [[ -x $DSH_HOME/profiles/$profile/node_modules/.bin/mbot && -x $DSH_HOME/profiles/$profile/node_modules/.bin/botctl ]]
  "$DSH_HOME/profiles/$profile/node_modules/.bin/botctl" -C "$ws" lint > "$root/$mode.lint.log"
  if [[ $mode != web-tarball ]]; then
    dsh --profile "$profile" --dump-config-schema > "$root/$mode.schema.json"
    jq -e '..|objects|select(.properties?.workspace? != null)|.properties.workspace["x-cordis"].volatile==true' "$root/$mode.schema.json" >/dev/null
  fi
  if [[ $mode == web-tarball ]]; then
    printf '%s\n' '- insert:' '    - id: mbot-binding-probe' "      name: '$repo/tests/binding-probe.mjs'" > "$DSH_HOME/profiles/$profile/cordis.patch.yml"
    MBOT_BINDING_WS="$root/binding-faults" MBOT_BINDING_RESULT="$root/binding.result.json" timeout --kill-after=5s 30 dsh --profile "$profile" "${app_args[@]}" > "$root/binding.runtime.log" 2>&1
    jq -e '.success and .bot.binding.state=="ready"' "$root/binding.result.json" >/dev/null
  fi
  dsh plugin --profile "$profile" remove dsh-mbot --store-dir "$root/pnpm-store" > "$root/$mode.remove.log" 2>&1
  jq -e '.dsh.profile.bundles | index("dsh-mbot") == null' "$DSH_HOME/profiles/$profile/package.json" >/dev/null
  [[ -f $ws/BOARD.md && -z $(git -C "$ws" status --porcelain) ]]
  printf 'Plugin install PASS: %s install/activation/native tool/command/schema/bin/metadata/removal\n' "$mode"
done
