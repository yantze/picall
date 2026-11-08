import { MAX_TOOLS, parseToolOverrides, toolPolicy, validToolName } from '../tool-policy.js';
import { installLocalResearch } from './research.mjs';

const MAX_DESCRIPTION_LENGTH = 500;

function toolNames(values) {
  return [...new Set(values.filter(validToolName))]
    .slice(0, MAX_TOOLS).sort();
}

// RPC's public UI status channel preserves JSONL output ordering without adding
// model messages or modifying user files. Pi redirects ordinary stdout to stderr.
export default function picallRuntimeExtension(pi) {
  // Invalid policy must prevent metadata from marking this worker ready.
  const overrides = parseToolOverrides(process.env.PICALL_TOOL_OVERRIDES);
  installLocalResearch(pi);

  const report = (ctx) => {
    const allTools = pi.getAllTools();
    const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
    const active = new Set(pi.getActiveTools());
    const availableTools = toolNames(allTools.map((tool) => tool.name));
    ctx.ui.setStatus('picall_runtime', JSON.stringify({
      activeTools: toolNames([...active]),
      availableTools,
      toolDetails: availableTools.map((name) => {
        const tool = toolsByName.get(name);
        return {
          name,
          description: typeof tool.description === 'string' ? tool.description.slice(0, MAX_DESCRIPTION_LENGTH) : '',
          ...toolPolicy(tool, overrides),
          active: active.has(name),
          exposure: tool.exposure ?? 'direct',
        };
      }),
    }));
  };

  const applyPolicy = (_event, ctx) => {
    const allTools = pi.getAllTools();
    const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
    const active = new Set(pi.getActiveTools().filter((name) =>
      toolPolicy(toolsByName.get(name) ?? name, overrides).enabled));
    for (const tool of allTools) {
      // Respect native deferred/codemode/hidden exposure and inactive defaults.
      // Only a user's explicit opt-in activates an otherwise inactive tool.
      if (Object.hasOwn(overrides, tool.name) && overrides[tool.name] === true &&
          ['direct', 'model-only'].includes(tool.exposure ?? 'direct')) {
        active.add(tool.name);
      }
    }
    pi.setActiveTools([...active]);
    report(ctx);
  };

  pi.on('session_start', applyPolicy);
  pi.on('before_agent_start', applyPolicy);
  pi.on('tool_call', (event) => {
    // Active declarations alone cannot disable deferred tools. This hook also
    // gates tool_search/codemode nested calls, including tools registered late.
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    const policy = toolPolicy(tool ?? event.toolName, overrides);
    if (!policy.enabled) return { block: true, reason: `PiCall disabled tool ${event.toolName}: ${policy.reason}` };
  });
}
