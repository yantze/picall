const MAX_TOOLS = 512;
const MAX_TOOL_NAME_LENGTH = 256;

function toolNames(values) {
  return [...new Set(values.filter((name) => typeof name === 'string' &&
    name.length > 0 && name.length <= MAX_TOOL_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(name)))]
    .slice(0, MAX_TOOLS).sort();
}

// The extension observes Pi's actual tool registry without adding model messages
// or modifying user files. RPC's public UI status channel preserves JSONL output
// ordering; Pi redirects ordinary process.stdout.write calls to stderr.
export default function picallRuntimeExtension(pi) {
  const contextWindow = Number(process.env.PICALL_CONTEXT_WINDOW);
  const report = async (_event, ctx) => {
    if (Number.isSafeInteger(contextWindow) && contextWindow > 0 && ctx.model &&
        ctx.model.contextWindow !== contextWindow) {
      const changed = await pi.setModel({ ...ctx.model, contextWindow });
      if (!changed) throw new Error('Picall could not apply the context window to this model.');
    }
    ctx.ui.setStatus('picall_runtime', JSON.stringify({
      activeTools: toolNames(pi.getActiveTools()),
      availableTools: toolNames(pi.getAllTools().map((tool) => tool.name)),
    }));
  };
  pi.on('session_start', report);
  pi.on('before_agent_start', report);
}
