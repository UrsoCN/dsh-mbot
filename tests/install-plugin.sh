#!/usr/bin/env bash
# Keyless acceptance of the actual DSH installer and installed Cordis runtime.
set -Eeuo pipefail
umask 077
if (( $# )); then
  modes=("$@")
else
  modes=(tarball source git web-tarball)
fi
for mode in "${modes[@]}"; do
  case $mode in
    tarball|source|git|web-tarball) ;;
    *) printf 'Unknown installation mode: %s (expected tarball, source, git or web-tarball)\n' "$mode" >&2; exit 2 ;;
  esac
done
# A local developer's PATH may already provide pnpm, while a fresh runner's
# npm-installed DSH does not. Fail before creating a profile with a useful error.
for dependency in node npm dsh pnpm git jq flock awk tar timeout; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf 'Missing installation test dependency: %s (see PLUGIN.md)\n' "$dependency" >&2
    exit 127
  fi
done
run_logged() {
  local log=$1 status
  shift
  if "$@" > "$log" 2>&1; then return 0; else status=$?; fi
  printf 'Installation command failed (exit %s); last 80 lines of %s:\n' "$status" "$log" >&2
  tail -n 80 -- "$log" >&2
  return "$status"
}
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
root=$(mktemp -d /tmp/mbot-plugin-install.XXXXXX)
trap 'printf "Plugin installation artifacts: %s\n" "$root"' EXIT
export DSH_HOME=$root/dsh XDG_CONFIG_HOME=$root/config XDG_DATA_HOME=$root/data XDG_CACHE_HOME=$root/cache XDG_STATE_HOME=$root/state TMPDIR=$root
export DSH_TELEMETRY_MODE=DISABLED
export COREPACK_HOME=$root/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export GIT_AUTHOR_NAME='mbot plugin install' GIT_AUTHOR_EMAIL=mbot-tests@example.invalid
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
unset MBOT_WS MBOT_RUN_ID MBOT_BOT DEEPSEEK_API_KEY
cd "$root"
npm pack "$repo" --json --ignore-scripts --pack-destination "$root" --cache "$root/npm-cache" > "$root/pack.json"
tarball=$root/$(jq -r '.[0].filename' "$root/pack.json")
jq -e '.[0].files | any(.path=="DESIGN.md") and any(.path=="PLUGIN.md") and any(.path=="RELEASE_NOTE.md") and any(.path=="TODO.md") and any(.path=="docs/README.md") and any(.path=="docs/archive/0.1-acceptance.md") and any(.path=="templates/workspace/gitignore") and any(.path=="templates/workspace/.mbot/config") and any(.path=="plugin/index.d.ts") and any(.path=="plugin/client.js") and any(.path=="plugin/client.d.ts") and any(.path=="bin/mbot-turn" and (.mode / 64 | floor % 2)==1) and any(.path=="bin/turn-state.mjs" and (.mode / 64 | floor % 2)==1) and any(.path=="plugin/turn-state.js") and any(.path=="lib/permit.sh") and any(.path=="plugin/turn.d.ts") and any(.path=="lib/turn-recovery.sh") and any(.path=="bin/turn-writers.mjs") and any(.path=="bin/turn-snapshot.mjs") and any(.path=="bin/botctl-host.mjs") and any(.path=="plugin/ipc.js") and any(.path=="plugin/ipc.d.ts") and any(.path=="plugin/ipc-protocol.js") and any(.path=="lib/turn-outcome.jq") and any(.path=="bin/turn-reply.mjs") and any(.path=="bin/turn-receipt.mjs") and any(.path=="plugin/reply-proof.js") and any(.path=="plugin/receipts.js") and any(.path=="plugin/removal.js") and any(.path=="bin/turn-actor.mjs") and any(.path=="plugin/actor-lease.js") and any(.path=="plugin/workers.js") and any(.path=="plugin/worker-proof.js") and any(.path=="plugin/runtime-cells.js") and any(.path=="plugin/gate-driver.js") and any(.path=="plugin/conversation-session.js") and any(.path=="plugin/bot-coordinator.js") and any(.path=="plugin/mailbox-facade.js") and any(.path=="plugin/runtime-recovery.js") and any(.path=="plugin/recovery-proof.js") and any(.path=="plugin/recovery-audit.js") and any(.path=="plugin/native-reply.js") and any(.path=="bin/turn-runtime-recovery.mjs") and any(.path=="bin/botctl-migrate.mjs") and any(.path=="plugin/readonly-migration.js") and any(.path=="plugin/native-storage.js") and any(.path=="plugin/compaction.js") and any(.path=="plugin/compaction-data.js") and any(.path=="plugin/maintenance-journal.js") and any(.path=="plugin/sleep.js") and any(.path=="docs/managed-compaction.md") and any(.path=="docs/sleep-wake.md") and all(.path != ".env" and (.path | startswith("node_modules/") | not))' "$root/pack.json" >/dev/null
# A committed package tree tests Git installation without linking developer node_modules.
mkdir "$root/git-source"
tar -xzf "$tarball" -C "$root/git-source" --strip-components=1
git -C "$root/git-source" init -q
git -C "$root/git-source" add -- .
git -C "$root/git-source" commit -qm 'fixture: packaged Git plugin source'
git_commit=$(git -C "$root/git-source" rev-parse HEAD)
git clone --bare --no-hardlinks "$root/git-source" "$root/plugin.git" > "$root/git-fixture.log" 2>&1
cat > "$root/probe.mjs" <<'JS'
import { readFile, writeFile } from 'node:fs/promises'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
export const inject = ['mbot', 'mbotRuntime', 'mbotIpc', 'agents', 'llm', 'tools', 'commands', 'pluginManager', 'appExit', 'subprocess']
export function apply(ctx) { void setImmediate().then(() => probe(ctx)) }
// /proc can lose an unrelated process between listing and inspection. Retry
// only a verified exit, preserving evidence and re-entering the public API.
async function recoverDataTurn(ctx, botId) {
  const workspace = ctx.mbot.bot({ botId }).workspacePath
  const evidence = async () => ({
    head: execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
    status: execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }),
    diff: execFileSync('git', ['-C', workspace, 'diff', 'HEAD', '--binary'], { encoding: 'utf8' }),
    journal: await readFile(`${workspace}/.mbot/runs/active-turn.json`, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    }),
  })
  const before = await evidence()
  for (let attempt = 0; ; attempt++) {
    try { return await ctx.mbot.recoverTurn({ botId }) }
    catch (error) {
      const pid = /Cannot inspect possible writer pid (\d+)/u.exec(error.message)?.[1]
      if (!pid || attempt >= 3) throw error
      let exited = false
      const deadline = Date.now() + 500
      while (Date.now() < deadline) {
        try {
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
          if (stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/u)[0] === 'Z') { exited = true; break }
        } catch (inspection) {
          if (inspection.code === 'ENOENT') { exited = true; break }
          throw error
        }
        await delay(20)
      }
      if (!exited) throw error
      const after = await evidence()
      // Do not let an assertion serialize the journal's private permit token.
      assert.ok(Object.keys(before).every(key => before[key] === after[key]), 'Recovery refusal changed installation evidence')
    }
  }
}
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
    const actors = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'installation-actor-protocol', turn: 1,
      request: 'installed scoped data capability', writerScope: 'agent-runtime', messages: [],
      runtimeOwnership: { schemaVersion: 2, mode: 'foreground-workers', workerDepth: 1, maxWorkers: 2, tools: ['botctl'], workerTools: ['botctl'] },
      onExpiry: async () => {}, onCancel: async () => {} })
    const assigned = await actors.execute('botctl', ['board', 'add', 'installed actor task', '--owner', 'coder'])
    if (assigned.exitCode) throw new Error('installed actor task creation failed')
    const taskId = assigned.stdout.trim()
    if ((await actors.execute('botctl', ['board', 'set', taskId, 'doing'])).exitCode) throw new Error('installed actor assignment failed')
    const actor = await actors.delegate({ sessionId: 'installed-coder-actor', role: 'coder', taskId })
    if ((await actor.execute('botctl', ['boot', 'coder', '--task', taskId])).exitCode
      || (await actor.execute('botctl', ['board', 'add', 'actor must not change board'])).exitCode !== 1
      || (await actor.execute('botctl', ['task', 'result', taskId], { input: 'installed actor result' })).exitCode) throw new Error('installed actor data scope failed')
    await actor.close()
    await actors.record({ seq: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    if (!(await actors.finish({ reason: { kind: 'completed' }, text: '' })).success) throw new Error('installed actor settlement failed')
    const interrupted = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'installation-turn', turn: 2, request: 'installed recovery' })
    interrupted.child.stdin.end()
    await interrupted.child.done
    const recovered = await recoverDataTurn(ctx, bot.botId)
    if (recovered.kind !== 'recovered' || !recovered.needed || recovered.success) throw new Error('installed recovery failed')
    if ((await recoverDataTurn(ctx, bot.botId)).needed) throw new Error('installed recovery was not idempotent')
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
    const mailbox = native ? ctx.mbotRuntime.ownerMailbox(managed.agent, { visibility: 'owner-private', adapterId: 'installation',
      ownerId: 'verified-fixture-owner', conversationKey: 'private-fixture', replyRoute: 'fixture-owner' }) : null
    const submitted = mailbox ? await mailbox.send({ requestId: 'installed-event-1', text: 'installed managed Runtime' }) : null
    if (!mailbox) managed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'installed managed Runtime' }], source: { kind: 'user', rpcId: 'installed-native-1' } }))
    await managed.agent.whenIdle()
    await ctx.mbotRuntime.settled(managed.agent)
    if (runtimeCalls !== 2) throw new Error(`installed Runtime made ${runtimeCalls} calls; expected tool and final response`)
    const runtimeStatus = await ctx.mbotRuntime.status(managed.agent)
    if (runtimeStatus.state !== 'idle' || runtimeStatus.lastReceipt?.phase !== 'committed' || !runtimeStatus.lastReceipt.head) throw new Error('installed Runtime audit receipt missing')
    const checkpoint = await ctx.mbotRuntime.checkpoint(managed.agent)
    if (!checkpoint || checkpoint.commit !== runtimeStatus.lastReceipt.head || checkpoint.snapshot.contextEpoch !== 1
      || checkpoint.snapshot.sessionId !== managed.agent.id || checkpoint.snapshot.memoryCommit !== runtimeStatus.lastReceipt.memoryCommit
      || checkpoint.snapshot.knowledge.documents.length !== 4) throw new Error('installed native/Git context checkpoint missing')
    if (mailbox) {
      const retried = await mailbox.send({ requestId: 'installed-event-1', text: 'installed managed Runtime' })
      const receipt = await mailbox.receipt('installed-event-1')
      if (submitted.confirmation !== 'confirmed' || retried.messageId !== submitted.messageId || receipt.delivery !== 'ended'
        || receipt.result?.final !== true || receipt.result.reply.text !== 'installed Runtime succeeded'
        || runtimeCalls !== 2) throw new Error('installed owner mailbox failed native-history deduplication or audited reply proof')
    }
    const { readdir, readFile } = await import('node:fs/promises')
    const candidates = await readdir(`${ctx.mbot.workspace()}/inbox`)
    const candidateText = (await Promise.all(candidates.filter(name => name.endsWith('.md')).map(name => readFile(`${ctx.mbot.workspace()}/inbox/${name}`, 'utf8')))).join('\n')
    if (!candidateText.includes('installed Runtime native candidate')) throw new Error('installed Runtime data tool did not commit its candidate')
    if (ctx.mbotIpc.status().state !== 'ready') throw new Error('installed private Host IPC missing')
    const { dirname, join } = await import('node:path')
    const ctl = join(dirname(await realpath(process.env.MBOT_INSTALL_PACKAGE_JSON)), 'bin/botctl')
    const hostCall = async args => {
      const child = ctx.subprocess.spawn({ argv: [ctl, ...args, '--profile', ctx.get('profileContext').name],
        cwd: dirname(ctl), graceMs: 5000, env: { DSH_HOME: process.env.DSH_HOME },
        stdio: { stdin: 'ignore', stdout: { maxBytes: 128000 }, stderr: { maxBytes: 128000 } } })
      const done = await child.done
      const stdout = child.collected.stdout.readFrom(0).text
      if (done.exitCode !== 0) {
        if (!native && args[0] === 'talk' && done.exitCode === 1) return JSON.parse(stdout)
        throw new Error(child.collected.stderr.readFrom(0).text || stdout)
      }
      return JSON.parse(stdout)
    }
    if ((await hostCall(['bots'])).value.bots[0].botId !== bot.botId) throw new Error('installed IPC registry routing failed')
    const cliInput = ['talk', '--bot', bot.botId, '--request-id', 'installed-cli-1', '--text', 'installed CLI message']
    const cli = await hostCall(cliInput)
    if (native) {
      await managed.agent.whenIdle()
      await ctx.mbotRuntime.settled(managed.agent)
      const again = await hostCall(cliInput)
      const receipt = await hostCall(['receipt', '--bot', bot.botId, '--request-id', 'installed-cli-1'])
      if (cli.value.confirmation !== 'confirmed' || again.value.messageId !== cli.value.messageId || receipt.value.delivery !== 'ended'
        || receipt.value.result?.final !== true || receipt.value.result.reply.text !== 'installed Runtime succeeded'
        || runtimeCalls !== 3) throw new Error('installed external CLI request was not deduplicated or audited')
    } else if (cli.ok || runtimeCalls !== 2) throw new Error('basic Host IPC created an unmanaged main Session')
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
for mode in "${modes[@]}"; do
  case $mode in
    tarball|web-tarball) spec=$tarball ;;
    source) spec=$repo ;;
    git) spec="git+file://$root/plugin.git#$git_commit" ;;
  esac
  profile=mbot-$mode
  if [[ $mode == web-tarball ]]; then
    dsh --profile "$profile" --from-default-profile web --dump-config > "$root/$mode.default.yml"
  fi
  run_logged "$root/$mode.install.log" dsh plugin --profile "$profile" add "$spec" --store-dir "$root/pnpm-store" --ignore-scripts
  jq -e '.dsh.profile.bundles | index("dsh-mbot") != null' "$DSH_HOME/profiles/$profile/package.json" >/dev/null
  dsh --profile "$profile" --dump-config > "$root/$mode.config.yml"
  [[ $(cat "$root/$mode.config.yml") == *'# == dsh-mbot'* ]]
  ws=$root/$mode-workspace
  printf '%s\n' '- id: mbot' '  config:' "    workspace: '$ws'" '- id: sandbox-policy' '  config:' '    mode: danger-full-access' '- id: approval' '  config:' '    policy: never' '- insert:' '    - id: mbot-install-probe' "      name: '$root/probe.mjs'" > "$DSH_HOME/profiles/$profile/cordis.patch.yml"
  app_args=()
  if [[ $mode == web-tarball ]]; then app_args=(--no-open --host 127.0.0.1 --port 0); fi
  MBOT_INSTALL_RESULT="$root/$mode.result.json" MBOT_INSTALL_PACKAGE_JSON="$DSH_HOME/profiles/$profile/node_modules/dsh-mbot/package.json" run_logged "$root/$mode.runtime.log" timeout --kill-after=5s 30 dsh --profile "$profile" "${app_args[@]}"
  jq -e '.success and .runtimeCalls==(if .native then 3 else 2 end) and (.output|test("^[0-9]{3,9}")) and (.status.text|contains("todo=1"))' "$root/$mode.result.json" >/dev/null
  jq -e '.registry.schemaVersion==3 and .registry.conversations==[] and (.registry.bots|length)==1 and .registry.bots[0].name=="Installed Bot" and .registry.bots[0].botId==.registry.selectedBotId' "$root/$mode.result.json" >/dev/null
  if [[ $mode == web-tarball ]]; then jq -e '.native and .registry.bots[0].binding.state=="ready" and (.registry.bots[0].mainSessionId|startswith("session-"))' "$root/$mode.result.json" >/dev/null; fi
  [[ -z $(git -C "$ws" status --porcelain) ]]
  installed_task_id=$(jq -r '.output | rtrimstr("\n")' "$root/$mode.result.json")
  [[ $(git -C "$ws" log -1 --format=%s) == "human: board add $installed_task_id "* ]]
  [[ -x $DSH_HOME/profiles/$profile/node_modules/.bin/mbot && -x $DSH_HOME/profiles/$profile/node_modules/.bin/botctl ]]
  "$DSH_HOME/profiles/$profile/node_modules/.bin/botctl" -C "$ws" lint > "$root/$mode.lint.log"
  if [[ $mode != web-tarball ]]; then
    dsh --profile "$profile" --dump-config-schema > "$root/$mode.schema.json"
    jq -e '..|objects|select(.properties?.workspace? != null)|.properties.workspace["x-cordis"].volatile==true' "$root/$mode.schema.json" >/dev/null
  fi
  if [[ $mode == web-tarball ]]; then
    printf '%s\n' '- insert:' '    - id: mbot-binding-probe' "      name: '$repo/tests/binding-probe.mjs'" > "$DSH_HOME/profiles/$profile/cordis.patch.yml"
    MBOT_BINDING_WS="$root/binding-faults" MBOT_BINDING_RESULT="$root/binding.result.json" run_logged "$root/binding.runtime.log" timeout --kill-after=5s 30 dsh --profile "$profile" "${app_args[@]}"
    jq -e '.success and .bot.binding.state=="ready"' "$root/binding.result.json" >/dev/null
  fi
  run_logged "$root/$mode.remove.log" dsh plugin --profile "$profile" remove dsh-mbot --store-dir "$root/pnpm-store"
  jq -e '.dsh.profile.bundles | index("dsh-mbot") == null' "$DSH_HOME/profiles/$profile/package.json" >/dev/null
  [[ -f $ws/BOARD.md && -z $(git -C "$ws" status --porcelain) ]]
  printf 'Plugin install PASS: %s install/activation/native tool/command/schema/bin/metadata/removal\n' "$mode"
done
