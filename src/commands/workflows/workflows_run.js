import { workflowRegistry } from '../../workflows/registry.js';
import { runEmailTriageWorkflow } from '../../workflows/email_triage.js';
import { runGithubPrMonitorWorkflow, runGithubPrMonitorNotifyWorkflow } from '../../workflows/github_pr_monitor.js';

const runners = {
  'email.triage': runEmailTriageWorkflow,
  'github.pr.monitor': runGithubPrMonitorWorkflow,
  'github.pr.monitor.notify': runGithubPrMonitorNotifyWorkflow,
};

export const workflowsRunCommand = {
  name: 'workflows.run',
  help() {
    return `workflows.run — run a named Lobster workflow\n\nUsage:\n  workflows.run --name <workflow> [--args-json '{...}']\n\nExample:\n  workflows.run --name email.triage --args-json '{"query":"newer_than:1d","max":10}'\n`;
  },
  async run({ input, args, ctx }) {
    // Drain input.
    for await (const _ of input) {
      // no-op
    }

    const name = args.name ?? args._[0];
    if (!name) throw new Error('workflows.run requires --name');

    const meta = workflowRegistry[name];
    if (!meta) throw new Error(`Unknown workflow: ${name}`);

    const runner = runners[name];
    if (!runner) throw new Error(`Workflow runner not implemented: ${name}`);

    let workflowArgs = {};
    if (args['args-json']) {
      try {
        workflowArgs = JSON.parse(String(args['args-json']));
      } catch {
        throw new Error('workflows.run --args-json must be valid JSON');
      }
    }

    const result = await runner({ args: workflowArgs, ctx });
    return { output: asStream([result]) };
  },
};

async function* asStream(items) {
  for (const item of items) yield item;
}
