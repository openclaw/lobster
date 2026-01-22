import { listWorkflows } from '../../workflows/registry.js';

export const workflowsListCommand = {
  name: 'workflows.list',
  help() {
    return `workflows.list — list available Lobster workflows\n\nUsage:\n  workflows.list\n\nNotes:\n  - Intended for Clawdbot to discover workflows dynamically.\n`;
  },
  async run({ input }) {
    // Drain input.
    for await (const _item of input) {
      // no-op
    }

    return { output: asStream(listWorkflows()) };
  },
};

async function* asStream(items) {
  for (const item of items) yield item;
}
