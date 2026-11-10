import { createRegistry } from '@earendil-works/pi-durable';
import { registrations, researchSystemPrompt } from '../tools/index.js';

/** Register the same tools and schemas on Harness and PiHarness. */
export function researchRegistry(web, { enabled = true, overrides = {}, guard = () => {}, extensionName = 'research', sectionKey = 'security', observe = () => {} } = {}) {
  const registry = createRegistry();
  registry.install({ name: extensionName,
    tools: enabled ? registrations(web).filter(tool => overrides[tool.name] !== false).map(tool => ({ ...tool, replay: 'safe',
      async execute(args, _api, context) {
        await guard();
        await observe('start', tool.name);
        try {
          const result = await tool.execute(args, context.abortSignal);
          await observe('done', tool.name);
          return { output: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (error) {
          await observe('error', tool.name, error.code || 'tool_error');
          if (context.abortSignal?.aborted) throw error;
          return { isError: true, output: [{ type: 'text', text: JSON.stringify({ error: { code: error.code || 'tool_error' } }) }] };
        }
      },
    })) : [],
    sections: enabled ? [{ key: sectionKey, tag: false, render: () => researchSystemPrompt() }] : [],
  });
  return registry;
}
