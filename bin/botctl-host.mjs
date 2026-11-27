#!/usr/bin/env node
import { ipcLocation, profileLocation, requestHost, hostActions } from '../plugin/ipc-protocol.js'

const usage = `Usage: botctl talk --profile NAME --bot ID --request-id ID --text TEXT|--stdin
       botctl receipt --profile NAME --bot ID --request-id ID
       botctl runtime|stop --profile NAME --bot ID
       botctl bots --profile NAME
Use --endpoint-dir DIR instead of --profile for an explicitly configured Host.
All commands print JSON; talk returns admission, not a completed model response.
Exit 3 means unconfirmed delivery: retry with the same request ID.\n`

async function stdinText() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 262144) throw new Error('Input exceeds 262144 bytes')
    chunks.push(chunk)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

async function main() {
  const args = process.argv.slice(2)
  const action = args.shift()
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(usage); return }
  if (!hostActions.includes(action)) throw new Error('Unknown Host command')
  if (['MBOT_RUN_ID', 'DSH_MBOT_RUN_ID', 'MBOT_PERMIT_TOKEN', 'DSH_MBOT_PERMIT_TOKEN'].some(name => process.env[name] !== undefined)) throw new Error('Host owner commands are unavailable inside managed runs; use current-turn data tools')
  const values = {}
  while (args.length) {
    const name = args.shift()
    if (!['--profile', '--endpoint-dir', '--bot', '--request-id', '--text', '--stdin', '--correlation-id'].includes(name) || name in values) throw new Error('Unknown or duplicate Host option')
    if (name === '--stdin') values[name] = true
    else {
      if (!args.length) throw new Error('Host option requires a value')
      values[name] = args.shift()
    }
  }
  if (Boolean(values['--profile']) === Boolean(values['--endpoint-dir'])) throw new Error('Choose exactly one of --profile or --endpoint-dir')
  if (action !== 'bots' && !values['--bot']) throw new Error('--bot is required')
  if (['talk', 'receipt'].includes(action) && !values['--request-id']) throw new Error('--request-id is required')
  if (action === 'talk' && (('--text' in values) === Boolean(values['--stdin']))) throw new Error('talk requires exactly one of --text or --stdin')
  const allowed = ['--profile', '--endpoint-dir', ...(action === 'bots' ? [] : ['--bot']),
    ...(['talk', 'receipt'].includes(action) ? ['--request-id'] : []), ...(action === 'talk' ? ['--text', '--stdin', '--correlation-id'] : [])]
  if (Object.keys(values).some(name => !allowed.includes(name))) throw new Error('Option does not apply to this Host command')
  const input = { action, ...(values['--bot'] ? { botId: values['--bot'] } : {}),
    ...(values['--request-id'] ? { requestId: values['--request-id'] } : {}),
    ...(action === 'talk' ? { text: values['--stdin'] ? await stdinText() : values['--text'],
      ...(values['--correlation-id'] ? { correlationId: values['--correlation-id'] } : {}) } : {}) }
  try {
    let location
    try { location = values['--profile'] ? await profileLocation(values['--profile']) : await ipcLocation({ directory: values['--endpoint-dir'] }) }
    catch { throw new Error('Matching Host location is unavailable; start DSH with the requested profile or configure --endpoint-dir') }
    const result = await requestHost(location, input)
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode = !result.ok ? 1 : result.value?.confirmation === 'unconfirmed' ? 3 : 0
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code ?? 'IPC_UNAVAILABLE', message: error.message } }) + '\n')
    process.exitCode = error.uncertain ? 3 : 1
  }
}

await main().catch(error => { process.stderr.write(`botctl: ${error.message}\n${usage}`); process.exitCode = 2 })
