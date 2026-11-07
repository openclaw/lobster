import { workflowRegistry } from "../../workflows/registry.js";
import {
	runGithubPrMonitorWorkflow,
	runGithubPrMonitorNotifyWorkflow,
} from "../../workflows/github_pr_monitor.js";
import { parseWorkflowArgsJson } from "../../workflows/values.js";

const runners = {
	"github.pr.monitor": runGithubPrMonitorWorkflow,
	"github.pr.monitor.notify": runGithubPrMonitorNotifyWorkflow,
};

export const workflowsRunCommand = {
	name: "workflows.run",
	meta: {
		description: "Run a named Lobster workflow",
		argsSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Workflow name" },
				"args-json": { type: "string", description: "JSON string of workflow args" },
				_: { type: "array", items: { type: "string" } },
			},
			required: ["name"],
		},
		sideEffects: [],
	},
	help() {
		return `workflows.run — run a named Lobster workflow\n\nUsage:\n  workflows.run --name <workflow> [--args-json '{...}']\n\nExample:\n  workflows.run --name github.pr.monitor.notify --args-json '{"repo":"openclaw/openclaw","pr":1152}'\n`;
	},
	async run({ input, args, ctx }) {
		// Drain input.
		for await (const _item of input) {
			// no-op
		}

		const name = args.name ?? args._[0];
		if (!name) throw new Error("workflows.run requires --name");

		const meta = workflowRegistry[name];
		if (!meta) throw new Error(`Unknown workflow: ${name}`);

		const runner = runners[name];
		if (!runner) throw new Error(`Workflow runner not implemented: ${name}`);

		let workflowArgs = {};
		if (args["args-json"] !== undefined) {
			workflowArgs = parseWorkflowArgsJson(String(args["args-json"]), "workflows.run");
		}

		const result = await runner({ args: workflowArgs, ctx });
		return { output: asStream([result]) };
	},
};

async function* asStream(items) {
	for (const item of items) yield item;
}
