// Browser-only lazy CommonJS factory, as required by DSH's module loader.
// No build step or platform dependencies are needed for this small contribution.
window.__ModuleLoader__.load({ id: 'dsh-mbot', factory: require => {
  const { jsx, jsxs } = require('react/jsx-runtime')
  const target = 'mbot-command-activity'
  const auditKind = 'mbot-runtime-audit'
  const auditRecord = 'plugin:mbot/runtime-turn'
  const phases = ['active', 'auditing', 'committed', 'rejected', 'failed', 'cancelled']
  function receipt(event) {
    const data = event.data
    if (event.type !== auditRecord || event.ignorable !== true || data?.schemaVersion !== 1
      || typeof data.botId !== 'string' || typeof data.sessionId !== 'string'
      || !Number.isSafeInteger(data.turn) || data.turn < 1 || !phases.includes(data.phase)
      || ['runId', 'memoryCommit', 'head', 'meta', 'reason', 'error'].some(key => data[key] !== undefined && typeof data[key] !== 'string')
      || (data.outcome !== undefined && !['completed', 'cancelled', 'failed'].includes(data.outcome))
      || (data.failureCountEffect !== undefined && !['reset', 'preserve', 'increment'].includes(data.failureCountEffect))
      || (data.success !== undefined && typeof data.success !== 'boolean')) return null
    return data
  }
  function AuditCard({ node, t }) {
    const data = node.data
    const stopped = data.phase === 'cancelled' || (data.phase === 'rejected'
      && (data.outcome === 'cancelled' || (data.outcome === undefined && data.reason === 'aborted')))
    const failed = data.phase === 'failed' || (data.phase === 'rejected' && !stopped)
    const title = stopped ? 'stopped' : data.phase === 'failed' && data.head ? 'receiptFailed' : data.phase
    return jsxs('section', { 'data-mbot-audit': String(data.turn), 'data-phase': data.phase, role: 'status',
      style: { margin: '8px 0', padding: '10px 12px', border: '1px solid currentColor', borderRadius: 8,
        fontSize: 13, color: failed ? '#dc2626' : 'inherit' },
      children: [jsx('strong', { children: t(title) }), jsx('div', { children: t('turn', { turn: data.turn }) }),
        data.head ? jsxs('div', { children: [t('commit'), ' ', jsx('code', { children: data.head.slice(0, 12) })] }) : null,
        stopped ? jsx('div', { children: t('queueRetained') }) : null,
        data.error ? jsx('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0 0' }, children: data.error }) : null] })
  }
  function apply(ctx) {
    ctx.uiConversation.events.register({
      kind: auditKind, target: 'chat',
      match: event => receipt(event) ? { id: String(event.data.turn), role: event.data.phase === 'active' ? 'start' : 'update' } : null,
      start: (_context, match) => receipt(match.event),
      update: (_context, match) => receipt(match.event),
      buildViewNode: context => {
        const last = context.matches.at(-1)
        const data = context.state ?? (last && receipt(last.event))
        if (!data || !last) return null
        return { key: context.key, id: context.id, kind: auditKind, target: 'chat', anchorSeq: last.event.seq,
          location: { kind: 'session' }, visibility: 'visible', data }
      },
    })
    ctx.inject(['slots', 'locale'], scope => {
      const NS = 'mbot-runtime'
      scope.effect(() => scope.locale.register(NS, {
        zh: { active: 'MBot 正在处理', auditing: 'MBot 正在验收', committed: 'MBot 验收完成', rejected: 'MBot 本轮未通过验收',
          failed: 'MBot 尚未完成验收', stopped: 'MBot 已停止', receiptFailed: 'MBot 审计已提交，回执保存失败',
          turn: '回合 {turn}', commit: '审计提交', queueRetained: '已接收的待办保留。' },
        en: { active: 'MBot is working', auditing: 'MBot is validating', committed: 'MBot validation completed', rejected: 'MBot turn did not pass validation',
          failed: 'MBot validation is incomplete', stopped: 'MBot stopped', receiptFailed: 'MBot audit committed; receipt save failed',
          turn: 'Turn {turn}', commit: 'Audit commit', queueRetained: 'Accepted queued inputs are retained.' },
      }))
      scope.slots.inject('conversation.chat.node', () => scope.slots.register({ name: 'conversation.chat.node', key: auditKind, locale: NS }, AuditCard))
    })
    // DSH deliberately excludes generic commands from Chat's activity predicate.
    // Contribute activity on our own target; native Chat owns the only result card.
    ctx.uiConversation.views.register({
      target,
      create: () => {
        let active = false
        return {
          empty: false,
          replace({ nodes }) { active = nodes.length > 0; return active },
          apply({ upserts }) { active ||= upserts.length > 0; return active },
        }
      },
      isActive: active => active,
    })
    ctx.uiConversation.events.register({
      kind: target, target,
      match: {
        'command/run': event => event.data.name === 'mbot'
          ? { id: String(event.data.commandId), role: 'start' } : null,
      },
      start: () => true,
      update: () => true,
      buildViewNode: context => ({ key: context.key, id: context.id, kind: target, target, data: true }),
    })
    const activate = () => {
      for (const id of Object.keys(ctx.sessions.list.getSnapshot().byId)) {
        const binding = ctx.sessions.binding(id)
        if (binding) ctx.uiConversation.binding(binding).activate(target)
      }
    }
    ctx.effect(() => {
      const stop = ctx.sessions.list.subscribe(activate)
      activate()
      return stop
    })
    // Local Remote acknowledgments only: broadcasts/replay never move other
    // windows. Defer until the composer's submit transaction has settled.
    ctx.inject(['uiWorkspace', 'commandUi', 'workspaces'], scope => {
      let navigationTimer
      const deferOpen = id => {
        clearTimeout(navigationTimer)
        navigationTimer = setTimeout(() => {
          navigationTimer = undefined
          scope.uiWorkspace.openSession(id)
        }, 0)
      }
      const openLink = () => {
        const id = /^#mbot-session=(session-[0-9a-f-]+)$/u.exec(window.location.hash)?.[1]
        if (id && scope.sessions.list.getSnapshot().phase === 'ready'
          && scope.workspaces.list.getSnapshot().phase === 'ready') {
          window.history.replaceState(null, '', window.location.pathname + window.location.search)
          deferOpen(id)
        }
      }
      scope.effect(() => {
        window.addEventListener('hashchange', openLink)
        const stopSessions = scope.sessions.list.subscribe(openLink)
        const stopWorkspaces = scope.workspaces.list.subscribe(openLink)
        openLink()
        return () => {
          window.removeEventListener('hashchange', openLink)
          stopSessions()
          stopWorkspaces()
          clearTimeout(navigationTimer)
        }
      })
      scope.on('command/executed', (sessionId, name, result) => {
        if (name !== 'mbot' || result.kind !== 'success') return
        const target = /^Open main Session: (session-[0-9a-f-]+)$/mu.exec(result.text ?? '')?.[1]
        if (!target) return
        deferOpen(target)
      })
    })
  }
  return { name: 'mbot-client', inject: ['uiConversation', 'sessions'], apply }
} })
