// Browser-only lazy CommonJS factory, as required by DSH's module loader.
// No build step or platform dependencies are needed for this small contribution.
window.__ModuleLoader__.load({ id: 'dsh-mbot', factory: () => {
  const target = 'mbot-command-activity'
  function apply(ctx) {
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
  }
  return { name: 'mbot-client', inject: ['uiConversation', 'sessions'], apply }
} })
