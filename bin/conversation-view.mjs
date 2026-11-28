#!/usr/bin/env node
// Host-only inspection helper; source identity arrives via stdin, not model arguments.
import { readConversationView, inspectConversationView } from '../plugin/conversation-view.js'

try {
  if (process.argv.length !== 3) throw new Error('usage: conversation-view.mjs workspace (Host request on stdin)')
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    // 256 permitted sender IDs can each contain 1024 four-byte code points.
    if (size > 2 * 1024 * 1024) throw new Error('Conversation view request is too large')
    chunks.push(chunk)
  }
  const { registration, role, commit } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const view = readConversationView(process.argv[2], commit, registration, role)
  process.stdout.write(JSON.stringify(inspectConversationView(view)) + '\n')
} catch (error) {
  process.stderr.write(`mbot: ${error.message}\n`)
  process.exitCode = 1
}
