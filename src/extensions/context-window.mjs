// Keep Picall's context budget local to this Pi process. The public setModel API
// preserves the provider's authentication, transport, tools, and capabilities.
export default function contextWindowExtension(pi) {
  const contextWindow = Number(process.env.PICALL_CONTEXT_WINDOW);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return;
  const apply = async (_event, ctx) => {
    if (!ctx.model || ctx.model.contextWindow === contextWindow) return;
    const changed = await pi.setModel({ ...ctx.model, contextWindow });
    if (!changed) throw new Error('Picall could not apply the context window to this model.');
  };
  pi.on('session_start', apply);
  pi.on('before_agent_start', apply);
}
